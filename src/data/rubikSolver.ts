// Bot giải Rubik theo đúng 7 bước đang dạy trong /rubik/ (phương pháp từng tầng). Thuần logic, không đụng DOM.
// Mỗi bước tìm chuỗi nước ngắn nhất trong tập "nước đi được dạy" (xoay mặt, và các thuật toán trong bài), giữ nguyên mọi mảnh đã xong.
import { solved, applyMove, type State, type V3 } from './rubikEngine';

const BASE = solved(); // thứ tự mảnh dán cố định = đánh số "ô" 0..53
const N = BASE.length;
const SLOT = new Map<string, number>();
BASE.forEach((t, i) => SLOT.set(t.p.join(',') + '|' + t.d.join(','), i));
const slotOf = (p: V3, d: V3) => SLOT.get(p.join(',') + '|' + d.join(','))!;
const P = BASE.map((t) => t.p), D = BASE.map((t) => t.d);

// ---------- hoán vị ô của từng nước ----------
const permCache = new Map<string, Uint8Array>();
function perm(tok: string): Uint8Array {
  let r = permCache.get(tok);
  if (r) return r;
  const s: State = BASE.map((t, i) => ({ p: [...t.p] as V3, d: [...t.d] as V3, c: i }));
  applyMove(s, tok);
  r = new Uint8Array(N);
  for (let i = 0; i < N; i++) r[i] = slotOf(s[i].p, s[i].d);
  permCache.set(tok, r);
  return r;
}
function composePerm(tokens: string[]): Uint8Array {
  let cur = new Uint8Array(N); for (let i = 0; i < N; i++) cur[i] = i;
  for (const t of tokens) { const p = perm(t); const nx = new Uint8Array(N); for (let i = 0; i < N; i++) nx[i] = p[cur[i]]; cur = nx; }
  return cur;
}
const applyCols = (cols: Uint8Array, to: Uint8Array) => { const o = new Uint8Array(N); for (let i = 0; i < N; i++) o[to[i]] = cols[i]; return o; };
export const toCols = (s: State): Uint8Array => { const c = new Uint8Array(N); for (const t of s) c[slotOf(t.p, t.d)] = t.c; return c; };

