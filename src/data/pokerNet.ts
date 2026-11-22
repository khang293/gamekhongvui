// Poker online: bộ điều khiển bàn (PKGame) và phần nối mạng (PKNetHost, PKNetClient).
// PKGame chạy luật bằng engine có sẵn (pokerEngine, pokerBot) và là nguồn sự thật duy nhất. Chơi online thì máy chủ phòng
// chạy PKGame và gửi cho từng khách bản xem riêng (stateFor) của họ: bài úp của người khác không bao giờ rời khỏi máy chủ phòng
// trước khi mở bài. Khách chỉ gửi ý định {type:'action', action:{...}}. Cùng mô hình với tienlenNet.ts, dùng lại lớp mạng net/room.ts.
import { createTable, startHand, applyAction, viewFor, legalActions, BLINDS, type Table, type View, type Ev, type Action } from './pokerEngine';
import { decide, PROFILES } from './pokerBot';
import { RoomHost, RoomClient, makeCode, normCode, sanitizeName, realClock, type Clock, type Member, type RejectReason, type JoinInfo } from './net/room';
import { TransportError, type Transport } from './net/transport';

export const GRACE_MS = 60000;   // mất mạng quá lâu thì máy chơi thay đến hết ván
export const NEXT_MS = 6000;     // nghỉ giữa hai ván để mọi người xem kết quả
export const MAX_SEATS = 6;

export interface PKSettings { n: number; stack: number; blindEvery: number; level: number; timer: number }
export const DEFAULTS: PKSettings = { n: 4, stack: 1000, blindEvery: 8, level: 2, timer: 30 };

export type Profile = 'tight' | 'loose' | 'balanced';
export const ROSTER_PROFILES: Profile[] = ['balanced', 'balanced', 'loose', 'tight', 'loose', 'tight']; // theo số ghế (ghế 0 là chủ phòng)

export interface PubSlot { name: string; kind: 'human' | 'bot'; online: boolean; replaced: boolean; host: boolean; profile: Profile }
export interface NetState {
  seq: number; code: string; phase: 'lobby' | 'table'; settings: PKSettings; slots: PubSlot[]; mySlot: number;
  view: View | null;            // bản xem của ghế mySlot (bài người khác chỉ có khi đã mở)
  turnMs: number | null;        // còn bao lâu hết giờ của người đang tới lượt (nếu có đồng hồ)
  turnTotal: number;            // tổng thời gian một lượt (ms), 0 nếu không có đồng hồ
  nextMs: number | null;        // còn bao lâu tới ván kế tiếp
  evN: number; events: Ev[];    // lô sự kiện mới nhất (để hiệu ứng, chỉ phát một lần theo evN)
  gameOver: boolean; winner: number;
}

interface GSlot { human: boolean; name: string; online: boolean; replaced: boolean; offlineAt: number }
const clampInt = (v: unknown, lo: number, hi: number, d: number) => { const x = Number(v); return Number.isInteger(x) && x >= lo && x <= hi ? x : d; };
const BOT_FALLBACK = ['', 'An', 'Mai', 'Cường', 'Hà', 'Lan'];

/** Số ngẫu nhiên an toàn (crypto) cho việc xào bài ở phòng online. */
export function secureRng(): () => number {
  const c = (globalThis as any).crypto;
  if (c && typeof c.getRandomValues === 'function') {
    const buf = new Uint32Array(1);
    return () => { c.getRandomValues(buf); return buf[0] / 4294967296; };
  }
  return Math.random;
}

export type IntentResult = 'ok' | 'bad' | 'notTurn' | 'illegal' | 'phase' | 'forbidden';
const ACTION_TYPES = ['fold', 'check', 'call', 'raise', 'allin'];

