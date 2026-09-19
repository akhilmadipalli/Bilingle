// Placeholder for Developer B's room-creation function.
//
// Agreed signature: createRoom() -> Promise<string> (a daily.co room url)
// Once Developer B's module is ready, replace the implementation below with:
//   const { createRoom } = require('path/to/dev-b/module');
//   module.exports = { createRoom };

let mockRoomCounter = 0;

async function createRoom() {
  mockRoomCounter += 1;
  return `https://example.daily.co/mock-room-${mockRoomCounter}`;
}

module.exports = { createRoom };
