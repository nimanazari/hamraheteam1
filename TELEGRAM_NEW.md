# تلگرام از داخلِ ایران — الگوی «دو رله با سوییچِ خودکار»

> این سند **قابلِ حمل** است: مالِ هیچ پروژه‌ی خاصی نیست. هر جا لازم شد از یک
> سرورِ ایران به `api.telegram.org` وصل شوی، همین را بردار و پیاده کن.
> **هیچ سکرتی اینجا نیست** (توکن، رمزِ رله، مسیرِ رله) — همه در ENV/تنظیمات.
>
> این نسخه‌ی تازه‌شده‌ی `TELEGRAM.md` است: آن یکی یک رله داشت، این یکی **دو تا**
> با سوییچِ خودکار — چیزی که در عمل به آن رسیدیم.

---

## ۱. چرا اصلاً رله؟ و چرا **دو** تا؟

`api.telegram.org` از ایران بلاک است. پس سرورِ ایران مستقیم حرف نمی‌زند؛ یک فایلِ
کوچکِ PHP روی هاستِ خارج واسطه می‌شود (هیچ دیتایی ذخیره نمی‌کند، فقط رد می‌کند).

با **یک** رله تجربه‌ی واقعی این شد:
- هاستِ اشتراکی (cPanel) گاهی چند دقیقه می‌خوابد یا PHPش ری‌استارت می‌شود؛
- مسیرِ ایران→اروپا در ساعت‌هایی تا ۲۰٪ **packet loss** می‌دهد؛
- گاهی خودِ آن IP برای چند ساعت فیلتر می‌شود.

هر کدام یعنی **ربات کر می‌شود** — نه پیام می‌فرستد نه می‌گیرد. راهِ حل: دو رله روی
دو زیرساختِ مستقل (مثلاً یکی cPanelِ اشتراکی، یکی VPSِ آلمان) و سوییچِ خودکار.

```
                 ┌──► رله‌ی ۲ (VPS، Caddy+PHP)  ──┐
پنلِ ایران ──────┤   (اولویتِ اول)                ├──► api.telegram.org
                 └──► رله‌ی ۱ (cPanel اشتراکی)  ──┘
                     (پشتیبان)
```

---

## ۲. چهار درسی که گران درآمد

### ۲.۱ TLS 1.3 را فیلترینگ می‌کُشد — با ≤ 1.2 وصل شو
اندازه‌گیریِ واقعی روی همان IP: با TLS1.3 → timeout؛ با TLS1.2 → ۰٫۸ ثانیه.
علتش ClientHelloِ رمزشده‌ی TLS1.3 است (SNI دیده نمی‌شود، سیستمِ فیلترینگ می‌بندد).

```python
ctx = ssl.create_default_context()
ctx.maximum_version = ssl.TLSVersion.TLSv1_2   # ← حیاتی
```

### ۲.۲ به IP وصل شو، ولی SNI را **دامنه** بگذار
اگر دامنه‌ات DNSش به سرورِ ایران اشاره می‌کند (یا DNS سینک‌هول شده)، باید مستقیم
به IPِ رله وصل شوی. ولی اگر سوکت را با IP باز کنی و `server_hostname` هم IP بدهی،
سرور (Caddy/nginx) گواهی را پیدا نمی‌کند → `tlsv1 alert internal error`.
**اتصال به IP، SNI و هدرِ Host = دامنه.**

```python
raw = socket.create_connection((relay_ip or host, 443), timeout=connect_timeout)
conn.sock = ctx.wrap_socket(raw, server_hostname=host)   # ← دامنه، نه IP
```

### ۲.۳ تایم‌اوتِ اتصال کوتاه، تایم‌اوتِ خواندن بلند
اگر لوله بسته باشد باید **سریع** بفهمی و بروی سراغِ رله‌ی بعدی؛ ولی `getUpdates`ِ
long-poll ذاتاً ۲۰ ثانیه طول می‌کشد. پس این دو را جدا کن:
`connect_timeout≈3–4s`، `http_timeout≈25s`.

### ۲.۴ خطای «لوله» با خطای «منطقی» فرق دارد
- timeout / connection refused / OSError → **لوله** بسته است → همان لحظه رله‌ی بعدی.
- `ok:false` با `error_code` (مثلاً chat not found) → **منطقی** است → همان را
  برگردان؛ عوض‌کردنِ رله هیچ کمکی نمی‌کند و فقط وقت می‌سوزاند.

---

## ۳. قلبِ ماجرا: تابعِ `post()` با سوییچ و حافظه

