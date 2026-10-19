// In-session dictionary: GET /api/define?word=&fluent=
//
// a word is always explained in the reader's own language, so we query the
// reader's own wiktionary edition: en.wiktionary for an English speaker,
// tr.wiktionary for a Turkish one. both sides of a match use a different
// edition. no api key; the looked-up word is the only thing sent.
//
// the REST /page/definition/ endpoint only exists on the English edition
// (501 elsewhere), so we use the MediaWiki action API, which every edition
// serves. it returns the page as plain text with wiki headings.
const express = require('express');

const USER_AGENT = 'Bilingle-hackathon/1.0 (https://github.com/akhilmadipalli/Bilingle)';
const MAX_WORD_LENGTH = 100;
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX = 500;
const FETCH_TIMEOUT_MS = 6000;
const MAX_SECTIONS = 60;
const MAX_SECTION_CHARS = 1200;

// editions a user may pick. each is a real {code}.wiktionary.org site.
const EDITIONS = new Set([
  'en', 'es', 'fr', 'de', 'it', 'pt', 'tr', 'ja', 'ko', 'zh', 'ar', 'ru', 'hi',
]);

function apiUrl(word, fluent) {
  const params = new URLSearchParams({
    action: 'query',
    prop: 'extracts',
    explaintext: '1',
    redirects: '1',
    format: 'json',
    formatversion: '2',
    titles: word,
  });
  return `https://${fluent}.wiktionary.org/w/api.php?${params}`;
}

// an extract looks like:
//   == İngilizce ==
//   === Köken ===
//   Orta İngilizce dogge sözcüğünden.
// level 2 is a language, deeper levels are its sections. headings stay
// verbatim: they are already in the reader's language, which is the point.
const HEADING = /^(={2,6})\s*(.+?)\s*\1$/;

function parseExtract(extract) {
  const sections = [];
  let current = null;

  for (const raw of String(extract).split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    const heading = line.match(HEADING);
    if (heading) {
      current = { level: heading[1].length, title: heading[2], text: '' };
      sections.push(current);
      continue;
    }

    // body text before the first heading has no section to belong to.
    if (!current || current.text.length >= MAX_SECTION_CHARS) continue;
    current.text += current.text ? `\n${line}` : line;
  }

  return sections.slice(0, MAX_SECTIONS);
}

// returns { title, sections } or null when the edition has no such page.
// throws when the edition could not be reached at all.
async function fetchPage(word, fluent, fetchImpl) {
  const res = await fetchImpl(apiUrl(word, fluent), {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`upstream ${res.status}`);

  const body = await res.json();
  const page = body && body.query && body.query.pages && body.query.pages[0];
  if (!page || page.missing || !page.extract) return null;

  const sections = parseExtract(page.extract);
  return sections.length ? { title: page.title || word, sections } : null;
}

function createRouter({ fetchImpl = fetch, now = Date.now } = {}) {
  const router = express.Router();
  // in-memory Map, oldest-out at CACHE_MAX; add a real LRU if the demo outgrows it.
  const cache = new Map();

  router.get('/define', async (req, res) => {
    const word = typeof req.query.word === 'string' ? req.query.word.trim() : '';
    const fluent = typeof req.query.fluent === 'string' ? req.query.fluent.toLowerCase() : '';

    if (!word) return res.status(400).json({ error: 'word is required' });
    if (Array.from(word).length > MAX_WORD_LENGTH) return res.status(400).json({ error: `word is over ${MAX_WORD_LENGTH} characters` });
    if (!/[\p{L}\p{N}]/u.test(word)) return res.status(400).json({ error: 'word must contain a letter or number' });
    if (!EDITIONS.has(fluent)) return res.status(400).json({ error: 'unsupported fluent language' });

    const key = `${fluent}|${word.toLowerCase()}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_TTL_MS) return res.status(hit.status).json(hit.body);

    let result = null;
    try {
      // wiktionary titles are case sensitive ("Haus" vs "haus"): try what was
      // typed, then lowercase.
      for (const spelling of [...new Set([word, word.toLowerCase()])]) {
        result = await fetchPage(spelling, fluent, fetchImpl);
        if (result) break;
      }
    } catch {
      // never cached: the word may well exist once the edition is reachable.
      return res.status(502).json({ error: 'dictionary source unavailable' });
    }

    let status = 404;
    let body = { error: 'not found' };
    if (result) {
      status = 200;
      body = {
        word: result.title,
        fluent,
        sections: result.sections,
        source: `https://${fluent}.wiktionary.org/wiki/${encodeURIComponent(result.title)}`,
      };
    }

    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, { status, body, at: now() });
    res.status(status).json(body);
  });

  return router;
}

module.exports = createRouter();
module.exports.createRouter = createRouter;
module.exports.MAX_WORD_LENGTH = MAX_WORD_LENGTH;
module.exports.EDITIONS = EDITIONS;
