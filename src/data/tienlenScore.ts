// Tính chip cho Tiến lên miền Nam (/tienlen/). Chỉ có luật tính tiền và phiên chơi nhiều ván, không đụng giao diện.
// Mọi khoản trả đều là chuyển chip từ người này sang người kia, nên tổng chip của cả bàn luôn không đổi (zero-sum).
import { newGame, rankOf, suitOf, type TLState, type ChopRec } from './tienlenEngine';

const TWO = 12;
export const isTwo = (c: number) => rankOf(c) === TWO;
export const isRedTwo = (c: number) => isTwo(c) && suitOf(c) >= 2; // rô, cơ
export const isBlackTwo = (c: number) => isTwo(c) && suitOf(c) < 2; // bích, chuồn

// Hệ số (đơn vị) của từng khoản
export const RATES = {
  perCard: 1,          // mỗi lá còn trên tay (người thua trả người thắng)
  burnedMult: 2,       // cháy bài (chưa đánh lá nào): số lá nhân đôi
  heoBlack: 1,         // thối heo đen: mỗi lá 2 bích/chuồn còn trên tay thêm 1 đơn vị
  heoRed: 2,           // thối heo đỏ: mỗi lá 2 rô/cơ còn trên tay thêm 2 đơn vị
  chopBlack: 3,        // chặt heo đen: mỗi lá 2 bích/chuồn bị chặt trả 3 đơn vị
  chopRed: 4,          // chặt heo đỏ: mỗi lá 2 rô/cơ bị chặt trả 4 đơn vị
  white: 13,           // tới trắng: mỗi người còn lại trả 13 đơn vị
};

export type ItemKind = 'hand' | 'chop' | 'white';
export interface Item {
  kind: ItemKind;
  from: number;        // người trả (số ghế trong ván)
  to: number;          // người nhận
  due: number;         // số chip phải trả theo luật
  paid: number;        // số chip thực trả (có thể ít hơn due khi người trả không đủ)
  units: number;       // due / unit
  cards?: number;      // kind 'hand': số lá còn trên tay
  burned?: boolean;    // kind 'hand': cháy bài
  black?: number;      // số lá 2 đen (còn trên tay hoặc bị chặt)
  red?: number;        // số lá 2 đỏ
}
export interface Settlement {
  deltas: number[];    // thay đổi chip của từng ghế, tổng luôn bằng 0
  items: Item[];
  winner: number;
  white: boolean;
  burned: boolean[];   // ghế nào cháy bài
}

export interface SettleInput {
  n: number;
  hands: number[][];   // bài còn trên tay khi hết ván
  played: number[];    // số lần mỗi ghế đã đánh bài
  winner: number;
  order: number[];     // thứ tự về đích (người thắng đứng đầu)
  white: boolean;      // ván kết thúc do tới trắng
  chops: ChopRec[];
  unit: number;
  stacks: number[];    // chip hiện có của từng ghế
}

export function settleHand(inp: SettleInput): Settlement {
  const { n, unit } = inp;
  const bal = inp.stacks.slice();
  const deltas = new Array(n).fill(0);
  const items: Item[] = [];
  const burned = new Array(n).fill(false);
  // Chuyển tối đa số chip người trả đang có, người nhận được đúng số đã trả
  const pay = (kind: ItemKind, from: number, to: number, due: number, extra: Partial<Item>) => {
    const paid = Math.max(0, Math.min(due, bal[from]));
    bal[from] -= paid; bal[to] += paid;
    deltas[from] -= paid; deltas[to] += paid;
    items.push({ kind, from, to, due, paid, units: due / unit, ...extra });
  };
  if (inp.white) {
    for (const s of inp.order.slice(1)) pay('white', s, inp.winner, RATES.white * unit, {});
    return { deltas, items, winner: inp.winner, white: true, burned };
  }
  // 1) chặt heo theo thứ tự xảy ra
  for (const ch of inp.chops) {
    const black = ch.twos.filter(isBlackTwo).length, red = ch.twos.filter(isRedTwo).length;
    pay('chop', ch.victim, ch.chopper, (black * RATES.chopBlack + red * RATES.chopRed) * unit, { black, red });
  }
  // 2) người thua trả người thắng, theo thứ tự về đích
  for (const s of inp.order.slice(1)) {
    const hand = inp.hands[s];
    const isBurned = inp.played[s] === 0;
    burned[s] = isBurned;
    const black = hand.filter(isBlackTwo).length, red = hand.filter(isRedTwo).length;
    const base = hand.length * RATES.perCard * (isBurned ? RATES.burnedMult : 1);
    const heo = black * RATES.heoBlack + red * RATES.heoRed;
    pay('hand', s, inp.winner, (base + heo) * unit, { cards: hand.length, burned: isBurned, black, red });
  }
  return { deltas, items, winner: inp.winner, white: false, burned };
}

// ---------- Phiên chơi nhiều ván ----------
export type Over = '' | 'lose' | 'win'; // lose: người chơi hết chip, win: mọi máy hết chip
export interface Session {
  total: number;        // số người ở bàn lúc bắt đầu (người chơi là số 0, các máy là 1..)
  unit: number;
  startStack: number;
  stacks: number[];     // chip của từng người (theo số người, không đổi theo ghế)
  hand: number;         // số ván đã chơi xong
  lastWinner: number;   // người thắng ván trước (số người), -1 nếu chưa có
  over: Over;
  best: number;         // chip nhiều nhất của người chơi
}
export function newSession(total: number, startStack: number, unit: number): Session {
  return { total, unit, startStack, stacks: new Array(total).fill(startStack), hand: 0, lastWinner: -1, over: '', best: startStack };
}
export const activePlayers = (s: Session) => s.stacks.map((c, i) => (c > 0 ? i : -1)).filter((i) => i >= 0);

// Chia ván mới cho những người còn chip. seats[i] = số người ngồi ghế i.
export function dealHand(s: Session, rng: () => number = Math.random): { st: TLState; seats: number[] } {
  const seats = activePlayers(s);
  if (seats.length < 2) throw new Error('need at least 2 players with chips');
  const leader = s.lastWinner >= 0 ? seats.indexOf(s.lastWinner) : -1;
  return { st: newGame(seats.length, leader, rng), seats };
}

// Kết thúc ván: tính tiền, cập nhật chip, loại người hết chip, xác định hết game
export function finishHand(s: Session, st: TLState, seats: number[]): Settlement {
  if (!st.over) throw new Error('hand not over');
  const set = settleHand({
    n: st.n, hands: st.hands, played: st.played, winner: st.winner, order: st.order,
    white: !!st.white, chops: st.chops, unit: s.unit, stacks: seats.map((g) => s.stacks[g]),
  });
  seats.forEach((g, i) => { s.stacks[g] += set.deltas[i]; });
  s.hand++;
  s.lastWinner = seats[st.winner];
  s.best = Math.max(s.best, s.stacks[0]);
  if (s.stacks[0] <= 0) s.over = 'lose';
  else if (s.stacks.slice(1).every((c) => c <= 0)) s.over = 'win';
  return set;
}
