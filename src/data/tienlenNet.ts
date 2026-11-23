// Tiến lên miền Nam: bộ điều khiển ván (TLGame) và phần nối mạng (TLNetHost, TLNetClient).
// TLGame chạy luật bằng engine có sẵn (tienlenEngine, tienlenScore, tienlenBot) và là nguồn sự thật duy nhất.
// Chơi với máy một mình dùng thẳng TLGame; chơi online thì chủ phòng chạy TLGame và gửi cho từng khách
// bản xem riêng (stateFor) của họ. Khách chỉ gửi ý định: đánh, bỏ lượt, sẵn sàng.
import { newGame, play, pass, viewFor, victimKey, type TLState, type View, type WhiteKind } from './tienlenEngine';
import { botDecide } from './tienlenBot';
import { newSession, dealHand, finishHand, activePlayers, type Session, newPointSession, dealHandPoints, finishHandPoints, endPointSession, clampTarget, type PointSession, type PointsOver } from './tienlenScore';
import { RoomHost, RoomClient, makeCode, normCode, sanitizeName, realClock, type Clock, type Member, type RejectReason, type JoinInfo } from './net/room';
import { TransportError, type Transport } from './net/transport';

export const TURN_MS = 30000;    // thời gian mỗi lượt (chơi online, nếu chủ phòng bật đồng hồ)
export const GRACE_MS = 60000;   // mất mạng quá lâu thì máy chơi thay đến hết ván

export type PlayMode = 'chips' | 'single' | 'points';
// target: chỉ dùng ở chế độ 'points' (0 = không đặt đích)
export interface NetSettings { n: number; mode: PlayMode; stack: number; unit: number; level: number; timer: boolean; target: number }
export const DEFAULTS: NetSettings = { n: 4, mode: 'chips', stack: 1000, unit: 10, level: 2, timer: true, target: 100 };

export interface PubSlot { name: string; kind: 'human' | 'bot'; online: boolean; replaced: boolean; host: boolean; ready: boolean }
export interface ResItem { kind: 'hand' | 'chop' | 'white'; from: number; to: number; due: number; paid: number; units: number; cards?: number; burned?: boolean; black?: number; red?: number }
// Kết quả ván ở chế độ tính điểm (chỉ số theo ghế = số chỗ ngồi vì luôn 4 người)
export interface PtsResultItem { from: number; to: number; val: number; key: string; cards: number[]; chain: number; self: boolean }
export interface PtsResult { rank: number[]; chop: number[]; items: PtsResultItem[]; totals: number[]; target: number; over: PointsOver }
export interface NetResult {
  deltas: number[]; items: ResItem[]; winner: number; white: WhiteKind | null; burned: boolean[];
  order: number[]; hands: Record<string, number[]>; chops: { chopper: number; victim: number }[];
  sessionOver: boolean; sessionWinner: number; pts?: PtsResult;
}
// vc / vk: với sự kiện chặt, các lá và loại bộ bị chặt (công khai, dùng để hiện điểm chặt)
export interface NetEvent { n: number; kind: 'deal' | 'play' | 'chop' | 'pass' | 'timeout'; slot: number; cards?: number[]; vc?: number[]; vk?: string }
export interface NetState {
  seq: number; code: string; phase: 'lobby' | 'playing' | 'result'; settings: NetSettings; slots: PubSlot[]; mySlot: number;
  hand: number; seats: number[]; mySeat: number; view: View | null; stacks: number[] | null;
  points: { totals: number[]; target: number; lastDeltas: number[] } | null;
  turnMs: number | null; ev: NetEvent | null; result: NetResult | null;
}

interface GSlot { human: boolean; name: string; online: boolean; replaced: boolean; offlineAt: number }
const BOT_NAMES = ['An', 'Mai', 'Cường', 'Hà'];
const clampInt = (v: unknown, lo: number, hi: number, d: number) => { const x = Number(v); return Number.isInteger(x) && x >= lo && x <= hi ? x : d; };

export type IntentResult = 'ok' | 'bad' | 'notTurn' | 'illegal' | 'phase' | 'forbidden';

