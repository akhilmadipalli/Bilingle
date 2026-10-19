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

const pages = {
  'en:house': {
    title: 'house',
    extract: '== English ==\n\n\n=== Noun ===\nA structure for people.\n\n\n=== Verb ===\nTo give shelter to.',
  },
  'tr:dog': {
    title: 'dog',
    extract: '== İngilizce ==\n\n\n=== Köken ===\nOrta İngilizce dogge.\n\n\n=== Ad ===\nKöpek.',
  },
  'de:haus': {
    title: 'haus',
    extract: '== Deutsch ==\n\n\n=== Substantiv ===\nGebäude.',
  },
  'zh:学习': {
    title: '學習',
    extract: '== 漢語 ==\n\n\n=== 動詞 ===\n學習。',
  },
};

let calls = [];
let broken = false;
function stubFetch(url) {
  calls.push(url);
  if (broken) return Promise.reject(new Error('network down'));

  const parsed = new URL(url);
  const edition = parsed.hostname.split('.')[0];
  const title = parsed.searchParams.get('titles');
  const respond = (status, body) => ({ status, ok: status < 400, json: async () => body });

  if (title === 'broken') return respond(500, {});

  const page = pages[`${edition}:${title}`];
  if (!page) return respond(200, { query: { pages: [{ title, missing: true }] } });
  return respond(200, { query: { pages: [page] } });
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

  let r = await get({ word: 'house', fluent: 'en' });
  check('found: 200 with the asked word', r.status === 200 && r.body.word === 'house' && r.body.fluent === 'en');
  check('parses a level 2 language heading',
    r.body.sections[0].level === 2 && r.body.sections[0].title === 'English');
  check('parses level 3 sections with their text',
    r.body.sections[1].level === 3 && r.body.sections[1].title === 'Noun'
    && r.body.sections[1].text === 'A structure for people.');
  check('keeps every section', r.body.sections.length === 3 && r.body.sections[2].title === 'Verb');
  check('source links to the reader\'s own edition', r.body.source === 'https://en.wiktionary.org/wiki/house');

  r = await get({ word: 'dog', fluent: 'tr' });
  check('a different edition answers for a different reader',
    r.status === 200 && r.body.sections[0].title === 'İngilizce');
  check('headings are kept verbatim, not translated',
    r.body.sections[1].title === 'Köken' && r.body.sections[1].text === 'Orta İngilizce dogge.');

  check('a word missing from one edition 404s there', (await get({ word: 'dog', fluent: 'en' })).status === 404);

  const before = calls.length;
  r = await get({ word: 'House', fluent: 'en' });
  check('cache hit: no new upstream calls, same answer', calls.length === before && r.status === 200 && r.body.word === 'house');

  r = await get({ word: 'zzzqx', fluent: 'es' });
  check('not found: 404 { error: "not found" }', r.status === 404 && r.body.error === 'not found');
  const before404 = calls.length;
  await get({ word: 'zzzqx', fluent: 'es' });
  check('not found is cached too', calls.length === before404);

  r = await get({ word: 'Haus', fluent: 'de' });
  check('falls back to the lowercase spelling', r.status === 200 && r.body.word === 'haus');

  r = await get({ word: '学习', fluent: 'zh' });
  check('reports the title a redirect landed on', r.status === 200 && r.body.word === '學習');

  check('bad input: missing word', (await get({ fluent: 'en' })).status === 400);
  check('bad input: blank word', (await get({ word: '   ', fluent: 'en' })).status === 400);
  check('bad input: unsupported fluent language', (await get({ word: 'house', fluent: 'xx' })).status === 400);
  check('bad input: missing fluent language', (await get({ word: 'house' })).status === 400);
  check('bad input: no letters (path tricks)', (await get({ word: '..', fluent: 'en' })).status === 400);
  r = await get({ word: 'a'.repeat(MAX_WORD_LENGTH + 1), fluent: 'en' });
  check(`over-length: ${MAX_WORD_LENGTH + 1} chars is 400`, r.status === 400 && /100/.test(r.body.error));
  check(`${MAX_WORD_LENGTH} chars is accepted`, (await get({ word: 'a'.repeat(MAX_WORD_LENGTH), fluent: 'en' })).status === 404);

  r = await get({ word: 'broken', fluent: 'en' });
  check('upstream HTTP failure: 502', r.status === 502 && !!r.body.error);
  broken = true;
  r = await get({ word: 'kaput', fluent: 'en' });
  check('upstream unreachable: 502', r.status === 502 && !!r.body.error);
  broken = false;
  r = await get({ word: 'kaput', fluent: 'en' });
  check('upstream failures are not cached', r.status === 404);

  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main();
