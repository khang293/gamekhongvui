// Luật Tiến lên miền Nam (/tienlen/). Chỉ có luật, không đụng tới giao diện, để sau này dùng lại cho phòng chơi online.
// Lá bài là số 0..51: id = hạng * 4 + chất. Hạng 0..12 = 3,4,...,10,J,Q,K,A,2 (2 lớn nhất). Chất 0..3 = bích, chuồn, rô, cơ (nhỏ → lớn).
// Nhờ vậy so sánh hai lá chỉ cần so id.
export const RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
export const SUITS = ['♠', '♣', '♦', '♥'];
export const rankOf = (c: number) => c >> 2;
export const suitOf = (c: number) => c & 3;
export const cardName = (c: number) => RANKS[rankOf(c)] + SUITS[suitOf(c)];
const TWO = 12; // hạng của lá 2

export type ComboType = 'single' | 'pair' | 'triple' | 'quad' | 'run' | 'pairs';
export interface Combo {
  type: ComboType;
  len: number;     // single..quad: số lá (1..4); run: số lá; pairs: số đôi
  cards: number[]; // đã sắp tăng dần
  top: number;     // lá lớn nhất
}

// ---------- Nhận dạng bộ bài ----------
export function detectCombo(cards: number[]): Combo | null {
  const n = cards.length;
  if (n === 0) return null;
  const cs = [...cards].sort((a, b) => a - b);
  for (let i = 1; i < n; i++) if (cs[i] === cs[i - 1]) return null;
  for (const c of cs) if (c < 0 || c > 51 || !Number.isInteger(c)) return null;
  const rk = cs.map(rankOf);
  const top = cs[n - 1];
  if (n === 1) return { type: 'single', len: 1, cards: cs, top };
  if (rk.every((r) => r === rk[0])) {
    if (n === 2) return { type: 'pair', len: 2, cards: cs, top };
    if (n === 3) return { type: 'triple', len: 3, cards: cs, top };
    if (n === 4) return { type: 'quad', len: 4, cards: cs, top };
    return null;
  }
  if (rk[n - 1] > 11) return null; // sảnh và đôi thông không có lá 2
  if (n >= 3 && rk.every((r, i) => i === 0 || r === rk[i - 1] + 1)) return { type: 'run', len: n, cards: cs, top };
  if (n >= 6 && n % 2 === 0) {
    let ok = true;
    for (let i = 0; i < n; i += 2) {
      if (rk[i] !== rk[i + 1]) { ok = false; break; }
      if (i > 0 && rk[i] !== rk[i - 2] + 1) { ok = false; break; }
    }
    if (ok) return { type: 'pairs', len: n / 2, cards: cs, top };
  }
  return null;
}

// ---------- Bảng chặt (một nơi duy nhất) ----------
// victim: bộ đang nằm trên bàn bị chặt. by: các bộ được phép chặt nó (ngoài luật thường: cùng loại, cùng độ dài, lớn hơn).
//   exact: đúng số đôi / số lá; atLeast: từ số đó trở lên.
export type Matcher = { type: ComboType; len?: number; atLeast?: number };
export const CHOP_TABLE: { victim: string; by: Matcher[] }[] = [
  // (a) một lá 2: tứ quý, 3 / 4 / 5+ đôi thông
  { victim: 'single2', by: [{ type: 'quad' }, { type: 'pairs', len: 3 }, { type: 'pairs', len: 4 }, { type: 'pairs', atLeast: 5 }] },
  // (b) đôi 2: tứ quý, 4 / 5+ đôi thông
  { victim: 'pair2', by: [{ type: 'quad' }, { type: 'pairs', len: 4 }, { type: 'pairs', atLeast: 5 }] },
  // (c) sám 2: chỉ 5+ đôi thông
  { victim: 'triple2', by: [{ type: 'pairs', atLeast: 5 }] },
  // (d) tứ quý: 4 đôi thông (tứ quý lớn hơn đã có luật thường)
  { victim: 'quad', by: [{ type: 'pairs', len: 4 }] },
  // (e) 3 đôi thông: tứ quý (3 đôi thông lớn hơn đã có luật thường); 4 đôi thông: 5+ đôi thông (4 đôi thông lớn hơn có luật thường)
  { victim: 'pairs3', by: [{ type: 'quad' }] },
  { victim: 'pairs4', by: [{ type: 'pairs', atLeast: 5 }] },
];

