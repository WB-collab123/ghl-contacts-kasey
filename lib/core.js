'use strict';
const crypto = require('crypto');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function pad(n) { return String(n).padStart(2, '0'); }

// Accepts: Google serial number, YYYY-MM-DD, M/D/YYYY (US). Returns 'YYYY-MM-DD' or null.
function toIsoDate(v, now = new Date()) {
  if (v === '' || v === null || v === undefined) return null;
  let y, m, d;
  if (typeof v === 'number') {
    const dt = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
    y = dt.getUTCFullYear(); m = dt.getUTCMonth() + 1; d = dt.getUTCDate();
  } else {
    const s = String(v).trim();
    let r;
    if ((r = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) { y = +r[1]; m = +r[2]; d = +r[3]; }
    else if ((r = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) { m = +r[1]; d = +r[2]; y = +r[3]; }
    else return null;
  }
  const chk = new Date(Date.UTC(y, m - 1, d));
  if (chk.getUTCFullYear() !== y || chk.getUTCMonth() !== m - 1 || chk.getUTCDate() !== d) return null;
  if (y < 1900) return null;
  if (chk.getTime() > now.getTime()) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

function rowKey(email, iso) {
  return crypto.createHash('sha1').update(`${email}|${iso}`).digest('hex').slice(0, 16);
}

// rows: array of [email, dob, status, key, lastSynced]; returns plan per row (index 0 = sheet row 2)
function classifyRows(rows, now = new Date()) {
  const seen = new Set();
  return rows.map((r, i) => {
    const row = i + 2;
    const rawEmail = (r[0] === undefined ? '' : String(r[0])).trim();
    const rawDob = r[1];
    const storedKey = r[3] ? String(r[3]) : '';
    if (!rawEmail && (rawDob === '' || rawDob === undefined)) return { row, action: 'blank' };
    const email = rawEmail.toLowerCase();
    if (!EMAIL_RE.test(email)) return { row, action: 'skip', status: 'Invalid email' };
    if (seen.has(email)) return { row, action: 'skip', status: 'Duplicate email in sheet - skipped' };
    seen.add(email);
    if (rawDob === '' || rawDob === undefined) return { row, action: 'skip', status: 'No birthday - skipped' };
    const iso = toIsoDate(rawDob, now);
    if (!iso) return { row, action: 'skip', status: 'Invalid date (use YYYY-MM-DD or a real date)' };
    const key = rowKey(email, iso);
    if (key === storedKey) return { row, action: 'unchanged', email, iso, key };
    return { row, action: 'sync', email, iso, key };
  });
}

module.exports = { EMAIL_RE, toIsoDate, rowKey, classifyRows };
