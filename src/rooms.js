// Tracks active matches: key = socketId -> value = { partnerSocketId, roomUrl }
// roomUrl from Daily.co
const activeMatches = new Map();


// Add both users to active-match dict
function createMatch(socketIdA, socketIdB, roomUrl) {
  activeMatches.set(socketIdA, { partnerSocketId: socketIdB, roomUrl });
  activeMatches.set(socketIdB, { partnerSocketId: socketIdA, roomUrl });
}

function getMatch(socketId) {
  return activeMatches.get(socketId) || null; // returns null if that socketId isn't found, instead of undefined
}

// Removes the match for socketId and its partner, returning the partner's
// socketId (or null if this socket had no active match).
function endMatch(socketId) {
  const match = activeMatches.get(socketId);
  if (!match) return null;

  activeMatches.delete(socketId);
  activeMatches.delete(match.partnerSocketId);
  return match.partnerSocketId;
}

module.exports = { createMatch, getMatch, endMatch };
