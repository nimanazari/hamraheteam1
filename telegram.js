/* Telegram bot for teachers: link account, check-in/out, session report wizard, lesson plans.
   Admin (settings.tg_admin username, plus teachers with is_admin) receives every new report.
   Network: uses settings.tg_api_base (default https://api.telegram.org). Set a relay/proxy base if the
   server cannot reach Telegram directly. */
const DAYS = ['شنبه', 'یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنجشنبه', 'جمعه'];
const fa = n => String(n ?? '').replace(/\d/g, d => '۰۱۲۳۴۵۶۷۸۹'[d]);
const todayISO = () => { const d = new Date(Date.now() + 3.5 * 3600e3); return d.toISOString().slice(0, 10); }; // Tehran
const nowHM = () => { const d = new Date(Date.now() + 3.5 * 3600e3); return d.toISOString().slice(11, 16); };
const dayIdx = iso => (new Date(iso + 'T12:00:00Z').getUTCDay() + 1) % 7;
const jDate = iso => { try { return new Intl.DateTimeFormat('fa-IR-u-ca-persian', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(iso + 'T12:00:00')); } catch { return iso; } };
const TYPES = { public: 'عمومی', robotic: 'رباتیک', private: 'خصوصی' };

module.exports = function createBot({ db, setting, log = console }) {
  const state = new Map(); // chat_id -> wizard state
  let offset = 0, running = false, lastError = '';

  const token = () => setting('tg_token', '');
  const base = () => (setting('tg_api_base', 'https://api.telegram.org') || 'https://api.telegram.org').replace(/\/$/, '');
  async function call(method, body) {
    const t = token(); if (!t) throw new Error('no token');
    const r = await fetch(`${base()}/bot${t}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(40000) });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw new Error(j.description || ('telegram ' + r.status));
    return j.result;
  }
  const send = (chat_id, text, extra = {}) => call('sendMessage', { chat_id, text, parse_mode: 'HTML', ...extra }).catch(e => log.warn('tg send:', e.message));
  const kb = rows => ({ reply_markup: { inline_keyboard: rows } });
  const mainKb = () => ({ reply_markup: { keyboard: [[{ text: '⏱ ورود زدم' }, { text: '⏱ خروج زدم' }], [{ text: '📝 گزارش جلسه' }, { text: '📅 برنامه امروز' }], [{ text: '📘 طرح درس‌ها' }, { text: '🗂 گزارش‌های من' }]], resize_keyboard: true } });

  // ---- data helpers ----
  const teacherByChat = chat => db.prepare('SELECT * FROM teachers WHERE tg_chat_id=?').get(String(chat));
  const teacherClasses = tid => db.prepare('SELECT c.*, sc.name school_name FROM classes c LEFT JOIN schools sc ON sc.id=c.school_id WHERE c.teacher_id=? ORDER BY c.day, c.start').all(tid);
  const classStudents = cid => db.prepare('SELECT s.* FROM class_students cs JOIN students s ON s.id=cs.student_id WHERE cs.class_id=? ORDER BY s.name').all(cid);
  const label = c => `${DAYS[c.day]} ${fa(c.start)}–${fa(c.end)} · ${c.title || c.school_name || TYPES[c.type] || 'کلاس'}`;
  const adminChats = () => {
    const ids = new Set(db.prepare('SELECT tg_chat_id FROM teachers WHERE is_admin=1 AND tg_chat_id IS NOT NULL').all().map(r => r.tg_chat_id));
    const a = setting('tg_admin_chat', ''); if (a) ids.add(a);
    return [...ids];
  };
  const esc = s => String(s ?? '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  const hoursOf = (a, b) => { if (!a || !b || b <= a) return 0; const m = s => +s.slice(0, 2) * 60 + +s.slice(3); return +((m(b) - m(a)) / 60).toFixed(2); };

  function reportText(r, t) {
    const att = (() => { try { return JSON.parse(r.attendance || '{}'); } catch { return {}; } })();
    const v = Object.values(att); const names = id => (db.prepare('SELECT name FROM students WHERE id=?').get(id) || {}).name || id;
    const absent = Object.entries(att).filter(([, x]) => x !== 'p').map(([id, x]) => `${names(id)} (${x === 'a' ? 'غایب' : 'تأخیر'})`);
    const c = r.class_id ? db.prepare('SELECT c.*, sc.name school_name FROM classes c LEFT JOIN schools sc ON sc.id=c.school_id WHERE c.id=?').get(r.class_id) : null;
    return [`📝 <b>گزارش جلسه</b> · ${esc(t.name)}`, `📅 ${jDate(r.date)}${c ? ' · ' + esc(c.title || c.school_name || '') : ''}`,
      `⏱ ${fa(r.check_in || '—')} تا ${fa(r.check_out || '—')}${r.check_in && r.check_out ? ` (${fa(hoursOf(r.check_in, r.check_out))} ساعت)` : ''}`,
      v.length ? `✅ حاضر ${fa(v.filter(x => x === 'p').length)} · غایب ${fa(v.filter(x => x === 'a').length)} · تأخیر ${fa(v.filter(x => x === 'l').length)}${absent.length ? '\n   ' + esc(absent.join('، ')) : ''}` : '',
      r.followed_plan ? '📘 طبق طرح درس ✅' : `📘 انحراف از طرح درس ⚠️ ${esc(r.plan_note || '')}`,
      r.lesson_plan ? `\n<b>تدریس:</b> ${esc(r.lesson_plan)}` : '', r.done ? `<b>انجام‌شده:</b> ${esc(r.done)}` : '', r.homework ? `<b>تکلیف:</b> ${esc(r.homework)}` : '',
      r.with_whom ? `<b>کار با:</b> ${esc(r.with_whom)}` : '', r.notes ? `<b>یادداشت:</b> ${esc(r.notes)}` : ''].filter(Boolean).join('\n');
  }
  // called by server after any report is created (web or bot)
  async function notifyReport(reportId) {
    const r = db.prepare('SELECT * FROM reports WHERE id=?').get(reportId); if (!r) return;
    const t = db.prepare('SELECT * FROM teachers WHERE id=?').get(r.teacher_id); if (!t) return;
    for (const chat of adminChats()) if (chat !== t.tg_chat_id) await send(chat, reportText(r, t));
  }

  // ---- wizard ----
  const REPORT_COLS = ['class_id', 'date', 'lesson_plan', 'done', 'with_whom', 'notes', 'homework', 'attendance', 'followed_plan', 'plan_note', 'check_in', 'check_out', 'plan_id'];
  function saveReport(t, d) {
    const o = { class_id: d.class_id || null, date: d.date, lesson_plan: d.lesson_plan || '', done: d.done || '', with_whom: d.with_whom || '', notes: d.notes || '', homework: d.homework || '', attendance: JSON.stringify(d.att || {}), followed_plan: d.followed_plan ? 1 : 0, plan_note: d.plan_note || '', check_in: d.check_in || '', check_out: d.check_out || '', plan_id: d.plan_id || null };
    const r = db.prepare(`INSERT INTO reports(teacher_id,${REPORT_COLS.join(',')}) VALUES (?,${REPORT_COLS.map(() => '?').join(',')})`).run(t.id, ...REPORT_COLS.map(c => o[c]));
    return Number(r.lastInsertRowid);
  }
  const stamps = () => { try { return JSON.parse(setting('tg_stamps', '{}')); } catch { return {}; } };
  const setStamp = (tid, k, v) => { const s = stamps(); s[tid] = { ...(s[tid] || {}), date: todayISO(), [k]: v }; db.prepare("UPDATE settings SET value=? WHERE key='tg_stamps'").run(JSON.stringify(s)); };
  const myStamp = tid => { const s = stamps()[tid]; return s && s.date === todayISO() ? s : {}; };

  async function startReport(chat, t, cls) {
    const classes = teacherClasses(t.id);
    if (!classes.length) return send(chat, 'هنوز کلاسی برای شما روی برنامه نیست.', mainKb());
    if (!cls) {
      const today = dayIdx(todayISO());
      const rows = classes.map(c => [{ text: (c.day === today ? '⭐ ' : '') + label(c), callback_data: 'cls:' + c.id }]);
      rows.push([{ text: 'بدون کلاس مشخص', callback_data: 'cls:0' }]);
      state.set(chat, { step: 'class', d: { date: todayISO() } });
      return send(chat, '📝 گزارش کدام کلاس؟', kb(rows));
    }
  }
  function attKb(d) {
    const rows = d.students.map(s => [{ text: `${{ p: '✅', a: '❌', l: '⏰' }[d.att[s.id]]} ${s.name}`, callback_data: 'att:' + s.id }]);
    rows.push([{ text: '✔️ تمام، ادامه', callback_data: 'att:done' }]);
    return kb(rows);
  }
  async function askNext(chat, st) {
    const d = st.d;
    switch (st.step) {
      case 'att': return send(chat, '✅ حضور و غیاب — روی هر نام بزنید تا وضعیت عوض شود (✅ حاضر، ❌ غایب، ⏰ تأخیر):', attKb(d));
      case 'in': return send(chat, `⏱ ساعت <b>ورود</b> را بفرستید (مثلاً ${fa(d.cls ? d.cls.start : '10:00')}) یا «الان» را بزنید:`, kb([[{ text: `الان (${fa(nowHM())})`, callback_data: 'now:in' }, ...(d.cls ? [{ text: `ساعت کلاس (${fa(d.cls.start)})`, callback_data: 'cls:in' }] : [])]]));
      case 'out': return send(chat, `⏱ ساعت <b>خروج</b> را بفرستید یا «الان» را بزنید:`, kb([[{ text: `الان (${fa(nowHM())})`, callback_data: 'now:out' }, ...(d.cls ? [{ text: `ساعت کلاس (${fa(d.cls.end)})`, callback_data: 'cls:out' }] : [])]]));
      case 'plan': {
        const plans = db.prepare('SELECT id,title FROM plans WHERE teacher_id IS NULL OR teacher_id=? ORDER BY id DESC LIMIT 8').all(d.teacher_id);
        return send(chat, '📘 طبق کدام طرح درس پیش رفتید؟', kb([...plans.map(p => [{ text: p.title, callback_data: 'plan:' + p.id }]), [{ text: 'بدون طرح درس مرجع', callback_data: 'plan:0' }]]));
      }
      case 'fp': return send(chat, 'طبق طرح درس پیش رفتید؟', kb([[{ text: '✅ بله', callback_data: 'fp:1' }, { text: '⚠️ خیر، انحراف داشت', callback_data: 'fp:0' }]]));
      case 'fpn': return send(chat, 'دلیل یا توضیح انحراف را بنویسید:');
      case 'lp': return send(chat, '📖 چه چیزی تدریس شد؟ (موضوع / طرح درس این جلسه)');
      case 'done': return send(chat, '🛠 چه کارهایی انجام شد؟ (تمرین، آزمون، پروژه...)');
      case 'hw': return send(chat, '📝 تکلیف داده‌شده؟ (اگر نبود بنویسید «ندارد»)');
      case 'notes': return send(chat, '🗒 یادداشت یا کار با اولیا/مدیر؟ (اگر نبود بنویسید «ندارد»)');
      case 'confirm': {
        const preview = reportText({ ...d, attendance: JSON.stringify(d.att || {}), followed_plan: d.followed_plan ? 1 : 0 }, { name: d.tname });
        return send(chat, preview + '\n\nثبت شود؟', kb([[{ text: '✅ ثبت گزارش', callback_data: 'save' }, { text: '❌ انصراف', callback_data: 'cancel' }]]));
      }
    }
  }
  const nextStep = st => { const order = ['class', 'att', 'in', 'out', 'plan', 'fp', 'fpn', 'lp', 'done', 'hw', 'notes', 'confirm']; let i = order.indexOf(st.step) + 1; if (order[i] === 'att' && !st.d.students?.length) i++; if (order[i] === 'fpn' && st.d.followed_plan) i++; st.step = order[i]; };

  async function onText(chat, from, text) {
    const t = teacherByChat(chat);
    // ---- linking ----
    if (!t) {
      const code = (text.match(/\b(\d{6})\b/) || [])[1] || (text.startsWith('/start ') ? text.slice(7).trim() : '');
      if (code) {
        const tt = db.prepare('SELECT * FROM teachers WHERE tg_code=?').get(code);
        if (tt) { db.prepare('UPDATE teachers SET tg_chat_id=?, tg_code=NULL WHERE id=?').run(String(chat), tt.id); return send(chat, `✅ حساب <b>${esc(tt.name)}</b> به تلگرام وصل شد.\nاز دکمه‌های پایین استفاده کنید.`, mainKb()); }
        return send(chat, 'کد معتبر نیست. کد ۶ رقمی را از پنل خودتان (منوی «رمز عبور و تلگرام») بردارید و بفرستید.');
      }
      if (from.username && from.username.toLowerCase() === setting('tg_admin', 'academynz').toLowerCase()) {
        db.prepare("INSERT INTO settings VALUES('tg_admin_chat',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(chat));
        return send(chat, '👋 سلام مدیر. از این به بعد هر گزارشی که دبیرها ثبت کنند همین‌جا برایتان می‌آید.\nدستورها: /today گزارش‌های امروز · /week خلاصه هفته');
      }
      return send(chat, 'سلام 👋 برای اتصال حساب دبیر، کد ۶ رقمی را از پنل خودتان (hamraheteam.ir → رمز عبور و تلگرام) بردارید و همین‌جا بفرستید.');
    }
    const st = state.get(chat);
    if (text === '/cancel' || text === '❌ انصراف') { state.delete(chat); return send(chat, 'لغو شد.', mainKb()); }
    if (text.startsWith('/start')) return send(chat, `سلام ${esc(t.name)} 👋`, mainKb());
    if (text === '📅 برنامه امروز' || text === '/today') {
      const today = dayIdx(todayISO()); const list = teacherClasses(t.id).filter(c => c.day === today);
      const stp = myStamp(t.id);
      return send(chat, `📅 ${jDate(todayISO())}\n${list.length ? list.map(c => '• ' + label(c) + (c.school_name && c.title ? ' · 📍' + esc(c.school_name) : '')).join('\n') : 'امروز کلاسی ندارید.'}${stp.check_in ? `\n\n⏱ ورود: ${fa(stp.check_in)}${stp.check_out ? ' · خروج: ' + fa(stp.check_out) : ''}` : ''}`, mainKb());
    }
    if (text === '⏱ ورود زدم' || text === '/in') { setStamp(t.id, 'check_in', nowHM()); return send(chat, `⏱ ورود ثبت شد: <b>${fa(nowHM())}</b>\nبعد از کلاس «خروج زدم» را بزنید و گزارش را بفرستید.`, mainKb()); }
    if (text === '⏱ خروج زدم' || text === '/out') { setStamp(t.id, 'check_out', nowHM()); const s = myStamp(t.id); return send(chat, `⏱ خروج ثبت شد: <b>${fa(nowHM())}</b>${s.check_in ? ` (ورود ${fa(s.check_in)} → ${fa(hoursOf(s.check_in, s.check_out))} ساعت)` : ''}\nحالا «📝 گزارش جلسه» را بزنید؛ ساعت‌ها خودکار پر می‌شود.`, mainKb()); }
    if (text === '📘 طرح درس‌ها' || text === '/plans') {
      const plans = db.prepare('SELECT * FROM plans WHERE teacher_id IS NULL OR teacher_id=? ORDER BY id DESC LIMIT 10').all(t.id);
      return send(chat, plans.length ? plans.map(p => `📘 <b>${esc(p.title)}</b>${p.content ? '\n' + esc(p.content.slice(0, 400)) : ''}${p.file_name ? `\n📎 فایل: ${esc(p.file_name)} (دانلود از پنل)` : ''}`).join('\n\n') : 'هنوز طرح درسی برای شما ثبت نشده.', mainKb());
    }
    if (text === '🗂 گزارش‌های من' || text === '/reports') {
      const reps = db.prepare('SELECT * FROM reports WHERE teacher_id=? ORDER BY date DESC, id DESC LIMIT 5').all(t.id);
      return send(chat, reps.length ? reps.map(r => reportText(r, t)).join('\n\n———\n\n') : 'هنوز گزارشی ثبت نکرده‌اید.', mainKb());
    }
    if (text === '📝 گزارش جلسه' || text === '/report') return startReport(chat, t);
    if (text === '/week' && (t.is_admin)) return sendWeek(chat);
    // ---- wizard text steps ----
    if (st) {
      const d = st.d;
      if (st.step === 'in' || st.step === 'out') {
        const m = text.match(/(\d{1,2})[:٫.](\d{2})/); if (!m) return send(chat, 'ساعت را به شکل 10:30 بفرستید.');
        d[st.step === 'in' ? 'check_in' : 'check_out'] = `${m[1].padStart(2, '0')}:${m[2]}`;
        if (st.step === 'out' && d.check_out <= d.check_in) return send(chat, 'ساعت خروج باید بعد از ورود باشد.');
        nextStep(st); return askNext(chat, st);
      }
      if (['fpn', 'lp', 'done', 'hw', 'notes'].includes(st.step)) {
        const v = /^(ندارد|نداره|-|—|خیر|no)$/i.test(text.trim()) ? '' : text.trim();
        ({ fpn: () => d.plan_note = v, lp: () => d.lesson_plan = v, done: () => d.done = v, hw: () => d.homework = v, notes: () => d.notes = v })[st.step]();
        nextStep(st); return askNext(chat, st);
      }
      return send(chat, 'لطفاً از دکمه‌های پیام قبلی استفاده کنید یا /cancel بزنید.');
    }
    return send(chat, 'از دکمه‌های پایین استفاده کنید 👇', mainKb());
  }

  async function onCallback(cb) {
    const chat = cb.message.chat.id, data = cb.data || '';
    call('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
    const t = teacherByChat(chat); if (!t) return;
    const st = state.get(chat);
    if (data === 'cancel') { state.delete(chat); return send(chat, 'لغو شد.', mainKb()); }
    if (!st) return;
    const d = st.d;
    if (data.startsWith('cls:') && st.step === 'class') {
      const id = +data.slice(4); d.class_id = id || null; d.cls = id ? teacherClasses(t.id).find(c => c.id === id) : null; d.teacher_id = t.id; d.tname = t.name;
      d.students = d.cls && d.cls.type !== 'public' ? classStudents(id) : []; d.att = {}; d.students.forEach(s => d.att[s.id] = 'p');
      const stp = myStamp(t.id); if (stp.check_in) d.check_in = stp.check_in; if (stp.check_out && stp.check_in && stp.check_out > stp.check_in) d.check_out = stp.check_out;
      nextStep(st);
      if (st.step === 'in' && d.check_in) nextStep(st);
      if (st.step === 'out' && d.check_out) nextStep(st);
      return askNext(chat, st);
    }
    if (data.startsWith('att:') && st.step === 'att') {
      if (data === 'att:done') { nextStep(st); if (st.step === 'in' && d.check_in) nextStep(st); if (st.step === 'out' && d.check_out) nextStep(st); return askNext(chat, st); }
      const id = data.slice(4); d.att[id] = { p: 'a', a: 'l', l: 'p' }[d.att[id] || 'p'];
      return call('editMessageReplyMarkup', { chat_id: chat, message_id: cb.message.message_id, ...attKb(d).reply_markup ? { reply_markup: attKb(d).reply_markup } : {} }).catch(() => {});
    }
    if ((data === 'now:in' || data === 'cls:in') && st.step === 'in') { d.check_in = data === 'now:in' ? nowHM() : d.cls.start; nextStep(st); if (d.check_out) nextStep(st); return askNext(chat, st); }
    if ((data === 'now:out' || data === 'cls:out') && st.step === 'out') { d.check_out = data === 'now:out' ? nowHM() : d.cls.end; if (d.check_out <= d.check_in) return send(chat, 'ساعت خروج باید بعد از ورود باشد. ساعت را تایپ کنید.'); nextStep(st); return askNext(chat, st); }
    if (data.startsWith('plan:') && st.step === 'plan') { d.plan_id = +data.slice(5) || null; nextStep(st); return askNext(chat, st); }
    if (data.startsWith('fp:') && st.step === 'fp') { d.followed_plan = data === 'fp:1'; nextStep(st); return askNext(chat, st); }
    if (data === 'save' && st.step === 'confirm') {
      const id = saveReport(t, d); state.delete(chat);
      setStamp(t.id, 'reported', id);
      await send(chat, '✅ گزارش ثبت شد و برای مدیر ارسال شد. خسته نباشید!', mainKb());
      return notifyReport(id);
    }
  }
  async function sendWeek(chat) {
    const from = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
    const rows = db.prepare('SELECT t.name, COUNT(r.id) n, SUM(CASE WHEN r.check_in<>"" AND r.check_out<>"" THEN 1 ELSE 0 END) withTime FROM teachers t LEFT JOIN reports r ON r.teacher_id=t.id AND r.date>=? GROUP BY t.id ORDER BY n DESC').all(from);
    return send(chat, '📊 <b>۷ روز گذشته</b>\n' + rows.map(r => `• ${esc(r.name)}: ${fa(r.n)} گزارش`).join('\n'));
  }

  async function handleUpdate(u) {
    try {
      if (u.message && u.message.text) {
        const chat = u.message.chat.id;
        if (u.message.text === '/today' && !teacherByChat(chat) && String(chat) === setting('tg_admin_chat', '')) {
          const reps = db.prepare('SELECT r.*, t.name tname FROM reports r JOIN teachers t ON t.id=r.teacher_id WHERE r.date=? ORDER BY r.id').all(todayISO());
          return send(chat, reps.length ? reps.map(r => reportText(r, { name: r.tname })).join('\n\n———\n\n') : 'امروز هنوز گزارشی ثبت نشده.');
        }
        if (u.message.text === '/week' && String(chat) === setting('tg_admin_chat', '')) return sendWeek(chat);
        return onText(chat, u.message.from || {}, u.message.text.trim());
      }
      if (u.callback_query) return onCallback(u.callback_query);
    } catch (e) { log.error('tg update:', e); }
  }

  async function poll() {
    if (running) return; running = true;
    log.log('telegram: polling started');
    while (running) {
      if (!token()) { await new Promise(r => setTimeout(r, 15000)); continue; }
      try {
        const updates = await call('getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'callback_query'] });
        lastError = '';
        for (const u of updates) { offset = u.update_id + 1; await handleUpdate(u); }
      } catch (e) {
        if (lastError !== e.message) { log.warn('telegram:', e.message); lastError = e.message; }
        await new Promise(r => setTimeout(r, 10000));
      }
    }
  }
  const status = () => ({ token: !!token(), base: base(), polling: running, lastError, admin_linked: !!setting('tg_admin_chat', ''), linked_teachers: db.prepare('SELECT COUNT(*) c FROM teachers WHERE tg_chat_id IS NOT NULL').get().c });
  return { poll, handleUpdate, notifyReport, status, send };
};