export class TLGame {
  settings: NetSettings = { ...DEFAULTS };
  phase: 'lobby' | 'playing' | 'result' = 'lobby';
  slots: GSlot[];
  sess: Session | null = null;
  psess: PointSession | null = null;
  st: TLState | null = null;
  seats: number[] = [];
  hand = 0;
  lastWinner = -1;
  ready = new Set<number>();
  result: NetResult | null = null;
  ev: NetEvent | null = null;
  seq = 0;
  private evN = 0;
  private turnToken = 0;
  private deadline = 0;
  private advTimer: (() => void) | null = null;
  readonly rng: () => number;
  readonly botNames: string[];
  code: string;
  constructor(public clock: Clock = realClock, private opts: { rng?: () => number; botMs?: [number, number]; botNames?: string[]; code?: string; onChange?: () => void } = {}) {
    this.rng = opts.rng || Math.random;
    this.botNames = opts.botNames && opts.botNames.length >= 4 ? opts.botNames : BOT_NAMES;
    this.code = opts.code || '';
    this.slots = [0, 1, 2, 3].map((i) => ({ human: false, name: this.botNames[i], online: true, replaced: false, offlineAt: 0 }));
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
    this.ready.delete(slot);
    if (this.phase === 'playing') this.scheduleTurn(); // máy lên thay nếu đang tới lượt ghế này
    this.maybeAdvance();
    this.notify();
  }
  humanSlots(): number[] { return this.slots.slice(0, this.settings.n).map((s, i) => (s.human ? i : -1)).filter((i) => i >= 0); }
  maxHumanSlot(): number { return Math.max(0, ...this.humanSlots()); }
  controller(slot: number): 'human' | 'bot' { const s = this.slots[slot]; return s && s.human && !s.replaced ? 'human' : 'bot'; }

  markOnline(slot: number, on: boolean) {
    const s = this.slots[slot]; if (!s || !s.human || s.online === on) return;
    s.online = on;
    if (!on) {
      const at = this.clock.now(); s.offlineAt = at;
      if (this.phase === 'playing') {
        this.clock.after(() => {
          const x = this.slots[slot];
          if (x && x.human && !x.online && x.offlineAt === at && this.phase === 'playing' && !x.replaced) {
            x.replaced = true;
            if (this.st && !this.st.over && this.seats[this.st.cur] === slot) this.scheduleTurn();
            this.notify();
          }
        }, GRACE_MS);
      }
    } else s.offlineAt = 0;
    this.maybeAdvance();
    this.notify();
  }

  // ---------- Cài đặt (chỉ trong sảnh) ----------
  setSettings(p: Partial<NetSettings>) {
    if (this.phase !== 'lobby') return;
    const o = this.settings;
    const n = clampInt(p.n ?? o.n, 2, 4, o.n);
    o.n = Math.max(n, this.maxHumanSlot() + 1, 2);
    if (p.mode === 'chips' || p.mode === 'single' || p.mode === 'points') o.mode = p.mode;
    if (p.target !== undefined) o.target = clampTarget(p.target, o.target);
    if (o.mode === 'points') o.n = 4; // chế độ tính điểm luôn 4 người (chỗ trống do máy chơi)
    if (p.stack !== undefined) o.stack = [500, 1000, 2000].includes(Number(p.stack)) ? Number(p.stack) : o.stack;
    if (p.unit !== undefined) o.unit = [5, 10, 20].includes(Number(p.unit)) ? Number(p.unit) : o.unit;
    if (p.level !== undefined) o.level = clampInt(p.level, 1, 3, o.level);
    if (p.timer !== undefined) o.timer = !!p.timer;
    this.notify();
  }

  // ---------- Bắt đầu và chia ván ----------
  start(): boolean {
    if (this.phase !== 'lobby') return false;
    if (this.settings.n < 2) return false;
    this.hand = 0; this.lastWinner = -1;
    this.sess = this.settings.mode === 'chips' ? newSession(this.settings.n, this.settings.stack, this.settings.unit) : null;
    this.psess = this.settings.mode === 'points' ? newPointSession(this.settings.target) : null;
    this.dealNext();
    return true;
  }
  /** Chơi lại từ đầu (đặt lại chip) */
  restartNow() {
    if (this.phase === 'lobby') return;
    this.hand = 0; this.lastWinner = -1;
    this.sess = this.settings.mode === 'chips' ? newSession(this.settings.n, this.settings.stack, this.settings.unit) : null;
    this.psess = this.settings.mode === 'points' ? newPointSession(this.settings.target) : null;
    this.dealNext();
  }
  toLobby() {
    this.turnToken++; this.advTimer?.(); this.advTimer = null;
    this.phase = 'lobby'; this.st = null; this.sess = null; this.psess = null; this.seats = []; this.result = null; this.ready.clear(); this.ev = null; this.hand = 0; this.deadline = 0;
    for (const s of this.slots) { s.replaced = false; }
    this.notify();
  }

