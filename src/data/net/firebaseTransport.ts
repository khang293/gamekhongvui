// Truyền tin qua Firebase Realtime Database (đường web thông thường, nên chơi được trên mọi mạng mở được web,
// không cần hai máy nối trực tiếp như trước). Cấu trúc dữ liệu:
//   peers/<id>            {uid, ts}   mỗi máy đang trực tuyến (chủ phòng: id = gkv-MÃ)
//   links/<chủ>/<khách>   {u}         khách đang ở trong phòng của chủ
//   inbox/<id>/<khóa>     {f, d}      tin nhắn gửi tới <id>; chỉ chủ nhân <id> đọc được, đọc xong thì xóa
// Quy tắc bảo mật (database.rules.json) bảo đảm bài của ai chỉ máy đó đọc được và không giả mạo được người gửi.
import { TransportError, type Transport } from './transport';
import { firebaseConfig } from './firebaseConfig';

type FB = { db: any; uid: string; m: typeof import('firebase/database') };
let ready: Promise<FB> | null = null;

// Một app + một lần đăng nhập ẩn danh cho cả trang (tạo lại transport khi nối lại không đăng nhập lại)
function firebase(): Promise<FB> {
  if (!ready) {
    ready = (async () => {
      const [{ initializeApp }, auth, m] = await Promise.all([import('firebase/app'), import('firebase/auth'), import('firebase/database')]);
      const app = initializeApp(firebaseConfig);
      const cred = await auth.signInAnonymously(auth.getAuth(app));
      return { db: m.getDatabase(app), uid: cred.user.uid, m };
    })();
    ready.catch(() => { ready = null; });
  }
  return ready;
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new TransportError('timeout')), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
const randomId = () => 'c-' + Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => b.toString(16).padStart(2, '0')).join('');
const STALE_MS = 86400000;

export class FirebaseTransport implements Transport {
  id = '';
  private fb: FB | null = null;
  private closed = false;
  private peers = new Set<string>();      // các máy đang nối với mình
  private stops: (() => void)[] = [];     // hủy các bộ lắng nghe
  private hostId = '';                    // chỉ có ở phía khách
  private isHost = false;
  private msgCbs: ((from: string, data: string) => void)[] = [];
  private joinCbs: ((p: string) => void)[] = [];
  private leaveCbs: ((p: string) => void)[] = [];
  private queued: [string, string][] = []; // tin tới trước khi game kịp đăng ký nhận

  private ref(path: string) { return this.fb!.m.ref(this.fb!.db, path); }

  async open(wantedId?: string): Promise<string> {
    try {
      this.fb = await withTimeout(firebase(), 15000);
      const { m, uid } = this.fb;
      const id = wantedId || randomId();
      const peerRef = this.ref('peers/' + id);
      if (wantedId) {
        const cur = (await withTimeout(m.get(peerRef), 12000)).val();
        if (cur && cur.uid !== uid && Date.now() - cur.ts < STALE_MS) throw new TransportError('unavailable-id');
      }
      this.id = id;
      this.isHost = !!wantedId;
      await this.register();
      // mạng chập chờn: Firebase tự xóa bản ghi khi mất kết nối, nên có mạng lại thì đăng ký lại
      let first = true;
      this.stops.push(m.onValue(this.ref('.info/connected'), (s) => {
        if (first) { first = false; return; }
        if (s.val() === true && !this.closed) this.register().catch(() => {});
      }));
      this.stops.push(m.onChildAdded(this.ref('inbox/' + id), (s) => {
        const v = s.val();
        m.remove(s.ref).catch(() => {});
        if (!v || typeof v.f !== 'string' || typeof v.d !== 'string' || this.closed) return;
        if (this.msgCbs.length) this.msgCbs.forEach((cb) => cb(v.f, v.d)); else this.queued.push([v.f, v.d]);
      }));
      if (this.isHost) {
        this.stops.push(m.onChildAdded(this.ref('links/' + id), (s) => { const p = s.key as string; if (!this.peers.has(p)) { this.peers.add(p); this.joinCbs.forEach((cb) => cb(p)); } }));
        this.stops.push(m.onChildRemoved(this.ref('links/' + id), (s) => this.gone(s.key as string)));
      }
      return id;
    } catch (e) {
      if (e instanceof TransportError) throw e;
      throw new TransportError('network', String((e as any)?.code || (e as any)?.message || e));
    }
  }

