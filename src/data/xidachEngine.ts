// Luật Xì dách (blackjack Việt Nam) cho trang /xidach/. Thuần logic, không đụng DOM. Xóa game thì xóa luôn file này.
// Lá bài 0..51: rank = c % 13 (0 = A, 1..8 = 2..9, 9 = 10, 10 = J, 11 = Q, 12 = K), suit = floor(c / 13).
export const rankOf = (c: number) => c % 13;
export const suitOf = (c: number) => Math.floor(c / 13);
export const isAce = (c: number) => rankOf(c) === 0;
const isTen = (c: number) => rankOf(c) >= 9;

export type Kind = 'xibang' | 'xidach' | 'ngulinh' | 'points' | 'quac';
export interface HandValue { total: number; kind: Kind }

export const MAX_CARDS = 5;
export const MIN_PLAYER = 16; // nhà con phải đủ 16 mới được dằn
export const MIN_DEALER = 15; // nhà cái đủ 15 mới được dằn / xét bài
export const MULT: Record<Kind, number> = { xibang: 3, xidach: 2, ngulinh: 2, points: 1, quac: 1 };
const ORDER: Record<Kind, number> = { xibang: 4, xidach: 3, ngulinh: 2, points: 1, quac: 0 };

// Lá A: cầm 2 lá tính 1 / 10 / 11; cầm 3 lá tính 1 / 10; từ 4 lá chỉ tính 1. Chọn tổng lớn nhất mà không quá 21.
export function handValue(cards: number[]): HandValue {
  const n = cards.length;
  if (n === 2 && cards.every(isAce)) return { total: 21, kind: 'xibang' };
  if (n === 2 && cards.some(isAce) && cards.some(isTen)) return { total: 21, kind: 'xidach' };
  const choices = n <= 2 ? [1, 10, 11] : n === 3 ? [1, 10] : [1];
  let totals = [0];
  for (const c of cards) {
    const add = isAce(c) ? choices : [isTen(c) ? 10 : rankOf(c) + 1];
    totals = [...new Set(totals.flatMap((t) => add.map((a) => t + a)))];
  }
  const ok = totals.filter((t) => t <= 21);
  const total = ok.length ? Math.max(...ok) : Math.min(...totals);
  if (total > 21) return { total, kind: 'quac' };
  if (n >= MAX_CARDS) return { total, kind: 'ngulinh' };
  return { total, kind: 'points' };
}

// > 0: a thắng b; < 0: b thắng; 0: hòa. Cùng quắc thì hòa; hai ngũ linh thì điểm nhỏ hơn thắng.
export function compare(a: HandValue, b: HandValue): number {
  if (a.kind !== b.kind) return ORDER[a.kind] - ORDER[b.kind];
  if (a.kind === 'points') return a.total - b.total;
  if (a.kind === 'ngulinh') return b.total - a.total;
  return 0;
}

export interface Settled { result: 1 | 0 | -1; delta: number; mult: number; player: HandValue; dealer: HandValue }
export interface XDState {
  n: number; dealer: number; hands: number[][]; deck: number[]; bets: number[];
  stood: boolean[]; settled: (Settled | null)[]; turn: number; phase: 'players' | 'dealer' | 'done';
  deltas: number[]; // thay đổi chip trong ván của từng ghế, tổng luôn 0
}

export function shuffle(rng: () => number): number[] {
  const d = Array.from({ length: 52 }, (_, i) => i);
  for (let i = 51; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [d[i], d[j]] = [d[j], d[i]]; }
  return d;
}
const isNatural = (v: HandValue) => v.kind === 'xibang' || v.kind === 'xidach';

// Chia 2 lá mỗi người. Nhà cái có xì bàng / xì dách: xét cả bàn ngay. Nhà con có thì được xét ngay.
export function deal(n: number, dealer: number, bets: number[], rng: () => number = Math.random, deck?: number[]): XDState {
  if (n < 2 || n > 8) throw new Error('n must be 2..8'); // 8 người x tối đa 5 lá = 40 lá, đủ một bộ
  const d = deck ? deck.slice() : shuffle(rng);
  const hands: number[][] = Array.from({ length: n }, () => []);
  for (let r = 0; r < 2; r++) for (let k = 1; k <= n; k++) hands[(dealer + k) % n].push(d.shift()!);
  const st: XDState = { n, dealer, hands, deck: d, bets: bets.slice(), stood: new Array(n).fill(false), settled: new Array(n).fill(null), turn: dealer, phase: 'players', deltas: new Array(n).fill(0) };
  if (isNatural(handValue(hands[dealer]))) { for (const s of others(st)) settle(st, s); st.phase = 'done'; return st; }
  for (const s of others(st)) if (isNatural(handValue(hands[s]))) settle(st, s);
  advance(st);
  return st;
}
/** Các nhà con theo thứ tự lượt (bắt đầu từ người ngồi sau nhà cái). */
export const others = (st: XDState) => Array.from({ length: st.n - 1 }, (_, i) => (st.dealer + 1 + i) % st.n);

