// The one place that knows which translation service we use. To swap
// providers, replace this file: export a single async function
//   translate(text, from, to) -> Promise<string>
// where `from` may be 'auto', and throw an Error on any failure.
//
// Current provider: MyMemory (https://mymemory.translated.net). Free, no key,
// supports 2-letter ISO 639-1 codes and `Autodetect`. Anonymous use is capped
// at 5000 characters per day per IP; setting MYMEMORY_EMAIL in server/.env
// raises that to 50000. Each request may carry at most 500 characters, so
// longer text is split into chunks and stitched back together.

const ENDPOINT = 'https://api.mymemory.translated.net/get';
const MAX_CHUNK = 450; // MyMemory rejects >500; leave headroom
const TIMEOUT_MS = 8000;

// Split on sentence ends, pack sentences into chunks <= MAX_CHUNK, and hard-cut
// (at a space when possible) any single sentence that is still too long.
function chunk(text) {
  const pieces = text.match(/[^.!?。！？]+[.!?。！？]*\s*/g) || [text];
  const chunks = [];
  let current = '';

  const push = (piece) => {
    if (current && current.length + piece.length > MAX_CHUNK) {
      chunks.push(current);
      current = '';
    }
    current += piece;
  };

  for (let piece of pieces) {
    while (piece.length > MAX_CHUNK) {
      let cut = piece.lastIndexOf(' ', MAX_CHUNK);
      if (cut < MAX_CHUNK / 2) cut = MAX_CHUNK;
      push(piece.slice(0, cut));
      piece = piece.slice(cut);
    }
    push(piece);
  }
  if (current) chunks.push(current);
  return chunks.map((c) => c.trim()).filter(Boolean);
}

async function translateChunk(text, from, to) {
  const url = new URL(ENDPOINT);
  url.searchParams.set('q', text);
  url.searchParams.set('langpair', `${from === 'auto' ? 'Autodetect' : from}|${to}`);
  if (process.env.MYMEMORY_EMAIL) url.searchParams.set('de', process.env.MYMEMORY_EMAIL);

  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`MyMemory HTTP ${res.status}`);
  const body = await res.json();

  // MyMemory reports errors inside a 200 response, with the message in
  // translatedText, so the status field is the only reliable signal.
  const status = Number(body.responseStatus);
  const message = (body.responseDetails || body.responseData?.translatedText || '').toString();
  if (status === 403 && /DISTINCT LANGUAGES/i.test(message)) return text; // already in the target language
  if (status !== 200 || typeof body.responseData?.translatedText !== 'string') {
    throw new Error(`MyMemory error ${status}: ${message}`.slice(0, 200));
  }
  return body.responseData.translatedText;
}

async function translate(text, from, to) {
  const parts = await Promise.all(chunk(text).map((c) => translateChunk(c, from, to)));
  return parts.join(' ');
}

module.exports = { translate, chunk };
