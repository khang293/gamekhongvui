// Vẽ và đoán chữ: luật chơi, chấm điểm, so từ đoán và kiểm tra nét vẽ. Chạy trên máy chủ phòng.
// Ghế = số thứ tự trong phòng (0 là chủ phòng); người vào giữa chừng được xếp thêm vào lượt vẽ của vòng đang chơi.
import { WORDS, type WordLang } from './drawWords';
import { realClock, sanitizeName, cleanChat, type Clock } from './net/room';

export const MAX_PLAYERS = 8;
export const W = 800, H = 600;
export const COLORS = ['#ffffff', '#1d1d28', '#868e96', '#e03131', '#f76707', '#ffd43b', '#37b24d', '#1c7ed6', '#22b8cf', '#7048e8', '#e64980', '#8d5524', '#ffc9a0'];
export const SIZES = [4, 9, 18, 34];
export const ROUND_CHOICES = [1, 2, 3, 5];
export const TIME_CHOICES = [60, 80, 100, 120];
export const PICK_MS = 15000;
export const REVEAL_MS = 6000;
export const AWAY_MS = 8000;           // mất kết nối quá lâu: người vẽ bị bỏ lượt, người đoán không được chờ nữa
const MAX_ACTIONS = 1500;
const MAX_NUMBERS = 60000;             // tổng số tọa độ của một bức vẽ
export const MAX_PIECE = 400;          // số tọa độ tối đa trong một gói nét

// ---------- nét vẽ ----------
export type Op =
  | { o: 'p'; i: number; c: number; w: number; p: number[] } // đoạn nét; cùng i thì nối tiếp
  | { o: 'f'; i: number; c: number; x: number; y: number }   // đổ màu
  | { o: 'u' }                                               // hoàn tác
  | { o: 'c' };                                              // xóa hết

const int = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
/** Kiểm tra một thao tác vẽ lấy từ mạng; trả bản sạch hoặc null. */
export function cleanOp(op: any): Op | null {
  if (!op || typeof op !== 'object') return null;
  if (op.o === 'u' || op.o === 'c') return { o: op.o };
  if (!int(op.i, 0, 1e9) || !int(op.c, 0, COLORS.length - 1)) return null;
  if (op.o === 'f') return int(op.x, 0, W - 1) && int(op.y, 0, H - 1) ? { o: 'f', i: op.i, c: op.c, x: op.x, y: op.y } : null;
  if (op.o !== 'p' || !int(op.w, 0, SIZES.length - 1) || !Array.isArray(op.p) || op.p.length < 2 || op.p.length > MAX_PIECE || op.p.length % 2) return null;
  if (!op.p.every((v: unknown) => int(v, -50, W + 50))) return null;
  return { o: 'p', i: op.i, c: op.c, w: op.w, p: op.p.slice() };
}
/** Gộp một thao tác vào lịch sử bức vẽ. false = bỏ qua (đã đầy hoặc không có gì để làm). */
export function applyOp(list: Op[], op: Op): boolean {
  if (op.o === 'c') { list.length = 0; return true; }
  if (op.o === 'u') return list.pop() !== undefined;
  const last = list[list.length - 1];
  if (op.o === 'p') {
    let total = op.p.length;
    for (const a of list) if (a.o === 'p') total += a.p.length;
    if (total > MAX_NUMBERS) return false;
    if (last && last.o === 'p' && last.i === op.i) { for (const v of op.p) last.p.push(v); return true; }
  }
  if (list.length >= MAX_ACTIONS) return false;
  list.push(op.o === 'p' ? { ...op, p: op.p.slice() } : { ...op });
  return true;
}
/** Chia lịch sử thành các gói nhỏ để gửi cho người mới vào. */
export function packOps(list: Op[], maxChars = 9000): Op[][] {
  const out: Op[][] = [];
  let pack: Op[] = [], size = 0;
  const push = (op: Op) => {
    const len = JSON.stringify(op).length + 1;
    if (pack.length && size + len > maxChars) { out.push(pack); pack = []; size = 0; }
    pack.push(op); size += len;
  };
  for (const a of list) {
    if (a.o !== 'p') push(a);
    else for (let k = 0; k < a.p.length; k += MAX_PIECE) {
      // gói sau lặp lại điểm nối nằm ở máy nhận (cùng i nên được nối tiếp)
      push({ ...a, p: a.p.slice(k, k + MAX_PIECE) });
    }
  }
  if (pack.length) out.push(pack);
  return out;
}

