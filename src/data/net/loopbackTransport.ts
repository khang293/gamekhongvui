// Truyền tin trong bộ nhớ cho bài thử và chế độ #debug. Giả lập: mở id, nối, gửi, rớt mạng (drop), đóng.
import { TransportError, type Transport } from './transport';

type Handler<T> = (a: T, b: string) => void;

export class LoopbackHub {
  nodes = new Map<string, LoopbackTransport>();
  private seq = 0;
  /** Tạo một nút mới. Gọi open() trên nút để đăng ký id. */
  create(): LoopbackTransport { return new LoopbackTransport(this); }
  nextId() { return 'lb' + (++this.seq) + '-' + Math.floor(Math.random() * 1e6).toString(36); }
}

export class LoopbackTransport implements Transport {
  id = '';
  private opened = false;
  private closed = false;
  links = new Set<string>(); // các nút đang nối với nút này
  private msgCbs: Handler<string>[] = [];
  private joinCbs: ((p: string) => void)[] = [];
  private leaveCbs: ((p: string) => void)[] = [];
  /** Giả lập mạng chậm: số lần gọi tiếp theo bị bỏ (cho bài thử) */
  dropOutgoing = false;
  constructor(private hub: LoopbackHub) {}

  async open(wantedId?: string): Promise<string> {
    if (this.closed) throw new TransportError('closed');
    const id = wantedId || this.hub.nextId();
    if (this.hub.nodes.has(id)) throw new TransportError('unavailable-id');
    this.id = id; this.opened = true;
    this.hub.nodes.set(id, this);
    return id;
  }
  async connect(peerId: string): Promise<void> {
    if (!this.opened || this.closed) throw new TransportError('closed');
    const other = this.hub.nodes.get(peerId);
    if (!other || other.closed) throw new TransportError('no-peer');
    this.links.add(peerId); other.links.add(this.id);
    await Promise.resolve();
    other.joinCbs.forEach((cb) => cb(this.id));
  }
  send(peerId: string, data: string) {
    if (this.dropOutgoing || this.closed) return;
    if (!this.links.has(peerId)) return;
    const other = this.hub.nodes.get(peerId);
    if (!other || other.closed || !other.links.has(this.id)) return;
    // gửi bất đồng bộ như mạng thật
    Promise.resolve().then(() => { if (other.links.has(this.id)) other.msgCbs.forEach((cb) => cb(this.id, data)); });
  }
  onMessage(cb: (from: string, data: string) => void) { this.msgCbs.push(cb); }
  onPeerJoin(cb: (p: string) => void) { this.joinCbs.push(cb); }
  onPeerLeave(cb: (p: string) => void) { this.leaveCbs.push(cb); }
  disconnect(peerId: string) { this.cut(peerId); }
  /** Rớt mạng: cắt mọi kết nối nhưng nút vẫn sống (có thể nối lại) */
  dropAll() { for (const p of [...this.links]) this.cut(p); }
  private cut(peerId: string) {
    if (!this.links.has(peerId)) return;
    this.links.delete(peerId);
    const other = this.hub.nodes.get(peerId);
    this.leaveCbs.forEach((cb) => cb(peerId));
    if (other && other.links.has(this.id)) { other.links.delete(this.id); other.leaveCbs.forEach((cb) => cb(this.id)); }
  }
  close() {
    if (this.closed) return;
    this.dropAll();
    this.closed = true;
    this.hub.nodes.delete(this.id);
  }
}
