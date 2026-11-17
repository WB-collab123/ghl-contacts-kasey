'use strict';
const crypto = require('crypto');
const { classifyRows } = require('../lib/core');

const GHL = 'https://services.leadconnectorhq.com';
const TIME_BUDGET_MS = 240000;   // stop starting new work after 4 min (function max is 300 s)
const MIN_GAP_MS = 120;          // ~8 requests/s, safely under GHL's 100 per 10 s
const CONCURRENCY = 4;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64u = (b) => Buffer.from(b).toString('base64url');

// Tolerates quotes, literal \n, spaces instead of newlines, or a whole pasted JSON line.
function normalizeKey(raw) {
  let s = String(raw || '').trim();
  const m = s.match(/-----BEGIN ([A-Z ]*PRIVATE KEY)-----([\s\S]*?)-----END \1-----/);
  if (!m) throw new Error(`GOOGLE_PRIVATE_KEY is not a private key (length ${s.length}, starts "${s.slice(0, 12)}"). Paste the private_key value from the JSON file, BEGIN to END lines.`);
  const body = m[2].replace(/\\n/g, '').replace(/[^A-Za-z0-9+/=]/g, '');
  return `-----BEGIN ${m[1]}-----\n${body.match(/.{1,64}/g).join('\n')}\n-----END ${m[1]}-----\n`;
}

async function googleToken() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = normalizeKey(process.env.GOOGLE_PRIVATE_KEY);
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64u(JSON.stringify({
    iss: email, scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  }));
  let sig;
  try { sig = crypto.createSign('RSA-SHA256').update(`${head}.${claim}`).sign(key, 'base64url'); } catch (e) { throw new Error(`GOOGLE_PRIVATE_KEY could not be read (${e.message}); key looks truncated or altered. Length ${key.length}. Paste it again in full.`); }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claim}.${sig}`,
    }),
  });
  const j = await res.json();
  if (!res.ok || !j.access_token) throw new Error(`Google auth failed: ${JSON.stringify(j)}`);
  return j.access_token;
}

async function readSheet(token, sheetId, tab) {
  const range = encodeURIComponent(`'${tab}'!A2:E`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}` +
    `?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const j = await res.json();
  if (!res.ok) throw new Error(`Sheet read failed: ${JSON.stringify(j)}`);
  return j.values || [];
}

async function writeSheet(token, sheetId, tab, updates) {
  for (let i = 0; i < updates.length; i += 200) {
    const data = updates.slice(i, i + 200).map((u) => ({
      range: `'${tab}'!C${u.row}:E${u.row}`, values: [u.values],
    }));
    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values:batchUpdate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ valueInputOption: 'RAW', data }),
    });
    if (!res.ok) throw new Error(`Sheet write failed: ${await res.text()}`);
  }
}

let lastStart = 0;
async function paced() {
  const wait = Math.max(0, lastStart + MIN_GAP_MS - Date.now());
  lastStart = Date.now() + wait;
  if (wait) await sleep(wait);
}

async function upsert(item) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await paced();
    const res = await fetch(`${GHL}/contacts/upsert`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.GHL_TOKEN}`, Version: '2021-07-28',
        'Content-Type': 'application/json', Accept: 'application/json',
      },
      body: JSON.stringify({
        locationId: process.env.GHL_LOCATION_ID, email: item.email, dateOfBirth: item.iso,
        tags: ['birthday-sheet'], source: 'Birthday Sheet',
      }),
    });
    if (res.status === 429 || res.status >= 500) { await sleep(attempt === 0 ? 11000 : 20000); continue; }
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, msg: `Error ${res.status}: ${(j.message || JSON.stringify(j)).toString().slice(0, 120)}` };
    return { ok: true, created: j.new === true };
  }
  return { ok: false, msg: 'Error: GHL busy (retry tomorrow)' };
}

module.exports = async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const secret = process.env.CRON_SECRET;
  const provided = (req.headers.authorization || '').replace(/^Bearer /, '') || url.searchParams.get('key');
  if (!secret || provided !== secret) return res.status(401).json({ error: 'unauthorized' });

  const started = Date.now();
  const dry = url.searchParams.get('dry') === '1';
  const limit = parseInt(url.searchParams.get('limit') || '0', 10);
  const tab = process.env.SHEET_TAB || 'Sheet1';
  const sheetId = process.env.SHEET_ID;
  const out = { dry, created: 0, updated: 0, unchanged: 0, skipped: 0, errors: 0, remaining: 0 };
  const updates = [];
  let token;
  try {
    token = await googleToken();
    const rows = await readSheet(token, sheetId, tab);
    const plan = classifyRows(rows);
    const todo = [];
    for (const p of plan) {
      if (p.action === 'unchanged') out.unchanged++;
      else if (p.action === 'skip') {
        out.skipped++;
        const existing = rows[p.row - 2][2];
        if (existing !== p.status) updates.push({ row: p.row, values: [p.status, '', ''] });
      } else if (p.action === 'sync') todo.push(p);
    }
    const batch = limit > 0 ? todo.slice(0, limit) : todo;
    out.pending = todo.length;
    if (dry) {
      out.sample = batch.slice(0, 5).map((p) => ({ row: p.row, email: p.email, dob: p.iso }));
      return res.status(200).json(out);
    }
    let idx = 0;
    const worker = async () => {
      while (idx < batch.length && Date.now() - started < TIME_BUDGET_MS) {
        const p = batch[idx++];
        const r = await upsert(p);
        const stamp = new Date().toISOString();
        if (r.ok) {
          r.created ? out.created++ : out.updated++;
          updates.push({ row: p.row, values: [r.created ? 'Created' : 'Updated', p.key, stamp] });
        } else {
          out.errors++;
          updates.push({ row: p.row, values: [r.msg, '', stamp] });
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    out.remaining = todo.length - idx;
    await writeSheet(token, sheetId, tab, updates);
    out.secondsUsed = Math.round((Date.now() - started) / 1000);
    return res.status(200).json(out);
  } catch (e) {
    // still try to save progress made so far
    try { if (token && updates.length && !dry) await writeSheet(token, sheetId, tab, updates); } catch (_) {}
    return res.status(500).json({ error: String(e.message || e), ...out });
  }
};