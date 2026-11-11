/** 把聊天文字从视频右侧弹到左侧。 */
import { escapeHtml } from './util.js';

const COLORS = ['#fff4e8', '#f5c16c', '#7eb0ff', '#4ade9b', '#ff9b8a', '#e0c8ff'];

export function createDanmaku(stageEl) {
  function spawn(text, seed = 0) {
    if (!stageEl || !text) return;
    const el = document.createElement('div');
    el.className = 'danmaku-item';
    el.textContent = text;
    el.style.color = COLORS[Math.abs(hash(text + seed)) % COLORS.length];
    const top = 12 + (Math.abs(hash(text + Date.now())) % 70);
    el.style.top = `${top}%`;
    const duration = 8 + (Math.abs(hash(text)) % 5);
    el.style.animationDuration = `${duration}s`;
    stageEl.appendChild(el);
    const t = setTimeout(() => el.remove(), duration * 1000 + 200);
    el.addEventListener('animationend', () => {
      clearTimeout(t);
      el.remove();
    });
  }

  // 仅用于错开弹道，不是安全哈希
  function hash(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return h;
  }

  return { spawn };
}

export { escapeHtml };
