// Tests for public/subtitles.js with a fake recognizer, fake transport and fake timers.
// No browser, no microphone, no network. Real speech and live Daily are NOT covered here.
const { createSubtitles, dailyTransport, toBcp47 } = require('../public/subtitles.js');

let passed = 0;
let failed = 0;

function check(name, condition) {
  console.log(`${condition ? 'PASS' : 'FAIL'}: ${name}`);
  condition ? passed++ : failed++;
}

// Manual clock so fades, restarts and interim throttling are deterministic.
function fakeClock() {
  let time = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => time,
    setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: time + ms }); return id; },
    clearTimer: (id) => timers.delete(id),
    advance(ms) {
      const end = time + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        time = due[1].at;
        due[1].fn();
      }
      time = end;
    },
  };
}

function fakeRecognizer(supported = true) {
  const r = {
    supported, starts: [], stops: 0, handlers: null,
    start(lang, handlers) { r.starts.push(lang); r.handlers = handlers; },
    stop() { r.stops += 1; r.handlers = null; },
  };
  return r;
}

// Two fake transports wired back to back, like two browsers in one Daily call.
function fakeTransport() {
  const t = { sent: [], listeners: new Set(), send(m) { t.sent.push(m); }, listen(cb) { t.listeners.add(cb); return () => t.listeners.delete(cb); } };
  t.deliver = (m) => t.listeners.forEach((cb) => cb(m));
  return t;
}

function setup({ translate, supported = true } = {}) {
  const clock = fakeClock();
  const recognizer = fakeRecognizer(supported);
  const transport = fakeTransport();
  const seen = { lines: [], status: [], translateCalls: [] };
  const subs = createSubtitles({
    recognizer, transport,
    translate: translate || (async (text, from, to) => { seen.translateCalls.push([text, from, to]); return `[${to}] ${text}`; }),
    onLines: (l) => seen.lines.push(l),
    onStatus: (s) => seen.status.push(s),
    ...clock,
  });
  subs.configure({ fluent: 'tr', learning: 'en' });
  return { clock, recognizer, transport, seen, subs, lastLines: () => seen.lines[seen.lines.length - 1] };
}

const tick = () => new Promise((r) => setImmediate(r));

