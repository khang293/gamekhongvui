// Tính chip cho Tiến lên miền Nam (/tienlen/). Chỉ có luật tính tiền và phiên chơi nhiều ván, không đụng giao diện.
// Mọi khoản trả đều là chuyển chip từ người này sang người kia, nên tổng chip của cả bàn luôn không đổi (zero-sum).
import { newGame, rankOf, suitOf, type TLState, type ChopEvt } from './tienlenEngine';

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
  chopBomb: 4,         // chặt tứ quý hoặc đôi thông: bằng một heo đỏ
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
  bombs?: number;      // kind 'chop': số tứ quý / đôi thông bị chặt
  stack?: number;      // kind 'chop': số lần chặt nối tiếp (> 1 là chặt chồng)
}
/** Gom các lần chặt theo chuỗi (đúng thứ tự xảy ra). */
export function chains<T extends { chain: number }>(evs: T[]): T[][] {
  const m = new Map<number, T[]>();
  for (const e of evs) { const a = m.get(e.chain); if (a) a.push(e); else m.set(e.chain, [e]); }
  return [...m.values()];
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
  chopEvents: ChopEvt[];
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
  // 1) chặt theo thứ tự xảy ra; chặt chồng "con cuối chịu hết": người bị chặt sau cùng trả cả chuỗi cho người chặt cuối
  for (const evs of chains(inp.chopEvents)) {
    const last = evs[evs.length - 1];
    if (last.free) continue;
    const payer = last.victim, payee = last.chopper;
    let black = 0, red = 0, bombs = 0;
    for (const e of evs) {
      if (e.victim === payee) continue; // bộ của chính người chặt cuối thì triệt tiêu
      if (e.key === 'single2' || e.key === 'pair2' || e.key === 'triple2') { black += e.cards.filter(isBlackTwo).length; red += e.cards.filter(isRedTwo).length; }
      else bombs++;
    }
    const due = (black * RATES.chopBlack + red * RATES.chopRed + bombs * RATES.chopBomb) * unit;
    if (due > 0) pay('chop', payer, payee, due, { black, red, bombs, stack: evs.length });
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
    white: !!st.white, chopEvents: st.chopEvents, unit: s.unit, stacks: seats.map((g) => s.stacks[g]),
  });
  seats.forEach((g, i) => { s.stacks[g] += set.deltas[i]; });
  s.hand++;
  s.lastWinner = seats[st.winner];
  s.best = Math.max(s.best, s.stacks[0]);
  if (s.stacks[0] <= 0) s.over = 'lose';
  else if (s.stacks.slice(1).every((c) => c <= 0)) s.over = 'win';
  return set;
}

// =====================================================================================================
// Chế độ TÍNH ĐIỂM (4 người). Điểm cộng dồn qua các ván, ai chạm điểm đích trước thì thắng. Không dùng chip.
//  - Hạng cuối ván: nhất +20, nhì +10, ba -10, bét -20.
//  - Chặt (cộng dồn, người bị chặt trừ, người chặt cộng): mỗi lá 2 đen 10, mỗi lá 2 đỏ 20 (đôi 2, sám 2 cộng lại);
//    chặt đôi thông 20; chặt tứ quý 20.
//  - Chặt chồng: cả chuỗi chặt nối tiếp được tính về người chặt CUỐI CÙNG: mọi người bị chặt trong chuỗi
//    (kể cả người chặt trung gian đã bị chặt lại) đều trả giá trị bộ của mình cho người chặt cuối.
//  - Người đã về (hết bài) mà bộ cuối của họ bị chặt thì không bị trừ, người chặt không được cộng khoản đó.
//  - Thối bài: ai chưa đánh được lá nào tại lúc có người về nhất trả 10 điểm cho người về nhất.
//  - Thối heo: lá 2 còn trên tay khi hết ván bị trừ như bị chặt (đen 10, đỏ 20), trả cho người về nhất.
//  - Tới trắng: người thắng +20, ba người còn lại xếp hạng theo thứ tự ngồi, không có điểm chặt, không thối.
// =====================================================================================================
export const RANK_POINTS = [20, 10, -10, -20];
export const CHOP_PTS = { black: 10, red: 20, other: 20 };
export const BURN_PTS = 10; // thối bài

