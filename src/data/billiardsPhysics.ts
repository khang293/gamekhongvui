// Vật lý và luật bida (/billiards/): bida lỗ 8 bi, 9 bi, 10 bi và bida 3 băng. Không dùng DOM nên chạy được trong Web Worker và Node.
// Xóa game bida thì xóa luôn billiardsPhysics.ts, billiardsAI.ts, billiardsWorker.ts.
// Đơn vị: mặt bàn W×H = 1000×500, bán kính bi R = 14, thời gian tính theo giây.
export const W = 1000, H = 500, R = 14;
export const DT = 1 / 480;            // một bước mô phỏng; 60 khung/giây = 8 bước
export const MAXSPEED = 2900;         // tốc độ bi trắng khi đánh hết lực
const E_BALL = 0.95;                  // độ nảy khi hai bi va nhau
const E_CUSH = 0.78;                  // độ nảy khi chạm băng
const FR_A = 60, FR_B = 0.9;          // ma sát lăn: hằng số + tỉ lệ theo vận tốc
const STOP_V = 3;                     // dưới tốc độ này thì bi dừng hẳn
const KF = 0.42;                      // hệ số xoáy tiến/lùi truyền cho bi trắng sau va chạm
const KS = 0.2;                       // hệ số xoáy ngang khi chạm băng

// pool = 8 bi (16 quả kể cả bi trắng), nine = 9 bi (10 quả), ten = 10 bi (11 quả), carom = 3 băng (3 quả)
export type Kind = 'pool' | 'carom' | 'nine' | 'ten';
// k: 0 = hai bi va nhau (a, b), 1 = bi a chạm băng, 2 = bi a rơi lỗ b
export interface Ev { k: 0 | 1 | 2; a: number; b: number; v: number }
// Lỗ: x, y = điểm ngắm (cổ lỗ), r = bán kính vẽ/bấm; cx, cy = điểm góc/giữa băng; ux, uy = hướng vào trong bàn;
// tips = hai mũi hàm (đầu băng) dạng phẳng [x1,y1,x2,y2]; aims = các điểm ngắm cho máy (giữa miệng và hai bên).
export interface Pocket { x: number; y: number; r: number; kind: 0 | 1; cx: number; cy: number; ux: number; uy: number; tips: number[]; aims: number[] }
export interface World {
  kind: Kind; n: number;
  x: Float64Array; y: Float64Array; vx: Float64Array; vy: Float64Array;
  ts: Float64Array; ss: Float64Array;   // xoáy trên/dưới và xoáy ngang
  alive: Uint8Array;
  ev: Ev[];
  pockets: Pocket[];
}

// Cỡ lỗ theo bi (đường kính bi = 28): miệng lỗ góc ≈ 1,9 đường kính bi, miệng lỗ giữa ≈ 1,8. Mũi hàm là hình tròn nhỏ JR.
export const TC = 38;                 // khoảng cách từ góc bàn tới mũi hàm dọc theo băng (lỗ góc)
export const TS = 25;                 // nửa miệng lỗ giữa
const JR = 3.5, E_JAW = 0.55;         // bán kính mũi hàm, độ nảy khi bi đập vào hàm
const CAP_C = 32;                     // lỗ góc: bi rơi khi |dx| + |dy| tới góc nhỏ hơn mức này (tâm bi vượt qua đường nối hai mũi hàm)
const CAP_S = 11;                     // lỗ giữa: bi rơi khi tâm cách mép băng ít hơn mức này (bi chạm băng thì tâm cách R = 14)
function mkPockets(): Pocket[] {
  const out: Pocket[] = [];
  for (const [cx, cy] of [[0, 0], [W, 0], [0, H], [W, H]]) {
    const sx = cx === 0 ? 1 : -1, sy = cy === 0 ? 1 : -1;
    const x = cx - sx * 4, y = cy - sy * 4, ux = -sx / Math.SQRT2, uy = sy / Math.SQRT2; // (ux,uy): dọc đường nối hai mũi hàm
    out.push({ x, y, r: 27, kind: 0, cx, cy, ux: sx / Math.SQRT2, uy: sy / Math.SQRT2, tips: [cx + sx * TC, cy, cx, cy + sy * TC], aims: [x, y, x + ux * 7, y + uy * 7, x - ux * 7, y - uy * 7] });
  }
  for (const [cy, sy] of [[0, 1], [H, -1]]) {
    const cx = W / 2, y = cy - sy * 4;
    out.push({ x: cx, y, r: 22, kind: 1, cx, cy, ux: 0, uy: sy, tips: [cx - TS, cy, cx + TS, cy], aims: [cx, y, cx + 6, y, cx - 6, y] });
  }
  return out;
}
export const POOL_POCKETS: Pocket[] = mkPockets();