  private dealNext() {
    this.advTimer?.(); this.advTimer = null;
    for (const s of this.slots) if (s.human) s.replaced = !s.online; // ai đang mất mạng thì máy chơi thay ngay
    const n = this.settings.n;
    if (this.settings.mode === 'chips' && this.sess) {
      const d = dealHand(this.sess, this.rng);
      this.st = d.st; this.seats = d.seats;
    } else if (this.settings.mode === 'points' && this.psess) {
      this.st = dealHandPoints(this.psess, this.rng); this.seats = [0, 1, 2, 3];
    } else {
      this.seats = Array.from({ length: n }, (_, i) => i);
      this.st = newGame(n, this.lastWinner, this.rng);
    }
    this.phase = 'playing'; this.result = null; this.ready.clear(); this.hand++;
    this.ev = { n: ++this.evN, kind: 'deal', slot: -1 };
    if (this.st.over) { this.endHand(); return; }
    this.scheduleTurn();
    this.notify();
  }

  // ---------- Lượt chơi ----------
  private scheduleTurn() {
    const st = this.st;
    this.turnToken++; this.deadline = 0;
    if (!st || st.over || this.phase !== 'playing') return;
    const token = this.turnToken;
    const slot = this.seats[st.cur];
    if (this.controller(slot) === 'bot') {
      const [a, b] = this.opts.botMs || [600, 1300];
      const delay = a + this.rng() * (b - a);
      this.clock.after(() => this.botAct(token), delay);
    } else if (this.settings.timer) {
      this.deadline = this.clock.now() + TURN_MS;
      this.clock.after(() => this.timeoutAct(token), TURN_MS);
    }
  }
  private botAct(token: number) {
    const st = this.st;
    if (token !== this.turnToken || !st || st.over || this.phase !== 'playing') return;
    const seat = st.cur, slot = this.seats[seat];
    if (this.controller(slot) !== 'bot') return;
    const mv = botDecide(viewFor(st, seat), this.settings.level, this.rng, this.settings.mode === 'chips', this.settings.mode === 'points');
    if ('pass' in mv) {
      if (!pass(st, seat).ok) { const low = Math.min(...st.hands[seat]); this.doPlay(seat, [low]); return; }
      this.ev = { n: ++this.evN, kind: 'pass', slot };
      this.afterMove();
    } else if (!this.doPlay(seat, mv.cards)) {
      const low = Math.min(...st.hands[seat]); this.doPlay(seat, [low]);
    }
  }
  private timeoutAct(token: number) {
    const st = this.st;
    if (token !== this.turnToken || !st || st.over || this.phase !== 'playing') return;
    const seat = st.cur, slot = this.seats[seat];
    if (this.controller(slot) !== 'human') return;
    if (st.table) {
      if (pass(st, seat).ok) { this.ev = { n: ++this.evN, kind: 'timeout', slot }; this.afterMove(); return; }
    }
    // đang dẫn bài mà hết giờ: đánh lá nhỏ nhất (không có lợi thế gì cho người bị hết giờ)
    const low = Math.min(...st.hands[seat]);
    this.doPlay(seat, [low], 'timeout');
  }
  private doPlay(seat: number, cards: number[], kind: 'play' | 'timeout' = 'play'): boolean {
    const st = this.st!, slot = this.seats[seat];
    const prevTable = st.table; // bộ bị chặt (nếu là chặt)
    const r = play(st, seat, cards);
    if (!r.ok) return false;
    this.ev = { n: ++this.evN, kind: kind === 'timeout' ? 'timeout' : r.chop ? 'chop' : 'play', slot, cards: r.combo.cards.slice() };
    if (r.chop && prevTable) { this.ev.vc = prevTable.cards.slice(); const k = victimKey(prevTable); if (k) this.ev.vk = k; }
    this.afterMove();
    return true;
  }
  private afterMove() {
    const st = this.st!;
    if (st.over) { this.endHand(); return; }
    this.scheduleTurn();
    this.notify();
  }

