# Bilingle

An Omegle-style language exchange app. Pairs a user who knows language A and wants to learn language B with a user who knows B and wants to learn A, for real-time practice conversation.

## Key features

- Smart language pairing based on fluent/learning language pairs
- Real-time text chat and video calls
- Live-translation subtitles during conversation
- Persistent user profiles (Firebase)

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
- **The server persists nothing.** Queue state and matches live in memory
  only, so a refresh is a brand new connection with no chat history. User
  profiles do persist, but client-side via Firebase - see below.

## User profiles (Firebase)

Profiles are **client-authoritative**: the browser signs the user in with
Firebase Auth, reads their profile from Firestore, and sends the same
`join-queue` payload documented above. **The matchmaking server is not
involved and does not change** - it never talks to Firebase and has no
Firebase credentials.

Suggested document shape, `users/{uid}`:

```js
{
  displayName: "Alex",
  fluentLangs: ["en", "es"],     // languages they can teach
  learningLangs: ["tr", "fr"],   // languages they want to practise
}
```

Two lists rather than stored pairs, because the pairs are chosen per session:
the user picks from dropdowns populated by these lists, and the client turns
that selection into the `pairs` array. Selecting two fluent and two learning
languages produces four pairs, which is exactly what the multi-pair queueing
support is for.

```js
socket.emit('join-queue', {
  name: profile.displayName,
  pairs: [
    { fluentLang: 'en', learningLang: 'tr' },
    { fluentLang: 'en', learningLang: 'fr' },
    { fluentLang: 'es', learningLang: 'tr' },
    { fluentLang: 'es', learningLang: 'fr' },
  ],
});
```

Two things to get right:

- **Write Firestore security rules before shipping.** The Firebase web config
  (`apiKey` and friends) is public by design and is not a secret - rules are
  what actually protect the data. With the console's default test rules,
  anyone can read and write every profile. At minimum, a user may only read
  and write their own `users/{uid}` document.
- **Language codes must match the socket contract exactly** - lowercase ISO
  639-1. A dropdown emitting `"EN"` silently never matches `"en"`.

Because the client asserts its own name and languages, a crafted socket event
could claim to be anyone. That's acceptable while the app is anonymous
stranger chat with no moderation; if blocking, reporting or reputation is ever
added, the server will need to verify a Firebase ID token instead.

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

## Translation service

`POST /api/translate` is the one shared translation endpoint (built by the chat-translate feature; live subtitles and anything else should call it instead of adding their own).

