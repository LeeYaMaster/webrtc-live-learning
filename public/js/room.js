/**
 * 房间页：把信令、WebRTC、控件、聊天和学习面板串在一起。
 * 主播与观众共用这一份逻辑，用 role 分支。
 */
import { $, escapeHtml, qs, shortId } from './util.js';
import { createLogger } from './logger.js';
import { connectSignaling } from './signaling.js';
import { createPeer, getCameraStream, getScreenStream, stopStream } from './webrtc.js';
import { createDanmaku } from './danmaku.js';

const logger = createLogger();
const danmaku = createDanmaku($('danmaku-layer'));
const videoEl = $('live-video');
const stageNote = $('stage-note');
const toastEl = $('toast');

const state = {
  role: null,
  roomId: null,
  selfId: null,
  hostId: null,
  nickname: qs('name') || '',
  isLive: false,
  localStream: null,
  screenStream: null,
  cameraTrack: null,
  peers: new Map(),
  viewerCount: 0,
  nicknames: new Map(),
  muted: false,
  cameraOff: false,
  sharing: false,
  audioOnly: false,
  pendingIce: new Map(),
};

const signaling = connectSignaling({
  onLog: (entry) => logger.log(entry),
});

bindChrome();
boot();

async function boot() {
  const mode = qs('mode') || (qs('code') ? 'join' : '');
  const code = (qs('code') || '').toUpperCase();

  if (mode === 'create') {
    logger.setStage('正在创建房间…');
    signaling.emit('create-room', { nickname: state.nickname }, (res) => {
      if (!res?.ok) return failAndBack(res?.error || '创建房间失败');
      enterAsHost(res);
    });
    return;
  }

  if (mode === 'join' || code) {
    if (!code) return failAndBack('缺少房间号');
    logger.setStage('正在加入房间…');
    signaling.emit('join-room', { roomId: code, nickname: state.nickname }, (res) => {
      if (!res?.ok) return failAndBack(res?.error || '加入房间失败');
      enterAsViewer(res);
    });
    return;
  }

  failAndBack('请从首页创建或加入房间');
}

function enterAsHost(res) {
  state.role = 'host';
  state.roomId = res.roomId;
  state.selfId = res.selfId;
  state.nickname = res.nickname;
  history.replaceState({}, '', `./room.html?code=${res.roomId}&role=host`);
  renderShell();
  logger.setStage('房间已就绪。点击「开始直播」采集摄像头，再为在线观众逐个发起 Offer。');
  wireHostSignals();
}

function enterAsViewer(res) {
  state.role = 'viewer';
  state.roomId = res.roomId;
  state.selfId = res.selfId;
  state.hostId = res.hostId;
  state.nickname = res.nickname;
  state.isLive = !!res.isLive;
  state.viewerCount = res.viewerCount || 0;
  if (res.hostNickname) state.nicknames.set(res.hostId, res.hostNickname);
  history.replaceState({}, '', `./room.html?code=${res.roomId}`);
  renderShell();
  if (state.isLive) {
    logger.setStage('主播已在直播，等待收到 Offer，随后回复 Answer 并交换 ICE。');
    setStageNote('正在与主播建立连接…');
  } else {
    logger.setStage('已进入房间，等待主播开播。开播后你会收到 Offer。');
    setStageNote('主播尚未开播，稍候即可看到画面。');
  }
  wireViewerSignals();
}

function wireHostSignals() {
  signaling.on('viewer-joined', async (payload) => {
    state.viewerCount = payload.viewerCount ?? state.viewerCount + 1;
    state.nicknames.set(payload.viewerId, payload.nickname || '观众');
    updateCounts();
    if (state.isLive) {
      logger.setStage(`新观众「${payload.nickname || ''}」加入，正在为其创建 PeerConnection 并发送 Offer。`);
      await offerToViewer(payload.viewerId);
    }
  });

  signaling.on('viewer-left', (payload) => {
    state.viewerCount = payload.viewerCount ?? Math.max(0, state.viewerCount - 1);
    closePeer(payload.viewerId, '观众离开，关闭对应的 PeerConnection');
    updateCounts();
  });
}

function wireViewerSignals() {
  signaling.on('live-started', () => {
    state.isLive = true;
    renderLiveBadge();
    setStageNote('主播已开播，正在等待 Offer…');
    logger.setStage('主播已开播。接下来会收到 Offer，然后 createAnswer。');
  });

  signaling.on('live-stopped', () => {
    onStreamEnded('主播结束了直播');
  });

  signaling.on('host-left', () => {
    onStreamEnded('主播已离开，房间关闭');
    showToast('主播已离开，房间已关闭');
  });

  signaling.on('viewer-joined', (payload) => {
    state.viewerCount = payload.viewerCount ?? state.viewerCount;
    updateCounts();
  });

  signaling.on('viewer-left', (payload) => {
    state.viewerCount = payload.viewerCount ?? state.viewerCount;
    updateCounts();
  });

  signaling.on('offer', async (payload) => {
    await handleOffer(payload);
  });
}

