// Waiting pool, key = "fluentLang-learningLang" (e.g. "en-tr").
const pool = new Map(); // value = [user1, user2, user3] who use that key pair

function poolKey(fluentLang, learningLang) {
  return `${fluentLang}-${learningLang}`;
}

function addToQueue(user) {
  const key = poolKey(user.fluentLang, user.learningLang);
  if (!pool.has(key)) pool.set(key, []); 
  pool.get(key).push(user);
}

// Looks for someone waiting with the *reverse* language pair, removes and
// returns them if found (FIFO), or returns null.
function findAndRemoveMatch(user) {
  const reverseKey = poolKey(user.learningLang, user.fluentLang); 
  const candidates = pool.get(reverseKey); //list that has reverse pair
  if (!candidates || candidates.length === 0) return null;

  const match = candidates.shift(); // pop match from front of candidates list
  if (candidates.length === 0) pool.delete(reverseKey);
  return match;
}

// Remove user without a match, with socketId === socketId (disconnect, close tab, etc.)
function removeFromQueue(socketId) {
  for (const [key, users] of pool.entries()) {
    const index = users.findIndex((u) => u.socketId === socketId); // find user that disconnected
    if (index !== -1) { 
      users.splice(index, 1); // remove just that user
      if (users.length === 0) pool.delete(key);
      return true;
    }
  }
  return false;
}

module.exports = { addToQueue, findAndRemoveMatch, removeFromQueue };
