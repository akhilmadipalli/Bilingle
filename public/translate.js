// Bilingle.translate - the only client code that talks to /api/translate.
//   Bilingle.translate.translate(text, from, to) -> Promise<string>
//   Bilingle.translate.attachButton(item, text, to) adds the per-message
//   "Translate" button + hand-inked result to a chat message element.
// `from` may be 'auto'. Rejects with an Error (plain-language message) on failure.
window.Bilingle = window.Bilingle || {};
let uid = 0;

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

  // One click shows the translation under the bubble, the next hides it. The
  // same button is also the retry after a failure. Nothing is sent until pressed.
  // ponytail: result cached per message element only, not shared across messages.
  attachButton(item, text, to) {
    const id = `translation-${++uid}`;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'translate-btn';
    button.textContent = 'Translate';
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', id);

    const out = document.createElement('p');
    out.id = id;
    out.className = 'message-translation';
    out.setAttribute('role', 'status');
    out.lang = to;
    out.hidden = true;

    let cached = null;
    let busy = false;

    const show = (message, cls) => {
      out.textContent = message;
      out.className = 'message-translation' + (cls ? ` ${cls}` : '');
      out.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      out.scrollIntoView({ block: 'nearest' }); // keep it visible at the bottom of the log
    };

    button.addEventListener('click', async () => {
      if (busy) return;
      if (!out.hidden && cached !== null) {
        out.hidden = true;
        button.setAttribute('aria-expanded', 'false');
        button.textContent = 'Translate';
        return;
      }
      if (cached !== null) {
        show(cached);
        button.textContent = 'Hide translation';
        return;
      }

      busy = true;
      button.setAttribute('aria-busy', 'true');
      button.textContent = 'Translating...';
      out.lang = 'en';
      show('Translating...', 'is-loading');
      try {
        cached = await window.Bilingle.translate.translate(text, 'auto', to);
        out.lang = to;
        show(cached);
        button.textContent = 'Hide translation';
      } catch (err) {
        show(`Couldn\u2019t translate that: ${err.message}`, 'is-error');
        button.textContent = 'Retry';
      } finally {
        busy = false;
        button.removeAttribute('aria-busy');
      }
    });

    item.append(button, out);
  },
};
