(() => {
  const joinCard = document.getElementById('joinCard');
  const liveCard = document.getElementById('liveCard');
  const roomInput = document.getElementById('roomInput');
  const joinBtn = document.getElementById('joinBtn');
  const joinError = document.getElementById('joinError');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const meterFill = document.getElementById('meterFill');
  const volumeSlider = document.getElementById('volumeSlider');
  const leaveBtn = document.getElementById('leaveBtn');
  const player = document.getElementById('player');

  let iceServers = [];
  let signaling = null;
  let pc = null;
  let stopMeter = null;
  let wake = null;
  let currentRoom = null;

  // The broadcast room code is fixed (see server.js FIXED_ROOM_CODE), so
  // prefill it by default — a shared link with ?room=... still overrides it.
  const params = new URLSearchParams(location.search);
  roomInput.value = (params.get('room') || 'STUDIO99').toUpperCase();

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

  function resetToJoinScreen(message) {
    if (pc) { pc.close(); pc = null; }
    if (stopMeter) { stopMeter(); stopMeter = null; }
    if (wake) { wake.release(); wake = null; }
    if (signaling) { signaling.close(); signaling = null; }
    player.srcObject = null;
    liveCard.style.display = 'none';
    joinCard.style.display = 'flex';
    joinBtn.disabled = false;
    joinError.textContent = message || '';
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

    pc.ontrack = (e) => {
      const stream = e.streams[0];
      player.srcObject = stream;
      player.play().catch((err) => console.warn('Autoplay blocked, tap Join again:', err));

      if (stopMeter) stopMeter();
      stopMeter = createLevelMeter(stream, (level) => {
        meterFill.style.width = level + '%';
      });
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
        setStatus('connecting', 'Waiting for broadcast…');
        break;
      case 'join-error':
        resetToJoinScreen(msg.message);
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

    // Unlock audio playback on iOS/Safari with this user-gesture-triggered call.
    player.muted = false;
    player.play().catch(() => {});

    iceServers = await fetchIceServers();

    joinCard.style.display = 'none';
    liveCard.style.display = 'flex';
    setStatus('connecting');

    wake = new ScreenWake();
    wake.request();

    signaling = new SignalingClient({
      onOpen: () => signaling.send({ type: 'join', room: currentRoom }),
      onReconnect: () => {
        if (pc) { pc.close(); pc = null; }
        signaling.send({ type: 'join', room: currentRoom });
      },
      onMessage: onSignalingMessage,
      onStatusChange: (s) => {
        if (s === 'reconnecting' || s === 'connecting') setStatus(s);
      },
    });
  }

  volumeSlider.addEventListener('input', () => {
    player.volume = Number(volumeSlider.value) / 100;
  });

  leaveBtn.addEventListener('click', () => resetToJoinScreen());
  joinBtn.addEventListener('click', join);
  roomInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') join();
  });
})();
