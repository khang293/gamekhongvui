// Mô hình khối Rubik 3x3 cho trang hướng dẫn (/rubik/). Thuần logic, không đụng DOM.
// Hệ tọa độ giống CSS: x sang phải, y xuống dưới, z hướng về người xem. Xóa trang Rubik thì xóa luôn file này.
export type V3 = [number, number, number];
export type Sticker = { p: V3; d: V3; c: number };
export type State = Sticker[];

// Pháp tuyến của 6 mặt
export const FACES: Record<string, V3> = {
  U: [0, -1, 0], D: [0, 1, 0], L: [-1, 0, 0], R: [1, 0, 0], F: [0, 0, 1], B: [0, 0, -1],
};
// Màu: 0 trắng, 1 vàng, 2 cam, 3 đỏ, 4 xanh lá, 5 xanh dương. Trắng trên, xanh lá trước.
export const COLORS = ['#f4f4f4', '#f6d400', '#ff7a1a', '#d71920', '#16a34a', '#1d4ed8'];
const FACE_COLOR: Record<string, number> = { U: 0, D: 1, L: 2, R: 3, F: 4, B: 5 };

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const eq = (a: V3, b: V3) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

export function solved(): State {
  const s: State = [];
  for (const k of Object.keys(FACES)) {
    const n = FACES[k];
    for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
      if (dot([x, y, z], n) === 1) s.push({ p: [x, y, z], d: n, c: FACE_COLOR[k] });
    }
  }
  return s;
}
export const clone = (s: State): State => s.map((t) => ({ p: [...t.p] as V3, d: [...t.d] as V3, c: t.c }));

// Xoay 90 độ theo chiều kim đồng hồ quanh trục n (nhìn từ phía n vào tâm): v -> (n.v)n + n x v
export function rotQuarter(v: V3, n: V3): V3 {
  const a = dot(n, v), c = cross(n, v);
  return [a * n[0] + c[0], a * n[1] + c[1], a * n[2] + c[2]];
}
// Xoay một góc bất kỳ theta (rad), dương = theo chiều kim đồng hồ như trên
export function rotAngle(v: V3, n: V3, th: number): V3 {
  const a = dot(n, v), c = cross(n, v), co = Math.cos(th), si = Math.sin(th);
  return [0, 1, 2].map((i) => a * n[i] + co * (v[i] - a * n[i]) + si * c[i]) as V3;
}
// Ma trận 3x3 (hàng) của phép xoay theta quanh n
export function rotMatrix(n: V3, th: number): number[][] {
  const cols = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((e) => rotAngle(e as V3, n, th));
  return [0, 1, 2].map((r) => [cols[0][r], cols[1][r], cols[2][r]]);
}

export interface Move { axis: V3; layer: number | null; turns: number; } // layer: null = cả khối; 1 = lớp ngoài theo trục
// 'R' 'R\'' 'R2' ; 'x' 'y' 'z' (cả khối)  (x theo R, y theo U, z theo F)
export function parseMove(m: string): Move {
  const base = m[0];
  const mod = m.slice(1);
  const turns = mod === '2' ? 2 : mod === "'" ? -1 : 1;
  const whole: Record<string, V3> = { x: FACES.R, y: FACES.U, z: FACES.F };
  if (whole[base]) return { axis: whole[base], layer: null, turns };
  if (!FACES[base]) throw new Error('bad move ' + m);
  return { axis: FACES[base], layer: 1, turns };
}
export const inLayer = (p: V3, mv: Move) => mv.layer === null || dot(p, mv.axis) === mv.layer;

export function applyMove(s: State, m: string): void {
  const mv = parseMove(m);
  const q = ((mv.turns % 4) + 4) % 4;
  for (const t of s) {
    if (!inLayer(t.p, mv)) continue;
    for (let i = 0; i < q; i++) { t.p = rotQuarter(t.p, mv.axis); t.d = rotQuarter(t.d, mv.axis); }
  }
}
export const tokens = (alg: string) => alg.trim().split(/\s+/).filter(Boolean);
export function applyAlg(s: State, alg: string): void { for (const m of tokens(alg)) applyMove(s, m); }
export function invertMove(m: string): string {
  const mod = m.slice(1);
  return m[0] + (mod === '2' ? '2' : mod === "'" ? '' : "'");
}
export const invertAlg = (alg: string) => tokens(alg).reverse().map(invertMove).join(' ');
export const repeatAlg = (alg: string, n: number) => Array(n).fill(alg).join(' ');

