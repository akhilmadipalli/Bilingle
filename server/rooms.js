const DAILY_API_KEY = process.env.DAILY_API_KEY;

// creates one daily.co room, returns its joinable url
// server-side only, never call from the browser, holds the api key
async function createRoom() {
  const res = await fetch("https://api.daily.co/v1/rooms", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${DAILY_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      properties: {
        // daily expects an absolute unix timestamp here, not a duration
        exp: Math.floor(Date.now() / 1000) + 86400,
        // disable daily's built-in chat ui, app has its own chat panel
        enable_chat: false,
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`Daily room creation failed: ${res.status} ${await res.text()}`);
  }

  const room = await res.json();
  return { roomUrl: room.url };
}

module.exports = { createRoom };

