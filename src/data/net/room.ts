// Phòng chơi online dùng chung cho mọi game (Tiến lên, sau này poker). Mô hình: một "chủ phòng" (host) chạy luật và giữ trạng thái,
// các "khách" (client) chỉ gửi ý định và nhận bản xem riêng của mình. File này lo phần hạ tầng:
// mã phòng, bắt tay (hello/welcome) có số phiên bản giao thức, gán ghế, mã nối lại (token), nhịp tim (ping/pong), kiểm tra
// kích thước và dạng tin nhắn, giới hạn tốc độ, chủ phòng thoát thì đóng phòng. Luật của game nằm ở file khác.
import { TransportError, type Transport } from './transport';

export const PROTOCOL = 1;
export const MAX_MSG = 16384;                // ký tự tối đa của một tin nhắn
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // bỏ I, L, O, 0, 1 cho khỏi nhầm
export const CODE_LEN = 5;
export const peerIdOf = (code: string) => 'gkv-' + code;

// ---------- Đồng hồ (có bản giả để thử) ----------
export interface Clock {
  now(): number;
  every(fn: () => void, ms: number): () => void;
  after(fn: () => void, ms: number): () => void;
}
export const realClock: Clock = {
  now: () => Date.now(),
  every: (fn, ms) => { const id = setInterval(fn, ms); return () => clearInterval(id); },
  after: (fn, ms) => { const id = setTimeout(fn, ms); return () => clearTimeout(id); },
};
export class FakeClock implements Clock {
  t = 0;
  private seq = 0;
  private timers: { id: number; at: number; fn: () => void; every: number }[] = [];
  now() { return this.t; }
  every(fn: () => void, ms: number) { const id = ++this.seq; this.timers.push({ id, at: this.t + ms, fn, every: ms }); return () => this.cancel(id); }
  after(fn: () => void, ms: number) { const id = ++this.seq; this.timers.push({ id, at: this.t + ms, fn, every: 0 }); return () => this.cancel(id); }
  private cancel(id: number) { this.timers = this.timers.filter((x) => x.id !== id); }
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      let next: { id: number; at: number; fn: () => void; every: number } | null = null;
      for (const x of this.timers) if (x.at <= end && (!next || x.at < next.at || (x.at === next.at && x.id < next.id))) next = x;
      if (!next) break;
      this.t = Math.max(this.t, next.at);
      if (next.every) next.at += next.every; else this.timers = this.timers.filter((x) => x.id !== next!.id);
      next.fn();
    }
    this.t = end;
  }
}

// ---------- Tiện ích ----------
export function makeCode(rng: () => number = Math.random): string {
  let s = '';
  for (let i = 0; i < CODE_LEN; i++) s += CODE_ALPHABET[Math.floor(rng() * CODE_ALPHABET.length)];
  return s;
}
export const normCode = (s: string) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LEN);
export const validCode = (s: string) => s.length === CODE_LEN && [...s].every((c) => CODE_ALPHABET.includes(c));

export function newToken(): string {
  const a = new Uint8Array(12);
  (globalThis.crypto as Crypto).getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const TOKEN_RE = /^[0-9a-f]{24}$/;

/** Làm sạch tên người chơi: bỏ ký tự điều khiển và ký tự HTML, tối đa 16 ký tự. */
export function sanitizeName(s: unknown, fallback = 'Người chơi'): string {
  let t = typeof s === 'string' ? s : '';
  t = t.normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069<>&"'`\x5c]/g, '').replace(/\s+/g, ' ').trim();
  t = [...t].slice(0, 16).join('').trim();
  return t || fallback;
}
export const escapeHtml = (s: string) => s.replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c] as string));

export type RejectReason = 'version' | 'full' | 'started' | 'noroom' | 'timeout' | 'network' | 'closed' | 'badmsg' | 'kicked' | 'hostLeft' | 'lost';
export class RoomError extends Error { constructor(public reason: RejectReason, msg?: string) { super(msg || reason); } }

type Env = { v: number; t: string; [k: string]: unknown };
const TYPES = new Set(['hello', 'welcome', 'reject', 'ping', 'pong', 'g', 'closed', 'bye']);

/** Đọc và kiểm tra một tin nhắn thô. Trả null nếu hỏng, quá dài hoặc sai dạng. */
export function parseEnvelope(raw: unknown): Env | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_MSG) return null;
  let o: any;
  try { o = JSON.parse(raw); } catch { return null; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  if (typeof o.t !== 'string' || !TYPES.has(o.t)) return null;
  if (typeof o.v !== 'number') return null;
  return o as Env;
}
const enc = (t: string, rest: Record<string, unknown> = {}) => JSON.stringify({ v: PROTOCOL, t, ...rest });

