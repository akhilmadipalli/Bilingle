// In-session dictionary: Bilingle.dictionary.lookup() plus the "Dictionary" panel.
// Talks to GET /api/define (server/dictionary.js). All page text goes in via
// textContent; nothing from the server or the chat is ever parsed as HTML.
(() => {
  'use strict';
  const B = (window.Bilingle = window.Bilingle || {});

  async function lookup(word, fluent) {
    const params = new URLSearchParams({ word, fluent });
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

  let session = null;
  let ui = null;
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

    panel.append(top, form, status, results);

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
    return { button, panel, input, status, results };
  }

  function setStatus(text) {
    ui.status.textContent = text;
    ui.status.hidden = !text;
  }

  function idle() {
    ui.results.replaceChildren();
    setStatus('Type a word in either language, or double-click any word in the chat.');
  }

  function open(word) {
    if (!session) return;
    if (ui.panel.hidden) opener = document.activeElement;
    ui.panel.hidden = false;
    ui.button.setAttribute('aria-expanded', 'true');

    if (word) {
      ui.input.value = word;
      search(word);
    } else if (!ui.results.childElementCount) {
      idle();
    }
    ui.input.focus();
  }

  function closePanel() {
    ui.panel.hidden = true;
    ui.button.setAttribute('aria-expanded', 'false');
    ticket++;
    if (opener && document.contains(opener)) opener.focus();
    opener = null;
  }

  async function search(raw) {
    const word = raw.trim();
    if (!word) return;
    const mine = ++ticket;
    ui.results.replaceChildren();
    setStatus(`Looking up “${word}”…`);
    try {
      const data = await lookup(word, session.fluent);
      if (mine === ticket) render(data, word);
    } catch (err) {
      if (mine === ticket) fail(err, word);
    }
  }

  function fail(err, word) {
    ui.results.replaceChildren();
    if (err.status === 404) {
      setStatus(`No entry for “${word}” in the ${session.langName(session.fluent)} Wiktionary. Check the spelling, or try the base form (singular, infinitive).`);
    } else if (err.status === 400) {
      setStatus('That does not look like a word.');
    } else if (err.status === 0) {
      setStatus('Could not reach the server. Check your connection.');
    } else {
      setStatus('The dictionary source is unavailable right now. Try again shortly.');
    }
  }

  function headingTag(level) {
    if (level <= 2) return 'h4';
    if (level === 3) return 'h5';
    return 'h6';
  }

  function render(data, asked) {
    const nodes = [];
    const headword = el('h3', 'dict-word', data.word);
    headword.lang = data.fluent;
    nodes.push(headword);

    if (data.word !== asked) {
      nodes.push(el('p', 'dict-note', `Showing the entry “${data.word}” for “${asked}”.`));
    }

    for (const section of data.sections) {
      nodes.push(el(headingTag(section.level), `dict-section dict-level-${section.level}`, section.title));
      for (const line of section.text.split('\n')) {
        if (line) nodes.push(el('p', 'dict-line', line));
      }
    }

    const source = el('p', 'dict-source', 'Source: ');
    const link = el('a', '', 'Wiktionary');
    link.href = data.source;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    source.append(link);
    nodes.push(source);

    setStatus('');
    ui.results.replaceChildren(...nodes);
  }

  // Double-click a word in a chat message. The browser has already selected it.
  function onChatDoubleClick(event) {
    const body = event.target.closest && event.target.closest('.message-body');
    if (!body || !session) return;
    const word = String(window.getSelection()).replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (!word) return;
    open(word.slice(0, 100));
  }

  // Called from the `matched` handler. `learning` = partner.fluentLang,
  // `fluent` = partner.learningLang.
  function startSession({ learning, fluent, langName }) {
    if (!ui) {
      ui = build();
      document.getElementById('messages').addEventListener('dblclick', onChatDoubleClick);
    }
    session = { learning, fluent, langName };
    ui.panel.hidden = true;
    ui.button.setAttribute('aria-expanded', 'false');
    ui.input.value = '';
    ui.results.replaceChildren();
    ticket++;
  }

  B.dictionary = { lookup, startSession, open: (word) => open(word) };
})();
