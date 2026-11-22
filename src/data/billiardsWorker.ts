// Chạy máy bida trong Web Worker để trang không bị đứng khi máy nghĩ.
import { chooseShot, type Job } from './billiardsAI';

self.onmessage = (e: MessageEvent) => {
  const { id, job } = e.data as { id: number; job: Job };
  (self as unknown as Worker).postMessage({ id, shot: chooseShot(job) });
};
