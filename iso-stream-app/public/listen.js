(() => {
  const joinCard = document.getElementById('joinCard');
  const liveCard = document.getElementById('liveCard');
  const roomInput = document.getElementById('roomInput');
  const joinBtn = document.getElementById('joinBtn');
  const joinError = document.getElementById('joinError');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const channelListEl = document.getElementById('channelList');
  const leaveBtn = document.getElementById('leaveBtn');

  let iceServers = [];
  let signaling = null;
  let pc = null;
  let wake = null;
  let currentRoom = null;

  // Ordered [{ id, label }] as announced by the broadcaster.
  let channels = [];
  // trackId -> { audioEl, track, muted }
  const tracks = new Map();

  // The room code is fixed (see server.js FIXED_ROOM_CODE), so prefill it
  // by default — a shared link with ?room=... still overrides it.
  const params = new URLSearchParams(location.search);
  roomInput.value = (params.get('room') || 'ISO').toUpperCase();

  roomInput.addEventListener('input', () => {
    roomInput.value = roomInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });

  function setStatus(state, label) {
    statusDot.className = 'dot ' + (state === 'connected' ? 'live' : state === 'reconnecting' || state === 'connecting' ? 'connecting' : 'bad');
    const labels = {
      connected: 'Connected',
      connecting: 'Connecting…',
      reconnecting: 'Reconnecting…',
      closed: 'Disconnected',
    };
    statusText.textContent = label || labels[state] || state;
  }

  function toggleChannel(id) {
    const entry = tracks.get(id);
    if (!entry) return;
    entry.muted = !entry.muted;
    entry.audioEl.muted = entry.muted;
    renderChannelList();
  }

  function renderChannelList() {
    channelListEl.innerHTML = '';

    const knownIds = new Set(channels.map((c) => c.id));
    // Anything with audio already arriving but no metadata yet (rare
    // ordering edge case) still gets a tile, appended at the end.
    const extra = Array.from(tracks.keys())
      .filter((id) => !knownIds.has(id))
      .map((id) => ({ id, label: 'Channel' }));

    const all = [...channels, ...extra];

    // Square-ish grid so up to 16 (or more) channels fit one screen with no
    // scrolling — e.g. 16 channels -> 4 columns x 4 rows.
    const count = Math.max(1, all.length);
    const columns = Math.max(1, Math.ceil(Math.sqrt(count)));
    const rows = Math.max(1, Math.ceil(count / columns));
    channelListEl.style.gridTemplateColumns = `repeat(${columns}, 1fr)`;
    channelListEl.style.gridTemplateRows = `repeat(${rows}, 1fr)`;

    for (const ch of all) {
      const entry = tracks.get(ch.id);
      const listening = entry && !entry.muted;

      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'channel-tile ' + (!entry ? 'state-waiting' : listening ? 'state-listening' : 'state-muted');
      tile.disabled = !entry;

      const label = document.createElement('span');
      label.className = 'tile-label';
      label.textContent = ch.label || 'Channel';

      const state = document.createElement('span');
      state.className = 'tile-state';
      state.textContent = !entry ? 'Waiting…' : listening ? 'Listening' : 'Muted';

      tile.appendChild(label);
      tile.appendChild(state);
      tile.addEventListener('click', () => toggleChannel(ch.id));
      channelListEl.appendChild(tile);
    }
  }

  function resetToJoinScreen(message) {
    if (pc) { pc.close(); pc = null; }
    if (wake) { wake.release(); wake = null; }
    if (signaling) { signaling.close(); signaling = null; }
    for (const [, entry] of tracks) {
      entry.audioEl.srcObject = null;
      entry.audioEl.remove();
    }
    tracks.clear();
    channels = [];
    channelListEl.innerHTML = '';
    liveCard.style.display = 'none';
    joinCard.style.display = 'flex';
    joinBtn.disabled = false;
    joinError.textContent = message || '';
    document.body.classList.remove('iso-live');
  }

  async function ensurePeerConnection() {
    if (pc) return pc;
    pc = new RTCPeerConnection({ iceServers });
    window.pc = pc; // exposed for debugging in devtools

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        signaling.send({ type: 'signal', data: { kind: 'ice', candidate: e.candidate } });
      }
    };

    // One event fires per ISO channel track the broadcaster sent.
    pc.ontrack = (e) => {
      const stream = e.streams[0] || new MediaStream([e.track]);
      const audioEl = document.createElement('audio');
      audioEl.autoplay = true;
      audioEl.playsInline = true;
      audioEl.muted = true; // start silent — listener taps a channel to hear it
      audioEl.style.display = 'none';
      audioEl.srcObject = stream;
      document.body.appendChild(audioEl);
      audioEl.play().catch((err) => console.warn('Autoplay blocked, tap the channel again:', err));

      tracks.set(e.track.id, { audioEl, track: e.track, muted: true });
      e.track.addEventListener('ended', () => {
        tracks.delete(e.track.id);
        audioEl.remove();
        renderChannelList();
      });
      renderChannelList();
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') setStatus('connected');
      else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') setStatus('reconnecting');
    };

    return pc;
  }

  async function handleOffer(data) {
    await ensurePeerConnection();
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    signaling.send({ type: 'signal', data: { kind: 'answer', sdp: answer } });
  }

  async function handleIce(data) {
    if (!pc || !data.candidate) return;
    try {
      await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    } catch (err) {
      console.error('addIceCandidate failed', err);
    }
  }

  function onSignalingMessage(msg) {
    switch (msg.type) {
      case 'joined':
        channels = msg.channels || [];
        setStatus('connecting', 'Waiting for broadcast…');
        renderChannelList();
        break;
      case 'join-error':
        resetToJoinScreen(msg.message);
        break;
      case 'channels':
        channels = msg.channels || [];
        renderChannelList();
        break;
      case 'signal':
        if (msg.data.kind === 'offer') handleOffer(msg.data);
        else if (msg.data.kind === 'ice') handleIce(msg.data);
        break;
      case 'host-left':
        resetToJoinScreen('The broadcast ended.');
        break;
      default:
        break;
    }
  }

  async function join() {
    const room = roomInput.value.trim();
    if (!room) {
      joinError.textContent = 'Enter the room code.';
      return;
    }
    currentRoom = room;
    joinBtn.disabled = true;
    joinError.textContent = '';

    iceServers = await fetchIceServers();

    joinCard.style.display = 'none';
    liveCard.style.display = 'flex';
    document.body.classList.add('iso-live');
    setStatus('connecting');

    wake = new ScreenWake();
    wake.request();

    signaling = new SignalingClient({
      onOpen: () => signaling.send({ type: 'join', room: currentRoom }),
      onReconnect: () => {
        if (pc) { pc.close(); pc = null; }
        for (const [, entry] of tracks) entry.audioEl.remove();
        tracks.clear();
        signaling.send({ type: 'join', room: currentRoom });
      },
      onMessage: onSignalingMessage,
      onStatusChange: (s) => {
        if (s === 'reconnecting' || s === 'connecting') setStatus(s);
      },
    });
  }

  leaveBtn.addEventListener('click', () => resetToJoinScreen());
  joinBtn.addEventListener('click', join);
  roomInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') join();
  });
})();
