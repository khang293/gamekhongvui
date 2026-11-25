// Luật "Còn Một!" (trò đổ bài theo màu và số, bộ lá tự thiết kế). Thuần logic, không đụng DOM.
// Lá bài là chỉ số 0..107 trong DECK. Màu 0..3, màu 4 = lá đổi màu.
export type Value = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'skip' | 'rev' | 'd2' | 'wild' | 'd4';
export interface Card { c: number; v: Value }
export const HAND = 7;
export const MAX_PLAYERS = 8;

export const DECK: Card[] = (() => {
  const d: Card[] = [];
  for (let c = 0; c < 4; c++) {
    d.push({ c, v: '0' });
    for (const v of ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'skip', 'rev', 'd2'] as Value[]) d.push({ c, v }, { c, v });
  }
  for (let i = 0; i < 4; i++) d.push({ c: 4, v: 'wild' }, { c: 4, v: 'd4' });
  return d;
})();

export interface CMState {
  n: number;
  hands: number[][];
  draw: number[];               // chồng rút (lá cuối mảng là lá trên cùng)
  discard: number[];
  color: number;                // màu đang chơi 0..3
  turn: number;
  dir: 1 | -1;
  pending: number;              // số lá đang bị cộng dồn
  pendingKind: '' | 'd2' | 'd4';
  drawn: number | null;         // lá vừa rút đánh được: người đó đánh hoặc bỏ lượt
  called: boolean[];            // đã hô "Còn một!"
  catchable: number;            // ghế đang quên hô (-1: không ai)
  over: boolean;
  winner: number;
}

