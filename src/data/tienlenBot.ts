// Máy chơi Tiến lên miền Nam (/tienlen/). Chỉ dùng bài của chính nó và thông tin công khai (số lá của người khác, bài đã ra).
import { rankOf, detectCombo, canBeat, isChop, enumerateCombos, type Combo, type View } from './tienlenEngine';

export type BotMove = { cards: number[] } | { pass: true };
const TWO = 12;

// ---------- Chia tay bài thành ít bộ nhất (đơn, đôi, sám, tứ quý, sảnh, đôi thông) ----------
type Plan = { cost: number; groups: number[][] };
const memo = new Map<string, Plan>();

function solvePlan(rem: number[]): Plan {
  if (!rem.length) return { cost: 0, groups: [] };
  const key = rem.join(',');
  const hit = memo.get(key);
  if (hit) return hit;
  const by: number[][] = Array.from({ length: 13 }, () => []);
  for (const c of rem) by[rankOf(c)].push(c);
  const c0 = rem[0], r0 = rankOf(c0);
  const opts: number[][] = [[c0]];
  const g = by[r0];
  for (let k = 2; k <= g.length; k++) opts.push(g.slice(0, k));
  // sảnh bắt đầu từ lá nhỏ nhất, mỗi hạng lấy lá nhỏ nhất
  for (let r1 = r0 + 2; r1 <= 11; r1++) {
    let ok = true;
    for (let r = r0; r <= r1; r++) if (!by[r].length) { ok = false; break; }
    if (!ok) break;
    const o: number[] = [];
    for (let r = r0; r <= r1; r++) o.push(by[r][0]);
    opts.push(o);
  }
  // đôi thông
  if (g.length >= 2) {
    for (let r1 = r0 + 2; r1 <= 11; r1++) {
      let ok = true;
      for (let r = r0; r <= r1; r++) if (by[r].length < 2) { ok = false; break; }
      if (!ok) break;
      const o: number[] = [];
      for (let r = r0; r <= r1; r++) o.push(by[r][0], by[r][1]);
      opts.push(o);
    }
  }
  let best: Plan | null = null;
  for (const o of opts) {
    const rest = rem.filter((x) => !o.includes(x));
    const sub = solvePlan(rest);
    // mỗi bộ tốn một lượt; lá lẻ bị phạt thêm, lá lẻ nhỏ phạt nhiều hơn một chút vì khó thắng vòng
    const cost = sub.cost + 100 + (o.length === 1 ? 10 : 0);
    if (!best || cost < best.cost) best = { cost, groups: [o, ...sub.groups] };
  }
  if (memo.size > 150000) memo.clear();
  memo.set(key, best!);
  return best!;
}
export const planHand = (hand: number[]) => solvePlan([...hand].sort((a, b) => a - b));
const planCount = (hand: number[]) => planHand(hand).groups.length;

const comboKey = (c: Combo) => c.cards.join(',');
function minOpp(v: View): number {
  let m = 99;
  for (let i = 0; i < v.n; i++) if (i !== v.seat && v.counts[i] > 0) m = Math.min(m, v.counts[i]);
  return m;
}
const usesTwo = (c: Combo) => c.cards.some((x) => rankOf(x) === TWO);

// Quyết định nước đi. level 1 = Dễ, 2 = Thường, 3 = Khó
// chips = true: chế độ tính chip (chặt heo có lời, đừng giữ heo đỏ trên tay đến cuối ván)
export function botDecide(v: View, level = 2, rng: () => number = Math.random, chips = false): BotMove {
  const hand = v.hand;
  const all = enumerateCombos(hand);
  const legal = all.filter((c) => canBeat(v.table, c));
  if (!legal.length) return { pass: true }; // không đánh được thì buộc bỏ lượt (khi dẫn luôn có bài để đánh)
  // đánh hết bài được thì đánh
  const fin = legal.find((c) => c.cards.length === hand.length);
  if (fin) return { cards: fin.cards };

  const danger = minOpp(v);
  const leading = !v.table;

  if (level === 1) { // Dễ: hay đánh ngẫu nhiên, đôi khi bỏ lượt
    if (!leading && danger > 3 && rng() < 0.25) return { pass: true };
    if (rng() < 0.5) { const sorted = legal.slice().sort((a, b) => a.top - b.top || a.cards.length - b.cards.length); return { cards: sorted[0].cards }; }
    return { cards: legal[Math.floor(rng() * legal.length)].cards };
  }

  const plan = planHand(hand);

  if (leading) {
    // dẫn: bộ thấp nhất trong cách chia; có người sắp hết bài thì tránh dẫn lá lẻ nhỏ
    const groups = plan.groups.map((g) => detectCombo(g)!).filter(Boolean).sort((a, b) => a.top - b.top || b.cards.length - a.cards.length);
    let cands = groups.filter((g) => !(g.type === 'single' && rankOf(g.top) === TWO) && !(g.type === 'quad' && groups.length > 2));
    if (!cands.length) cands = groups;
    if (danger <= 1) { // đối thủ còn 1 lá: đừng dẫn lá lẻ trừ khi là lá lớn nhất
      const nonSingle = cands.filter((g) => g.type !== 'single');
      if (nonSingle.length) return { cards: nonSingle[0].cards };
      const singles = groups.filter((g) => g.type === 'single').sort((a, b) => b.top - a.top);
      return { cards: singles[0].cards };
    }
    if (level === 3 && groups.length <= 3 && groups.length >= 2) {
      // gần hết bài: dẫn bộ thấp, giữ bộ mạnh nhất (thường là lá 2) để đánh sau
      const low = cands[0];
      return { cards: low.cards };
    }
    return { cards: cands[0].cards };
  }

  // theo bài: chọn nước mà phần còn lại chia ra ít bộ nhất; tránh phí lá 2 và tứ quý
  const threat = danger <= 3 || v.counts[v.tableBy] <= 2;
  const cands = legal.slice().sort((a, b) => a.top - b.top || a.cards.length - b.cards.length);
  const pool = cands.slice(0, 14);
  for (const c of cands) if (isChop(v.table, c) && !pool.includes(c)) pool.push(c);
  const base = planCount(hand);
  let bestC: Combo | null = null, bestScore = Infinity;
  for (const c of pool) {
    const rest = hand.filter((x) => !c.cards.includes(x));
    let s = planCount(rest) * 100 + rankOf(c.top) + c.cards.length * 0.5;
    const premium = usesTwo(c) || c.type === 'quad' || (c.type === 'pairs' && c.len >= 4);
    if (premium) s += level === 3 ? 90 : 35;
    if (isChop(v.table, c) && v.table && !usesTwo(v.table)) s += level === 3 ? 60 : 20; // chặt bộ không phải 2 hiếm khi cần
    if (chips && level >= 2) {
      if (isChop(v.table, c) && v.table && v.table.cards.every((x) => rankOf(x) === TWO)) s -= 40; // chặt heo ăn chip
      const red = c.cards.filter((x) => rankOf(x) === TWO && x % 4 >= 2).length;
      s -= red * 12; // đánh được heo đỏ ra thì bớt thối heo đỏ
    }
    if (threat) s -= 500;
    if (s < bestScore) { bestScore = s; bestC = c; }
  }
  if (!bestC) return { pass: true };
  const passScore = base * 100 + (threat ? 0 : level === 3 ? 15 : 40);
  if (!threat && bestScore > passScore && level >= 2) return { pass: true };
  return { cards: bestC.cards };
}
export { comboKey };
