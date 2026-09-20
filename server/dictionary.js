// In-session dictionary: GET /api/define?word=&lang=&target=
//
// Source: English Wiktionary. Its REST definition endpoint answers for words
// of every language (definitions are written in English). Where that endpoint
// has no entry for the language (it drops some Chinese pages, and it does not
// follow simplified -> traditional redirects) we fall back to Kaikki.org, a
// static Wiktextract dump of the same English Wiktionary data. Kaikki also
// supplies `translations` for English words. No API key, text sent: only the
// looked-up word. See the README for the privacy note.
const express = require('express');

const USER_AGENT = 'Bilingle-hackathon/1.0 (https://github.com/akhilmadipalli/Bilingle)';
const MAX_WORD_LENGTH = 100;
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX = 500;
const FETCH_TIMEOUT_MS = 6000;
const MAX_ENTRIES = 8;
const MAX_DEFINITIONS = 8;
const MAX_EXAMPLES = 3;
const MAX_TRANSLATIONS = 8;

// Kaikki file paths use English language names.
const LANGUAGES = {
  en: 'English', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian',
  pt: 'Portuguese', tr: 'Turkish', ja: 'Japanese', ko: 'Korean', zh: 'Chinese',
  ar: 'Arabic', ru: 'Russian', hi: 'Hindi',
};

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

// Wiktionary definitions come back as HTML; we only want the words.
function stripHtml(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
      if (code[0] === '#') {
        const point = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(point) && point < 0x110000 ? String.fromCodePoint(point) : match;
      }
      return ENTITIES[code.toLowerCase()] ?? match;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

async function getJson(url, fetchImpl) {
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  return res;
}

function restEntries(data, lang) {
  return (data[lang] || []).map((entry) => ({
    partOfSpeech: String(entry.partOfSpeech || '').toLowerCase(),
    definitions: entry.definitions.map((d) => stripHtml(d.definition)).filter(Boolean).slice(0, MAX_DEFINITIONS),
    examples: (entry.definitions.flatMap((d) => d.examples || [])).map(stripHtml).filter(Boolean).slice(0, MAX_EXAMPLES),
  }));
}

// Kaikki serves one JSONL file per word, sharded by its first one and two characters.
function kaikkiUrl(word, lang) {
  const chars = Array.from(word);
  const parts = [LANGUAGES[lang], 'meaning', chars[0], chars.slice(0, 2).join(''), `${word}.jsonl`];
  return `https://kaikki.org/dictionary/${parts.map(encodeURIComponent).join('/')}`;
}

async function readKaikki(word, lang, fetchImpl) {
  const res = await getJson(kaikkiUrl(word, lang), fetchImpl);
  if (!res) return [];
  return (await res.text()).split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function kaikkiEntries(lines) {
  const byPos = new Map();
  for (const line of lines) {
    if (!line.senses) continue;
    const entry = byPos.get(line.pos) || { partOfSpeech: String(line.pos || '').toLowerCase(), definitions: [], examples: [] };
    for (const sense of line.senses) {
      const gloss = sense.glosses && sense.glosses[sense.glosses.length - 1];
      if (!gloss) continue;
      entry.definitions.push(stripHtml(gloss));
      for (const ex of sense.examples || []) {
        if (ex.text) entry.examples.push(ex.english ? `${ex.text} - ${ex.english}` : ex.text);
      }
    }
    byPos.set(line.pos, entry);
  }
  return [...byPos.values()]
    .filter((e) => e.definitions.length)
    .map((e) => ({ ...e, definitions: e.definitions.slice(0, MAX_DEFINITIONS), examples: e.examples.slice(0, MAX_EXAMPLES) }));
}

// Returns { entries, redirect } - `redirect` is a soft-redirect target such as
// simplified 学习 -> traditional 學習 - or null when the word is unknown.
async function fromKaikki(word, lang, fetchImpl) {
  const lines = await readKaikki(word, lang, fetchImpl);
  const soft = lines.find((l) => l.pos === 'soft-redirect' && l.redirects && l.redirects[0]);
  const entries = kaikkiEntries(lines);
  return { entries, redirect: !entries.length && soft ? soft.redirects[0] : null };
}

// English words: pull translations into `target` from the Kaikki translation tables.
async function translationsFor(word, target, fetchImpl) {
  const found = [];
  for (const line of await readKaikki(word, 'en', fetchImpl)) {
    for (const t of line.translations || []) {
      if (t.lang_code === target && t.word && !found.includes(t.word)) found.push(t.word);
    }
  }
  return found.slice(0, MAX_TRANSLATIONS);
}

// One candidate spelling. Returns { word, entries } or null (unknown word).
// Throws only when nothing could confirm the word is absent.
async function resolve(word, lang, fetchImpl, followRedirect = true) {
  let failed = false;
  try {
    const res = await getJson(`https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(word)}`, fetchImpl);
    const entries = res ? restEntries(await res.json(), lang).filter((e) => e.definitions.length) : [];
    if (entries.length) return { word, entries: entries.slice(0, MAX_ENTRIES), source: 'Wiktionary (English edition)' };
  } catch {
    failed = true;
  }
  try {
    const { entries, redirect } = await fromKaikki(word, lang, fetchImpl);
    if (entries.length) return { word, entries: entries.slice(0, MAX_ENTRIES), source: 'Wiktionary via Kaikki.org' };
    if (redirect && followRedirect) return resolve(redirect, lang, fetchImpl, false);
  } catch {
    failed = true;
  }
  if (failed) throw new Error('upstream failed');
  return null;
}

function createRouter({ fetchImpl = fetch, now = Date.now } = {}) {
  const router = express.Router();
  // ponytail: in-memory Map, oldest-out at CACHE_MAX; add a real LRU if the demo outgrows it.
  const cache = new Map();

  router.get('/define', async (req, res) => {
    const word = typeof req.query.word === 'string' ? req.query.word.trim() : '';
    const lang = typeof req.query.lang === 'string' ? req.query.lang.toLowerCase() : '';
    const target = typeof req.query.target === 'string' ? req.query.target.toLowerCase() : '';

    if (!word) return res.status(400).json({ error: 'word is required' });
    if (Array.from(word).length > MAX_WORD_LENGTH) return res.status(400).json({ error: `word is over ${MAX_WORD_LENGTH} characters` });
    if (!/[\p{L}\p{N}]/u.test(word)) return res.status(400).json({ error: 'word must contain a letter or number' });
    if (!LANGUAGES[lang]) return res.status(400).json({ error: 'unsupported lang' });
    if (target && !LANGUAGES[target]) return res.status(400).json({ error: 'unsupported target' });

    const key = `${lang}|${target}|${word.toLowerCase()}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_TTL_MS) return res.status(hit.status).json(hit.body);

    let result = null;
    try {
      // Wiktionary titles are case sensitive ("Haus" vs "haus"): try what was typed, then lowercase.
      const spellings = [...new Set([word, word.toLowerCase()])];
      for (const spelling of spellings) {
        result = await resolve(spelling, lang, fetchImpl);
        if (result) break;
      }
    } catch (err) {
      return res.status(502).json({ error: 'dictionary source unavailable' });
    }

    let status = 404;
    let body = { error: 'not found' };
    if (result) {
      status = 200;
      body = { word: result.word, lang, definitionLang: 'en', entries: result.entries, source: result.source };
      if (lang === 'en' && target && target !== 'en') {
        try {
          const translations = await translationsFor(result.word, target, fetchImpl);
          if (translations.length) body.translations = translations;
        } catch { /* translations are a bonus, never fail the lookup for them */ }
      }
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
