// Xì dách chơi online: XDGame (máy chủ phòng chạy luật, là nguồn sự thật duy nhất), XDNetHost và XDNetClient.
// Ghế = chỗ ngồi trong ván (0 là chủ phòng), chỗ không có người do máy chơi. Khách chỉ gửi ý định (cược, rút, dằn, xét),
// mỗi người nhận một bản xem riêng: bài chưa được lật là -1.
import { deal, draw, stand, check, legal, botAction, apply, capDeltas, type XDState } from './xidachEngine';
import { RoomHost, RoomClient, makeCode, normCode, sanitizeName, realClock, type Clock, type Member, type RejectReason, type JoinInfo } from './net/room';
import { TransportError, type Transport } from './net/transport';

export const TURN_MS = 30000;   // thời gian mỗi lượt và thời gian đặt cược (nếu chủ phòng bật đồng hồ)
export const GRACE_MS = 60000;  // mất mạng quá lâu thì máy chơi thay đến hết ván
export const SEATS = 8;
export const START_CHIPS = 1000;

export interface XDSettings { n: number; timer: boolean }
export interface XDSlot { name: string; human: boolean; online: boolean; replaced: boolean; host: boolean }
export interface XDNetState {
  game: 'xd'; seq: number; code: string; phase: 'lobby' | 'bet' | 'playing'; settings: XDSettings; slots: XDSlot[]; mySlot: number;
  dealer: number; round: number; chips: number[];
  bets: number[];          // cược đã đặt cho ván sắp tới (0 = chưa đặt)
  view: XDState | null;    // ván đang chơi, hoặc ván vừa xong khi đang đặt cược
  turnMs: number | null;
}

const isNatural = (k: string) => k === 'xibang' || k === 'xidach';

/** Bản xem của một người: giấu bài chưa lật, giấu bộ bài còn lại, giấu điểm cái khi cái chưa ngửa bài. */
export function viewFor(st: XDState, seat: number): XDState {
  // cái ngửa bài khi hết ván hoặc đã xét ai đó (xì bàng, xì dách của nhà con ngửa ngay thì chưa tính là xét)
  const dealerOpen = st.phase === 'done' || st.settled.some((r) => !!r && !isNatural(r.player.kind));
  const visible = (s: number) => s === seat || (s === st.dealer ? dealerOpen : !!st.settled[s]);
  return {
    ...st,
    hands: st.hands.map((h, s) => (visible(s) ? h.slice() : h.map(() => -1))),
    deck: st.deck.map(() => -1),
    bets: st.bets.slice(), stood: st.stood.slice(), deltas: st.deltas.slice(),
    settled: st.settled.map((r) => (r ? { ...r, player: { ...r.player }, dealer: dealerOpen ? { ...r.dealer } : { total: 0, kind: 'points' as const } } : null)),
  };
}

interface GSlot { human: boolean; name: string; online: boolean; replaced: boolean; offlineAt: number }
const BOT_NAMES = ['Tài', 'An', 'Bình', 'Chi', 'Dũng', 'Hà', 'Khoa', 'Linh'];

export type IntentResult = 'ok' | 'bad' | 'notTurn' | 'illegal' | 'phase' | 'forbidden';

export class XDGame {
  settings: XDSettings = { n: 6, timer: true };
  phase: 'lobby' | 'bet' | 'playing' = 'lobby';
  slots: GSlot[];
  chips: number[] = new Array(SEATS).fill(START_CHIPS);
  bets: number[] = new Array(SEATS).fill(0);
  private lastBet: number[] = new Array(SEATS).fill(10);
  dealer = 0;
  round = 0;
  st: XDState | null = null;
  seq = 0;
  private token = 0;
  private deadline = 0;
  private stopTimer: (() => void) | null = null;
  readonly rng: () => number;
  constructor(public clock: Clock = realClock, private opts: { rng?: () => number; botMs?: [number, number]; code?: string; onChange?: () => void; animMs?: number } = {}) {
    this.rng = opts.rng || Math.random;
    this.slots = BOT_NAMES.map((name) => ({ human: false, name, online: true, replaced: false, offlineAt: 0 }));
  }
  private notify() { this.seq++; this.opts.onChange?.(); }
  /** thời gian chờ cho hiệu ứng trên máy mọi người (animMs = 0 khi thử tự động) */
  private anim(ms: number) { return this.opts.animMs ?? ms; }