  /** Ý định từ một người (khách hoặc chủ phòng). Luôn kiểm tra lại, không tin dữ liệu gửi tới. */
  intent(slot: number, p: any): IntentResult {
    if (!p || typeof p !== 'object' || typeof p.type !== 'string') return 'bad';
    if (!Number.isInteger(slot) || slot < 0 || slot >= this.settings.n || !this.slots[slot].human) return 'forbidden';
    switch (p.type) {
      case 'play': {
        if (this.phase !== 'playing' || !this.st || this.st.over) return 'phase';
        const cards = p.cards;
        if (!Array.isArray(cards) || cards.length < 1 || cards.length > 13) return 'bad';
        const seen = new Set<number>();
        for (const c of cards) { if (!Number.isInteger(c) || c < 0 || c > 51 || seen.has(c)) return 'bad'; seen.add(c); }
        const seat = this.seats.indexOf(slot);
        if (seat < 0 || this.st.cur !== seat || this.controller(slot) !== 'human') return 'notTurn';
        return this.doPlay(seat, cards) ? 'ok' : 'illegal';
      }
      case 'pass': {
        if (this.phase !== 'playing' || !this.st || this.st.over) return 'phase';
        const seat = this.seats.indexOf(slot);
        if (seat < 0 || this.st.cur !== seat || this.controller(slot) !== 'human') return 'notTurn';
        if (!pass(this.st, seat).ok) return 'illegal';
        this.ev = { n: ++this.evN, kind: 'pass', slot };
        this.afterMove();
        return 'ok';
      }
      case 'ready': {
        if (this.phase !== 'result' || !this.result || this.result.sessionOver) return 'phase';
        this.ready.add(slot); this.maybeAdvance(); this.notify();
        return 'ok';
      }
      case 'endsession': {
        // Chế độ tính điểm: chủ phòng (hoặc người chơi một mình) kết thúc phiên giữa hai ván, người dẫn đầu thắng
        if (slot !== 0) return 'forbidden';
        if (this.phase !== 'result' || !this.result || this.result.sessionOver || this.settings.mode !== 'points' || !this.psess) return 'phase';
        endPointSession(this.psess);
        this.result.sessionOver = true; this.result.sessionWinner = this.psess.winner;
        if (this.result.pts) { this.result.pts.over = this.psess.over; }
        this.advTimer?.(); this.advTimer = null;
        this.notify();
        return 'ok';
      }
      case 'restart': {
        if (slot !== 0) return 'forbidden';
        if (this.phase === 'lobby') return 'phase';
        this.restartNow();
        return 'ok';
      }
      default: return 'bad';
    }
  }