// 主播收 Answer；双方都收 ICE 候选。监听只注册一次，避免日志重复。
signaling.on('answer', async (payload) => {
  if (state.role !== 'host') return;
  const peer = state.peers.get(payload.from);
  if (!peer) {
    logger.log({ level: 'warn', direction: 'in', label: '收到未知 Answer', detail: payload.from });
    return;
  }
  logger.setStage(`已收到「${nameOf(payload.from)}」的 Answer，调用 setRemoteDescription，随后继续交换 ICE。`);
  await peer.acceptAnswer(payload.sdp);
});

signaling.on('ice-candidate', async (payload) => {
  const peer = state.peers.get(payload.from);
  if (peer) {
    await peer.addIceCandidate(payload.candidate);
    return;
  }
  // Offer 处理完成前候选可能先到，先按来源排队。
  const list = state.pendingIce.get(payload.from) || [];
  list.push(payload.candidate);
  state.pendingIce.set(payload.from, list);
});

signaling.on('chat', (msg) => {
  pushChat(msg);
  danmaku.spawn(msg.text, msg.ts || 0);
});


async function startLive() {
  if (state.role !== 'host' || state.isLive) return;
  setBusy('btn-live', true);
  logger.setStage('正在申请摄像头和麦克风权限…');
  try {
    const { stream, audioOnly } = await getCameraStream();
    state.localStream = stream;
    state.audioOnly = audioOnly;
    state.cameraTrack = stream.getVideoTracks()[0] || null;
    attachPreview(stream, { mirror: !!state.cameraTrack && !state.sharing });
    if (audioOnly) {
      showToast('未找到摄像头，已改为仅音频开播');
      setStageNote('仅音频直播中');
    }
  } catch (err) {
    setBusy('btn-live', false);
    const hint = mediaErrorHint(err);
    logger.setStage(`采集失败：${hint}`);
    logger.log({ level: 'error', direction: 'in', label: 'getUserMedia 失败', detail: hint });
    showToast(hint);
    return;
  }

  signaling.emit('start-live', {}, async (res) => {
    setBusy('btn-live', false);
    if (!res?.ok) {
      showToast(res?.error || '开播失败');
      return;
    }
    state.isLive = true;
    renderLiveBadge();
    renderHostButtons();
    const ids = res.viewerIds || [];
    Object.entries(res.nicknames || {}).forEach(([id, name]) => state.nicknames.set(id, name));
    if (!ids.length) {
      logger.setStage('已经开播。目前还没有观众；有人加入时会自动为其创建 Offer。');
      setStageNote('直播中，等待观众加入');
      return;
    }
    logger.setStage(`已经开播，正在为 ${ids.length} 位在线观众分别创建 PeerConnection。`);
    for (const id of ids) {
      await offerToViewer(id);
    }
  });
}

async function stopLive() {
  if (state.role !== 'host') return;
  signaling.emit('stop-live', {});
  teardownMedia('已关播。本地轨道已停止，所有 PeerConnection 已关闭。');
  state.isLive = false;
  renderLiveBadge();
  renderHostButtons();
  setStageNote('已结束直播，可再次开播');
}

async function offerToViewer(viewerId) {
  closePeer(viewerId);
  const label = nameOf(viewerId);
  const peer = createPeer({
    remoteId: viewerId,
    label,
    onIceCandidate: (candidate) => {
      if (!candidate) {
        logger.log({ direction: 'out', label: 'ICE 收集结束', detail: label });
        return;
      }
      signaling.emit('ice-candidate', { to: viewerId, candidate });
    },
    onState: (info) => {
      logger.upsertPeerState(info);
      if (info.kind === 'connection' && info.value === 'connected') {
        logger.setStage(`与「${label}」的连接已建立，媒体开始走 P2P，不再经过信令服务器。`);
      }
      if (info.kind === 'connection' && (info.value === 'failed' || info.value === 'disconnected')) {
        logger.log({ level: 'warn', direction: 'in', label: '连接异常', detail: `${label} · ${info.value}` });
      }
    },
    onLocalSdp: (sdp) => logger.showSdp(sdp),
  });

  // 把当前正在播出的视频轨（摄像头或屏幕）和音频轨加到这条连接上。
  const outbound = outboundStream();
  if (outbound) peer.attachLocalStream(outbound);

  state.peers.set(viewerId, peer);
  await flushPendingIce(viewerId, peer);
  logger.upsertPeerState({ remoteId: viewerId, label, kind: 'signaling', value: peer.pc.signalingState });

  logger.setStage(`正在为「${label}」createOffer，并 setLocalDescription。`);
  const offer = await peer.createAndSendOffer();
  signaling.emit('offer', { to: viewerId, sdp: offer });
}