export function newWorld(kind: Kind): World {
  const n = kind === 'pool' ? 16 : kind === 'nine' ? 10 : kind === 'ten' ? 11 : 3;
  return {
    kind, n, x: new Float64Array(n), y: new Float64Array(n), vx: new Float64Array(n), vy: new Float64Array(n),
    ts: new Float64Array(n), ss: new Float64Array(n), alive: new Uint8Array(n).fill(1), ev: [],
    pockets: kind === 'carom' ? [] : POOL_POCKETS,
  };
}

export function cloneWorld(w: World): World {
  return {
    kind: w.kind, n: w.n, x: w.x.slice(), y: w.y.slice(), vx: w.vx.slice(), vy: w.vy.slice(),
    ts: w.ts.slice(), ss: w.ss.slice(), alive: w.alive.slice(), ev: [], pockets: w.pockets,
  };
}

// ---------- Xếp bi ----------
export const typeOf = (id: number) => (id === 8 ? 3 : id < 8 ? 1 : 2); // 1 đặc, 2 vằn, 3 bi 8 (id 0 là bi trắng)

export function rackPool(w: World) {
  const sp = R * 2 * 0.8660254 + 0.35;
  const fx = W * 0.72, cy = H / 2;
  const ids = [1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15];
  for (let i = ids.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [ids[i], ids[j]] = [ids[j], ids[i]]; }
  // vị trí 15 bi theo hàng: hàng k có k+1 bi. Bi 8 ở giữa hàng 3, hai góc cuối khác loại
  const slots: [number, number][] = [];
  for (let r = 0; r < 5; r++) for (let c = 0; c <= r; c++) slots.push([fx + r * sp, cy + (c - r / 2) * (R * 2 + 0.35)]);
  const order: number[] = new Array(15);
  const eightSlot = 4; // hàng 3, bi giữa (chỉ số 4 trong danh sách xếp theo hàng)
  const cornerA = 10, cornerB = 14;
  order[eightSlot] = 8;
  let k = 0;
  for (let i = 0; i < 15; i++) if (i !== eightSlot) order[i] = ids[k++];
  if (typeOf(order[cornerA]) === typeOf(order[cornerB])) {
    for (let i = 0; i < 15; i++) if (i !== eightSlot && i !== cornerA && i !== cornerB && typeOf(order[i]) !== typeOf(order[cornerA])) { [order[cornerB], order[i]] = [order[i], order[cornerB]]; break; }
  }
  for (let i = 0; i < 15; i++) { const id = order[i]; w.x[id] = slots[i][0]; w.y[id] = slots[i][1]; w.alive[id] = 1; w.vx[id] = w.vy[id] = 0; }
  w.x[0] = W * 0.22; w.y[0] = H / 2; w.alive[0] = 1; w.vx[0] = w.vy[0] = 0;
  w.ts.fill(0); w.ss.fill(0);
}

