'use strict';

const express = require('express');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '32kb' }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['polling', 'websocket'],
  pingInterval: 25000,
  pingTimeout: 60000,
  maxHttpBufferSize: 1e6
});

const PORT = Number(process.env.PORT) || 10000;
const rooms = new Map();
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function cleanText(value, max) {
  return String(value == null ? '' : value).replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, max);
}
function makeCode() {
  for (let attempt = 0; attempt < 100; attempt++) {
    let code = '';
    const bytes = crypto.randomBytes(5);
    for (const byte of bytes) code += ALPHABET[byte % ALPHABET.length];
    if (!rooms.has(code)) return code;
  }
  throw new Error('Could not allocate a lobby code');
}
function passwordDigest(password, salt) {
  return crypto.scryptSync(String(password), salt, 32);
}
function checkPassword(room, password) {
  if (room.visibility !== 'private') return true;
  const actual = passwordDigest(password || '', room.passwordSalt);
  return actual.length === room.passwordHash.length && crypto.timingSafeEqual(actual, room.passwordHash);
}
function publicRoom(room) {
  return {
    code: room.code,
    name: room.name,
    players: room.members.size,
    max: room.max,
    locked: room.visibility === 'private',
    visibility: room.visibility,
    started: room.started,
    createdAt: room.createdAt
  };
}
function listRooms() {
  return [...rooms.values()]
    .filter(room => !room.started && room.members.size < room.max)
    .map(publicRoom)
    .sort((a, b) => a.createdAt - b.createdAt);
}
function announceRoomList() {
  io.emit('lobby:list-changed');
}
function leaveRoom(socket, reason) {
  const code = socket.data.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  socket.data.roomCode = null;
  socket.data.isRoomHost = false;
  if (!room) return;

  if (room.hostId === socket.id) {
    rooms.delete(code);
    for (const memberId of room.members) {
      if (memberId !== socket.id) {
        io.to(memberId).emit('lobby:closed', { reason: reason || 'Создатель закрыл лобби' });
        const memberSocket = io.sockets.sockets.get(memberId);
        if (memberSocket) {
          memberSocket.data.roomCode = null;
          memberSocket.data.isRoomHost = false;
          memberSocket.leave(`room:${code}`);
        }
      }
    }
    room.members.clear();
    socket.leave(`room:${code}`);
    announceRoomList();
    return;
  }

  room.members.delete(socket.id);
  socket.leave(`room:${code}`);
  io.to(room.hostId).emit('lobby:player-left', { id: socket.id });
  announceRoomList();
}

app.get('/', (_req, res) => {
  res.json({ service: 'Platy Dom Socket.IO Game Server', status: 'ok', transport: 'socket.io' });
});
app.get('/test', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'test.html'));
});
app.get('/health', (_req, res) => {
  res.status(200).json({
    ok: true,
    transport: 'socket.io',
    rooms: rooms.size,
    connectedClients: io.engine.clientsCount
  });
});
app.get('/api/lobbies', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, rooms: listRooms() });
});

