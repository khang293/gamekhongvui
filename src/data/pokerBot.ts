// Máy chơi poker (/poker/). Quyết định chỉ dựa vào góc nhìn riêng của ghế (View): bài của mình, bài chung, pot, tiền cược, vị trí.
// Không bao giờ đọc bài của người khác. Xóa game poker thì xóa luôn file này.
import { evaluate, rankOf, suitOf } from './pokerEval';
import type { View, Action } from './pokerEngine';

export interface Profile {
  id: 'tight' | 'loose' | 'balanced';
  open: number;      // ngưỡng điểm Chen để mở tố
  call: number;      // ngưỡng điểm Chen để theo khi bị tố
  margin: number;    // phần xác suất thắng phải hơn pot odds mới theo
  betThr: number;    // xác suất thắng để cược lấy giá trị
  raiseThr: number;  // xác suất thắng để tố khi bị cược
  bluff: number;     // tần suất tố bluff cơ bản
  aggr: number;      // xác suất thật sự tố khi đủ mạnh
}
export const PROFILES: Record<Profile['id'], Profile> = {
  tight: { id: 'tight', open: 9, call: 10, margin: 0.07, betThr: 0.6, raiseThr: 0.8, bluff: 0.05, aggr: 0.55 },
  balanced: { id: 'balanced', open: 7, call: 8.5, margin: 0.03, betThr: 0.53, raiseThr: 0.72, bluff: 0.1, aggr: 0.7 },
  loose: { id: 'loose', open: 5, call: 6.5, margin: -0.03, betThr: 0.46, raiseThr: 0.64, bluff: 0.2, aggr: 0.85 },
};

// Điểm Chen cho 2 lá bài tẩy
export function chenScore(h: number[]): number {
  const r1 = rankOf(h[0]), r2 = rankOf(h[1]);
  const hi = Math.max(r1, r2), lo = Math.min(r1, r2);
  const val = (r: number) => (r === 12 ? 10 : r === 11 ? 8 : r === 10 ? 7 : r === 9 ? 6 : (r + 2) / 2);
  let s = val(hi);
  if (hi === lo) return Math.max(5, Math.ceil(s * 2));
  if (suitOf(h[0]) === suitOf(h[1])) s += 2;
  const gap = hi - lo - 1;
  s -= gap === 0 ? 0 : gap === 1 ? 1 : gap === 2 ? 2 : gap === 3 ? 4 : 5;
  if (gap <= 1 && hi < 10) s += 1; // dưới Đầm và gần nhau
  return Math.ceil(s);
}

function gauss(rng: () => number) { return (rng() + rng() + rng() + rng() - 2) / 0.58; }

// Xác suất thắng bằng mô phỏng Monte Carlo với số đối thủ cho trước (bài của họ là ngẫu nhiên)
export function equity(hole: number[], board: number[], nOpp: number, samples: number, rng: () => number, maxMs = 300): number {
  const known = new Set<number>([...hole, ...board]);
  const rest: number[] = [];
  for (let c = 0; c < 52; c++) if (!known.has(c)) rest.push(c);
  const t0 = Date.now();
  let win = 0, done = 0;
  const need = 5 - board.length + 2 * nOpp;
  const cards = new Array(7);
  for (let i = 0; i < samples; i++) {
    if ((i & 15) === 15 && Date.now() - t0 > maxMs) break;
    for (let k = 0; k < need; k++) { const j = k + Math.floor(rng() * (rest.length - k)); const tmp = rest[k]; rest[k] = rest[j]; rest[j] = tmp; }
    const full = board.slice();
    let p = 0;
    while (full.length < 5) full.push(rest[p++]);
    cards[0] = hole[0]; cards[1] = hole[1];
    for (let k = 0; k < 5; k++) cards[2 + k] = full[k];
    const mine = evaluate(cards);
    let better = false, ties = 0;
    for (let o = 0; o < nOpp; o++) {
      cards[0] = rest[p++]; cards[1] = rest[p++];
      const sc = evaluate(cards);
      if (sc > mine) { better = true; break; }
      if (sc === mine) ties++;
    }
    done++;
    if (!better) win += 1 / (ties + 1);
  }
  return done ? win / done : 0.5;
}

