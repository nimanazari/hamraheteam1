const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const UPLOADS = path.join(__dirname, 'data', 'uploads');
fs.mkdirSync(UPLOADS, { recursive: true });
const db = new DatabaseSync(path.join(__dirname, 'data', 'app.db'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS schools (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS teachers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, subject TEXT DEFAULT '', username TEXT UNIQUE, password TEXT, color TEXT DEFAULT '#3b82f6');
CREATE TABLE IF NOT EXISTS students (id INTEGER PRIMARY KEY, name TEXT NOT NULL, school_id INTEGER, note TEXT DEFAULT '', active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS classes (id INTEGER PRIMARY KEY, title TEXT DEFAULT '', teacher_id INTEGER, school_id INTEGER, day INTEGER NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL, note TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS class_students (class_id INTEGER, student_id INTEGER, PRIMARY KEY(class_id, student_id));
CREATE TABLE IF NOT EXISTS teacher_students (teacher_id INTEGER, student_id INTEGER, PRIMARY KEY(teacher_id, student_id));
CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY, class_id INTEGER, teacher_id INTEGER, date TEXT NOT NULL, lesson_plan TEXT DEFAULT '', done TEXT DEFAULT '', with_whom TEXT DEFAULT '', notes TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS overrides (class_id INTEGER, date TEXT, status TEXT DEFAULT 'cancel', note TEXT DEFAULT '', PRIMARY KEY(class_id,date));
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, user TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS plans (id INTEGER PRIMARY KEY, teacher_id INTEGER, title TEXT NOT NULL, content TEXT DEFAULT '', file_name TEXT, file_path TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY, kind TEXT DEFAULT 'auto', label TEXT DEFAULT '', by TEXT DEFAULT '', data TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS payments (id INTEGER PRIMARY KEY, teacher_id INTEGER, period_from TEXT, period_to TEXT, amount INTEGER, note TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')));
`);
// column migrations (safe to re-run)
const addCol = (t, c, def) => { try { db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`); } catch {} };
addCol('classes', 'type', "TEXT DEFAULT 'robotic'");
addCol('teachers', 'is_admin', 'INTEGER DEFAULT 0');
addCol('teachers', 'rate_hour', 'INTEGER DEFAULT 0');
addCol('teachers', 'rate_session', 'INTEGER DEFAULT 0');
addCol('teachers', 'rate_fixed', 'INTEGER DEFAULT 0');
addCol('reports', 'homework', "TEXT DEFAULT ''");
addCol('reports', 'attendance', "TEXT DEFAULT '{}'");
addCol('reports', 'followed_plan', 'INTEGER DEFAULT 1');
addCol('reports', 'plan_note', "TEXT DEFAULT ''");
addCol('reports', 'check_in', "TEXT DEFAULT ''");
addCol('reports', 'check_out', "TEXT DEFAULT ''");
addCol('reports', 'plan_id', 'INTEGER');
addCol('teachers', 'tg_chat_id', 'TEXT');
addCol('teachers', 'tg_code', 'TEXT');
addCol('teachers', 'perms', 'TEXT');
addCol('classes', 'color', 'TEXT');
addCol('schools', 'color', 'TEXT');
const PERMS = ['board', 'calendar', 'teachers', 'students', 'schools', 'reports', 'plans', 'payroll', 'settings'];
const DEFAULT_PERMS = PERMS.filter(p => p !== 'payroll');
const permsOf = t => { try { const p = JSON.parse(t.perms || 'null'); return Array.isArray(p) ? p : DEFAULT_PERMS; } catch { return DEFAULT_PERMS; } };

// ---- seed ----
if (db.prepare('SELECT COUNT(*) c FROM schools').get().c === 0) {
  const ins = db.prepare('INSERT INTO schools(name) VALUES (?)');
  ['نگرش دوره یک پسرانه', 'نگرش دبستان دوره یک', 'نگرش دخترانه دوره یک', 'رستاجو دوره دوم', 'یوسف آباد دوره دو', 'صالحی', 'نگاه نو', 'ستارگان زمین'].forEach(n => ins.run(n));
}
if (db.prepare('SELECT COUNT(*) c FROM students').get().c === 0 && fs.existsSync(path.join(__dirname, 'students.txt'))) {
  const ins = db.prepare('INSERT INTO students(name, note, active) VALUES (?,?,?)');
  fs.readFileSync(path.join(__dirname, 'students.txt'), 'utf8').split(/\r?\n/).filter(Boolean).forEach(l => {
    const [name, note = ''] = l.split('|');
    ins.run(name.trim(), note.trim(), note ? 0 : 1);
  });
}
if (db.prepare('SELECT COUNT(*) c FROM teachers').get().c === 0) {
  const ins = db.prepare('INSERT INTO teachers(name,subject,username,password,color,is_admin) VALUES (?,?,?,?,?,?)');
  const COLORS = ['#5b5bd6', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];
  [['پارسا', 'parsa'], ['صدرا', 'sadra'], ['ارشیا', 'arshia'], ['نیما', 'nima'], ['گلشید', 'golshid'], ['مهشید', 'mahshid'], ['تسنیم', 'tasnim'], ['ابریشمی', 'abrishami'], ['هستی', 'hasti']]
    .forEach(([n, u], i) => ins.run(n, '', u, u, COLORS[i % COLORS.length], u === 'nima' ? 1 : 0));
}
const setting = (k, d) => { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k); if (r) return r.value; db.prepare('INSERT INTO settings VALUES(?,?)').run(k, d); return d; };
setting('admin_password', 'admin');
setting('slots', JSON.stringify(['10:00-12:00', '12:00-14:00', '14:00-16:00']));
setting('tg_token', process.env.TG_TOKEN || ''); setting('tg_admin', 'academynz'); setting('tg_api_base', 'https://api.telegram.org'); setting('tg_stamps', '{}');
setting('color_mode', 'teacher');
setting('holidays', '');
setting('grid_start', '07:30'); setting('grid_end', '21:00');
setting('term_start', '2026-09-23'); setting('classes_start', '2026-09-25'); setting('term_end', '2027-05-21'); setting('term_weeks', '18');

// ---- auth ----
db.prepare("DELETE FROM sessions WHERE created_at < datetime('now','-90 days')").run();
const sessions = {
  get: sid => { const r = db.prepare('SELECT user FROM sessions WHERE sid=?').get(sid); return r ? JSON.parse(r.user) : null; },
  set: (sid, u) => db.prepare('INSERT INTO sessions(sid,user) VALUES (?,?)').run(sid, JSON.stringify(u)),
  delete: sid => db.prepare('DELETE FROM sessions WHERE sid=?').run(sid),
};
const bot = require('./telegram')({ db, setting, log: console });
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '30mb' }));
app.use((req, res, next) => {
  const m = /sid=([a-f0-9]+)/.exec(req.headers.cookie || '');
  req.user = m ? sessions.get(m[1]) : null;
  // refresh admin flag from DB (so revoking admin works immediately)
  if (req.user && req.user.teacher_id) { const t = db.prepare('SELECT is_admin, name, perms FROM teachers WHERE id=?').get(req.user.teacher_id); if (!t) req.user = null; else { req.user.name = t.name; req.user.role = t.is_admin ? 'admin' : 'teacher'; req.user.id = req.user.teacher_id; req.user.perms = t.is_admin ? permsOf(t) : []; req.user.main = false; } }
  else if (req.user && req.user.role === 'admin') { req.user.main = true; req.user.perms = PERMS; }
  next();
});
const cookieFor = (req, sid) => `sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=7776000${req.secure ? '; Secure' : ''}`;
const requireAuth = (req, res, next) => req.user ? next() : res.status(401).json({ error: 'unauthorized' });
const requireAdmin = (req, res, next) => (req.user && req.user.role === 'admin') ? next() : res.status(403).json({ error: 'forbidden' });
const isAdmin = req => req.user && req.user.role === 'admin';
const hasPerm = (req, p) => isAdmin(req) && (req.user.main || (req.user.perms || []).includes(p));
const requirePerm = p => (req, res, next) => hasPerm(req, p) ? next() : res.status(403).json({ error: 'دسترسی به این بخش ندارید' });
const requireMain = (req, res, next) => (req.user && req.user.main) ? next() : res.status(403).json({ error: 'فقط مدیر اصلی' });

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  let user = null;
  if (username === 'admin' && password === setting('admin_password', 'admin')) user = { role: 'admin', name: 'مدیر', main: true, perms: PERMS };
  else {
    const t = db.prepare('SELECT * FROM teachers WHERE username=? AND password=?').get(username, password);
    if (t) user = { role: t.is_admin ? 'admin' : 'teacher', id: t.id, teacher_id: t.id, name: t.name, main: false, perms: t.is_admin ? permsOf(t) : [] };
  }
  if (!user) return res.status(401).json({ error: 'نام کاربری یا رمز اشتباه است' });
  const sid = crypto.randomBytes(16).toString('hex');
  sessions.set(sid, user);
  res.setHeader('Set-Cookie', cookieFor(req, sid));
  res.json(user);
});
app.post('/api/logout', (req, res) => { const m = /sid=([a-f0-9]+)/.exec(req.headers.cookie || ''); if (m) sessions.delete(m[1]); res.json({ ok: true }); });
app.get('/api/me', (req, res) => res.json(req.user));
app.put('/api/me/password', requireAuth, (req, res) => {
  const { old_password, password } = req.body || {};
  if (!password || password.length < 3) return res.status(400).json({ error: 'رمز باید حداقل ۳ کاراکتر باشد' });
  if (req.user.teacher_id) {
    const t = db.prepare('SELECT password FROM teachers WHERE id=?').get(req.user.teacher_id);
    if (t.password !== old_password) return res.status(400).json({ error: 'رمز فعلی اشتباه است' });
    db.prepare('UPDATE teachers SET password=? WHERE id=?').run(password, req.user.teacher_id);
  } else {
    if (setting('admin_password', 'admin') !== old_password) return res.status(400).json({ error: 'رمز فعلی اشتباه است' });
    db.prepare("UPDATE settings SET value=? WHERE key='admin_password'").run(password);
  }
  res.json({ ok: true });
});

