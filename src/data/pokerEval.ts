// Chấm điểm bài poker (/poker/). Xóa game poker thì xóa luôn file này cùng pokerEngine.ts, pokerBot.ts.
// Lá bài là số 0..51: hạng = c % 13 (0 = 2 ... 12 = Át), chất = (c / 13) | 0.
// Điểm là một số duy nhất: loại bài (0..8) * 2^20 + 5 hạng đã xếp (mỗi hạng 4 bit). Điểm lớn hơn = bài mạnh hơn.
export const rankOf = (c: number) => c % 13;
export const suitOf = (c: number) => (c / 13) | 0;

export const CAT = { HIGH: 0, PAIR: 1, TWO_PAIR: 2, TRIPS: 3, STRAIGHT: 4, FLUSH: 5, FULL_HOUSE: 6, QUADS: 7, STRAIGHT_FLUSH: 8 } as const;

const pack = (cat: number, r: number[]) => (cat << 20) | ((r[0] || 0) << 16) | ((r[1] || 0) << 12) | ((r[2] || 0) << 8) | ((r[3] || 0) << 4) | (r[4] || 0);
export const categoryOf = (score: number) => score >> 20;

// Tìm hạng cao nhất của một dãy 5 lá liên tiếp trong mặt nạ hạng (13 bit). Dãy A-2-3-4-5 có hạng cao là 3 ('5'). -1 nếu không có.
function straightHigh(mask: number): number {
  for (let hi = 12; hi >= 4; hi--) {
    const need = 0b11111 << (hi - 4);
    if ((mask & need) === need) return hi;
  }
  const wheel = (1 << 12) | 0b1111; // A + 2,3,4,5
  if ((mask & wheel) === wheel) return 3;
  return -1;
}

// Điểm của bài tốt nhất trong 5 đến 7 lá
export function evaluate(cards: ArrayLike<number>): number {
  const rc = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const sm = [0, 0, 0, 0];
  const sn = [0, 0, 0, 0];
  let all = 0;
  const n = cards.length;
  for (let i = 0; i < n; i++) {
    const c = cards[i], r = c % 13, s = (c / 13) | 0;
    rc[r]++; sm[s] |= 1 << r; sn[s]++; all |= 1 << r;
  }
  // Thùng và sảnh thùng
  let fs = -1;
  for (let s = 0; s < 4; s++) if (sn[s] >= 5) { fs = s; break; }
  if (fs >= 0) {
    const sh = straightHigh(sm[fs]);
    if (sh >= 0) return pack(CAT.STRAIGHT_FLUSH, [sh]);
  }
  // Đếm bộ
  let quad = -1, trips: number[] = [], pairs: number[] = [];
  for (let r = 12; r >= 0; r--) {
    const k = rc[r];
    if (k === 4) { if (quad < 0) quad = r; else pairs.push(r); }
    else if (k === 3) trips.push(r);
    else if (k === 2) pairs.push(r);
  }
  const top = (excl: number[], cnt: number) => {
    const out: number[] = [];
    for (let r = 12; r >= 0 && out.length < cnt; r--) if (rc[r] > 0 && excl.indexOf(r) < 0) out.push(r);
    return out;
  };
  if (quad >= 0) return pack(CAT.QUADS, [quad, ...top([quad], 1)]);
  if (trips.length >= 1 && (trips.length >= 2 || pairs.length >= 1)) {
    const t = trips[0];
    const p = trips.length >= 2 ? Math.max(trips[1], pairs.length ? pairs[0] : -1) : pairs[0];
    return pack(CAT.FULL_HOUSE, [t, p]);
  }
  if (fs >= 0) {
    const out: number[] = [];
    for (let r = 12; r >= 0 && out.length < 5; r--) if (sm[fs] & (1 << r)) out.push(r);
    return pack(CAT.FLUSH, out);
  }
  const sh = straightHigh(all);
  if (sh >= 0) return pack(CAT.STRAIGHT, [sh]);
  if (trips.length) return pack(CAT.TRIPS, [trips[0], ...top([trips[0]], 2)]);
  if (pairs.length >= 2) {
    const a = pairs[0], b = pairs[1];
    return pack(CAT.TWO_PAIR, [a, b, ...top([a, b], 1)]);
  }
  if (pairs.length === 1) return pack(CAT.PAIR, [pairs[0], ...top([pairs[0]], 3)]);
  return pack(CAT.HIGH, top([], 5));
}

// ---------- Tên bài (vi / en) ----------
const R_EN = ['Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Jack', 'Queen', 'King', 'Ace'];
const R_EN_PL = ['Twos', 'Threes', 'Fours', 'Fives', 'Sixes', 'Sevens', 'Eights', 'Nines', 'Tens', 'Jacks', 'Queens', 'Kings', 'Aces'];
const R_VI = ['Hai', 'Ba', 'Bốn', 'Năm', 'Sáu', 'Bảy', 'Tám', 'Chín', 'Mười', 'Bồi', 'Đầm', 'Già', 'Át'];
export const RANK_CH = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

export function handName(score: number, lang: 'vi' | 'en' = 'en'): string {
  const cat = score >> 20;
  const r = [(score >> 16) & 15, (score >> 12) & 15, (score >> 8) & 15, (score >> 4) & 15, score & 15];
  if (lang === 'vi') {
    const v = R_VI;
    switch (cat) {
      case 0: return `Mậu thầu, ${v[r[0]]} cao`;
      case 1: return `Một đôi ${v[r[0]]}`;
      case 2: return `Hai đôi ${v[r[0]]} và ${v[r[1]]}`;
      case 3: return `Xám cô ${v[r[0]]}`;
      case 4: return `Sảnh, ${v[r[0]]} cao`;
      case 5: return `Thùng, ${v[r[0]]} cao`;
      case 6: return `Cù lũ, ${v[r[0]]} và ${v[r[1]]}`;
      case 7: return `Tứ quý ${v[r[0]]}`;
      default: return r[0] === 12 ? 'Sảnh chúa' : `Sảnh thùng, ${v[r[0]]} cao`;
    }
  }
  switch (cat) {
    case 0: return `High Card, ${R_EN[r[0]]}`;
    case 1: return `Pair of ${R_EN_PL[r[0]]}`;
    case 2: return `Two Pair, ${R_EN_PL[r[0]]} and ${R_EN_PL[r[1]]}`;
    case 3: return `Three of a Kind, ${R_EN_PL[r[0]]}`;
    case 4: return `Straight, ${R_EN[r[0]]} high`;
    case 5: return `Flush, ${R_EN[r[0]]} high`;
    case 6: return `Full House, ${R_EN_PL[r[0]]} full of ${R_EN_PL[r[1]]}`;
    case 7: return `Four of a Kind, ${R_EN_PL[r[0]]}`;
    default: return r[0] === 12 ? 'Royal Flush' : `Straight Flush, ${R_EN[r[0]]} high`;
  }
}