export class PKGame {
  settings: PKSettings = { ...DEFAULTS };
  phase: 'lobby' | 'table' = 'lobby';
  slots: GSlot[];
  t: Table | null = null;
  seq = 0;
  evN = 0;
  events: Ev[] = [];
  private turnToken = 0;
  private deadline = 0;
  private nextAt = 0;
  private nextTimer: (() => void) | null = null;
  readonly rng: () => number;
  readonly botNames: string[];
  code: string;
  constructor(public clock: Clock = realClock, private opts: { rng?: () => number; botMs?: [number, number]; botNames?: string[]; code?: string; onChange?: () => void } = {}) {
    this.rng = opts.rng || secureRng();
    this.botNames = opts.botNames && opts.botNames.length >= MAX_SEATS ? opts.botNames : BOT_FALLBACK;
    this.code = opts.code || '';
    this.slots = Array.from({ length: MAX_SEATS }, (_, i) => ({ human: false, name: this.botNames[i], online: true, replaced: false, offlineAt: 0 }));
  }
  private notify() { this.seq++; this.opts.onChange?.(); }

  // ---------- Người và máy ngồi ghế ----------
  setHuman(slot: number, name: string, online = true) {
    const s = this.slots[slot]; if (!s) return;
    s.human = true; s.name = sanitizeName(name); s.online = online; s.replaced = false; s.offlineAt = 0;
    this.notify();
  }
  clearHuman(slot: number) {
    const s = this.slots[slot]; if (!s) return;
    s.human = false; s.name = this.botNames[slot]; s.online = true; s.replaced = false; s.offlineAt = 0;
    if (this.phase === 'table') this.scheduleTurn();
    this.notify();
  }
  humanSlots(): number[] { return this.slots.slice(0, this.settings.n).map((s, i) => (s.human ? i : -1)).filter((i) => i >= 0); }
  maxHumanSlot(): number { return Math.max(0, ...this.humanSlots()); }
  controller(slot: number): 'human' | 'bot' { const s = this.slots[slot]; return s && s.human && !s.replaced ? 'human' : 'bot'; }
  profileOf(slot: number): Profile { return ROSTER_PROFILES[slot] || 'balanced'; }

  markOnline(slot: number, on: boolean) {
    const s = this.slots[slot]; if (!s || !s.human || s.online === on) return;
    s.online = on;
    if (!on) {
      const at = this.clock.now(); s.offlineAt = at;
      if (this.phase === 'table') {
        this.clock.after(() => {
          const x = this.slots[slot];
          if (x && x.human && !x.online && x.offlineAt === at && this.phase === 'table' && !x.replaced) {
            x.replaced = true;
            if (this.t && this.t.toAct === slot) this.scheduleTurn();
            this.notify();
          }
        }, GRACE_MS);
      }
    } else s.offlineAt = 0;
    this.notify();
  }

  // ---------- Cài đặt (chỉ trong sảnh) ----------
  setSettings(p: Partial<PKSettings>) {
    if (this.phase !== 'lobby') return;
    const o = this.settings;
    const n = clampInt(p.n ?? o.n, 2, MAX_SEATS, o.n);
    o.n = Math.max(n, this.maxHumanSlot() + 1, 2);
    if (p.stack !== undefined) o.stack = [500, 1000, 2000].includes(Number(p.stack)) ? Number(p.stack) : o.stack;
    if (p.blindEvery !== undefined) o.blindEvery = [0, 8].includes(Number(p.blindEvery)) ? Number(p.blindEvery) : o.blindEvery;
    if (p.level !== undefined) o.level = clampInt(p.level, 1, 3, o.level);
    if (p.timer !== undefined) o.timer = [0, 20, 30, 45].includes(Number(p.timer)) ? Number(p.timer) : o.timer;
    this.notify();
  }

  // ---------- Bắt đầu, chia ván ----------
  private makeTable(): Table {
    const n = this.settings.n;
    const t = createTable({
      names: Array.from({ length: n }, (_, i) => this.slots[i].name), bots: Array.from({ length: n }, (_, i) => !this.slots[i].human),
      startStack: this.settings.stack, blindEvery: this.settings.blindEvery,
    });
    t.rng = this.rng; // xào bài bằng số ngẫu nhiên an toàn (hoặc rng thử nghiệm)
    return t;
  }
  start(): boolean {
    if (this.phase !== 'lobby' || this.settings.n < 2) return false;
    this.t = this.makeTable(); this.phase = 'table';
    this.beginHand();
    return true;
  }
  restartNow() {
    if (this.phase === 'lobby') return;
    this.cancelNext();
    this.t = this.makeTable(); this.events = []; this.evN++;
    for (const s of this.slots) s.replaced = s.human && !s.online;
    this.beginHand();
  }
  toLobby() {
    this.turnToken++; this.cancelNext();
    this.phase = 'lobby'; this.t = null; this.events = []; this.deadline = 0;
    for (const s of this.slots) s.replaced = false;
    this.notify();
  }
  private cancelNext() { this.nextTimer?.(); this.nextTimer = null; this.nextAt = 0; }

