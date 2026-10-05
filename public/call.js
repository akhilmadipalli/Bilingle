let callFrame = null;

function attach(element, participant, withAudio) {
  if (!element) return;

  const tracks = [];
  if (participant) {
    const video = participant.tracks && participant.tracks.video;
    if (video && video.state === 'playable' && video.persistentTrack) {
      tracks.push(video.persistentTrack);
    }
    if (withAudio) {
      const audio = participant.tracks && participant.tracks.audio;
      if (audio && audio.state === 'playable' && audio.persistentTrack) {
        tracks.push(audio.persistentTrack);
      }
    }
  }

  const current = element.srcObject ? element.srcObject.getTracks() : [];
  const unchanged =
    current.length === tracks.length && tracks.every((track) => current.includes(track));
  if (unchanged) return;

  element.srcObject = tracks.length ? new MediaStream(tracks) : null;
  if (tracks.length) element.play().catch(() => {});
}

async function joinCall(roomUrl, containerElementId) {
  const container = document.getElementById(containerElementId);
  const selfVideo = container.querySelector('[data-video="self"]');
  const partnerVideo = container.querySelector('[data-video="partner"]');

  const call = window.DailyIframe.createCallObject();
  callFrame = call;

  const render = () => {
    if (callFrame !== call) return;
    const participants = call.participants();
    attach(selfVideo, participants.local, false);
    attach(partnerVideo, Object.values(participants).find((p) => !p.local), true);
  };

  call.on('joined-meeting', render);
  call.on('participant-joined', render);
  call.on('participant-updated', render);
  call.on('participant-left', render);
  call.on('track-started', render);
  call.on('track-stopped', render);
  call.on('left-meeting', () => leaveCall());

  await call.join({ url: roomUrl });
  render();

  if (callFrame === call && window.Bilingle && Bilingle.subtitles) {
    Bilingle.subtitles.attach(call);
  }
}

async function leaveCall() {
  if (window.Bilingle && Bilingle.subtitles) Bilingle.subtitles.stop();
  if (!callFrame) return;

  const call = callFrame;
  callFrame = null;

  document.querySelectorAll('#video-container video').forEach((element) => {
    element.srcObject = null;
  });

  await call.leave();
  await call.destroy();
}