function settle(st: XDState, seat: number) {
  if (st.settled[seat]) return;
  const p = handValue(st.hands[seat]), d = handValue(st.hands[st.dealer]);
  const c = compare(p, d);
  const result = (c > 0 ? 1 : c < 0 ? -1 : 0) as 1 | 0 | -1;
  const mult = result === 0 ? 0 : MULT[(result > 0 ? p : d).kind];
  const delta = result * mult * st.bets[seat];
  st.settled[seat] = { result, delta, mult, player: p, dealer: d };
  st.deltas[seat] += delta; st.deltas[st.dealer] -= delta;
}

const done = (st: XDState, s: number) => {
  if (st.settled[s] || st.stood[s]) return true;
  const v = handValue(st.hands[s]);
  return v.kind === 'quac' || st.hands[s].length >= MAX_CARDS;
};
function advance(st: XDState) {
  if (st.phase === 'players') {
    const next = others(st).find((s) => !done(st, s));
    if (next !== undefined) { st.turn = next; return; }
    st.phase = 'dealer'; st.turn = st.dealer;
  }
  if (st.phase === 'dealer') {
    const left = others(st).filter((s) => !st.settled[s]);
    const v = handValue(st.hands[st.dealer]);
    if (!left.length || v.kind === 'quac' || st.hands[st.dealer].length >= MAX_CARDS) { for (const s of left) settle(st, s); st.phase = 'done'; }
  }
}

export interface Legal { draw: boolean; stand: boolean; check: number[] }
export function legal(st: XDState, seat: number): Legal {
  const none = { draw: false, stand: false, check: [] as number[] };
  if (st.phase === 'done' || st.turn !== seat) return none;
  const v = handValue(st.hands[seat]);
  const min = seat === st.dealer ? MIN_DEALER : MIN_PLAYER;
  const draw = st.hands[seat].length < MAX_CARDS && v.kind !== 'quac' && v.total < 21;
  const enough = v.total >= min;
  return { draw, stand: enough, check: seat === st.dealer && enough ? others(st).filter((s) => !st.settled[s]) : [] };
}
export function draw(st: XDState, seat: number): boolean {
  if (!legal(st, seat).draw) return false;
  st.hands[seat].push(st.deck.shift()!);
  advance(st);
  return true;
}
export function stand(st: XDState, seat: number): boolean {
  if (!legal(st, seat).stand) return false;
  if (seat === st.dealer) { for (const s of others(st)) settle(st, s); st.phase = 'done'; return true; }
  st.stood[seat] = true;
  advance(st);
  return true;
}
/** Nhà cái xét bài một nhà con (so ngay với bài hiện tại của cái), sau đó vẫn được rút tiếp. */
export function check(st: XDState, target: number): boolean {
  if (!legal(st, st.dealer).check.includes(target)) return false;
  settle(st, target);
  advance(st);
  return true;
}

// ---------- Máy ----------
export type BotAction = { type: 'draw' } | { type: 'stand' } | { type: 'check'; target: number };
// Máy chỉ biết bài của mình và số lá của người khác (không nhìn bài người khác)
export function botAction(st: XDState, seat: number, rng: () => number = Math.random): BotAction {
  const lg = legal(st, seat), v = handValue(st.hands[seat]), len = st.hands[seat].length;
  if (seat !== st.dealer) {
    if (!lg.stand) return { type: 'draw' };
    if (lg.draw && v.total === 16 && len < 4 && rng() < 0.4) return { type: 'draw' };
    return { type: 'stand' };
  }
  if (!lg.stand) return { type: 'draw' };
  // đủ tuổi mà còn yếu: xét trước những người rút nhiều lá (dễ đã quắc hoặc điểm thấp), rồi rút tiếp
  if (v.total < 17 && lg.draw) {
    const many = lg.check.find((s) => st.hands[s].length >= 3);
    if (many !== undefined) return { type: 'check', target: many };
    return { type: 'draw' };
  }
  return { type: 'stand' };
}
export function apply(st: XDState, seat: number, a: BotAction): boolean {
  if (a.type === 'draw') return draw(st, seat) || stand(st, seat);
  if (a.type === 'stand') return stand(st, seat);
  return check(st, a.target);
}