async function handleOffer(payload) {
  const from = payload.from;
  state.hostId = state.hostId || from;
  const existing = state.peers.get(from);
  // 重新协商（例如仅音频开播后再共享屏幕）时复用已有 PeerConnection。
  if (existing && existing.pc.signalingState !== 'closed') {
    await flushPendingIce(from, existing);
    logger.showSdp(payload.sdp);
    logger.setStage('收到新的 Offer（重新协商），在现有连接上 setRemoteDescription 并 createAnswer。');
    const answer = await existing.acceptOfferAndCreateAnswer(payload.sdp);
    signaling.emit('answer', { to: from, sdp: answer });
    return;
  }
  closePeer(from);
  const label = nameOf(from) || '主播';
  const peer = createPeer({
    remoteId: from,
    label,
    onIceCandidate: (candidate) => {
      if (!candidate) {
        logger.log({ direction: 'out', label: 'ICE 收集结束', detail: label });
        return;
      }
      signaling.emit('ice-candidate', { to: from, candidate });
    },
    onTrack: (ev) => {
      const stream = ev.streams?.[0] || new MediaStream([ev.track]);
      attachPreview(stream, { mirror: false });
      setStageNote('');
      logger.setStage('ontrack：已收到远程媒体轨道，画面/声音开始播放。');
    },
    onState: (info) => {
      logger.upsertPeerState(info);
      if (info.kind === 'connection' && info.value === 'connected') {
        logger.setStage('与主播的连接已建立（connectionState = connected）。');
      }
    },
    onLocalSdp: (sdp) => logger.showSdp(sdp),
  });
  state.peers.set(from, peer);
  await flushPendingIce(from, peer);
  logger.showSdp(payload.sdp);
  logger.setStage('已收到 Offer，正在 setRemoteDescription，然后 createAnswer。');
  const answer = await peer.acceptOfferAndCreateAnswer(payload.sdp);
  signaling.emit('answer', { to: from, sdp: answer });
  logger.setStage('Answer 已发送，等待双方 ICE 候选交换完成。');
}

function outboundStream() {
  if (state.sharing && state.screenStream) {
    const mix = new MediaStream();
    for (const t of state.screenStream.getVideoTracks()) mix.addTrack(t);
    if (state.localStream) {
      for (const t of state.localStream.getAudioTracks()) mix.addTrack(t);
    }
    return mix;
  }
  return state.localStream;
}

async function replaceOutboundVideo(track) {
  for (const [viewerId, peer] of state.peers) {
    const result = await peer.replaceVideoTrack(track || null);
    // 仅音频开播后再共享屏幕时，原来没有 video sender，需要补一轮 Offer/Answer。
    if (result?.renegotiate) {
      logger.setStage(`「${nameOf(viewerId)}」这条连接新增了视频轨，正在重新 createOffer 协商。`);
      const offer = await peer.createAndSendOffer();
      signaling.emit('offer', { to: viewerId, sdp: offer });
    }
  }
}

async function toggleScreenShare() {
  if (state.role !== 'host' || !state.isLive) return;
  if (state.sharing) {
    await stopScreenShare();
    return;
  }
  try {
    const stream = await getScreenStream();
    const screenTrack = stream.getVideoTracks()[0];
    if (!screenTrack) throw new Error('没有屏幕视频轨');
    state.screenStream = stream;
    state.sharing = true;
    await replaceOutboundVideo(screenTrack);
    attachPreview(outboundStream(), { mirror: false });
    renderHostButtons();
    setStageNote('正在共享屏幕（replaceTrack，无需重新协商）');
    logger.setStage('屏幕共享已开始：对每条连接调用 sender.replaceTrack，不必再走 Offer/Answer。');
    screenTrack.addEventListener('ended', () => {
      stopScreenShare();
    });
  } catch (err) {
    if (err?.name === 'NotAllowedError') {
      showToast('已取消屏幕共享，或浏览器未授予权限');
      return;
    }
    showToast(err?.message || '无法开始屏幕共享');
  }
}