/** Giá trị (điểm) của một bộ bài bị chặt: lá 2 tính từng lá theo màu, tứ quý / đôi thông 20. */
export function chopValue(key: string, cards: number[]): number {
  if (key === 'single2' || key === 'pair2' || key === 'triple2') {
    return cards.reduce((a, c) => a + (isRedTwo(c) ? CHOP_PTS.red : isBlackTwo(c) ? CHOP_PTS.black : 0), 0);
  }
  return CHOP_PTS.other;
}
/** Giá trị cả chuỗi chặt chồng. Bộ do chính người chặt cuối đánh ra trước đó thì triệt tiêu (không ai trả cho chính bộ của mình). */
export function chainValue(evs: { victim: number; key: string; cards: number[] }[], payee: number): number {
  return evs.reduce((a, e) => a + (e.victim === payee ? 0 : chopValue(e.key, e.cards)), 0);
}
/** Nhãn loại bộ bị chặt: 'black' | 'red' | 'twos' (heo đen và đỏ lẫn) | 'quad' | 'pairs' */
export function chopKind(key: string, cards: number[]): 'black' | 'red' | 'twos' | 'quad' | 'pairs' {
  if (key === 'quad') return 'quad';
  if (key === 'pairs3' || key === 'pairs4') return 'pairs';
  const red = cards.filter(isRedTwo).length, black = cards.filter(isBlackTwo).length;
  return red && black ? 'twos' : red ? 'red' : 'black';
}

export interface PtsItem {
  kind: 'chop' | 'burn' | 'heo'; // chặt, thối bài, thối heo
  from: number;        // người trả điểm
  to: number;          // người nhận điểm (chặt: người chặt cuối chuỗi; thối: người về nhất)
  val: number;         // điểm
  key: string;         // loại bộ bị chặt ('' với thối bài)
  cards: number[];     // các lá bị chặt / bị thối
  chain: number;       // số chuỗi (-1 với khoản thối)
  self: boolean;       // giữ cho tương thích; hiện luôn false
  stack?: number;      // số lần chặt nối tiếp trong chuỗi (> 1 là chặt chồng)
}
export interface PointsSettlement {
  n: number;
  rank: number[];      // điểm hạng của từng ghế
  chop: number[];      // điểm chặt (ròng) của từng ghế
  thoi: number[];      // điểm thối bài + thối heo (ròng) của từng ghế
  deltas: number[];    // rank + chop + thoi, tổng luôn bằng 0
  items: PtsItem[];
  order: number[];
  winner: number;
  white: boolean;
}
export interface PtsInput { n: number; order: number[]; white: boolean; chopEvents: ChopEvt[]; thoi?: number[]; hands?: number[][] }

export function settlePoints(inp: PtsInput): PointsSettlement {
  const { n } = inp;
  if (n !== 4) throw new Error('points mode needs 4 players');
  const rank = new Array(n).fill(0), chop = new Array(n).fill(0);
  inp.order.forEach((seat, i) => { rank[seat] = RANK_POINTS[i] ?? 0; });
  const items: PtsItem[] = [];
  if (!inp.white) {
    // gom theo chuỗi: "con cuối chịu hết" - người bị chặt sau cùng đền cả chuỗi cho người chặt cuối, những người trước không mất gì
    const byChain = new Map<number, ChopEvt[]>();
    for (const e of inp.chopEvents) { const a = byChain.get(e.chain); if (a) a.push(e); else byChain.set(e.chain, [e]); }
    for (const [chain, evs] of byChain) {
      const last = evs[evs.length - 1];
      if (last.free) continue; // người bị chặt sau cùng đã về: được miễn trừ, nên cả chuỗi không ai mất điểm
      const payer = last.victim, payee = last.chopper;
      const val = chainValue(evs, payee);
      chop[payer] -= val; chop[payee] += val;
      items.push({ kind: 'chop', from: payer, to: payee, val, key: last.key, cards: last.cards.slice(), chain, self: false, stack: evs.length });
    }
  }
  const thoi = new Array(n).fill(0);
  if (!inp.white) {
    const first = inp.order[0];
    const pay = (kind: 'burn' | 'heo', from: number, val: number, key: string, cards: number[]) => {
      thoi[from] -= val; thoi[first] += val;
      items.push({ kind, from, to: first, val, key, cards, chain: -1, self: false });
    };
    for (const s of inp.thoi || []) if (s !== first) pay('burn', s, BURN_PTS, '', []);
    (inp.hands || []).forEach((hand, s) => {
      const twos = hand.filter((c) => isBlackTwo(c) || isRedTwo(c));
      if (twos.length && s !== first) pay('heo', s, chopValue('single2', twos), 'single2', twos);
    });
  }
  const deltas = rank.map((r, i) => r + chop[i] + thoi[i]);
  return { n, rank, chop, thoi, deltas, items, order: inp.order.slice(), winner: inp.order[0], white: inp.white };
}