  // ---------- người và máy ----------
  controller(slot: number): 'human' | 'bot' { const s = this.slots[slot]; return s && s.human && !s.replaced ? 'human' : 'bot'; }
  setHuman(slot: number, name: string) {
    const s = this.slots[slot]; if (!s) return;
    Object.assign(s, { human: true, name: sanitizeName(name), online: true, replaced: false, offlineAt: 0 });
    this.chips[slot] = START_CHIPS; this.lastBet[slot] = 10; this.bets[slot] = 0;
    this.notify();
  }
  clearHuman(slot: number) {
    const s = this.slots[slot]; if (!s) return;
    Object.assign(s, { human: false, name: BOT_NAMES[slot], online: true, replaced: false, offlineAt: 0 });
    this.bets[slot] = 0;
    if (this.phase === 'playing' && this.st?.turn === slot) this.scheduleTurn(0);
    this.notify();
    this.maybeDeal();
  }
  /** người chơi bấm rời giữa ván: giữ ghế, máy đánh thay ngay cho tới khi họ vào lại */
  away(slot: number) {
    this.markOnline(slot, false);
    const s = this.slots[slot]; if (!s || !s.human) return;
    s.replaced = true;
    if (this.phase === 'playing' && this.st?.turn === slot) this.scheduleTurn(0);
    this.notify();
    this.maybeDeal();
  }
  markOnline(slot: number, on: boolean) {
    const s = this.slots[slot]; if (!s || !s.human || s.online === on) return;
    s.online = on;
    if (!on) {
      const at = this.clock.now(); s.offlineAt = at;
      this.clock.after(() => {
        if (s.human && !s.online && s.offlineAt === at && this.phase === 'playing' && !s.replaced) {
          s.replaced = true;
          if (this.st?.turn === slot) this.scheduleTurn(0);
          this.notify();
        }
      }, GRACE_MS);
    } else { s.offlineAt = 0; s.replaced = false; if (this.phase === 'playing' && this.st?.turn === slot) this.scheduleTurn(0); }
    this.notify();
    this.maybeDeal();
  }
  maxHumanSlot() { return this.slots.reduce((m, s, i) => (s.human ? i : m), 0); }

  // ---------- sảnh, cái, cược ----------
  setSettings(p: Partial<XDSettings>) {
    if (this.phase !== 'lobby') return;
    const n = Number(p.n);
    if (Number.isInteger(n) && n >= 2 && n <= SEATS) this.settings.n = Math.max(n, this.maxHumanSlot() + 1);
    if (p.timer !== undefined) this.settings.timer = !!p.timer;
    this.notify();
  }
  start(): boolean {
    if (this.phase !== 'lobby') return false;
    this.chips = new Array(SEATS).fill(START_CHIPS); this.dealer = 0; this.round = 0; this.st = null;
    this.openBetting(0);
    this.notify();
    return true;
  }
  setDealer(slot: number): boolean {
    if (this.phase !== 'bet' || !Number.isInteger(slot) || slot < 0 || slot >= this.settings.n || slot === this.dealer) return false;
    this.dealer = slot;
    this.openBetting(0);
    this.notify();
    return true;
  }
  /** những người cần đặt cược trước khi chia */
  needBet(): number[] {
    return Array.from({ length: this.settings.n }, (_, i) => i).filter((i) => i !== this.dealer && this.controller(i) === 'human' && this.slots[i].online);
  }
  private openBetting(pause: number) {
    this.phase = 'bet';
    this.token++; this.stopTimer?.(); this.stopTimer = null; this.deadline = 0;
    this.bets.fill(0);
    for (const s of this.slots) s.replaced = false;
    // hết giờ đặt cược thì chia luôn, ai chưa đặt dùng mức cũ
    if (this.settings.timer && this.needBet().length) {
      const token = this.token;
      this.deadline = this.clock.now() + pause + TURN_MS;
      this.stopTimer = this.clock.after(() => { if (token === this.token && this.phase === 'bet') this.dealRound(); }, pause + TURN_MS);
    }
  }
  private maybeDeal() {
    if (this.phase !== 'bet') return;
    const need = this.needBet();
    if (need.length && need.every((i) => this.bets[i] > 0)) this.dealRound();
  }

