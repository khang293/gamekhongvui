// Giao diện phòng cờ online dùng chung: khung tạo / vào phòng ở màn đầu, thanh thông tin trên bàn cờ, chat.
// Trang game chỉ cần vẽ bàn theo state (onState), gọi lại menu (onExit) và gọi move() khi người chơi đi một nước.
import { DuelNetHost, DuelNetClient, mySide, myTurn, type DuelState } from './duel';
import type { DuelGame, DuelSettings } from './duelRules';
import { FirebaseTransport } from './firebaseTransport';
import { normCode, validCode, sanitizeName, RoomError } from './room';
import { mountChat, type ChatBox } from './chatUi';

const TEXT = {
  vi: {
    head: 'Chơi online với bạn bè', namePh: 'Tên của bạn', create: 'Tạo phòng', codePh: 'Mã phòng', join: 'Vào phòng', connecting: 'Đang kết nối...', defName: 'Người chơi',
    note: 'Phòng online chạy qua máy chủ Firebase của Google. Ván đầu chủ phòng đi trước, đấu lại thì đổi bên.',
    roomCode: 'Mã phòng', copyLink: 'Chép link mời', copied: 'Đã chép', waiting: 'Đang chờ bạn vào phòng...', vs: '{a} gặp {b}', score: 'Tỉ số {a} : {b}',
    yourTurn: 'Đến lượt bạn', oppTurn: 'Chờ {n} đi', youWin: 'Bạn thắng!', youLose: 'Bạn thua.', draw: 'Hòa.', oppResign: '{n} xin thua. Bạn thắng!', youResign: 'Bạn đã xin thua.',
    resign: 'Xin thua', resignConfirm: 'Bạn chắc muốn xin thua?', rematch: 'Đấu lại', rematchWait: 'Chờ bạn kia đồng ý...', rematchAsk: '{n} muốn đấu lại',
    leave: 'Rời phòng', leaveConfirm: 'Rời phòng? Nếu bạn là chủ phòng, phòng sẽ đóng.', offline: '{n} đang mất mạng', lost: 'Mất kết nối, đang nối lại...', left: 'Bạn kia đã rời phòng.',
    errs: { noroom: 'Không tìm thấy phòng này.', full: 'Phòng đã đủ người.', started: 'Phòng đang chơi, không vào được.', version: 'Hai máy đang dùng bản khác nhau, hãy tải lại trang.', timeout: 'Kết nối quá lâu, hãy thử lại.', network: 'Không kết nối được, hãy kiểm tra mạng rồi thử lại.', closed: 'Phòng đã đóng.', hostLeft: 'Chủ phòng đã rời, phòng đóng.', lost: 'Mất kết nối với phòng.', kicked: 'Bạn đã bị mời ra khỏi phòng.', badmsg: 'Mã này là phòng của trò khác.', badcode: 'Mã phòng gồm 5 ký tự.' } as Record<string, string>,
  },
  en: {
    head: 'Play online with a friend', namePh: 'Your name', create: 'Create room', codePh: 'Room code', join: 'Join', connecting: 'Connecting...', defName: 'Player',
    note: 'Online rooms run through Google Firebase. The host moves first in the first game; sides swap on rematch.',
    roomCode: 'Room code', copyLink: 'Copy invite link', copied: 'Copied', waiting: 'Waiting for your friend...', vs: '{a} vs {b}', score: 'Score {a} : {b}',
    yourTurn: 'Your turn', oppTurn: "Waiting for {n}", youWin: 'You win!', youLose: 'You lose.', draw: 'Draw.', oppResign: '{n} resigned. You win!', youResign: 'You resigned.',
    resign: 'Resign', resignConfirm: 'Resign this game?', rematch: 'Rematch', rematchWait: 'Waiting for the other player...', rematchAsk: '{n} wants a rematch',
    leave: 'Leave room', leaveConfirm: 'Leave the room? If you are the host, the room closes.', offline: '{n} is offline', lost: 'Connection lost, reconnecting...', left: 'The other player left.',
    errs: { noroom: 'Room not found.', full: 'The room is full.', started: 'That room is already playing.', version: 'The two devices run different versions, please reload.', timeout: 'Connecting took too long, try again.', network: 'Could not connect, check your network and try again.', closed: 'The room has closed.', hostLeft: 'The host left, the room is closed.', lost: 'Lost the connection to the room.', kicked: 'You were removed from the room.', badmsg: 'That code belongs to another game.', badcode: 'A room code has 5 characters.' } as Record<string, string>,
  },
};

