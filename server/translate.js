// POST /api/translate  { text, from, to }  ->  200 { translatedText, from, to }
// Errors: 400 { error } bad input or text over 1000 chars, 429 rate limited,
// 502 the translation provider failed. `from` may be "auto".
//
// This is the ONE translation endpoint in the app; other features call it
// (client side through public/translate.js) instead of adding their own.
const express = require('express');
const defaultProvider = require('./translateProvider');

const MAX_CHARS = 1000;
const CACHE_LIMIT = 500;
const CODE = /^[a-z]{2}$/;

function createRouter({ provider = defaultProvider, limit = 60, windowMs = 60_000 } = {}) {
  const router = express.Router();

  // ponytail: in-memory FIFO cache and fixed-window rate limit; both reset on
  // restart and are per-process, fine for one demo server.
  const cache = new Map(); // "from|to|text" -> translatedText
  const hits = new Map(); // ip -> { count, resetAt }

  function rateLimited(ip) {
    const now = Date.now();
    let entry = hits.get(ip);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(ip, entry);
      for (const [key, e] of hits) if (e.resetAt <= now) hits.delete(key); // keep the map small
    }
    entry.count += 1;
    return entry.count > limit;
  }

  router.use(express.json({ limit: '16kb' }));

  router.post('/translate', async (req, res) => {
    const { text, from, to } = req.body || {};

    if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'text is required' });
    if (text.length > MAX_CHARS) return res.status(400).json({ error: `text is over ${MAX_CHARS} characters` });
    if (typeof from !== 'string' || (from !== 'auto' && !CODE.test(from))) {
      return res.status(400).json({ error: 'from must be a 2-letter language code or "auto"' });
    }
    if (typeof to !== 'string' || !CODE.test(to)) {
      return res.status(400).json({ error: 'to must be a 2-letter language code' });
    }

    if (rateLimited(req.ip)) return res.status(429).json({ error: 'too many translations, slow down a little' });

    if (from === to) return res.json({ translatedText: text, from, to });

    const key = `${from}|${to}|${text}`;
    if (cache.has(key)) return res.json({ translatedText: cache.get(key), from, to });

    let translatedText;
    try {
      translatedText = await provider.translate(text, from, to);
      if (typeof translatedText !== 'string' || !translatedText) throw new Error('empty translation');
    } catch (err) {
      console.error('translate provider failed:', err.message);
      return res.status(502).json({ error: 'translation service unavailable' });
    }

    cache.set(key, translatedText);
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
    res.json({ translatedText, from, to });
  });

  // Malformed / oversized JSON bodies land here; keep the answer JSON.
  router.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
      return res.status(400).json({ error: 'invalid request body' });
    }
    next(err);
  });

  return router;
}

module.exports = createRouter();
module.exports.createRouter = createRouter;