// ---- helpers ----
const DAYS = ['شنبه', 'یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنجشنبه', 'جمعه'];
const toMin = s => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };
const overlap = (a, b) => toMin(a.start) < toMin(b.end) && toMin(b.start) < toMin(a.end);
function classWithStudents(c) {
  c.students = db.prepare('SELECT s.* FROM class_students cs JOIN students s ON s.id=cs.student_id WHERE cs.class_id=? ORDER BY s.name').all(c.id);
  c.student_ids = c.students.map(s => s.id);
  return c;
}
function allClasses(where = '', params = []) {
  return db.prepare(`SELECT c.*, t.name teacher_name, t.color teacher_color, sc.name school_name, sc.color school_color FROM classes c LEFT JOIN teachers t ON t.id=c.teacher_id LEFT JOIN schools sc ON sc.id=c.school_id ${where} ORDER BY c.day, c.start`).all(...params).map(classWithStudents);
}
function findConflicts({ id, teacher_id, day, start, end, student_ids = [] }) {
  const others = allClasses('WHERE c.day=? AND c.id<>?', [Number(day), Number(id) || 0]).filter(o => overlap({ start, end }, o));
  const conflicts = [];
  for (const o of others) {
    const label = `${o.title || o.school_name || 'کلاس'} (${o.start}-${o.end})`;
    if (teacher_id && o.teacher_id === Number(teacher_id)) conflicts.push({ type: 'teacher', name: o.teacher_name, class_id: o.id, class: label });
    for (const s of o.students) if (student_ids.map(Number).includes(s.id)) conflicts.push({ type: 'student', name: s.name, class_id: o.id, class: label });
  }
  return conflicts;
}