// ---------- so từ đoán ----------
const TONES = /[̣̀́̃̉]/g; // huyền, sắc, ngã, hỏi, nặng
/** Chuẩn hóa có dấu: chữ thường, đặt dấu thanh về cuối mỗi tiếng (hoà = hòa). */
export function toneKey(s: string): string {
  return String(s).normalize('NFD').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim()
    .split(' ').map((w) => { const t = w.match(TONES); return w.replace(TONES, '').normalize('NFC') + (t ? t.join('') : ''); }).join(' ');
}
export const plainKey = (s: string) => String(s).normalize('NFD').toLowerCase().replace(/\p{M}/gu, '').replace(/đ/g, 'd').replace(/[^a-z0-9]+/g, ' ').trim();
const glue = (s: string) => s.replace(/ /g, '');
const hasMarks = (s: string) => /[\p{M}đĐ]/u.test(s.normalize('NFD'));
const CLASSIFIERS = /^(con|cái|quả|chiếc|cây|ngọn|ngôi|bông|trái|cục|quyển|đôi|hòn|dòng) /;
/** Các cách viết được tính là đúng: cả cụm, và bỏ loại từ đầu ("con mèo" = "mèo"). */
function answers(word: string): string[] {
  const w = word.toLowerCase();
  const short = w.replace(CLASSIFIERS, '');
  return short !== w && short.length >= 2 ? [w, short] : [w];
}
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const keep = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = keep;
    }
  }
  return row[b.length];
}
/** 'yes' đúng, 'close' gần đúng, 'no' sai. Gõ không dấu được chấp nhận; đã gõ dấu thì phải đúng dấu. */
export function judge(guess: string, word: string): 'yes' | 'close' | 'no' {
  const marked = hasMarks(guess);
  const g = glue(marked ? toneKey(guess) : plainKey(guess));
  if (!g) return 'no';
  for (const a of answers(word)) if (g === glue(marked ? toneKey(a) : plainKey(a))) return 'yes';
  const pg = glue(plainKey(guess));
  for (const a of answers(word)) {
    const pa = glue(plainKey(a));
    if (pa === pg || (pa.length >= 4 && distance(pg, pa) === 1)) return 'close';
  }
  return 'no';
}
/** Tin nhắn có để lộ từ cần đoán không. */
export function leaks(text: string, word: string): boolean {
  const t = ` ${plainKey(text)} `;
  return answers(word).some((a) => { const k = plainKey(a); return t.includes(` ${k} `) || (k.length >= 4 && glue(t).includes(glue(k))); });
}

// ---------- ván chơi ----------
export interface DGSettings { rounds: number; seconds: number; words: WordLang }
export interface DGPlayer { slot: number; name: string; online: boolean; score: number; got: boolean; gain: number }
export type DGPhase = 'lobby' | 'pick' | 'draw' | 'reveal' | 'over';
export interface DGState {
  game: 'dg'; k: 'st'; seq: number; code: string; phase: DGPhase; settings: DGSettings; players: DGPlayer[]; mySlot: number;
  round: number; turn: number; drawer: number; mask: string; word: string; choices: string[]; ms: number | null; skipped: boolean;
}
export type LogKind = 'chat' | 'secret' | 'close' | 'got' | 'turn' | 'join' | 'leave' | 'word';
export interface DGLog { game: 'dg'; k: 'log'; kind: LogKind; slot: number; name: string; text: string }