export function shuffle(a: number[], rng: () => number): number[] {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

export function newRound(n: number, leader = 0, rng: () => number = Math.random): CMState {
  if (n < 2 || n > MAX_PLAYERS) throw new Error('n must be 2..8');
  const draw = shuffle(DECK.map((_, i) => i), rng);
  const hands = Array.from({ length: n }, () => draw.splice(-HAND, HAND));
  // lá mở đầu phải là lá số
  let k = draw.length - 1;
  while (!/^[0-9]$/.test(DECK[draw[k]].v)) k--;
  const first = draw.splice(k, 1)[0];
  return {
    n, hands, draw, discard: [first], color: DECK[first].c, turn: ((leader % n) + n) % n, dir: 1,
    pending: 0, pendingKind: '', drawn: null, called: new Array(n).fill(false), catchable: -1, over: false, winner: -1,
  };
}

export const topCard = (st: CMState) => st.discard[st.discard.length - 1];

/** lá này đặt lên bàn được không (chưa xét lượt) */
export function matches(card: number, top: number, color: number, pendingKind: CMState['pendingKind']): boolean {
  const c = DECK[card], t = DECK[top];
  if (!c) return false;
  if (pendingKind) return c.v === 'd4' || (c.v === 'd2' && pendingKind === 'd2'); // đang cộng dồn
  return c.c === 4 || c.c === color || (t.c !== 4 && c.v === t.v);
}
export function canPlay(st: CMState, seat: number, card: number): boolean {
  if (st.over || st.turn !== seat || !st.hands[seat].includes(card)) return false;
  if (st.drawn !== null && card !== st.drawn) return false;
  return matches(card, topCard(st), st.color, st.pendingKind);
}

const next = (st: CMState, from: number, steps = 1) => (((from + st.dir * steps) % st.n) + st.n) % st.n;

/** rút k lá cho một ghế; hết chồng rút thì xáo lại chồng đã đánh (giữ lá trên cùng) */
function give(st: CMState, seat: number, k: number, rng: () => number): number[] {
  const got: number[] = [];
  for (let i = 0; i < k; i++) {
    if (!st.draw.length) {
      if (st.discard.length < 2) break;
      const top = st.discard.pop()!;
      st.draw = shuffle(st.discard, rng);
      st.discard = [top];
    }
    got.push(st.draw.pop()!);
  }
  st.hands[seat].push(...got);
  if (st.hands[seat].length > 1) st.called[seat] = false;
  return got;
}

export function play(st: CMState, seat: number, card: number, color?: number): boolean {
  if (!canPlay(st, seat, card)) return false;
  const c = DECK[card];
  if (c.c === 4 && !(Number.isInteger(color) && color! >= 0 && color! < 4)) return false;
  st.catchable = -1; // người sau đã đi: hết hạn bắt lỗi
  st.hands[seat].splice(st.hands[seat].indexOf(card), 1);
  st.discard.push(card);
  st.color = c.c === 4 ? color! : c.c;
  st.drawn = null;
  if (!st.hands[seat].length) { st.over = true; st.winner = seat; return true; }
  if (st.hands[seat].length === 1 && !st.called[seat]) st.catchable = seat;
  let steps = 1;
  if (c.v === 'skip') steps = 2;
  if (c.v === 'rev') { st.dir = st.dir === 1 ? -1 : 1; if (st.n === 2) steps = 2; }
  if (c.v === 'd2') { st.pending += 2; st.pendingKind = st.pendingKind === 'd4' ? 'd4' : 'd2'; }
  if (c.v === 'd4') { st.pending += 4; st.pendingKind = 'd4'; }
  st.turn = next(st, seat, steps);
  return true;
}

export type DrawResult = { cards: number[]; penalty: boolean } | null;
/** rút: đang bị cộng dồn thì rút hết và mất lượt; bình thường rút 1, đánh được thì được chọn */
export function draw(st: CMState, seat: number, rng: () => number = Math.random): DrawResult {
  if (st.over || st.turn !== seat || st.drawn !== null) return null;
  st.catchable = -1;
  if (st.pending) {
    const cards = give(st, seat, st.pending, rng);
    st.pending = 0; st.pendingKind = '';
    st.turn = next(st, seat);
    return { cards, penalty: true };
  }
  const cards = give(st, seat, 1, rng);
  if (cards.length && matches(cards[0], topCard(st), st.color, '')) st.drawn = cards[0];
  else st.turn = next(st, seat);
  return { cards, penalty: false };
}
export function pass(st: CMState, seat: number): boolean {
  if (st.over || st.turn !== seat || st.drawn === null) return false;
  st.drawn = null;
  st.turn = next(st, seat);
  return true;
}
/** hô "Còn một!": trước khi đánh lá áp chót, hoặc chữa cháy khi chưa ai bắt */
export function canCall(st: CMState, seat: number): boolean {
  if (st.over || st.called[seat]) return false;
  return st.catchable === seat || (st.turn === seat && st.hands[seat].length === 2);
}
export function call(st: CMState, seat: number): boolean {
  if (!canCall(st, seat)) return false;
  st.called[seat] = true;
  if (st.catchable === seat) st.catchable = -1;
  return true;
}
export function catchOne(st: CMState, by: number, rng: () => number = Math.random): number {
  const target = st.catchable;
  if (st.over || target < 0 || by === target || by < 0 || by >= st.n) return -1;
  st.catchable = -1;
  give(st, target, 2, rng);
  return target;
}

// ---------- Máy ----------
export type BotMove = { type: 'play'; card: number; color?: number; call: boolean } | { type: 'draw' } | { type: 'pass' };
const bestColor = (hand: number[], not: number) => {
  const n = [0, 0, 0, 0];
  for (const x of hand) if (x !== not && DECK[x].c < 4) n[DECK[x].c]++;
  return n.indexOf(Math.max(...n));
};
/** máy chỉ nhìn bài của mình và số lá của người khác */
export function botMove(st: CMState, seat: number, rng: () => number = Math.random): BotMove {
  const hand = st.hands[seat];
  const legal = hand.filter((x) => canPlay(st, seat, x));
  if (!legal.length) return st.drawn !== null ? { type: 'pass' } : { type: 'draw' };
  const nextCount = st.hands[next(st, seat)].length;
  const score = (x: number) => {
    const c = DECK[x];
    let s = rng() * 2;
    if (c.c === 4) s -= c.v === 'd4' ? 12 : 9;                 // giữ lá đổi màu
    else s += hand.filter((y) => DECK[y].c === c.c).length;    // ưu tiên màu mình có nhiều
    if (/^[0-9]$/.test(c.v)) s += Number(c.v) * 0.1;
    if (['skip', 'rev', 'd2', 'd4'].includes(c.v)) s += nextCount <= 3 ? 14 : 1.5;
    if (hand.length <= 2 && c.c !== 4) s += 6;                 // sắp hết bài: giữ lá đổi màu để về
    return s;
  };
  const card = legal.slice().sort((a, b) => score(b) - score(a))[0];
  return { type: 'play', card, color: DECK[card].c === 4 ? bestColor(hand, card) : undefined, call: hand.length === 2 && rng() < 0.85 };
}