export function victimKey(c: Combo): string | null {
  if (c.type === 'single' && rankOf(c.top) === TWO) return 'single2';
  if (c.type === 'pair' && rankOf(c.top) === TWO) return 'pair2';
  if (c.type === 'triple' && rankOf(c.top) === TWO) return 'triple2';
  if (c.type === 'quad') return 'quad';
  if (c.type === 'pairs' && c.len === 3) return 'pairs3';
  if (c.type === 'pairs' && c.len === 4) return 'pairs4';
  return null;
}
const matches = (m: Matcher, c: Combo) => c.type === m.type && (m.len !== undefined ? c.len === m.len : m.atLeast !== undefined ? c.len >= m.atLeast : true);

// next có đánh được prev không (prev = bộ trên bàn, null = đang là lượt dẫn)
export function canBeat(prev: Combo | null, next: Combo): boolean {
  if (!prev) return true;
  if (next.type === prev.type && next.len === prev.len) return next.top > prev.top;
  const k = victimKey(prev);
  if (!k) return false;
  const row = CHOP_TABLE.find((r) => r.victim === k);
  return !!row && row.by.some((m) => matches(m, next));
}
// Tứ quý và 3 / 4 đôi thông: đè được chúng bằng bất cứ cách nào (kể cả cùng loại lớn hơn) đều tính là chặt (chặt chồng có điểm).
// Các bộ khác (kể cả lá 2 đè lá 2) đè cùng loại thì chỉ là đè bình thường.
const isBomb = (c: Combo) => { const k = victimKey(c); return k === 'quad' || k === 'pairs3' || k === 'pairs4'; };
export const isChop = (prev: Combo | null, next: Combo) => !!prev && canBeat(prev, next) && (isBomb(prev) || !(next.type === prev.type && next.len === prev.len));

// ---------- Liệt kê mọi bộ hợp lệ từ một tay bài ----------
function combos<T>(arr: T[], k: number): T[][] {
  const out: T[][] = [];
  const rec = (start: number, cur: T[]) => {
    if (cur.length === k) { out.push(cur.slice()); return; }
    for (let i = start; i < arr.length; i++) { cur.push(arr[i]); rec(i + 1, cur); cur.pop(); }
  };
  rec(0, []);
  return out;
}
export function enumerateCombos(hand: number[]): Combo[] {
  const by: number[][] = Array.from({ length: 13 }, () => []);
  for (const c of [...hand].sort((a, b) => a - b)) by[rankOf(c)].push(c);
  const out: Combo[] = [];
  const push = (cards: number[]) => { const c = detectCombo(cards); if (c) out.push(c); };
  for (let r = 0; r < 13; r++) {
    const g = by[r];
    for (let k = 1; k <= Math.min(4, g.length); k++) for (const s of combos(g, k)) push(s);
  }
  // sảnh: mỗi hạng chọn một lá
  for (let r0 = 0; r0 <= 9; r0++) {
    for (let r1 = r0 + 2; r1 <= 11; r1++) {
      let ok = true;
      for (let r = r0; r <= r1; r++) if (!by[r].length) { ok = false; break; }
      if (!ok) break;
      const rec = (r: number, cur: number[]) => {
        if (r > r1) { push(cur.slice()); return; }
        for (const c of by[r]) { cur.push(c); rec(r + 1, cur); cur.pop(); }
      };
      rec(r0, []);
    }
  }
  // đôi thông: mỗi hạng chọn một đôi
  for (let r0 = 0; r0 <= 9; r0++) {
    for (let r1 = r0 + 2; r1 <= 11; r1++) {
      let ok = true;
      for (let r = r0; r <= r1; r++) if (by[r].length < 2) { ok = false; break; }
      if (!ok) break;
      const rec = (r: number, cur: number[]) => {
        if (r > r1) { push(cur.slice()); return; }
        for (const p of combos(by[r], 2)) { rec(r + 1, cur.concat(p)); }
      };
      rec(r0, []);
    }
  }
  return out;
}
export const playsBeating = (hand: number[], table: Combo | null) => enumerateCombos(hand).filter((c) => canBeat(table, c));

