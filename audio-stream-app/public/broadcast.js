(() => {
  const setupCard = document.getElementById('setupCard');
  const liveCard = document.getElementById('liveCard');
  const startBtn = document.getElementById('startBtn');
  const setupError = document.getElementById('setupError');
  const roomCodeEl = document.getElementById('roomCode');
  const shareLink = document.getElementById('shareLink');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const listenerCountEl = document.getElementById('listenerCount');
  const meterFill = document.getElementById('meterFill');
  const muteBtn = document.getElementById('muteBtn');
  const stopBtn = document.getElementById('stopBtn');

  let localStream = null;
  let iceServers = [];
  let signaling = null;
  let stopMeter = null;
  let wake = null;
  const peers = new Map(); // listenerId -> RTCPeerConnection
  let muted = false;
  let roomCode = null;

  function setStatus(state) {
    statusDot.className = 'dot ' + (state === 'connected' ? 'live' : state === 'reconnecting' || state === 'connecting' ? 'connecting' : 'bad');
    const labels = {
      connected: 'Live',
      connecting: 'Connecting…',
      reconnecting: 'Reconnecting…',
      closed: 'Disconnected',
    };
    statusText.textContent = labels[state] || state;
  }

  function updateListenerCount() {
    const n = peers.size;
    listenerCountEl.textContent = `${n} listener${n === 1 ? '' : 's'} connected`;
  }

  async function createPeerForListener(listenerId) {
    const pc = new RTCPeerConnection({ iceServers });
    peers.set(listenerId, pc);
    updateListenerCount();

    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        signaling.send({ type: 'signal', to: listenerId, data: { kind: 'ice', candidate: e.candidate } });
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        try { pc.restartIce && pc.restartIce(); } catch {}
      }
      if (pc.connectionState === 'closed' || pc.connectionState === 'failed') {
        // leave cleanup to explicit listener-left message from server;
        // this just guards against dangling entries.
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    signaling.send({ type: 'signal', to: listenerId, data: { kind: 'offer', sdp: offer } });
  }

  async function handleSignal(fromListenerId, data) {
    const pc = peers.get(fromListenerId);
    if (!pc) return;
    if (data.kind === 'answer') {
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    } else if (data.kind === 'ice' && data.candidate) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch (err) {
        console.error('addIceCandidate failed', err);
      }
    }
  }

  function closePeer(listenerId) {
    const pc = peers.get(listenerId);
    if (pc) {
      pc.close();
      peers.delete(listenerId);
      updateListenerCount();
    }
  }

  function onSignalingMessage(msg) {
    switch (msg.type) {
      case 'hosting':
        roomCode = msg.room;
        roomCodeEl.textContent = roomCode;
        shareLink.href = `${location.origin}/listen.html?room=${roomCode}`;
        shareLink.textContent = `${location.host}/listen.html?room=${roomCode}`;
        setStatus('connected');
        break;
      case 'listener-joined':
        createPeerForListener(msg.listenerId);
        break;
      case 'listener-left':
        closePeer(msg.listenerId);
        break;
      case 'signal':
        handleSignal(msg.from, msg.data);
        break;
      case 'host-replaced':
        stop('Another device started broadcasting on this code and took over.');
        break;
      default:
        break;
    }
  }

  async function start() {
    startBtn.disabled = true;
    setupError.textContent = '';
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (err) {
      setupError.textContent = 'Could not access microphone: ' + err.message;
      startBtn.disabled = false;
      return;
    }

    iceServers = await fetchIceServers();

    setupCard.style.display = 'none';
    liveCard.style.display = 'flex';
    setStatus('connecting');

    stopMeter = createLevelMeter(localStream, (level) => {
      meterFill.style.width = level + '%';
    });

    wake = new ScreenWake();
    wake.request();

    signaling = new SignalingClient({
      onOpen: () => signaling.send({ type: 'host' }),
      onReconnect: () => {
        // The room code stays fixed, but the server drops the room when the
        // socket disconnects, so existing listener peer connections are
        // stale — clear them and re-host under the same code.
        for (const id of Array.from(peers.keys())) closePeer(id);
        signaling.send({ type: 'host' });
      },
      onMessage: onSignalingMessage,
      onStatusChange: setStatus,
    });
  }

  function stop(message) {
    if (signaling) signaling.close();
    for (const id of Array.from(peers.keys())) closePeer(id);
    if (localStream) localStream.getTracks().forEach((t) => t.stop());
    if (stopMeter) stopMeter();
    if (wake) wake.release();

    liveCard.style.display = 'none';
    setupCard.style.display = 'flex';
    startBtn.disabled = false;
    roomCodeEl.textContent = '------';
    meterFill.style.width = '0%';
    setupError.textContent = message || '';
  }

  muteBtn.addEventListener('click', () => {
    if (!localStream) return;
    muted = !muted;
    localStream.getAudioTracks().forEach((t) => (t.enabled = !muted));
    muteBtn.textContent = muted ? 'Unmute' : 'Mute';
  });

  stopBtn.addEventListener('click', stop);
  startBtn.addEventListener('click', start);
})();
