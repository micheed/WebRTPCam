const WebSocket = require('ws');
const http = require('http');

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('LiveCam Signal OK');
});

const wss = new WebSocket.Server({ server });

// rooms[roomId] = { sender: ws, viewers: { viewerId: ws } }
const rooms = {};

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }
function send(ws, obj) { if (ws?.readyState === 1) ws.send(JSON.stringify(obj)); }

wss.on('connection', (ws) => {
  ws._room = null; ws._role = null; ws._vid = null;

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const { type, room, role, viewerId } = msg;

    if (type === 'join') {
      ws._room = room; ws._role = role; ws._vid = viewerId || null;
      if (!rooms[room]) rooms[room] = { sender: null, viewers: {} };

      if (role === 'sender') {
        rooms[room].sender = ws;
        log(`Sender → room ${room}`);
        // Notify waiting viewers
        Object.entries(rooms[room].viewers).forEach(([vid, vws]) => {
          send(rooms[room].sender, { type: 'viewer-join', viewerId: vid });
        });
      }

      if (role === 'viewer') {
        rooms[room].viewers[viewerId] = ws;
        log(`Viewer ${viewerId} → room ${room}`);
        const sw = rooms[room]?.sender;
        if (sw?.readyState === 1) send(sw, { type: 'viewer-join', viewerId });
        else send(ws, { type: 'no-sender' });
      }
    }

    if (type === 'offer') {
      const vws = rooms[room]?.viewers[msg.viewerId];
      send(vws, { type: 'offer', sdp: msg.sdp, viewerId: msg.viewerId });
    }

    if (type === 'answer') {
      const sw = rooms[room]?.sender;
      send(sw, { type: 'answer', sdp: msg.sdp, viewerId: msg.viewerId });
    }

    if (type === 'ice') {
      if (msg.to === 'sender') {
        send(rooms[room]?.sender, { type: 'ice', candidate: msg.candidate, viewerId: msg.viewerId });
      } else {
        const vws = rooms[room]?.viewers[msg.viewerId];
        send(vws, { type: 'ice', candidate: msg.candidate });
      }
    }

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
    }
  });

  ws.on('error', () => {});
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => log(`Signaling server on :${PORT}`));
