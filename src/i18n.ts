// Ngôn ngữ và đường dẫn cho site game. Mọi đường dẫn nội bộ đi qua lp() để tự thêm tiền tố base (/gamekhongvui) và /en.
export const languages = { vi: 'Tiếng Việt', en: 'English' } as const;
export type Lang = keyof typeof languages;

// Tiền tố base của site, không có dấu / ở cuối ('' nếu site chạy ở gốc tên miền)
const BASE = (import.meta.env.BASE_URL || '/').replace(/\/+$/, '');

export const withBase = (p: string) => BASE + (p.startsWith('/') ? p : `/${p}`);

export const lp = (lang: Lang, path: string) => {
  const p = path.startsWith('/') ? path : `/${path}`;
  return withBase(lang === 'en' ? `/en${p}` : p);
};

// Bỏ tiền tố base khỏi một pathname
export const stripBase = (pathname: string) => (BASE && (pathname === BASE || pathname.startsWith(BASE + '/')) ? pathname.slice(BASE.length) || '/' : pathname);

export function getLang(url: URL): Lang {
  const p = stripBase(url.pathname);
  return p === '/en' || p.startsWith('/en/') ? 'en' : 'vi';
}

// Đường dẫn tương ứng ở ngôn ngữ còn lại
export function altPath(pathname: string, lang: Lang): string {
  const bare = stripBase(pathname);
  const noLang = lang === 'en' ? bare.replace(/^\/en/, '') || '/' : bare;
  return lp(lang === 'en' ? 'vi' : 'en', noLang);
}

export const ui = {
  vi: {
    locale: 'vi-VN',
    themeToggle: 'Chuyển giao diện sáng hoặc tối',
    privacy: 'Chính sách quyền riêng tư',
    portfolio: 'Hồ sơ của Khang',
    sideProject: 'Trang này là dự án làm cho vui của mình, các trò chơi miễn phí và không dùng tiền thật.',
    description: 'Kho trò chơi miễn phí chạy ngay trên trình duyệt: cờ vua, cờ tướng, caro, bida, đua xe, thủ thành và nhiều game khác.',
    nav: { contact: 'Liên hệ' },
  },
  en: {
    locale: 'en-US',
    themeToggle: 'Switch between light and dark theme',
    privacy: 'Privacy policy',
    portfolio: "Khang's portfolio",
    sideProject: 'This site is a fun side project of mine. The games are free and use no real money.',
    description: 'A free collection of games that run right in your browser: chess, xiangqi, caro, billiards, racing, tower defense and more.',
    nav: { contact: 'Contact' },
  },
};
