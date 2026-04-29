const WebSocket = require('ws');
const http = require('http');

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('LiveCam Signal OK');
});

const wss = new WebSocket.Server({ server });

// rooms[roomId] = { sender: ws, pinHash: '', viewers: { viewerId: ws } }
const rooms = {};

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }
function send(ws, obj) { if (ws?.readyState === 1) ws.send(JSON.stringify(obj)); }

wss.on('connection', (ws) => {
  ws._room = null; ws._role = null; ws._vid = null;

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const { type, room, role, viewerId } = msg;

    // ── JOIN ──
    if (type === 'join') {
      ws._room = room; ws._role = role; ws._vid = viewerId || null;
      if (!rooms[room]) rooms[room] = { sender: null, pinHash: '', viewers: {} };

      if (role === 'sender') {
        rooms[room].sender = ws;
        rooms[room].pinHash = msg.pinHash || ''; // store sender's PIN hash
        log(`Sender joined room ${room} (PIN: ${rooms[room].pinHash ? 'YES' : 'NO'})`);
        // Notify any waiting viewers
        Object.entries(rooms[room].viewers).forEach(([vid, vws]) => {
          send(rooms[room].sender, { type: 'viewer-join', viewerId: vid, pinHash: vws._pinHash || '' });
        });
      }

      if (role === 'viewer') {
        ws._pinHash = msg.pinHash || '';
        rooms[room].viewers[viewerId] = ws;
        log(`Viewer ${viewerId} joining room ${room}`);
        const sw = rooms[room]?.sender;
        if (sw?.readyState === 1) {
          // Forward viewer join to sender WITH the viewer's pin hash for verification
          send(sw, { type: 'viewer-join', viewerId, pinHash: msg.pinHash || '' });
        } else {
          send(ws, { type: 'no-sender' });
        }
      }
    }

    // ── OFFER (sender → viewer) ──
    if (type === 'offer') {
      const vws = rooms[room]?.viewers[msg.viewerId];
      send(vws, { type: 'offer', sdp: msg.sdp, viewerId: msg.viewerId });
    }

    // ── ANSWER (viewer → sender) ──
    if (type === 'answer') {
      const sw = rooms[room]?.sender;
      send(sw, { type: 'answer', sdp: msg.sdp, viewerId: msg.viewerId });
    }

    // ── ICE candidates ──
    if (type === 'ice') {
      if (msg.to === 'viewer') {
        const vws = rooms[room]?.viewers[msg.viewerId];
        send(vws, { type: 'ice', candidate: msg.candidate });
      } else {
        // to sender
        send(rooms[room]?.sender, { type: 'ice', candidate: msg.candidate, viewerId: msg.viewerId });
      }
    }

    // ── PIN reject (sender → viewer) ──
    if (type === 'pin-reject') {
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
    if (!rooms[_room]?.sender && Object.keys(rooms[_room]?.viewers || {}).length === 0) {
      delete rooms[_room];
      log(`Room ${_room} cleaned up`);
    }
  });

  ws.on('error', () => {});
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => log(`LiveCam signal server on :${PORT}`));
