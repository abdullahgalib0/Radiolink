const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT || 10000);
const CONFIG_PATH = path.join(__dirname, 'app-config.json');
const WebSocketServer = WebSocket.WebSocketServer || WebSocket.Server;

const MAX_CHANNEL_ID = 25000; // 1..999 + 11000..19999 (BD Postal Channels)
const MAX_BACKPRESSURE_BYTES = 64 * 1024;

let cachedConfigRaw = null;
let cachedConfigMinVer = 1;
let lastConfigReadMs = 0;

function readAppConfigCached() {
  const now = Date.now();
  if (now - lastConfigReadMs < 3000) {
    return { raw: cachedConfigRaw, minVer: cachedConfigMinVer };
  }
  lastConfigReadMs = now;
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    cachedConfigRaw = raw;
    const parsed = JSON.parse(raw);
    const v = Number(parsed.min_version_code || 1);
    cachedConfigMinVer = Number.isFinite(v) && v >= 1 ? v : 1;
  } catch {
    cachedConfigRaw = null;
    cachedConfigMinVer = 1;
  }
  return { raw: cachedConfigRaw, minVer: cachedConfigMinVer };
}

function getMinVersionCode() {
  const envMin = Number(process.env.MIN_APP_VERSION || 0);
  const { minVer } = readAppConfigCached();
  return Math.max(1, Number.isFinite(envMin) ? envMin : 0, minVer);
}

function isValidChannel(ch) {
  return Number.isInteger(ch) && ch >= 1 && ch <= MAX_CHANNEL_ID;
}

// চ্যানেল অনুযায়ী আলাদা রুম ম্যাপ (দ্রুত O(room_peers) ব্রডকাস্টের জন্য)
const channelRooms = new Map();

function addClientToChannel(ws, ch) {
  let room = channelRooms.get(ch);
  if (!room) {
    room = new Set();
    channelRooms.set(ch, room);
  }
  room.add(ws);
  ws.channelId = ch;
}

function removeClientFromChannel(ws) {
  const ch = ws.channelId;
  if (!ch) return null;
  const room = channelRooms.get(ch);
  if (room) {
    room.delete(ws);
    if (room.size === 0) {
      channelRooms.delete(ch);
    }
  }
  return ch;
}

function broadcastPeerCount(channelId) {
  const room = channelRooms.get(channelId);
  if (!room || room.size === 0) return;

  let openCount = 0;
  for (const client of room) {
    if (client.readyState === WebSocket.OPEN) openCount++;
  }
  if (openCount === 0) return;

  const payload = JSON.stringify({
    type: 'peers',
    channel: channelId,
    count: Math.max(1, openCount)
  });

  for (const client of room) {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(payload);
      } catch {}
    }
  }
}

const server = http.createServer((req, res) => {
  const reqPath = (req.url || '/').split('?')[0];

  if (reqPath === '/app-config.json') {
    const { raw } = readAppConfigCached();
    if (!raw) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: 'app-config.json not found' }));
    }
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    return res.end(raw);
  }

  if (reqPath === '/' || reqPath === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(
      JSON.stringify({
        status: 'ok',
        service: 'RadioLink Relay Server',
        min_version_code: getMinVersionCode(),
        connected_clients: wss.clients.size,
        active_channels: channelRooms.size
      })
    );
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

const wss = new WebSocketServer({
  server,
  perMessageDeflate: false, // রিয়েল-টাইম অডিওতে জিরো কম্প্রেশন ল্যাটেন্সি
  maxPayload: 64 * 1024
});

function rejectOutdatedClient(ws, minVersion) {
  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(
        JSON.stringify({
          type: 'upgrade_required',
          min_version_code: minVersion
        })
      );
    } catch {}
  }
  setTimeout(() => {
    try {
      ws.close(4002, 'UPGRADE_REQUIRED');
    } catch {}
  }, 120);
}

wss.on('connection', (ws, req) => {
  // TCP Nagle অ্যালগরিদম বন্ধ করে তাৎক্ষণিক ২০ms ভয়েজ প্যাকেট পাঠানো
  try {
    req.socket?.setNoDelay(true);
  } catch {}

  let channelId = 1;
  let clientVersion = 0;

  try {
    const parsedUrl = new URL(req.url || '/', 'https://localhost');
    const ch = Number(parsedUrl.searchParams.get('ch') || 1);
    if (isValidChannel(ch)) {
      channelId = ch;
    }
    const queryVer = Number(parsedUrl.searchParams.get('v') || 0);
    const headerVer = Number(req.headers['x-radiolink-version'] || 0);
    clientVersion = Math.max(
      Number.isFinite(queryVer) ? queryVer : 0,
      Number.isFinite(headerVer) ? headerVer : 0
    );
  } catch {}

  const minVersion = getMinVersionCode();
  if (minVersion > 1 && clientVersion < minVersion) {
    rejectOutdatedClient(ws, minVersion);
    return;
  }

  ws.isAlive = true;
  ws.clientVersion = clientVersion;
  addClientToChannel(ws, channelId);

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  broadcastPeerCount(ws.channelId);

  ws.on('message', (data, isBinary) => {
    const binaryFrame = typeof isBinary === 'boolean' ? isBinary : Buffer.isBuffer(data);

    if (!binaryFrame) {
      try {
        const msg = JSON.parse(data.toString('utf8'));
        if (msg && msg.type === 'switch') {
          const msgVer = Number(msg.version || 0);
          if (Number.isFinite(msgVer) && msgVer > 0) {
            ws.clientVersion = msgVer;
          }
          const currentMin = getMinVersionCode();
          if (currentMin > 1 && ws.clientVersion < currentMin) {
            rejectOutdatedClient(ws, currentMin);
            return;
          }
          const nextChannel = Number(msg.channel);
          if (isValidChannel(nextChannel) && nextChannel !== ws.channelId) {
            const prevChannel = removeClientFromChannel(ws);
            addClientToChannel(ws, nextChannel);
            if (prevChannel) broadcastPeerCount(prevChannel);
            broadcastPeerCount(nextChannel);
          }
        }
      } catch {}
      return;
    }

    // বাইনারি ভয়েজ ও কন্ট্রোল প্যাকেট শুধু একই চ্যানেলের অ্যাক্টিভ ইউজারদের কাছে পাঠানো
    const room = channelRooms.get(ws.channelId);
    if (!room) return;

    for (const client of room) {
      if (
        client !== ws &&
        client.readyState === WebSocket.OPEN &&
        client.bufferedAmount < MAX_BACKPRESSURE_BYTES
      ) {
        try {
          client.send(data, { binary: true });
        } catch {}
      }
    }
  });

  const handleDisconnect = () => {
    const prevCh = removeClientFromChannel(ws);
    if (prevCh) broadcastPeerCount(prevCh);
  };

  ws.on('close', handleDisconnect);
  ws.on('error', handleDisconnect);
});

const heartbeatTimer = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      const prevCh = removeClientFromChannel(ws);
      try {
        ws.terminate();
      } catch {}
      if (prevCh) broadcastPeerCount(prevCh);
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {}
  }
}, 25000);

wss.on('close', () => {
  clearInterval(heartbeatTimer);
});

server.listen(PORT, () => {
  console.log(`RadioLink Relay Server listening on port ${PORT}`);
});
