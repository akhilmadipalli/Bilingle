let callFrame = null;

// mounts a daily call into the given container and joins immediately
// no manual join button for the mvp, fires as soon as matched lands
async function joinCall(roomUrl, containerElementId) {
  const container = document.getElementById(containerElementId);

  const frame = window.DailyIframe.createFrame(container, {
    iframeStyle: { width: '100%', height: '100%', border: '0' },
  });
  callFrame = frame;

  // daily's own leave button ends the call without touching our app,
  // route it through the same path so the two arent out of sync
  frame.on('left-meeting', () => leaveCall());

  await frame.join({ url: roomUrl });

  // live subtitles ride on Daily app messages; works for the prebuilt frame and call object mode.
  // callFrame is null again if the call was torn down while we were joining
  if (callFrame === frame && window.Bilingle && Bilingle.subtitles) Bilingle.subtitles.attach(frame);
}

// tears down the current call and releases the camera/mic
async function leaveCall() {
  // stop speech recognition first: every leave path (skip, partner-left, disconnect) comes through here
  if (window.Bilingle && Bilingle.subtitles) Bilingle.subtitles.stop();
  if (!callFrame) return;

  const frame = callFrame;
  callFrame = null; // clear first so a second call can't race this teardown

  await frame.leave();
  await frame.destroy();
}

