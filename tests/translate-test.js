// Tests for POST /api/translate with a stubbed provider - no network, no key.
// Run with `npm test` (chained after the smoke test).
const express = require('express');
const { createRouter } = require('../server/translate');
const { chunk } = require('../server/translateProvider');

let passed = 0;
let failed = 0;

function check(name, condition) {
  console.log(`${condition ? 'PASS' : 'FAIL'}: ${name}`);
  condition ? passed++ : failed++;
}

async function listen(app) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return { server, url: `http://localhost:${server.address().port}/api/translate` };
}

async function post(url, body, raw = false) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw ? body : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function run() {
  let calls = 0;
  let failing = false;
  const provider = {
    translate: async (text, from, to) => {
      calls += 1;
      if (failing) throw new Error('boom');
      return `[${from}>${to}] ${text}`;
    },
  };

  const app = express();
  app.use('/api', createRouter({ provider, limit: 12 }));
  const { server, url } = await listen(app);

  // success
  let r = await post(url, { text: 'hello', from: 'en', to: 'tr' });
  check('success answers 200 with translatedText, from, to',
    r.status === 200 && r.body.translatedText === '[en>tr] hello' && r.body.from === 'en' && r.body.to === 'tr');

  r = await post(url, { text: 'merhaba', from: 'auto', to: 'en' });
  check('from "auto" is accepted and passed to the provider', r.status === 200 && r.body.translatedText === '[auto>en] merhaba');

  // cache hit
  calls = 0;
  await post(url, { text: 'cached line', from: 'en', to: 'fr' });
  r = await post(url, { text: 'cached line', from: 'en', to: 'fr' });
  check('repeat request is served from cache (one provider call)', calls === 1 && r.body.translatedText === '[en>fr] cached line');

  // same language needs no provider
  calls = 0;
  r = await post(url, { text: 'same', from: 'en', to: 'en' });
  check('from === to returns the text without calling the provider', calls === 0 && r.body.translatedText === 'same');

  // bad input
  for (const [label, body] of [
    ['missing text', { from: 'en', to: 'tr' }],
    ['blank text', { text: '   ', from: 'en', to: 'tr' }],
    ['non-string text', { text: 42, from: 'en', to: 'tr' }],
    ['uppercase code', { text: 'hi', from: 'EN', to: 'tr' }],
    ['"auto" as target', { text: 'hi', from: 'en', to: 'auto' }],
    ['missing to', { text: 'hi', from: 'en' }],
  ]) {
    r = await post(url, body);
    check(`bad input (${label}) answers 400 with error`, r.status === 400 && typeof r.body.error === 'string');
  }
  r = await post(url, '{not json', true);
  check('malformed JSON answers 400 with a JSON error', r.status === 400 && typeof r.body.error === 'string');

  // over-length
  r = await post(url, { text: 'a'.repeat(1001), from: 'en', to: 'tr' });
  check('text over 1000 chars answers 400', r.status === 400);
  r = await post(url, { text: 'a'.repeat(1000), from: 'en', to: 'tr' });
  check('text of exactly 1000 chars is accepted', r.status === 200);

  // provider failure, and failures are not cached
  failing = true;
  r = await post(url, { text: 'will fail', from: 'en', to: 'de' });
  check('provider failure answers 502 with error', r.status === 502 && typeof r.body.error === 'string');
  failing = false;
  r = await post(url, { text: 'will fail', from: 'en', to: 'de' });
  check('a failed translation is not cached', r.status === 200);

  // rate limit (limit is 12 per window; 14 requests were valid-shaped above)
  let limited = null;
  for (let i = 0; i < 15 && !limited; i++) {
    r = await post(url, { text: `spam ${i}`, from: 'en', to: 'es' });
    if (r.status === 429) limited = r;
  }
  check('per-IP rate limit answers 429 with error', limited && typeof limited.body.error === 'string');
  server.close();

  // The real server mounts the router at /api (validation only, no network).
  const { server: real } = require('../server/server');
  await new Promise((resolve) => real.listen(0, resolve));
  r = await post(`http://localhost:${real.address().port}/api/translate`, { from: 'en', to: 'tr' });
  check('server.js mounts /api/translate', r.status === 400 && r.body.error === 'text is required');
  real.close();

  // provider chunking keeps every piece within MyMemory's 500 char cap
  const long = 'Hello there. '.repeat(70) + 'x'.repeat(900);
  const pieces = chunk(long);
  check('chunking respects the size cap', pieces.every((p) => p.length <= 450) && pieces.length > 2);
  check('chunking keeps all content', pieces.join('').replace(/\s/g, '') === long.replace(/\s/g, ''));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