const CSS = `
.du-box { margin-top: 22px; padding-top: 6px; border-top: 1px solid #8884; }
.du-box .bd-row { display: flex; flex-wrap: wrap; gap: 8px; }
.du-input { min-height: 44px; padding: 6px 12px; border-radius: 10px; border: 1px solid #8886; background: var(--bg); color: inherit; font: inherit; max-width: 100%; }
.du-code { width: 150px; text-transform: uppercase; letter-spacing: .25em; font-weight: 800; text-align: center; }
.du-err { margin: 6px 0; color: #e8590c; font-weight: 700; } .du-err:empty { display: none; }
.du-bar { margin: 0 0 10px; padding: 10px 12px; border-radius: 14px; background: linear-gradient(160deg, #14203a, #0c1426); color: #fff; text-align: center; max-width: 640px; }
.du-bar[hidden] { display: none; }
.du-bar b.du-big { display: block; font-size: 1.8rem; letter-spacing: .3em; color: #ffd54a; }
.du-bar p { margin: 2px 0; } .du-bar .du-status { font-weight: 800; color: #ffe066; }
.du-bar .du-btns { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin-top: 6px; }
.du-bar button { border: 1px solid #ffffff55; border-radius: 9px; background: #ffffff14; color: #fff; font: inherit; font-weight: 700; padding: 6px 14px; min-height: 36px; cursor: pointer; }
.du-bar button.go { background: #4c5ce0; border-color: #4c5ce0; }
`;

export interface DuelUiOpts {
  game: DuelGame;
  lang: 'vi' | 'en';
  menu: HTMLElement;                 // khung tạo / vào phòng được thêm vào cuối đây
  board: HTMLElement;                // thanh phòng được chèn vào đầu đây
  settings: () => DuelSettings;      // cài đặt chủ phòng đã chọn ở menu
  onEnter: () => void;               // vào phòng: ẩn menu, hiện bàn, khóa các nút chơi một mình
  onState: (s: DuelState, resultText: string) => void; // vẽ bàn theo state
  onExit: () => void;                // rời phòng: về menu
}
export interface DuelUi { move(m: unknown): void; readonly state: DuelState | null }

