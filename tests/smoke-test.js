// End-to-end checks for the matchmaking server, run with `npm test`.
//
// These talk to a real server over real socket connections - the only thing
// faked is Selim's Daily.co module. We swap it out via Node's require cache
// BEFORE requiring the server, so that:
//   - tests never hit the live Daily API (no key needed, no real rooms made)
//   - room creation is deterministic, and we can force it to fail on demand
// server.js destructures `createRoom` at module-load time, which is exactly
// why this has to happen before the require on the next few lines.
const Module = require('module');
const path = require('path');

let failNextRoom = false;
let roomCounter = 0;

const fakeRooms = {
  // Same shape as Selim's real one: resolves to { roomUrl }, not a string.
  createRoom: async () => {
    if (failNextRoom) throw new Error('simulated Daily.co failure');
    roomCounter += 1;
    return { roomUrl: `https://fake.daily.co/room-${roomCounter}` };
  },
};

const roomsPath = require.resolve(path.join(__dirname, '..', 'server', 'rooms.js'));
const stubModule = new Module(roomsPath);
stubModule.filename = roomsPath;
stubModule.loaded = true;
stubModule.exports = fakeRooms;
require.cache[roomsPath] = stubModule;

const { server } = require('../server/server');
const { io: ioClient } = require('socket.io-client');

let passed = 0;
let failed = 0;

function check(name, condition) {
  if (condition) {
    console.log(`PASS: ${name}`);
    passed++;
  } else {
    console.log(`FAIL: ${name}`);
    failed++;
  }
}

function connect(url) {
  return new Promise((resolve) => {
    const socket = ioClient(url);
    socket.on('connect', () => resolve(socket));
  });
}

