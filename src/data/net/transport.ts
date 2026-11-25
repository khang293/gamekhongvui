// Lớp truyền tin trừu tượng cho phòng chơi online. Có hai bản cài đặt:
//  - firebaseTransport.ts: qua Firebase Realtime Database của Google (chơi được trên mọi mạng mở được web)
//  - loopbackTransport.ts: trong bộ nhớ, dùng cho bài thử và #debug (không cần mạng)
// Phòng (room.ts) và game (tienlenNet.ts) chỉ biết giao diện Transport này nên poker cũng dùng lại được.

export interface Transport {
  /** id của mình trên mạng sau khi mở xong */
  readonly id: string;
  /** Mở kết nối tới máy chủ báo hiệu. Chủ phòng truyền id cố định (gkv-MÃ), khách để trống. Trả về id thật. */
  open(wantedId?: string): Promise<string>;
  /** Khách nối tới chủ phòng. Reject nếu không có phòng hoặc quá hạn. */
  connect(peerId: string, timeoutMs?: number): Promise<void>;
  /** Gửi một chuỗi tới một máy đã nối. Không ném lỗi nếu máy đó đã đi. */
  send(peerId: string, data: string): void;
  onMessage(cb: (from: string, data: string) => void): void;
  onPeerJoin(cb: (peerId: string) => void): void;
  onPeerLeave(cb: (peerId: string) => void): void;
  /** Ngắt một máy cụ thể (đá khỏi phòng) */
  disconnect(peerId: string): void;
  close(): void;
}

export class TransportError extends Error {
  constructor(public code: 'unavailable-id' | 'no-peer' | 'timeout' | 'network' | 'closed', msg?: string) { super(msg || code); }
}