  // ---------- Kết thúc ván và tính chip ----------
  private endHand() {
    const st = this.st!, seats = this.seats, n = this.settings.n;
    this.turnToken++; this.deadline = 0;
    const slotOf = (seat: number) => seats[seat];
    const deltas = new Array(n).fill(0) as number[];
    const burned = new Array(n).fill(false) as boolean[];
    let items: ResItem[] = [];
    let sessionOver = false, sessionWinner = -1;
    let pts: PtsResult | undefined;
    if (this.settings.mode === 'points' && this.psess) {
      const set = finishHandPoints(this.psess, st);
      set.deltas.forEach((d, seat) => { deltas[slotOf(seat)] = d; });
      pts = {
        rank: set.rank.slice(), chop: set.chop.slice(), totals: this.psess.totals.slice(), target: this.psess.target, over: this.psess.over,
        items: set.items.map((it) => ({ ...it, from: slotOf(it.from), to: slotOf(it.to), cards: it.cards.slice() })),
      };
      sessionOver = !!this.psess.over; sessionWinner = sessionOver ? slotOf(this.psess.winner) : -1;
    } else if (this.settings.mode === 'chips' && this.sess) {
      const set = finishHand(this.sess, st, seats);
      this.sess.over = '';
      set.deltas.forEach((d, seat) => { deltas[slotOf(seat)] = d; });
      set.burned.forEach((b, seat) => { burned[slotOf(seat)] = b; });
      items = set.items.map((it) => ({ ...it, from: slotOf(it.from), to: slotOf(it.to) }));
      const act = activePlayers(this.sess);
      const humansAlive = act.filter((i) => this.slots[i].human).length;
      if (act.length < 2 || humansAlive === 0) {
        sessionOver = true;
        sessionWinner = [...act].sort((a, b) => this.sess!.stacks[b] - this.sess!.stacks[a])[0] ?? -1;
      }
    } else {
      st.played.forEach((p, seat) => { burned[slotOf(seat)] = !st.white && p === 0 && seat !== st.winner; });
    }
    const hands: Record<string, number[]> = {};
    st.hands.forEach((h, seat) => { hands[String(slotOf(seat))] = h.slice(); });
    this.lastWinner = slotOf(st.winner);
    this.result = {
      deltas, items, winner: slotOf(st.winner), white: st.white ? st.white.kind : null, burned,
      order: st.order.map(slotOf), hands, chops: st.chops.map((c) => ({ chopper: slotOf(c.chopper), victim: slotOf(c.victim) })),
      sessionOver, sessionWinner, ...(pts ? { pts } : {}),
    };
    this.phase = 'result'; this.ready.clear();
    this.maybeAdvance();
    this.notify();
  }

  private needReady(i: number): boolean {
    const s = this.slots[i];
    if (!s || !s.human || !s.online) return false;
    return this.settings.mode === 'single' || !this.sess || this.sess.stacks[i] > 0;
  }
  /** Ván tiếp bắt đầu khi mọi người đang online (còn chip) đã bấm sẵn sàng; không còn ai thì tự chia sau 2,5 giây. */
  maybeAdvance() {
    if (this.phase !== 'result' || !this.result || this.result.sessionOver) return;
    const need = this.humanSlots().filter((i) => this.needReady(i));
    if (need.every((i) => this.ready.has(i))) {
      if (need.length === 0) {
        if (!this.advTimer) this.advTimer = this.clock.after(() => { this.advTimer = null; if (this.phase === 'result' && !this.result?.sessionOver) this.dealNext(); }, 2500);
      } else this.dealNext();
    }
  }

  // ---------- Bản xem gửi cho từng người ----------
  stateFor(slot: number): NetState {
    const n = this.settings.n;
    const slots: PubSlot[] = this.slots.slice(0, n).map((s, i) => ({
      name: s.name, kind: s.human ? 'human' : 'bot', online: s.online, replaced: s.human && s.replaced, host: i === 0, ready: this.ready.has(i),
    }));
    let view: View | null = null, mySeat = -1;
    const st = this.st;
    if (st && this.phase !== 'lobby') {
      mySeat = this.seats.indexOf(slot);
      const base = viewFor(st, mySeat >= 0 ? mySeat : 0);
      // chỉ gửi vài nước gần nhất để tin nhắn nhỏ; người xem chỉ cần biết bàn hiện tại
      view = { ...base, log: base.log.slice(-6), seat: mySeat, hand: mySeat >= 0 ? base.hand : [] };
      if (!st.over) delete view.hands;
    }
    return {
      seq: this.seq, code: this.code, phase: this.phase, settings: { ...this.settings }, slots, mySlot: slot,
      hand: this.hand, seats: this.seats.slice(), mySeat, view, stacks: this.sess ? this.sess.stacks.slice(0, n) : null,
      points: this.psess ? { totals: this.psess.totals.slice(), target: this.psess.target, lastDeltas: this.psess.lastDeltas.slice() } : null,
      turnMs: this.deadline ? Math.max(0, this.deadline - this.clock.now()) : null,
      ev: this.ev, result: this.phase === 'result' ? this.result : null,
    };
  }
}

