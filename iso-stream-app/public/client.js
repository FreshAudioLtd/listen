// Shared helpers used by broadcast.js and listen.js

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

async function fetchIceServers() {
  try {
    const r = await fetch('/turn-credentials');
    const data = await r.json();
    return data.iceServers;
  } catch (err) {
    console.error('Could not fetch TURN credentials, using STUN only', err);
    return [{ urls: 'stun:stun.l.google.com:19302' }];
  }
}

// A WebSocket wrapper that auto-reconnects with backoff and calls
// onReconnect() after each successful reconnect so the caller can
// re-send whatever "hello" message (host/join) is needed.
class SignalingClient {
  constructor({ onMessage, onOpen, onReconnect, onStatusChange }) {
    this.onMessage = onMessage;
    this.onOpen = onOpen;
    this.onReconnect = onReconnect;
    this.onStatusChange = onStatusChange || (() => {});
    this.ws = null;
    this.attempt = 0;
    this.deliberatelyClosed = false;
    this._connect(false);
  }

  _connect(isReconnect) {
    this.onStatusChange('connecting');
    const ws = new WebSocket(wsUrl());
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      this.onStatusChange('connected');
      if (isReconnect) {
        this.onReconnect && this.onReconnect();
      } else {
        this.onOpen && this.onOpen();
      }
    };

    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      this.onMessage(msg);
    };

    ws.onclose = () => {
      if (this.deliberatelyClosed) {
        this.onStatusChange('closed');
        return;
      }
      this.onStatusChange('reconnecting');
      const delay = Math.min(1000 * 2 ** this.attempt, 8000);
      this.attempt += 1;
      setTimeout(() => this._connect(true), delay);
    };

    ws.onerror = () => {
      // onclose will fire right after; reconnect logic lives there.
    };
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  close() {
    this.deliberatelyClosed = true;
    if (this.ws) this.ws.close();
  }
}

// Keeps the screen awake where supported (Wake Lock API). Silently
// no-ops on unsupported browsers.
class ScreenWake {
  constructor() {
    this.lock = null;
    this._reacquire = () => {
      if (document.visibilityState === 'visible' && this._wanted) this.request();
    };
    document.addEventListener('visibilitychange', this._reacquire);
  }

  async request() {
    this._wanted = true;
    if (!('wakeLock' in navigator)) return;
    try {
      this.lock = await navigator.wakeLock.request('screen');
    } catch (err) {
      // Often fails if tab isn't visible yet; visibilitychange handler retries.
    }
  }

  release() {
    this._wanted = false;
    if (this.lock) {
      this.lock.release().catch(() => {});
      this.lock = null;
    }
  }
}

// Simple mic-level meter (0-100) via Web Audio AnalyserNode.
function createLevelMeter(stream, onLevel) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);
  let raf;
  function tick() {
    analyser.getByteTimeDomainData(data);
    let sumSquares = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sumSquares += v * v;
    }
    const rms = Math.sqrt(sumSquares / data.length);
    onLevel(Math.min(100, Math.round(rms * 220)));
    raf = requestAnimationFrame(tick);
  }
  tick();
  return () => {
    cancelAnimationFrame(raf);
    ctx.close().catch(() => {});
  };
}
