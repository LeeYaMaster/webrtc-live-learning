/**
 * 学习面板：用中文记下信令事件，并展示每条 PeerConnection 的状态。
 */
import { $, escapeHtml, formatTime } from './util.js';

const LEVEL_CLASS = {
  error: 'log-error',
  warn: 'log-warn',
  out: 'log-out',
  in: 'log-in',
};

export function createLogger() {
  const listEl = $('log-list');
  const stageEl = $('stage-text');
  const statesEl = $('peer-states');
  const sdpEl = $('sdp-snippet');
  const peerStates = new Map();
  let lastSdp = '';

  function append(entry) {
    if (!listEl) return;
    const level = entry.level || entry.direction || 'in';
    const row = document.createElement('div');
    row.className = `log-row ${LEVEL_CLASS[level] || ''}`;
    const arrow = entry.direction === 'out' ? '发出' : '收到';
    row.innerHTML = `
      <span class="log-time">${escapeHtml(formatTime(entry.ts))}</span>
      <span class="log-dir">${arrow}</span>
      <span class="log-label">${escapeHtml(entry.label || entry.event)}</span>
      ${entry.detail ? `<span class="log-detail">${escapeHtml(entry.detail)}</span>` : ''}
    `;
    listEl.appendChild(row);
    listEl.scrollTop = listEl.scrollHeight;
  }

  function setStage(text) {
    if (stageEl) stageEl.textContent = text;
  }

  function upsertPeerState({ remoteId, label, kind, value }) {
    const id = remoteId || 'default';
    const prev = peerStates.get(id) || { label: label || id, signaling: '—', iceConnection: '—', iceGathering: '—', connection: '—' };
    if (label) prev.label = label;
    if (kind && value) prev[kind] = value;
    peerStates.set(id, prev);
    renderStates();
  }

  function removePeer(remoteId) {
    peerStates.delete(remoteId);
    renderStates();
  }

  function clearPeers() {
    peerStates.clear();
    renderStates();
  }

  function stateTone(value) {
    if (!value || value === '—') return '';
    if (['connected', 'completed', 'stable'].includes(value)) return 'is-good';
    if (['connecting', 'checking', 'gathering', 'have-local-offer', 'have-remote-offer'].includes(value)) return 'is-wait';
    if (['failed', 'disconnected', 'closed', 'disconnected'].includes(value)) return 'is-bad';
    return '';
  }

  function renderStates() {
    if (!statesEl) return;
    if (!peerStates.size) {
      statesEl.innerHTML = '<p class="peer-empty">还没有 PeerConnection。开播并有观众进入后会出现在这里。</p>';
      return;
    }
    statesEl.innerHTML = [...peerStates.values()].map((p) => `
      <div class="peer-card">
        <div class="peer-name">${escapeHtml(p.label)}</div>
        <div class="peer-pills">
          <span class="pill ${stateTone(p.connection)}">连接 ${escapeHtml(p.connection)}</span>
          <span class="pill ${stateTone(p.iceConnection)}">ICE ${escapeHtml(p.iceConnection)}</span>
          <span class="pill ${stateTone(p.signaling)}">信令 ${escapeHtml(p.signaling)}</span>
          <span class="pill">收集 ${escapeHtml(p.iceGathering)}</span>
        </div>
      </div>
    `).join('');
  }

  function showSdp(description) {
    if (!description) return;
    lastSdp = `${description.type}\n\n${description.sdp || ''}`;
    if (sdpEl) sdpEl.textContent = lastSdp;
  }

  function log(entry) {
    append({ ts: Date.now(), ...entry });
  }

  return { log, setStage, upsertPeerState, removePeer, clearPeers, showSdp };
}
