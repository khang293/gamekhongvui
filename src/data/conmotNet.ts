// "Còn Một!": CMGame chạy luật (chơi với máy dùng thẳng, chơi online thì máy chủ phòng chạy) và CMNetHost / CMNetClient.
// Ghế = chỗ ngồi (0 là chủ phòng hoặc người chơi một mình), chỗ không có người do máy chơi.
// Khách chỉ gửi ý định; mỗi người nhận bài của riêng mình và số lá của người khác.
import { newRound, play, draw, pass, call, catchOne, botMove, topCard, DECK, MAX_PLAYERS, type CMState } from './conmotEngine';
import { RoomHost, RoomClient, makeCode, normCode, sanitizeName, realClock, type Clock, type Member, type RejectReason, type JoinInfo } from './net/room';
import { TransportError, type Transport } from './net/transport';

export const TURN_MS = 30000;
export const GRACE_MS = 60000;

export interface CMSettings { n: number; timer: boolean }
export interface CMSlot { name: string; human: boolean; online: boolean; replaced: boolean; host: boolean; wins: number }
export interface CMView {
  hand: number[]; counts: number[]; recent: number[]; color: number; turn: number; dir: 1 | -1;
  pending: number; pendingKind: '' | 'd2' | 'd4'; drawn: number | null; drawCount: number; called: boolean[]; catchable: number; winner: number;
}
export type CMEventKind = 'deal' | 'play' | 'draw' | 'pass' | 'call' | 'catch';
export interface CMEvent { n: number; kind: CMEventKind; seat: number; card?: number; count?: number; penalty?: boolean; target?: number }
export interface CMNetState {
  game: 'cm'; seq: number; code: string; phase: 'lobby' | 'play' | 'over'; settings: CMSettings; slots: CMSlot[]; mySlot: number;
  round: number; view: CMView | null; turnMs: number | null; ev: CMEvent | null;
}

interface GSlot { human: boolean; name: string; online: boolean; replaced: boolean; offlineAt: number; wins: number }
export const BOT_NAMES = ['Gà', 'Mèo', 'Gấu Trúc', 'Cáo', 'Thỏ', 'Ếch', 'Cánh Cụt', 'Gấu'];
export type IntentResult = 'ok' | 'bad' | 'illegal' | 'phase' | 'forbidden';

export class CMGame {
  settings: CMSettings = { n: 4, timer: true };
  phase: 'lobby' | 'play' | 'over' = 'lobby';
  slots: GSlot[];
  st: CMState | null = null;
  round = 0;
  seq = 0;
  ev: CMEvent | null = null;
  private evN = 0;
  private lastWinner = 0;
  private token = 0;
  private deadline = 0;
  private stopTurn: (() => void) | null = null;
  private stopCatch: (() => void) | null = null;
  readonly rng: () => number;
  readonly names: string[];
  constructor(public clock: Clock = realClock, private opts: { rng?: () => number; code?: string; onChange?: () => void; botMs?: [number, number]; botNames?: string[]; timer?: boolean } = {}) {
    this.rng = opts.rng || Math.random;
    this.names = opts.botNames || BOT_NAMES;
    this.slots = Array.from({ length: MAX_PLAYERS }, (_, i) => ({ human: false, name: this.names[i], online: true, replaced: false, offlineAt: 0, wins: 0 }));
    if (opts.timer === false) this.settings.timer = false;
  }
  private notify() { this.seq++; this.opts.onChange?.(); }
  private emit(kind: CMEventKind, seat: number, extra: Partial<CMEvent> = {}) { this.ev = { n: ++this.evN, kind, seat, ...extra }; }
  controller(slot: number): 'human' | 'bot' { const s = this.slots[slot]; return s && s.human && !s.replaced ? 'human' : 'bot'; }
  maxHumanSlot() { return this.slots.reduce((m, s, i) => (s.human ? i : m), 0); }

