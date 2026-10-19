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
visit. This section is the design for when profiles are built.

Profiles will be **client-authoritative**. The browser signs the user in with
Firebase Auth, reads their profile from Firestore, and sends the same
`join-queue` payload documented above. **The matchmaking server does not
change.** It never talks to Firebase and has no Firebase credentials.

The document shape, `users/{uid}`:

```js
{
  displayName: "Alex",
  fluentLangs: ["en", "es"],     // languages they can teach
  learningLangs: ["tr", "fr"],   // languages they want to practise
}
```

The profile stores two lists, not pairs, because the user chooses pairs per
session. They pick from dropdowns filled from these lists, and the client
turns that choice into the `pairs` array. Two fluent and two learning
languages make four pairs, which multi-pair queueing already handles.

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
  (`apiKey` and the rest) is public by design and is not a secret. The rules
  protect the data. With the console's default test rules, anyone can read and
  write every profile. At minimum, a user may only read and write their own
  `users/{uid}` document.
- **Language codes must match the socket contract exactly**, in lowercase ISO
  639-1. A dropdown that emits `"EN"` never matches `"en"`.

Because the client asserts its own name and languages, a crafted socket event
can claim to be anyone. That's acceptable while the app is anonymous stranger
chat with no moderation. If blocking, reporting or reputation is ever added,
the server will need to verify a Firebase ID token instead.

## Backend integration notes

- `createRoom()` in `server/rooms.js` resolves to `{ roomUrl }`, not a bare
  string. `server/server.js` unwraps it before emitting `matched`.
- `server/rooms.js` reads `DAILY_API_KEY` when the module loads, so `dotenv`
  must run *before* anything requires it. See the top of `server/server.js`.
- If room creation fails, the server puts both users back in the queue.
- The smoke test replaces `server/rooms.js` through Node's require cache, so
  it never calls the live Daily API and needs no key.

## Translation service

`POST /api/translate` is the app's only translation endpoint. Live subtitles,
the chat translate button and any new feature call it instead of adding their
own.

- Request: JSON `{ text, from, to }` with lowercase ISO 639-1 codes. `from` may be `"auto"`.
- Responses:
  - `200 { translatedText, from, to }`;
  - `400 { error }` for bad input or text over 1000 characters;
  - `429 { error }` past 60 requests per minute per IP;
  - `502 { error }` when the translation provider fails.
