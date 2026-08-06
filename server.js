const WebSocket = require('ws');
const http = require('http');
const crypto = require('crypto');

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('LiveCam Signal OK');
});

const wss = new WebSocket.Server({ server });

// ── Rooms ──
// rooms[roomId] = {
//   sender: ws,
//   encryptedOffer: null,   // PIN-encrypted offer, opaque to server
//   viewers: { viewerId: ws }
//   createdAt: timestamp
// }
const rooms = {};

// ── Rate limiting ──
// ip -> { count, resetAt }
const rateLimits = {};
const RATE_WINDOW_MS = 10000; // 10 seconds
const RATE_MAX = 20;          // max 20 messages per 10s per IP

function getIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
}

function isRateLimited(ip) {
  const now = Date.now();
  if (!rateLimits[ip] || now > rateLimits[ip].resetAt) {
    rateLimits[ip] = { count: 1, resetAt: now + RATE_WINDOW_MS };
    return false;
  }
  rateLimits[ip].count++;
  return rateLimits[ip].count > RATE_MAX;
}

// Clean up stale rooms every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of Object.entries(rooms)) {
    if (now - room.createdAt > 12 * 60 * 60 * 1000) { // 12 hour max room age
      Object.values(room.viewers).forEach(vws => send(vws, { type: 'room-expired' }));
      delete rooms[id];
      log(`Room ${id} expired`);
    }
  }
  // Clean stale rate limit entries
  for (const ip of Object.keys(rateLimits)) {
    if (now > rateLimits[ip].resetAt) delete rateLimits[ip];
  }
}, 5 * 60 * 1000);

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }
function send(ws, obj) { if (ws?.readyState === 1) ws.send(JSON.stringify(obj)); }

wss.on('connection', (ws, req) => {
  ws._room = null;
  ws._role = null;
  ws._vid = null;
  ws._ip = getIP(req);

  ws.on('message', (raw) => {
    // Rate limit
    if (isRateLimited(ws._ip)) {
      send(ws, { type: 'error', message: 'rate-limited' });
      return;
    }

    // Size limit — no message should be more than 64KB
    if (raw.length > 65536) return;

    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const { type, room, role, viewerId } = msg;

    // Validate room ID format (6 uppercase alphanumeric chars)
    if (room && !/^[A-Z0-9]{6}$/.test(room)) {
      send(ws, { type: 'error', message: 'invalid-room-id' });
      return;
    }

    // ── JOIN ──
    if (type === 'join') {
      ws._room = room;
      ws._role = role;
      ws._vid = viewerId || null;

      if (!rooms[room]) rooms[room] = { sender: null, viewers: {}, createdAt: Date.now() };

      if (role === 'sender') {
        // Only one sender per room
        if (rooms[room].sender?.readyState === 1) {
          send(ws, { type: 'error', message: 'room-taken' });
          return;
        }
        rooms[room].sender = ws;
        log(`Sender joined room ${room} from ${ws._ip}`);

        // Tell waiting viewers sender is ready
        Object.entries(rooms[room].viewers).forEach(([vid]) => {
          send(rooms[room].sender, { type: 'viewer-join', viewerId: vid });
        });
      }

      if (role === 'viewer') {
        if (!viewerId || !/^[A-Z0-9]{6,12}$/.test(viewerId)) {
          send(ws, { type: 'error', message: 'invalid-viewer-id' });
          return;
        }
        rooms[room].viewers[viewerId] = ws;
        log(`Viewer ${viewerId} joined room ${room} from ${ws._ip}`);

        const sw = rooms[room]?.sender;
        if (sw?.readyState === 1) {
          // Tell sender a viewer joined — server passes NO pin info
          // PIN auth is handled entirely client-side via encrypted SDP
          send(sw, { type: 'viewer-join', viewerId });
        } else {
          send(ws, { type: 'no-sender' });
        }
      }
    }

    // ── OFFER (sender → viewer) ──
    // The SDP offer is optionally encrypted by sender with PIN before sending here
    // Server is completely opaque to PIN — it just relays
    if (type === 'offer') {
      if (ws._role !== 'sender') return; // only sender can send offers
      const vws = rooms[room]?.viewers[msg.viewerId];
      if (vws) send(vws, { type: 'offer', sdp: msg.sdp, viewerId: msg.viewerId, encrypted: msg.encrypted || false });
    }

    // ── ANSWER (viewer → sender) ──
    if (type === 'answer') {
      if (ws._role !== 'viewer') return;
      const sw = rooms[room]?.sender;
      send(sw, { type: 'answer', sdp: msg.sdp, viewerId: msg.viewerId });
    }

    // ── ICE ──
    if (type === 'ice') {
      if (msg.to === 'viewer') {
        if (ws._role !== 'sender') return;
        const vws = rooms[room]?.viewers[msg.viewerId];
        send(vws, { type: 'ice', candidate: msg.candidate });
      } else {
        if (ws._role !== 'viewer') return;
        send(rooms[room]?.sender, { type: 'ice', candidate: msg.candidate, viewerId: msg.viewerId });
      }
    }

    // ── PIN REJECT (sender → viewer) — server doesn't know why, just relays ──
    if (type === 'pin-reject') {
      if (ws._role !== 'sender') return;
      const vws = rooms[room]?.viewers[msg.viewerId];
      send(vws, { type: 'pin-reject' });
    }
  });

  ws.on('close', () => {
    const { _room, _role, _vid } = ws;
    if (!_room || !rooms[_room]) return;

    if (_role === 'sender') {
      rooms[_room].sender = null;
      Object.values(rooms[_room].viewers).forEach(vws => send(vws, { type: 'sender-left' }));
      log(`Sender left ${_room}`);
    }
    if (_role === 'viewer' && _vid) {
      delete rooms[_room].viewers[_vid];
      log(`Viewer ${_vid} left ${_room}`);
    }

    // Clean up empty rooms
    if (!rooms[_room]?.sender && Object.keys(rooms[_room]?.viewers || {}).length === 0) {
      delete rooms[_room];
      log(`Room ${_room} cleaned up`);
    }
  });

  ws.on('error', () => {});
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => log(`LiveCam secure signal server on :${PORT}`));