// ---------- Chủ phòng ----------
export interface Member {
  slot: number; name: string; token: string; peerId: string | null;
  online: boolean; lastSeen: number; offlineSince: number; local: boolean;
}
export interface HostHooks {
  /** 'ok' khi còn cho vào (sảnh), 'started' khi ván đã bắt đầu (chỉ người cũ có token được nối lại) */
  canJoin(): 'ok' | 'started';
  /** số ghế người tối đa hiện tại (theo cài đặt của chủ phòng) */
  limit(): number;
  onJoin(m: Member, reconnect: boolean): void;
  onOnline(m: Member, online: boolean): void;
  onLeave(m: Member, why: 'left' | 'kicked'): void;
  onIntent(m: Member, payload: any): void;
}
export interface HostOpts {
  code: string; hostName: string; clock?: Clock; maxSlots?: number;
  heartbeatMs?: number; timeoutMs?: number; helloMs?: number;
}

export class RoomHost {
  readonly code: string;
  readonly clock: Clock;
  readonly maxSlots: number;
  readonly heartbeatMs: number;
  readonly timeoutMs: number;
  readonly helloMs: number;
  members: Member[] = [];
  private byPeer = new Map<string, Member>();
  private pending = new Map<string, () => void>(); // peer chưa hello -> hủy hẹn giờ
  private buckets = new Map<string, { n: number; at: number }>();
  private stopBeat: (() => void) | null = null;
  closed = false;
  stats = { rejected: 0, badmsg: 0 };

  constructor(private tr: Transport, private hooks: HostHooks, opts: HostOpts) {
    this.code = opts.code;
    this.clock = opts.clock || realClock;
    this.maxSlots = opts.maxSlots ?? 4;
    this.heartbeatMs = opts.heartbeatMs ?? 5000;
    this.timeoutMs = opts.timeoutMs ?? 15000;
    this.helloMs = opts.helloMs ?? 10000;
    const me: Member = { slot: 0, name: sanitizeName(opts.hostName), token: newToken(), peerId: null, online: true, lastSeen: this.clock.now(), offlineSince: 0, local: true };
    this.members.push(me);
  }
  get host(): Member { return this.members[0]; }

  async open(): Promise<void> {
    await this.tr.open(peerIdOf(this.code));
    this.tr.onPeerJoin((p) => this.peerJoin(p));
    this.tr.onPeerLeave((p) => this.peerLeave(p));
    this.tr.onMessage((from, raw) => this.onRaw(from, raw));
    this.stopBeat = this.clock.every(() => this.beat(), this.heartbeatMs);
  }

  private peerJoin(p: string) {
    if (this.closed) return;
    this.pending.get(p)?.();
    this.pending.set(p, this.clock.after(() => { this.pending.delete(p); if (!this.byPeer.has(p)) this.tr.disconnect(p); }, this.helloMs));
  }
  private peerLeave(p: string) {
    this.pending.get(p)?.(); this.pending.delete(p); this.buckets.delete(p);
    const m = this.byPeer.get(p);
    if (!m) return;
    this.byPeer.delete(p);
    if (m.peerId === p) { m.peerId = null; this.setOnline(m, false); }
  }
  private setOnline(m: Member, on: boolean) {
    if (m.online === on) return;
    m.online = on; m.offlineSince = on ? 0 : this.clock.now();
    this.hooks.onOnline(m, on);
  }
  private allow(p: string): boolean {
    const t = this.clock.now();
    const b = this.buckets.get(p) || { n: 40, at: t };
    b.n = Math.min(40, b.n + ((t - b.at) / 1000) * 25); b.at = t;
    if (b.n < 1) { this.buckets.set(p, b); return false; }
    b.n -= 1; this.buckets.set(p, b); return true;
  }
  private reject(p: string, reason: RejectReason) {
    this.stats.rejected++;
    this.tr.send(p, enc('reject', { reason }));
    this.pending.get(p)?.();
    this.pending.set(p, this.clock.after(() => { this.pending.delete(p); if (!this.byPeer.has(p)) this.tr.disconnect(p); }, 1500));
  }

  private onRaw(from: string, raw: string) {
    if (this.closed) return;
    if (!this.allow(from)) { this.stats.badmsg++; return; }
    const e = parseEnvelope(raw);
    if (!e) { this.stats.badmsg++; if (!this.byPeer.has(from)) this.reject(from, 'badmsg'); return; }
    const m = this.byPeer.get(from);
    if (m) m.lastSeen = this.clock.now();
    switch (e.t) {
      case 'hello': return this.onHello(from, e);
      case 'ping': if (m) this.tr.send(from, enc('pong')); return;
      case 'pong': return;
      case 'bye': if (m) this.removeMember(m, 'left'); return;
      case 'g': if (m) this.hooks.onIntent(m, e.p); return;
      default: return; // khách không được gửi welcome/reject/closed
    }
  }

