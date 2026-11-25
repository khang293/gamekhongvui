// Phòng cờ online 2 người (caro, cờ vua, cờ tướng). Chủ phòng giữ danh sách nước đi và kiểm tra từng nước bằng duelRules;
// khách chỉ gửi ý định. Ghế 0 = chủ phòng. Ván đầu chủ phòng đi trước, mỗi lần đấu lại thì đổi bên.
import { RoomHost, RoomClient, makeCode, normCode, sanitizeName, realClock, type Clock, type Member, type RejectReason } from './room';
import { TransportError, type Transport } from './transport';
import { judge, type DuelGame, type DuelSettings } from './duelRules';

export interface DuelState {
  game: DuelGame; seq: number; round: number; code: string;
  phase: 'lobby' | 'play' | 'over';
  settings: DuelSettings;
  names: [string, string];        // [chủ phòng, khách]
  guestOnline: boolean;
  hostSide: 0 | 1;                // chủ phòng cầm bên nào (0 đi trước)
  moves: unknown[];
  winner: -1 | 0 | 1 | null;      // bên thắng, -1 hòa
  reason: '' | 'move' | 'resign';
  score: [number, number];        // số ván thắng [chủ, khách]
  rematch: [boolean, boolean];
  mySlot: 0 | 1;
}
/** bên mà một người đang cầm */
export const sideOf = (s: DuelState, slot: number): 0 | 1 => (slot === 0 ? s.hostSide : ((1 - s.hostSide) as 0 | 1));
export const mySide = (s: DuelState) => sideOf(s, s.mySlot);
export const myTurn = (s: DuelState) => s.phase === 'play' && s.moves.length % 2 === mySide(s);

export class DuelGameHost {
  phase: DuelState['phase'] = 'lobby';
  names: [string, string] = ['', ''];
  guestOnline = false;
  hostSide: 0 | 1 = 0;
  moves: unknown[] = [];
  winner: DuelState['winner'] = null;
  reason: DuelState['reason'] = '';
  score: [number, number] = [0, 0];
  rematch: [boolean, boolean] = [false, false];
  round = 0;
  seq = 0;
  constructor(readonly game: DuelGame, readonly settings: DuelSettings, readonly code: string, hostName: string, private onChange: () => void = () => {}) {
    this.names[0] = sanitizeName(hostName);
  }
  private notify() { this.seq++; this.onChange(); }
  join(name: string) {
    this.names[1] = sanitizeName(name); this.guestOnline = true; this.score = [0, 0]; this.hostSide = 0;
    this.begin();
  }
  online(on: boolean) { if (this.guestOnline !== on) { this.guestOnline = on; this.notify(); } }
  leave() {
    this.names[1] = ''; this.guestOnline = false; this.phase = 'lobby'; this.moves = []; this.winner = null; this.reason = ''; this.rematch = [false, false];
    this.notify();
  }
  private begin() {
    this.phase = 'play'; this.moves = []; this.winner = null; this.reason = ''; this.rematch = [false, false]; this.round++;
    this.notify();
  }
  private finish(winner: -1 | 0 | 1, reason: 'move' | 'resign') {
    this.phase = 'over'; this.winner = winner; this.reason = reason;
    if (winner >= 0) this.score[winner === this.hostSide ? 0 : 1]++;
  }
  /** Ý định của một người; luôn kiểm tra lại. */
  intent(slot: number, p: any): boolean {
    if ((slot !== 0 && slot !== 1) || !p || typeof p !== 'object') return false;
    if (p.type === 'move') {
      if (this.phase !== 'play' || p.ply !== this.moves.length) return false;
      const side = slot === 0 ? this.hostSide : 1 - this.hostSide;
      if (this.moves.length % 2 !== side) return false;
      const m = p.move && typeof p.move === 'object' ? { from: p.move.from, to: p.move.to, ...(p.move.promo ? { promo: p.move.promo } : {}) } : p.move;
      const next = [...this.moves, m];
      const out = judge(this.game, next, this.settings);
      if (!out.ok) return false;
      this.moves = next;
      if (out.winner !== null) this.finish(out.winner, 'move');
      this.notify();
      return true;
    }
    if (p.type === 'resign') {
      if (this.phase !== 'play') return false;
      const side = slot === 0 ? this.hostSide : 1 - this.hostSide;
      this.finish((1 - side) as 0 | 1, 'resign');
      this.notify();
      return true;
    }
    if (p.type === 'rematch') {
      if (this.phase !== 'over') return false;
      this.rematch[slot] = true;
      if (this.rematch[0] && this.rematch[1]) { this.hostSide = (1 - this.hostSide) as 0 | 1; this.begin(); } else this.notify();
      return true;
    }
    return false;
  }
  stateFor(slot: 0 | 1): DuelState {
    return {
      game: this.game, seq: this.seq, round: this.round, code: this.code, phase: this.phase, settings: { ...this.settings },
      names: [...this.names] as [string, string], guestOnline: this.guestOnline, hostSide: this.hostSide, moves: this.moves.slice(),
      winner: this.winner, reason: this.reason, score: [...this.score] as [number, number], rematch: [...this.rematch] as [boolean, boolean], mySlot: slot,
    };
  }
}