  setHuman(slot: number, name: string) {
    const s = this.slots[slot]; if (!s) return;
    Object.assign(s, { human: true, name: sanitizeName(name), online: true, replaced: false, offlineAt: 0, wins: 0 });
    this.notify();
  }
  clearHuman(slot: number) {
    const s = this.slots[slot]; if (!s) return;
    Object.assign(s, { human: false, name: this.names[slot], online: true, replaced: false, offlineAt: 0, wins: 0 });
    if (this.phase === 'play' && this.st?.turn === slot) this.schedule(0);
    this.notify();
  }
  /** người chơi bấm rời giữa ván: giữ ghế, máy đánh thay ngay cho tới khi họ vào lại */
  away(slot: number) {
    this.markOnline(slot, false);
    const s = this.slots[slot]; if (!s || !s.human) return;
    s.replaced = true;
    if (this.phase === 'play' && this.st?.turn === slot) this.schedule(0);
    this.notify();
  }
  markOnline(slot: number, on: boolean) {
    const s = this.slots[slot]; if (!s || !s.human || s.online === on) return;
    s.online = on;
    if (!on) {
      const at = this.clock.now(); s.offlineAt = at;
      this.clock.after(() => {
        if (s.human && !s.online && s.offlineAt === at && this.phase === 'play' && !s.replaced) {
          s.replaced = true;
          if (this.st?.turn === slot) this.schedule(0);
          this.notify();
        }
      }, GRACE_MS);
    } else { s.offlineAt = 0; s.replaced = false; if (this.phase === 'play' && this.st?.turn === slot) this.schedule(0); }
    this.notify();
  }
  setSettings(p: Partial<CMSettings>) {
    if (this.phase !== 'lobby') return;
    const n = Number(p.n);
    if (Number.isInteger(n) && n >= 2 && n <= MAX_PLAYERS) this.settings.n = Math.max(n, this.maxHumanSlot() + 1);
    if (p.timer !== undefined) this.settings.timer = !!p.timer;
    this.notify();
  }
  start(): boolean {
    if (this.phase !== 'lobby') return false;
    for (const s of this.slots) s.wins = 0;
    this.round = 0; this.lastWinner = Math.floor(this.rng() * this.settings.n);
    this.deal();
    return true;
  }
  private deal() {
    for (const s of this.slots) s.replaced = s.human && !s.online;
    this.st = newRound(this.settings.n, this.lastWinner, this.rng);
    this.phase = 'play'; this.round++;
    this.stopCatch?.(); this.stopCatch = null;
    this.emit('deal', this.st.turn);
    this.schedule(2600); // chờ hiệu ứng chia bài
    this.notify();
  }

  private schedule(extra: number) {
    this.token++; this.stopTurn?.(); this.stopTurn = null; this.deadline = 0;
    const st = this.st;
    if (!st || st.over || this.phase !== 'play') return;
    const token = this.token, seat = st.turn;
    if (this.controller(seat) === 'bot') {
      const [a, b] = this.opts.botMs || [1100, 1900];
      // vừa có người quên hô: chậm lại để người khác kịp bắt
      const wait = extra + a + this.rng() * (b - a) + (st.catchable >= 0 && st.catchable !== seat ? 1800 : 0);
      this.stopTurn = this.clock.after(() => this.botAct(token), wait);
    } else if (this.settings.timer) {
      this.deadline = this.clock.now() + extra + TURN_MS;
      this.stopTurn = this.clock.after(() => this.timeout(token), extra + TURN_MS);
    }
  }
  private botAct(token: number) {
    const st = this.st;
    if (token !== this.token || !st || st.over || this.phase !== 'play') return;
    const seat = st.turn, m = botMove(st, seat, this.rng);
    if (m.type === 'play') { if (m.call) call(st, seat); this.doPlay(seat, m.card, m.color); }
    else if (m.type === 'draw') this.doDraw(seat);
    else this.doPass(seat);
  }
  private timeout(token: number) {
    const st = this.st;
    if (token !== this.token || !st || st.over || this.phase !== 'play') return;
    const seat = st.turn;
    if (st.drawn !== null) { this.doPass(seat); return; }
    this.doDraw(seat);
    if (this.st === st && st.turn === seat && st.drawn !== null) this.doPass(seat);
  }
  /** máy canh bắt người quên hô */
  private watchCatch() {
    this.stopCatch?.(); this.stopCatch = null;
    const st = this.st!;
    const target = st.catchable;
    if (target < 0) return;
    const bots = Array.from({ length: st.n }, (_, i) => i).filter((i) => i !== target && this.controller(i) === 'bot');
    if (!bots.length || this.rng() > 0.6) return;
    const by = bots[Math.floor(this.rng() * bots.length)];
    this.stopCatch = this.clock.after(() => { if (this.st === st && st.catchable === target) this.doCatch(by); }, 1700 + this.rng() * 900);
  }

  private doPlay(seat: number, card: number, color?: number): boolean {
    const st = this.st!;
    if (!play(st, seat, card, color)) return false;
    this.emit('play', seat, { card });
    if (st.over) {
      this.phase = 'over'; this.lastWinner = st.winner; this.slots[st.winner].wins++;
      this.token++; this.stopTurn?.(); this.stopCatch?.(); this.deadline = 0;
    } else { this.watchCatch(); this.schedule(0); }
    this.notify();
    return true;
  }
  private doDraw(seat: number): boolean {
    const r = draw(this.st!, seat, this.rng);
    if (!r) return false;
    this.emit('draw', seat, { count: r.cards.length, penalty: r.penalty });
    this.schedule(r.penalty ? 1200 : 0);
    this.notify();
    return true;
  }
  private doPass(seat: number): boolean {
    if (!pass(this.st!, seat)) return false;
    this.emit('pass', seat);
    this.schedule(0);
    this.notify();
    return true;
  }
  private doCatch(by: number): boolean {
    const target = catchOne(this.st!, by, this.rng);
    if (target < 0) return false;
    this.emit('catch', by, { target, count: 2 });
    this.schedule(900);
    this.notify();
    return true;
  }

