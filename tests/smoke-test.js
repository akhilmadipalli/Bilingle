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

async function run() {
  await new Promise((resolve) => server.listen(0, resolve));
  const url = `http://localhost:${server.address().port}`;

  // 1. Two complementary users match each other.
  const alice = await connect(url);
  const bob = await connect(url);

  const aliceMatched = nextEvent(alice, 'matched');
  const bobMatched = nextEvent(bob, 'matched');

  alice.emit('join-queue', { name: 'Alice', fluentLang: 'en', learningLang: 'tr' });
  bob.emit('join-queue', { name: 'Bob', fluentLang: 'tr', learningLang: 'en' });

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
  carol.emit('join-queue', { name: 'Carol', fluentLang: 'es', learningLang: 'fr' });
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

  // Alice was auto-requeued, so a fresh complementary user should match her
  // without Alice having to rejoin.
  const dave = await connect(url);
  const aliceRematched = nextEvent(alice, 'matched');
  dave.emit('join-queue', { name: 'Dave', fluentLang: 'tr', learningLang: 'en' });
  const aliceRematch = await aliceRematched;

  check('skipper is auto-requeued and rematches',
    aliceRematch !== 'timeout' && aliceRematch.partner.name === 'Dave');

  // Bob was NOT requeued, so he should still be idle - no match, no waiting.
  const bobStillIdle = nextEvent(bob, 'matched');
  check('skipped-on user is not auto-rematched', (await bobStillIdle) === 'timeout');

  // 5. If room creation fails, neither user is silently dropped.
  failNextRoom = true;

  const erin = await connect(url);
  const frank = await connect(url);

  const erinWaiting = nextEvent(erin, 'waiting');
  erin.emit('join-queue', { name: 'Erin', fluentLang: 'de', learningLang: 'ja' });
  await erinWaiting;

  const erinRequeued = nextEvent(erin, 'waiting', 2000);
  const frankWaiting = nextEvent(frank, 'waiting', 2000);
  frank.emit('join-queue', { name: 'Frank', fluentLang: 'ja', learningLang: 'de' });

  check('user already in pool is put back after a failed room creation',
    (await erinRequeued) !== 'timeout');
  check('joining user is queued after a failed room creation',
    (await frankWaiting) !== 'timeout');

  // Both are back in the pool, so once room creation works again the next
  // complementary joiner should match one of them.
  failNextRoom = false;
  const grace = await connect(url);
  const graceMatched = nextEvent(grace, 'matched', 2000);
  grace.emit('join-queue', { name: 'Grace', fluentLang: 'ja', learningLang: 'de' });

  check('matching recovers after a failure', (await graceMatched) !== 'timeout');

  // 6. Disconnecting while matched notifies the partner.
  const daveAfterDisconnect = nextEvent(dave, 'waiting', 2000);
  alice.close();
  const davePayload = await daveAfterDisconnect;

  check('partner is notified on disconnect',
    davePayload !== 'timeout' && davePayload.reason === 'partner-left');

  [bob, carol, dave, erin, frank, grace].forEach((socket) => socket.close());
  server.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