// ---------- Tới trắng ----------
export type WhiteKind = 'quad2' | 'dragon' | 'fivePairs' | 'sixPairs';
export function checkWhite(hand: number[]): WhiteKind | null {
  const cnt = new Array(13).fill(0);
  for (const c of hand) cnt[rankOf(c)]++;
  if (cnt[TWO] === 4) return 'quad2';
  if (cnt.slice(0, 12).every((x) => x >= 1)) return 'dragon';
  for (let r = 0; r + 4 <= 11; r++) { let ok = true; for (let k = 0; k < 5; k++) if (cnt[r + k] < 2) ok = false; if (ok) return 'fivePairs'; }
  let pairs = 0;
  for (const x of cnt) pairs += x >> 1;
  if (pairs >= 6) return 'sixPairs';
  return null;
}

// ---------- Trạng thái ván ----------
export interface LogEntry { seat: number; combo: Combo | null; chop?: boolean }
// Mọi lần chặt (heo, tứ quý, đôi thông) theo thứ tự, dùng cho chế độ tính điểm. chain: các lần chặt nối tiếp nhau (chặt chồng) có cùng số.
// key: loại bộ bị chặt (single2, pair2, triple2, quad, pairs3, pairs4); cards: các lá của bộ bị chặt.
// free: người bị chặt đã hết bài (đã về) lúc bị chặt: vẫn chặt đè được nhưng không ai bị trừ hay được cộng.
export interface ChopEvt { chopper: number; victim: number; key: string; cards: number[]; chain: number; free: boolean }
export interface TLState {
  n: number;
  hands: number[][];
  cur: number;
  table: Combo | null;
  tableBy: number;
  passed: boolean[];
  played: number[];       // số lần mỗi người đã đánh bài
  log: LogEntry[];
  playedCards: number[];  // mọi lá đã ra bàn (công khai)
  over: boolean;
  winner: number;
  white: { seat: number; kind: WhiteKind } | null;
  order: number[];        // thứ tự về đích khi hết ván (người thắng đứng đầu, còn lại theo số lá còn)
  firstHand: boolean;
  chopEvents: ChopEvt[];  // mọi lần chặt trong ván (heo, tứ quý, đôi thông), dùng để tính chip và điểm
  tableChop: boolean;     // bộ đang trên bàn có phải là một lần chặt không (để nối chuỗi chặt chồng)
  chainSeq: number;       // số chuỗi chặt chồng đã dùng
  multi: boolean;         // chế độ tính điểm: ván tiếp tục sau khi có người về nhất cho tới khi xếp xong hạng nhất, nhì, ba, bét
  finished: number[];     // thứ tự những người đã hết bài (chỉ dùng khi multi); khi ván xong có đủ n người, người cuối là bét
  thoi: number[];         // chỉ khi multi: những người chưa đánh được lá nào tại thời điểm có người về nhất (thối bài)
  heo: number[];          // các lá 2 đang chồng trên bàn (heo đè heo cùng kiểu); bị chặt thì người đánh bộ cuối đền hết
}