  /** Ý định của một người. Luôn kiểm tra lại, không tin dữ liệu gửi tới. */
  intent(slot: number, p: any): IntentResult {
    if (!p || typeof p !== 'object' || typeof p.type !== 'string') return 'bad';
    if (!Number.isInteger(slot) || slot < 0 || slot >= this.settings.n || !this.slots[slot].human) return 'forbidden';
    if (p.type === 'next') {
      if (slot !== 0) return 'forbidden';
      if (this.phase !== 'over') return 'phase';
      this.deal();
      return 'ok';
    }
    const st = this.st;
    if (this.phase !== 'play' || !st || st.over) return 'phase';
    switch (p.type) {
      case 'play':
        if (!Number.isInteger(p.card) || p.card < 0 || p.card >= DECK.length) return 'bad';
        return this.controller(slot) === 'human' && this.doPlay(slot, p.card, p.color) ? 'ok' : 'illegal';
      case 'draw': return this.doDraw(slot) ? 'ok' : 'illegal';
      case 'pass': return this.doPass(slot) ? 'ok' : 'illegal';
      case 'call':
        if (!call(st, slot)) return 'illegal';
        this.stopCatch?.(); this.stopCatch = null;
        this.emit('call', slot);
        this.notify();
        return 'ok';
      case 'catch': return this.doCatch(slot) ? 'ok' : 'illegal';
      default: return 'bad';
    }
  }

  stateFor(slot: number): CMNetState {
    const n = this.settings.n, st = this.st;
    let view: CMView | null = null;
    if (st && this.phase !== 'lobby' && st.n === n) {
      view = {
        hand: (st.hands[slot] || []).slice(), counts: st.hands.map((h) => h.length), recent: st.discard.slice(-4),
        color: st.color, turn: st.turn, dir: st.dir, pending: st.pending, pendingKind: st.pendingKind,
        drawn: st.turn === slot ? st.drawn : null, drawCount: st.draw.length, called: st.called.slice(), catchable: st.catchable, winner: st.winner,
      };
    }
    // sự kiện rút bài không mang theo lá nào nên không lộ bài
    return {
      game: 'cm', seq: this.seq, code: this.opts.code || '', phase: this.phase, settings: { ...this.settings },
      slots: this.slots.slice(0, n).map((s, i) => ({ name: s.name, human: s.human, online: s.online, replaced: s.human && s.replaced, host: i === 0, wins: s.wins })),
      mySlot: slot, round: this.round, view, turnMs: this.deadline ? Math.max(0, this.deadline - this.clock.now()) : null, ev: this.ev,
    };
  }
}
export { topCard };

