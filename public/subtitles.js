// Bilingle.subtitles - live subtitles with translation during the video call.
//
// Each browser recognizes its OWN speech (Web Speech API, Chrome/Edge) and sends the text
// to the partner over Daily app messages. The partner's page shows the last two lines at the
// bottom of the video and translates finished lines into the viewer's fluent language through
// Bilingle.translate.translate. Speech goes to the browser vendor's speech service (Google in
// Chrome, Microsoft in Edge); translated text goes through /api/translate.
//
// Pieces (all injectable, so tests use fakes):
//   recognizer  { supported, start(lang, { onResult({text,isFinal}), onError(code), onEnd() }), stop() }
//   transport   { send(msg), listen(cb) -> unlisten }         (dailyTransport below)
//   translate   (text, from, to) -> Promise<string>
//   onLines     (lines) -> void      lines: [{ id, text, translated?, interim }], newest last
//   onStatus    (text) -> void       short plain-language state for the controls
(function (root) {
  'use strict';

  const TYPE = 'bilingle-subtitle';
  const MAX_LINES = 2;
  const MAX_TEXT = 500;
  const MAX_FAILURES = 5;
  const NEEDS_CHROME = 'Live subtitles need Chrome or Edge. You can still read your partner’s.';
  // Errors after which retrying can only loop (or re-prompt for the mic), so we stop for good.
  const FATAL = new Set(['not-allowed', 'service-not-allowed', 'language-not-supported']);
  // Normal end-of-utterance noise, not a failure.
  const QUIET = new Set(['no-speech', 'aborted']);

  const BCP47 = {
    en: 'en-US', es: 'es-ES', fr: 'fr-FR', de: 'de-DE', it: 'it-IT', pt: 'pt-BR',
    ja: 'ja-JP', ko: 'ko-KR', zh: 'zh-CN', ar: 'ar-SA', hi: 'hi-IN', tr: 'tr-TR',
  };
  const toBcp47 = (code) => BCP47[code] || code;

  function createSubtitles(opts) {
    const {
      recognizer, transport, translate, onLines = () => {}, onStatus = () => {},
      fadeMs = 6000, restartMs = 300, interimMs = 400,
      now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout,
    } = opts;

    let langs = { fluent: 'en', learning: 'es' };
    let speaking = 'fluent';      // which of my two languages I am speaking right now
    let enabled = true;           // the CC switch: I send my speech AND see theirs
    let inCall = false;
    let recognizing = false;
    let failures = 0;
    let unlisten = null;
    let restartTimer = null;
    let fadeTimer = null;
    let utterance = 0;            // id of my current sentence, bumped after each final
    let lastInterimAt = -Infinity;
    let lines = [];               // partner subtitles on screen, newest last
    let enabledChanged = () => {};

    const speakingLang = () => langs[speaking];
    const emit = () => onLines(lines.map((l) => ({ ...l })));

    function armFade() {
      clearTimer(fadeTimer);
      fadeTimer = setTimer(() => { lines = []; emit(); }, fadeMs);
    }

    function turnOff(status) {
      enabled = false;
      stopRecognizing();
      onStatus(status);
      enabledChanged(false);
    }

    // ---- sending my own speech ----
    function send(text, isFinal) {
      try {
        transport.send({ type: TYPE, id: utterance, text: text.slice(0, MAX_TEXT), lang: speakingLang(), final: isFinal });
      } catch { /* call not joined yet or already gone: subtitles are best-effort */ }
    }

    function onResult({ text, isFinal }) {
      text = (text || '').trim();
      if (!text) return;
      failures = 0;
      if (isFinal) {
        send(text, true);
        utterance += 1;
        lastInterimAt = -Infinity;
      } else if (now() - lastInterimAt >= interimMs) { // Daily documents no rate limit, so be gentle
        lastInterimAt = now();
        send(text, false);
      }
    }

    function startRecognizing() {
      if (recognizing || !inCall || !enabled || !recognizer.supported) return;
      recognizing = true;
      recognizer.start(toBcp47(speakingLang()), {
        onResult,
        onError(code) {
          if (FATAL.has(code)) {
            turnOff(code === 'language-not-supported'
              ? 'This browser cannot recognize that language.'
              : 'Speech recognition is blocked. Allow the microphone, then turn CC on again.');
          } else if (!QUIET.has(code)) {
            failures += 1;
          }
        },
        onEnd() {
          // Continuous recognition ends after silence or a time limit: restart while CC is on.
          recognizing = false;
          if (!inCall || !enabled) return;
          if (failures >= MAX_FAILURES) return turnOff('Subtitles stopped: the speech service is not answering.');
          clearTimer(restartTimer);
          restartTimer = setTimer(startRecognizing, restartMs);
        },
      });
      onStatus('Listening...');
    }

    function stopRecognizing() {
      clearTimer(restartTimer);
      restartTimer = null;
      if (recognizing) recognizer.stop();
      recognizing = false;
    }

    // ---- receiving the partner's lines ----
    function onMessage(msg) {
      if (!enabled || !msg || msg.type !== TYPE) return;
      if (typeof msg.text !== 'string' || !msg.text.trim() || !/^[a-z]{2,3}$/.test(msg.lang)) return;
      const text = msg.text.slice(0, MAX_TEXT);
      const isFinal = msg.final === true;

      let line = lines.find((l) => l.id === msg.id);
      if (!line) {
        line = { id: msg.id };
        lines.push(line);
        if (lines.length > MAX_LINES) lines.shift();
      }
      line.text = text;
      line.interim = !isFinal;
      emit();
      armFade();

      if (isFinal && msg.lang !== langs.fluent) {
        Promise.resolve().then(() => translate(text, msg.lang, langs.fluent)).then((translated) => {
          // ignore if the line scrolled off or was replaced while we waited
          if (lines.includes(line) && line.text === text) {
            line.translated = translated;
            emit();
            armFade();
          }
        }, () => { /* translation failed: the original stays on screen */ });
      }
    }

    return {
      supported: !!recognizer.supported,
      configure(next) { langs = { fluent: next.fluent, learning: next.learning }; speaking = 'fluent'; },

      // Call once joined. Safe to call again (restarts cleanly).
      start() {
        this.stop();
        inCall = true;
        failures = 0;
        unlisten = transport.listen(onMessage);
        if (!recognizer.supported) return onStatus(NEEDS_CHROME);
        if (enabled) startRecognizing(); else onStatus('Subtitles are off.');
      },

      // Leave / skip / partner left: stop everything, clear the screen.
      stop() {
        inCall = false;
        stopRecognizing();
        if (unlisten) { unlisten(); unlisten = null; }
        clearTimer(fadeTimer);
        lines = [];
        emit();
      },

      setEnabled(on) {
        enabled = !!on;
        failures = 0;
        if (!inCall) return;
        if (enabled) {
          if (recognizer.supported) startRecognizing(); else onStatus(NEEDS_CHROME);
        } else {
          stopRecognizing();
          lines = [];
          emit();
          onStatus('Subtitles are off.');
        }
      },

      // 'fluent' | 'learning': restart recognition in the other language.
      setSpeaking(which) {
        if (which !== 'fluent' && which !== 'learning') return;
        speaking = which;
        if (recognizing) { stopRecognizing(); startRecognizing(); }
      },

      onEnabledChange(cb) { enabledChanged = cb; },
      get enabled() { return enabled; },
      get speaking() { return speaking; },
    };
  }

  // ---- adapters ----

  // Browser SpeechRecognition wrapped to the small recognizer contract.
  function browserRecognizer(win) {
    const Ctor = win.SpeechRecognition || win.webkitSpeechRecognition;
    let rec = null;
    return {
      supported: !!Ctor,
      start(lang, handlers) {
        rec = new Ctor();
        rec.lang = lang;
        rec.continuous = true;
        rec.interimResults = true;
        rec.onresult = (event) => {
          let interim = '';
          for (let i = event.resultIndex; i < event.results.length; i++) {
            const r = event.results[i];
            if (r.isFinal) handlers.onResult({ text: r[0].transcript, isFinal: true });
            else interim += r[0].transcript;
          }
          if (interim) handlers.onResult({ text: interim, isFinal: false });
        };
        rec.onerror = (event) => handlers.onError(event.error);
        rec.onend = () => handlers.onEnd();
        try { rec.start(); } catch { handlers.onError('start-failed'); handlers.onEnd(); }
      },
      stop() {
        if (!rec) return;
        const r = rec;
        rec = null;
        r.onresult = r.onerror = r.onend = null; // a stopped session must not restart itself
        try { r.abort(); } catch { /* already stopped */ }
      },
    };
  }

  // Daily app messages over whichever call object is current (Prebuilt frame or call object mode:
  // both expose sendAppMessage and the app-message event). Broadcast is not delivered to the sender.
  // Limits: 4KB per message, not replayed to late joiners; a rate limit is not documented.
  function dailyTransport(getCall) {
    return {
      send(msg) {
        const call = getCall();
        if (call) call.sendAppMessage(msg, '*');
      },
      listen(cb) {
        const call = getCall();
        if (!call) return () => {};
        const handler = (event) => cb(event && event.data);
        call.on('app-message', handler);
        return () => { try { call.off('app-message', handler); } catch { /* call destroyed */ } };
      },
    };
  }

  // ---- DOM: bind the static markup in index.html ----
  function bindDom(doc, api) {
    const $ = (id) => doc.getElementById(id);
    const overlay = $('subtitles');
    if (!overlay) return null;
    const toggle = $('cc-toggle');
    const note = $('subs-note');
    const radios = doc.querySelectorAll('input[name="speak-lang"]');
    let mode = 'both';
    let lastLines = [];

    function render(lines) {
      lastLines = lines;
      overlay.replaceChildren();
      for (const l of lines) {
        const p = doc.createElement('p');
        p.className = 'sub-line' + (l.interim ? ' interim' : '');
        const showTr = l.translated && mode !== 'original';
        if (mode !== 'translated' || !l.translated) {
          const o = doc.createElement('span');
          o.className = 'sub-orig';
          o.textContent = l.text;
          p.append(o);
        }
        if (showTr) {
          const t = doc.createElement('span');
          t.className = 'sub-tr';
          t.textContent = l.translated;
          p.append(t);
        }
        overlay.append(p);
      }
      overlay.dataset.visible = lines.length ? 'true' : 'false';
    }

    const setToggle = (on) => {
      toggle.setAttribute('aria-pressed', String(on));
      toggle.textContent = on ? 'CC on' : 'CC off';
    };
    toggle.addEventListener('click', () => { api.setEnabled(!api.enabled); setToggle(api.enabled); });
    api.onEnabledChange(setToggle);
    radios.forEach((r) => r.addEventListener('change', () => { if (r.checked) api.setSpeaking(r.value); }));
    $('subs-mode').addEventListener('change', (e) => { mode = e.target.value; render(lastLines); });

    return {
      render,
      status: (text) => { note.textContent = text; },
      // Names the two speaking options after the real languages, e.g. "Turkish".
      labels(fluentName, learningName) {
        $('speak-fluent-text').textContent = fluentName;
        $('speak-learning-text').textContent = learningName;
        radios.forEach((r) => { r.checked = r.value === 'fluent'; });
        setToggle(api.enabled);
        // Without recognition there is nothing to switch; captions from the partner still show.
        if (!api.supported) {
          radios.forEach((r) => { r.disabled = true; });
          note.textContent = NEEDS_CHROME;
        }
      },
    };
  }

  // ---- public namespace ----
  const ns = { createSubtitles, browserRecognizer, dailyTransport, toBcp47, TYPE };

  // Wired-up singleton used by the page:
  //   configure({ fluent, learning, fluentName, learningName })  when matched (my languages)
  //   attach(callObject)                                          once joined
  //   stop()                                                      from leaveCall
  if (typeof root.document !== 'undefined') {
    let call = null;
    let dom = null;
    const controller = createSubtitles({
      recognizer: browserRecognizer(root),
      transport: dailyTransport(() => call),
      translate: (text, from, to) => root.Bilingle.translate.translate(text, from, to),
      onLines: (lines) => dom && dom.render(lines),
      onStatus: (text) => dom && dom.status(text),
    });
    dom = bindDom(root.document, controller);
    ns.configure = (cfg) => {
      controller.configure(cfg);
      if (dom) dom.labels(cfg.fluentName || cfg.fluent, cfg.learningName || cfg.learning);
    };
    ns.attach = (callObject) => { call = callObject; controller.start(); };
    ns.stop = () => { call = null; controller.stop(); if (dom) dom.status(''); };
  }

  root.Bilingle = root.Bilingle || {};
  root.Bilingle.subtitles = ns;
  if (typeof module !== 'undefined' && module.exports) module.exports = ns;
})(typeof window !== 'undefined' ? window : globalThis);
