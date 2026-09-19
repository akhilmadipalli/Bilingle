# Bilingle

An Omegle-style language exchange app. Pairs a user who knows language A and wants to learn language B with a user who knows B and wants to learn A, for real-time practice conversation.

## Key features

- Smart language pairing based on fluent/learning language pairs
- Real-time text chat and video calls
- Live-translation subtitles during conversation
- Progress tracking and quizzes
- Post-session feedback and rating

## Stack

- Backend: Node.js, Express, Socket.io (in-memory matchmaking pool, no database)
- Video: Daily.co (`@daily-co/daily-js`)
- Frontend: React or plain HTML/JS, Socket.io client

## Repo layout

```
client/    frontend (Micah)
server/    backend - matchmaking (Akhil) + Daily.co room creation (Selim)
public/    minimal reference client, served at http://localhost:3001
tests/     smoke test for the matchmaking server
```

`server/.env` holds `DAILY_API_KEY` and is untracked - never commit it. Ask
Selim for the current key.

## Running the backend

```bash
npm install
echo "DAILY_API_KEY=<key>" > server/.env
npm start                     # http://localhost:3001
npm test                      # 24 checks, no API key needed
```

Open `http://localhost:3001` in two tabs with complementary languages
(`en`/`tr` and `tr`/`en`) to watch a match happen end to end.

## Socket API contract

This is the agreed interface between the matchmaking server and the
frontend. Don't change it without telling the team. `public/index.html` is a
working reference implementation of everything below.

### Events the client sends

| Event | Payload | Notes |
|---|---|---|
| `join-queue` | `{ name, pairs: [{ fluentLang, learningLang }, ...] }` | Do **not** send `socketId`; the server takes it from the connection |
| `send-message` | `{ text }` | Silently dropped if not currently matched |
| `skip` | *none* | Leave the current match |

`pairs` is a list because a user can queue for several language combinations
at once - someone fluent in `en`+`es` learning `tr` sends both `en`->`tr` and
`es`->`tr` and gets matched on whichever comes up first. A user with one
combination just sends a list of one. Duplicate pairs are ignored.

Disconnects are handled automatically - nothing to emit.

### Events the server sends

| Event | Payload | Meaning |
|---|---|---|
| `matched` | `{ roomUrl, partner: { name, fluentLang, learningLang } }` | Paired. `roomUrl` is a plain Daily.co url string. The partner's languages are the pair you were **actually matched on**, not their whole list - so your own side of the match is always the reverse of them |
| `chat-message` | `{ text }` | From your partner. No sender name - label it with the `partner.name` you saved from `matched` |
| `waiting` | *none* | You are in the queue, actively searching |
| `waiting` | `{ reason: 'partner-left' }` | Your partner left. You are **not** in the queue - show a static "disconnected" screen and rejoin manually |

### Behavioral rules that aren't visible in the payloads

- **Skip is asymmetric.** Whoever clicks skip is put back in the queue
  automatically and will receive `waiting` or `matched` with no further
  action. The person left behind gets `waiting` with
  `reason: 'partner-left'` and stays idle until they emit `join-queue`
  again.
- **`join-queue` while already matched is ignored.** Skip first.
- **Re-sending `join-queue` while waiting replaces your queued pairs**, it
  doesn't add to them. That's how a user changes their language selection
  without skipping, and it's what stops you being matched with yourself.
- **More pairs means faster matches.** Someone queued for four combinations
  is matched roughly four times as often as someone queued for one. Fine at
  your size; worth revisiting if fairness ever matters.
- **Language codes must match exactly, reversed.** `en`/`tr` only ever pairs
  with `tr`/`en`. Agree on one code set (lowercase ISO 639-1) - `"EN"` vs
  `"en"` will silently never match and will look like a backend bug.
- **Nothing is persisted.** A refresh is a brand new identity with no chat
  history.

## Backend integration notes

- Selim's `server/rooms.js` `createRoom()` resolves to `{ roomUrl }`, not a
  bare string. `server/server.js` unwraps it before emitting `matched`.
- `server/rooms.js` reads `DAILY_API_KEY` at module-load time, so
  `dotenv` must be configured *before* it is required. See the top of
  `server/server.js`.
- If room creation fails, both users are returned to the queue rather than
  being silently dropped.
- The smoke test replaces `server/rooms.js` through Node's require cache, so
  it never calls the live Daily API and needs no key.

## Testing across two laptops

`localhost` means "this machine", and the waiting pool lives in memory in a
single process - so if two people each run `npm start`, they sit in two
separate pools and will never match. One person runs the server, everyone
connects to that machine:

```bash
ipconfig getifaddr en0     # the host machine's LAN ip, e.g. 172.29.23.42
```

Everyone else opens `http://<that-ip>:3001`. Only the host machine needs
`server/.env`. Allow the incoming connection if macOS prompts about `node`.

Note that camera/mic access is blocked on a plain `http://` LAN address -
browsers only allow it on `https://` or `localhost` - so video needs a real
deployment, though text chat works fine this way.

## Deployment

Live at **bilingle.live**.

Requirements, none of which are optional:

- **Node 18+** (pinned in `engines`). Selim's `rooms.js` calls global
  `fetch`, which doesn't exist on older versions.
- **A host that supports long-lived WebSocket connections** - Render,
  Railway, Fly.io or a VPS. Serverless platforms (Vercel/Netlify functions)
  cannot hold a Socket.io connection open.
- **Exactly one instance.** The waiting pool is an in-memory `Map`, so two
  instances behind a load balancer means two separate pools and users who
  silently never match. Moving the pool to Redis is a prerequisite for
  scaling past one.
- **HTTPS.** Browsers only grant camera/mic access on a secure context, so
  video will not work over plain http.

Environment variables on the host:

| Variable | Value |
|---|---|
| `DAILY_API_KEY` | from the Daily dashboard - set it in the host's env, not a committed file |
| `ALLOWED_ORIGINS` | `https://bilingle.live,https://www.bilingle.live` |
| `PORT` | set automatically by most hosts; defaults to 3001 |

`dotenv` reads `server/.env` if present and does nothing if it isn't, so the
host's own environment variables take over in production with no code change.
