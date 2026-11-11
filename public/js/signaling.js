/**
 * 信令封装：所有通过 Socket.IO 进出的事件都会回调给学习面板。
 * 媒体数据不走这里，这里只搬运 SDP、ICE 候选、房间事件和聊天。
 */
const SIGNAL_LABELS = {
  'create-room': '创建房间',
  'join-room': '加入房间',
  'start-live': '开始直播',
  'stop-live': '结束直播',
  'viewer-joined': '观众加入',
  'viewer-left': '观众离开',
  'live-started': '主播已开播',
  'live-stopped': '主播已关播',
  'host-left': '主播离开',
  offer: 'Offer（SDP）',
  answer: 'Answer（SDP）',
  'ice-candidate': 'ICE 候选',
  chat: '聊天 / 弹幕',
  connect: '已连上信令服务器',
  disconnect: '信令断开',
  connect_error: '信令连接失败',
};

export function labelOf(event) {
  return SIGNAL_LABELS[event] || event;
}

export function connectSignaling({ onLog } = {}) {
  const socket = window.io({
    transports: ['websocket', 'polling'],
  });

  function describe(event, payload) {
    if (!payload || typeof payload !== 'object') return '';
    if (event === 'offer' || event === 'answer') {
      const type = payload.sdp?.type || '';
      const who = payload.fromNickname || payload.to || payload.from || '';
      return [type, who && `对象 ${who}`].filter(Boolean).join(' · ');
    }
    if (event === 'ice-candidate') {
      const cand = payload.candidate?.candidate || payload.candidate;
      if (!cand) return '收集结束（candidate 为空）';
      const mid = typeof cand === 'string' ? cand : '';
      const typ = mid.match(/ typ (\w+)/)?.[1];
      const proto = mid.match(/ (udp|tcp) /i)?.[1];
      return [typ, proto].filter(Boolean).join(' / ') || '一条候选';
    }
    if (event === 'viewer-joined' || event === 'viewer-left') {
      return `${payload.nickname || payload.viewerId || ''} · 在线 ${payload.viewerCount ?? ''}`;
    }
    if (event === 'chat') return payload.text || '';
    if (payload.roomId) return `房间 ${payload.roomId}`;
    if (payload.error) return payload.error;
    return '';
  }

  function emit(event, data, cb) {
    onLog?.({
      direction: 'out',
      event,
      label: labelOf(event),
      detail: describe(event, data),
      raw: data,
    });
    socket.emit(event, data, (res) => {
      if (res && res.ok === false) {
        onLog?.({
          direction: 'in',
          event,
          label: `${labelOf(event)} 失败`,
          detail: res.error || '',
          raw: res,
          level: 'error',
        });
      }
      cb?.(res);
    });
  }

  function on(event, handler) {
    socket.on(event, (payload) => {
      onLog?.({
        direction: 'in',
        event,
        label: labelOf(event),
        detail: describe(event, payload),
        raw: payload,
      });
      handler(payload);
    });
  }

  socket.on('connect', () => {
    onLog?.({
      direction: 'in',
      event: 'connect',
      label: labelOf('connect'),
      detail: `socket id ${socket.id}`,
    });
  });

  socket.on('disconnect', (reason) => {
    onLog?.({
      direction: 'in',
      event: 'disconnect',
      label: labelOf('disconnect'),
      detail: String(reason || ''),
      level: 'warn',
    });
  });

  socket.on('connect_error', (err) => {
    onLog?.({
      direction: 'in',
      event: 'connect_error',
      label: labelOf('connect_error'),
      detail: err?.message || String(err),
      level: 'error',
    });
  });

  return { socket, emit, on };
}