قواعد:
1. رله‌ها به ترتیبِ اولویت؛ هر رله حداکثر ۲ تلاشِ کوتاه.
2. خطای اتصال → **بدونِ تلاشِ دوم** سراغِ رله‌ی بعدی.
3. رله‌ای که شکست خورد، ۹۰ ثانیه «مرده» علامت می‌خورد تا درخواست‌های بعدی اول
   از رله‌ی سالم بروند (وگرنه هر پیام دوباره ۳ ثانیه پشتِ رله‌ی مرده می‌ماند).
4. اولین جوابِ معتبر → رله از حالتِ «مرده» درمی‌آید.

```python
_BAD = {}        # name → تا کِی مرده فرض شود (epoch)
BAD_FOR = 90

def post(payload, http_timeout=25, connect_timeout=3, tries_per_relay=2):
    body = json.dumps(payload).encode('utf-8')
    now = time.time()
    order = sorted(relays(), key=lambda r: 1 if _BAD.get(r['name'], 0) > now else 0)
    last = None
    for relay in order:
        for attempt in range(tries_per_relay):
            try:
                res = _one(relay, body, http_timeout, connect_timeout)
                if isinstance(res, dict) and (res.get('ok') or 'error_code' in res
                                              or 'tg_error' in res or 'http_code' in res):
                    _BAD.pop(relay['name'], None)
                    return res
                last = res
            except (TimeoutError, ConnectionError, OSError) as e:
                last = e
                break                      # لوله بسته — رله‌ی بعدی
            except Exception as e:
                last = e
            if attempt + 1 < tries_per_relay:
                time.sleep(0.3)
        _BAD[relay['name']] = time.time() + BAD_FOR
        log.warning('[RELAY] %s جواب نداد (%s) — رله‌ی بعدی', relay['name'], str(last)[:120])
    return last if isinstance(last, dict) else None
```

پیاده‌سازیِ کاملِ آماده‌ی کپی: [services/relay.py](services/relay.py) — همه‌ی
فرستنده‌ها باید فقط از `relay.post()` رد شوند، نه مستقیم از سوکت.

---

## ۴. پیکربندی — رله‌ی ۱ در ENV، رله‌ی ۲ در دیتابیس

یک نکته‌ی عملی که خیلی به کار آمد: **رله‌ی دوم را در ENV نگذار.** عوض‌کردنِ ENV یعنی
`docker compose up -d` و recreate؛ وسطِ قطعی این آخرین کاری است که دلت می‌خواهد
بکنی. رله‌ی دوم را در جدولِ تنظیماتِ خودِ اپ (`AppSetting`) بگذار تا **از داخلِ پنل،
بدونِ ری‌استارت** بتوانی عوضش کنی یا خاموشش کنی.

| کلید | جا | کارش |
|---|---|---|
| `TELEGRAM_RELAY_URL` / `_SECRET` / `_IP` / `_INSECURE` | ENV | رله‌ی ۱ (پشتیبان) |
| `relay2.url` / `.secret` / `.ip` / `.insecure` / `.enabled` | تنظیماتِ اپ | رله‌ی ۲ (اولویتِ اول) |
| `TELEGRAM_BOT_TOKEN` | ENV | توکنِ ربات — رله به توکن کار ندارد |

فهرستِ رله‌ها ۶۰ ثانیه کَش می‌شود؛ یعنی تغییرِ تنظیمات حداکثر یک دقیقه بعد اثر
می‌کند، بدونِ ری‌استارت. `relay2.enabled = 0` یعنی موقتاً فقط رله‌ی ۱.

---

## ۵. خودِ رله (PHP) — امنیت و منطق

فایلِ آماده: [deploy/telegram-relay/tg-relay.php](deploy/telegram-relay/tg-relay.php).
همان فایل روی هر دو رله می‌نشیند (فقط `RELAY_SECRET`ها فرق دارند). قواعدش:

- **هدرِ `X-Relay-Secret` با `hash_equals`** (مقایسه‌ی زمان‌ثابت) — بدونش ۴۰۳. پس
  کسی نمی‌تواند رله‌ات را برای اسپم اجاره کند.
- **whitelistِ متدها** — نه هرچه Bot API دارد. الان: `sendMessage`, `getUpdates`,
  `answerCallbackQuery`, `editMessageText`, `editMessageReplyMarkup`,
  `sendDocument`, `sendPhoto`.
- **فایل هرگز از رله رد نمی‌شود** — `sendDocument` فقط URLِ https می‌پذیرد و
  `sendPhoto` فقط `file_id` یا URL. خودِ تلگرام می‌رود برمی‌دارد. (برای بکاپ:
  لینکِ امضاشده‌ی موقتِ خودِ پنل.)
