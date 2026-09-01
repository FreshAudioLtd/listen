require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_LISTENERS = parseInt(process.env.MAX_LISTENERS || '5', 10);

// Static TURN credential generated from a Metered.ca "TURN Server" app
// (dashboard.metered.ca -> TURN Server -> Add Credential). This pair is
// used directly in the iceServers array below — no per-request API call
// needed, which is both simpler and avoids an extra network hop from the
// server to Metered on every join. Set both env vars to enable it.
const METERED_TURN_USERNAME = process.env.METERED_TURN_USERNAME || '';
const METERED_TURN_CREDENTIAL = process.env.METERED_TURN_CREDENTIAL || '';

// Best-effort fallback used only if METERED_TURN_USERNAME/METERED_TURN_CREDENTIAL
// aren't configured: Google's public STUN server (reliable, no auth) plus
// the Open Relay Project's legacy shared TURN credentials.
const FALLBACK_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:80?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
];

function meteredIceServers(username, credential) {
  return [
    { urls: 'stun:stun.relay.metered.ca:80' },
    { urls: 'turn:global.relay.metered.ca:80', username, credential },
    { urls: 'turn:global.relay.metered.ca:80?transport=tcp', username, credential },
    { urls: 'turn:global.relay.metered.ca:443', username, credential },
    { urls: 'turns:global.relay.metered.ca:443?transport=tcp', username, credential },
  ];
}

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// Serve ICE server config (STUN/TURN) to the frontend.
app.get('/turn-credentials', (req, res) => {
  if (METERED_TURN_USERNAME && METERED_TURN_CREDENTIAL) {
    return res.json({
      iceServers: meteredIceServers(METERED_TURN_USERNAME, METERED_TURN_CREDENTIAL),
      source: 'metered',
    });
  }
  res.json({ iceServers: FALLBACK_ICE_SERVERS, source: 'fallback' });
});

app.get('/config', (req, res) => {
  res.json({ maxListeners: MAX_LISTENERS });
});

const server = app.listen(PORT, () => {
  console.log(`ISO stream server listening on port ${PORT}`);
});

const wss = new WebSocketServer({ server, path: '/ws' });

// room code -> { hostWs, hostId, listeners: Map<listenerId, ws>, channels: [{id, label}] }
const rooms = new Map();

// Fixed room code: every broadcast uses this same code, so listeners never
// need to be given a new one. Starting a new broadcast while one is already
// live takes over the code — the previous broadcaster is disconnected and
// its listeners are told the broadcast ended (they just rejoin with the
// same ISO code once the new broadcast is live).
const FIXED_ROOM_CODE = process.env.ROOM_CODE || 'ISO';

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
        const roomCode = FIXED_ROOM_CODE;
        const existing = rooms.get(roomCode);
        if (existing && existing.hostWs && existing.hostWs !== ws) {
          // Someone is already broadcasting on the fixed code — take over:
          // tell their listeners the broadcast ended and disconnect them.
          cleanupHost(existing, roomCode);
          send(existing.hostWs, { type: 'host-replaced' });
          try { existing.hostWs.close(); } catch {}
        }
        ws.role = 'host';
        ws.room = roomCode;
        rooms.set(roomCode, { hostWs: ws, hostId: ws.id, listeners: new Map(), channels: [] });
        send(ws, { type: 'hosting', room: roomCode, maxListeners: MAX_LISTENERS });
        break;
      }

      // Host announces (or updates) the list of ISO channels being sent —
      // [{ id: <track id>, label: <display name> }, ...]. Stored on the
      // room so a listener who joins later still gets the current list,
      // and relayed live to everyone already listening.
      case 'channels': {
        const room = rooms.get(ws.room);
        if (!room || ws.role !== 'host') return;
        room.channels = Array.isArray(msg.channels) ? msg.channels : [];
        for (const [, listenerWs] of room.listeners) {
          send(listenerWs, { type: 'channels', channels: room.channels });
        }
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
        send(ws, { type: 'joined', room: roomCode, listenerId: ws.id, channels: room.channels });
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