  private beginHand() {
    this.cancelNext();
    for (const s of this.slots) if (s.human) s.replaced = !s.online; // ai đang mất mạng thì máy chơi thay ngay
    const evs = startHand(this.t!);
    this.after(evs);
  }
  /** Sau mỗi thay đổi bàn: ghi sự kiện, hẹn lượt kế (hoặc ván kế), thông báo. */
  private after(evs: Ev[]) {
    this.events = evs; this.evN++;
    const t = this.t!;
    if (t.phase === 'hand_over') {
      this.turnToken++; this.deadline = 0;
      this.nextAt = this.clock.now() + NEXT_MS;
      this.nextTimer = this.clock.after(() => { this.nextTimer = null; this.nextAt = 0; if (this.phase === 'table' && this.t && this.t.phase === 'hand_over') this.beginHand(); }, NEXT_MS);
    } else if (t.phase === 'game_over') {
      this.turnToken++; this.deadline = 0; this.nextAt = 0;
    } else this.scheduleTurn();
    this.notify();
  }

  // ---------- Lượt chơi ----------
  private static betting = ['preflop', 'flop', 'turn', 'river'];
  private scheduleTurn() {
    const t = this.t;
    this.turnToken++; this.deadline = 0;
    if (!t || this.phase !== 'table' || !PKGame.betting.includes(t.phase) || t.toAct < 0) return;
    const token = this.turnToken, slot = t.toAct;
    if (this.controller(slot) === 'bot') {
      const [a, b] = this.opts.botMs || [700, 1500];
      this.clock.after(() => this.botAct(token), a + this.rng() * (b - a));
    } else if (this.settings.timer > 0) {
      const ms = this.settings.timer * 1000;
      this.deadline = this.clock.now() + ms;
      this.clock.after(() => this.timeoutAct(token), ms);
    }
  }
  private botAct(token: number) {
    const t = this.t;
    if (token !== this.turnToken || !t || !PKGame.betting.includes(t.phase)) return;
    const seat = t.toAct;
    if (seat < 0 || this.controller(seat) !== 'bot') return;
    const lg = legalActions(t, seat);
    if (!lg.canAct) return;
    let a: Action;
    try { a = decide(viewFor(t, seat), PROFILES[this.profileOf(seat)], this.settings.level, this.rng); } catch { a = lg.canCheck ? { type: 'check' } : { type: 'fold' }; }
    let r = applyAction(t, seat, a);
    if (!r.ok) r = applyAction(t, seat, lg.canCheck ? { type: 'check' } : lg.canCall ? { type: 'call' } : { type: 'fold' });
    if (r.ok) this.after(r.events);
  }
  private timeoutAct(token: number) {
    const t = this.t;
    if (token !== this.turnToken || !t || !PKGame.betting.includes(t.phase)) return;
    const seat = t.toAct;
    if (seat < 0 || this.controller(seat) !== 'human') return;
    const lg = legalActions(t, seat);
    if (!lg.canAct) return;
    // hết giờ: xem bài nếu được, không thì bỏ bài (không bao giờ tự theo)
    const r = applyAction(t, seat, lg.canCheck ? { type: 'check' } : { type: 'fold' });
    if (r.ok) this.after(r.events);
  }

