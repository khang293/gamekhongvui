// Máy đánh bida (/billiards/): thử nhiều cú đánh trên cùng bộ vật lý rồi chọn cú tốt nhất theo luật.
// Chạy được trong Web Worker (xem billiardsWorker.ts) hoặc trực tiếp.
import {
  W, H, R, newWorld, cloneWorld, shoot, simulate, canPlace, resolvePool, resolveCarom, resolveRack, lowestBall, lastBall, typeOf, ownLeft, POOL_POCKETS,
  type World, type Kind, type PoolState, type RackState, type Call,
} from './billiardsPhysics';

export interface Job {
  kind: Kind;
  x: number[]; y: number[]; alive: number[];
  cur: number; group: number[]; breakPending: boolean; inHand: boolean; headOnly: boolean;
  level: number; ms: number;
}
export interface Shot { angle: number; power: number; sx: number; sy: number; pos?: [number, number]; call?: Call }

const NOISE = [
  { ang: 2.4, pw: 0.12, pick: 5, rand: 0.3 },  // dễ
  { ang: 0.9, pw: 0.05, pick: 2, rand: 0 },    // thường
  { ang: 0.25, pw: 0.02, pick: 1, rand: 0 },   // khó
];

function worldOf(job: Job): World {
  const w = newWorld(job.kind);
  for (let i = 0; i < w.n; i++) { w.x[i] = job.x[i]; w.y[i] = job.y[i]; w.alive[i] = job.alive[i] ? 1 : 0; }
  return w;
}

interface Cand { angle: number; power: number; sx: number; sy: number; pos?: [number, number]; score: number; call?: Call }

function gauss() { let s = 0; for (let i = 0; i < 4; i++) s += Math.random(); return (s - 2) * 1.7; }

function finalize(c: Cand, level: number, scale = 1): Shot {
  const nz = NOISE[Math.max(0, Math.min(2, level - 1))];
  return {
    angle: c.angle + gauss() * nz.ang * scale * Math.PI / 180,
    power: Math.max(0.05, Math.min(1, c.power * (1 + gauss() * nz.pw))),
    sx: c.sx, sy: c.sy, pos: c.pos, call: c.call,
  };
}

function pickBest(cands: Cand[], level: number): Cand {
  cands.sort((a, b) => b.score - a.score);
  const nz = NOISE[Math.max(0, Math.min(2, level - 1))];
  if (nz.rand && Math.random() < nz.rand) return cands[(Math.random() * cands.length) | 0];
  const k = Math.min(nz.pick, cands.length);
  return cands[(Math.random() * k) | 0];
}

export function chooseShot(job: Job): Shot {
  const deadline = Date.now() + job.ms;
  return job.kind === 'carom' ? caromShot(job, deadline) : poolShot(job, deadline);
}

// ---------- Bida 3 băng ----------
function caromShot(job: Job, deadline: number): Shot {
  const base = worldOf(job);
  const cue = job.cur;
  const cands: Cand[] = [];
  const spins = [0, 0.5, -0.5];
  const powers = [0.5, 0.8];
  const evalShot = (angle: number, power: number, sx: number): number => {
    const w = cloneWorld(base);
    shoot(w, cue, angle, power, sx, 0);
    simulate(w, 25);
    const r = resolveCarom(w.ev, cue);
    let s = r.touched * 80 + Math.min(r.cushions, 3) * 25;
    if (r.point) {
      s = 1000;
      // sau khi ghi điểm: thích để các bi gần nhau cho cú sau
      const a = [0, 1, 2].filter((i) => i !== cue);
      s += 200 - Math.min(200, Math.hypot(w.x[a[0]] - w.x[a[1]], w.y[a[0]] - w.y[a[1]]) * 0.25);
    }
    return s + Math.random() * 3;
  };
  const off = Math.random() * 2;
  for (let deg = 0; deg < 360; deg += 2) {
    if (Date.now() > deadline && cands.length > 40) break;
    const angle = (deg + off) * Math.PI / 180;
    for (const p of powers) for (const sx of spins) cands.push({ angle, power: p, sx, sy: 0, score: evalShot(angle, p, sx) });
  }
  // tinh chỉnh các cú tốt nhất
  cands.sort((a, b) => b.score - a.score);
  const top = cands.slice(0, 6);
  for (const c of top) {
    for (const d of [-1, -0.5, 0.5, 1]) {
      if (Date.now() > deadline + 400) break;
      const angle = c.angle + d * Math.PI / 180;
      cands.push({ angle, power: c.power, sx: c.sx, sy: 0, score: evalShot(angle, c.power, c.sx) });
    }
  }
  // cú ghi điểm phải còn ăn khi lệch nhẹ góc (băng khuếch đại sai số rất nhanh)
  cands.sort((a, b) => b.score - a.score);
  for (const c of cands.slice(0, 12)) {
    if (c.score < 900 || Date.now() > deadline + 900) continue;
    let robust = 0;
    for (const d of [-0.12, 0.12]) if (evalShot(c.angle + d * Math.PI / 180, c.power, c.sx) >= 900) robust++;
    c.score += robust * 150;
  }
  return finalize(pickBest(cands, job.level), job.level, 0.25);
}

