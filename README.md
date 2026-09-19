# Bilingle (Bilinguale)

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

## Structure

- `server/` - matchmaking server: waiting pool, socket events, room creation
- `client/` - profile form, waiting screen, matched screen (video + chat)

Built for a one-day hackathon; no persistence, auth, or scaling beyond the demo.
