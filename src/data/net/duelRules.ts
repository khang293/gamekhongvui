// Luật dùng cho phòng cờ online 2 người: phát lại toàn bộ nước đi, kiểm tra hợp lệ và cho biết kết quả.
// Bên 0 luôn đi trước (X ở caro, Trắng ở cờ vua, Đỏ ở cờ tướng). Không dựng lại luật: dùng đúng engine của từng game.
import { startState, legalMoves as chessMoves, makeMove, status, posKey } from '../chessEngine';
import { startBoard, legalMoves as xqMoves, make } from '../xiangqiEngine';

export type DuelGame = 'caro' | 'chess' | 'xiangqi';
export interface DuelSettings { size: number } // chỉ caro dùng
export interface Outcome {
  ok: boolean;       // mọi nước đều hợp lệ
  turn: 0 | 1;       // bên tới lượt
  winner: -1 | 0 | 1 | null; // null: chưa xong, -1: hòa
}
const BAD: Outcome = { ok: false, turn: 0, winner: null };
const int = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;

function caro(moves: unknown[], N: number): Outcome {
  if (![15, 19, 25].includes(N) || moves.length > N * N) return BAD;
  const b = new Int8Array(N * N);
  const at = (r: number, c: number) => (r < 0 || r >= N || c < 0 || c >= N ? 0 : b[r * N + c]);
  let winner: Outcome['winner'] = null;
  for (let k = 0; k < moves.length; k++) {
    const i = moves[k];
    if (winner !== null || !int(i, 0, N * N - 1) || b[i as number]) return BAD;
    const me = (k % 2) + 1, r = Math.floor((i as number) / N), c = (i as number) % N;
    b[i as number] = me;
    for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
      let n = 1;
      for (const s of [1, -1]) for (let d = 1; at(r + s * dr * d, c + s * dc * d) === me; d++) n++;
      if (n >= 5) winner = (k % 2) as 0 | 1;
    }
    if (winner === null && k === N * N - 1) winner = -1;
  }
  return { ok: true, turn: (moves.length % 2) as 0 | 1, winner };
}

function chess(moves: unknown[]): Outcome {
  if (moves.length > 800) return BAD;
  let st = startState();
  const seen = new Map<string, number>([[posKey(st), 1]]);
  let winner: Outcome['winner'] = null;
  for (let k = 0; k < moves.length; k++) {
    const m = moves[k] as { from?: number; to?: number; promo?: number } | null;
    if (winner !== null || !m || typeof m !== 'object') return BAD;
    const found = chessMoves(st).find((x) => x.from === m.from && x.to === m.to && (x.promo || 0) === (m.promo || 0));
    if (!found) return BAD;
    st = makeMove(st, found);
    const key = posKey(st), reps = (seen.get(key) || 0) + 1;
    seen.set(key, reps);
    const s = status(st);
    if (s === 'mate') winner = (k % 2) as 0 | 1;
    else if (s === 'stalemate' || s === 'fifty' || s === 'material' || reps >= 3) winner = -1;
  }
  return { ok: true, turn: (moves.length % 2) as 0 | 1, winner };
}

function xiangqi(moves: unknown[]): Outcome {
  if (moves.length > 800) return BAD;
  const b = startBoard();
  let turn = 1, since = 0;
  const seen = new Map<string, number>([[b.join('') + turn, 1]]);
  let winner: Outcome['winner'] = null;
  for (let k = 0; k < moves.length; k++) {
    const m = moves[k];
    if (winner !== null || !int(m, 0, 16383) || !xqMoves(b, turn).includes(m as number)) return BAD;
    const cap = make(b, m as number);
    turn = -turn; since = cap ? 0 : since + 1;
    const key = b.join('') + turn, reps = (seen.get(key) || 0) + 1;
    seen.set(key, reps);
    if (!xqMoves(b, turn).length) winner = (k % 2) as 0 | 1;
    else if (reps >= 3 || since >= 120) winner = -1;
  }
  return { ok: true, turn: (moves.length % 2) as 0 | 1, winner };
}

export function judge(game: DuelGame, moves: unknown[], settings: DuelSettings): Outcome {
  if (!Array.isArray(moves)) return BAD;
  return game === 'caro' ? caro(moves, settings.size) : game === 'chess' ? chess(moves) : xiangqi(moves);
}