export class DuelNetHost {
  logic!: DuelGameHost;
  room: RoomHost;
  closed = false;
  private constructor(game: DuelGame, settings: DuelSettings, tr: Transport, clock: Clock, hostName: string, code: string, private onState: (s: DuelState) => void) {
    this.logic = new DuelGameHost(game, settings, code, hostName, () => this.publish());
    this.room = new RoomHost(tr, {
      canJoin: () => (this.logic.phase === 'lobby' ? 'ok' : 'started'),
      limit: () => 2,
      onJoin: (m, re) => { if (re) this.logic.online(true); else this.logic.join(m.name); this.publish(); },
      onOnline: (m: Member, on: boolean) => { if (!m.local) { this.logic.online(on); this.publish(); } },
      onLeave: () => { this.logic.leave(); },
      onIntent: (m, p) => { this.logic.intent(m.slot, p); },
    }, { code, hostName, clock, maxSlots: 2 });
  }
  static async create(game: DuelGame, settings: DuelSettings, makeTransport: () => Transport, hostName: string, onState: (s: DuelState) => void, clock: Clock = realClock): Promise<DuelNetHost> {
    let lastErr: unknown = null;
    for (let i = 0; i < 6; i++) {
      const tr = makeTransport();
      const h = new DuelNetHost(game, settings, tr, clock, hostName, makeCode(), onState);
      try { await h.room.open(); h.publish(); return h; } catch (e) {
        lastErr = e; try { tr.close(); } catch {}
        if (!(e instanceof TransportError && e.code === 'unavailable-id')) break;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('create-failed');
  }
  publish() {
    if (this.closed || !this.room) return;
    for (const m of this.room.members) {
      if (m.local) this.onState(this.logic.stateFor(0));
      else if (m.online) this.room.send(m, this.logic.stateFor(1));
    }
  }
  send(p: unknown) { return this.logic.intent(0, p); }
  close() { if (this.closed) return; this.closed = true; this.room.close('hostLeft'); }
}

/** Không tin dữ liệu từ máy chủ phòng: kiểm tra kiểu và phát lại nước đi. */
export function validDuel(s: any, game: DuelGame): DuelState | null {
  if (!s || typeof s !== 'object' || s.game !== game || !['lobby', 'play', 'over'].includes(s.phase)) return null;
  if (!Number.isInteger(s.seq) || !Number.isInteger(s.round) || (s.mySlot !== 0 && s.mySlot !== 1) || (s.hostSide !== 0 && s.hostSide !== 1)) return null;
  if (!s.settings || ![15, 19, 25].includes(s.settings.size) || !Array.isArray(s.names) || s.names.length !== 2) return null;
  if (!Array.isArray(s.score) || !s.score.every((x: unknown) => Number.isInteger(x)) || !Array.isArray(s.rematch)) return null;
  if (![null, -1, 0, 1].includes(s.winner) || !['', 'move', 'resign'].includes(s.reason)) return null;
  if (!judge(game, s.moves, s.settings).ok) return null;
  return { ...s, code: normCode(String(s.code || '')), names: [sanitizeName(s.names[0]), sanitizeName(s.names[1])], rematch: [!!s.rematch[0], !!s.rematch[1]] } as DuelState;
}

export class DuelNetClient {
  rc: RoomClient;
  private seq = -1;
  constructor(game: DuelGame, factory: () => Transport, hooks: { onState(s: DuelState): void; onStatus(st: 'online' | 'lost'): void; onClosed(r: RejectReason): void }, clock: Clock = realClock) {
    this.rc = new RoomClient(factory, {
      onGame: (p) => {
        const s = validDuel(p, game);
        if (!s) { if (p && p.game !== game) { this.rc.leave(); hooks.onClosed('badmsg'); } return; } // mã phòng của trò khác
        if (s.seq < this.seq) return;
        this.seq = s.seq; hooks.onState(s);
      },
      onStatus: (st) => { if (st === 'online') this.seq = -1; hooks.onStatus(st); },
      onClosed: (r) => hooks.onClosed(r),
    }, clock);
  }
  join(code: string, name: string, token = '') { return this.rc.join(normCode(code), name, token); }
  send(p: unknown) { this.rc.send(p); }
  leave() { this.rc.leave(); }
}