  private async register(): Promise<void> {
    const { m, uid } = this.fb!;
    const inbox = this.ref('inbox/' + this.id), peer = this.ref('peers/' + this.id);
    await withTimeout(m.set(peer, { uid, ts: m.serverTimestamp() }), 12000);
    // thứ tự quan trọng: dọn hộp thư (và danh sách khách) trước, xóa đăng ký sau, vì quyền dọn dựa vào đăng ký
    await m.onDisconnect(inbox).remove();
    if (this.isHost) await m.onDisconnect(this.ref('links/' + this.id)).remove();
    if (this.hostId) {
      const link = this.ref(`links/${this.hostId}/${this.id}`);
      await m.set(link, { u: uid }).catch(() => {}); // tạo trước: quyền "tự xóa" được kiểm trên bản ghi đang có
      await m.onDisconnect(link).remove().catch(() => {});
    }
    await m.onDisconnect(peer).remove();
  }

  async connect(peerId: string, timeoutMs = 12000): Promise<void> {
    if (!this.fb || this.closed) throw new TransportError('closed');
    const { m, uid } = this.fb;
    try {
      const host = (await withTimeout(m.get(this.ref('peers/' + peerId)), timeoutMs)).val();
      if (!host) throw new TransportError('no-peer');
      this.hostId = peerId;
      const link = this.ref(`links/${peerId}/${this.id}`);
      await withTimeout(m.set(link, { u: uid }), timeoutMs);
      await m.onDisconnect(link).remove();
      this.peers.add(peerId);
      // chủ phòng biến mất: chờ vài giây (mạng chập chờn), không quay lại thì coi như đã rời
      let timer: ReturnType<typeof setTimeout> | null = null;
      this.stops.push(m.onValue(this.ref('peers/' + peerId), (s) => {
        if (s.exists()) { if (timer) { clearTimeout(timer); timer = null; } return; }
        if (!timer) timer = setTimeout(() => this.gone(peerId), 6000);
      }));
      this.stops.push(() => { if (timer) clearTimeout(timer); });
    } catch (e) {
      if (e instanceof TransportError) throw e;
      throw new TransportError('network', String((e as any)?.code || e));
    }
  }

  private gone(peerId: string) {
    if (this.closed || !this.peers.delete(peerId)) return;
    this.leaveCbs.forEach((cb) => cb(peerId));
  }

  send(peerId: string, data: string) {
    if (!this.fb || this.closed || !this.peers.has(peerId)) return;
    const { m } = this.fb;
    m.set(m.push(this.ref('inbox/' + peerId)), { f: this.id, d: data }).catch(() => {});
  }
  onMessage(cb: (from: string, data: string) => void) {
    this.msgCbs.push(cb);
    const q = this.queued.splice(0);
    for (const [f, d] of q) cb(f, d);
  }
  onPeerJoin(cb: (p: string) => void) { this.joinCbs.push(cb); for (const p of this.peers) if (this.isHost) cb(p); }
  onPeerLeave(cb: (p: string) => void) { this.leaveCbs.push(cb); }

  disconnect(peerId: string) {
    if (!this.fb || !this.peers.has(peerId)) return;
    const path = this.isHost ? `links/${this.id}/${peerId}` : `links/${peerId}/${this.id}`;
    this.fb.m.remove(this.ref(path)).catch(() => {});
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const s of this.stops.splice(0)) { try { s(); } catch {} }
    this.peers.clear();
    if (!this.fb || !this.id) return;
    const { m } = this.fb;
    const inbox = this.ref('inbox/' + this.id), peer = this.ref('peers/' + this.id);
    const jobs: Promise<unknown>[] = [m.remove(inbox)];
    if (this.hostId) jobs.push(m.remove(this.ref(`links/${this.hostId}/${this.id}`)));
    if (this.isHost) jobs.push(m.remove(this.ref('links/' + this.id)));
    Promise.allSettled(jobs).then(async () => {
      await m.onDisconnect(inbox).cancel().catch(() => {});
      await m.onDisconnect(peer).cancel().catch(() => {});
      await m.remove(peer).catch(() => {});
    });
  }
}