async function run() {
  // -- sending: final result goes out with id and spoken language, then the id advances
  {
    const { subs, recognizer, transport } = setup();
    subs.start();
    check('recognition starts in the fluent language by default', recognizer.starts[0] === 'tr-TR');
    recognizer.handlers.onResult({ text: ' merhaba ', isFinal: true });
    recognizer.handlers.onResult({ text: 'nasilsin', isFinal: true });
    check('final result is sent trimmed with lang and final flag',
      JSON.stringify(transport.sent[0]) === JSON.stringify({ type: 'bilingle-subtitle', id: 0, text: 'merhaba', lang: 'tr', final: true }));
    check('next sentence gets a new id', transport.sent[1].id === 1);
    recognizer.handlers.onResult({ text: '   ', isFinal: true });
    check('blank result is not sent', transport.sent.length === 2);
  }

  // -- interim: throttled, and the final for the same id follows
  {
    const { subs, recognizer, transport, clock } = setup();
    subs.start();
    recognizer.handlers.onResult({ text: 'mer', isFinal: false });
    recognizer.handlers.onResult({ text: 'merh', isFinal: false });
    check('interim results are throttled', transport.sent.length === 1 && transport.sent[0].final === false);
    clock.advance(500);
    recognizer.handlers.onResult({ text: 'merhaba', isFinal: false });
    recognizer.handlers.onResult({ text: 'merhaba', isFinal: true });
    check('later interim goes out, final always goes out',
      transport.sent.length === 3 && transport.sent[1].id === transport.sent[2].id && transport.sent[2].final === true);
  }

  // -- auto-restart after silence, and no restart once stopped
  {
    const { subs, recognizer, clock } = setup();
    subs.start();
    recognizer.handlers.onError('no-speech');
    recognizer.handlers.onEnd();
    check('does not restart instantly', recognizer.starts.length === 1);
    clock.advance(400);
    check('restarts after the recognizer ends', recognizer.starts.length === 2);
    subs.stop();
    check('stop() stops the recognizer', recognizer.stops === 1);
    clock.advance(2000);
    check('no restart after stop', recognizer.starts.length === 2);
  }

  // -- stop while a restart is pending (skip / partner-left right after a silence end)
  {
    const { subs, recognizer, clock } = setup();
    subs.start();
    recognizer.handlers.onEnd();
    subs.stop();
    clock.advance(2000);
    check('pending restart is cancelled by stop()', recognizer.starts.length === 1);
  }

  // -- permission denied: stop for good, no prompt loop
  {
    const { subs, recognizer, clock, seen } = setup();
    let toggled = null;
    subs.onEnabledChange((on) => { toggled = on; });
    subs.start();
    recognizer.handlers.onError('not-allowed');
    check('permission error turns CC off and tells the user',
      subs.enabled === false && toggled === false && /blocked/.test(seen.status[seen.status.length - 1]));
    clock.advance(5000);
    check('no restart loop after permission error', recognizer.starts.length === 1);
  }

  // -- repeated network failures give up instead of looping forever
  {
    const { subs, recognizer, clock } = setup();
    subs.start();
    for (let i = 0; i < 8 && recognizer.handlers; i++) {
      recognizer.handlers.onError('network');
      recognizer.handlers.onEnd();
      clock.advance(400);
    }
    check('gives up after repeated failures', subs.enabled === false && recognizer.starts.length <= 6);
  }

  // -- switching the spoken language restarts recognition in that language
  {
    const { subs, recognizer } = setup();
    subs.start();
    subs.setSpeaking('learning');
    check('speaking switch restarts recognition in the learning language',
      recognizer.starts.length === 2 && recognizer.starts[1] === 'en-US' && recognizer.stops === 1);
    recognizer.handlers.onResult({ text: 'hello', isFinal: true });
  }

  // -- CC off stops recognition and hides subtitles; CC on resumes
  {
    const { subs, recognizer, transport, lastLines } = setup();
    subs.start();
    subs.setEnabled(false);
    check('CC off stops recognition', recognizer.stops === 1);
    transport.deliver({ type: 'bilingle-subtitle', id: 0, text: 'hello', lang: 'en', final: true });
    check('incoming subtitles are ignored while CC is off', !lastLines() || lastLines().length === 0);
    subs.setEnabled(true);
    check('CC on resumes recognition', recognizer.starts.length === 2);
  }

  // -- receiving: interim replaces in place, final is translated into the viewer's fluent language
  {
    const { subs, transport, seen, lastLines } = setup();
    subs.start();
    transport.deliver({ type: 'bilingle-subtitle', id: 0, text: 'how are', lang: 'en', final: false });
    transport.deliver({ type: 'bilingle-subtitle', id: 0, text: 'how are you', lang: 'en', final: true });
    check('interim and final share one line', lastLines().length === 1 && lastLines()[0].text === 'how are you' && !lastLines()[0].interim);
    await tick();
    check('final line is translated to the viewer fluent language', seen.translateCalls.length === 1 && seen.translateCalls[0].join('|') === 'how are you|en|tr');
    check('translation appears under the original', lastLines()[0].translated === '[tr] how are you');
  }

  // -- interim lines are not translated
  {
    const { subs, transport, seen } = setup();
    subs.start();
    transport.deliver({ type: 'bilingle-subtitle', id: 0, text: 'how', lang: 'en', final: false });
    await tick();
    check('interim lines are not sent for translation', seen.translateCalls.length === 0);
  }

  // -- partner speaking the viewer's own fluent language needs no translation
  {
    const { subs, transport, seen, lastLines } = setup();
    subs.start();
    transport.deliver({ type: 'bilingle-subtitle', id: 0, text: 'merhaba', lang: 'tr', final: true });
    await tick();
    check('same-language line is shown without translating', seen.translateCalls.length === 0 && lastLines()[0].translated === undefined);
  }

  // -- translation failure: the original still shows
  {
    const { subs, transport, lastLines } = setup({ translate: async () => { throw new Error('down'); } });
    subs.start();
    transport.deliver({ type: 'bilingle-subtitle', id: 0, text: 'good morning', lang: 'en', final: true });
    await tick();
    check('original still shows when translation fails', lastLines().length === 1 && lastLines()[0].text === 'good morning' && lastLines()[0].translated === undefined);
  }
  {
    const { subs, transport, lastLines } = setup({ translate: () => { throw new Error('sync boom'); } });
    subs.start();
    transport.deliver({ type: 'bilingle-subtitle', id: 0, text: 'good night', lang: 'en', final: true });
    await tick();
    check('a translator that throws synchronously does not break subtitles', lastLines()[0].text === 'good night');
  }

  // -- last two lines only, fade after 6 seconds
  {
    const { subs, transport, clock, lastLines } = setup();
    subs.start();
    for (let i = 0; i < 3; i++) transport.deliver({ type: 'bilingle-subtitle', id: i, text: `line ${i}`, lang: 'tr', final: true });
    check('only the last two lines are kept', lastLines().length === 2 && lastLines()[0].text === 'line 1' && lastLines()[1].text === 'line 2');
    clock.advance(5900);
    check('lines are still there just before 6s', lastLines().length === 2);
    clock.advance(200);
    check('lines fade away after 6s of silence', lastLines().length === 0);
  }

  // -- a translation that lands after the line scrolled off is dropped
  {
    let resolve;
    const { subs, transport, lastLines } = setup({ translate: () => new Promise((r) => { resolve = r; }) });
    subs.start();
    transport.deliver({ type: 'bilingle-subtitle', id: 0, text: 'old', lang: 'en', final: true });
    transport.deliver({ type: 'bilingle-subtitle', id: 1, text: 'b', lang: 'tr', final: true });
    transport.deliver({ type: 'bilingle-subtitle', id: 2, text: 'c', lang: 'tr', final: true });
    await tick();
    resolve('eski');
    await tick();
    check('late translation for a scrolled-off line is ignored', lastLines().every((l) => l.translated === undefined));
  }

  // -- malformed messages are ignored
  {
    const { subs, transport, lastLines } = setup();
    subs.start();
    for (const bad of [null, {}, { type: 'other', text: 'x', lang: 'en' }, { type: 'bilingle-subtitle', text: 5, lang: 'en' },
      { type: 'bilingle-subtitle', id: 0, text: 'x', lang: 'EN-us' }, { type: 'bilingle-subtitle', id: 0, text: '  ', lang: 'en' }]) {
      transport.deliver(bad);
    }
    check('malformed app messages are ignored', lastLines().length === 0);
  }

  // -- stop on skip / partner-left / leaveCall: recognizer, listener and lines all go
  {
    const { subs, recognizer, transport, lastLines } = setup();
    subs.start();
    transport.deliver({ type: 'bilingle-subtitle', id: 0, text: 'hi', lang: 'tr', final: true });
    subs.stop();
    check('stop() clears subtitles', lastLines().length === 0);
    check('stop() detaches the transport listener', transport.listeners.size === 0);
    check('stop() stops recognition', recognizer.stops === 1);
    subs.stop();
    check('stop() twice is harmless', recognizer.stops === 1);
  }

  // -- unsupported browser: clear note, still shows the partner's subtitles, no crash
  {
    const { subs, recognizer, transport, seen, lastLines } = setup({ supported: false });
    subs.start();
    check('unsupported browser gets a Chrome/Edge note', /Chrome or Edge/.test(seen.status[seen.status.length - 1]));
    check('unsupported browser never starts recognition', recognizer.starts.length === 0);
    subs.setEnabled(false);
    subs.setEnabled(true);
    check('toggling CC in an unsupported browser does not start recognition', recognizer.starts.length === 0);
    transport.deliver({ type: 'bilingle-subtitle', id: 0, text: 'merhaba', lang: 'tr', final: true });
    check('partner subtitles still show without recognition', lastLines().length === 1);
  }

  // -- restart cleanly when the call is re-attached (next match)
  {
    const { subs, recognizer, transport } = setup();
    subs.start();
    subs.start();
    check('start() twice keeps one listener and one recognizer', transport.listeners.size === 1 && recognizer.starts.length === 2 && recognizer.stops === 1);
  }

  // -- send errors (call not joined yet) are swallowed
  {
    const { subs, recognizer, transport } = setup();
    transport.send = () => { throw new Error('not joined'); };
    subs.start();
    let threw = false;
    try { recognizer.handlers.onResult({ text: 'hi', isFinal: true }); } catch { threw = true; }
    check('a failing transport send does not throw', !threw);
  }

  // -- Daily transport adapter: broadcast send, listen/unlisten via app-message
  {
    const calls = { sent: [], on: [], off: [] };
    const call = {
      sendAppMessage: (m, to) => calls.sent.push([m, to]),
      on: (ev, fn) => calls.on.push([ev, fn]),
      off: (ev, fn) => calls.off.push([ev, fn]),
    };
    const t = dailyTransport(() => call);
    t.send({ a: 1 });
    let got = null;
    const un = t.listen((d) => { got = d; });
    calls.on[0][1]({ data: { hello: 1 }, fromId: 'x' });
    un();
    check('dailyTransport broadcasts with sendAppMessage(msg, "*")', calls.sent[0][1] === '*' && calls.sent[0][0].a === 1);
    check('dailyTransport listens to app-message and unwraps data', calls.on[0][0] === 'app-message' && got.hello === 1);
    check('dailyTransport unlisten removes the handler', calls.off[0][0] === 'app-message' && calls.off[0][1] === calls.on[0][1]);
    const none = dailyTransport(() => null);
    none.send({});
    none.listen(() => {})();
    check('dailyTransport tolerates no call object', true);
  }

  check('language codes map to BCP-47 tags', toBcp47('tr') === 'tr-TR' && toBcp47('xx') === 'xx');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run().catch((err) => { console.error(err); process.exit(1); });
