// Checks for server/dictionary.js with a stubbed source: no network, no key.
const http = require('http');
const express = require('express');
const { createRouter, MAX_WORD_LENGTH } = require('../server/dictionary');

let passed = 0;
let failed = 0;
function check(name, condition) {
  console.log(`${condition ? 'PASS' : 'FAIL'}: ${name}`);
  condition ? passed++ : failed++;
}

// Fake Wiktionary + Kaikki. `pages` maps a URL substring to a response.
const restHouse = {
  en: [{
    partOfSpeech: 'Noun',
    definitions: [
      { definition: '' },
      { definition: 'A <a href="/wiki/abode">structure</a> for people &amp; things.<style>.x{}</style>', examples: ['This is my <b>house</b>.'] },
    ],
  }],
};
const kaikkiHouse = JSON.stringify({
  pos: 'noun', senses: [{ glosses: ['house'] }],
  translations: [{ lang_code: 'tr', word: 'ev' }, { lang_code: 'tr', word: 'ev' }, { lang_code: 'es', word: 'casa' }],
});
const kaikkiRedirect = JSON.stringify({ pos: 'soft-redirect', redirects: ['學習'], senses: [{ tags: ['no-gloss'] }] });
const kaikkiStudy = JSON.stringify({ pos: 'verb', senses: [{ glosses: ['to study'], examples: [{ text: '學習', english: 'study' }] }] });

let calls = [];
let broken = false;
function stubFetch(url) {
  calls.push(url);
  const respond = (status, body) => ({
    status, ok: status < 400, json: async () => body, text: async () => body,
  });
  if (broken) return Promise.reject(new Error('network down'));
  if (url.includes('rest_v1/page/definition/house')) return respond(200, restHouse);
  if (url.includes('English/meaning/h/ho/house.jsonl')) return respond(200, kaikkiHouse);
  if (url.includes('rest_v1/page/definition/Haus')) return respond(404, {});
  if (url.includes('rest_v1/page/definition/haus')) return respond(200, { de: [{ partOfSpeech: 'Noun', definitions: [{ definition: 'house' }] }] });
  if (url.includes('Chinese/meaning/%E5%AD%A6/%E5%AD%A6%E4%B9%A0')) return respond(200, kaikkiRedirect);
  if (url.includes('Chinese/meaning/%E5%AD%B8/%E5%AD%B8%E7%BF%92')) return respond(200, kaikkiStudy);
  if (url.includes('rest_v1/page/definition/broken')) return respond(500, {});
  return respond(404, '');
}

async function main() {
  const app = express();
  app.use('/api', createRouter({ fetchImpl: stubFetch }));
  const server = http.createServer(app).listen(0);
  const base = `http://localhost:${server.address().port}/api/define`;
  const get = async (params) => {
    const res = await fetch(`${base}?${new URLSearchParams(params)}`);
    return { status: res.status, body: await res.json() };
  };

  let r = await get({ word: 'house', lang: 'en', target: 'tr' });
  check('found: 200 with normalized entry', r.status === 200 && r.body.word === 'house' && r.body.lang === 'en'
    && r.body.entries[0].partOfSpeech === 'noun'
    && r.body.entries[0].definitions.length === 1
    && r.body.entries[0].definitions[0] === 'A structure for people & things.'
    && r.body.entries[0].examples[0] === 'This is my house.'
    && /Wiktionary/.test(r.body.source));
  check('found: translations into target, deduped', JSON.stringify(r.body.translations) === '["ev"]');

  const before = calls.length;
  r = await get({ word: 'House', lang: 'en', target: 'tr' });
  check('cache hit: no new upstream calls, same answer', calls.length === before && r.status === 200 && r.body.word === 'house');

  r = await get({ word: 'zzzqx', lang: 'es' });
  check('not found: 404 { error: "not found" }', r.status === 404 && r.body.error === 'not found');
  const before404 = calls.length;
  await get({ word: 'zzzqx', lang: 'es' });
  check('not found is cached too', calls.length === before404);

  r = await get({ word: 'Haus', lang: 'de' });
  check('falls back to lowercase spelling', r.status === 200 && r.body.word === 'haus');

  r = await get({ word: '学习', lang: 'zh' });
  check('Kaikki fallback follows a soft redirect', r.status === 200 && r.body.word === '學習'
    && r.body.source === 'Wiktionary via Kaikki.org' && r.body.entries[0].examples[0] === '學習 - study');

  check('bad input: missing word', (await get({ lang: 'en' })).status === 400);
  check('bad input: blank word', (await get({ word: '   ', lang: 'en' })).status === 400);
  check('bad input: unsupported lang', (await get({ word: 'house', lang: 'xx' })).status === 400);
  check('bad input: unsupported target', (await get({ word: 'house', lang: 'en', target: 'xx' })).status === 400);
  check('bad input: no letters (path tricks)', (await get({ word: '..', lang: 'en' })).status === 400);
  r = await get({ word: 'a'.repeat(MAX_WORD_LENGTH + 1), lang: 'en' });
  check(`over-length: ${MAX_WORD_LENGTH + 1} chars is 400`, r.status === 400 && /100/.test(r.body.error));
  check(`${MAX_WORD_LENGTH} chars is accepted`, (await get({ word: 'a'.repeat(MAX_WORD_LENGTH), lang: 'en' })).status === 404);

  r = await get({ word: 'broken', lang: 'en' });
  check('upstream HTTP failure: 502', r.status === 502 && !!r.body.error);
  broken = true;
  r = await get({ word: 'kaput', lang: 'en' });
  check('upstream unreachable: 502', r.status === 502 && !!r.body.error);
  broken = false;
  r = await get({ word: 'kaput', lang: 'en' });
  check('upstream failures are not cached', r.status === 404);

  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main();