  // ---------- ván ----------
  private dealRound() {
    const n = this.settings.n;
    if (this.dealer >= n) this.dealer = 0;
    const bets = new Array(n).fill(0) as number[];
    for (let i = 0; i < n; i++) {
      const s = this.slots[i];
      s.replaced = s.human && !s.online;
      if (this.chips[i] <= 0) this.chips[i] = START_CHIPS; // hết chip thì được phát lại
      if (i === this.dealer) continue;
      const want = this.controller(i) === 'bot' ? [10, 20, 50][Math.floor(this.rng() * 3)] : this.bets[i] || this.lastBet[i];
      bets[i] = Math.max(1, Math.min(want, this.chips[i]));
      if (s.human && this.bets[i] > 0) this.lastBet[i] = this.bets[i];
    }
    this.st = deal(n, this.dealer, bets, this.rng);
    this.phase = 'playing'; this.round++; this.bets.fill(0);
    this.token++; this.stopTimer?.(); this.stopTimer = null; this.deadline = 0;
    const pause = this.anim(1500 + n * 220);
    if (this.st.phase === 'done') this.endRound(pause);
    else this.scheduleTurn(pause);
    this.notify();
  }
  private endRound(pause: number) {
    const st = this.st!, n = st.n;
    st.deltas = capDeltas(st.deltas, this.chips.slice(0, n), st.dealer);
    st.deltas.forEach((d, i) => { this.chips[i] += d; });
    this.openBetting(pause);
  }
  private scheduleTurn(pause: number) {
    const st = this.st;
    this.token++; this.stopTimer?.(); this.stopTimer = null; this.deadline = 0;
    if (!st || st.phase === 'done' || this.phase !== 'playing') return;
    const token = this.token, seat = st.turn;
    if (this.controller(seat) === 'bot') {
      const [a, b] = this.opts.botMs || [700, 1300];
      this.stopTimer = this.clock.after(() => this.autoAct(token, false), pause + a + this.rng() * (b - a));
    } else if (this.settings.timer) {
      this.deadline = this.clock.now() + pause + TURN_MS;
      this.stopTimer = this.clock.after(() => this.autoAct(token, true), pause + TURN_MS);
    }
  }
  private autoAct(token: number, timeout: boolean) {
    const st = this.st;
    if (token !== this.token || !st || st.phase === 'done' || this.phase !== 'playing') return;
    const seat = st.turn;
    // hết giờ: đủ tuổi thì dằn, chưa đủ thì rút
    this.act(() => (timeout ? (legal(st, seat).stand ? stand(st, seat) : draw(st, seat)) : apply(st, seat, botAction(st, seat, this.rng))));
  }
  /** chạy một nước đi rồi chờ cho mọi máy xem xong bài vừa xét */
  private act(move: () => boolean): boolean {
    const st = this.st!;
    const before = st.settled.map(Boolean);
    if (!move()) return false;
    let pause = 0;
    st.settled.forEach((r, i) => { if (r && !before[i]) pause += 4500 + (st.hands[i].length - 1) * 1100; });
    pause = this.anim(pause);
    if (st.phase === 'done') this.endRound(pause);
    else this.scheduleTurn(pause);
    this.notify();
    return true;
  }

  /** Ý định từ một người. Luôn kiểm tra lại, không tin dữ liệu gửi tới. */
  intent(slot: number, p: any): IntentResult {
    if (!p || typeof p !== 'object' || typeof p.type !== 'string') return 'bad';
    if (!Number.isInteger(slot) || slot < 0 || slot >= this.settings.n || !this.slots[slot].human) return 'forbidden';
    const st = this.st;
    switch (p.type) {
      case 'bet': {
        if (this.phase !== 'bet') return 'phase';
        if (slot === this.dealer) return 'forbidden';
        const v = p.amount;
        if (!Number.isInteger(v) || v < 1) return 'bad';
        this.bets[slot] = Math.min(v, this.chips[slot] > 0 ? this.chips[slot] : START_CHIPS);
        this.notify();
        this.maybeDeal();
        return 'ok';
      }
      case 'draw': case 'stand': case 'check': {
        if (this.phase !== 'playing' || !st || st.phase === 'done') return 'phase';
        if (st.turn !== slot || this.controller(slot) !== 'human') return 'notTurn';
        if (p.type === 'check' && (!Number.isInteger(p.target) || slot !== st.dealer)) return 'bad';
        return this.act(() => (p.type === 'draw' ? draw(st, slot) : p.type === 'stand' ? stand(st, slot) : check(st, p.target))) ? 'ok' : 'illegal';
      }
      case 'deal': {
        if (slot !== 0) return 'forbidden';
        if (this.phase !== 'bet') return 'phase';
        this.dealRound();
        return 'ok';
      }
      case 'dealer': {
        if (slot !== 0) return 'forbidden';
        return this.setDealer(p.slot) ? 'ok' : 'illegal';
      }
      default: return 'bad';
    }
  }

  stateFor(slot: number): XDNetState {
    const n = this.settings.n;
    return {
      game: 'xd', seq: this.seq, code: this.opts.code || '', phase: this.phase, settings: { ...this.settings },
      slots: this.slots.slice(0, n).map((s, i) => ({ name: s.name, human: s.human, online: s.online, replaced: s.human && s.replaced, host: i === 0 })),
      mySlot: slot, dealer: this.dealer, round: this.round, chips: this.chips.slice(0, n), bets: this.bets.slice(0, n),
      view: this.st && this.st.n === n && this.phase !== 'lobby' ? viewFor(this.st, slot) : null,
      turnMs: this.deadline ? Math.max(0, this.deadline - this.clock.now()) : null,
    };
  }
}