// ---- snapshots (undo/redo + version history of the weekly board) ----
const boardData = () => JSON.stringify({ classes: db.prepare('SELECT * FROM classes').all(), class_students: db.prepare('SELECT * FROM class_students').all(), overrides: db.prepare('SELECT * FROM overrides').all() });
function snapshot(req, kind, label) {
  db.prepare("DELETE FROM snapshots WHERE kind='redo'").run(); // a new change invalidates redo history
  db.prepare('INSERT INTO snapshots(kind,label,by,data) VALUES (?,?,?,?)').run(kind, label || '', req?.user?.name || '', boardData());
  db.prepare("DELETE FROM snapshots WHERE kind='auto' AND id NOT IN (SELECT id FROM snapshots WHERE kind='auto' ORDER BY id DESC LIMIT 100)").run();
  db.prepare("DELETE FROM snapshots WHERE kind IN ('manual','restore') AND id NOT IN (SELECT id FROM snapshots WHERE kind IN ('manual','restore') ORDER BY id DESC LIMIT 60)").run();
}
function restoreData(json) {
  const d = JSON.parse(json);
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM class_students; DELETE FROM overrides; DELETE FROM classes;');
    const cols = ['id', 'title', 'teacher_id', 'school_id', 'day', 'start', 'end', 'note', 'type', 'color'];
    const ic = db.prepare(`INSERT INTO classes(${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
    d.classes.forEach(c => ic.run(...cols.map(k => c[k] ?? (k === 'type' ? 'robotic' : k === 'note' || k === 'title' ? '' : null))));
    const ics = db.prepare('INSERT OR IGNORE INTO class_students VALUES (?,?)'); d.class_students.forEach(x => ics.run(x.class_id, x.student_id));
    const io = db.prepare('INSERT OR IGNORE INTO overrides(class_id,date,status,note) VALUES (?,?,?,?)'); (d.overrides || []).forEach(x => io.run(x.class_id, x.date, x.status, x.note));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
app.get('/api/snapshots', requirePerm('board'), (req, res) => {
  const rows = db.prepare("SELECT id,kind,label,by,created_at,length(data) size FROM snapshots WHERE kind<>'redo' ORDER BY id DESC LIMIT 80").all();
  rows.forEach(r => { try { r.classes = JSON.parse(db.prepare('SELECT data FROM snapshots WHERE id=?').get(r.id).data).classes.length; } catch { r.classes = 0; } });
  res.json({ list: rows, canUndo: !!db.prepare("SELECT 1 FROM snapshots WHERE kind='auto' LIMIT 1").get(), canRedo: !!db.prepare("SELECT 1 FROM snapshots WHERE kind='redo' LIMIT 1").get() });
});
app.post('/api/snapshots', requirePerm('board'), (req, res) => { snapshot(req, 'manual', req.body.label || 'ذخیره دستی'); res.json({ ok: true }); });
app.post('/api/snapshots/:id/restore', requirePerm('board'), (req, res) => {
  const sn = db.prepare('SELECT * FROM snapshots WHERE id=?').get(req.params.id); if (!sn) return res.status(404).json({ error: 'نسخه پیدا نشد' });
  snapshot(req, 'restore', 'قبل از بازگردانی به نسخه ' + sn.id);
  restoreData(sn.data); res.json({ ok: true });
});
app.post('/api/undo', requirePerm('board'), (req, res) => {
  const sn = db.prepare("SELECT * FROM snapshots WHERE kind='auto' ORDER BY id DESC LIMIT 1").get(); if (!sn) return res.status(400).json({ error: 'چیزی برای برگرداندن نیست' });
  db.prepare('INSERT INTO snapshots(kind,label,by,data) VALUES (?,?,?,?)').run('redo', sn.label, req.user.name || '', boardData());
  db.prepare('DELETE FROM snapshots WHERE id=?').run(sn.id);
  restoreData(sn.data); res.json({ ok: true, label: sn.label });
});
app.post('/api/redo', requirePerm('board'), (req, res) => {
  const sn = db.prepare("SELECT * FROM snapshots WHERE kind='redo' ORDER BY id DESC LIMIT 1").get(); if (!sn) return res.status(400).json({ error: 'چیزی برای تکرار نیست' });
  db.prepare('INSERT INTO snapshots(kind,label,by,data) VALUES (?,?,?,?)').run('auto', sn.label, req.user.name || '', boardData());
  db.prepare('DELETE FROM snapshots WHERE id=?').run(sn.id);
  restoreData(sn.data); res.json({ ok: true, label: sn.label });
});
// bulk day operations
app.post('/api/classes/bulk', requirePerm('board'), (req, res) => {
  const { action, from_day, to_day, ids } = req.body;
  const list = ids?.length ? allClasses(`WHERE c.id IN (${ids.map(Number).join(',')})`) : allClasses('WHERE c.day=?', [Number(from_day)]);
  if (!list.length) return res.status(400).json({ error: 'کلاسی برای این عملیات نیست' });
  snapshot(req, 'auto', `${action === 'move' ? 'انتقال' : action === 'copy' ? 'کپی' : 'حذف'} ${list.length} کلاس ${action === 'clear' ? '' : 'به ' + DAYS[to_day]}`);
  const ins = db.prepare('INSERT OR IGNORE INTO class_students VALUES (?,?)');
  if (action === 'move') list.forEach(c => db.prepare('UPDATE classes SET day=? WHERE id=?').run(Number(to_day), c.id));
  else if (action === 'copy') list.forEach(c => { const id = Number(db.prepare('INSERT INTO classes(title,teacher_id,school_id,day,start,end,note,type,color) VALUES (?,?,?,?,?,?,?,?,?)').run(c.title, c.teacher_id, c.school_id, Number(to_day), c.start, c.end, c.note, c.type, c.color || null).lastInsertRowid); c.student_ids.forEach(s => ins.run(id, s)); });
  else if (action === 'clear') list.forEach(c => { for (const t of ['overrides', 'class_students']) db.prepare(`DELETE FROM ${t} WHERE class_id=?`).run(c.id); db.prepare('DELETE FROM classes WHERE id=?').run(c.id); });
  res.json({ ok: true, count: list.length });
});

// ---- meta ----
app.get('/api/meta', requireAuth, (req, res) => {
  res.json({ days: DAYS, slots: JSON.parse(setting('slots', '[]')), term_start: setting('term_start', '2026-09-23'), classes_start: setting('classes_start', '2026-09-25'), term_end: setting('term_end', '2027-05-21'), term_weeks: +setting('term_weeks', '18'), color_mode: setting('color_mode', 'teacher'), grid_start: setting('grid_start', '07:30'), grid_end: setting('grid_end', '21:00'), holidays: (() => { try { return JSON.parse(setting('holidays', '') || 'null'); } catch { return null; } })() });
});
app.put('/api/meta/holidays', requirePerm('board'), (req, res) => { db.prepare("UPDATE settings SET value=? WHERE key='holidays'").run(JSON.stringify(req.body.holidays || {})); res.json({ ok: true }); });
app.put('/api/meta/slots', requirePerm('settings'), (req, res) => { db.prepare("UPDATE settings SET value=? WHERE key='slots'").run(JSON.stringify(req.body.slots || [])); res.json({ ok: true }); });
app.put('/api/meta/term', requirePerm('settings'), (req, res) => {
  for (const k of ['term_start', 'classes_start', 'term_weeks', 'term_end', 'color_mode', 'grid_start', 'grid_end']) if (req.body[k]) db.prepare('UPDATE settings SET value=? WHERE key=?').run(String(req.body[k]), k);
  res.json({ ok: true });
});
app.put('/api/meta/admin-password', requireMain, (req, res) => { db.prepare("UPDATE settings SET value=? WHERE key='admin_password'").run(String(req.body.password || 'admin')); res.json({ ok: true }); });

// ---- overrides ----
app.get('/api/overrides', requireAuth, (req, res) => res.json(db.prepare('SELECT * FROM overrides').all()));
app.put('/api/overrides', requirePerm('board'), (req, res) => {
  const { class_id, date, status = 'cancel', note = '' } = req.body;
  snapshot(req, 'auto', 'تغییر جلسه ' + date);
  if (status === 'none') db.prepare('DELETE FROM overrides WHERE class_id=? AND date=?').run(class_id, date);
  else db.prepare('INSERT INTO overrides(class_id,date,status,note) VALUES (?,?,?,?) ON CONFLICT(class_id,date) DO UPDATE SET status=excluded.status, note=excluded.note').run(class_id, date, status, note);
  res.json({ ok: true });
});

// ---- generic CRUD ----
function crud(table, cols, opts = {}) {
  app.get(`/api/${table}`, requireAuth, (req, res) => {
    const rows = db.prepare(`SELECT * FROM ${table} ORDER BY name`).all();
    if (table === 'teachers') {
      const ts = db.prepare('SELECT teacher_id, student_id FROM teacher_students').all();
      rows.forEach(r => { r.student_ids = ts.filter(x => x.teacher_id === r.id).map(x => x.student_id); r.perms = r.is_admin ? permsOf(r) : []; if (!isAdmin(req)) { delete r.password; delete r.username; } if (!hasPerm(req, 'payroll')) { delete r.rate_hour; delete r.rate_session; delete r.rate_fixed; } });
    }
    res.json(rows);
  });
  const perm = requirePerm(table);
  app.post(`/api/${table}`, perm, (req, res) => {
    const vals = cols.map(c => req.body[c] ?? null);
    try { const r = db.prepare(`INSERT INTO ${table}(${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals); res.json({ id: Number(r.lastInsertRowid) }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.put(`/api/${table}/:id`, perm, (req, res) => {
    let set = cols.filter(c => c in req.body);
    if (table === 'teachers' && !req.user.main) set = set.filter(c => !['is_admin', 'perms', 'rate_hour', 'rate_session', 'rate_fixed'].includes(c)); // only main admin grants access / sets rates
    if (table === 'teachers' && 'perms' in req.body && typeof req.body.perms !== 'string') req.body.perms = JSON.stringify(req.body.perms || []);
    try { if (set.length) db.prepare(`UPDATE ${table} SET ${set.map(c => `${c}=?`).join(',')} WHERE id=?`).run(...set.map(c => req.body[c]), req.params.id); res.json({ ok: true }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.delete(`/api/${table}/:id`, perm, (req, res) => { db.prepare(`DELETE FROM ${table} WHERE id=?`).run(req.params.id); if (opts.onDelete) opts.onDelete(req.params.id); res.json({ ok: true }); });
}
crud('schools', ['name', 'color'], { onDelete: id => { db.prepare('UPDATE students SET school_id=NULL WHERE school_id=?').run(id); db.prepare('UPDATE classes SET school_id=NULL WHERE school_id=?').run(id); } });
crud('teachers', ['name', 'subject', 'username', 'password', 'color', 'is_admin', 'rate_hour', 'rate_session', 'rate_fixed', 'perms'], { onDelete: id => { db.prepare('UPDATE classes SET teacher_id=NULL WHERE teacher_id=?').run(id); db.prepare('DELETE FROM teacher_students WHERE teacher_id=?').run(id); } });
crud('students', ['name', 'school_id', 'note', 'active'], { onDelete: id => { db.prepare('DELETE FROM class_students WHERE student_id=?').run(id); db.prepare('DELETE FROM teacher_students WHERE student_id=?').run(id); } });
app.put('/api/teachers/:id/students', requirePerm('board'), (req, res) => {
  db.prepare('DELETE FROM teacher_students WHERE teacher_id=?').run(req.params.id);
  const ins = db.prepare('INSERT OR IGNORE INTO teacher_students VALUES (?,?)');
  (req.body.student_ids || []).forEach(sid => ins.run(req.params.id, sid));
  res.json({ ok: true });
});

// ---- classes ----
app.get('/api/classes/version', requireAuth, (req, res) => res.json({ v: db.prepare('SELECT COALESCE(MAX(id),0) m FROM snapshots').get().m + ':' + db.prepare('SELECT COUNT(*) c, COALESCE(SUM(id),0) s FROM classes').get().c + ':' + db.prepare('SELECT COUNT(*) c FROM class_students').get().c }));
app.get('/api/classes', requireAuth, (req, res) => {
  if (!isAdmin(req)) return res.json(allClasses('WHERE c.teacher_id=?', [req.user.id]));
  res.json(allClasses());
});
app.post('/api/classes/check', requirePerm('board'), (req, res) => res.json(findConflicts(req.body)));
function saveClass(body, id) {
  const { title = '', teacher_id = null, school_id = null, day, start, end, note = '', type = 'robotic', color = null } = body;
  const student_ids = type === 'public' ? [] : (body.student_ids || []);
  if (id) db.prepare('UPDATE classes SET title=?,teacher_id=?,school_id=?,day=?,start=?,end=?,note=?,type=?,color=? WHERE id=?').run(title, teacher_id, school_id, day, start, end, note, type, color || null, id);
  else id = Number(db.prepare('INSERT INTO classes(title,teacher_id,school_id,day,start,end,note,type,color) VALUES (?,?,?,?,?,?,?,?,?)').run(title, teacher_id, school_id, day, start, end, note, type, color || null).lastInsertRowid);
  db.prepare('DELETE FROM class_students WHERE class_id=?').run(id);
  const ins = db.prepare('INSERT OR IGNORE INTO class_students VALUES (?,?)');
  student_ids.forEach(s => ins.run(id, s));
  return id;
}
app.post('/api/classes', requirePerm('board'), (req, res) => {
  const conflicts = findConflicts(req.body);
  if (conflicts.length && !req.body.force) return res.status(409).json({ conflicts });
  snapshot(req, 'auto', 'افزودن کلاس ' + DAYS[req.body.day]);
  res.json({ id: saveClass(req.body) });
});
app.put('/api/classes/:id', requirePerm('board'), (req, res) => {
  const conflicts = findConflicts({ ...req.body, id: Number(req.params.id) });
  if (conflicts.length && !req.body.force) return res.status(409).json({ conflicts });
  snapshot(req, 'auto', 'ویرایش کلاس ' + (req.body.title || DAYS[req.body.day] || ''));
  res.json({ id: saveClass(req.body, Number(req.params.id)) });
});
app.delete('/api/classes/:id', requirePerm('board'), (req, res) => {
  snapshot(req, 'auto', 'حذف کلاس');
  for (const t of ['overrides', 'class_students', 'classes']) db.prepare(`DELETE FROM ${t} WHERE ${t === 'classes' ? 'id' : 'class_id'}=?`).run(req.params.id);
  res.json({ ok: true });
});

// ---- reports ----
const REPORT_COLS = ['class_id', 'date', 'lesson_plan', 'done', 'with_whom', 'notes', 'homework', 'attendance', 'followed_plan', 'plan_note', 'check_in', 'check_out', 'plan_id'];
const hoursOf = r => (r.check_in && r.check_out && r.check_out > r.check_in) ? +((toMin(r.check_out) - toMin(r.check_in)) / 60).toFixed(2) : 0;
app.get('/api/reports', requireAuth, (req, res) => {
  const w = [], p = [];
  if (!hasPerm(req, 'reports')) { w.push('r.teacher_id=?'); p.push(req.user.id || 0); }
  else if (req.query.teacher_id) { w.push('r.teacher_id=?'); p.push(req.query.teacher_id); }
  if (req.query.from) { w.push('r.date>=?'); p.push(req.query.from); }
  if (req.query.to) { w.push('r.date<=?'); p.push(req.query.to); }
  const rows = db.prepare(`SELECT r.*, t.name teacher_name, c.title class_title, c.day, c.start, c.end, c.type class_type, sc.name school_name, pl.title plan_title FROM reports r LEFT JOIN teachers t ON t.id=r.teacher_id LEFT JOIN classes c ON c.id=r.class_id LEFT JOIN schools sc ON sc.id=c.school_id LEFT JOIN plans pl ON pl.id=r.plan_id ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY r.date DESC, r.id DESC`).all(...p);
  rows.forEach(r => { r.hours = hoursOf(r); try { r.attendance = JSON.parse(r.attendance || '{}'); } catch { r.attendance = {}; } });
  res.json(rows);
});
function reportBody(body, base = {}) {
  const o = {};
  for (const c of REPORT_COLS) o[c] = c in body ? body[c] : (base[c] ?? (c === 'followed_plan' ? 1 : c === 'attendance' ? '{}' : c === 'class_id' || c === 'plan_id' ? null : ''));
  if (typeof o.attendance !== 'string') o.attendance = JSON.stringify(o.attendance || {});
  o.followed_plan = o.followed_plan ? 1 : 0;
  return o;
}
app.post('/api/reports', requireAuth, (req, res) => {
  const teacher_id = isAdmin(req) && req.body.teacher_id ? req.body.teacher_id : req.user.id;
  if (!teacher_id) return res.status(400).json({ error: 'دبیر مشخص نیست' });
  const o = reportBody(req.body);
  if (!o.date) return res.status(400).json({ error: 'تاریخ لازم است' });
  const r = db.prepare(`INSERT INTO reports(teacher_id,${REPORT_COLS.join(',')}) VALUES (?,${REPORT_COLS.map(() => '?').join(',')})`).run(teacher_id, ...REPORT_COLS.map(c => o[c]));
  res.json({ id: Number(r.lastInsertRowid) });
  bot.notifyReport(Number(r.lastInsertRowid)).catch(() => {});
});
app.put('/api/reports/:id', requireAuth, (req, res) => {
  const r = db.prepare('SELECT * FROM reports WHERE id=?').get(req.params.id);
  if (!r || (r.teacher_id !== req.user.id && !hasPerm(req, 'reports'))) return res.status(403).json({ error: 'forbidden' });
  const o = reportBody(req.body, r);
  db.prepare(`UPDATE reports SET ${REPORT_COLS.map(c => c + '=?').join(',')} WHERE id=?`).run(...REPORT_COLS.map(c => o[c]), req.params.id);
  res.json({ ok: true });
});
app.delete('/api/reports/:id', requireAuth, (req, res) => {
  const r = db.prepare('SELECT * FROM reports WHERE id=?').get(req.params.id);
  if (!r || (r.teacher_id !== req.user.id && !hasPerm(req, 'reports'))) return res.status(403).json({ error: 'forbidden' });
  db.prepare('DELETE FROM reports WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---- lesson plans (admin writes/uploads, teachers read) ----
app.get('/api/plans', requireAuth, (req, res) => {
  const rows = isAdmin(req) && !req.query.mine ? db.prepare('SELECT p.*, t.name teacher_name FROM plans p LEFT JOIN teachers t ON t.id=p.teacher_id ORDER BY p.id DESC').all()
    : db.prepare('SELECT p.*, t.name teacher_name FROM plans p LEFT JOIN teachers t ON t.id=p.teacher_id WHERE p.teacher_id IS NULL OR p.teacher_id=? ORDER BY p.id DESC').all(req.user.id || 0);
  res.json(rows);
});
const SAFE_EXT = /\.(pdf|docx?|pptx?|xlsx?|txt|png|jpe?g|zip|mp4)$/i;
app.post('/api/plans', requirePerm('plans'), (req, res) => {
  const { teacher_id = null, title, content = '', file } = req.body;
  if (!title) return res.status(400).json({ error: 'عنوان لازم است' });
  let file_name = null, file_path = null;
  if (file && file.name && file.data) {
    if (!SAFE_EXT.test(file.name)) return res.status(400).json({ error: 'نوع فایل مجاز نیست' });
    file_name = file.name; file_path = crypto.randomBytes(8).toString('hex') + path.extname(file.name).toLowerCase();
    fs.writeFileSync(path.join(UPLOADS, file_path), Buffer.from(file.data, 'base64'));
  }
  const r = db.prepare('INSERT INTO plans(teacher_id,title,content,file_name,file_path) VALUES (?,?,?,?,?)').run(teacher_id || null, title, content, file_name, file_path);
  res.json({ id: Number(r.lastInsertRowid) });
});
app.put('/api/plans/:id', requirePerm('plans'), (req, res) => {
  const { teacher_id = null, title, content = '' } = req.body;
  db.prepare('UPDATE plans SET teacher_id=?,title=?,content=? WHERE id=?').run(teacher_id || null, title, content, req.params.id);
  res.json({ ok: true });
});
app.delete('/api/plans/:id', requirePerm('plans'), (req, res) => {
  const p = db.prepare('SELECT * FROM plans WHERE id=?').get(req.params.id);
  if (p?.file_path) { try { fs.unlinkSync(path.join(UPLOADS, p.file_path)); } catch {} }
  db.prepare('DELETE FROM plans WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});
app.get('/files/:id', requireAuth, (req, res) => {
  const p = db.prepare('SELECT * FROM plans WHERE id=?').get(req.params.id);
  if (!p || !p.file_path) return res.status(404).end();
  if (!isAdmin(req) && p.teacher_id && p.teacher_id !== req.user.id) return res.status(403).end();
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(p.file_name)}`);
  res.sendFile(path.join(UPLOADS, p.file_path));
});

// ---- payroll ----
app.get('/api/payroll', requireAuth, (req, res) => {
  if (isAdmin(req) && !hasPerm(req, 'payroll') && !req.user.teacher_id) return res.status(403).json({ error: 'دسترسی ندارید' });
  const from = req.query.from || '2000-01-01', to = req.query.to || '2100-01-01';
  const teachers = hasPerm(req, 'payroll') ? db.prepare('SELECT * FROM teachers ORDER BY name').all() : db.prepare('SELECT * FROM teachers WHERE id=?').all(req.user.id || 0);
  const out = teachers.map(t => {
    const reps = db.prepare('SELECT * FROM reports WHERE teacher_id=? AND date>=? AND date<=? ORDER BY date').all(t.id, from, to);
    const days = new Set(reps.map(r => r.date)).size;
    const hours = +reps.reduce((a, r) => a + hoursOf(r), 0).toFixed(2);
    const sessions = reps.length;
    const amount = Math.round(t.rate_fixed * days + t.rate_session * sessions + t.rate_hour * hours);
    const paid = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM payments WHERE teacher_id=? AND period_from>=? AND period_to<=?').get(t.id, from, to).s;
    return { teacher_id: t.id, name: t.name, color: t.color, rate_hour: t.rate_hour, rate_session: t.rate_session, rate_fixed: t.rate_fixed, days, sessions, hours, amount, paid, reports: reps.map(r => ({ id: r.id, date: r.date, check_in: r.check_in, check_out: r.check_out, hours: hoursOf(r), class_id: r.class_id })) };
  });
  res.json(out);
});
app.get('/api/payments', requireAuth, (req, res) => {
  res.json(hasPerm(req, 'payroll') ? db.prepare('SELECT p.*, t.name teacher_name FROM payments p LEFT JOIN teachers t ON t.id=p.teacher_id ORDER BY p.id DESC').all()
    : db.prepare('SELECT * FROM payments WHERE teacher_id=? ORDER BY id DESC').all(req.user.id));
});
app.post('/api/payments', requirePerm('payroll'), (req, res) => {
  const { teacher_id, period_from, period_to, amount, note = '' } = req.body;
  const r = db.prepare('INSERT INTO payments(teacher_id,period_from,period_to,amount,note) VALUES (?,?,?,?,?)').run(teacher_id, period_from, period_to, +amount || 0, note);
  res.json({ id: Number(r.lastInsertRowid) });
});
app.delete('/api/payments/:id', requirePerm('payroll'), (req, res) => { db.prepare('DELETE FROM payments WHERE id=?').run(req.params.id); res.json({ ok: true }); });

// ---- telegram ----
app.get('/api/telegram/me', requireAuth, (req, res) => {
  if (!req.user.teacher_id) return res.json({ linked: false });
  let t = db.prepare('SELECT tg_chat_id, tg_code FROM teachers WHERE id=?').get(req.user.teacher_id);
  if (!t.tg_chat_id && !t.tg_code) { const code = String(Math.floor(100000 + Math.random() * 900000)); db.prepare('UPDATE teachers SET tg_code=? WHERE id=?').run(code, req.user.teacher_id); t.tg_code = code; }
  res.json({ linked: !!t.tg_chat_id, code: t.tg_chat_id ? null : t.tg_code, bot: setting('tg_bot_username', 'hamraheteam_bot') });
});
app.post('/api/telegram/unlink', requireAuth, (req, res) => { if (req.user.teacher_id) db.prepare('UPDATE teachers SET tg_chat_id=NULL, tg_code=NULL WHERE id=?').run(req.user.teacher_id); res.json({ ok: true }); });
app.get('/api/telegram/status', requirePerm('settings'), (req, res) => res.json({ ...bot.status(), relay1: { url: setting('tg_relay1_url', ''), ip: setting('tg_relay1_ip', ''), insecure: setting('tg_relay1_insecure', '0'), enabled: setting('tg_relay1_enabled', '1'), has_secret: !!setting('tg_relay1_secret', '') }, relay2: { url: setting('tg_relay2_url', ''), ip: setting('tg_relay2_ip', ''), insecure: setting('tg_relay2_insecure', '0'), enabled: setting('tg_relay2_enabled', '1'), has_secret: !!setting('tg_relay2_secret', '') }, admin: setting('tg_admin', ''), bot: setting('tg_bot_username', 'hamraheteam_bot'), teachers: db.prepare('SELECT id,name,tg_chat_id IS NOT NULL linked FROM teachers').all() }));
app.put('/api/telegram/settings', requireMain, (req, res) => {
  for (const k of ['tg_token', 'tg_admin', 'tg_api_base', 'tg_bot_username', 'tg_relay1_url', 'tg_relay1_secret', 'tg_relay1_ip', 'tg_relay1_insecure', 'tg_relay1_enabled', 'tg_relay2_url', 'tg_relay2_secret', 'tg_relay2_ip', 'tg_relay2_insecure', 'tg_relay2_enabled']) if (k in req.body) db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(req.body[k] || ''));
  res.json({ ok: true });
});
app.post('/api/telegram/test', requirePerm('settings'), async (req, res) => {
  try { const st = bot.status(); if (!st.token) throw new Error('توکن ثبت نشده'); if (st.lastError) throw new Error(st.lastError); if (!st.polling) throw new Error('ربات فعال نیست'); res.json({ ok: true, result: { username: setting('tg_bot_username', 'hamraheteam_bot') } }); }
  catch (e) { res.status(502).json({ error: 'سرور به تلگرام دسترسی ندارد: ' + e.message }); }
});

app.use(express.static(path.join(__dirname, 'public'), { etag: true, setHeaders: res => res.setHeader('Cache-Control', 'no-cache') }));
app.get('/health', (req, res) => res.json({ ok: true }));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'خطای سرور' }); });
app.listen(PORT, '0.0.0.0', () => { console.log(`سرور روی http://localhost:${PORT} بالا آمد`); if (!process.env.NO_BOT) bot.poll(); });
