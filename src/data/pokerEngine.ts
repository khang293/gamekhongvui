// Luật Texas Hold'em không giới hạn (/poker/), chạy thuần mã, không đụng DOM, chủ bàn quyết định mọi việc.
// Giao diện chỉ gọi applyAction() và đọc viewFor() (chỉ lộ bài của chính người xem). Sau này nối mạng thì máy chủ bàn chạy file này.
// Quy ước: ghế đánh theo chiều kim đồng hồ = chỉ số tăng dần. Số chip là số nguyên.
import { evaluate, handName } from './pokerEval';

export type Phase = 'idle' | 'preflop' | 'flop' | 'turn' | 'river' | 'showdown' | 'hand_over' | 'game_over';
export type ActionType = 'fold' | 'check' | 'call' | 'raise' | 'allin';
export interface Action { type: ActionType; amount?: number } // raise: amount = tổng tiền cược của vòng này ("tố tới")

export interface Seat {
  id: number; name: string; isBot: boolean; stack: number; hole: number[];
  folded: boolean; allIn: boolean; busted: boolean; inHand: boolean;
  bet: number;      // tiền đã cược ở vòng hiện tại
  total: number;    // tổng tiền đã bỏ vào ván này
  acted: boolean; canRaise: boolean; revealed: boolean; lastAction: string;
}
export interface Settings { startStack: number; blindEvery: number }
export interface Award { seat: number; amount: number; reason: 'showdown' | 'fold'; score?: number }
export interface PotResult { amount: number; eligible: number[]; winners: number[] }
export interface HandResult {
  awards: Award[]; pots: PotResult[]; showdown: boolean;
  shown: { seat: number; hole: number[]; score: number }[];
  refund: { seat: number; amount: number } | null; handNo: number; potTotal: number;
}
export interface Table {
  seats: Seat[]; button: number; sbSeat: number; bbSeat: number; sb: number; bb: number;
  board: number[]; deck: number[]; phase: Phase; toAct: number; currentBet: number; minRaise: number;
  handNo: number; settings: Settings; rng: () => number; result: HandResult | null; chipTotal: number;
}
export type Ev =
  | { t: 'newhand'; handNo: number; button: number; sb: number; bb: number }
  | { t: 'blind'; seat: number; amount: number; kind: 'sb' | 'bb' }
  | { t: 'action'; seat: number; kind: ActionType; amount: number; paid: number }
  | { t: 'street'; phase: Phase; cards: number[] }
  | { t: 'showdown' }
  | { t: 'win'; seat: number; amount: number; reason: 'showdown' | 'fold'; score?: number }
  | { t: 'refund'; seat: number; amount: number }
  | { t: 'bust'; seat: number }
  | { t: 'gameover'; winner: number };

export const BLINDS: [number, number][] = [[10, 20], [15, 30], [25, 50], [50, 100], [75, 150], [100, 200], [150, 300], [200, 400], [300, 600], [400, 800], [500, 1000], [750, 1500], [1000, 2000]];

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function createTable(opts: { names: string[]; bots: boolean[]; startStack?: number; blindEvery?: number; seed?: number }): Table {
  const startStack = opts.startStack ?? 1000;
  const seats: Seat[] = opts.names.map((name, id) => ({
    id, name, isBot: !!opts.bots[id], stack: startStack, hole: [], folded: false, allIn: false, busted: false, inHand: false,
    bet: 0, total: 0, acted: false, canRaise: true, revealed: false, lastAction: '',
  }));
  return {
    seats, button: -1, sbSeat: -1, bbSeat: -1, sb: BLINDS[0][0], bb: BLINDS[0][1], board: [], deck: [], phase: 'idle', toAct: -1,
    currentBet: 0, minRaise: BLINDS[0][1], handNo: 0, settings: { startStack, blindEvery: opts.blindEvery ?? 0 },
    rng: mulberry32(opts.seed ?? ((Math.random() * 2 ** 32) >>> 0)), result: null, chipTotal: seats.length * startStack,
  };
}

// ---------- Hàm trợ giúp ----------
const live = (s: Seat) => s.inHand && !s.folded;
const actable = (s: Seat) => live(s) && !s.allIn;
// Cần hành động nếu còn thiếu tiền để theo, hoặc chưa được hành động và còn có người khác để đấu (không ai để cược thì bỏ qua vòng)
const needsAction = (t: Table, s: Seat) => actable(s) && (s.bet < t.currentBet || (!s.acted && t.seats.some((o) => o.id !== s.id && actable(o))));
export const potTotal = (t: Table) => t.seats.reduce((a, s) => a + s.total, 0);
export const totalChips = (t: Table) => t.seats.reduce((a, s) => a + s.stack + s.total, 0);
const n = (t: Table) => t.seats.length;
function nextWhere(t: Table, from: number, pred: (s: Seat) => boolean): number {
  for (let k = 1; k <= n(t); k++) { const i = (from + k) % n(t); if (pred(t.seats[i])) return i; }
  return -1;
}
function shuffle(t: Table) {
  const d = Array.from({ length: 52 }, (_, i) => i);
  for (let i = 51; i > 0; i--) { const j = Math.floor(t.rng() * (i + 1)); [d[i], d[j]] = [d[j], d[i]]; }
  t.deck = d;
}
function post(s: Seat, amount: number): number {
  const pay = Math.min(s.stack, amount);
  s.stack -= pay; s.bet += pay; s.total += pay;
  if (s.stack === 0) s.allIn = true;
  return pay;
}

