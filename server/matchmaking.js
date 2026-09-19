// Waiting pool, key = "fluentLang-learningLang" (e.g. "en-tr").
// value = [entry, entry, ...] of everyone waiting on that pair.
const pool = new Map();

function poolKey(fluentLang, learningLang) {
  return `${fluentLang}-${learningLang}`;
}

function addToQueue(entry) {
  const key = poolKey(entry.fluentLang, entry.learningLang);
  if (!pool.has(key)) pool.set(key, []);
  pool.get(key).push(entry);
}

// Looks for someone waiting on the *reverse* of this pair, removes that one
// entry and returns it (FIFO), or returns null.

function findAndRemoveMatch(fluentLang, learningLang) {
  const reverseKey = poolKey(learningLang, fluentLang);
  const candidates = pool.get(reverseKey);
  if (!candidates || candidates.length === 0) return null;

  const match = candidates.shift();
  if (candidates.length === 0) pool.delete(reverseKey);
  return match;
}

// Removes EVERY entry belonging to this socket, across all pairs. Used on
// disconnect, on match, and when a user
// re-queues with a different language selection.
// Returns how many entries were dropped.
function removeFromQueue(socketId) {
  let removed = 0;

  for (const [key, entries] of pool.entries()) {
    // Walk backwards so splicing doesn't shift indexes we haven't checked.
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].socketId === socketId) {
        entries.splice(i, 1);
        removed++;
      }
    }

    if (entries.length === 0) pool.delete(key);
  }

  return removed;
}

module.exports = { addToQueue, findAndRemoveMatch, removeFromQueue };