// Bida 9 bi (hình thoi 1-2-3-2-1, bi 1 ở đầu, bi 9 ở giữa) và bida 10 bi (tam giác 1-2-3-4, bi 1 ở đầu, bi 10 ở giữa hàng 3).
// Các bi còn lại xếp ngẫu nhiên. Bi 1 nằm đúng điểm chấm cuối bàn (W*0.72).
export const lastBall = (kind: Kind) => (kind === 'nine' ? 9 : kind === 'ten' ? 10 : 15);
export function rackRows(w: World, kind: 'nine' | 'ten') {
  const rows = kind === 'nine' ? [1, 2, 3, 2, 1] : [1, 2, 3, 4];
  const sp = R * 2 * 0.8660254 + 0.35, lat = R * 2 + 0.35;
  const fx = W * 0.72, cy = H / 2;
  const slots: [number, number][] = [];
  rows.forEach((cnt, r) => { for (let c = 0; c < cnt; c++) slots.push([fx + r * sp, cy + (c - (cnt - 1) / 2) * lat]); });
  const last = lastBall(kind);
  const center = 4; // ô giữa của hàng thứ ba trong cả hai kiểu xếp
  const ids: number[] = [];
  for (let id = 2; id < last; id++) ids.push(id);
  for (let i = ids.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [ids[i], ids[j]] = [ids[j], ids[i]]; }
  const order: number[] = new Array(slots.length);
  order[0] = 1; order[center] = last;
  let k = 0;
  for (let i = 1; i < slots.length; i++) if (i !== center) order[i] = ids[k++];
  for (let i = 0; i < slots.length; i++) { const id = order[i]; w.x[id] = slots[i][0]; w.y[id] = slots[i][1]; w.alive[id] = 1; w.vx[id] = w.vy[id] = 0; }
  w.x[0] = W * 0.22; w.y[0] = H / 2; w.alive[0] = 1; w.vx[0] = w.vy[0] = 0;
  w.ts.fill(0); w.ss.fill(0);
}

// Bida 3 băng: 0 = trắng, 1 = vàng, 2 = đỏ
export function setupCarom(w: World) {
  const pos: [number, number][] = [[W * 0.25, H * 0.28], [W * 0.25, H * 0.5], [W * 0.75, H * 0.5]];
  for (let i = 0; i < 3; i++) { w.x[i] = pos[i][0]; w.y[i] = pos[i][1]; w.alive[i] = 1; w.vx[i] = w.vy[i] = 0; }
  w.ts.fill(0); w.ss.fill(0);
}

export function canPlace(w: World, id: number, x: number, y: number, headOnly: boolean): boolean {
  if (x < R + 1 || x > W - R - 1 || y < R + 1 || y > H - R - 1) return false;
  if (headOnly && x > W * 0.25) return false;
  for (let i = 0; i < w.n; i++) {
    if (i === id || !w.alive[i]) continue;
    const dx = w.x[i] - x, dy = w.y[i] - y;
    if (dx * dx + dy * dy < (2 * R + 1) * (2 * R + 1)) return false;
  }
  for (const p of w.pockets) { const dx = p.x - x, dy = p.y - y; if (dx * dx + dy * dy < (p.r + 4) * (p.r + 4)) return false; }
  return true;
}

// ---------- Mô phỏng ----------
export function shoot(w: World, id: number, angle: number, power: number, sx = 0, sy = 0) {
  const sp = MAXSPEED * Math.max(0.03, Math.min(1, power));
  w.vx[id] = Math.cos(angle) * sp; w.vy[id] = Math.sin(angle) * sp;
  const m = Math.hypot(sx, sy), lim = 0.9;
  if (m > lim) { sx *= lim / m; sy *= lim / m; }
  w.ts[id] = sy * sp; // sy > 0: xoáy tiến (đẩy bi theo), sy < 0: xoáy lùi (kéo bi về)
  w.ss[id] = sx * sp;
  w.ev.length = 0;
}

export function allStopped(w: World): boolean {
  for (let i = 0; i < w.n; i++) if (w.alive[i] && (w.vx[i] !== 0 || w.vy[i] !== 0)) return false;
  return true;
}