async function stopScreenShare() {
  if (!state.sharing) return;
  stopStream(state.screenStream);
  state.screenStream = null;
  state.sharing = false;
  const cam = state.cameraOff ? null : state.cameraTrack;
  await replaceOutboundVideo(cam);
  if (state.localStream) attachPreview(state.localStream, { mirror: !!cam });
  renderHostButtons();
  setStageNote(state.isLive ? '直播中' : '');
  logger.setStage('已停止屏幕共享，视频轨切回摄像头。');
}

function toggleMute() {
  if (!state.localStream) return;
  state.muted = !state.muted;
  for (const track of state.localStream.getAudioTracks()) track.enabled = !state.muted;
  renderHostButtons();
  logger.log({
    direction: 'out',
    label: state.muted ? '已静音' : '已取消静音',
    detail: '只切换 track.enabled，不会破坏 PeerConnection',
  });
}

async function toggleCamera() {
  if (!state.localStream || state.audioOnly) return;
  state.cameraOff = !state.cameraOff;
  if (state.sharing) {
    // 共享屏幕时先记住摄像头开关，停止共享后再生效
    renderHostButtons();
    showToast(state.cameraOff ? '停止共享后将关闭摄像头' : '停止共享后将打开摄像头');
    return;
  }
  if (state.cameraTrack) state.cameraTrack.enabled = !state.cameraOff;
  renderHostButtons();
  logger.log({
    direction: 'out',
    label: state.cameraOff ? '已关闭摄像头' : '已打开摄像头',
    detail: '使用 track.enabled，对端连接保持不断',
  });
}

function teardownMedia(stageText) {
  for (const id of [...state.peers.keys()]) closePeer(id);
  logger.clearPeers();
  stopStream(state.screenStream);
  stopStream(state.localStream);
  state.screenStream = null;
  state.localStream = null;
  state.cameraTrack = null;
  state.sharing = false;
  state.muted = false;
  state.cameraOff = false;
  state.audioOnly = false;
  if (videoEl) videoEl.srcObject = null;
  $('video-placeholder')?.classList.remove('is-hidden');
  if (stageText) logger.setStage(stageText);
}

function onStreamEnded(message) {
  state.isLive = false;
  for (const id of [...state.peers.keys()]) closePeer(id);
  logger.clearPeers();
  if (videoEl) videoEl.srcObject = null;
  $('video-placeholder')?.classList.remove('is-hidden');
  renderLiveBadge();
  setStageNote(message);
  logger.setStage(message + '。可继续留在房间等主播再次开播。');
}

async function flushPendingIce(remoteId, peer) {
  const list = state.pendingIce.get(remoteId) || [];
  state.pendingIce.delete(remoteId);
  for (const candidate of list) {
    await peer.addIceCandidate(candidate);
  }
}

function closePeer(remoteId, reason) {
  const peer = state.peers.get(remoteId);
  if (!peer) {
    logger.removePeer(remoteId);
    return;
  }
  peer.close();
  state.peers.delete(remoteId);
  logger.removePeer(remoteId);
  if (reason) logger.log({ direction: 'out', label: '关闭 PeerConnection', detail: `${nameOf(remoteId)} · ${reason}` });
}

function attachPreview(stream, { mirror } = {}) {
  if (!videoEl) return;
  videoEl.srcObject = stream;
  videoEl.classList.toggle('is-mirrored', !!mirror);
  videoEl.muted = state.role === 'host'; // 主播预览必须静音，避免回声
  videoEl.playsInline = true;
  videoEl.play().catch(() => {});
  $('video-placeholder')?.classList.toggle('is-hidden', !!stream);
}

function nameOf(id) {
  return state.nicknames.get(id) || (id === state.hostId ? '主播' : `观众 ${shortId(id)}`);
}

function mediaErrorHint(err) {
  const name = err?.name || '';
  if (name === 'NotAllowedError') return '浏览器拒绝了摄像头/麦克风权限。请在地址栏允许后重试。';
  if (name === 'NotFoundError') return '没有找到可用的摄像头或麦克风。';
  if (name === 'NotReadableError') return '设备被其他程序占用，请关闭后重试。';
  if (location.protocol === 'http:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    return '非 localhost 的 HTTP 页面无法使用摄像头，请改用 https:// 或在本机用 localhost 打开。';
  }
  return err?.message || '无法采集音视频';
}