export interface DGHooks {
  onState(): void;
  /** to = ghế nhận; không có = tất cả */
  onLog(line: DGLog, to?: number[]): void;
  /** thao tác vẽ cần chuyển cho mọi người trừ người vẽ; reset = bức vẽ mới */
  onOps(ops: Op[], reset: boolean, from: number): void;
}

export class DGGame {
  settings: DGSettings = { rounds: 3, seconds: 80, words: 'vi' };
  phase: DGPhase = 'lobby';
  players: DGPlayer[] = [];
  ops: Op[] = [];
  round = 0;
  turn = 0;
  drawer = -1;
  word = '';
  choices: string[] = [];
  skipped = false;
  seq = 0;
  private queue: number[] = [];
  private used = new Set<string>();
  private shown = new Set<number>();
  private deadline = 0;
  private stops: (() => void)[] = [];
  private stopAway: (() => void) | null = null;
  private lastSay = new Map<number, number>();
  private offAt = new Map<number, number>();

  constructor(private hooks: DGHooks, public clock: Clock = realClock, private opts: { code?: string; rng?: () => number } = {}) {}
  private rng() { return (this.opts.rng || Math.random)(); }
  private notify() { this.seq++; this.hooks.onState(); }
  private log(kind: LogKind, slot: number, text = '', to?: number[]) {
    this.hooks.onLog({ game: 'dg', k: 'log', kind, slot, name: this.player(slot)?.name || '', text }, to);
  }
  player(slot: number) { return this.players.find((p) => p.slot === slot); }
  private onlineCount() { return this.players.filter((p) => p.online).length; }
  private clearTimers() { for (const s of this.stops.splice(0)) s(); this.stopAway?.(); this.stopAway = null; this.deadline = 0; }
  private after(ms: number, fn: () => void) { this.stops.push(this.clock.after(fn, ms)); }

  join(slot: number, name: string) {
    if (this.player(slot)) return;
    this.players.push({ slot, name: sanitizeName(name), online: true, score: 0, got: false, gain: 0 });
    this.players.sort((a, b) => a.slot - b.slot);
    if (this.phase === 'pick' || this.phase === 'draw' || this.phase === 'reveal') this.queue.push(slot);
    this.log('join', slot);
    this.notify();
  }
  leave(slot: number) {
    const p = this.player(slot);
    if (!p) return;
    this.log('leave', slot);
    this.players = this.players.filter((x) => x !== p);
    this.offAt.delete(slot);
    this.queue = this.queue.filter((x) => x !== slot);
    if (this.running() && this.players.length < 2) return this.finish();
    if (this.drawer === slot && (this.phase === 'pick' || this.phase === 'draw')) return this.endTurn(true);
    this.checkAllGot();
    this.notify();
  }
  markOnline(slot: number, on: boolean) {
    const p = this.player(slot);
    if (!p || p.online === on) return;
    p.online = on;
    if (on) this.offAt.delete(slot);
    else {
      // vừa rớt mạng (hay tải lại trang): chờ một lúc rồi mới tính là vắng
      this.offAt.set(slot, this.clock.now());
      this.clock.after(() => { this.checkAllGot(); }, AWAY_MS);
    }
    if (slot === this.drawer && (this.phase === 'pick' || this.phase === 'draw')) {
      this.stopAway?.(); this.stopAway = null;
      if (!on) this.stopAway = this.clock.after(() => { if (!p.online && this.drawer === slot) this.endTurn(true); }, AWAY_MS);
    }
    this.checkAllGot();
    this.notify();
  }
  private running() { return this.phase === 'pick' || this.phase === 'draw' || this.phase === 'reveal'; }