// ---------- Chủ phòng: nối TLGame với RoomHost ----------
export class TLNetHost {
  game: TLGame;
  room: RoomHost;
  closed = false;
  private constructor(private tr: Transport, clock: Clock, hostName: string, code: string, botNames: string[] | undefined, private onHostState: (s: NetState) => void, rng?: () => number, botMs?: [number, number]) {
    this.game = new TLGame(clock, { code, botNames, rng, botMs, onChange: () => this.publish() });
    this.room = new RoomHost(tr, {
      canJoin: () => (this.game.phase === 'lobby' ? 'ok' : 'started'),
      limit: () => this.game.settings.n,
      onJoin: (m, re) => this.onJoin(m, re),
      onOnline: (m, on) => this.onOnline(m, on),
      onLeave: (m) => { this.game.clearHuman(m.slot); this.publish(); },
      onIntent: (m, p) => { this.game.intent(m.slot, p); },
    }, { code, hostName, clock });
    this.game.setHuman(0, this.room.host.name, true);
  }
  /** Tạo phòng mới: thử vài mã cho tới khi một mã còn trống. */
  static async create(makeTransport: () => Transport, clock: Clock, hostName: string, onHostState: (s: NetState) => void, opts: { botNames?: string[]; rng?: () => number; botMs?: [number, number]; codeRng?: () => number } = {}): Promise<TLNetHost> {
    let lastErr: unknown = null;
    for (let i = 0; i < 6; i++) {
      const tr = makeTransport();
      const code = makeCode(opts.codeRng);
      const h = new TLNetHost(tr, clock, hostName, code, opts.botNames, onHostState, opts.rng, opts.botMs);
      try { await h.room.open(); h.publish(); return h; } catch (e) {
        lastErr = e; try { tr.close(); } catch {}
        if (!(e instanceof TransportError && e.code === 'unavailable-id')) break;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('create-failed');
  }
  private onJoin(m: Member, reconnect: boolean) {
    if (reconnect) { this.game.markOnline(m.slot, true); }
    else { this.game.setHuman(m.slot, m.name, true); }
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
  setSettings(p: Partial<NetSettings>) { this.game.setSettings(p); this.publish(); }
  kick(slot: number) { const m = this.room.members.find((x) => x.slot === slot && !x.local); if (m) this.room.removeMember(m, 'kicked'); }
  close() { if (this.closed) return; this.closed = true; this.room.close('hostLeft'); }
}

// ---------- Khách ----------
function validState(s: any): s is NetState {
  if (!s || typeof s !== 'object') return false;
  if (!['lobby', 'playing', 'result'].includes(s.phase)) return false;
  if (!Array.isArray(s.slots) || s.slots.length < 2 || s.slots.length > 4) return false;
  if (!s.settings || typeof s.settings !== 'object' || !Number.isInteger(s.mySlot)) return false;
  if (s.points != null && (typeof s.points !== 'object' || !Array.isArray(s.points.totals) || s.points.totals.length !== 4 || !s.points.totals.every((x: unknown) => typeof x === 'number'))) return false;
  for (const x of s.slots) if (!x || typeof x.name !== 'string' || x.name.length > 40) return false;
  if (s.phase !== 'lobby') {
    if (!Array.isArray(s.seats) || !s.view || typeof s.view !== 'object' || !Array.isArray(s.view.counts) || !Array.isArray(s.view.hand)) return false;
  }
  return true;
}

export class TLNetClient {
  rc: RoomClient;
  state: NetState | null = null;
  info: JoinInfo | null = null;
  constructor(factory: () => Transport, private hooks: { onState(s: NetState): void; onStatus(st: 'online' | 'lost'): void; onClosed(r: RejectReason): void }, clock: Clock = realClock, opts: ConstructorParameters<typeof RoomClient>[3] = {}) {
    this.rc = new RoomClient(factory, {
      onGame: (p) => { if (validState(p) && (!this.state || p.seq >= this.state.seq || p.phase !== this.state.phase || p.hand !== this.state.hand)) { this.state = p; this.hooks.onState(p); } },
      onStatus: (s) => this.hooks.onStatus(s),
      onClosed: (r) => this.hooks.onClosed(r),
    }, clock, opts);
  }
  async join(code: string, name: string, token = ''): Promise<JoinInfo> {
    const c = normCode(code);
    this.info = await this.rc.join(c, name, token);
    return this.info;
  }
  play(cards: number[]) { this.rc.send({ type: 'play', cards }); }
  pass() { this.rc.send({ type: 'pass' }); }
  ready() { this.rc.send({ type: 'ready' }); }
  leave() { this.rc.leave(); }
  get status() { return this.rc.status; }
}