// ---------- chủ phòng ----------
export class XDNetHost {
  game!: XDGame;
  room: RoomHost;
  closed = false;
  private constructor(tr: Transport, clock: Clock, hostName: string, code: string, private onHostState: (s: XDNetState) => void) {
    this.game = new XDGame(clock, { code, onChange: () => this.publish() });
    this.room = new RoomHost(tr, {
      canJoin: () => (this.game.phase === 'lobby' ? 'ok' : 'started'),
      limit: () => this.game.settings.n,
      onJoin: (m, re) => { if (re) this.game.markOnline(m.slot, true); else this.game.setHuman(m.slot, m.name); this.publish(); },
      onOnline: (m, on) => this.onOnline(m, on),
      onLeave: (m) => { this.game.clearHuman(m.slot); this.publish(); },
      onAway: (m) => { this.game.away(m.slot); this.publish(); },
      onIntent: (m, p) => { this.game.intent(m.slot, p); },
    }, { code, hostName, clock, maxSlots: SEATS });
    this.game.setHuman(0, this.room.host.name);
  }
  /** Tạo phòng mới: thử vài mã cho tới khi một mã còn trống. */
  static async create(makeTransport: () => Transport, hostName: string, onHostState: (s: XDNetState) => void, clock: Clock = realClock): Promise<XDNetHost> {
    let lastErr: unknown = null;
    for (let i = 0; i < 6; i++) {
      const tr = makeTransport();
      const h = new XDNetHost(tr, clock, hostName, makeCode(), onHostState);
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
  send(p: any) { return this.game.intent(0, p); }
  start() { this.game.start(); this.publish(); }
  setSettings(p: Partial<XDSettings>) { this.game.setSettings(p); this.publish(); }
  close() { if (this.closed) return; this.closed = true; this.room.close('hostLeft'); }
}

// ---------- khách ----------
const int = (v: unknown) => Number.isInteger(v);
const ints = (a: unknown, len: number) => Array.isArray(a) && a.length === len && a.every(int);
const KINDS = ['xibang', 'xidach', 'ngulinh', 'points', 'quac'];
const okValue = (v: any) => !!v && int(v.total) && KINDS.includes(v.kind);

/** Không tin dữ liệu từ máy chủ phòng: mọi thứ sẽ đưa lên trang phải đúng kiểu. Tên được làm sạch lại. */
export function validState(s: any): XDNetState | null {
  if (!s || typeof s !== 'object' || s.game !== 'xd' || !['lobby', 'bet', 'playing'].includes(s.phase)) return null;
  const n = s.settings?.n;
  if (!int(n) || n < 2 || n > SEATS || !Array.isArray(s.slots) || s.slots.length !== n) return null;
  if (!int(s.seq) || !int(s.mySlot) || s.mySlot < 0 || s.mySlot >= n || !int(s.dealer) || s.dealer < 0 || s.dealer >= n || !int(s.round)) return null;
  if (!ints(s.chips, n) || !ints(s.bets, n) || (s.turnMs !== null && typeof s.turnMs !== 'number')) return null;
  const v = s.view;
  if (v !== null) {
    if (!v || typeof v !== 'object' || v.n !== n || !int(v.dealer) || !int(v.turn) || !['players', 'dealer', 'done'].includes(v.phase)) return null;
    if (!Array.isArray(v.hands) || v.hands.length !== n || !v.hands.every((h: any) => Array.isArray(h) && h.length <= 5 && h.every((c: any) => int(c) && c >= -1 && c < 52))) return null;
    if (!Array.isArray(v.deck) || v.deck.length > 52 || !ints(v.bets, n) || !ints(v.deltas, n)) return null;
    if (!Array.isArray(v.stood) || v.stood.length !== n || !Array.isArray(v.settled) || v.settled.length !== n) return null;
    if (!v.settled.every((r: any) => r === null || (r && [1, 0, -1].includes(r.result) && int(r.delta) && int(r.mult) && okValue(r.player) && okValue(r.dealer)))) return null;
  } else if (s.phase === 'playing') return null;
  return {
    ...s,
    code: normCode(String(s.code || '')),
    slots: s.slots.map((x: any) => ({ name: sanitizeName(x?.name), human: !!x?.human, online: !!x?.online, replaced: !!x?.replaced, host: !!x?.host })),
  } as XDNetState;
}

export class XDNetClient {
  rc: RoomClient;
  private seq = -1;
  info: JoinInfo | null = null;
  constructor(factory: () => Transport, hooks: { onState(s: XDNetState): void; onStatus(st: 'online' | 'lost'): void; onClosed(r: RejectReason): void }, clock: Clock = realClock) {
    this.rc = new RoomClient(factory, {
      onGame: (p) => {
        const s = validState(p);
        if (!s) { if (p && p.game !== 'xd') { this.rc.leave(); hooks.onClosed('badmsg'); } return; } // mã phòng của trò khác
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
  send(p: any) { this.rc.send(p); }
  leave() { this.rc.leave(); }
}
