// Khung chat và thả biểu cảm nổi ở góc màn hình, dùng chung cho mọi phòng online.
// Nội dung người khác gửi chỉ được đưa lên trang bằng textContent.
import type { ChatMsg } from './room';

export interface ChatBox { add(m: ChatMsg, mine: boolean): void; destroy(): void }

const TEXT = {
  vi: { open: 'Chat và biểu cảm', ph: 'Nhắn gì đó...', send: 'Gửi', close: 'Đóng', empty: 'Chưa có tin nào. Tin nhắn chỉ hiện trong phòng, không được lưu lại.', you: 'Bạn' },
  en: { open: 'Chat and reactions', ph: 'Say something...', send: 'Send', close: 'Close', empty: 'No messages yet. Messages stay in the room and are not saved.', you: 'You' },
};
const EMOJIS = ['😂', '😎', '😭', '😡', '😱', '👍', '👏', '🤝', '💣', '🔥', '🐷', '🎉'];
const isEmoji = (t: string) => EMOJIS.includes(t);

const CSS = `
.gk-chat { position: fixed; right: 8px; top: 68px; z-index: 95; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; pointer-events: none; }
.gk-chat > * { pointer-events: auto; }
main:has(#pk-v-lobby) .gk-chat, main:has(#cm-root) .gk-chat { top: 124px; } /* poker: tránh nút toàn màn hình và âm thanh ở góc trên */
.gk-fab { position: relative; width: 46px; height: 46px; opacity: .93; border-radius: 50%; border: 2px solid #fff; background: linear-gradient(135deg, #5b6cff, #3b46c4); color: #fff; font-size: 24px; cursor: pointer; box-shadow: 0 6px 16px rgba(0,0,0,.35); }
.gk-fab b { position: absolute; top: -4px; right: -4px; min-width: 20px; height: 20px; padding: 0 5px; border-radius: 999px; background: #e03131; font-size: 12px; line-height: 20px; }
.gk-fab b[hidden], .gk-panel[hidden] { display: none; }
.gk-panel { width: min(300px, calc(100vw - 24px)); padding: 10px; border-radius: 14px; background: #121a2b; color: #fff; border: 1px solid #ffffff33; box-shadow: 0 14px 34px rgba(0,0,0,.45); }
.gk-log { height: 150px; overflow-y: auto; font-size: 14px; line-height: 1.45; overflow-wrap: anywhere; }
.gk-log p { margin: 0 0 4px; } .gk-log p b { color: #ffd54a; margin-right: 6px; } .gk-log p.mine b { color: #8fd3ff; } .gk-log .gk-empty { opacity: .65; font-size: 12.5px; }
.gk-emo { display: grid; grid-template-columns: repeat(6, 1fr); gap: 2px; margin: 8px 0; }
.gk-emo button { border: 0; background: #ffffff14; border-radius: 8px; font-size: 20px; min-height: 36px; cursor: pointer; }
.gk-row { display: flex; gap: 6px; }
.gk-row input { flex: 1; min-width: 0; min-height: 38px; padding: 4px 10px; border-radius: 9px; border: 1px solid #ffffff44; background: #0b1120; color: #fff; font: inherit; font-size: 16px; }
.gk-row button { border: 0; border-radius: 9px; padding: 0 12px; background: #4c5ce0; color: #fff; font-weight: 700; cursor: pointer; }
.gk-toast { max-width: min(260px, calc(100vw - 24px)); padding: 8px 12px; border-radius: 14px 4px 14px 14px; background: #fff; color: #15171c; font-size: 14px; overflow-wrap: anywhere; box-shadow: 0 6px 16px rgba(0,0,0,.3); animation: gkIn .25s ease-out; }
.gk-toast b { margin-right: 6px; color: #3b46c4; }
.gk-toast.big { background: transparent; box-shadow: none; display: flex; flex-direction: column; align-items: center; padding: 0 4px; font-size: 46px; line-height: 1.1; animation: gkBounce .6s cubic-bezier(.3,1.6,.5,1); }
.gk-toast.big b { font-size: 12px; color: #fff; background: #000a; border-radius: 999px; padding: 1px 8px; margin: 0; }
@keyframes gkIn { from { opacity: 0; transform: translateY(10px); } }
@keyframes gkBounce { from { opacity: 0; transform: scale(.2) translateY(30px); } }
`;

export function mountChat(lang: 'vi' | 'en', say: (text: string) => void): ChatBox {
  const T = TEXT[lang] || TEXT.vi;
  if (!document.getElementById('gk-chat-css')) {
    const st = document.createElement('style');
    st.id = 'gk-chat-css'; st.textContent = CSS;
    document.head.appendChild(st);
  }
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = '') => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  };
  const root = el('div', 'gk-chat');
  const toasts = el('div');
  toasts.style.cssText = 'display:flex;flex-direction:column;align-items:flex-end;gap:6px;pointer-events:none';
  toasts.setAttribute('aria-live', 'polite');
  const panel = el('div', 'gk-panel');
  panel.hidden = true;
  const log = el('div', 'gk-log');
  log.appendChild(el('p', 'gk-empty', T.empty));
  const emo = el('div', 'gk-emo');
  for (const e of EMOJIS) { const b = el('button', '', e); b.type = 'button'; b.addEventListener('click', () => say(e)); emo.appendChild(b); }
  const form = el('form', 'gk-row');
  const input = el('input');
  input.type = 'text'; input.maxLength = 120; input.placeholder = T.ph; input.setAttribute('aria-label', T.ph); input.autocomplete = 'off';
  const send = el('button', '', T.send); send.type = 'submit';
  form.append(input, send);
  form.addEventListener('submit', (e) => { e.preventDefault(); const t = input.value.trim(); if (t) { say(t); input.value = ''; } });
  panel.append(log, emo, form);
  const fab = el('button', 'gk-fab', '💬');
  fab.type = 'button'; fab.setAttribute('aria-label', T.open); fab.title = T.open;
  const badge = el('b'); badge.hidden = true; fab.appendChild(badge);
  let unread = 0;
  const paint = () => { badge.hidden = !unread; badge.textContent = String(unread > 9 ? '9+' : unread); };
  fab.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) { unread = 0; paint(); toasts.textContent = ''; log.scrollTop = log.scrollHeight; }
  });
  root.append(fab, panel, toasts);
  (document.querySelector('main') || document.body).appendChild(root); // trong main để còn thấy khi bật toàn màn hình

  return {
    add(m, mine) {
      log.querySelector('.gk-empty')?.remove();
      const who = mine ? T.you : m.name;
      const line = el('p', mine ? 'mine' : '');
      line.append(el('b', '', who), document.createTextNode(m.text));
      log.appendChild(line);
      while (log.childElementCount > 50) log.firstElementChild!.remove();
      log.scrollTop = log.scrollHeight;
      if (!panel.hidden) return;
      // đang đóng khung chat: biểu cảm nảy to, lời nhắn hiện bong bóng
      const t = el('div', 'gk-toast' + (isEmoji(m.text) ? ' big' : ''));
      if (isEmoji(m.text)) t.append(document.createTextNode(m.text), el('b', '', who));
      else t.append(el('b', '', who), document.createTextNode(m.text));
      toasts.appendChild(t);
      while (toasts.childElementCount > 3) toasts.firstElementChild!.remove();
      setTimeout(() => t.remove(), isEmoji(m.text) ? 2500 : 4500);
      if (!mine) { unread++; paint(); }
    },
    destroy() { root.remove(); },
  };
}