// ---------- Bắt đầu ván ----------
export function startHand(t: Table): Ev[] {
  const ev: Ev[] = [];
  if (t.phase === 'game_over') return ev;
  for (const s of t.seats) if (!s.busted && s.stack <= 0) { s.busted = true; ev.push({ t: 'bust', seat: s.id }); }
  const alive = t.seats.filter((s) => !s.busted);
  if (alive.length < 2) { t.phase = 'game_over'; t.toAct = -1; ev.push({ t: 'gameover', winner: alive[0]?.id ?? -1 }); return ev; }
  t.handNo++;
  const lvl = t.settings.blindEvery > 0 ? Math.min(Math.floor((t.handNo - 1) / t.settings.blindEvery), BLINDS.length - 1) : 0;
  [t.sb, t.bb] = BLINDS[lvl];
  for (const s of t.seats) {
    s.hole = []; s.folded = false; s.allIn = false; s.bet = 0; s.total = 0; s.acted = false; s.canRaise = true; s.revealed = false; s.lastAction = '';
    s.inHand = !s.busted;
  }
  t.board = []; t.result = null;
  t.button = t.button < 0 ? alive[Math.floor(t.rng() * alive.length)].id : nextWhere(t, t.button, (s) => s.inHand);
  if (alive.length === 2) { t.sbSeat = t.button; t.bbSeat = nextWhere(t, t.button, (s) => s.inHand); }
  else { t.sbSeat = nextWhere(t, t.button, (s) => s.inHand); t.bbSeat = nextWhere(t, t.sbSeat, (s) => s.inHand); }
  shuffle(t);
  for (let pass = 0; pass < 2; pass++) {
    let i = t.sbSeat;
    for (let k = 0; k < alive.length; k++) { t.seats[i].hole.push(t.deck.pop()!); i = nextWhere(t, i, (s) => s.inHand); }
  }
  ev.push({ t: 'newhand', handNo: t.handNo, button: t.button, sb: t.sb, bb: t.bb });
  const p1 = post(t.seats[t.sbSeat], t.sb); ev.push({ t: 'blind', seat: t.sbSeat, amount: p1, kind: 'sb' });
  const p2 = post(t.seats[t.bbSeat], t.bb); ev.push({ t: 'blind', seat: t.bbSeat, amount: p2, kind: 'bb' });
  t.currentBet = t.bb; t.minRaise = t.bb; t.phase = 'preflop';
  advance(t, ev, t.bbSeat);
  return ev;
}

// ---------- Quyền hành động hợp lệ ----------
export interface Legal {
  canAct: boolean; canFold: boolean; canCheck: boolean; canCall: boolean; callAmount: number;
  canRaise: boolean; minRaiseTo: number; maxRaiseTo: number; toCall: number;
}
export function legalActions(t: Table, seat: number): Legal {
  const none: Legal = { canAct: false, canFold: false, canCheck: false, canCall: false, callAmount: 0, canRaise: false, minRaiseTo: 0, maxRaiseTo: 0, toCall: 0 };
  const s = t.seats[seat];
  if (!s || t.toAct !== seat || !['preflop', 'flop', 'turn', 'river'].includes(t.phase) || !actable(s)) return none;
  const toCall = Math.max(0, t.currentBet - s.bet);
  const maxTo = s.bet + s.stack;
  const others = t.seats.filter((o) => o.id !== seat && actable(o)).length;
  const canRaise = s.canRaise && others >= 1 && s.stack > toCall;
  return {
    canAct: true, canFold: true, canCheck: toCall === 0, canCall: toCall > 0, callAmount: Math.min(s.stack, toCall), toCall,
    canRaise, minRaiseTo: Math.min(t.currentBet + t.minRaise, maxTo), maxRaiseTo: maxTo,
  };
}