  private onHello(from: string, e: Env) {
    if (this.byPeer.has(from)) return;
    if (e.v !== PROTOCOL) return this.reject(from, 'version');
    const name = sanitizeName(e.name);
    const token = typeof e.token === 'string' && TOKEN_RE.test(e.token) ? e.token : '';
    // nối lại bằng token của người cũ
    const old = token ? this.members.find((x) => !x.local && x.token === token) : undefined;
    if (old) {
      if (old.peerId && old.peerId !== from) { const op = old.peerId; this.byPeer.delete(op); old.peerId = null; this.tr.disconnect(op); }
      this.pending.get(from)?.(); this.pending.delete(from);
      old.peerId = from; old.lastSeen = this.clock.now(); this.byPeer.set(from, old);
      this.tr.send(from, enc('welcome', { slot: old.slot, token: old.token, code: this.code, name: old.name, reconnect: true }));
      this.setOnline(old, true);
      this.hooks.onJoin(old, true);
      return;
    }
    if (this.hooks.canJoin() !== 'ok') return this.reject(from, 'started');
    const used = new Set(this.members.map((x) => x.slot));
    let slot = -1;
    for (let i = 0; i < Math.min(this.maxSlots, this.hooks.limit()); i++) if (!used.has(i)) { slot = i; break; }
    if (slot < 0) return this.reject(from, 'full');
    this.pending.get(from)?.(); this.pending.delete(from);
    const nm: Member = { slot, name, token: newToken(), peerId: from, online: true, lastSeen: this.clock.now(), offlineSince: 0, local: false };
    this.members.push(nm); this.byPeer.set(from, nm);
    this.tr.send(from, enc('welcome', { slot, token: nm.token, code: this.code, name, reconnect: false }));
    this.hooks.onJoin(nm, false);
  }

  private beat() {
    if (this.closed) return;
    const t = this.clock.now();
    for (const m of [...this.members]) {
      if (m.local || !m.peerId) continue;
      if (t - m.lastSeen > this.timeoutMs) { const p = m.peerId; this.tr.disconnect(p); this.peerLeave(p); continue; }
      this.tr.send(m.peerId, enc('ping'));
    }
  }

  removeMember(m: Member, why: 'left' | 'kicked') {
    if (m.local) return;
    const i = this.members.indexOf(m);
    if (i < 0) return;
    this.members.splice(i, 1);
    if (m.peerId) {
      const p = m.peerId; this.byPeer.delete(p);
      if (why === 'kicked') this.tr.send(p, enc('closed', { reason: 'kicked' }));
      this.clock.after(() => this.tr.disconnect(p), 300);
      m.peerId = null;
    }
    m.online = false;
    this.hooks.onLeave(m, why);
  }

  /** Gửi một tin của game tới một khách (chủ phòng tự xử lý phần của mình, không gửi qua mạng). */
  send(m: Member, payload: unknown) {
    if (m.local || !m.peerId || this.closed) return;
    const s = enc('g', { p: payload });
    this.tr.send(m.peerId, s);
  }

  close(reason: RejectReason = 'hostLeft') {
    if (this.closed) return;
    for (const m of this.members) if (!m.local && m.peerId) this.tr.send(m.peerId, enc('closed', { reason }));
    this.closed = true;
    this.stopBeat?.();
    for (const c of this.pending.values()) c();
    this.pending.clear();
    // cho tin 'closed' kịp đi trước khi ngắt
    this.clock.after(() => this.tr.close(), 400);
  }
}

// ---------- Khách ----------
export interface ClientHooks {
  onGame(payload: any): void;
  onStatus(status: 'online' | 'lost'): void;
  onClosed(reason: RejectReason): void;
}
export interface JoinInfo { slot: number; token: string; code: string; name: string; reconnect: boolean }

export class RoomClient {
  status: 'idle' | 'connecting' | 'online' | 'lost' | 'closed' = 'idle';
  info: JoinInfo | null = null;
  private tr: Transport | null = null;
  private hostId = '';
  private myName = '';
  private lastHostMsg = 0;
  private stopBeat: (() => void) | null = null;
  private recoTimer: (() => void) | null = null;
  private lostAt = 0;

  constructor(private factory: () => Transport, private hooks: ClientHooks, private clock: Clock = realClock, private opts: { heartbeatMs?: number; timeoutMs?: number; graceMs?: number; retryMs?: number; connectMs?: number } = {}) {}
  private get timeoutMs() { return this.opts.timeoutMs ?? 15000; }
  private get graceMs() { return this.opts.graceMs ?? 60000; }

