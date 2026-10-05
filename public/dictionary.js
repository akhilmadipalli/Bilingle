// In-session dictionary: Bilingle.dictionary.lookup() plus the "Dictionary" panel.
// Talks to GET /api/define (server/dictionary.js). All page text goes in via
// textContent; nothing from the server or the chat is ever parsed as HTML.
(() => {
  'use strict';
  const B = (window.Bilingle = window.Bilingle || {});

  // Promise of { word, lang, definitionLang, entries, translations?, source }.
  // Rejects with an Error carrying `status` (404 = not found, 400 = bad word,
  // 0 = could not reach our server, anything else = the source failed).
  async function lookup(word, lang, target) {
    const params = new URLSearchParams({ word, lang });
    if (target) params.set('target', target);
    let res;
    try {
      res = await fetch(`/api/define?${params}`);
    } catch {
      throw Object.assign(new Error('network'), { status: 0 });
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.error || 'lookup failed'), { status: res.status });
    return body;
  }

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  // The two languages of this match: `learning` is the one I practice (my
  // partner's fluent language), `fluent` is mine. Set by startSession().
  let session = null;
  let ui = null;
  let current = null; // language code currently selected
  let ticket = 0;     // latest lookup wins
  let opener = null;

  function build() {
    const button = el('button', 'secondary dict-open', 'Dictionary');
    button.type = 'button';
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', 'dictionary-panel');

    const panel = el('section', 'dict-panel');
    panel.id = 'dictionary-panel';
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-labelledby', 'dict-title');

    const top = el('div', 'dict-top');
    const title = el('h2', '', 'Dictionary');
    title.id = 'dict-title';
    const close = el('button', 'dict-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close dictionary');
    top.append(title, close);

    const switcher = el('div', 'dict-langs');
    switcher.setAttribute('role', 'group');
    switcher.setAttribute('aria-label', 'Dictionary language');

    const form = el('form', 'dict-form');
    const label = el('label', 'sr-only', 'Word to look up');
    label.htmlFor = 'dict-word';
    const input = el('input');
    input.id = 'dict-word';
    input.maxLength = 100;
    input.autocomplete = 'off';
    input.autocapitalize = 'off';
    input.spellcheck = false;
    input.required = true;
    const go = el('button', 'primary', 'Look up');
    go.type = 'submit';
    form.append(label, input, go);

    const status = el('p', 'dict-status');
    status.setAttribute('role', 'status');
    const results = el('div', 'dict-results');

    panel.append(top, switcher, form, status, results);

    button.addEventListener('click', () => (panel.hidden ? open() : closePanel()));
    close.addEventListener('click', closePanel);
    panel.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        closePanel();
      }
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      search(input.value);
    });

    document.querySelector('.call-bottom').append(button);
    document.getElementById('matched').append(panel);
    return { button, panel, switcher, input, status, results };
  }

  function renderSwitcher() {
    ui.switcher.replaceChildren(...[session.learning, session.fluent].map((code) => {
      const b = el('button', 'dict-lang', session.langName(code));
      b.type = 'button';
      b.lang = code;
      b.setAttribute('aria-pressed', String(code === current));
      b.addEventListener('click', () => {
        current = code;
        renderSwitcher();
        if (ui.input.value.trim()) search(ui.input.value);
        else ui.input.focus();
      });
      return b;
    }));
  }

  function setStatus(text) {
    ui.status.textContent = text;
    ui.status.hidden = !text;
  }

  function idle() {
    ui.results.replaceChildren();
    setStatus(`Type a word in ${session.langName(current)}, or double-click any word in the chat.`);
  }

  function open(word, lang) {
    if (!session) return;
    if (ui.panel.hidden) opener = document.activeElement;
    ui.panel.hidden = false;
    ui.button.setAttribute('aria-expanded', 'true');
    if (lang) current = lang;
    renderSwitcher();
    if (word) {
      ui.input.value = word;
      search(word);
    } else if (!ui.results.hasChildNodes()) {
      idle();
    }
    ui.input.focus();
    ui.input.select();
  }

  function closePanel() {
    ui.panel.hidden = true;
    ui.button.setAttribute('aria-expanded', 'false');
    ticket++;
    const back = opener && document.contains(opener) && !opener.closest('[hidden]') ? opener : ui.button;
    opener = null;
    back.focus();
  }

  async function search(raw) {
    const word = raw.trim();
    if (!word) return;
    const lang = current;
    const mine = ++ticket;
    ui.results.replaceChildren();
    setStatus(`Looking up “${word}” in ${session.langName(lang)}…`);
    try {
      const data = await lookup(word, lang, session.fluent);
      if (mine === ticket) render(data, word);
    } catch (err) {
      if (mine === ticket) fail(err, word, lang);
    }
  }

  function fail(err, word, lang) {
    ui.results.replaceChildren();
    const other = lang === session.learning ? session.fluent : session.learning;
    if (err.status === 404) {
      setStatus(`No entry for “${word}” in ${session.langName(lang)}. Check the spelling, try the base form (singular, infinitive), or switch language.`);
      const retry = el('button', 'secondary dict-retry', `Try in ${session.langName(other)}`);
      retry.type = 'button';
      retry.addEventListener('click', () => {
        current = other;
        renderSwitcher();
        search(word);
      });
      ui.results.append(retry);
    } else if (err.status === 400) {
      setStatus('That does not look like a word. Type one word or a short phrase, up to 100 characters, with at least one letter.');
    } else {
      setStatus('The dictionary could not be reached. Your word is fine - wait a moment and press Look up again.');
    }
  }

  function render(data, asked) {
    const lang = data.lang;
    const head = el('div', 'dict-head');
    const headword = el('h3', 'dict-word', data.word);
    headword.lang = lang;
    head.append(headword, el('span', 'dict-badge', session.langName(lang)));
    const nodes = [head];

    if (data.word !== asked) nodes.push(el('p', 'dict-note', `Showing the entry “${data.word}” for “${asked}”.`));
    if (data.translations && data.translations.length) {
      const tr = el('p', 'dict-translations', `In ${session.langName(session.fluent)}: `);
      const list = el('span', 'dict-tr-list', data.translations.join(', '));
      list.lang = session.fluent;
      tr.append(list);
      nodes.push(tr);
    }

    // Definitions are in the source's language (English), not always the user's.
    const defLang = data.definitionLang;
    const foreign = defLang && defLang !== session.fluent;
    if (foreign) {
      nodes.push(el('p', 'dict-note', `No ${session.langName(session.fluent)} definitions for this source, so these are in ${session.langName(defLang)}.`));
      if (B.translate && typeof B.translate.translate === 'function') nodes.push(translateButton(defLang));
    }

    for (const entry of data.entries) {
      const article = el('article', 'dict-entry');
      article.append(el('h4', 'dict-pos', entry.partOfSpeech || 'entry'));
      const defs = el('ol', 'dict-defs');
      defs.lang = defLang || 'en';
      for (const text of entry.definitions) {
        const li = el('li');
        li.append(el('span', 'dict-def', text));
        defs.append(li);
      }
      article.append(defs);
      if (entry.examples && entry.examples.length) {
        const examples = el('ul', 'dict-examples');
        for (const text of entry.examples) {
          const li = el('li', '', text);
          li.lang = lang;
          examples.append(li);
        }
        article.append(examples);
      }
      nodes.push(article);
    }

    const source = el('p', 'dict-source', 'Source: ');
    const link = el('a', '', data.source);
    link.href = `https://en.wiktionary.org/wiki/${encodeURIComponent(data.word)}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    source.append(link);
    nodes.push(source);

    setStatus('');
    ui.results.replaceChildren(...nodes);
  }

  // Optional: only offered when the shared translation service is loaded.
  function translateButton(defLang) {
    const button = el('button', 'secondary dict-translate', `Translate definitions to ${session.langName(session.fluent)}`);
    button.type = 'button';
    button.addEventListener('click', async () => {
      button.disabled = true;
      button.textContent = 'Translating…';
      const spans = [...ui.results.querySelectorAll('.dict-def')].slice(0, 12);
      let failed = false;
      for (const span of spans) {
        if (span.nextSibling) continue;
        try {
          const text = await B.translate.translate(span.textContent, defLang, session.fluent);
          const out = el('span', 'dict-translated', text);
          out.lang = session.fluent;
          span.after(out);
        } catch {
          failed = true;
          break;
        }
      }
      button.disabled = false;
      button.textContent = failed ? 'Translation failed, try again' : 'Translated';
      button.disabled = !failed;
    });
    return button;
  }

  // Double-click a word in a chat message. The browser has already selected it.
  function onChatDoubleClick(event) {
    const body = event.target.closest && event.target.closest('.message-body');
    if (!body || !session) return;
    const word = String(window.getSelection()).replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (!word) return;
    const mine = body.closest('.message').classList.contains('author-self');
    // A partner writes in their fluent language; I mostly write in mine.
    open(word.slice(0, 100), mine ? session.fluent : session.learning);
  }

  // Called from the `matched` handler. `learning` = partner.fluentLang,
  // `fluent` = partner.learningLang.
  function startSession({ learning, fluent, langName }) {
    if (!ui) {
      ui = build();
      document.getElementById('messages').addEventListener('dblclick', onChatDoubleClick);
    }
    session = { learning, fluent, langName };
    current = learning;
    ui.panel.hidden = true;
    ui.button.setAttribute('aria-expanded', 'false');
    ui.input.value = '';
    ui.results.replaceChildren();
    ticket++;
    renderSwitcher();
  }

  B.dictionary = { lookup, startSession, open: (word, lang) => open(word, lang) };
})();