export function key(s: State): string {
  const a = s.map((t) => `${t.p.join(',')}|${t.d.join(',')}|${t.c}`);
  a.sort();
  return a.join(';');
}
export function isSolved(s: State): boolean {
  const cen = centres(s);
  return s.every((t) => t.c === cen.get(t.d.join(',')));
}

export function centres(s: State): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of s) if (eq(t.p, t.d)) m.set(t.d.join(','), t.c);
  return m;
}
const nz = (p: V3) => p.filter((x) => x !== 0).length;
function pieces(s: State): Map<string, Sticker[]> {
  const m = new Map<string, Sticker[]>();
  for (const t of s) { const k = t.p.join(','); const a = m.get(k); if (a) a.push(t); else m.set(k, [t]); }
  return m;
}
export function randomMoves(n: number, rng: () => number = Math.random): string[] {
  const faces = ['U', 'D', 'L', 'R', 'F', 'B'], mods = ['', "'", '2'];
  const out: string[] = [];
  let last = '';
  while (out.length < n) {
    const f = faces[Math.floor(rng() * 6)];
    if (f === last) continue;
    last = f;
    out.push(f + mods[Math.floor(rng() * 3)]);
  }
  return out;
}

// Mặt trắng là mặt có tâm trắng; mặt vàng là mặt đối diện. Các bước kiểm tra theo mặt trắng, không phụ thuộc cách cầm khối.
export function whiteNormal(s: State): V3 {
  for (const t of s) if (eq(t.p, t.d) && t.c === 0) return t.d;
  return FACES.U;
}
export type StepId = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export function stepDone(s: State, step: StepId): boolean {
  const cen = centres(s);
  const W = whiteNormal(s);
  const Y: V3 = [-W[0], -W[1], -W[2]];
  const cw = cen.get(W.join(','))!, cy = cen.get(Y.join(','))!;
  const matches = (t: Sticker) => t.c === cen.get(t.d.join(','));
  const pcs = pieces(s);
  const each = (pred: (p: V3, st: Sticker[]) => boolean, f: (st: Sticker[], p: V3) => boolean) => {
    for (const [k, st] of pcs) { const p = k.split(',').map(Number) as V3; if (pred(p, st) && !f(st, p)) return false; }
    return true;
  };
  switch (step) {
    case 1: return each((p) => nz(p) === 2 && dot(p, W) === 1, (st) => st.every(matches));
    case 2: return each((p) => dot(p, W) === 1, (st) => st.every(matches)) && stepDone(s, 1);
    case 3: return stepDone(s, 2) && each((p) => nz(p) === 2 && dot(p, W) === 0, (st) => st.every(matches));
    case 4: return stepDone(s, 3) && each((p) => nz(p) === 2 && dot(p, Y) === 1, (st) => st.filter((t) => eq(t.d, Y)).every((t) => t.c === cy));
    case 5: return stepDone(s, 4) && each((p) => nz(p) === 2 && dot(p, Y) === 1, (st) => st.every(matches));
    case 6: return stepDone(s, 5) && each((p) => nz(p) === 3 && dot(p, Y) === 1, (st, p) => {
      const need = new Set<number>(); for (let i = 0; i < 3; i++) { const d: V3 = [0, 0, 0]; d[i] = p[i]; need.add(cen.get(d.join(','))!); }
      return st.every((t) => need.has(t.c));
    });
    case 7: return isSolved(s);
  }
}
// Bước đang làm dở: bước lớn nhất đã xong liên tiếp từ bước 1
export function progress(s: State): number {
  let n = 0;
  for (let i = 1; i <= 7; i++) { if (stepDone(s, i as StepId)) n = i; else break; }
  return n;
}
