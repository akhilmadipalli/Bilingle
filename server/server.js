const path = require('path');

// Load server/.env BEFORE requiring Selim's rooms.js below. That file reads
// DAILY_API_KEY into a const at module-load time, so if we loaded the env
// any later it would capture undefined and every room creation would 401.
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

// Selim's Daily.co room creation. Note it resolves to an OBJECT ({ roomUrl }),
// not a bare url string - see matchUsers below where we unwrap it.
const { createRoom } = require('./rooms');

// The waiting pool: users who've joined but haven't been matched yet.
const { addToQueue, findAndRemoveMatch, removeFromQueue } = require('./matchmaking');

// Active match tracking: who's currently paired with who, and their room.
const { createMatch, getMatch, endMatch } = require('./activeMatches');

const PORT = process.env.PORT || 3001;

const app = express();
// Serve the manual test client (public/index.html) so opening
// http://localhost:3001 in a browser gives us something to click around in.
app.use(express.static(path.join(__dirname, '..', 'public')));

// Socket.io needs a raw http server to attach to (it can't attach directly
// to the Express app), so we wrap the app in one.
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

// key = socketId -> value = full profile ({ socketId, name, fluentLang, learningLang }).
const users = new Map();

// Basic shape-check. Not complete
function isValidProfile(profile) {
  return (
    profile &&
    typeof profile.name === 'string' &&
    typeof profile.fluentLang === 'string' &&
    typeof profile.learningLang === 'string' &&
    profile.name.trim() &&
    profile.fluentLang.trim() &&
    profile.learningLang.trim()
  );
}

// Leave out socket id
function partnerPayload(user) {
  return { name: user.name, fluentLang: user.fluentLang, learningLang: user.learningLang };
}

// Called once we've found two complementary users. Gets a room from
// Selim's function, records the match, and tells both sides.
async function matchUsers(userA, userB) {
  // Selim's createRoom resolves to { roomUrl }, so unwrap it here - the rest
  // of our code (and the `matched` payload Micah consumes) wants a string.
  const { roomUrl } = await createRoom();
  createMatch(userA.socketId, userB.socketId, roomUrl);

  io.to(userA.socketId).emit('matched', { roomUrl, partner: partnerPayload(userB) });
  io.to(userB.socketId).emit('matched', { roomUrl, partner: partnerPayload(userA) });
}

// Shared by `join-queue` and `skip`: try to find a waiting complementary
// partner right now; if there isn't one, drop this user in the pool and
// tell them to wait.
async function enterQueue(socket, user) {
  const partner = findAndRemoveMatch(user);
  if (partner) {
    try {
      await matchUsers(user, partner);
      return;
    } catch (err) {
      // Daily.co room creation failed (bad/expired key, network, rate limit).
      // findAndRemoveMatch has ALREADY pulled the partner out of the pool, so
      // without this they'd be silently dropped and left waiting forever.
      // Put them back and fall through to re-queue this user too.
      console.error('Room creation failed, returning both users to the queue:', err);
      addToQueue(partner);
      io.to(partner.socketId).emit('waiting');
    }
  }

  addToQueue(user);
  socket.emit('waiting');
}

io.on('connection', (socket) => {
  // A new browser tab has connected. `socket.id` is unique to this
  // connection and is what we use as the key everywhere (pool, active
  // matches, users map) to identify "this particular tab".

  socket.on('join-queue', async (profile) => {
    if (!isValidProfile(profile)) return;

    const user = {
      socketId: socket.id,
      name: profile.name,
      fluentLang: profile.fluentLang,
      learningLang: profile.learningLang,
    };
    users.set(socket.id, user);

    await enterQueue(socket, user);
  });

  socket.on('send-message', ({ text } = {}) => {
    if (typeof text !== 'string' || !text.trim()) return;

    const match = getMatch(socket.id);
    if (!match) return; // not currently matched with anyone

    // Relay only to the matched partner
    io.to(match.partnerSocketId).emit('chat-message', { text });
  });

  socket.on('skip', async () => {
    // endMatch removes both sides of the match and hands back the
    // partner's socketId (or null if this socket wasn't actually matched).
    const partnerSocketId = endMatch(socket.id);
    if (partnerSocketId) {
      // Tell the partner their stranger left. `reason: 'partner-left'`
      // lets the frontend show a static "Partner has disconnected"
      io.to(partnerSocketId).emit('waiting', { reason: 'partner-left' });
    }

    // The person who skipped DOES get auto-requeued
    const user = users.get(socket.id);
    if (user) {
      await enterQueue(socket, user);
    }
  });

  socket.on('disconnect', () => {
    // The socket could have been either waiting in the pool or actively matched
    // We don't track which, so just attempt both cleanups
    removeFromQueue(socket.id);

    const partnerSocketId = endMatch(socket.id);
    if (partnerSocketId) {
      io.to(partnerSocketId).emit('waiting', { reason: 'partner-left' });
    }

    users.delete(socket.id);
  });
});

// Export the raw pieces (not just "start the server") so tests can require
// this file, bind it to an ephemeral port, and tear it down cleanly
// without needing a second copy of all this wiring.
module.exports = { app, server, io };

// Only auto-start listening when this file is run directly (`node
// src/server.js`), not when it's `require`'d by a test.
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Bilingle matchmaking server listening on http://localhost:${PORT}`);
  });
}
