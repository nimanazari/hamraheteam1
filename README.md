# برنامه هفتگی مدارس

## اجرا (لوکال)
```
npm install
npm start
```
مرورگر: http://localhost:3000 — ورود مدیر: `admin` / `admin` (از تنظیمات عوض کنید)

## انتقال به سرور
پیش‌نیاز: Node 22 یا بالاتر (به خاطر SQLite داخلی Node). داده‌ها فقط در `data/app.db` هستند.

**روش ۱: pm2 (ساده‌ترین)**
```
npm install --omit=dev
npm i -g pm2
pm2 start ecosystem.config.js
pm2 save && pm2 startup
```
**روش ۲: Docker**
```
docker compose up -d
```
سپس nginx را با `nginx.example.conf` روی دامنه پروکسی کنید و با certbot گواهی HTTPS بگیرید. اگر HTTPS دارید کوکی خودکار Secure می‌شود.

پشتیبان‌گیری: فقط `data/app.db` را کپی کنید.

## سرور فعلی (hamraheteam.ir)
- مسیر: `/opt/barname-madrese` · سرویس: `systemctl status barname-madrese` · پورت داخلی 5920
- nginx: `/etc/nginx/sites-enabled/hamraheteam` · SSL: Let's Encrypt (تمدید خودکار certbot)
- دیتابیس: `/opt/barname-madrese/data/app.db` (بک‌آپ = کپی همین فایل)
- آپدیت کد: `bash deploy.sh` از همین پوشه
- لاگ: `journalctl -u barname-madrese -f`
