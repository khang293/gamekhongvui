// Vẽ và đoán chữ qua phòng online: máy chủ phòng chạy DGGame, gửi cho mỗi người trạng thái riêng, dòng chat và nét vẽ.
import { DGGame, cleanOp, packOps, MAX_PLAYERS, type DGState, type DGLog, type DGSettings, type Op } from './drawGame';
import { RoomHost, RoomClient, makeCode, normCode, sanitizeName, cleanChat, realClock, type Clock, type Member, type RejectReason, type JoinInfo } from './net/room';
import { TransportError, type Transport } from './net/transport';

const AWAY_REMOVE_MS = 600000; // giữ ghế và điểm 10 phút cho người rời hay mất mạng
export interface DGOps { game: 'dg'; k: 'op'; reset: boolean; ops: Op[] }
export interface DGViewHooks {
  onState(s: DGState): void;
  onLog(l: DGLog): void;
  onOps(ops: Op[], reset: boolean): void;
}

export class DGNetHost {
  game: DGGame;
  room: RoomHost;
  closed = false;
  private constructor(tr: Transport, private clock: Clock, hostName: string, code: string, private view: DGViewHooks) {
    this.game = new DGGame({
      onState: () => this.publish(),
      onLog: (line, to) => {
        for (const m of this.room.members) {
          if (to && !to.includes(m.slot)) continue;
          if (m.local) this.view.onLog(line); else if (m.online) this.room.send(m, line);
        }
      },
      onOps: (ops, reset, from) => {
        for (const m of this.room.members) {
          if (m.slot === from) continue;
          if (m.local) this.view.onOps(ops, reset); else if (m.online) this.sendOps(m, ops, reset);
        }
      },
    }, clock, { code });
    this.room = new RoomHost(tr, {
      canJoin: () => 'ok', // vào giữa chừng được
      limit: () => MAX_PLAYERS,
      keepSeat: () => this.game.phase !== 'lobby' && this.game.phase !== 'over',
      onJoin: (m, re) => {
        if (re) this.game.markOnline(m.slot, true); else this.game.join(m.slot, m.name);
        this.publish();
        // người mới hoặc nối lại: gửi bức vẽ đang có (người vẽ nối lại cũng cần)
        this.sendOps(m, [], true);
        for (const pack of packOps(this.game.ops)) this.sendOps(m, pack, false);
      },
      onOnline: (m, on) => this.onOnline(m, on),
      onAway: (m) => this.onOnline(m, false),
      onLeave: (m) => this.game.leave(m.slot),
      onIntent: (m, p) => { this.game.intent(m.slot, p); },
    }, { code, hostName, clock, maxSlots: MAX_PLAYERS });
  }
  static async create(makeTransport: () => Transport, hostName: string, view: DGViewHooks, words: 'vi' | 'en', clock: Clock = realClock): Promise<DGNetHost> {
    let lastErr: unknown = null;
    for (let i = 0; i < 6; i++) {
      const tr = makeTransport();
      const h = new DGNetHost(tr, clock, hostName, makeCode(), view);
      try {
        await h.room.open();
        h.game.settings.words = words;
        h.game.join(0, h.room.host.name);
        return h;
      } catch (e) {
        lastErr = e; try { tr.close(); } catch {}
        if (!(e instanceof TransportError && e.code === 'unavailable-id')) break;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('create-failed');
  }
  private sendOps(m: Member, ops: Op[], reset: boolean) {
    const msg: DGOps = { game: 'dg', k: 'op', reset, ops };
    this.room.send(m, msg);
  }
  private onOnline(m: Member, on: boolean) {
    if (m.local) return;
    if (!on && (this.game.phase === 'lobby' || this.game.phase === 'over')) { this.room.removeMember(m, 'left'); return; }
    this.game.markOnline(m.slot, on);
    if (!on) {
      const at = m.offlineSince;
      this.clock.after(() => { if (!this.closed && !m.online && m.offlineSince === at) this.room.removeMember(m, 'left'); }, AWAY_REMOVE_MS);
    }
  }
  publish() {
    if (this.closed || !this.room) return;
    for (const m of this.room.members) {
      if (m.local) this.view.onState(this.game.stateFor(m.slot));
      else if (m.online) this.room.send(m, this.game.stateFor(m.slot));
    }
  }
  get code() { return this.room.code; }
  send(p: unknown) { return this.game.intent(0, p); }
  start() { return this.game.start(); }
  again() { this.game.backToLobby(); }
  setSettings(p: Partial<DGSettings>) { this.game.setSettings(p); }
  close() { if (this.closed) return; this.closed = true; this.game.dispose(); this.room.close('hostLeft'); }
}

// ---------- khách ----------
const int = (v: unknown, lo = -1e9, hi = 1e9) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
const wordText = (v: unknown) => str(v, 40).replace(/[<>&"'`]/g, '');
/** Không tin dữ liệu từ máy chủ phòng: kiểm tra kiểu mọi thứ sẽ đưa lên trang. */
export function validState(s: any): DGState | null {
  if (!s || typeof s !== 'object' || s.game !== 'dg' || s.k !== 'st') return null;
  if (!['lobby', 'pick', 'draw', 'reveal', 'over'].includes(s.phase)) return null;
  if (!int(s.seq, 0) || !int(s.mySlot, 0, MAX_PLAYERS - 1) || !int(s.round, 0, 99) || !int(s.turn, 0) || !int(s.drawer, -1, MAX_PLAYERS - 1)) return null;
  if (s.ms !== null && typeof s.ms !== 'number') return null;
  if (!Array.isArray(s.players) || s.players.length > MAX_PLAYERS || !s.players.every((p: any) => p && int(p.slot, 0, MAX_PLAYERS - 1) && int(p.score, 0) && int(p.gain, 0))) return null;
  if (!Array.isArray(s.choices) || s.choices.length > 3 || !s.settings || !int(s.settings.rounds, 1, 9) || !int(s.settings.seconds, 10, 600)) return null;
  return {
    ...s, code: normCode(String(s.code || '')), mask: wordText(s.mask), word: wordText(s.word), choices: s.choices.map(wordText), skipped: !!s.skipped,
    settings: { rounds: s.settings.rounds, seconds: s.settings.seconds, words: s.settings.words === 'en' ? 'en' : 'vi' },
    players: s.players.map((p: any) => ({ slot: p.slot, name: sanitizeName(p.name), online: !!p.online, score: p.score, got: !!p.got, gain: p.gain })),
  };
}
const LOGS = ['chat', 'secret', 'close', 'got', 'turn', 'join', 'leave', 'word'];

export class DGNetClient {
  rc: RoomClient;
  private seq = -1;
  info: JoinInfo | null = null;
  constructor(factory: () => Transport, hooks: DGViewHooks & { onStatus(st: 'online' | 'lost'): void; onClosed(r: RejectReason): void }, clock: Clock = realClock) {
    this.rc = new RoomClient(factory, {
      onGame: (p) => {
        if (!p || p.game !== 'dg') { this.rc.leave(); hooks.onClosed('badmsg'); return; }
        if (p.k === 'st') {
          const s = validState(p);
          if (!s || s.seq < this.seq) return;
          this.seq = s.seq; hooks.onState(s);
        } else if (p.k === 'op') {
          if (!Array.isArray(p.ops)) return;
          const ops = p.ops.map(cleanOp).filter(Boolean) as Op[];
          hooks.onOps(ops, !!p.reset);
        } else if (p.k === 'log' && LOGS.includes(p.kind) && int(p.slot, 0, MAX_PLAYERS - 1)) {
          hooks.onLog({ game: 'dg', k: 'log', kind: p.kind, slot: p.slot, name: sanitizeName(p.name), text: cleanChat(p.text) });
        }
      },
      onStatus: (st) => { if (st === 'online') this.seq = -1; hooks.onStatus(st); },
      onClosed: (r) => hooks.onClosed(r),
    }, clock);
  }
  async join(code: string, name: string, token = ''): Promise<JoinInfo> {
    this.info = await this.rc.join(normCode(code), name, token);
    return this.info;
  }
  send(p: unknown) { this.rc.send(p); }
  leave() { this.rc.leave(); }
}
