(() => {
  const deviceCard = document.getElementById('deviceCard');
  const deviceSelect = document.getElementById('deviceSelect');
  const useDeviceBtn = document.getElementById('useDeviceBtn');
  const deviceError = document.getElementById('deviceError');

  const channelsCard = document.getElementById('channelsCard');
  const channelCountInput = document.getElementById('channelCountInput');
  const applyChannelCountBtn = document.getElementById('applyChannelCountBtn');
  const channelList = document.getElementById('channelList');
  const goLiveBtn = document.getElementById('goLiveBtn');
  const channelsError = document.getElementById('channelsError');

  const liveCard = document.getElementById('liveCard');
  const roomCodeEl = document.getElementById('roomCode');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const listenerCountEl = document.getElementById('listenerCount');
  const liveChannelList = document.getElementById('liveChannelList');
  const stopBtn = document.getElementById('stopBtn');

  const MAX_CHANNELS = 16;

  // Remembers each channel's name/photo (by position — channel 1, 2, 3…) in
  // this browser, so the next time you broadcast they're filled in
  // automatically instead of starting over as "Channel 1", "Channel 2"...
  const CHANNEL_PRESETS_KEY = 'iso-mixer-channel-presets';

  function loadChannelPresets() {
    try {
      const raw = localStorage.getItem(CHANNEL_PRESETS_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      console.warn('Could not read saved channel names/photos:', err);
      return [];
    }
  }

  function saveChannelPresets() {
    try {
      const presets = channelNodes.map((n) => ({ label: n.label, photo: n.photo || null }));
      localStorage.setItem(CHANNEL_PRESETS_KEY, JSON.stringify(presets));
    } catch (err) {
      // Storage can fail (quota exceeded, private browsing, etc.) — the app
      // still works, it just won't remember names/photos next time.
      console.warn('Could not save channel names/photos:', err);
    }
  }

  let rawStream = null;
  let audioCtx = null;
  let channelNodes = []; // [{ id, track, stream, label, row, meterFillEl }]
  let currentListCleanup = null;

  let iceServers = [];
  let signaling = null;
  const peers = new Map(); // listenerId -> RTCPeerConnection
  let wake = null;
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

  // ---------- Device selection (Stage 1) ----------

  async function loadDevices() {
    deviceSelect.innerHTML = '';
    try {
      // A quick throwaway request to unlock device labels (browsers hide
      // them until permission has been granted at least once).
      const unlock = await navigator.mediaDevices.getUserMedia({ audio: true });
      unlock.getTracks().forEach((t) => t.stop());
    } catch (err) {
      deviceError.textContent = 'Could not access microphone: ' + err.message;
      return;
    }

    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((d) => d.kind === 'audioinput');
    if (inputs.length === 0) {
      deviceError.textContent = 'No audio input devices found.';
      return;
    }
    for (const d of inputs) {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || 'Microphone';
      deviceSelect.appendChild(opt);
    }
  }

  async function useSelectedDevice() {
    useDeviceBtn.disabled = true;
    deviceError.textContent = '';
    const deviceId = deviceSelect.value;

    try {
      rawStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: deviceId },
          channelCount: { ideal: MAX_CHANNELS, min: 1 },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
    } catch (err) {
      deviceError.textContent = 'Could not open that device: ' + err.message;
      useDeviceBtn.disabled = false;
      return;
    }

    const track = rawStream.getAudioTracks()[0];
    const settings = track.getSettings ? track.getSettings() : {};
    let count = settings.channelCount || 2;
    count = Math.max(1, Math.min(MAX_CHANNELS, count));

    channelCountInput.max = MAX_CHANNELS;
    channelCountInput.value = count;
    buildChannelGraph(count);

    deviceCard.style.display = 'none';
    channelsCard.style.display = 'flex';
    useDeviceBtn.disabled = false;
  }

  // ---------- Channel splitting (Stage 2 setup) ----------

  function teardownChannelGraph() {
    if (currentListCleanup) {
      currentListCleanup();
      currentListCleanup = null;
    }
    channelNodes = [];
    if (audioCtx) {
      audioCtx.close().catch(() => {});
      audioCtx = null;
    }
  }

  function buildChannelGraph(count) {
    // Preserve any labels/photos the user already set THIS session, by
    // index; for a channel with nothing set yet, fall back to whatever was
    // saved from a previous broadcast on this browser (loadChannelPresets).
    const previousLabels = channelNodes.map((n) => n.label);
    const previousPhotos = channelNodes.map((n) => n.photo);
    const presets = loadChannelPresets();
    teardownChannelGraph();

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createMediaStreamSource(rawStream);
    const splitter = audioCtx.createChannelSplitter(count);
    source.connect(splitter);

    channelNodes = [];
    for (let i = 0; i < count; i++) {
      const gain = audioCtx.createGain();
      splitter.connect(gain, i, 0);
      const dest = audioCtx.createMediaStreamDestination();
      gain.connect(dest);
      const channelTrack = dest.stream.getAudioTracks()[0];
      const preset = presets[i];
      channelNodes.push({
        id: channelTrack.id,
        track: channelTrack,
        stream: dest.stream,
        label: previousLabels[i] || (preset && preset.label) || `Channel ${i + 1}`,
        photo: previousPhotos[i] || (preset && preset.photo) || null,
      });
    }

    currentListCleanup = mountChannelRows(channelList, channelNodes, true);
  }

  // Reads an image file and downsamples it — WITHOUT cropping — to a data
  // URL small enough to ride along in every signaling 'channels' message
  // (all channels, to everyone). The full photo is preserved at its own
  // aspect ratio (never forced to a square), just scaled down if it's
  // larger than `maxSize` on its longest side; small photos are left alone.
  function resizeImageToDataUrl(file, maxSize = 240, quality = 0.75) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error || new Error('Could not read file'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('Could not read image'));
        img.onload = () => {
          const scale = Math.min(1, maxSize / img.width, maxSize / img.height);
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  applyChannelCountBtn.addEventListener('click', () => {
    let count = parseInt(channelCountInput.value, 10);
    if (!count || count < 1) count = 1;
    if (count > MAX_CHANNELS) count = MAX_CHANNELS;
    channelCountInput.value = count;
    buildChannelGraph(count);
  });

  // Renders one row per channel (label input + live meter) into `container`.
  // Returns a cleanup function that stops the meters. `editable` controls
  // whether the label input is enabled (it always is here, live or not —
  // renaming while broadcasting just re-sends fresh metadata).
  function mountChannelRows(container, nodes, editable) {
    container.innerHTML = '';
    const stops = [];
    for (const node of nodes) {
      const row = document.createElement('div');
      row.className = 'channel-row';

      const avatarBtn = document.createElement('button');
      avatarBtn.type = 'button';
      avatarBtn.className = 'channel-avatar-btn' + (node.photo ? ' has-photo' : '');
      avatarBtn.textContent = node.photo ? '' : '📷';
      avatarBtn.title = node.photo ? 'Change photo' : 'Add photo';
      avatarBtn.disabled = !editable;
      if (node.photo) avatarBtn.style.backgroundImage = `url(${node.photo})`;

      const photoInput = document.createElement('input');
      photoInput.type = 'file';
      photoInput.accept = 'image/*';
      photoInput.style.display = 'none';
      photoInput.addEventListener('change', async () => {
        const file = photoInput.files && photoInput.files[0];
        photoInput.value = '';
        if (!file) return;
        try {
          const dataUrl = await resizeImageToDataUrl(file);
          node.photo = dataUrl;
          avatarBtn.classList.add('has-photo');
          avatarBtn.textContent = '';
          avatarBtn.title = 'Change photo';
          avatarBtn.style.backgroundImage = `url(${dataUrl})`;
          sendChannelsUpdate();
        } catch (err) {
          console.warn('Could not process photo:', err);
        }
      });
      avatarBtn.addEventListener('click', () => photoInput.click());

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'pill channel-label-input';
      input.value = node.label;
      input.disabled = !editable;
      input.addEventListener('input', () => {
        node.label = input.value;
        sendChannelsUpdate();
      });

      const meter = document.createElement('div');
      meter.className = 'channel-meter';
      const meterFill = document.createElement('div');
      meterFill.className = 'channel-meter-fill';
      meter.appendChild(meterFill);

      row.appendChild(avatarBtn);
      row.appendChild(photoInput);
      row.appendChild(input);
      row.appendChild(meter);
      container.appendChild(row);

      const stop = createLevelMeter(node.stream, (level) => {
        meterFill.style.width = level + '%';
      });
      stops.push(stop);
    }
    return () => stops.forEach((s) => s());
  }

  // ---------- Going live (Stage 3) ----------

  // Debounced: labels can change on every keystroke, and each channel now
  // carries a small photo, so batching rapid edits into one send/save keeps
  // things from being flooded with near-duplicate writes. Runs whenever a
  // name or photo changes — while setting up (Stage 2) as well as live —
  // so presets are saved even if you never go live this time.
  let sendChannelsTimer = null;
  function sendChannelsUpdate() {
    if (sendChannelsTimer) clearTimeout(sendChannelsTimer);
    sendChannelsTimer = setTimeout(() => {
      saveChannelPresets();
      if (!signaling) return;
      signaling.send({
        type: 'channels',
        channels: channelNodes.map((n) => ({ id: n.id, label: n.label, photo: n.photo || null })),
      });
    }, 250);
  }

  async function createPeerForListener(listenerId) {
    const pc = new RTCPeerConnection({ iceServers });
    peers.set(listenerId, pc);
    updateListenerCount();

    for (const node of channelNodes) {
      pc.addTrack(node.track, node.stream);
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        signaling.send({ type: 'signal', to: listenerId, data: { kind: 'ice', candidate: e.candidate } });
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        try { pc.restartIce && pc.restartIce(); } catch {}
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
        setStatus('connected');
        sendChannelsUpdate();
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

  async function goLive() {
    goLiveBtn.disabled = true;
    channelsError.textContent = '';

    if (channelNodes.length === 0) {
      channelsError.textContent = 'No channels to broadcast.';
      goLiveBtn.disabled = false;
      return;
    }

    iceServers = await fetchIceServers();

    channelsCard.style.display = 'none';
    liveCard.style.display = 'flex';
    setStatus('connecting');

    if (currentListCleanup) {
      currentListCleanup();
    }
    currentListCleanup = mountChannelRows(liveChannelList, channelNodes, true);

    wake = new ScreenWake();
    wake.request();

    signaling = new SignalingClient({
      onOpen: () => signaling.send({ type: 'host' }),
      onReconnect: () => {
        // The room code stays fixed, but the server drops the room when the
        // socket disconnects, so existing listener peer connections are
        // stale — clear them; 'hosting' (once re-established) re-sends
        // channel metadata automatically.
        for (const id of Array.from(peers.keys())) closePeer(id);
        signaling.send({ type: 'host' });
      },
      onMessage: onSignalingMessage,
      onStatusChange: setStatus,
    });

    goLiveBtn.disabled = false;
  }

  function stop(message) {
    if (signaling) signaling.close();
    signaling = null;
    for (const id of Array.from(peers.keys())) closePeer(id);
    if (wake) wake.release();
    wake = null;

    teardownChannelGraph();
    if (rawStream) {
      rawStream.getTracks().forEach((t) => t.stop());
      rawStream = null;
    }

    liveCard.style.display = 'none';
    channelsCard.style.display = 'none';
    deviceCard.style.display = 'flex';

    roomCodeEl.textContent = '------';
    listenerCountEl.textContent = '0 listeners connected';
    deviceError.textContent = message || '';
    loadDevices();
  }

  useDeviceBtn.addEventListener('click', useSelectedDevice);
  goLiveBtn.addEventListener('click', goLive);
  stopBtn.addEventListener('click', () => stop());

  loadDevices();
})();