function bindChrome() {
  $('btn-live')?.addEventListener('click', () => {
    if (state.isLive) stopLive();
    else startLive();
  });
  $('btn-mute')?.addEventListener('click', toggleMute);
  $('btn-camera')?.addEventListener('click', toggleCamera);
  $('btn-share')?.addEventListener('click', toggleScreenShare);
  $('btn-copy-code')?.addEventListener('click', copyRoomCode);
  $('btn-copy-link')?.addEventListener('click', copyWatchLink);
  $('btn-leave')?.addEventListener('click', leaveRoom);

  const form = $('chat-form');
  const input = $('chat-input');
  form?.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const text = (input?.value || '').trim();
    if (!text) return;
    signaling.emit('chat', { text });
    input.value = '';
  });

  $('btn-clear-log')?.addEventListener('click', () => {
    const list = $('log-list');
    if (list) list.innerHTML = '';
  });
}

function leaveRoom() {
  if (state.role === 'host' && state.isLive) {
    signaling.emit('stop-live', {});
  }
  teardownMedia('');
  location.href = './';
}

async function copyRoomCode() {
  if (!state.roomId) return;
  try {
    await navigator.clipboard.writeText(state.roomId);
    showToast(`房间号 ${state.roomId} 已复制`);
  } catch {
    showToast(`房间号是 ${state.roomId}`);
  }
}

async function copyWatchLink() {
  if (!state.roomId) return;
  const url = `${location.origin}/room.html?code=${state.roomId}`;
  try {
    await navigator.clipboard.writeText(url);
    showToast('观看链接已复制，发给其他标签页或同学即可');
  } catch {
    showToast(url);
  }
}

function renderShell() {
  const roleEl = $('role-badge');
  if (roleEl) {
    roleEl.textContent = state.role === 'host' ? '主播' : '观众';
    roleEl.dataset.role = state.role || '';
  }
  const codeEl = $('room-code-display');
  if (codeEl) codeEl.textContent = state.roomId || '------';
  const nameEl = $('self-name');
  if (nameEl) nameEl.textContent = state.nickname || (state.role === 'host' ? '主播' : '观众');
  $('host-controls')?.classList.toggle('is-hidden', state.role !== 'host');
  $('viewer-hint')?.classList.toggle('is-hidden', state.role !== 'viewer');
  renderLiveBadge();
  renderHostButtons();
  updateCounts();
}

function renderLiveBadge() {
  const el = $('live-badge');
  if (!el) return;
  el.classList.toggle('is-on', !!state.isLive);
  el.innerHTML = state.isLive
    ? '<span class="live-dot"></span>直播中'
    : '<span class="live-dot"></span>未开播';
}

function renderHostButtons() {
  const live = $('btn-live');
  if (live) {
    live.textContent = state.isLive ? '结束直播' : '开始直播';
    live.classList.toggle('btn-danger', state.isLive);
    live.classList.toggle('btn-primary', !state.isLive);
  }
  setToggle('btn-mute', state.muted, state.muted ? '取消静音' : '静音');
  setToggle('btn-camera', state.cameraOff, state.cameraOff ? '打开摄像头' : '关闭摄像头');
  setToggle('btn-share', state.sharing, state.sharing ? '停止共享' : '共享屏幕');
  $('btn-camera')?.toggleAttribute('disabled', !state.isLive || state.audioOnly);
  $('btn-mute')?.toggleAttribute('disabled', !state.isLive);
  $('btn-share')?.toggleAttribute('disabled', !state.isLive);
}

function setToggle(id, on, label) {
  const el = $(id);
  if (!el) return;
  el.classList.toggle('is-on', !!on);
  const text = el.querySelector('.btn-label');
  if (text) text.textContent = label;
  else el.textContent = label;
}

function updateCounts() {
  const el = $('viewer-count');
  if (el) el.textContent = String(state.viewerCount);
}

function setStageNote(text) {
  if (!stageNote) return;
  stageNote.textContent = text || '';
  stageNote.classList.toggle('is-hidden', !text);
}

function setBusy(id, busy) {
  $(id)?.toggleAttribute('disabled', !!busy);
}

function pushChat(msg) {
  const list = $('chat-list');
  if (!list) return;
  const mine = msg.from === state.selfId;
  const row = document.createElement('div');
  row.className = `chat-row ${mine ? 'is-mine' : ''} is-${msg.role || 'viewer'}`;
  row.innerHTML = `
    <span class="chat-name">${escapeHtml(msg.nickname || '匿名')}</span>
    <span class="chat-text">${escapeHtml(msg.text)}</span>
  `;
  list.appendChild(row);
  list.scrollTop = list.scrollHeight;
}

function showToast(text) {
  if (!toastEl) return;
  toastEl.textContent = text;
  toastEl.classList.add('is-show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toastEl.classList.remove('is-show'), 2800);
}

function failAndBack(message) {
  logger.setStage(message);
  showToast(message);
  setTimeout(() => { location.href = './'; }, 1600);
}
