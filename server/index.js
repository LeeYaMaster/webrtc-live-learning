/**
 * 研播 Live Lab — 信令服务器
 *
 * 职责很单一：转发房间事件、SDP（offer/answer）、ICE candidate，以及聊天。
 * 它不碰音视频本身——媒体数据走浏览器之间的 RTCPeerConnection（P2P）。
 */
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true },
});

app.use(express.static(path.join(__dirname, '../public')));

/**
 * rooms: roomId -> {
 *   hostId: string,
 *   viewers: Set<socketId>,
 *   isLive: boolean,
 *   nicknames: Map<socketId, string>,
 * }
 */
const rooms = new Map();

const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateRoomCode() {
  let code;
  do {
    code = Array.from({ length: 6 }, () => ROOM_CHARS[Math.floor(Math.random() * ROOM_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function sanitizeName(raw, fallback) {
  const name = String(raw || '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim()
    .slice(0, 16);
  return name || fallback;
}

function nicknameMap(room, ids) {
  const out = {};
  for (const id of ids) out[id] = room.nicknames.get(id) || '观众';
  return out;
}

function getRoom(socket) {
  const roomId = socket.data.roomId;
  if (!roomId) return null;
  const room = rooms.get(roomId);
  return room ? { roomId, room } : null;
}

io.on('connection', (socket) => {
  socket.data.roomId = null;
  socket.data.role = null;
  socket.data.nickname = null;

  socket.on('create-room', (payload, cb) => {
    if (socket.data.roomId) {
      cb?.({ ok: false, error: '已经在房间里了，请先离开再创建。' });
      return;
    }
    const roomId = generateRoomCode();
    const nickname = sanitizeName(payload?.nickname, '主播');
    rooms.set(roomId, {
      hostId: socket.id,
      viewers: new Set(),
      isLive: false,
      nicknames: new Map([[socket.id, nickname]]),
    });
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.role = 'host';
    socket.data.nickname = nickname;
    cb?.({ ok: true, roomId, role: 'host', selfId: socket.id, nickname });
  });

  socket.on('join-room', (payload, cb) => {
    if (socket.data.roomId) {
      cb?.({ ok: false, error: '已经在房间里了。' });
      return;
    }
    const roomId = String(payload?.roomId || '')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 6);
    const room = rooms.get(roomId);
    if (!room) {
      cb?.({ ok: false, error: '房间不存在，请确认房间号。' });
      return;
    }
    if (!room.hostId) {
      cb?.({ ok: false, error: '主播已离开，房间已关闭。' });
      return;
    }

    const nickname = sanitizeName(payload?.nickname, `观众${room.viewers.size + 1}`);
    room.viewers.add(socket.id);
    room.nicknames.set(socket.id, nickname);
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.role = 'viewer';
    socket.data.nickname = nickname;

    // 通知主播（以及房间内其他人）：有新观众进来。
    // 若此时已经在直播，主播端会为这位观众新建一条 RTCPeerConnection 并发送 offer。
    socket.to(roomId).emit('viewer-joined', {
      viewerId: socket.id,
      nickname,
      viewerCount: room.viewers.size,
      isLive: room.isLive,
      hostId: room.hostId,
    });

    cb?.({
      ok: true,
      roomId,
      role: 'viewer',
      selfId: socket.id,
      hostId: room.hostId,
      hostNickname: room.nicknames.get(room.hostId) || '主播',
      isLive: room.isLive,
      viewerCount: room.viewers.size,
      nickname,
    });
  });

  socket.on('start-live', (_payload, cb) => {
    const ctx = getRoom(socket);
    if (!ctx || socket.data.role !== 'host') {
      cb?.({ ok: false, error: '只有主播可以开播。' });
      return;
    }
    ctx.room.isLive = true;
    const viewerIds = [...ctx.room.viewers];
    // 告诉观众：主播开始直播了，准备接收 offer。
    socket.to(ctx.roomId).emit('live-started', { hostId: socket.id });
    // 把当前观众列表回给主播，主播要为每一位创建 PeerConnection。
    cb?.({
      ok: true,
      viewerIds,
      nicknames: nicknameMap(ctx.room, viewerIds),
    });
  });

  socket.on('stop-live', (_payload, cb) => {
    const ctx = getRoom(socket);
    if (!ctx || socket.data.role !== 'host') {
      cb?.({ ok: false, error: '只有主播可以关播。' });
      return;
    }
    ctx.room.isLive = false;
    socket.to(ctx.roomId).emit('live-stopped', { hostId: socket.id });
    cb?.({ ok: true });
  });

  // —— WebRTC 信令中继：服务器只转发，不修改 SDP / ICE ——
  socket.on('offer', (payload) => {
    relaySignal(socket, 'offer', payload);
  });

  socket.on('answer', (payload) => {
    relaySignal(socket, 'answer', payload);
  });

  socket.on('ice-candidate', (payload) => {
    relaySignal(socket, 'ice-candidate', payload);
  });

  socket.on('chat', (payload) => {
    const ctx = getRoom(socket);
    if (!ctx) return;
    const text = String(payload?.text || '').trim().slice(0, 200);
    if (!text) return;
    io.to(ctx.roomId).emit('chat', {
      from: socket.id,
      nickname: socket.data.nickname,
      role: socket.data.role,
      text,
      ts: Date.now(),
    });
  });

  socket.on('disconnect', () => {
    const ctx = getRoom(socket);
    if (!ctx) return;
    const { roomId, room } = ctx;

    if (socket.data.role === 'host' && room.hostId === socket.id) {
      // 主播离开：关闭房间。无持久化，刷新页面即失效。
      socket.to(roomId).emit('host-left');
      rooms.delete(roomId);
      return;
    }

    if (room.viewers.has(socket.id)) {
      room.viewers.delete(socket.id);
      room.nicknames.delete(socket.id);
      socket.to(roomId).emit('viewer-left', {
        viewerId: socket.id,
        viewerCount: room.viewers.size,
      });
    }
  });
});

/**
 * 把 offer / answer / ice-candidate 转发给目标 socket。
 * 校验双方是否在同一个房间，避免把信令发到房间外。
 */
function relaySignal(socket, event, payload) {
  const ctx = getRoom(socket);
  if (!ctx) return;
  const to = payload?.to;
  if (!to || typeof to !== 'string') return;

  const target = io.sockets.sockets.get(to);
  if (!target || target.data.roomId !== ctx.roomId) return;

  const body = { from: socket.id, fromNickname: socket.data.nickname };
  if (event === 'ice-candidate') {
    body.candidate = payload.candidate ?? null;
  } else {
    body.sdp = payload.sdp;
  }
  target.emit(event, body);
}

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  研播 Live Lab 已启动');
  console.log(`  本机访问:  http://localhost:${PORT}`);
  console.log(`  监听地址:  http://${HOST}:${PORT}`);
  console.log('  提示: 非 localhost 访问需要 HTTPS，浏览器才会允许摄像头。');
  console.log('');
});