- Request: JSON `{ text, from, to }` with lowercase ISO 639-1 codes. `from` may be `"auto"`.
- `200 { translatedText, from, to }`, or `{ error }` with `400` (bad input, or text over 1000 characters), `429` (rate limited, 60 requests per minute per IP), `502` (the translation provider failed).
- Client helper: `Bilingle.translate.translate(text, from, to)` in `public/translate.js` returns a Promise of the translated string and rejects with an `Error` on failure.
- Results are cached in memory (500 entries). Nothing is stored on disk.
- Provider: [MyMemory](https://mymemory.translated.net), free and keyless. **Text sent for translation is sent to MyMemory** (`api.mymemory.translated.net`). The provider lives alone in `server/translateProvider.js` (one function, `translate(text, from, to)`), so swapping it is a one-file change.
- Optional env var in `server/.env`: `MYMEMORY_EMAIL` raises MyMemory's anonymous quota from 5000 to 50000 characters per day (the address is sent to MyMemory as the `de` parameter). The quota is per server IP, so set it before a demo.

## In-session dictionary

A "Dictionary" button in the match screen opens a panel with a search box and a
switch between the two languages of the match. Double-clicking a word in a chat
message opens the panel with that word looked up. Not-found and error states say
what to try. No saved words, no history.

`GET /api/define?word=&lang=&target=` (`server/dictionary.js`, mounted at `/api`):

- `word` up to 100 characters, `lang` is the language of the word, `target` is
  optional (the asker's fluent language, used for `translations`). Codes are
  lowercase ISO 639-1 from `en es fr de it pt tr ja ko zh ar ru hi`.
- `200 { word, lang, definitionLang, entries: [{ partOfSpeech, definitions: [string], examples: [string] }], translations?: [string], source }`
- `400 { error }` bad input, `404 { error: 'not found' }`, `502 { error }` source unavailable.
- Client: `Bilingle.dictionary.lookup(word, lang, target)` resolves to the body above and
  rejects with an Error carrying `status`. `Bilingle.dictionary.startSession({ learning, fluent, langName })`
  is called from the `matched` handler.
- Definitions come in English (English Wiktionary), whatever the languages. When the
  asker's fluent language is not English the panel says so and, if `Bilingle.translate`
  is loaded, offers "Translate definitions".
- Results are cached in memory for an hour. No API key and no env vars.

Privacy: the looked-up word is sent to Wikimedia (en.wiktionary.org) and, as a
fallback for some pages, to Kaikki.org. Wiktionary text is CC BY-SA, and each result
links back to its Wiktionary page. Server requests use the User-Agent
`Bilingle-hackathon/1.0 (https://github.com/akhilmadipalli/Bilingle)`.

## Click-to-translate in chat

Every chat message (the partner's and your own) has a small "Translate" button under the bubble.
Pressing it (Enter or Space works) shows the translation beneath the bubble in a hand-inked box, pressing again ("Hide translation") hides it.
Nothing is translated until you press it.

- Partner messages translate into your fluent language, your own messages into your partner's, both with `from: 'auto'` since either side may write in either language.
- The result is cached per message, so hiding and showing does not call the server again. If translating fails, the same button becomes "Retry".
- The UI lives in `Bilingle.translate.attachButton` (`public/translate.js`); `public/index.html` only calls it from `appendMessage`.
- Message text is sent only to `/api/translate`, and from there to MyMemory (see above).

## Live subtitles

During a video call each browser recognizes **its own** speech and sends the text to the partner, whose page shows it as subtitles at the bottom of the video (last two lines, fading after about 6 seconds of silence) with a translation into the viewer's fluent language beneath it.

- Client: `public/subtitles.js` (`Bilingle.subtitles`), styles in `public/subtitles.css`. `call.js` attaches it after joining (`Bilingle.subtitles.attach(callObject)`) and stops it in `leaveCall()`, so skip, partner-left and disconnect all stop recognition.
- Transport: Daily app messages (`sendAppMessage(msg, '*')` and the `app-message` event), which work in both the Prebuilt frame and call object mode. No server change and no new socket event. Daily limits: 4 KB per message, not replayed to late joiners, no rate limit documented, so interim results are throttled to about 2 per second.
- Message shape: `{ type: 'bilingle-subtitle', id, text, lang, final }` (`lang` is the ISO 639-1 code the speaker chose, `id` groups interim results with their final line).
- Speech recognition: the browser's Web Speech API (`SpeechRecognition`), Chrome and Edge only, HTTPS or localhost, needs the microphone permission. Other browsers get "Live subtitles need Chrome or Edge" and everything else keeps working (they can still read the partner's subtitles).
- Controls sit below the video: **CC on/off** (one switch: your speech is recognized and sent, and the partner's subtitles show), **I am speaking: fluent | learning** (recognition needs a language up front, default is your fluent one), and a **Both / Original / Translated** display choice.
- Translation reuses `Bilingle.translate.translate` (see Translation service). If it fails the original line still shows.
- Env vars: none.
- Privacy: **your speech is sent to your browser vendor's speech service** (Google in Chrome, Microsoft in Edge). Translated text is sent to MyMemory through `/api/translate`, as described above.
- Tests: `tests/subtitles-test.js` (part of `npm test`) uses a fake recognizer, transport and clock. It cannot cover real speech or a live Daily call.

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