- **قالبِ توکن regex می‌شود** (`^\d{6,15}:[A-Za-z0-9_\-]{25,}$`) تا کسی با توکنِ
  ساختگی مسیرِ URL را تزریق نکند.
- توکن در هیچ لاگی نوشته نمی‌شود؛ توکن را **فرستنده** می‌دهد نه رله — پس چند
  پروژه/چند ربات می‌توانند از یک رله رد شوند.
- تایم‌اوتِ cURL برای `getUpdates` باید از `timeout`ِ خودِ تلگرام بیشتر باشد
  (وگرنه long-poll همیشه قطع می‌شود): `timeout + 10`.
- تستِ سلامت بدونِ سکرت: `?ping=1` → `{"ok":true,"telegram_reachable":true}`.
  اگر `false` داد، آن هاست هم فیلتر است و به درد نمی‌خورد — **قبل از خریدن تست کن.**

### راه‌اندازیِ رله‌ی دوم (VPS، ۱۰ دقیقه)
```bash
apt install -y php-fpm php-curl caddy
mkdir -p /var/www/relay/<پوشه-غیرقابل-حدس>
```
فایلِ `tg-relay.php` را داخلِ آن پوشه بگذار و `RELAY_SECRET` داخلش را به یک رشته‌ی
تصادفیِ بلند عوض کن. `Caddyfile`:

```
relay2.example.com {
    root * /var/www/relay
    php_fastcgi unix//run/php/php8.2-fpm.sock
    file_server
}
```

```bash
curl -s "https://relay2.example.com/<پوشه>/tg-relay.php?ping=1"
```
بعد `relay2.*` را در تنظیماتِ پنل پر کن — تمام، بدونِ ری‌استارت.

---

## ۶. چطور این را به پروژه‌ی دیگری ببری

1. `services/relay.py` را کپی کن؛ فقط منبعِ تنظیماتش (`services.settings.get`) را
   با هرچه آن پروژه دارد عوض کن.
2. `tg-relay.php` را روی **همان دو رله**ی موجود بگذار — لازم نیست رله‌ی تازه بخری.
   رله به توکن کار ندارد، پس پروژه‌ی جدید با **توکنِ رباتِ خودش** رد می‌شود.
3. هر جای کد که مستقیم `api.telegram.org` را صدا می‌زند، به `relay.post()` بده.
4. اگر آن پروژه پیام هم **می‌گیرد**: ⚠️ دو پروسه هم‌زمان روی **یک توکن**
   `getUpdates` نزنند (خطای ۴۰۹). یا رباتِ جدا با توکنِ جدا، یا قفلِ فایلی
   (`flock`) تا فقط یک ورکر پول کند.
5. اگر سرورِ آن پروژه **خارج از ایران** است، رله لازم نداری — `relay.post()` را
   دور بزن و مستقیم به `https://api.telegram.org/bot<TOKEN>/<method>` بزن.

---

## ۷. عیب‌یابی

| نشانه | علت | کار |
|---|---|---|
| `tlsv1 alert internal error` | SNI را IP گذاشته‌ای | `server_hostname` = دامنه |
| اتصال همیشه timeout ولی مرورگر باز می‌کند | TLS1.3 | `ctx.maximum_version = TLSv1_2` |
| ربات کند شده ولی کار می‌کند | رله‌ی اول مرده و هر بار چند ثانیه تلف می‌شود | `_BAD`/`BAD_FOR` را چک کن؛ حافظه‌ی ۹۰ثانیه‌ای باید همین را حل کند |
| `[RELAY] … جواب نداد` پشتِ‌هم برای هر دو | مسیرِ خروجیِ سرور قطع است، نه رله‌ها | از خودِ سرور `curl "…?ping=1"` بزن |
| `method not allowed` | whitelistِ PHP | `$ALLOWED` را در **هر دو** رله به‌روز کن |
| یک رله رفتارِ متفاوت دارد | نسخه‌های ناهمگونِ فایل | همیشه هر دو رله را با هم به‌روز کن |
| خطای ۴۰۹ | دو پروسه هم‌زمان `getUpdates` | قفلِ فایلی |

لاگِ سوییچ‌ها:
```bash
docker logs --tail 200 <container> | grep RELAY
```

---

## ۸. جمع‌بندیِ یک‌خطی

> **دو رله روی دو زیرساختِ مستقل، TLS ≤ 1.2، اتصال به IP با SNIِ دامنه، تایم‌اوتِ
> اتصالِ کوتاه و سوییچِ فوری با حافظه‌ی ۹۰ثانیه‌ای** — این ترکیب ربات را از «روزی
> چند بار کر می‌شود» به «ماه‌ها بی‌صدا کار می‌کند» رساند.