export function mountDuel(o: DuelUiOpts): DuelUi {
  const T = TEXT[o.lang] || TEXT.vi;
  const fmt = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ''));
  const st = document.createElement('style');
  st.textContent = CSS; document.head.appendChild(st);
  const box = document.createElement('div');
  box.className = 'du-box';
  box.innerHTML = `<h2 class="bd-h">${T.head}</h2>
    <div class="bd-row"><input class="du-input du-name" type="text" maxlength="16" autocomplete="nickname" placeholder="${T.namePh}" aria-label="${T.namePh}"><button type="button" class="btn du-create">🌐 ${T.create}</button></div>
    <div class="bd-row"><input class="du-input du-code" type="text" maxlength="5" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="${T.codePh}" aria-label="${T.codePh}"><button type="button" class="btn ghost du-join">🔑 ${T.join}</button></div>
    <p class="du-err" aria-live="polite"></p><p class="meta">${T.note}</p>`;
  o.menu.appendChild(box);
  const bar = document.createElement('div');
  bar.className = 'du-bar'; bar.hidden = true;
  o.board.prepend(bar);
  const nameIn = box.querySelector('.du-name') as HTMLInputElement, codeIn = box.querySelector('.du-code') as HTMLInputElement;
  const errEl = box.querySelector('.du-err') as HTMLElement;
  const createBtn = box.querySelector('.du-create') as HTMLButtonElement, joinBtn = box.querySelector('.du-join') as HTMLButtonElement;

  const KEY = 'duel-room-' + o.game;
  const store = (k: string, v: string | null) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch {} };
  const read = (k: string) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
  nameIn.value = read('xd-name') || read('tl-name');
  const myName = () => { const n = sanitizeName(nameIn.value, T.defName); store('xd-name', nameIn.value.trim()); return n; };

  let ctl: { kind: 'host'; host: DuelNetHost } | { kind: 'client'; client: DuelNetClient } | null = null;
  let state: DuelState | null = null, chat: ChatBox | null = null, busy = false, lost = false, sentPly = -1;

  const setErr = (r: string) => { errEl.textContent = r ? (r === 'connecting' ? T.connecting : T.errs[r] || T.errs.network) : ''; };
  const setBusy = (on: boolean) => { busy = on; createBtn.disabled = on; joinBtn.disabled = on; };

  const resultText = (s: DuelState) => {
    if (s.phase !== 'over' || s.winner === null) return '';
    if (s.winner === -1) return T.draw;
    const won = s.winner === mySide(s);
    if (s.reason === 'resign') return won ? fmt(T.oppResign, { n: s.names[1 - s.mySlot] }) : T.youResign;
    return won ? T.youWin : T.youLose;
  };

  // thanh phòng: chỉ dùng textContent cho mọi thứ đến từ máy khác
  function paint() {
    const s = state;
    if (!s) return;
    bar.hidden = false;
    bar.textContent = '';
    const p = (text: string, cls = '', tag = 'p') => { const e = document.createElement(tag); e.className = cls; e.textContent = text; bar.appendChild(e); return e; };
    const btns = document.createElement('div');
    btns.className = 'du-btns';
    const btn = (label: string, act: string, cls = '') => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.dataset.act = act; b.className = cls; btns.appendChild(b); };
    const opp = s.names[1 - s.mySlot];
    if (s.phase === 'lobby') {
      p(T.roomCode); p(s.code, 'du-big', 'b'); p(T.waiting, 'du-status');
      btn(T.copyLink, 'copy', 'go');
    } else {
      p(`${T.roomCode} ${s.code} · ${fmt(T.vs, { a: s.names[0], b: s.names[1] })} · ${fmt(T.score, { a: s.score[0], b: s.score[1] })}`);
      let status = s.phase === 'over' ? resultText(s) : myTurn(s) ? T.yourTurn : fmt(T.oppTurn, { n: opp });
      if (s.mySlot === 0 && !s.guestOnline) status = fmt(T.offline, { n: opp });
      if (lost) status = T.lost;
      p(status, 'du-status');
      if (s.phase === 'play') btn(T.resign, 'resign');
      else if (s.rematch[s.mySlot]) p(T.rematchWait);
      else { if (s.rematch[1 - s.mySlot]) p(fmt(T.rematchAsk, { n: opp })); btn(T.rematch, 'rematch', 'go'); }
    }
    btn(T.leave, 'leave');
    bar.appendChild(btns);
  }

  function onState(s: DuelState) {
    if (!ctl) return;
    const first = !state;
    state = s; lost = false; sentPly = -1;
    if (first) {
      o.onEnter();
      const c = ctl;
      chat = mountChat(o.lang, (t) => (c.kind === 'host' ? c.host.room.say(t) : c.client.rc.say(t)));
      const add = (m: { slot: number; name: string; text: string }) => chat?.add(m, m.slot === state?.mySlot);
      if (c.kind === 'host') c.host.room.onChat = add; else c.client.rc.onChat = add;
    }
    paint();
    o.onState(s, resultText(s));
  }
  function exit(err = '') {
    ctl = null; state = null; lost = false;
    chat?.destroy(); chat = null;
    bar.hidden = true;
    o.onExit();
    setErr(err);
  }
  function leave() {
    const c = ctl;
    store(KEY, null);
    ctl = null;
    try { if (c?.kind === 'host') c.host.close(); else c?.client.leave(); } catch {}
    exit();
  }
  const send = (p: unknown) => { if (ctl?.kind === 'host') ctl.host.send(p); else ctl?.client.send(p); };

  bar.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button'); if (!b || !state) return;
    const act = b.dataset.act;
    if (act === 'copy') navigator.clipboard?.writeText(`${location.origin}${location.pathname}?room=${state.code}`).then(() => { b.textContent = T.copied; }).catch(() => {});
    else if (act === 'resign') { if (confirm(T.resignConfirm)) send({ type: 'resign' }); }
    else if (act === 'rematch') send({ type: 'rematch' });
    else if (act === 'leave') { if (state.phase === 'lobby' || confirm(T.leaveConfirm)) leave(); }
  });

  async function create() {
    if (busy) return;
    setBusy(true); setErr('connecting');
    try {
      const pending: DuelState[] = [];
      const host = await DuelNetHost.create(o.game, o.settings(), () => new FirebaseTransport(), myName(), (s) => { if (ctl?.kind === 'host') onState(s); else pending.push(s); });
      ctl = { kind: 'host', host }; setErr('');
      const last = pending[pending.length - 1];
      if (last) onState(last);
    } catch { setErr('network'); }
    setBusy(false);
  }
  async function join(codeRaw: string, name: string, token = '') {
    const code = normCode(codeRaw);
    if (busy) return;
    if (!validCode(code)) { setErr('badcode'); return; }
    setBusy(true); setErr('connecting');
    const client: DuelNetClient = new DuelNetClient(o.game, () => new FirebaseTransport(), {
      onState: (s) => onState(s),
      onStatus: (x) => { lost = x === 'lost'; paint(); },
      onClosed: (r) => { if (ctl?.kind === 'client' && ctl.client === client) { store(KEY, null); exit(r); } },
    });
    ctl = { kind: 'client', client };
    try {
      const info = await client.join(code, name, token);
      store(KEY, JSON.stringify({ code, token: info.token, name, at: Date.now() }));
      setErr('');
    } catch (e) {
      ctl = null; store(KEY, null);
      setErr(e instanceof RoomError ? e.reason : 'network');
    }
    setBusy(false);
  }
  createBtn.addEventListener('click', () => void create());
  joinBtn.addEventListener('click', () => void join(codeIn.value, myName()));
  codeIn.addEventListener('input', () => { codeIn.value = normCode(codeIn.value); });
  window.addEventListener('pagehide', () => { if (ctl?.kind === 'host') { try { ctl.host.close(); } catch {} } });
  // link mời ?room=MÃ, hoặc tải lại trang khi đang ở phòng của người khác
  const invite = normCode(new URLSearchParams(location.search).get('room') || '');
  if (invite) codeIn.value = invite;
  try {
    const saved = JSON.parse(read(KEY) || 'null');
    if (saved && saved.code && saved.token && Date.now() - saved.at < 30 * 60 * 1000 && (!invite || invite === saved.code)) void join(saved.code, saved.name, saved.token);
  } catch {}

  return {
    move(m) {
      if (!state || !myTurn(state) || lost || sentPly === state.moves.length) return;
      sentPly = state.moves.length; // không gửi hai lần cho cùng một lượt
      send({ type: 'move', move: m, ply: state.moves.length });
    },
    get state() { return state; },
  };
}