  setSettings(s: Partial<DGSettings>) {
    if (this.phase !== 'lobby') return;
    if (ROUND_CHOICES.includes(Number(s.rounds))) this.settings.rounds = Number(s.rounds);
    if (TIME_CHOICES.includes(Number(s.seconds))) this.settings.seconds = Number(s.seconds);
    if (s.words === 'vi' || s.words === 'en') this.settings.words = s.words;
    this.notify();
  }
  start(): boolean {
    if (this.phase !== 'lobby' && this.phase !== 'over') return false;
    if (this.onlineCount() < 2) return false;
    for (const p of this.players) Object.assign(p, { score: 0, got: false, gain: 0 });
    this.round = 0; this.turn = 0; this.queue = [];
    this.nextTurn();
    return true;
  }
  private nextTurn() {
    this.clearTimers();
    if (this.onlineCount() < 2) return this.finish();
    let next: DGPlayer | undefined;
    while (!next) {
      if (!this.queue.length) {
        if (this.round >= this.settings.rounds) return this.finish();
        this.round++;
        this.queue = this.players.map((p) => p.slot);
      }
      const p = this.player(this.queue.shift()!);
      if (p?.online) next = p;
    }
    this.drawer = next.slot; this.turn++;
    this.phase = 'pick'; this.word = ''; this.skipped = false; this.shown.clear();
    for (const p of this.players) { p.got = false; p.gain = 0; }
    this.ops = [];
    this.hooks.onOps([], true, -1);
    this.choices = this.draft();
    this.deadline = this.clock.now() + PICK_MS;
    this.after(PICK_MS, () => this.pick(Math.floor(this.rng() * this.choices.length)));
    this.log('turn', this.drawer);
    this.notify();
  }
  private draft(): string[] {
    const all = WORDS[this.settings.words];
    let pool = all.filter((w) => !this.used.has(w));
    if (pool.length < 3) { this.used.clear(); pool = all.slice(); }
    const left = pool.slice(), out: string[] = [];
    while (out.length < 3) out.push(left.splice(Math.floor(this.rng() * left.length), 1)[0]);
    return out;
  }
  private pick(i: number) {
    if (this.phase !== 'pick' || !this.choices[i]) return;
    this.clearTimers();
    this.word = this.choices[i]; this.used.add(this.word); this.choices = [];
    this.phase = 'draw';
    const ms = this.settings.seconds * 1000;
    this.deadline = this.clock.now() + ms;
    this.after(ms, () => this.endTurn(false));
    this.after(ms * 0.5, () => this.hint());
    this.after(ms * 0.75, () => this.hint());
    const p = this.player(this.drawer);
    if (p && !p.online) this.stopAway = this.clock.after(() => this.endTurn(true), AWAY_MS);
    this.notify();
  }
  /** Mở một chữ cái, không bao giờ quá một nửa số chữ. */
  private hint() {
    if (this.phase !== 'draw') return;
    const chars = [...this.word];
    const hidden = chars.map((c, i) => (c !== ' ' && !this.shown.has(i) ? i : -1)).filter((i) => i >= 0);
    const letters = chars.filter((c) => c !== ' ').length;
    if (this.shown.size + 1 > Math.floor(letters / 2)) return;
    this.shown.add(hidden[Math.floor(this.rng() * hidden.length)]);
    this.notify();
  }
  private mask(): string {
    return [...this.word].map((c, i) => (c === ' ' ? ' ' : this.shown.has(i) ? c : '_')).join('');
  }
  private checkAllGot() {
    if (this.phase !== 'draw') return;
    const now = this.clock.now();
    const guessers = this.players.filter((p) => p.slot !== this.drawer && (p.online || p.got || now - (this.offAt.get(p.slot) ?? -1e9) < AWAY_MS));
    if (guessers.length && guessers.every((p) => p.got)) this.endTurn(false);
  }
  private endTurn(skipped: boolean) {
    if (this.phase !== 'pick' && this.phase !== 'draw') return;
    this.clearTimers();
    this.skipped = skipped;
    const drawer = this.player(this.drawer);
    // người vẽ được điểm trung bình của những người đoán
    const others = this.players.filter((p) => p.slot !== this.drawer && (p.online || p.got));
    if (drawer && others.length) {
      drawer.gain = Math.round(others.reduce((s, p) => s + p.gain, 0) / others.length);
      drawer.score += drawer.gain;
    }
    this.phase = 'reveal';
    if (this.word) this.log('word', this.drawer, this.word);
    this.deadline = this.clock.now() + REVEAL_MS;
    this.after(REVEAL_MS, () => this.nextTurn());
    this.notify();
  }
  private finish() {
    this.clearTimers();
    this.phase = 'over'; this.drawer = -1; this.choices = [];
    this.notify();
  }
  backToLobby() {
    if (this.phase !== 'over') return;
    this.phase = 'lobby'; this.word = ''; this.ops = [];
    this.hooks.onOps([], true, -1);
    this.notify();
  }
  dispose() { this.clearTimers(); }

