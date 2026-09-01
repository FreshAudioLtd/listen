require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_LISTENERS = parseInt(process.env.MAX_LISTENERS || '5', 10);
const METERED_SUBDOMAIN = process.env.METERED_SUBDOMAIN || '';
const METERED_API_KEY = process.env.METERED_API_KEY || '';

// Best-effort fallback used only if METERED_SUBDOMAIN/METERED_API_KEY
// aren't configured: Google's public STUN server (reliable, no auth) plus
// the Open Relay Project's legacy shared TURN credentials. Metered now
// gates their TURN service behind free account signup to prevent abuse,
// so this shared TURN entry is NOT guaranteed to work — it's included as
// a quick first try, not a real substitute for your own credentials.
// See .env.example / README for the ~2-minute free signup that makes
// cellular connections reliable.
const FALLBACK_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:80?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
];

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// Serve ICE server config (STUN/TURN) to the frontend. If Metered
// credentials are configured, fetch fresh short-lived ones from their
// API; otherwise fall back to the shared public Open Relay servers.
app.get('/turn-credentials', async (req, res) => {
  if (METERED_SUBDOMAIN && METERED_API_KEY) {
    try {
      const url = `https://${METERED_SUBDOMAIN}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(METERED_API_KEY)}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`Metered API responded ${r.status}`);
      const iceServers = await r.json();
      return res.json({ iceServers, source: 'metered' });
    } catch (err) {
      console.error('Failed to fetch Metered TURN credentials, falling back:', err.message);
    }
  }
  res.json({ iceServers: FALLBACK_ICE_SERVERS, source: 'fallback' });
});

app.get('/config', (req, res) => {
  res.json({ maxListeners: MAX_LISTENERS });
});

const server = app.listen(PORT, () => {
  console.log(`Audio stream server listening on port ${PORT}`);
});

const wss = new WebSocketServer({ server, path: '/ws' });

// room code -> { hostWs, hostId, listeners: Map<listenerId, ws> }
const rooms = new Map();

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L to avoid ambiguity
function generateRoomCode() {
  let code;
  do {
    code = Array.from({ length: 6 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function cleanupHost(room, roomCode) {
  for (const [, listenerWs] of room.listeners) {
    send(listenerWs, { type: 'host-left' });
  }
  rooms.delete(roomCode);
}

function cleanupListener(room, listenerId) {
  room.listeners.delete(listenerId);
  send(room.hostWs, { type: 'listener-left', listenerId });
}

wss.on('connection', (ws) => {
  ws.id = crypto.randomUUID();
  ws.role = null;
  ws.room = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'host': {
        const roomCode = generateRoomCode();
        ws.role = 'host';
        ws.room = roomCode;
        rooms.set(roomCode, { hostWs: ws, hostId: ws.id, listeners: new Map() });
        send(ws, { type: 'hosting', room: roomCode, maxListeners: MAX_LISTENERS });
        break;
      }

      case 'join': {
        const roomCode = (msg.room || '').toUpperCase().trim();
        const room = rooms.get(roomCode);
        if (!room) {
          send(ws, { type: 'join-error', message: 'No broadcast found with that code.' });
          return;
        }
        if (room.listeners.size >= MAX_LISTENERS) {
          send(ws, { type: 'join-error', message: 'This broadcast already has the maximum number of listeners.' });
          return;
        }
        ws.role = 'listener';
        ws.room = roomCode;
        room.listeners.set(ws.id, ws);
        send(ws, { type: 'joined', room: roomCode, listenerId: ws.id });
        send(room.hostWs, { type: 'listener-joined', listenerId: ws.id });
        break;
      }

      // Relay WebRTC signaling data (SDP offers/answers, ICE candidates).
      // Host must include `to` (a listenerId). Listener signals always go
      // to the room's host.
      case 'signal': {
        const room = rooms.get(ws.room);
        if (!room) return;
        if (ws.role === 'host') {
          const target = room.listeners.get(msg.to);
          send(target, { type: 'signal', from: 'host', data: msg.data });
        } else if (ws.role === 'listener') {
          send(room.hostWs, { type: 'signal', from: ws.id, data: msg.data });
        }
        break;
      }

      case 'leave': {
        handleDisconnect(ws);
        break;
      }

      default:
        break;
    }
  });

  ws.on('close', () => handleDisconnect(ws));
  ws.on('error', () => handleDisconnect(ws));
});

function handleDisconnect(ws) {
  if (!ws.room) return;
  const room = rooms.get(ws.room);
  if (!room) return;

  if (ws.role === 'host' && room.hostId === ws.id) {
    cleanupHost(room, ws.room);
  } else if (ws.role === 'listener') {
    cleanupListener(room, ws.id);
  }
  ws.room = null;
}