// ---------- Phiên chơi tính điểm ----------
export type PointsOver = '' | 'target' | 'ended';
export interface PointSession {
  total: number;        // luôn 4
  target: number;       // 0 = không đặt đích
  totals: number[];     // điểm cộng dồn của từng người (theo số ghế, không đổi)
  hand: number;
  lastWinner: number;   // người về nhất ván trước, -1 nếu chưa có
  over: PointsOver;
  winner: number;       // người thắng cả phiên (khi over != '')
  lastDeltas: number[]; // điểm của ván vừa xong
}
export const TARGET_MIN = 10, TARGET_MAX = 1000;
export function clampTarget(v: unknown, d = 100): number {
  const x = Number(v);
  if (x === 0) return 0;
  return Number.isInteger(x) && x >= TARGET_MIN && x <= TARGET_MAX ? x : d;
}
export function newPointSession(target: number): PointSession {
  return { total: 4, target: clampTarget(target), totals: [0, 0, 0, 0], hand: 0, lastWinner: -1, over: '', winner: -1, lastDeltas: [0, 0, 0, 0] };
}
/** Người dẫn đầu: điểm cao nhất; hòa thì điểm ván vừa rồi cao hơn, rồi số ghế nhỏ hơn. */
export function leaderOf(s: PointSession): number {
  let best = 0;
  for (let i = 1; i < s.total; i++) {
    if (s.totals[i] > s.totals[best] || (s.totals[i] === s.totals[best] && s.lastDeltas[i] > s.lastDeltas[best])) best = i;
  }
  return best;
}
export function dealHandPoints(s: PointSession, rng: () => number = Math.random): TLState {
  return newGame(4, s.lastWinner, rng, { multi: true }); // chế độ tính điểm: đánh tiếp sau khi có người về nhất
}
/** Kết thúc ván: cộng điểm, kiểm tra đích. */
export function finishHandPoints(s: PointSession, st: TLState): PointsSettlement {
  if (!st.over) throw new Error('hand not over');
  const set = settlePoints({ n: st.n, order: st.order, white: !!st.white, chopEvents: st.chopEvents, thoi: st.thoi, hands: st.hands });
  set.deltas.forEach((d, i) => { s.totals[i] += d; });
  s.lastDeltas = set.deltas.slice();
  s.hand++;
  s.lastWinner = st.winner;
  if (s.target > 0 && s.totals.some((t) => t >= s.target)) {
    // trong những người đã chạm đích: điểm cao nhất; hòa thì điểm ván này, rồi số ghế
    const reached = s.totals.map((t, i) => (t >= s.target ? i : -1)).filter((i) => i >= 0);
    let best = reached[0];
    for (const i of reached) if (s.totals[i] > s.totals[best] || (s.totals[i] === s.totals[best] && s.lastDeltas[i] > s.lastDeltas[best])) best = i;
    s.over = 'target'; s.winner = best;
  }
  return set;
}
/** Kết thúc phiên theo ý người chơi: người dẫn đầu thắng. */
export function endPointSession(s: PointSession) {
  if (s.over) return;
  s.over = 'ended'; s.winner = leaderOf(s);
}