export function newGame(n: number, leader = -1, rng: () => number = Math.random, opts: { multi?: boolean } = {}): TLState {
  if (n < 2 || n > 4) throw new Error('n must be 2..4');
  const deck = Array.from({ length: 52 }, (_, i) => i);
  for (let i = 51; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
  const hands = Array.from({ length: n }, (_, i) => deck.slice(i * 13, i * 13 + 13).sort((a, b) => a - b));
  let cur = leader;
  const firstHand = leader < 0;
  if (firstHand) { // người giữ lá nhỏ nhất trong số bài đã chia (3 bích nếu có)
    let low = 99; cur = 0;
    hands.forEach((h, i) => { if (h[0] < low) { low = h[0]; cur = i; } });
  }
  const st: TLState = {
    n, hands, cur, table: null, tableBy: cur, passed: new Array(n).fill(false), played: new Array(n).fill(0),
    log: [], playedCards: [], over: false, winner: -1, white: null, order: [], firstHand, chopEvents: [], tableChop: false, chainSeq: 0, multi: !!opts.multi, finished: [], thoi: [], heo: [],
  };
  for (let i = 0; i < n; i++) {
    const k = checkWhite(hands[i]);
    if (k) { st.white = { seat: i, kind: k }; st.over = true; st.winner = i; st.order = finishOrder(st, i); st.cur = i; break; }
  }
  return st;
}

function finishOrder(st: TLState, winner: number): number[] {
  const rest: number[] = [];
  for (let k = 1; k < st.n; k++) rest.push((winner + k) % st.n);
  rest.sort((a, b) => st.hands[a].length - st.hands[b].length); // sort ổn định: hòa thì theo thứ tự lượt
  return [winner, ...rest];
}

export type Reason = 'over' | 'notTurn' | 'empty' | 'notInHand' | 'invalid' | 'cannotBeat' | 'mustLead';
export function checkPlay(st: TLState, seat: number, cards: number[]): { ok: true; combo: Combo } | { ok: false; reason: Reason } {
  if (st.over) return { ok: false, reason: 'over' };
  if (seat !== st.cur) return { ok: false, reason: 'notTurn' };
  if (!cards.length) return { ok: false, reason: 'empty' };
  const h = st.hands[seat];
  for (const c of cards) if (!h.includes(c)) return { ok: false, reason: 'notInHand' };
  const combo = detectCombo(cards);
  if (!combo) return { ok: false, reason: 'invalid' };
  if (!canBeat(st.table, combo)) return { ok: false, reason: 'cannotBeat' };
  return { ok: true, combo };
}
export const isValidPlay = (st: TLState, seat: number, cards: number[]) => checkPlay(st, seat, cards).ok;
export function legalPlays(st: TLState, seat: number): Combo[] {
  if (st.over || seat !== st.cur) return [];
  return playsBeating(st.hands[seat], st.table);
}

// Chuyển lượt: bỏ qua người đã bỏ vòng và người đã hết bài; hết vòng thì người đánh cuối dẫn tiếp.
// Nếu người đánh cuối vừa hết bài (chế độ nhiều hạng) và mọi người còn lại đều bỏ, quyền dẫn về người kế tiếp còn bài theo thứ tự ghế.
function advance(st: TLState) {
  const done = (s: number) => st.hands[s].length === 0;
  for (let i = 1; i <= st.n; i++) {
    const s = (st.cur + i) % st.n;
    if (done(s)) continue;
    if (s === st.tableBy) { st.table = null; st.tableChop = false; st.passed = new Array(st.n).fill(false); st.cur = s; return; }
    if (!st.passed[s]) { st.cur = s; return; }
  }
  for (let k = 1; k <= st.n; k++) {
    const s = (st.tableBy + k) % st.n;
    if (!done(s)) { st.table = null; st.tableChop = false; st.passed = new Array(st.n).fill(false); st.cur = s; return; }
  }
}

export function play(st: TLState, seat: number, cards: number[]): { ok: true; combo: Combo; chop: boolean } | { ok: false; reason: Reason } {
  const r = checkPlay(st, seat, cards);
  if (!r.ok) return r;
  const combo = r.combo;
  const chop = isChop(st.table, combo);
  if (chop && st.table) {
    // chặt chồng: bộ trên bàn cũng là một lần chặt thì cùng một chuỗi
    const chain = st.tableChop ? st.chainSeq : ++st.chainSeq;
    st.chopEvents.push({ chopper: seat, victim: st.tableBy, key: victimKey(st.table) as string, cards: (st.heo.length ? st.heo : st.table.cards).slice(), chain, free: st.multi && !st.hands[st.tableBy].length });
  }
  // chồng heo: đè heo bằng heo cùng kiểu thì cộng thêm; bộ không phải heo thì xóa chồng
  if (/2$/.test(victimKey(combo) || '')) st.heo = !chop && st.table && st.heo.length ? [...st.heo, ...combo.cards] : combo.cards.slice();
  else st.heo = [];
  st.hands[seat] = st.hands[seat].filter((c) => !combo.cards.includes(c));
  st.table = combo; st.tableBy = seat; st.tableChop = chop; st.played[seat]++;
  st.playedCards.push(...combo.cards);
  st.log.push({ seat, combo, chop });
  if (!st.hands[seat].length) {
    if (!st.multi) { st.over = true; st.winner = seat; st.order = finishOrder(st, seat); return { ok: true, combo, chop }; }
    // nhiều hạng: người này về hạng kế tiếp; ván xong khi chỉ còn một người còn bài (người đó về bét)
    st.finished.push(seat);
    // thối bài chốt đúng lúc có người về nhất, dù sau đó họ vẫn đánh tiếp
    if (st.finished.length === 1) st.thoi = st.played.map((p, k) => (k !== seat && p === 0 ? k : -1)).filter((k) => k >= 0);
    if (st.finished.length >= st.n - 1) {
      for (let k = 0; k < st.n; k++) if (!st.finished.includes(k)) st.finished.push(k);
      st.order = st.finished.slice(); st.winner = st.order[0]; st.over = true;
      return { ok: true, combo, chop };
    }
  }
  advance(st);
  return { ok: true, combo, chop };
}

export function pass(st: TLState, seat: number): { ok: true } | { ok: false; reason: Reason } {
  if (st.over) return { ok: false, reason: 'over' };
  if (seat !== st.cur) return { ok: false, reason: 'notTurn' };
  if (!st.table) return { ok: false, reason: 'mustLead' };
  st.passed[seat] = true;
  st.log.push({ seat, combo: null });
  advance(st);
  return { ok: true };
}

// ---------- Góc nhìn của một người chơi (không lộ bài người khác) ----------
export interface View {
  n: number; seat: number; hand: number[]; counts: number[];
  table: Combo | null; tableBy: number; passed: boolean[]; cur: number; played: number[];
  playedCards: number[]; log: LogEntry[]; over: boolean; winner: number; white: TLState['white']; order: number[];
  chopEvents: ChopEvt[]; // công khai: ai chặt ai trong ván
  multi: boolean; finished: number[]; // chế độ nhiều hạng: ai đã về đích và theo thứ tự nào (công khai)
  hands?: number[][]; // chỉ có khi ván đã kết thúc
}
export function viewFor(st: TLState, seat: number): View {
  const v: View = {
    n: st.n, seat, hand: st.hands[seat].slice(), counts: st.hands.map((h) => h.length),
    table: st.table, tableBy: st.tableBy, passed: st.passed.slice(), cur: st.cur, played: st.played.slice(),
    playedCards: st.playedCards.slice(), log: st.log.slice(), over: st.over, winner: st.winner, white: st.white, order: st.order.slice(),
    chopEvents: st.chopEvents.map((e) => ({ ...e, cards: e.cards.slice() })),
    multi: st.multi, finished: st.finished.slice(),
  };
  if (st.over) v.hands = st.hands.map((h) => h.slice());
  return v;
}
