import { defineConfig } from 'astro/config';

// Site game chạy ở https://khang293.github.io/gamekhongvui/ (repo khang293/gamekhongvui).
// Nếu sau này dùng tên miền riêng, đổi site và bỏ base.
export default defineConfig({
  site: 'https://khang293.github.io',
  base: '/gamekhongvui',
  trailingSlash: 'always',
  devToolbar: { enabled: false },
  i18n: {
    defaultLocale: 'vi',
    locales: ['vi', 'en'],
    routing: { prefixDefaultLocale: false },
  },
});
