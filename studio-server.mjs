/**
 * PAN Gamelan Studio — Local & Tunnel Dev Server (Zero Dependencies)
 * Serves static studio files and provides a Same-Origin SSE + POST room relay
 * so devices on the same mobile hotspot or Cloudflare tunnel can jam together
 * without WebRTC ICE/CGNAT hairpinning failures.
 *
 * Usage: node studio-server.mjs [port]
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT_DIR = path.dirname(__filename);
const PORT = Number(process.env.PORT || process.argv[2] || 8080);
const MAX_BODY_BYTES = 128 * 1024;
const HEARTBEAT_MS = 15000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.pga': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.woff2': 'font/woff2'
};

/** @type {Map<string, { code: string, hostId: string, hostRes: http.ServerResponse, hostHeartbeat: NodeJS.Timeout, guests: Map<string, { res: http.ServerResponse, heartbeat: NodeJS.Timeout }> }>} */
const rooms = new Map();

function normalizeCode(raw) {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '');
}

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function sendSse(res, event, data) {
  if (!res || res.writableEnded) return false;
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch (_) {
    return false;
  }
}

function startHeartbeat(res) {
  return setInterval(() => {
    if (!res.writableEnded) {
      try {
        res.write(': ping\n\n');
      } catch (_) {}
    }
  }, HEARTBEAT_MS);
}

function resolveRoomForGuest(requestedCode) {
  const clean = normalizeCode(requestedCode);
  if (!clean) return null;
  if (rooms.has(clean)) return rooms.get(clean);
  if (/^\d{4}$/.test(clean)) {
    const prefixed = `PAN-${clean}`;
    if (rooms.has(prefixed)) return rooms.get(prefixed);
  }
  return null;
}

function handleRoomEvents(req, res, url) {
  const roomParam = normalizeCode(url.searchParams.get('room'));
  const peerId = String(url.searchParams.get('peerId') || '').trim();
  const role = url.searchParams.get('role') === 'host' ? 'host' : 'guest';

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  req.socket?.setNoDelay?.(true);

  if (!roomParam || !peerId) {
    sendSse(res, 'room-error', {
      type: 'invalid-request',
      message: 'Parameter room dan peerId wajib diisi.'
    });
    res.end();
    return;
  }

  if (role === 'host') {
    const existing = rooms.get(roomParam);
    if (existing && existing.hostId !== peerId && !existing.hostRes.writableEnded) {
      sendSse(res, 'room-error', {
        type: 'unavailable-id',
        message: `Kode ${roomParam} sudah dipakai. Coba kode lain.`
      });
      res.end();
      return;
    }

    const guests = existing ? existing.guests : new Map();
    if (existing?.hostHeartbeat) clearInterval(existing.hostHeartbeat);

    const hostHeartbeat = startHeartbeat(res);
    const roomObj = { code: roomParam, hostId: peerId, hostRes: res, hostHeartbeat, guests };
    rooms.set(roomParam, roomObj);

    sendSse(res, 'ready', { room: roomParam, peerId, role: 'host' });

    // Re-announce any active guests if Host SSE reconnected quickly
    for (const guestId of guests.keys()) {
      sendSse(res, 'peer-open', { peerId: guestId });
    }

    req.on('close', () => {
      clearInterval(hostHeartbeat);
      const current = rooms.get(roomParam);
      if (!current || current.hostRes !== res) return;
      rooms.delete(roomParam);
      for (const guestEntry of current.guests.values()) {
        clearInterval(guestEntry.heartbeat);
        sendSse(guestEntry.res, 'room-closed', {
          message: 'Host menutup room atau keluar.'
        });
        try {
          guestEntry.res.end();
        } catch (_) {}
      }
      current.guests.clear();
    });
    return;
  }

  // Guest flow
  const roomObj = resolveRoomForGuest(roomParam);
  if (!roomObj || roomObj.hostRes.writableEnded) {
    sendSse(res, 'room-error', {
      type: 'peer-unavailable',
      message: `Room ${roomParam} tidak ditemukan atau Host belum aktif.`
    });
    res.end();
    return;
  }

  const prevGuest = roomObj.guests.get(peerId);
  if (prevGuest?.heartbeat) clearInterval(prevGuest.heartbeat);

  const heartbeat = startHeartbeat(res);
  roomObj.guests.set(peerId, { res, heartbeat });

  sendSse(res, 'ready', {
    room: roomObj.code,
    hostId: roomObj.hostId,
    peerId,
    role: 'guest'
  });
  sendSse(roomObj.hostRes, 'peer-open', { peerId });

  req.on('close', () => {
    clearInterval(heartbeat);
    const entry = roomObj.guests.get(peerId);
    if (!entry || entry.res !== res) return;
    roomObj.guests.delete(peerId);
    sendSse(roomObj.hostRes, 'peer-close', { peerId });
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

async function handleRoomSend(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (_) {
    sendJson(res, 400, { ok: false, error: 'Invalid JSON body' });
    return;
  }

  const code = normalizeCode(body?.room);
  const from = String(body?.from || '').trim();
  const to = String(body?.to || '').trim();
  const payload = body?.payload;

  const roomObj = rooms.get(code);
  if (!roomObj) {
    sendJson(res, 404, { ok: false, error: 'Room not found' });
    return;
  }

  const senderIsValid = from === roomObj.hostId || roomObj.guests.has(from);
  if (!senderIsValid) {
    sendJson(res, 403, { ok: false, error: 'Sender not in room' });
    return;
  }

  if (to === roomObj.hostId) {
    sendSse(roomObj.hostRes, 'msg', { from, payload });
  } else {
    const guest = roomObj.guests.get(to);
    if (guest) {
      sendSse(guest.res, 'msg', { from, payload });
    }
  }

  res.writeHead(204);
  res.end();
}

function serveStaticFile(req, res, url) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(url.pathname);
  } catch (_) {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }

  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const resolved = path.resolve(ROOT_DIR, rel);

  if (resolved !== ROOT_DIR && !resolved.startsWith(ROOT_DIR + path.sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(resolved, (err, stat) => {
    if (err || !stat) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const filePath = stat.isDirectory() ? path.join(resolved, 'index.html') : resolved;
    fs.stat(filePath, (err2, stat2) => {
      if (err2 || !stat2 || stat2.isDirectory()) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Content-Length': stat2.size,
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600'
      });

      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      fs.createReadStream(filePath).pipe(res);
    });
  });
}

export function createStudioServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/api/studio-health') {
      sendJson(res, 200, { ok: true, relay: 'sse' });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/studio-room/events') {
      handleRoomEvents(req, res, url);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/studio-room/send') {
      handleRoomSend(req, res);
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      serveStaticFile(req, res, url);
      return;
    }

    res.writeHead(405);
    res.end('Method Not Allowed');
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const server = createStudioServer();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`PAN Gamelan Studio server listening on http://0.0.0.0:${PORT}`);
  });
}