  /** Ý định từ một người (khách hoặc chủ phòng). Luôn kiểm tra lại, không tin dữ liệu gửi tới. */
  intent(slot: number, p: any): IntentResult {
    if (!p || typeof p !== 'object' || typeof p.type !== 'string') return 'bad';
    if (!Number.isInteger(slot) || slot < 0 || slot >= this.settings.n || !this.slots[slot].human) return 'forbidden';
    switch (p.type) {
      case 'action': {
        const a = p.action;
        if (!a || typeof a !== 'object' || typeof a.type !== 'string' || !ACTION_TYPES.includes(a.type)) return 'bad';
        let amount: number | undefined;
        if (a.type === 'raise') {
          if (typeof a.amount !== 'number' || !Number.isSafeInteger(a.amount) || a.amount <= 0 || a.amount > 1e9) return 'bad';
          amount = a.amount;
        } else if (a.amount !== undefined && (typeof a.amount !== 'number' || !Number.isFinite(a.amount))) return 'bad';
        const t = this.t;
        if (this.phase !== 'table' || !t || !PKGame.betting.includes(t.phase)) return 'phase';
        if (t.toAct !== slot || this.controller(slot) !== 'human') return 'notTurn';
        const r = applyAction(t, slot, amount !== undefined ? { type: 'raise', amount } : { type: a.type as Action['type'] });
        if (!r.ok) return 'illegal';
        this.after(r.events);
        return 'ok';
      }
      case 'restart': {
        if (slot !== 0) return 'forbidden';
        if (this.phase !== 'table') return 'phase';
        this.restartNow();
        return 'ok';
      }
      default: return 'bad';
    }
  }

  // ---------- Bản xem gửi cho từng người ----------
  stateFor(slot: number): NetState {
    const n = this.settings.n;
    const slots: PubSlot[] = this.slots.slice(0, n).map((s, i) => ({
      name: s.name, kind: s.human ? 'human' : 'bot', online: s.online, replaced: s.human && s.replaced, host: i === 0, profile: this.profileOf(i),
    }));
    const t = this.t;
    const view = t && this.phase === 'table' && slot >= 0 && slot < n ? viewFor(t, slot) : null;
    const over = !!t && t.phase === 'game_over';
    let winner = -1;
    if (over && t) { const alive = t.seats.filter((s) => s.stack > 0 && !s.busted); winner = alive.length === 1 ? alive[0].id : -1; }
    return {
      seq: this.seq, code: this.code, phase: this.phase, settings: { ...this.settings }, slots, mySlot: slot, view,
      turnMs: this.deadline ? Math.max(0, this.deadline - this.clock.now()) : null,
      turnTotal: this.deadline ? this.settings.timer * 1000 : 0,
      nextMs: this.nextAt ? Math.max(0, this.nextAt - this.clock.now()) : null,
      evN: this.evN, events: this.events, gameOver: over, winner,
    };
  }
}