// ---------- chủ phòng ----------
export class CMNetHost {
  game!: CMGame;
  room: RoomHost;
  closed = false;
  private constructor(tr: Transport, clock: Clock, hostName: string, code: string, private onHostState: (s: CMNetState) => void, botNames?: string[]) {
    this.game = new CMGame(clock, { code, botNames, onChange: () => this.publish() });
    this.room = new RoomHost(tr, {
      canJoin: () => (this.game.phase === 'lobby' ? 'ok' : 'started'),
      limit: () => this.game.settings.n,
      onJoin: (m, re) => { if (re) this.game.markOnline(m.slot, true); else this.game.setHuman(m.slot, m.name); this.publish(); },
      onOnline: (m, on) => this.onOnline(m, on),
      onLeave: (m) => { this.game.clearHuman(m.slot); this.publish(); },
      onAway: (m) => { this.game.away(m.slot); this.publish(); },
      onIntent: (m, p) => { this.game.intent(m.slot, p); },
    }, { code, hostName, clock, maxSlots: MAX_PLAYERS });
    this.game.setHuman(0, this.room.host.name);
  }
  static async create(makeTransport: () => Transport, hostName: string, onHostState: (s: CMNetState) => void, botNames?: string[], clock: Clock = realClock): Promise<CMNetHost> {
    let lastErr: unknown = null;
    for (let i = 0; i < 6; i++) {
      const tr = makeTransport();
      const h = new CMNetHost(tr, clock, hostName, makeCode(), onHostState, botNames);
      try { await h.room.open(); h.publish(); return h; } catch (e) {
        lastErr = e; try { tr.close(); } catch {}
        if (!(e instanceof TransportError && e.code === 'unavailable-id')) break;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('create-failed');
  }
  private onOnline(m: Member, on: boolean) {
    if (m.local) return;
    if (!on && this.game.phase === 'lobby') { this.room.removeMember(m, 'left'); return; }
    this.game.markOnline(m.slot, on);
    this.publish();
  }
  publish() {
    if (this.closed || !this.room) return;
    for (const m of this.room.members) {
      if (m.local) this.onHostState(this.game.stateFor(m.slot));
      else if (m.online) this.room.send(m, this.game.stateFor(m.slot));
    }
  }
  get code() { return this.room.code; }
  send(p: unknown) { return this.game.intent(0, p); }
  start() { this.game.start(); this.publish(); }
  setSettings(p: Partial<CMSettings>) { this.game.setSettings(p); this.publish(); }
  close() { if (this.closed) return; this.closed = true; this.room.close('hostLeft'); }
}

// ---------- khách ----------
const int = (v: unknown, lo = -1e9, hi = 1e9) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
const cardId = (v: unknown) => int(v, 0, DECK.length - 1);
/** Không tin dữ liệu từ máy chủ phòng: kiểm tra kiểu mọi thứ sẽ đưa lên trang; tên được làm sạch lại. */
export function validState(s: any): CMNetState | null {
  if (!s || typeof s !== 'object' || s.game !== 'cm' || !['lobby', 'play', 'over'].includes(s.phase)) return null;
  const n = s.settings?.n;
  if (!int(n, 2, MAX_PLAYERS) || !Array.isArray(s.slots) || s.slots.length !== n) return null;
  if (!int(s.seq) || !int(s.mySlot, 0, n - 1) || !int(s.round, 0) || (s.turnMs !== null && typeof s.turnMs !== 'number')) return null;
  if (s.ev !== null && (!s.ev || !int(s.ev.n) || !['deal', 'play', 'draw', 'pass', 'call', 'catch'].includes(s.ev.kind) || !int(s.ev.seat, 0, n - 1)
    || (s.ev.card !== undefined && !cardId(s.ev.card)) || (s.ev.count !== undefined && !int(s.ev.count, 0, 108)) || (s.ev.target !== undefined && !int(s.ev.target, 0, n - 1)))) return null;
  const v = s.view;
  if (v !== null) {
    if (!v || !Array.isArray(v.hand) || v.hand.length > 108 || !v.hand.every(cardId)) return null;
    if (!Array.isArray(v.counts) || v.counts.length !== n || !v.counts.every((x: unknown) => int(x, 0, 108))) return null;
    if (!Array.isArray(v.recent) || !v.recent.length || v.recent.length > 4 || !v.recent.every(cardId)) return null;
    if (!int(v.color, 0, 3) || !int(v.turn, 0, n - 1) || (v.dir !== 1 && v.dir !== -1) || !int(v.pending, 0, 200) || !['', 'd2', 'd4'].includes(v.pendingKind)) return null;
    if ((v.drawn !== null && !cardId(v.drawn)) || !int(v.drawCount, 0, 108) || !Array.isArray(v.called) || v.called.length !== n || !int(v.catchable, -1, n - 1) || !int(v.winner, -1, n - 1)) return null;
  } else if (s.phase !== 'lobby') return null;
  return {
    ...s, code: normCode(String(s.code || '')),
    slots: s.slots.map((x: any) => ({ name: sanitizeName(x?.name), human: !!x?.human, online: !!x?.online, replaced: !!x?.replaced, host: !!x?.host, wins: int(x?.wins, 0) ? x.wins : 0 })),
  } as CMNetState;
}

export class CMNetClient {
  rc: RoomClient;
  private seq = -1;
  info: JoinInfo | null = null;
  constructor(factory: () => Transport, hooks: { onState(s: CMNetState): void; onStatus(st: 'online' | 'lost'): void; onClosed(r: RejectReason): void }, clock: Clock = realClock) {
    this.rc = new RoomClient(factory, {
      onGame: (p) => {
        const s = validState(p);
        if (!s) { if (p && p.game !== 'cm') { this.rc.leave(); hooks.onClosed('badmsg'); } return; }
        if (s.seq < this.seq) return;
        this.seq = s.seq; hooks.onState(s);
      },
      onStatus: (st) => { if (st === 'online') this.seq = -1; hooks.onStatus(st); },
      onClosed: (r) => hooks.onClosed(r),
    }, clock);
  }
  async join(code: string, name: string, token = ''): Promise<JoinInfo> {
    this.info = await this.rc.join(normCode(code), name, token);
    return this.info;
  }
  send(p: unknown) { this.rc.send(p); }
  leave() { this.rc.leave(); }
}