// ---------- Thực hiện hành động ----------
export function applyAction(t: Table, seat: number, a: Action): { ok: boolean; error?: string; events: Ev[] } {
  const ev: Ev[] = [];
  const lg = legalActions(t, seat);
  if (!lg.canAct) return { ok: false, error: 'not your turn', events: ev };
  const s = t.seats[seat];
  let kind: ActionType = a.type;
  let raiseTo = a.amount ?? 0;
  if (kind === 'allin') {
    const maxTo = s.bet + s.stack;
    if (maxTo <= t.currentBet) kind = 'call';
    else { kind = 'raise'; raiseTo = maxTo; }
  }
  let paid = 0;
  if (kind === 'fold') {
    s.folded = true; s.lastAction = 'fold';
  } else if (kind === 'check') {
    if (!lg.canCheck) return { ok: false, error: 'cannot check', events: ev };
    s.acted = true; s.lastAction = 'check';
  } else if (kind === 'call') {
    if (!lg.canCall) return { ok: false, error: 'nothing to call', events: ev };
    paid = post(s, lg.toCall); s.acted = true; s.lastAction = s.allIn ? 'allin' : 'call';
  } else if (kind === 'raise') {
    if (!lg.canRaise) return { ok: false, error: 'cannot raise', events: ev };
    if (!Number.isInteger(raiseTo) || raiseTo <= t.currentBet) return { ok: false, error: 'raise too small', events: ev };
    if (raiseTo > lg.maxRaiseTo) return { ok: false, error: 'not enough chips', events: ev };
    if (raiseTo < t.currentBet + t.minRaise && raiseTo !== lg.maxRaiseTo) return { ok: false, error: 'below minimum raise', events: ev };
    const size = raiseTo - t.currentBet;
    const wasBet = t.currentBet === 0;
    paid = post(s, raiseTo - s.bet);
    const full = size >= t.minRaise;
    for (const o of t.seats) {
      if (o.id === seat || !actable(o)) continue;
      if (full) { o.acted = false; o.canRaise = true; }
      else if (o.acted) { o.acted = false; o.canRaise = false; }
    }
    if (full) t.minRaise = size;
    t.currentBet = raiseTo;
    s.acted = true; s.lastAction = s.allIn ? 'allin' : wasBet ? 'bet' : 'raise';
  } else return { ok: false, error: 'unknown action', events: ev };
  ev.push({ t: 'action', seat, kind: s.allIn && kind !== 'fold' ? 'allin' : kind, amount: s.bet, paid });
  advance(t, ev, seat);
  return { ok: true, events: ev };
}

// ---------- Chuyển vòng, chia bài chung, tổng kết ----------
function advance(t: Table, ev: Ev[], from: number) {
  for (let guard = 0; guard < 20; guard++) {
    const lives = t.seats.filter(live);
    if (lives.length === 1) { finishByFold(t, ev, lives[0]); return; }
    const nxt = nextWhere(t, from, (s) => needsAction(t, s));
    if (nxt >= 0) { t.toAct = nxt; return; }
    // Vòng cược xong
    if (t.phase === 'river') { showdown(t, ev); return; }
    for (const s of t.seats) { s.bet = 0; s.acted = false; s.canRaise = true; }
    t.currentBet = 0; t.minRaise = t.bb;
    const next: Phase = t.phase === 'preflop' ? 'flop' : t.phase === 'flop' ? 'turn' : 'river';
    const cnt = next === 'flop' ? 3 : 1;
    t.deck.pop(); // đốt một lá
    const cards: number[] = [];
    for (let i = 0; i < cnt; i++) cards.push(t.deck.pop()!);
    t.board.push(...cards); t.phase = next;
    ev.push({ t: 'street', phase: next, cards });
    for (const s of t.seats) if (s.lastAction !== 'fold' && s.lastAction !== 'allin') s.lastAction = '';
    from = t.button; // người đầu tiên bên trái nút hành động trước
    t.toAct = -1;
  }
}

function payout(t: Table, ev: Ev[], awards: Award[], pots: PotResult[], showdown: boolean, shown: HandResult['shown'], refund: HandResult['refund']) {
  const pt = potTotal(t);
  for (const a of awards) { t.seats[a.seat].stack += a.amount; ev.push({ t: 'win', seat: a.seat, amount: a.amount, reason: a.reason, score: a.score }); }
  if (refund) { t.seats[refund.seat].stack += refund.amount; ev.push({ t: 'refund', seat: refund.seat, amount: refund.amount }); }
  t.result = { awards, pots, showdown, shown, refund, handNo: t.handNo, potTotal: pt };
  for (const s of t.seats) { s.total = 0; s.bet = 0; }
  t.toAct = -1;
  const alive = t.seats.filter((s) => s.stack > 0 && !s.busted);
  t.phase = alive.length < 2 ? 'game_over' : 'hand_over';
  if (t.phase === 'game_over') ev.push({ t: 'gameover', winner: alive[0]?.id ?? -1 });
}

function finishByFold(t: Table, ev: Ev[], winner: Seat) {
  const pot = potTotal(t);
  payout(t, ev, [{ seat: winner.id, amount: pot, reason: 'fold' }], [{ amount: pot, eligible: [winner.id], winners: [winner.id] }], false, [], null);
}

