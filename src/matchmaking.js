// Waiting pool, keyed by "fluentLang-learningLang" (e.g. "en-tr").
const pool = new Map();

function poolKey(fluentLang, learningLang) {
  return `${fluentLang}-${learningLang}`;
}

function addToQueue(user) {
  const key = poolKey(user.fluentLang, user.learningLang);
  if (!pool.has(key)) pool.set(key, []);
  pool.get(key).push(user);
}

// Looks for someone waiting with the reverse language pair, removes and
// returns them if found (FIFO), or returns null.
function findAndRemoveMatch(user) {
  const reverseKey = poolKey(user.learningLang, user.fluentLang);
  const candidates = pool.get(reverseKey);
  if (!candidates || candidates.length === 0) return null;

  const match = candidates.shift();
  if (candidates.length === 0) pool.delete(reverseKey);
  return match;
}

function removeFromQueue(socketId) {
  for (const [key, users] of pool.entries()) {
    const index = users.findIndex((u) => u.socketId === socketId);
    if (index !== -1) {
      users.splice(index, 1);
      if (users.length === 0) pool.delete(key);
      return true;
    }
  }
  return false;
}

module.exports = { addToQueue, findAndRemoveMatch, removeFromQueue };
