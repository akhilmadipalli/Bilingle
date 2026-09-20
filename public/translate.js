// Bilingle.translate - the only client code that talks to /api/translate.
//   Bilingle.translate.translate(text, from, to) -> Promise<string>
// `from` may be 'auto'. Rejects with an Error (plain-language message) on failure.
window.Bilingle = window.Bilingle || {};
window.Bilingle.translate = {
  async translate(text, from, to) {
    let res;
    try {
      res = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, from, to }),
      });
    } catch {
      throw new Error('Could not reach the translator. Check your connection.');
    }

    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'Translation failed.');
    return body.translatedText;
  },
};
