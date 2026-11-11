import { $ } from './util.js';

const nameInput = $('nickname');
const codeInput = $('room-code');
const createBtn = $('btn-create');
const joinBtn = $('btn-join');

const saved = sessionStorage.getItem('livelab-name') || '';
if (saved && nameInput) nameInput.value = saved;

function nickname() {
  return (nameInput?.value || '').trim();
}

function go(params) {
  const name = nickname();
  if (name) sessionStorage.setItem('livelab-name', name);
  const qs = new URLSearchParams(params);
  if (name) qs.set('name', name);
  location.href = `./room.html?${qs.toString()}`;
}

createBtn?.addEventListener('click', () => {
  go({ mode: 'create' });
});

function tryJoin() {
  const code = (codeInput?.value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  if (codeInput) codeInput.value = code;
  if (code.length < 6) {
    codeInput?.focus();
    codeInput?.classList.add('is-invalid');
    return;
  }
  codeInput?.classList.remove('is-invalid');
  go({ mode: 'join', code });
}

joinBtn?.addEventListener('click', tryJoin);
codeInput?.addEventListener('input', () => {
  codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  codeInput.classList.remove('is-invalid');
});
codeInput?.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') tryJoin();
});
nameInput?.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') {
    if ((codeInput?.value || '').length >= 6) tryJoin();
    else createBtn?.click();
  }
});