io.on('connection', socket => {
  socket.data.roomCode = null;
  socket.data.isRoomHost = false;
  console.log('[socket] connected', socket.id, socket.conn.transport.name);

  socket.on('test:echo', (payload, ack) => {
    if (typeof ack === 'function') ack({ ok: true, echo: cleanText(payload && payload.text, 120), socketId: socket.id, transport: socket.conn.transport.name, serverTime: new Date().toISOString() });
  });

  socket.on('lobby:list', (_payload, ack) => {
    if (typeof ack === 'function') ack({ ok: true, rooms: listRooms() });
  });

  socket.on('lobby:create', (payload, ack) => {
    try {
      if (socket.data.roomCode) leaveRoom(socket, 'Создано новое лобби');
      const data = payload || {};
      const name = cleanText(data.name, 24) || 'Новый дом';
      const max = Math.max(2, Math.min(10, Math.floor(Number(data.max) || 6)));
      const visibility = data.visibility === 'private' ? 'private' : 'public';
      const password = String(data.password || '');
      if (visibility === 'private' && password.trim().length < 4) {
        if (typeof ack === 'function') ack({ ok: false, error: 'Пароль закрытого лобби должен содержать минимум 4 символа' });
        return;
      }
      const code = makeCode();
      const salt = crypto.randomBytes(16);
      const room = {
        code, name, max, visibility,
        passwordSalt: salt,
        passwordHash: visibility === 'private' ? passwordDigest(password, salt) : Buffer.alloc(0),
        hostId: socket.id,
        members: new Set([socket.id]),
        started: false,
        createdAt: Date.now()
      };
      rooms.set(code, room);
      socket.join(`room:${code}`);
      socket.data.roomCode = code;
      socket.data.isRoomHost = true;
      if (typeof ack === 'function') ack({ ok: true, id: socket.id, room: publicRoom(room) });
      announceRoomList();
      console.log('[lobby] created', code, visibility);
    } catch (error) {
      console.error('[lobby] create failed', error);
      if (typeof ack === 'function') ack({ ok: false, error: 'Не удалось создать лобби на сервере' });
    }
  });

  socket.on('lobby:join', (payload, ack) => {
    const data = payload || {};
    const code = cleanText(data.code, 8).toUpperCase();
    const room = rooms.get(code);
    const fail = error => { if (typeof ack === 'function') ack({ ok: false, error }); };
    if (!room) return fail('Лобби не найдено. Возможно, создатель уже вышел.');
    if (room.started) return fail('Игра уже началась — войти нельзя.');
    if (room.members.size >= room.max) return fail('Лобби заполнено.');
    if (!checkPassword(room, data.password || '')) return fail('Неверный пароль от закрытого лобби.');
    if (socket.data.roomCode) leaveRoom(socket, 'Игрок перешёл в другое лобби');

    room.members.add(socket.id);
    socket.join(`room:${code}`);
    socket.data.roomCode = code;
    socket.data.isRoomHost = false;
    if (typeof ack === 'function') ack({ ok: true, id: socket.id, room: publicRoom(room) });

    const hello = {
      t: 'hello',
      name: cleanText(data.name || 'Игрок', 14) || 'Игрок',
      look: data.look || {},
      pass: String(data.password || '')
    };
    setImmediate(() => io.to(room.hostId).emit('game:member-message', { id: socket.id, m: hello }));
    announceRoomList();
  });

  socket.on('lobby:update', payload => {
    const code = socket.data.roomCode;
    const room = code && rooms.get(code);
    if (!room || room.hostId !== socket.id) return;
    const data = payload || {};
    room.name = cleanText(data.name || room.name, 24) || room.name;
    room.started = !!data.started;
    announceRoomList();
  });

  socket.on('game:to-host', message => {
    const code = socket.data.roomCode;
    const room = code && rooms.get(code);
    if (!room || room.hostId === socket.id || !room.members.has(socket.id)) return;
    io.to(room.hostId).emit('game:member-message', { id: socket.id, m: message });
  });

  socket.on('game:to-player', payload => {
    const code = socket.data.roomCode;
    const room = code && rooms.get(code);
    if (!room || room.hostId !== socket.id) return;
    const target = payload && String(payload.id || '');
    if (!room.members.has(target) || target === socket.id) return;
    io.to(target).emit('game:host-message', payload.message);
  });

  socket.on('game:kick-player', payload => {
    const code = socket.data.roomCode;
    const room = code && rooms.get(code);
    if (!room || room.hostId !== socket.id) return;
    const target = payload && String(payload.id || '');
    if (!room.members.has(target) || target === socket.id) return;
    io.to(target).emit('game:kicked', { reason: 'Хост отключил вас от лобби' });
    const targetSocket = io.sockets.sockets.get(target);
    if (targetSocket) targetSocket.disconnect(true);
  });

  socket.on('voice:signal', payload => {
    const code = socket.data.roomCode;
    const room = code && rooms.get(code);
    if (!room || !room.members.has(socket.id)) return;
    const target = payload && String(payload.to || '');
    const data = payload && payload.data;
    if (!room.members.has(target) || target === socket.id || !data || typeof data !== 'object') return;
    io.to(target).emit('voice:signal', { from: socket.id, data });
  });

  socket.on('lobby:leave', (_payload, ack) => {
    leaveRoom(socket, 'Игрок покинул лобби');
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('disconnect', reason => {
    console.log('[socket] disconnected', socket.id, reason);
    leaveRoom(socket, reason);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Platy Dom Socket.IO server listening on ${PORT}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