function ballHit(w: World, i: number, j: number) {
  const { x, y, vx, vy, ts } = w;
  let dx = x[j] - x[i], dy = y[j] - y[i];
  const d2 = dx * dx + dy * dy;
  const md = 2 * R;
  if (d2 >= md * md) return;
  let d = Math.sqrt(d2);
  if (d < 1e-6) { dx = 1; dy = 0; d = 1e-6; }
  let nx = dx / d, ny = dy / d;
  const rvn0 = (vx[i] - vx[j]) * nx + (vy[i] - vy[j]) * ny;
  if (rvn0 <= 0) { // đang tách ra: chỉ đẩy ra khỏi chồng lấn
    const ov = md - d;
    x[i] -= nx * ov / 2; y[i] -= ny * ov / 2; x[j] += nx * ov / 2; y[j] += ny * ov / 2;
    return;
  }
  // lùi về đúng lúc hai bi chạm nhau để góc va chạm chính xác, không phụ thuộc tốc độ
  const ux = vx[i] - vx[j], uy = vy[i] - vy[j];
  const a = ux * ux + uy * uy, b = 2 * (dx * ux + dy * uy), c = d2 - md * md;
  let tau = 0;
  if (a > 1e-9) { const disc = b * b - 4 * a * c; if (disc >= 0) tau = (-b + Math.sqrt(disc)) / (2 * a); }
  if (tau < 0) tau = 0; else if (tau > 2 * DT) tau = 2 * DT;
  x[i] -= vx[i] * tau; y[i] -= vy[i] * tau; x[j] -= vx[j] * tau; y[j] -= vy[j] * tau;
  dx = x[j] - x[i]; dy = y[j] - y[i]; d = Math.hypot(dx, dy) || 1e-6;
  nx = dx / d; ny = dy / d;
  const rvn = (vx[i] - vx[j]) * nx + (vy[i] - vy[j]) * ny;
  // hướng đi của mỗi bi trước va chạm (cho xoáy tiến/lùi)
  const si = Math.hypot(vx[i], vy[i]), sj = Math.hypot(vx[j], vy[j]);
  const dix = si > 1 ? vx[i] / si : 0, diy = si > 1 ? vy[i] / si : 0;
  const djx = sj > 1 ? vx[j] / sj : 0, djy = sj > 1 ? vy[j] / sj : 0;
  const jn = (1 + E_BALL) * 0.5 * Math.max(0, rvn);
  vx[i] -= jn * nx; vy[i] -= jn * ny; vx[j] += jn * nx; vy[j] += jn * ny;
  if (ts[i] !== 0) { vx[i] += dix * ts[i] * KF; vy[i] += diy * ts[i] * KF; ts[i] *= 0.2; }
  if (ts[j] !== 0) { vx[j] += djx * ts[j] * KF; vy[j] += djy * ts[j] * KF; ts[j] *= 0.2; }
  x[i] += vx[i] * tau; y[i] += vy[i] * tau; x[j] += vx[j] * tau; y[j] += vy[j] * tau;
  w.ev.push({ k: 0, a: i, b: j, v: rvn });
}