// ---------- Bida lỗ ----------
function poolShot(job: Job, deadline: number): Shot {
  const base = worldOf(job);
  const st: PoolState = { cur: job.cur, group: job.group, breakPending: job.breakPending, inHand: job.inHand, headOnly: job.headOnly };
  const rst: RackState = { cur: job.cur, breakPending: job.breakPending, inHand: job.inHand, headOnly: job.headOnly };
  const rack = job.kind === 'nine' || job.kind === 'ten';   // 9 bi / 10 bi: chỉ đánh bi nhỏ nhất, 10 bi phải gọi bi và lỗ
  const last = lastBall(job.kind);
  const aliveBefore = Uint8Array.from(job.alive);
  const cur = job.cur, myG = rack ? 0 : job.group[cur];

  // phát bóng
  if (job.breakPending) {
    const y = H / 2 + (Math.random() - 0.5) * 40;
    return finalize({ angle: Math.atan2(H / 2 - y, W * 0.72 - W * 0.2), power: job.level === 1 ? 0.8 : 0.97, sx: 0, sy: 0, pos: [W * 0.2, y], score: 0 }, job.level);
  }

  const left = myG ? ownLeft(aliveBefore, myG) : 99;
  const targets: number[] = [];
  if (rack) targets.push(lowestBall(aliveBefore, last));
  else {
    for (let id = 1; id <= 15; id++) {
      if (!aliveBefore[id]) continue;
      if (myG === 0) { if (id !== 8) targets.push(id); }
      else if (left === 0) { if (id === 8) targets.push(id); }
      else if (typeOf(id) === myG) targets.push(id);
    }
    if (!targets.length) targets.push(8);
  }
  // 10 bi phải gọi: mỗi cú gọi bi mục tiêu và lỗ định đưa bi vào
  const needCall = job.kind === 'ten';
  const nearestPocket = (t: number) => { let bi = 0, bd = 1e9; POOL_POCKETS.forEach((p, i) => { const d = Math.hypot(p.x - job.x[t], p.y - job.y[t]); if (d < bd) { bd = d; bi = i; } }); return bi; };

  const evalRack = (w: World, call: Call | undefined): number => {
    const r = resolveRack(job.kind, rst, aliveBefore, w.ev, needCall ? call ?? null : null);
    if (r.winner >= 0) return r.winner === cur ? 1e6 : -1e6;
    let s = 0;
    if (r.foul) s -= 1200;
    if (r.keep) s += 650;
    else if (!r.foul) s += r.potted.length * 40;
    if (!r.scratch && w.alive[0]) {
      const nl = lowestBall(w.alive, last);
      if (nl > 0) s -= Math.min(Math.hypot(w.x[nl] - w.x[0], w.y[nl] - w.y[0]), 500) * 0.15;
    }
    return s + Math.random() * 4;
  };
  const evalShot = (pos: [number, number] | undefined, angle: number, power: number, sy: number, call?: Call): number => {
    const w = cloneWorld(base);
    if (pos) { w.x[0] = pos[0]; w.y[0] = pos[1]; w.alive[0] = 1; }
    shoot(w, 0, angle, power, 0, sy);
    simulate(w, 25);
    if (rack) return evalRack(w, call);
    const r = resolvePool(st, aliveBefore, w.ev);
    let s = 0;
    if (r.winner >= 0) return r.winner === cur ? 1e6 : -1e6;
    if (r.foul) s -= 1200;
    for (const id of r.potted) {
      if (id === 8) continue;
      s += (myG === 0 || typeOf(id) === myG) ? 400 : -300;
    }
    if (r.keep) s += 250;
    if (!r.scratch && w.alive[0]) {
      // bi trắng nên dừng gần một bi của mình
      let md = 1e9;
      for (const id of targets) if (w.alive[id]) md = Math.min(md, Math.hypot(w.x[id] - w.x[0], w.y[id] - w.y[0]));
      if (md < 1e9) s -= Math.min(md, 500) * 0.15;
    }
    return s + Math.random() * 4;
  };

  const cx = job.x[0], cy = job.y[0];
  // các cặp (bi mục tiêu, lỗ) kèm điểm ưu tiên hình học
  const pairs: { gx: number; gy: number; pre: number; t: number; pk: number; main: boolean }[] = [];
  for (const t of targets) {
    for (let pk = 0; pk < POOL_POCKETS.length; pk++) {
      const p = POOL_POCKETS[pk];
      // ngắm vào giữa miệng lỗ và hai bên: lỗ nhỏ nên cần thử vài điểm ngắm
      for (let ai = 0; ai < p.aims.length; ai += 2) {
        const px = p.aims[ai], py = p.aims[ai + 1];
        let dx = px - base.x[t], dy = py - base.y[t];
        const dl = Math.hypot(dx, dy) || 1; dx /= dl; dy /= dl;
        const gx = base.x[t] - dx * 2 * R, gy = base.y[t] - dy * 2 * R;
        const ax = gx - cx, ay = gy - cy, al = Math.hypot(ax, ay) || 1;
        const cos = (ax / al) * dx + (ay / al) * dy;
        if (!job.inHand && cos < 0.2) continue;
        pairs.push({ gx, gy, pre: al + dl * 0.8 + (1 - cos) * 260 + (ai === 0 ? 0 : 25), t, pk, main: ai === 0 });
      }
    }
  }
  pairs.sort((a, b) => a.pre - b.pre);

  const cands: Cand[] = [];
  const spinsY = [0, 0.4, -0.4];
  for (const pr of pairs) {
    if (Date.now() > deadline && cands.length > 20) break;
    let pos: [number, number] | undefined;
    let ax = pr.gx - cx, ay = pr.gy - cy;
    if (job.inHand) {
      // chọn chỗ đặt bi trắng phía sau bi mục tiêu theo hướng ngắm
      const dxl = base.x[pr.t] - pr.gx, dyl = base.y[pr.t] - pr.gy, dl = Math.hypot(dxl, dyl) || 1;
      pos = undefined;
      for (const back of [170, 110, 240, 70]) {
        const px = pr.gx - (dxl / dl) * back, py = pr.gy - (dyl / dl) * back;
        if (canPlace(base, 0, px, py, job.headOnly)) { pos = [px, py]; break; }
      }
      if (!pos) continue;
      ax = pr.gx - pos[0]; ay = pr.gy - pos[1];
    }
    const angle = Math.atan2(ay, ax);
    const dist = Math.hypot(ax, ay) + Math.hypot(base.x[pr.t] - pr.gx, base.y[pr.t] - pr.gy);
    const p0 = Math.max(0.25, Math.min(0.9, 0.2 + dist / 1500));
    for (const p of [p0, Math.min(1, p0 + 0.25)]) {
      const call = needCall ? { ball: pr.t, pocket: pr.pk } : undefined;
      for (const sy of pr.main ? spinsY : [0]) cands.push({ angle, power: p, sx: 0, sy, pos, call, score: evalShot(pos, angle, p, sy, call) });
    }
  }
  // vài cú ngẫu nhiên làm phương án dự phòng (đánh an toàn)
  for (let i = 0; i < 24; i++) {
    if (Date.now() > deadline + 300) break;
    let pos: [number, number] | undefined;
    if (job.inHand) {
      for (let k = 0; k < 20 && !pos; k++) { const px = (job.headOnly ? 0.05 + Math.random() * 0.2 : 0.05 + Math.random() * 0.9) * W, py = (0.1 + Math.random() * 0.8) * H; if (canPlace(base, 0, px, py, job.headOnly)) pos = [px, py]; }
      if (!pos) continue;
    }
    const sx0 = pos ? pos[0] : cx, sy0 = pos ? pos[1] : cy;
    // ngắm vào một bi mục tiêu bất kỳ
    const t = targets[(Math.random() * targets.length) | 0];
    const angle = Math.atan2(base.y[t] - sy0, base.x[t] - sx0) + (Math.random() - 0.5) * 0.3;
    const power = 0.35 + Math.random() * 0.5;
    const call = needCall ? { ball: t, pocket: nearestPocket(t) } : undefined;
    cands.push({ angle, power, sx: 0, sy: 0, pos, call, score: evalShot(pos, angle, power, 0, call) });
  }
  // 9/10 bi: nếu bi nhỏ nhất bị chắn hết (mọi cú thẳng đều lỗi), quét mọi góc để tìm cú hợp lệ, kể cả cú ăn băng (kick)
  if (rack && !job.inHand) {
    cands.sort((x, y) => y.score - x.score);
    if (!cands.length || cands[0].score < -500) {
      const callK = needCall ? { ball: targets[0], pocket: nearestPocket(targets[0]) } : undefined;
      const off = Math.random() * 3;
      for (let deg = 0; deg < 360; deg += 3) {
        if (Date.now() > deadline + 800) break;
        const angle = (deg + off) * Math.PI / 180;
        for (const pw of [0.5, 0.85]) cands.push({ angle, power: pw, sx: 0, sy: 0, call: callK, score: evalShot(undefined, angle, pw, 0, callK) });
      }
    }
  }
  // thử lại các cú tốt nhất với sai số nhỏ về góc và lực: bỏ những cú chỉ ăn nhờ may (nảy nhiều băng)
  cands.sort((x, y) => y.score - x.score);
  // 9/10 bi: thế bi thường dày đặc nên kết quả mô phỏng rất nhạy; kiểm tra độ chắc của các cú đứng đầu kể cả khi chưa ăn bi
  const robustSet = rack ? cands.slice(0, 40) : cands.filter((c) => c.score >= 300).slice(0, 60);
  for (const c of cands) if (c.score >= 300 && !robustSet.includes(c)) c.score = 299; // chưa kiểm tra độ chắc thì không ưu tiên
  for (const c of robustSet) {
    if (Date.now() > deadline + 700) { c.score = 299; continue; }
    let sum = c.score;
    let mn = c.score;
    for (const [da, dp] of [[0.15, 1.02], [-0.15, 0.98], [0.35, 0.97], [-0.35, 1.03]]) { const v = evalShot(c.pos, c.angle + da * Math.PI / 180, Math.min(1, c.power * dp), c.sy, c.call); sum += v; if (v < mn) mn = v; }
    c.score = (sum / 5) * 0.6 + mn * 0.4;
  }
  if (!cands.length) cands.push({ angle: Math.random() * 6.283, power: 0.5, sx: 0, sy: 0, score: 0, call: needCall ? { ball: targets[0], pocket: 0 } : undefined, pos: job.inHand ? (canPlace(base, 0, W * 0.2, H / 2, false) ? [W * 0.2, H / 2] : [W * 0.15, H * 0.3]) : undefined });
  return finalize(pickBest(cands, job.level), job.level);
}