// ---------- Chủ phòng: nối PKGame với RoomHost ----------
export class PKNetHost {
  game: PKGame;
  room: RoomHost;
  closed = false;
  private constructor(tr: Transport, clock: Clock, hostName: string, code: string, botNames: string[] | undefined, private onHostState: (s: NetState) => void, rng?: () => number, botMs?: [number, number]) {
    this.game = new PKGame(clock, { code, botNames, rng, botMs, onChange: () => this.publish() });
    this.room = new RoomHost(tr, {
      canJoin: () => (this.game.phase === 'lobby' ? 'ok' : 'started'),
      limit: () => this.game.settings.n,
      onJoin: (m, re) => this.onJoin(m, re),
      onOnline: (m, on) => this.onOnline(m, on),
      onLeave: (m) => { this.game.clearHuman(m.slot); this.publish(); },
      onIntent: (m, p) => { this.game.intent(m.slot, p); },
    }, { code, hostName, clock, maxSlots: MAX_SEATS });
    this.game.setHuman(0, this.room.host.name, true);
  }
  /** Tạo phòng mới: thử vài mã cho tới khi một mã còn trống. */
  static async create(makeTransport: () => Transport, clock: Clock, hostName: string, onHostState: (s: NetState) => void, opts: { botNames?: string[]; rng?: () => number; botMs?: [number, number]; codeRng?: () => number } = {}): Promise<PKNetHost> {
    let lastErr: unknown = null;
    for (let i = 0; i < 6; i++) {
      const tr = makeTransport();
      const code = makeCode(opts.codeRng);
      const h = new PKNetHost(tr, clock, hostName, code, opts.botNames, onHostState, opts.rng, opts.botMs);
      try { await h.room.open(); h.publish(); return h; } catch (e) {
        lastErr = e; try { tr.close(); } catch {}
        if (!(e instanceof TransportError && e.code === 'unavailable-id')) break;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('create-failed');
  }
  private onJoin(m: Member, reconnect: boolean) {
    if (reconnect) this.game.markOnline(m.slot, true); else this.game.setHuman(m.slot, m.name, true);
    this.publish();
  }
  private onOnline(m: Member, on: boolean) {
    if (m.local) return;
    if (!on && this.game.phase === 'lobby') { this.room.removeMember(m, 'left'); return; }
    this.game.markOnline(m.slot, on);
    this.publish();
  }
  /** Gửi trạng thái mới nhất cho mọi người (chủ phòng nhận trực tiếp) */
  publish() {
    if (this.closed) return;
    for (const m of this.room.members) {
      if (m.local) this.onHostState(this.game.stateFor(m.slot));
      else if (m.online) this.room.send(m, this.game.stateFor(m.slot));
    }
  }
  get code() { return this.room.code; }
  intentHost(p: any) { return this.game.intent(0, p); }
  start() { const ok = this.game.start(); this.publish(); return ok; }
  setSettings(p: Partial<PKSettings>) { this.game.setSettings(p); this.publish(); }
  kick(slot: number) { const m = this.room.members.find((x) => x.slot === slot && !x.local); if (m) this.room.removeMember(m, 'kicked'); }
  close() { if (this.closed) return; this.closed = true; this.room.close('hostLeft'); }
}

// ---------- Khách ----------
const finite = (x: unknown) => typeof x === 'number' && Number.isFinite(x);
function validState(s: any): s is NetState {
  if (!s || typeof s !== 'object') return false;
  if (!['lobby', 'table'].includes(s.phase)) return false;
  if (!Array.isArray(s.slots) || s.slots.length < 2 || s.slots.length > MAX_SEATS) return false;
  if (!s.settings || typeof s.settings !== 'object' || !Number.isInteger(s.mySlot)) return false;
  for (const x of s.slots) if (!x || typeof x.name !== 'string' || x.name.length > 40 || (x.kind !== 'human' && x.kind !== 'bot')) return false;
  if (s.phase === 'table') {
    const v = s.view;
    if (!v || typeof v !== 'object' || !Array.isArray(v.seats) || v.seats.length !== s.slots.length || !Array.isArray(v.board) || v.board.length > 5) return false;
    if (!v.legal || typeof v.legal !== 'object' || !finite(v.pot) || !finite(v.toAct) || !finite(v.currentBet) || !finite(v.bb)) return false;
    for (const x of v.seats) if (!x || typeof x.name !== 'string' || !finite(x.stack) || !finite(x.bet)) return false;
    if (!Array.isArray(s.events)) return false;
  }
  return true;
}

export class PKNetClient {
  rc: RoomClient;
  state: NetState | null = null;
  info: JoinInfo | null = null;
  constructor(factory: () => Transport, private hooks: { onState(s: NetState): void; onStatus(st: 'online' | 'lost'): void; onClosed(r: RejectReason): void }, clock: Clock = realClock, opts: ConstructorParameters<typeof RoomClient>[3] = {}) {
    this.rc = new RoomClient(factory, {
      onGame: (p) => { if (validState(p) && (!this.state || p.seq >= this.state.seq || p.phase !== this.state.phase || p.evN !== this.state.evN)) { this.state = p; this.hooks.onState(p); } },
      onStatus: (s) => this.hooks.onStatus(s),
      onClosed: (r) => this.hooks.onClosed(r),
    }, clock, opts);
  }
  async join(code: string, name: string, token = ''): Promise<JoinInfo> {
    const c = normCode(code);
    this.info = await this.rc.join(c, name, token);
    return this.info;
  }
  act(action: Action) { this.rc.send({ type: 'action', action }); }
  leave() { this.rc.leave(); }
  get status() { return this.rc.status; }
}

export { BLINDS };