function showdown(t: Table, ev: Ev[]) {
  t.phase = 'showdown';
  ev.push({ t: 'showdown' });
  while (t.board.length < 5) {
    const need = t.board.length === 0 ? 3 : 1;
    t.deck.pop();
    const cards: number[] = [];
    for (let i = 0; i < need; i++) cards.push(t.deck.pop()!);
    t.board.push(...cards);
    ev.push({ t: 'street', phase: t.board.length === 3 ? 'flop' : t.board.length === 4 ? 'turn' : 'river', cards });
  }
  const lives = t.seats.filter(live);
  const score = new Map<number, number>();
  const shown: HandResult['shown'] = [];
  for (const s of lives) { s.revealed = true; const sc = evaluate([...s.hole, ...t.board]); score.set(s.id, sc); shown.push({ seat: s.id, hole: s.hole.slice(), score: sc }); }

  // Chia thành tiền chính và tiền phụ theo mức đóng góp
  const totals = t.seats.map((s) => s.total);
  const levels = [...new Set(totals.filter((x) => x > 0))].sort((a, b) => a - b);
  const pots: PotResult[] = [];
  let refund: HandResult['refund'] = null;
  let prev = 0;
  for (const L of levels) {
    let amount = 0, contrib = 0;
    for (const x of totals) { amount += Math.min(x, L) - Math.min(x, prev); if (x >= L) contrib++; }
    let eligible = lives.filter((s) => s.total >= L).map((s) => s.id);
    if (!eligible.length) eligible = lives.map((s) => s.id); // không xảy ra, đề phòng để không mất chip
    prev = L;
    if (contrib === 1 && eligible.length === 1) { refund = { seat: eligible[0], amount: (refund?.amount ?? 0) + amount }; continue; } // phần cược không ai theo
    const last = pots[pots.length - 1];
    if (last && last.eligible.length === eligible.length && last.eligible.every((e, i) => e === eligible[i])) last.amount += amount;
    else pots.push({ amount, eligible, winners: [] });
  }
  const won = new Map<number, number>();
  for (const p of pots) {
    let best = -1;
    for (const id of p.eligible) best = Math.max(best, score.get(id)!);
    p.winners = p.eligible.filter((id) => score.get(id) === best);
    const k = p.winners.length, share = Math.floor(p.amount / k);
    let rem = p.amount - share * k;
    // chip lẻ cho người ngồi gần bên trái nút nhất
    const dist = (x: number) => ((x - t.button + n(t)) % n(t)) || n(t); // nút là người cuối cùng
    const order = p.winners.slice().sort((a, b) => dist(a) - dist(b));
    for (const id of order) { let g = share; if (rem > 0) { g++; rem--; } won.set(id, (won.get(id) ?? 0) + g); }
  }
  const awards: Award[] = [...won.entries()].map(([seat, amount]) => ({ seat, amount, reason: 'showdown', score: score.get(seat) }));
  payout(t, ev, awards, pots, true, shown, refund);
}

// ---------- Góc nhìn của một ghế (không lộ bài người khác) ----------
export interface SeatView {
  id: number; name: string; isBot: boolean; stack: number; folded: boolean; allIn: boolean; busted: boolean; inHand: boolean;
  bet: number; total: number; lastAction: string; hole: number[] | null; hasCards: boolean;
}
export interface View {
  me: number; seats: SeatView[]; board: number[]; pot: number; phase: Phase; toAct: number; currentBet: number; minRaise: number;
  button: number; sbSeat: number; bbSeat: number; sb: number; bb: number; handNo: number; legal: Legal; result: HandResult | null;
}
export function viewFor(t: Table, me: number): View {
  const seats: SeatView[] = t.seats.map((s) => ({
    id: s.id, name: s.name, isBot: s.isBot, stack: s.stack, folded: s.folded, allIn: s.allIn, busted: s.busted, inHand: s.inHand,
    bet: s.bet, total: s.total, lastAction: s.lastAction,
    hole: s.id === me || s.revealed ? s.hole.slice() : null, hasCards: s.inHand && s.hole.length > 0 && !s.folded,
  }));
  // Kết quả chỉ kèm bài của người đã lật
  let result: HandResult | null = null;
  if (t.result) result = { ...t.result, shown: t.result.shown.map((x) => ({ ...x })) };
  return {
    me, seats, board: t.board.slice(), pot: potTotal(t), phase: t.phase, toAct: t.toAct, currentBet: t.currentBet, minRaise: t.minRaise,
    button: t.button, sbSeat: t.sbSeat, bbSeat: t.bbSeat, sb: t.sb, bb: t.bb, handNo: t.handNo, legal: legalActions(t, me), result,
  };
}

export { handName };