export function step(w: World, dt = DT) {
  const { n, x, y, vx, vy, ts, ss, alive } = w;
  const decay = dt * 0.9;
  for (let i = 0; i < n; i++) {
    if (!alive[i]) continue;
    const sp2 = vx[i] * vx[i] + vy[i] * vy[i];
    if (sp2 > 0) {
      const sp = Math.sqrt(sp2), dec = (FR_A + FR_B * sp) * dt;
      if (sp <= dec || sp < STOP_V) { vx[i] = 0; vy[i] = 0; ts[i] = 0; ss[i] = 0; }
      else { const k = (sp - dec) / sp; vx[i] *= k; vy[i] *= k; ts[i] *= 1 - decay; ss[i] *= 1 - decay * 1.3; }
    } else continue;
    x[i] += vx[i] * dt; y[i] += vy[i] * dt;
    // lỗ và hàm lỗ
    const hasP = w.pockets.length > 0;
    let hit = 0, vn = 0;
    if (hasP) {
      let sunk = -1;
      for (let p = 0; p < w.pockets.length; p++) {
        const pk = w.pockets[p];
        if (pk.kind === 0) {
          const sum = Math.abs(x[i] - pk.cx) + Math.abs(y[i] - pk.cy), slow = vx[i] * vx[i] + vy[i] * vy[i] < 14400; // bi chậm nằm trong miệng lỗ thì lăn vào
          if (sum < (slow ? CAP_C + 14 : CAP_C) && vx[i] * (pk.cx - x[i]) + vy[i] * (pk.cy - y[i]) >= 0) { sunk = p; break; }
        } else if (Math.abs(x[i] - pk.cx) < TS - 2 && vy[i] * pk.uy <= 0 && (y[i] - pk.cy) * pk.uy < (vx[i] * vx[i] + vy[i] * vy[i] < 14400 ? R + 1 : CAP_S)) { sunk = p; break; }
      }
      if (sunk >= 0) { alive[i] = 0; vx[i] = vy[i] = 0; w.ev.push({ k: 2, a: i, b: sunk, v: 0 }); continue; }
      // mũi hàm: bi đập vào thì nảy ra, không lọt qua (bi quá nhanh hoặc sai góc sẽ bật khỏi lỗ)
      for (let p = 0; p < w.pockets.length; p++) {
        const tp = w.pockets[p].tips;
        for (let t = 0; t < 4; t += 2) {
          const dx = x[i] - tp[t], dy = y[i] - tp[t + 1], md = R + JR, d2 = dx * dx + dy * dy;
          if (d2 >= md * md) continue;
          const d = Math.sqrt(d2) || 1e-6, nx = dx / d, ny = dy / d;
          x[i] = tp[t] + nx * md; y[i] = tp[t + 1] + ny * md;
          const vnn = vx[i] * nx + vy[i] * ny;
          if (vnn < 0) { vx[i] -= (1 + E_JAW) * vnn * nx; vy[i] -= (1 + E_JAW) * vnn * ny; hit = 1; vn = Math.max(vn, -vnn); }
        }
      }
    }
    // băng (đoạn băng đi qua miệng lỗ thì không có)
    if (x[i] < R) { if (!(hasP && (y[i] < TC || y[i] > H - TC))) { x[i] = R; if (vx[i] < 0) { vn = -vx[i]; vx[i] = vn * E_CUSH; vy[i] = vy[i] * 0.94 + ss[i] * KS * (vn / MAXSPEED + 0.15); hit = 1; } } }
    else if (x[i] > W - R) { if (!(hasP && (y[i] < TC || y[i] > H - TC))) { x[i] = W - R; if (vx[i] > 0) { vn = vx[i]; vx[i] = -vn * E_CUSH; vy[i] = vy[i] * 0.94 - ss[i] * KS * (vn / MAXSPEED + 0.15); hit = 1; } } }
    if (y[i] < R) { if (!(hasP && (x[i] < TC || x[i] > W - TC || Math.abs(x[i] - W / 2) < TS))) { y[i] = R; if (vy[i] < 0) { vn = -vy[i]; vy[i] = vn * E_CUSH; vx[i] = vx[i] * 0.94 - ss[i] * KS * (vn / MAXSPEED + 0.15); hit = 1; } } }
    else if (y[i] > H - R) { if (!(hasP && (x[i] < TC || x[i] > W - TC || Math.abs(x[i] - W / 2) < TS))) { y[i] = H - R; if (vy[i] > 0) { vn = vy[i]; vy[i] = -vn * E_CUSH; vx[i] = vx[i] * 0.94 + ss[i] * KS * (vn / MAXSPEED + 0.15); hit = 1; } } }
    if (hit) { ss[i] *= 0.55; if (vn > 8) w.ev.push({ k: 1, a: i, b: 0, v: vn }); }
  }
  for (let i = 0; i < n; i++) {
    if (!alive[i]) continue;
    for (let j = i + 1; j < n; j++) {
      if (!alive[j]) continue;
      if (vx[i] === 0 && vy[i] === 0 && vx[j] === 0 && vy[j] === 0) continue;
      const dx = x[j] - x[i], dy = y[j] - y[i];
      if (dx > 2 * R || dx < -2 * R || dy > 2 * R || dy < -2 * R) continue;
      ballHit(w, i, j);
    }
  }
}

// Chạy tới khi mọi bi dừng (hoặc hết maxT giây). Trả về số giây đã mô phỏng.
export function simulate(w: World, maxT = 30): number {
  const maxSteps = Math.ceil(maxT / DT);
  let s = 0;
  while (s < maxSteps) {
    step(w);
    s++;
    if ((s & 15) === 0 && allStopped(w)) break;
  }
  return s * DT;
}

