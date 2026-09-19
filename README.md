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
npm test                      # 17 checks, no API key needed
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
| `join-queue` | `{ name, fluentLang, learningLang }` | Do **not** send `socketId`; the server takes it from the connection |
| `send-message` | `{ text }` | Silently dropped if not currently matched |
| `skip` | *none* | Leave the current match |

Disconnects are handled automatically - nothing to emit.

### Events the server sends

| Event | Payload | Meaning |
|---|---|---|
| `matched` | `{ roomUrl, partner: { name, fluentLang, learningLang } }` | Paired. `roomUrl` is a plain Daily.co url string |
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
