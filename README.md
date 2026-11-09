# دستیار پروژه سامان / Saman Project Assistant

افزونه Chrome و Edge برای دانلود یک‌جای اسناد، اطلاعات و تصویر صفحه یک پروژه در سامانه سامان (`saman.fceo.ir`) و کم‌حجم کردن خودکار عکس‌ها پیش از آپلود.

A Chrome / Edge (Manifest V3) extension that downloads a Saman project's documents, form data and a page screenshot in one click, and shrinks images automatically before they are uploaded.

## امکانات
- دانلود فایل‌های همه تب‌های اسناد (تصویر، pdf، zip، dwg و ...) با باز کردن خودکار تب‌ها
- ذخیره در `Downloads/Saman/<نام مالک>/<نام تب>/`
- ذخیره اطلاعات فرم در فایل متنی و اسکرین‌شات بخش اطلاعات
- گزارش پایان کار و لینک باز کردن پوشه
- کم‌حجم کردن خودکار عکس‌ها هنگام انتخاب فایل یا کشیدن و رها کردن در سامانه سامان (حجم هدف پیش‌فرض ۳۰۰ کیلوبایت، قابل تغییر و خاموش کردن از popup)؛ GIF، SVG و فایل‌های غیرتصویری دست‌نخورده می‌مانند

## نصب (Load unpacked)
1. آخرین `saman-downloader.zip` را از [Releases](../../releases/latest) بگیرید و در یک پوشه ثابت extract کنید.
2. در Chrome یا Edge آدرس `chrome://extensions` را باز و **Developer mode** را روشن کنید.
3. **Load unpacked** را بزنید و پوشه را انتخاب کنید.
4. وارد `saman.fceo.ir` شوید، صفحه اطلاعات پروژه را باز کنید و روی آیکون افزونه بزنید.

## ساخت بسته انتشار
```
zip -r saman-downloader.zip manifest.json popup.html popup.js settings.js compress.js style.css fonts icons _locales
```
سپس در GitHub یک Release جدید (مثلاً `v4.0.0`) بسازید و فایل zip را به آن پیوست کنید.

## مجوزها
`activeTab`، `scripting`، `downloads`، `downloads.ui`، `storage` (ذخیره تنظیمات فشرده‌سازی) و دسترسی به `saman.fceo.ir`. فشرده‌سازی کاملاً داخل مرورگر انجام می‌شود و عکس به جایی ارسال نمی‌شود. افزونه هیچ داده‌ای جمع‌آوری یا ارسال نمی‌کند ([سیاست حریم خصوصی](site/privacy.html)).

## سازنده
حجت جمال‌خواه (Hojjat Jamalkhah) — [jamalkhah.ir](https://jamalkhah.ir) — jamalkhah@gmail.com

لایسنس: MIT
