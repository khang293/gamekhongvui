// Đang ở trong phòng mà đóng tab, tải lại hay chuyển trang thì trình duyệt hỏi lại trước.
// Câu hỏi do trình duyệt tự viết; iPhone thường không hiện, nên nút rời phòng trong game vẫn phải tự hỏi.
export function guardLeave(inRoom: () => boolean) {
  keepAwake(inRoom);
  window.addEventListener('beforeunload', (e) => {
    if (!inRoom()) return;
    e.preventDefault();
    e.returnValue = '';
  });
}

// Đang ở trong phòng thì xin điện thoại đừng tự tắt màn hình (Screen Wake Lock).
// Trình duyệt tự hủy quyền này khi chuyển app, nên quay lại thì xin lại. Máy không hỗ trợ thì bỏ qua.
function keepAwake(inRoom: () => boolean) {
  const wl = (navigator as any).wakeLock;
  if (!wl) return;
  let lock: any = null, asking = false;
  const sync = async () => {
    const want = inRoom() && document.visibilityState === 'visible';
    if (want && (!lock || lock.released) && !asking) {
      asking = true;
      try { lock = await wl.request('screen'); } catch { lock = null; } // tiết kiệm pin có thể từ chối
      asking = false;
    } else if (!want && lock) {
      const old = lock; lock = null;
      old.release().catch(() => {});
    }
  };
  setInterval(sync, 2000);
  document.addEventListener('visibilitychange', sync);
}