  /** Nối vào phòng. Có token cũ thì xin lại đúng ghế. Reject bằng RoomError. */
  async join(code: string, name: string, token = ''): Promise<JoinInfo> {
    this.status = 'connecting';
    this.hostId = peerIdOf(code); this.myName = sanitizeName(name);
    try {
      const info = await this.attempt(token);
      this.info = info;
      this.status = 'online';
      this.lastHostMsg = this.clock.now();
      this.stopBeat = this.clock.every(() => this.beat(), this.opts.heartbeatMs ?? 5000);
      return info;
    } catch (e) {
      this.status = 'closed';
      throw e instanceof RoomError ? e : new RoomError('network');
    }
  }

  private async attempt(token: string): Promise<JoinInfo> {
    this.tr?.close();
    const tr = this.factory();
    this.tr = tr;
    try { await tr.open(); } catch (e) { throw new RoomError(e instanceof TransportError && e.code === 'timeout' ? 'timeout' : 'network'); }
    try { await tr.connect(this.hostId, this.opts.connectMs ?? 12000); } catch (e) {
      const c = e instanceof TransportError ? e.code : 'network';
      throw new RoomError(c === 'no-peer' ? 'noroom' : c === 'timeout' ? 'timeout' : 'network');
    }
    return new Promise<JoinInfo>((resolve, reject) => {
      let done = false;
      const fin = (f: () => void) => { if (done) return; done = true; stop(); f(); };
      const stop = this.clock.after(() => fin(() => reject(new RoomError('timeout'))), 10000);
      tr.onMessage((from, raw) => {
        if (from !== this.hostId) return;
        const e = parseEnvelope(raw);
        if (!e) return;
        this.lastHostMsg = this.clock.now();
        if (!done) {
          if (e.t === 'welcome' && typeof e.slot === 'number' && typeof e.token === 'string') {
            return fin(() => resolve({ slot: e.slot as number, token: e.token as string, code: String(e.code || ''), name: String(e.name || this.myName), reconnect: !!e.reconnect }));
          }
          if (e.t === 'reject') return fin(() => reject(new RoomError(String(e.reason) as RejectReason)));
          if (e.t === 'closed') return fin(() => reject(new RoomError('closed')));
          return;
        }
        this.onHostMsg(e);
      });
      tr.onPeerLeave((p) => { if (p === this.hostId) { if (!done) fin(() => reject(new RoomError('closed'))); else this.connectionLost(); } });
      tr.send(this.hostId, enc('hello', { name: this.myName, token }));
    });
  }

  private onHostMsg(e: Env) {
    switch (e.t) {
      case 'ping': this.tr?.send(this.hostId, enc('pong')); return;
      case 'g': this.hooks.onGame(e.p); return;
      case 'closed': this.finish(String(e.reason || 'hostLeft') as RejectReason); return;
      default: return;
    }
  }

  private beat() {
    if (this.status !== 'online') return;
    if (this.clock.now() - this.lastHostMsg > this.timeoutMs) this.connectionLost();
  }

  private connectionLost() {
    if (this.status !== 'online') return;
    this.status = 'lost'; this.lostAt = this.clock.now();
    this.hooks.onStatus('lost');
    this.tryRecover();
  }
  private tryRecover() {
    this.recoTimer?.();
    this.recoTimer = this.clock.after(async () => {
      if (this.status !== 'lost') return;
      if (this.clock.now() - this.lostAt > this.graceMs) { this.finish('lost'); return; }
      try {
        const info = await this.attempt(this.info?.token || '');
        if (this.status !== 'lost') return;
        this.info = info; this.status = 'online'; this.lastHostMsg = this.clock.now();
        this.hooks.onStatus('online');
      } catch (e) {
        const r = e instanceof RoomError ? e.reason : 'network';
        if (r === 'noroom' || r === 'closed' || r === 'started' || r === 'full' || r === 'version') { this.finish('closed'); return; }
        this.tryRecover();
      }
    }, this.opts.retryMs ?? 3000);
  }

  send(payload: unknown) {
    if (this.status !== 'online') return;
    this.tr?.send(this.hostId, enc('g', { p: payload }));
  }
  private finish(reason: RejectReason) {
    if (this.status === 'closed') return;
    this.status = 'closed';
    this.stopBeat?.(); this.recoTimer?.();
    try { this.tr?.close(); } catch {}
    this.hooks.onClosed(reason);
  }
  leave() {
    if (this.status === 'closed') return;
    if (this.status === 'online') this.tr?.send(this.hostId, enc('bye'));
    this.status = 'closed';
    this.stopBeat?.(); this.recoTimer?.();
    this.clock.after(() => { try { this.tr?.close(); } catch {} }, 300);
  }
}
