# gamekhongvui

Kho trò chơi chạy trong trình duyệt (Astro, trang tĩnh). Địa chỉ: https://khang293.github.io/gamekhongvui/

- Tiếng Việt ở gốc, tiếng Anh ở `/en/`.
- Mỗi game là một trang trong `src/components/pages/*Page.astro`, dữ liệu và máy đánh ở `src/data/`.
- Mọi đường dẫn nội bộ đi qua `lp()` trong `src/i18n.ts` để tự thêm tiền tố `/gamekhongvui`. Đổi `base` trong `astro.config.mjs` nếu dùng tên miền riêng.
- Tất cả trang đặt `noindex`, không có sitemap.
- Chạy thử: `npm install` rồi `npm run dev`. Build: `npm run build`.
- Deploy: đẩy lên nhánh `main`, GitHub Actions tự build và đăng lên GitHub Pages (Settings → Pages → Source: GitHub Actions).
