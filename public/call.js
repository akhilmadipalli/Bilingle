let callFrame = null;

// mounts a daily call into the given container and joins immediately
// no manual join button for the mvp, fires as soon as matched lands
async function joinCall(roomUrl, containerElementId) {
  const container = document.getElementById(containerElementId);

  callFrame = window.DailyIframe.createFrame(container, {
    iframeStyle: { width: '100%', height: '100%', border: '0' },
  });

  // daily's own leave button ends the call without touching our app,
  // route it through the same path so the two arent out of sync
  callFrame.on('left-meeting', () => leaveCall());

  await callFrame.join({ url: roomUrl });
}

// tears down the current call and releases the camera/mic
async function leaveCall() {
  if (!callFrame) return;

  const frame = callFrame;
  callFrame = null; // clear first so a second call can't race this teardown

  await frame.leave();
  await frame.destroy();
}

