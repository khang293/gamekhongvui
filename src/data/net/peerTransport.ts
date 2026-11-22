// Truyền tin thật: kết nối trực tiếp giữa các trình duyệt (WebRTC) qua thư viện PeerJS.
// Máy chủ báo hiệu công cộng của PeerJS chỉ dùng để hai máy tìm thấy nhau; sau đó dữ liệu đi thẳng giữa các máy.
import { TransportError, type Transport } from './transport';

type PeerCtor = new (id?: string, opts?: any) => any;

export class PeerTransport implements Transport {
  id = '';
  private peer: any = null;
  private conns = new Map<string, any>();
  private msgCbs: ((from: string, data: string) => void)[] = [];
  private joinCbs: ((p: string) => void)[] = [];
  private leaveCbs: ((p: string) => void)[] = [];
  private closed = false;

  async open(wantedId?: string): Promise<string> {
    const mod: any = await import('peerjs');
    const Peer: PeerCtor = mod.Peer || mod.default;
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const peer = new Peer(wantedId, { debug: 0 });
      this.peer = peer;
      const timer = setTimeout(() => { if (!settled) { settled = true; try { peer.destroy(); } catch {} reject(new TransportError('timeout', 'signaling timeout')); } }, 12000);
      peer.on('open', (id: string) => { if (settled) return; settled = true; clearTimeout(timer); this.id = id; resolve(id); });
      peer.on('error', (e: any) => {
        const type = String(e?.type || '');
        if (!settled) {
          settled = true; clearTimeout(timer);
          reject(new TransportError(type === 'unavailable-id' ? 'unavailable-id' : 'network', type));
        }
      });
      peer.on('connection', (conn: any) => this.wire(conn));
      peer.on('disconnected', () => { /* máy chủ báo hiệu rớt: kết nối đã mở vẫn còn dùng được */ });
    });
  }

  private wire(conn: any) {
    const id: string = conn.peer;
    const onOpen = () => {
      this.conns.set(id, conn);
      this.joinCbs.forEach((cb) => cb(id));
    };
    if (conn.open) onOpen(); else conn.on('open', onOpen);
    conn.on('data', (d: unknown) => { if (typeof d === 'string') this.msgCbs.forEach((cb) => cb(id, d)); });
    const gone = () => { if (this.conns.get(id) === conn) { this.conns.delete(id); this.leaveCbs.forEach((cb) => cb(id)); } };
    conn.on('close', gone);
    conn.on('error', gone);
  }

  connect(peerId: string, timeoutMs = 12000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.peer || this.closed) { reject(new TransportError('closed')); return; }
      let settled = false;
      const conn = this.peer.connect(peerId, { reliable: true });
      const fail = (code: TransportError['code']) => { if (settled) return; settled = true; clearTimeout(timer); try { conn.close(); } catch {} reject(new TransportError(code)); };
      const timer = setTimeout(() => fail('timeout'), timeoutMs);
      const onPeerErr = (e: any) => { if (String(e?.type) === 'peer-unavailable') fail('no-peer'); };
      this.peer.on('error', onPeerErr);
      conn.on('open', () => {
        if (settled) return; settled = true; clearTimeout(timer);
        try { this.peer.off('error', onPeerErr); } catch {}
        this.wire(conn);
        resolve();
      });
      conn.on('error', () => fail('network'));
    });
  }

  send(peerId: string, data: string) {
    const c = this.conns.get(peerId);
    if (c && c.open) { try { c.send(data); } catch {} }
  }
  onMessage(cb: (from: string, data: string) => void) { this.msgCbs.push(cb); }
  onPeerJoin(cb: (p: string) => void) { this.joinCbs.push(cb); }
  onPeerLeave(cb: (p: string) => void) { this.leaveCbs.push(cb); }
  disconnect(peerId: string) { const c = this.conns.get(peerId); if (c) { try { c.close(); } catch {} } }
  close() {
    this.closed = true;
    for (const c of this.conns.values()) { try { c.close(); } catch {} }
    this.conns.clear();
    try { this.peer?.destroy(); } catch {}
  }
}