// Tia từ bi id theo góc: trả về khoảng cách tới vật đầu tiên (bi khác hoặc băng)
export function rayCast(w: World, id: number, angle: number): { t: number; ball: number } {
  const ox = w.x[id], oy = w.y[id], dx = Math.cos(angle), dy = Math.sin(angle);
  let best = 1e9, ball = -1;
  if (dx > 1e-9) best = Math.min(best, (W - R - ox) / dx); else if (dx < -1e-9) best = Math.min(best, (R - ox) / dx);
  if (dy > 1e-9) best = Math.min(best, (H - R - oy) / dy); else if (dy < -1e-9) best = Math.min(best, (R - oy) / dy);
  for (let i = 0; i < w.n; i++) {
    if (i === id || !w.alive[i]) continue;
    const px = w.x[i] - ox, py = w.y[i] - oy;
    const proj = px * dx + py * dy;
    if (proj <= 0) continue;
    const perp2 = px * px + py * py - proj * proj;
    const md2 = 4 * R * R;
    if (perp2 >= md2) continue;
    const t = proj - Math.sqrt(md2 - perp2);
    if (t > 0 && t < best) { best = t; ball = i; }
  }
  return { t: Math.max(0, best), ball };
}

// ---------- Luật bida lỗ 8 bi ----------
export interface PoolState { cur: number; group: number[]; breakPending: boolean; inHand: boolean; headOnly: boolean }
export interface PoolRes {
  foul: boolean; reason: '' | 'scratch' | 'nohit' | 'wrong' | 'norail' | 'early8';
  potted: number[]; keep: boolean; winner: number; assign: number; scratch: boolean; respot8: boolean; first: number;
}

export function ownLeft(alive: ArrayLike<number>, group: number): number {
  let c = 0;
  for (let id = 1; id <= 15; id++) if (alive[id] && typeOf(id) === group) c++;
  return c;
}

// aliveBefore: trạng thái bi còn trên bàn trước cú đánh
export function resolvePool(st: PoolState, aliveBefore: ArrayLike<number>, ev: Ev[]): PoolRes {
  const cur = st.cur, myG = st.group[cur];
  const potted: number[] = [];
  let scratch = false;
  for (const e of ev) if (e.k === 2) { if (e.a === 0) scratch = true; else potted.push(e.a); }
  let firstIdx = -1, first = -1;
  for (let i = 0; i < ev.length; i++) { const e = ev[i]; if (e.k === 0 && (e.a === 0 || e.b === 0)) { first = e.a === 0 ? e.b : e.a; firstIdx = i; break; } }
  let foul = false;
  let reason: PoolRes['reason'] = '';
  const onEight = myG !== 0 && ownLeft(aliveBefore, myG) === 0;
  if (first < 0) { foul = true; reason = 'nohit'; }
  else {
    const t = typeOf(first);
    if (onEight) { if (t !== 3) { foul = true; reason = 'wrong'; } }
    else if (myG === 0) { if (t === 3) { foul = true; reason = 'wrong'; } }
    else if (t !== myG) { foul = true; reason = 'wrong'; }
  }
  if (scratch) { foul = true; reason = 'scratch'; }
  if (!foul && first >= 0 && potted.length === 0) {
    let rail = false;
    for (let i = firstIdx + 1; i < ev.length; i++) if (ev[i].k === 1) { rail = true; break; }
    if (!rail) { foul = true; reason = 'norail'; }
  }
  let winner = -1, respot8 = false;
  if (potted.includes(8)) {
    if (st.breakPending) respot8 = true;
    else if (foul || !onEight) { winner = 1 - cur; if (!foul) { foul = true; reason = 'early8'; } }
    else winner = cur;
  }
  let assign = 0;
  if (!foul && winner < 0 && myG === 0 && !st.breakPending) {
    for (const id of potted) if (id !== 8) { assign = typeOf(id); break; }
  }
  let keep = false;
  if (!foul && winner < 0) {
    const g = assign || myG;
    keep = potted.some((id) => id !== 8 && (g === 0 || typeOf(id) === g));
    if (onEight && potted.includes(8)) keep = false;
  }
  return { foul, reason, potted, keep, winner, assign, scratch, respot8, first };
}