// ---------- hình học ----------
const DIRS: Record<string, V3> = { U: [0, -1, 0], D: [0, 1, 0], L: [-1, 0, 0], R: [1, 0, 0], F: [0, 0, 1], B: [0, 0, -1] };
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const centreSlot = (d: V3) => slotOf(d, d);
function centreFaceOf(cols: Uint8Array): Map<number, V3> { // màu -> mặt có tâm màu đó
  const m = new Map<number, V3>();
  for (const k of Object.keys(DIRS)) m.set(cols[centreSlot(DIRS[k])], DIRS[k]);
  return m;
}
function piecesAt(): Map<string, number[]> { // vị trí -> các ô của mảnh đó (cạnh, góc)
  const m = new Map<string, number[]>();
  for (let i = 0; i < N; i++) {
    const nz = P[i].filter((x) => x !== 0).length;
    if (nz < 2) continue;
    const k = P[i].join(',');
    const a = m.get(k); if (a) a.push(i); else m.set(k, [i]);
  }
  return m;
}
const PIECES = piecesAt();
const sameSet = (a: number[], b: number[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

// ---------- tìm đường (Dijkstra theo số nước) trên các ô đang theo dõi ----------
export interface Macro { tokens: string[]; cost: number; to: Uint8Array; }
const mk = (tokens: string[], cost?: number): Macro => ({ tokens, cost: cost ?? tokens.filter((t) => !/^[xyz]/.test(t)).length, to: composePerm(tokens) });
const parseAlg = (s: string) => s.trim().split(/\s+/);
const ROT = [[], ['y'], ['y2'], ["y'"]];
const INVROT = [[], ["y'"], ['y2'], ['y']];
const conj = (alg: string[], k: number): string[] => [...ROT[k], ...alg, ...INVROT[k]];

const FACE_MOVES = ['U', "U'", 'U2', 'D', "D'", 'D2', 'L', "L'", 'L2', 'R', "R'", 'R2', 'F', "F'", 'F2', 'B', "B'", 'B2'].map((t) => mk([t]));
const UMOVES = ['U', "U'", 'U2'].map((t) => mk([t]));
const withConj = (alg: string, label = alg) => [0, 1, 2, 3].map((k) => mk(conj(parseAlg(alg), k)));
export const ALG = {
  corner: "R U R' U'",
  midR: "U R U' R' U' F' U F",
  midL: "U' L' U L U F U' F'",
  line: "F R U R' U' F'",
  ell: "F U R U' R' F'",
  edges: "R U R' U R U2 R' U",
  corners: "U R U' L' U R' U' L",
  twist: "R' D' R D",
};

function search(start: number[], goal: number[], macros: Macro[], maxCost: number): Macro[] | null {
  const key = (s: number[]) => String.fromCharCode(...s);
  const gk = key(goal);
  if (key(start) === gk) return [];
  const best = new Map<string, number>([[key(start), 0]]);
  const prev = new Map<string, { from: string; m: Macro }>();
  const buckets: { s: number[]; k: string }[][] = [];
  const push = (c: number, s: number[], k: string) => { (buckets[c] ||= []).push({ s, k }); };
  push(0, start, key(start));
  for (let c = 0; c <= maxCost; c++) {
    const b = buckets[c]; if (!b) continue;
    for (let i = 0; i < b.length; i++) {
      const { s, k } = b[i];
      if (best.get(k) !== c) continue;
      if (k === gk) {
        const out: Macro[] = []; let cur = k;
        while (prev.has(cur)) { const pv = prev.get(cur)!; out.push(pv.m); cur = pv.from; }
        return out.reverse();
      }
      for (const m of macros) {
        const nc = c + m.cost; if (nc > maxCost) continue;
        const ns = s.map((x) => m.to[x]); const nk = key(ns);
        const old = best.get(nk);
        if (old === undefined || nc < old) { best.set(nk, nc); prev.set(nk, { from: k, m }); push(nc, ns, nk); }
      }
    }
  }
  return null;
}

// Theo dõi một nhóm mảnh (theo bộ màu): trả về ô hiện tại và ô đích của từng mảnh dán
function track(cols: Uint8Array, sets: number[][]): { cur: number[]; goal: number[] } {
  const cf = centreFaceOf(cols);
  const cur: number[] = [], goal: number[] = [];
  for (const S of sets) {
    let found: number[] | null = null;
    for (const [, slots] of PIECES) { if (sameSet(slots.map((i) => cols[i]), S)) { found = slots; break; } }
    if (!found) throw new Error('không tìm thấy mảnh ' + S.join());
    let pg: V3 = [0, 0, 0]; for (const c of S) pg = add(pg, cf.get(c)!);
    for (const i of found) { cur.push(i); goal.push(slotOf(pg, cf.get(cols[i])!)); }
  }
  return { cur, goal };
}

export interface Stage { step: number; tokens: string[]; }

// Gộp các nước liền kề cùng trục (U U -> U2, y y' -> bỏ) cho gọn
export function simplify(tokens: string[]): string[] {
  const out: { b: string; t: number }[] = [];
  for (const tk of tokens) {
    const b = tk[0], t = tk.length === 1 ? 1 : tk[1] === "'" ? 3 : 2;
    const top = out[out.length - 1];
    if (top && top.b === b) { top.t = (top.t + t) % 4; if (top.t === 0) out.pop(); } else out.push({ b, t });
  }
  return out.map((x) => x.b + (x.t === 1 ? '' : x.t === 2 ? '2' : "'"));
}

const faceColour = (cols: Uint8Array, k: string) => cols[centreSlot(DIRS[k])];

export function solve(start: State): Stage[] {
  let cols = toCols(start);
  const stages: Stage[] = [];
  const emit = (step: number, tokens: string[]) => { const tk = simplify(tokens); if (tk.length) stages.push({ step, tokens: tk }); };
  const run = (toks: string[]) => { cols = applyCols(cols, composePerm(toks)); };
  const WHITE = cols[centreSlot(DIRS.U)] === 0 ? 0 : 0; // trắng = màu 0

  // đưa tâm trắng lên trên
  const pre: string[] = [];
  for (const r of [[], ['x'], ["x'"], ['x2'], ['z'], ["z'"]]) {
    const c2 = applyCols(cols, composePerm(r));
    if (c2[centreSlot(DIRS.U)] === WHITE) { pre.push(...r); cols = c2; break; }
  }
  const side = ['F', 'R', 'B', 'L'];
  const sideCols = () => side.map((k) => faceColour(cols, k));

  // Bước 1: dấu cộng trắng (4 cạnh)
  {
    const t: string[] = [...pre];
    const done: number[][] = [];
    for (const c of sideCols()) {
      const sets = [...done, [WHITE, c]];
      const { cur, goal } = track(cols, sets);
      const path = search(cur, goal, FACE_MOVES, 12);
      if (!path) throw new Error('bước 1 không tìm được lời giải');
      for (const m of path) { t.push(...m.tokens); run(m.tokens); }
      done.push([WHITE, c]);
    }
    emit(1, t);
  }
  // lật khối: trắng xuống dưới
  const flip = ['x2']; run(flip);
  const sc = () => side.map((k) => faceColour(cols, k));
  const crossSets = (): number[][] => sc().map((c) => [WHITE, c]);

  // Bước 2: 4 góc trắng
  {
    const t: string[] = [...flip];
    const macros = [...UMOVES, ...withConj(ALG.corner)];
    const done: number[][] = [];
    const s = sc();
    for (let i = 0; i < 4; i++) {
      const set = [WHITE, s[i], s[(i + 1) % 4]];
      const { cur, goal } = track(cols, [...crossSets(), ...done, set]);
      const path = search(cur, goal, macros, 40);
      if (!path) throw new Error('bước 2 không tìm được lời giải');
      for (const m of path) { t.push(...m.tokens); run(m.tokens); }
      done.push(set);
    }
    emit(2, t);
  }
  // Bước 3: 4 cạnh tầng giữa
  {
    const t: string[] = [];
    const macros = [...UMOVES, ...withConj(ALG.midR), ...withConj(ALG.midL)];
    const s = sc();
    const cornerSets = s.map((c, i) => [WHITE, c, s[(i + 1) % 4]]);
    const done: number[][] = [];
    for (let i = 0; i < 4; i++) {
      const set = [s[i], s[(i + 1) % 4]];
      const { cur, goal } = track(cols, [...crossSets(), ...cornerSets, ...done, set]);
      const path = search(cur, goal, macros, 60);
      if (!path) throw new Error('bước 3 không tìm được lời giải');
      for (const m of path) { t.push(...m.tokens); run(m.tokens); }
      done.push(set);
    }
    emit(3, t);
  }
  // Bước 4-7: tầng trên (đã có hai tầng dưới). Tìm theo trạng thái màu của các ô lớp trên.
  const topSlots: number[] = []; for (let i = 0; i < N; i++) if (P[i][1] === -1) topSlots.push(i);
  const ySlots = (): number => 0; void ySlots;
  const lastLayer = (step: number, macros: Macro[], ok: (c: Uint8Array) => boolean, maxCost: number, full = false) => {
    if (ok(cols)) return;
    // bước 7 làm lộn xộn tầng dưới tạm thời, nên khóa trạng thái phải gồm cả khối; các bước 4-6 giữ nguyên hai tầng dưới
    const topKey = (c: Uint8Array) => (full ? String.fromCharCode(...c) : String.fromCharCode(...topSlots.map((i) => c[i])));
    const best = new Map<string, number>([[topKey(cols), 0]]);
    const prev = new Map<string, { from: string; m: Macro }>();
    const buckets: { c: Uint8Array; k: string }[][] = [[{ c: cols, k: topKey(cols) }]];
    let goalKey: string | null = null, goalCols: Uint8Array | null = null;
    outer: for (let cost = 0; cost <= maxCost; cost++) {
      const b = buckets[cost]; if (!b) continue;
      for (let i = 0; i < b.length; i++) {
        const { c, k } = b[i];
        if (best.get(k) !== cost) continue;
        if (ok(c)) { goalKey = k; goalCols = c; break outer; }
        for (const m of macros) {
          const nc = cost + m.cost; if (nc > maxCost) continue;
          const nCols = applyCols(c, m.to), nk = topKey(nCols);
          const old = best.get(nk);
          if (old === undefined || nc < old) { best.set(nk, nc); prev.set(nk, { from: k, m }); (buckets[nc] ||= []).push({ c: nCols, k: nk }); }
        }
      }
    }
    if (!goalKey || !goalCols) throw new Error('bước ' + step + ' không tìm được lời giải');
    const seq: Macro[] = []; let cur = goalKey;
    while (prev.has(cur)) { const pv = prev.get(cur)!; seq.push(pv.m); cur = pv.from; }
    seq.reverse();
    const t: string[] = []; for (const m of seq) t.push(...m.tokens);
    cols = goalCols;
    emit(step, t);
  };
  const cen = (k: string) => faceColour(cols, k);
  const upCentre = () => cen('U');
  const topEdgeSlots: [V3, V3][] = [[[0, -1, 1], DIRS.U], [[1, -1, 0], DIRS.U], [[0, -1, -1], DIRS.U], [[-1, -1, 0], DIRS.U]];
  lastLayer(4, [...UMOVES, ...withConj(ALG.line), ...withConj(ALG.ell)], (c) => topEdgeSlots.every(([p, d]) => c[slotOf(p, d)] === c[centreSlot(DIRS.U)]), 60);
  void upCentre;
  const sideDir = (p: V3): V3[] => { const r: V3[] = []; if (p[0]) r.push([p[0], 0, 0]); if (p[2]) r.push([0, 0, p[2]]); return r; };
  const edgeOk = (c: Uint8Array) => topEdgeSlots.every(([p]) => sideDir(p).every((d) => c[slotOf(p, d)] === c[centreSlot(d)]));
  lastLayer(5, [...UMOVES, ...withConj(ALG.edges)], (c) => edgeOk(c) && topEdgeSlots.every(([p, d]) => c[slotOf(p, d)] === c[centreSlot(DIRS.U)]), 80);
  const topCorners: V3[] = [[1, -1, 1], [1, -1, -1], [-1, -1, -1], [-1, -1, 1]];
  const cornerPosOk = (c: Uint8Array) => topCorners.every((p) => {
    const have: number[] = [c[slotOf(p, DIRS.U)], c[slotOf(p, [p[0], 0, 0])], c[slotOf(p, [0, 0, p[2]])]];
    const need: number[] = [c[centreSlot(DIRS.U)], c[centreSlot([p[0], 0, 0])], c[centreSlot([0, 0, p[2]])]];
    return sameSet(have, need);
  });
  lastLayer(6, [...UMOVES, ...withConj(ALG.corners)], (c) => cornerPosOk(c) && edgeOk(c), 80);
  const solvedAll = (c: Uint8Array) => { for (let i = 0; i < N; i++) if (c[i] !== c[centreSlot(D[i])]) return false; return true; };
  lastLayer(7, [...UMOVES, mk(Array(2).fill(parseAlg(ALG.twist)).flat()), mk(Array(4).fill(parseAlg(ALG.twist)).flat())], solvedAll, 120, true);
  if (!solvedAll(cols)) throw new Error('chưa giải xong');
  return stages;
}
