# Bilingle

An Omegle-style language exchange app. It matches someone who speaks language A and is learning B with someone who speaks B and is learning A, so they can practise in a live conversation.

## Features

- Matching on fluent and learning language pairs, including several pairs at once
- Video calls with a text chat beside them
- A translate button on every chat message
- Live subtitles with translation during the call
- An in-call dictionary that explains words in your own language

## Stack

- Backend: Node.js, Express and Socket.io. Matchmaking runs in memory, with no database.
- Video: Daily.co (`@daily-co/daily-js`) in call object mode.
- Frontend: plain HTML and JS in `public/`, using the Socket.io client.

## Repo layout

```
server/      matchmaking, Daily.co room creation, translation and dictionary endpoints
public/      the frontend, served at http://localhost:3001
tests/       the test suites behind `npm test`
GLOSSARY.md  canonical domain terms (Language Pair, Queue, Match, Partner, Skip)
render.yaml  Render Blueprint for the bilingle.live deploy
```

`server/.env` holds `DAILY_API_KEY`. Git ignores it, so never commit it. The
key is in the Daily dashboard.

## Running the backend

```bash
npm install
echo "DAILY_API_KEY=<key>" > server/.env
npm start                     # http://localhost:3001
npm test                      # all suites, no API key needed
```

Open `http://localhost:3001` in two tabs with complementary languages
(`en`/`tr` and `tr`/`en`) to watch a match happen end to end.

## Socket API contract

This is the interface between the matchmaking server and the frontend.
`public/index.html` implements all of it. Change both sides together.

### Events the client sends

| Event | Payload | Notes |
|---|---|---|
| `join-queue` | `{ name, pairs: [{ fluentLang, learningLang }, ...] }` | Do **not** send `socketId`. The server takes it from the connection. |
| `send-message` | `{ text }` | The server drops it if you are not in a match. |
| `skip` | *none* | Leave the current match. |

`pairs` is a list because a user can queue for several Language Pairs at once.
Someone fluent in `en` and `es` who is learning `tr` sends both `en` to `tr`
and `es` to `tr`, and gets matched on whichever comes up first. A user with one
pair sends a list of one. The server ignores duplicate pairs.

The server handles disconnects itself. The client emits nothing.

### Events the server sends

| Event | Payload | Meaning |
|---|---|---|
| `matched` | `{ roomUrl, partner: { name, fluentLang, learningLang } }` | You are in a match. `roomUrl` is a plain Daily.co url string. The partner's languages are the pair you were **actually matched on**, not their whole list, so your own side of the match is always the reverse of theirs. |
| `chat-message` | `{ text }` | A message from your partner. It has no sender name, so label it with the `partner.name` you saved from `matched`. |
| `waiting` | *none* | You are in the queue and the server is looking for a match. |
| `waiting` | `{ reason: 'partner-left' }` | Your partner left. You are **not** in the queue. Show a "disconnected" screen and let the user rejoin. |

### Behavioral rules that aren't visible in the payloads

- **Skip is asymmetric.** The server puts whoever skips back in the queue, and
  they receive `waiting` or `matched` with no further action. The partner they
  left gets `waiting` with `reason: 'partner-left'` and stays idle until they
  emit `join-queue` again.
- **The server ignores `join-queue` while you are in a match.** Skip first.
- **Re-sending `join-queue` while waiting replaces your queued pairs.** It
  doesn't add to them. That's how a user changes their languages without
  skipping, and it's what stops a user from matching with themselves.
- **More pairs means faster matches.** Someone queued for four pairs is
  matched about four times as often as someone queued for one. That's fine at
  this size. Revisit it if fairness ever matters.
- **Language codes must match exactly, reversed.** `en`/`tr` only ever matches
  with `tr`/`en`. Use lowercase ISO 639-1 everywhere. `"EN"` never matches
  `"en"`, and nothing reports the mismatch, so it looks like a backend bug.
- **The server persists nothing.** The queue and matches live in memory, so a
  refresh is a new connection with no chat history.