// Resolves with the event payload, or with the string 'timeout' if the event
// never arrives - lets us assert both "this should happen" and "this should
// NOT happen" without hanging the suite.
function nextEvent(socket, eventName, timeoutMs = 500) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), timeoutMs);
    socket.once(eventName, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

// Shorthand for the common single-pair case.
function profile(name, fluentLang, learningLang) {
  return { name, pairs: [{ fluentLang, learningLang }] };
}

async function run() {
  await new Promise((resolve) => server.listen(0, resolve));
  const url = `http://localhost:${server.address().port}`;

  // 1. Two complementary users match each other.
  const alice = await connect(url);
  const bob = await connect(url);

  const aliceMatched = nextEvent(alice, 'matched');
  const bobMatched = nextEvent(bob, 'matched');

  alice.emit('join-queue', profile('Alice', 'en', 'tr'));
  bob.emit('join-queue', profile('Bob', 'tr', 'en'));

  const aliceMatch = await aliceMatched;
  const bobMatch = await bobMatched;

  check('complementary pair matches', aliceMatch !== 'timeout' && bobMatch !== 'timeout');
  check('each side sees the other as partner',
    aliceMatch.partner.name === 'Bob' && bobMatch.partner.name === 'Alice');
  check('partner payload carries languages',
    aliceMatch.partner.fluentLang === 'tr' && aliceMatch.partner.learningLang === 'en');
  check('both sides get the same room url', aliceMatch.roomUrl === bobMatch.roomUrl);
  check('roomUrl is a string, not an object', typeof aliceMatch.roomUrl === 'string');

  // 2. A user with no complementary counterpart just waits.
  const carol = await connect(url);
  const carolWaiting = nextEvent(carol, 'waiting');
  carol.emit('join-queue', profile('Carol', 'es', 'fr'));
  const carolWait = await carolWaiting;

  check('unmatched user is told to wait', carolWait !== 'timeout');
  check('plain waiting carries no reason', !carolWait || carolWait.reason === undefined);

  // 3. Chat reaches the partner and nobody else.
  const bobMessage = nextEvent(bob, 'chat-message');
  const carolMessage = nextEvent(carol, 'chat-message');
  alice.emit('send-message', { text: 'merhaba' });

  check('partner receives the chat message', (await bobMessage).text === 'merhaba');
  check('third party receives nothing', (await carolMessage) === 'timeout');

  // 4. Skip: the partner is told, and is NOT auto-requeued. The skipper IS.
  const bobAfterSkip = nextEvent(bob, 'waiting');
  alice.emit('skip');
  const bobSkipPayload = await bobAfterSkip;

  check('partner is notified when skipped', bobSkipPayload !== 'timeout');
  check('skip notification carries reason partner-left',
    bobSkipPayload && bobSkipPayload.reason === 'partner-left');

  const dave = await connect(url);
  const aliceRematched = nextEvent(alice, 'matched');
  dave.emit('join-queue', profile('Dave', 'tr', 'en'));
  const aliceRematch = await aliceRematched;

  check('skipper is auto-requeued and rematches',
    aliceRematch !== 'timeout' && aliceRematch.partner.name === 'Dave');

  const bobStillIdle = nextEvent(bob, 'matched');
  check('skipped-on user is not auto-rematched', (await bobStillIdle) === 'timeout');

  // 5. Multi-pair queueing: a user queued for several pairs can match on any
  //    of them, and the match reports the pair actually used - not the first
  //    pair in their list.
  const polly = await connect(url);
  const stefan = await connect(url);

  const pollyWaiting = nextEvent(polly, 'waiting');
  polly.emit('join-queue', {
    name: 'Polly',
    pairs: [
      { fluentLang: 'en', learningLang: 'tr' },
      { fluentLang: 'es', learningLang: 'tr' },
    ],
  });
  await pollyWaiting;

  const pollyMatched = nextEvent(polly, 'matched');
  const stefanMatched = nextEvent(stefan, 'matched');
  stefan.emit('join-queue', profile('Stefan', 'tr', 'es'));

  const pollyMatch = await pollyMatched;
  const stefanMatch = await stefanMatched;

  check('user queued for several pairs matches on a non-first pair',
    pollyMatch !== 'timeout' && pollyMatch.partner.name === 'Stefan');
  check('matched pair reported is the one actually used, not the first listed',
    stefanMatch !== 'timeout' &&
    stefanMatch.partner.fluentLang === 'es' &&
    stefanMatch.partner.learningLang === 'tr');

  // 6. Ghost entries: once matched, a multi-pair user must be gone from ALL
  //    their lists. Otherwise a third person matches a socket already in a
  //    call, silently hijacking an active conversation.
  const ghostA = await connect(url);
  const ghostB = await connect(url);
  const ghostC = await connect(url);

  const ghostAWaiting = nextEvent(ghostA, 'waiting');
  ghostA.emit('join-queue', {
    name: 'GhostA',
    // Three pairs on purpose: removing only ONE leftover (the old behavior)
    // would still leave the last one behind, so this test can actually fail.
    pairs: [
      { fluentLang: 'de', learningLang: 'ja' },
      { fluentLang: 'pl', learningLang: 'ko' },
      { fluentLang: 'sv', learningLang: 'da' },
    ],
  });
  await ghostAWaiting;

  const ghostAMatched = nextEvent(ghostA, 'matched');
  ghostB.emit('join-queue', profile('GhostB', 'ja', 'de'));
  check('multi-pair user matches on their first pair', (await ghostAMatched) !== 'timeout');

  // GhostA's sv-da entry (the LAST one) must be gone too. If it lingers,
  // GhostC matches a socket that is already in a call.
  const ghostCMatched = nextEvent(ghostC, 'matched');
  const ghostCWaiting = nextEvent(ghostC, 'waiting');
  ghostC.emit('join-queue', profile('GhostC', 'da', 'sv'));

  check('leftover entries are cleared when a multi-pair user matches',
    (await ghostCMatched) === 'timeout');
  check('user who only had a ghost to match against waits instead',
    (await ghostCWaiting) !== 'timeout');

  // 7. A user re-queueing must never be matched against their own stale entry.
  const solo = await connect(url);
  const soloWaiting = nextEvent(solo, 'waiting');
  solo.emit('join-queue', profile('Solo', 'fi', 'no'));
  await soloWaiting;

  const soloSelfMatched = nextEvent(solo, 'matched');
  const soloWaitingAgain = nextEvent(solo, 'waiting');
  solo.emit('join-queue', profile('Solo', 'no', 'fi'));

  check('user is never matched with themselves', (await soloSelfMatched) === 'timeout');
  check('re-queueing user is told to wait', (await soloWaitingAgain) !== 'timeout');

  // 8. If room creation fails, neither user is silently dropped.
  failNextRoom = true;

  const erin = await connect(url);
  const frank = await connect(url);

  const erinWaiting = nextEvent(erin, 'waiting');
  erin.emit('join-queue', profile('Erin', 'hu', 'el'));
  await erinWaiting;

  const erinRequeued = nextEvent(erin, 'waiting', 2000);
  const frankWaiting = nextEvent(frank, 'waiting', 2000);
  frank.emit('join-queue', profile('Frank', 'el', 'hu'));

  check('user already in pool is put back after a failed room creation',
    (await erinRequeued) !== 'timeout');
  check('joining user is queued after a failed room creation',
    (await frankWaiting) !== 'timeout');

  failNextRoom = false;
  const grace = await connect(url);
  const graceMatched = nextEvent(grace, 'matched', 2000);
  grace.emit('join-queue', profile('Grace', 'el', 'hu'));

  check('matching recovers after a failure', (await graceMatched) !== 'timeout');

  // 9. Disconnecting while matched notifies the partner.
  const daveAfterDisconnect = nextEvent(dave, 'waiting', 2000);
  alice.close();
  const davePayload = await daveAfterDisconnect;

  check('partner is notified on disconnect',
    davePayload !== 'timeout' && davePayload.reason === 'partner-left');

  [bob, carol, dave, polly, stefan, ghostA, ghostB, ghostC, solo, erin, frank, grace]
    .forEach((socket) => socket.close());
  server.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