- Client helper: `Bilingle.translate.translate(text, from, to)` in `public/translate.js` returns a Promise of the translated string, and rejects with an `Error` on failure.
- The server caches the last 500 results in memory and stores nothing on disk.
- Provider: [MyMemory](https://mymemory.translated.net), free and keyless. **The server sends all text for translation to MyMemory** (`api.mymemory.translated.net`). The provider is one function, `translate(text, from, to)`, alone in `server/translateProvider.js`, so swapping it is a one-file change.
- Optional env var: `MYMEMORY_EMAIL` raises MyMemory's anonymous quota from 5000 to 50000 characters per day. The server sends the address to MyMemory as the `de` parameter. The quota is per server IP, so set it before a demo.

## In-call dictionary

A "Dictionary" button in the match screen opens a panel with a search box.
Double-clicking a word in a chat message opens the panel and looks that word
up. It saves no words and keeps no history.

The dictionary always explains a word in **the reader's own language**, so
each side of a match queries a different Wiktionary edition. An English
speaker gets `en.wiktionary` and their Turkish partner gets `tr.wiktionary`.
Looking up `dog` gives the English reader an English entry, and gives the
Turkish reader the same word under `İngilizce`, explained in Turkish. There is
no language switch, because the page covers whichever of the two languages the
word belongs to.

`GET /api/define?word=&fluent=` (`server/dictionary.js`, mounted at `/api`):

- `word` is up to 100 characters. `fluent` is the reader's language and picks
  the edition. Codes are lowercase ISO 639-1 from `en es fr de it pt tr ja ko zh ar ru hi`.
- `200 { word, fluent, sections: [{ level, title, text }], source }`.
  `sections` is the page in reading order. Level 2 is a language heading, and
  deeper levels are its sections. Headings stay verbatim, in the edition's own
  language, because that is the language the reader reads.
- `400 { error }` for bad input, `404 { error: 'not found' }`, and
  `502 { error }` when the edition is unavailable.
- Client: `Bilingle.dictionary.lookup(word, fluent)` resolves to the body
  above and rejects with an Error that carries `status`. The `matched` handler
  calls `Bilingle.dictionary.startSession({ learning, fluent, langName })`.
- The source is the MediaWiki action API (`action=query&prop=extracts&explaintext=1`),
  which every edition serves. The REST `/page/definition/` endpoint exists only
  on the English edition and returns 501 elsewhere. The API returns plain text,
  not HTML, so the page never injects anything from the source.
- The server caches results in memory for an hour, keyed by edition and word.
  It caches misses too, but not upstream failures. It needs no API key and no
  env vars.

Known gap: smaller editions cover far fewer words than `en.wiktionary`, so a
non-English reader misses words an English reader finds. Every edition misses
inflected forms, such as `gidiyorum` for `gitmek`. The plan for both is an
opt-in LLM lookup.

Privacy: the server sends the looked-up word to Wikimedia, to the reader's own
edition. Wiktionary text is CC BY-SA, and each result links back to its page.
The server identifies itself with the User-Agent
`Bilingle/1.0 (https://github.com/akhilmadipalli/Bilingle)`.

## Click-to-translate in chat

Every chat message, yours and your partner's, has a small "Translate" button
under the bubble. Pressing it, or Enter or Space on it, shows the translation
in a hand-inked box beneath the bubble. Pressing it again ("Hide translation")
hides it. The app translates nothing until you press it.

- Your partner's messages translate into your fluent language, and yours into
  your partner's. Both use `from: 'auto'`, because either side may write in
  either language.
- The page caches the result per message, so hiding and showing it again makes
  no new request. If a translation fails, the same button becomes "Retry".
- The UI is `Bilingle.translate.attachButton` in `public/translate.js`.
  `public/index.html` calls it only from `appendMessage`.
- Message text goes only to `/api/translate`, and from there to MyMemory.

## Live subtitles

During a video call, each browser recognizes **its own** speech and sends the
text to the partner. The partner's page shows it as subtitles at the bottom of
the video, with a translation into the viewer's fluent language beneath. It
shows the last two lines, and they fade after about 6 seconds of silence.

- Client: `public/subtitles.js` (`Bilingle.subtitles`), styled by
  `public/subtitles.css`. `call.js` attaches it after joining
  (`Bilingle.subtitles.attach(callObject)`) and stops it in `leaveCall()`, so
  skip, partner-left and disconnect all stop recognition.
- Transport: Daily app messages (`sendAppMessage(msg, '*')` and the
  `app-message` event). The server is not involved and there is no socket
  event for it. Daily allows 4 KB per message, does not replay messages to late
  joiners, and documents no rate limit. The page still throttles interim
  results to about 2 per second.
- Message shape: `{ type: 'bilingle-subtitle', id, text, lang, final }`. `lang`
  is the ISO 639-1 code the speaker chose, and `id` groups interim results with
  their final line.
- Speech recognition uses the browser's Web Speech API (`SpeechRecognition`).
  It works only in Chrome and Edge, only over HTTPS or on localhost, and needs
  microphone permission. Other browsers show "Live subtitles need Chrome or
  Edge", and everything else keeps working, including reading the partner's
  subtitles.
- The controls below the video are:
  - **CC on/off**, one switch that both sends your recognized speech and shows
    your partner's subtitles;
  - **I am speaking: fluent | learning**, because recognition needs the
    language up front (it defaults to your fluent one);
  - a **Both / Original / Translated** display choice.
- Translation goes through `Bilingle.translate.translate`. If it fails, the
  original line still shows.
- Env vars: none.
- Privacy: **your browser sends your speech to its vendor's speech service**
  (Google in Chrome, Microsoft in Edge). Translated text goes to MyMemory
  through `/api/translate`.
- Tests: `tests/subtitles-test.js`, part of `npm test`, uses a fake
  recognizer, transport and clock. It cannot cover real speech or a live Daily
  call.

## Testing across two laptops

`localhost` means "this machine", and the waiting pool lives in the memory of
one process. If each laptop runs `npm start`, they have two separate pools and
never match. Run the server on one machine and connect every browser to it:

```bash
ipconfig getifaddr en0     # the host machine's LAN ip, e.g. 172.29.23.42
```

The other laptop opens `http://<that-ip>:3001`. Only the host machine needs
`server/.env`. Allow the incoming connection if macOS asks about `node`.

Browsers block the camera and microphone on a plain `http://` LAN address and
allow them only on `https://` or `localhost`. Text chat works this way, but
video needs the real deployment.

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

- **Node 18+**, pinned in `engines`. `server/rooms.js` calls the global
  `fetch`, which older versions don't have.
- **A host that keeps WebSocket connections open**, such as Render, Railway,
  Fly.io or a VPS. Serverless functions on Vercel or Netlify cannot hold a
  Socket.io connection.
- **Exactly one instance.** The waiting pool is an in-memory `Map`. Two
  instances behind a load balancer would have two separate pools, and their
  users would never match each other, with no error. Scaling past one instance
  first needs the pool moved to Redis.
- **HTTPS.** Browsers grant camera and microphone access only on a secure
  context, so video does not work over plain http.

Environment variables on the host:

| Variable | Value |
|---|---|
| `DAILY_API_KEY` | From the Daily dashboard. Set it in the host's environment, never in a committed file. |
| `ALLOWED_ORIGINS` | `https://bilingle.live,https://www.bilingle.live` |
| `MYMEMORY_EMAIL` | Your email. It raises the translation quota to 50000 characters per day (see Translation service). |
| `PORT` | Most hosts set it. It defaults to 3001. |

`dotenv` reads `server/.env` if it exists and does nothing otherwise, so in
production the host's own environment variables apply with no code change.