- **The server silently drops oversized and rapid-fire events.** It ignores
  a `join-queue` with a name over 32 characters, more than 20 pairs, or a
  language code over 10 characters, and a `send-message` over 500
  characters. These match the `maxlength`s in `public/index.html`. It accepts
  at most 10 `join-queue` and `skip` events per socket in any 10 seconds,
  because each one can create a paid Daily room. It rejects any socket
  payload over 16 KB.

## User profiles (Firebase, not built yet)

None of this exists in code. Users type a name and pick languages on every
visit. This section is the agreed design for when profiles are built.

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

A "Dictionary" button in the match screen opens a panel with a search box.
Double-clicking a word in a chat message opens the panel with that word looked
up. No saved words, no history.

A word is always explained in **the reader's own language**, so each side of a
match queries a different Wiktionary edition: an English speaker gets
`en.wiktionary`, their Turkish partner gets `tr.wiktionary`. Looking up `dog`
gives the English reader an English entry and the Turkish reader the same word
under `İngilizce`, explained in Turkish. There is no language switch - the page
covers whichever of the two languages the word belongs to.

`GET /api/define?word=&fluent=` (`server/dictionary.js`, mounted at `/api`):

- `word` up to 100 characters; `fluent` is the reader's language and selects the
  edition. Codes are lowercase ISO 639-1 from `en es fr de it pt tr ja ko zh ar ru hi`.
- `200 { word, fluent, sections: [{ level, title, text }], source }` - `sections`
  is the page flattened in reading order, where level 2 is a language heading and
  deeper levels are its sections. Headings are kept verbatim, in the edition's own
  language, because that is the language the reader reads.
- `400 { error }` bad input, `404 { error: 'not found' }`, `502 { error }` edition unavailable.
- Client: `Bilingle.dictionary.lookup(word, fluent)` resolves to the body above and
  rejects with an Error carrying `status`. `Bilingle.dictionary.startSession({ learning, fluent, langName })`
  is called from the `matched` handler.
- Source is the MediaWiki action API (`action=query&prop=extracts&explaintext=1`),
  which every edition serves. The REST `/page/definition/` endpoint is English-only
  (501 elsewhere), which is why it isn't used. Plain text rather than parsed HTML,
  so nothing from the source is ever injected into the page.
- Results are cached in memory for an hour, keyed by edition and word. Misses are
  cached too; upstream failures are not. No API key and no env vars.

Known gap: smaller editions have far less coverage than `en.wiktionary`, so a
non-English reader will hit misses an English one never sees. Inflected forms
(`gidiyorum` vs `gitmek`) miss in every edition. An opt-in LLM lookup is the
planned answer to both.

Privacy: the looked-up word is sent to Wikimedia, to the reader's own edition.
Wiktionary text is CC BY-SA, and each result links back to its page. Server
requests use the User-Agent `Bilingle/1.0 (https://github.com/akhilmadipalli/Bilingle)`.

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

Bilingle runs on Render at **bilingle.live**, with Cloudflare handling DNS.
`render.yaml` is the Render Blueprint for the service.

One-time setup:

1. In Render, create a new Blueprint from this repo. Fill in
   `DAILY_API_KEY` and `MYMEMORY_EMAIL` when Render asks for them. Use a paid
   instance type. The free type sleeps after 15 minutes without traffic,
   which closes every open socket, and the next visitor waits about a minute
   for it to wake.
2. In the service's Settings, add the custom domains `bilingle.live` and
   `www.bilingle.live`.
3. In Cloudflare DNS, add proxied CNAME records for `@` and `www` that point
   to `<service>.onrender.com`.
4. Set Cloudflare's SSL/TLS mode to **Full**. With "Flexible", Cloudflare
   talks plain http to Render, Render redirects it to https, and the browser
   loops.
5. Check that `curl -sI https://bilingle.live` returns 200. Then match two
   devices in Chrome and confirm that video and subtitles work.

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
| `MYMEMORY_EMAIL` | a team email; raises the translation quota to 50000 chars/day (see Translation service) |
| `PORT` | set automatically by most hosts; defaults to 3001 |

`dotenv` reads `server/.env` if present and does nothing if it isn't, so the
host's own environment variables take over in production with no code change.
