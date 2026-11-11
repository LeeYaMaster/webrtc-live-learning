/** 小工具：转义、时间、选择器。 */

export function $(id) {
  return document.getElementById(id);
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

export function formatTime(ts = Date.now()) {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
}

export function shortId(id = '') {
  return String(id).slice(0, 6);
}

export function qs(name) {
  return new URLSearchParams(location.search).get(name);
}