// ---------- Luật bida 9 bi và 10 bi ----------
// Phải chạm bi nhỏ nhất còn trên bàn trước. 9 bi: bi nào vào lỗ hợp lệ cũng được đánh tiếp, bi 9 vào hợp lệ là thắng.
// 10 bi: phải gọi bi và lỗ trước mỗi cú (trừ cú phá); chỉ bi gọi vào đúng lỗ gọi mới tính, bi 10 vào đúng lỗ gọi (đang là bi gọi) là thắng.
// Lỗi: bi trắng rơi lỗ, không chạm bi nào, chạm sai bi đầu tiên, không có bi nào chạm băng (khi không bỏ được bi). Lỗi thì đối thủ được đặt bi trắng ở bất kỳ đâu.
// Bi 9 / bi 10 rơi lỗ không hợp lệ thì đặt lại ở điểm chấm cuối bàn.
export interface RackState { cur: number; breakPending: boolean; inHand: boolean; headOnly: boolean }
export interface Call { ball: number; pocket: number }
export interface RackRes {
  foul: boolean; reason: '' | 'scratch' | 'nohit' | 'wrong' | 'norail';
  potted: number[]; keep: boolean; winner: number; respot: number[]; first: number; scratch: boolean; calledOk: boolean;
}

export function lowestBall(alive: ArrayLike<number>, last: number): number {
  for (let id = 1; id <= last; id++) if (alive[id]) return id;
  return -1;
}

export function resolveRack(kind: Kind, st: RackState, aliveBefore: ArrayLike<number>, ev: Ev[], call: Call | null): RackRes {
  const last = lastBall(kind), cur = st.cur;
  const potted: number[] = [];
  let scratch = false, calledOk = false;
  for (const e of ev) if (e.k === 2) {
    if (e.a === 0) scratch = true;
    else { potted.push(e.a); if (call && e.a === call.ball && e.b === call.pocket) calledOk = true; }
  }
  let firstIdx = -1, first = -1;
  for (let i = 0; i < ev.length; i++) { const e = ev[i]; if (e.k === 0 && (e.a === 0 || e.b === 0)) { first = e.a === 0 ? e.b : e.a; firstIdx = i; break; } }
  let foul = false;
  let reason: RackRes['reason'] = '';
  if (first < 0) { foul = true; reason = 'nohit'; }
  else if (first !== lowestBall(aliveBefore, last)) { foul = true; reason = 'wrong'; }
  if (scratch) { foul = true; reason = 'scratch'; }
  if (!foul && first >= 0 && potted.length === 0) {
    let rail = false;
    for (let i = firstIdx + 1; i < ev.length; i++) if (ev[i].k === 1) { rail = true; break; }
    if (!rail) { foul = true; reason = 'norail'; }
  }
  let winner = -1;
  const respot: number[] = [];
  if (potted.includes(last)) {
    if (foul) respot.push(last);
    else if (kind === 'nine') winner = cur;
    else if (!st.breakPending && calledOk && call && call.ball === last) winner = cur;
    else respot.push(last);
  }
  let keep = false;
  if (!foul && winner < 0) {
    if (kind === 'nine') keep = potted.length > 0;
    else if (st.breakPending) keep = potted.some((id) => id !== last);
    else keep = calledOk && !!call && call.ball !== last;
  }
  return { foul, reason, potted, keep, winner, respot, first, scratch, calledOk };
}

// Đặt lại một bi ở điểm chấm cuối bàn; nếu bị chiếm thì lùi dần về phía băng cuối, rồi về phía đầu bàn. Trả về false nếu không còn chỗ.
export function respotBall(w: World, id: number): boolean {
  const fx = W * 0.72, cy = H / 2, st = 2 * R + 1;
  const tries: number[] = [0];
  for (let k = 1; fx + k * st <= W - R - 1; k++) tries.push(k * st);
  for (let k = 1; fx - k * st >= R + 1; k++) tries.push(-k * st);
  for (const d of tries) {
    if (canPlace(w, id, fx + d, cy, false)) { w.x[id] = fx + d; w.y[id] = cy; w.vx[id] = w.vy[id] = 0; w.alive[id] = 1; w.ts[id] = w.ss[id] = 0; return true; }
  }
  return false;
}

// ---------- Luật bida 3 băng ----------
export interface CaromRes { point: boolean; touched: number; cushions: number }
export function resolveCarom(ev: Ev[], cue: number): CaromRes {
  let c = 0, point = false;
  const touched: number[] = [];
  for (const e of ev) {
    if (e.k === 1 && e.a === cue) c++;
    else if (e.k === 0 && (e.a === cue || e.b === cue)) {
      const o = e.a === cue ? e.b : e.a;
      if (!touched.includes(o)) { touched.push(o); if (touched.length === 2) { point = c >= 3; break; } }
    }
  }
  return { point, touched: touched.length, cushions: c };
}