  /** Ý định của một người. Luôn kiểm tra lại, không tin dữ liệu gửi tới. */
  intent(slot: number, p: any): boolean {
    const me = this.player(slot);
    if (!me || !p || typeof p !== 'object') return false;
    switch (p.type) {
      case 'pick':
        if (slot !== this.drawer || this.phase !== 'pick' || !int(p.i, 0, 2)) return false;
        this.pick(p.i);
        return true;
      case 'ops': {
        if (slot !== this.drawer || this.phase !== 'draw' || !Array.isArray(p.ops) || p.ops.length > 40) return false;
        const done: Op[] = [];
        for (const raw of p.ops) {
          const op = cleanOp(raw);
          if (op && applyOp(this.ops, op)) done.push(op);
        }
        if (done.length) this.hooks.onOps(done, false, slot);
        return true;
      }
      case 'say': return this.say(me, p.text);
      case 'skip':
        if (slot !== this.drawer || (this.phase !== 'pick' && this.phase !== 'draw')) return false;
        this.endTurn(true);
        return true;
      default: return false;
    }
  }
  private say(me: DGPlayer, raw: unknown): boolean {
    const text = cleanChat(raw).slice(0, 60);
    if (!text) return false;
    const t = this.clock.now();
    if (t - (this.lastSay.get(me.slot) ?? -1e9) < 500) return false;
    this.lastSay.set(me.slot, t);
    if (this.phase !== 'draw') { this.log('chat', me.slot, text); return true; }
    const inside = [this.drawer, ...this.players.filter((p) => p.got).map((p) => p.slot)];
    if (me.slot === this.drawer || me.got) {
      // người đã biết từ chỉ nói chuyện với nhau
      this.log('secret', me.slot, text, inside);
      return true;
    }
    const verdict = judge(text, this.word);
    if (verdict === 'yes') {
      const left = Math.max(0, this.deadline - t) / (this.settings.seconds * 1000);
      const first = !this.players.some((p) => p.got);
      me.got = true;
      me.gain = 100 + Math.round(200 * left) + (first ? 50 : 0);
      me.score += me.gain;
      this.log('got', me.slot);
      this.checkAllGot();
      if (this.phase === 'draw') this.notify();
      return true;
    }
    if (verdict === 'close') { this.log('close', me.slot, text, [me.slot]); return true; }
    if (leaks(text, this.word)) { this.log('close', me.slot, text, [me.slot]); return true; }
    this.log('chat', me.slot, text);
    return true;
  }

  stateFor(slot: number): DGState {
    const me = this.player(slot);
    const knows = this.phase === 'reveal' || this.phase === 'over' || slot === this.drawer || !!me?.got;
    return {
      game: 'dg', k: 'st', seq: this.seq, code: this.opts.code || '', phase: this.phase, settings: { ...this.settings },
      players: this.players.map((p) => ({ ...p })), mySlot: slot, round: this.round, turn: this.turn, drawer: this.drawer,
      mask: this.word ? this.mask() : '', word: knows ? this.word : '',
      choices: slot === this.drawer && this.phase === 'pick' ? this.choices.slice() : [],
      ms: this.deadline ? Math.max(0, this.deadline - this.clock.now()) : null, skipped: this.skipped,
    };
  }
}
