'use strict';
const assert = require('assert');
const crypto = require('crypto');
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
Object.assign(process.env, {
  GOOGLE_SERVICE_ACCOUNT_EMAIL: 'sa@x.iam.gserviceaccount.com', GOOGLE_PRIVATE_KEY: privateKey.replace(/\n/g, '\\n'),
  SHEET_ID: 'S1', SHEET_TAB: 'Sheet1', GHL_TOKEN: 't', GHL_LOCATION_ID: 'L', CRON_SECRET: 'sec',
});
const { toIsoDate } = require('../lib/core');
const handler = require('../api/sync');

// serial for 1990-05-17
const serial = (iso) => Math.round((Date.UTC(...iso.split('-').map((n, i) => (i === 1 ? n - 1 : +n))) - Date.UTC(1899, 11, 30)) / 86400000);
assert.strictEqual(toIsoDate(serial('1990-05-17')), '1990-05-17');
assert.strictEqual(toIsoDate('3/7/1985'), '1985-03-07');
assert.strictEqual(toIsoDate('1985-02-30'), null);
assert.strictEqual(toIsoDate('2999-01-01'), null);

let sheet, ghlCalls, ghlKnown, fail429;
const reset = () => {
  sheet = [
    ['Anna@x.com', serial('1990-05-17')], ['bad-email', serial('1990-05-17')], ['anna@x.com', serial('1991-01-01')],
    ['bob@x.com', ''], ['carl@x.com', 'garbage'], ['dina@x.com', '1980-12-25'], ['', ''],
  ];
  ghlCalls = []; ghlKnown = new Set(['anna@x.com']); fail429 = 0;
};
global.fetch = async (url, opts = {}) => {
  const J = (o, status = 200) => ({ ok: status < 400, status, json: async () => o, text: async () => JSON.stringify(o) });
  if (url.includes('oauth2.googleapis.com')) return J({ access_token: 'g' });
  if (url.includes('values:batchUpdate')) {
    for (const d of JSON.parse(opts.body).data) {
      const row = +d.range.match(/C(\d+)/)[1] - 2;
      while (sheet.length <= row) sheet.push([]);
      const r = sheet[row]; while (r.length < 2) r.push('');
      [r[2], r[3], r[4]] = d.values[0];
    }
    return J({});
  }
  if (url.includes('sheets.googleapis.com')) return J({ values: sheet.map((r) => r.slice()) });
  if (url.includes('/contacts/upsert')) {
    const b = JSON.parse(opts.body); ghlCalls.push(b);
    if (fail429 > 0) { fail429--; return J({ message: 'rate' }, 429); }
    if (b.email === 'dina@x.com' && process.env.FAIL_DINA) return J({ message: 'Bad' }, 422);
    const isNew = !ghlKnown.has(b.email); ghlKnown.add(b.email);
    return J({ new: isNew, contact: { id: '1' } });
  }
  throw new Error('unexpected ' + url);
};
const run = async (q = '', auth = 'Bearer sec') => {
  let code, body;
  await handler({ url: '/api/sync' + q, headers: { authorization: auth } }, { status: (c) => ({ json: (b) => { code = c; body = b; } }) });
  return { code, body };
};
(async () => {
  reset();
  assert.strictEqual((await run('', 'Bearer no')).code, 401);
  let r = await run('?dry=1'); assert.strictEqual(r.body.pending, 2); assert.strictEqual(ghlCalls.length, 0);
  r = await run(); assert.strictEqual(r.code, 200);
  assert.deepStrictEqual([r.body.created, r.body.updated, r.body.errors, r.body.skipped], [1, 1, 0, 4]);
  assert.strictEqual(ghlCalls.find((c) => c.email === 'anna@x.com').dateOfBirth, '1990-05-17');
  assert.strictEqual(sheet[1][2], 'Invalid email'); assert.strictEqual(sheet[2][2], 'Duplicate email in sheet - skipped');
  assert.strictEqual(sheet[0][2], 'Updated'); assert.strictEqual(sheet[5][2], 'Created');
  // idempotent rerun
  ghlCalls = []; r = await run(); assert.strictEqual(ghlCalls.length, 0); assert.strictEqual(r.body.unchanged, 2);
  // DOB changed -> only that row resyncs
  sheet[0][1] = serial('1992-02-02'); r = await run();
  assert.strictEqual(ghlCalls.length, 1); assert.strictEqual(ghlCalls[0].dateOfBirth, '1992-02-02');
  // error -> retried next run
  sheet[5][1] = '1981-01-01'; process.env.FAIL_DINA = '1'; r = await run();
  assert.strictEqual(r.body.errors, 1); assert.ok(sheet[5][2].startsWith('Error 422')); assert.strictEqual(sheet[5][3], '');
  delete process.env.FAIL_DINA; ghlCalls = []; r = await run(); assert.strictEqual(ghlCalls.length, 1); assert.strictEqual(sheet[5][2], 'Updated');
  console.log('ALL TESTS PASSED');
})().catch((e) => { console.error(e); process.exit(1); });