const LEVELS = [
  { samples: 70, noise: 0.1, mistake: 0.07, callBias: -0.04, bluff: 0.6 },
  { samples: 180, noise: 0.05, mistake: 0.02, callBias: 0, bluff: 1 },
  { samples: 420, noise: 0.02, mistake: 0, callBias: 0.01, bluff: 1.15 },
];

export function decide(v: View, profile: Profile, level: number, rng: () => number): Action {
  const lg = v.legal;
  const me = v.seats[v.me];
  const hole = me.hole as number[];
  const L = LEVELS[Math.max(0, Math.min(2, level - 1))];
  const fallback = (): Action => (lg.canCheck ? { type: 'check' } : { type: 'fold' });
  if (!lg.canAct || !hole || hole.length < 2) return fallback();

  const nSeats = v.seats.length;
  const opps = v.seats.filter((s) => s.id !== v.me && s.hasCards).length;
  const activeOpps = v.seats.filter((s) => s.id !== v.me && s.hasCards && !s.allIn).length;
  // vị trí: 0 = sớm ... 1 = nút
  const dist = (v.me - v.button + nSeats) % nSeats;
  const late = nSeats <= 2 ? (dist === 0) : (dist === 0 || dist === nSeats - 1 && nSeats >= 5);
  const posBonus = dist === 0 ? 1.5 : late ? 1 : dist === (v.bbSeat - v.button + nSeats) % nSeats || dist === (v.sbSeat - v.button + nSeats) % nSeats ? -0.3 : 0;
  const stackBB = me.stack / v.bb;

  const raiseTo = (target: number): Action => {
    if (!lg.canRaise) return lg.canCall ? { type: 'call' } : fallback();
    let to = Math.round(Math.max(lg.minRaiseTo, Math.min(lg.maxRaiseTo, target)) / 5) * 5;
    to = Math.max(lg.minRaiseTo, Math.min(lg.maxRaiseTo, to));
    if (to >= lg.maxRaiseTo * 0.7) return { type: 'allin' };
    return { type: 'raise', amount: to };
  };
  const callOrFold = (): Action => (lg.canCheck ? { type: 'check' } : lg.canCall ? { type: 'call' } : { type: 'fold' });

  // Người mới chơi sai ngẫu nhiên đôi khi
  if (L.mistake > 0 && rng() < L.mistake) return lg.canCheck ? { type: 'check' } : rng() < 0.5 && lg.canCall ? { type: 'call' } : { type: 'fold' };

  // ---------- Trước flop ----------
  if (v.board.length === 0) {
    const chen = chenScore(hole) + posBonus * 0.8;
    const facingRaise = v.currentBet > v.bb;
    const open = profile.open + (nSeats <= 3 ? -1 : 0);
    // Ngắn stack: đẩy hết hoặc bỏ
    if (stackBB <= 12) {
      if (chen >= open - 1 + (facingRaise ? 2 : 0)) return lg.canRaise ? { type: 'allin' } : callOrFold();
      return lg.canCheck ? { type: 'check' } : { type: 'fold' };
    }
    if (!facingRaise) {
      // chưa ai tố (có thể có người limp)
      const limpers = v.seats.filter((s) => s.id !== v.bbSeat && s.bet >= v.bb).length;
      if (chen >= open + (lg.canCheck ? 2 : 0)) {
        const sz = (2.5 + rng() * 1.2 + limpers) * v.bb;
        if (rng() < profile.aggr || chen >= 12) return raiseTo(sz);
        return lg.canCheck ? { type: 'check' } : { type: 'call' };
      }
      if (lg.canCheck) return { type: 'check' };
      // bù mù nhỏ hoặc limp
      if (lg.toCall <= v.bb / 2 + 0.01 && chen >= open - 2.5) return { type: 'call' };
      if (profile.id === 'loose' && chen >= open - 1 && lg.toCall <= v.bb && rng() < 0.5) return { type: 'call' };
      return { type: 'fold' };
    }
    // bị tố
    const bbs = lg.toCall / v.bb;
    // Bị tố rất lớn hoặc all-in: không thể dùng ngưỡng điểm Chen tăng theo số mù (lúc nào cũng bỏ).
    // Dùng xác suất thắng so với tay ngẫu nhiên và tỉ lệ cược, cộng thêm biên vì người đẩy hết thường có tay mạnh hơn trung bình.
    if (lg.canCall && lg.toCall >= me.stack * 0.35) {
      const eqPre = equity(hole, [], Math.max(1, Math.min(2, opps)), Math.min(L.samples, 260), rng, 250) + gauss(rng) * L.noise;
      const potOddsPre = lg.toCall / (v.pot + lg.toCall);
      const rangeAdj = profile.id === 'tight' ? 0.07 : profile.id === 'loose' ? 0.0 : 0.04;
      const needPre = Math.max(0.36, potOddsPre + rangeAdj - L.callBias);
      return eqPre >= needPre ? { type: 'call' } : { type: 'fold' };
    }
    const thr = profile.call + Math.max(0, bbs - 3) * 0.45 + (L.callBias < 0 ? -0.6 : 0);
    if (chen >= 12 && lg.canRaise && rng() < 0.9) return raiseTo(v.currentBet * 3 + rng() * v.bb);
    if (profile.id === 'loose' && lg.canRaise && chen >= 9 && rng() < 0.1 * L.bluff) return raiseTo(v.currentBet * 3);
    if (chen >= thr) return lg.canCall ? { type: 'call' } : callOrFold();
    if (lg.canCheck) return { type: 'check' };
    return { type: 'fold' };
  }

  // ---------- Sau flop ----------
  const nOpp = Math.max(1, opps);
  let eq = equity(hole, v.board, nOpp, L.samples, rng, 320);
  eq = Math.max(0, Math.min(1, eq + gauss(rng) * L.noise));
  const pot = v.pot;
  const toCall = lg.toCall;
  const multi = Math.max(0, nOpp - 1);

  if (toCall === 0) {
    const thr = profile.betThr - 0.04 * multi - posBonus * 0.01;
    if (lg.canRaise && eq > thr) {
      if (eq > 0.82 && rng() < 0.15) return { type: 'check' }; // bẫy
      const frac = 0.4 + 0.5 * Math.min(1, (eq - thr) / (1 - thr)) + rng() * 0.15;
      return raiseTo(v.currentBet + Math.max(v.bb, pot * frac));
    }
    const bluff = profile.bluff * L.bluff * (activeOpps <= 1 ? 1 : 0.35) * (late ? 1.4 : 1);
    if (lg.canRaise && activeOpps >= 1 && eq > 0.18 && rng() < bluff) return raiseTo(v.currentBet + Math.max(v.bb, pot * (0.4 + rng() * 0.25)));
    return { type: 'check' };
  }

  const potOdds = toCall / (pot + toCall);
  const stackAfter = me.stack - toCall;
  const commitFrac = toCall / Math.max(1, me.stack);
  let need = potOdds + profile.margin - L.callBias + (commitFrac > 0.4 ? 0.05 : 0) + (v.bb > 0 && toCall > pot ? 0.04 : 0);
  need += 0.015 * multi;
  const rThr = profile.raiseThr - 0.03 * multi;
  if (lg.canRaise && eq > rThr && rng() < profile.aggr) {
    const to = v.currentBet + Math.max(lg.toCall, pot * (0.6 + rng() * 0.5));
    return raiseTo(eq > 0.9 && stackAfter < pot ? lg.maxRaiseTo : to);
  }
  if (eq >= need) return lg.canCall ? { type: 'call' } : { type: 'fold' };
  const br = profile.bluff * L.bluff * 0.3;
  if (lg.canRaise && activeOpps === 1 && eq > 0.15 && commitFrac < 0.35 && rng() < br) return raiseTo(v.currentBet + Math.max(lg.toCall * 2, pot * 0.8));
  return { type: 'fold' };
}
