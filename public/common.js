// helpers shared by all pages
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fa = n => String(n).replace(/\d/g, d => '۰۱۲۳۴۵۶۷۸۹'[d]);

async function api(url, method = 'GET', body) {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401) { location.href = '/'; throw new Error('unauthorized'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(data.error || 'خطا'); e.status = r.status; e.data = data; throw e; }
  return data;
}

let toastT;
function toast(msg, kind = '') {
  let el = $('.toast'); if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = msg; el.className = 'toast show ' + kind;
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('show'), 2800);
}

function openModal(html) { $('#overlay').innerHTML = `<div class="modal">${html}</div>`; $('#overlay').classList.add('show'); }
function closeModal() { $('#overlay').classList.remove('show'); $('#overlay').innerHTML = ''; }
document.addEventListener('click', e => { if (e.target.id === 'overlay') closeModal(); });

async function logout() { await api('/api/logout', 'POST'); location.href = '/'; }

// today as YYYY-MM-DD and Persian date string
const todayISO = () => new Date().toISOString().slice(0, 10);
const faDate = iso => { try { return new Intl.DateTimeFormat('fa-IR', { dateStyle: 'medium' }).format(new Date(iso)); } catch { return iso; } };
// JS getDay: 0=Sun..6=Sat -> our index 0=Sat..6=Fri
const todayDayIndex = () => (new Date().getDay() + 1) % 7;

// ---- Jalali <-> Gregorian ----
function toJalali(iso) {
  const [gy, gm, gd] = iso.split('-').map(Number);
  const g_d_m = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  let jy = gy <= 1600 ? 0 : 979, gy2 = gy <= 1600 ? gy - 621 : gy - 1600;
  const gy3 = gm > 2 ? gy2 + 1 : gy2;
  let days = 365 * gy2 + Math.floor((gy3 + 3) / 4) - Math.floor((gy3 + 99) / 100) + Math.floor((gy3 + 399) / 400) - 80 + gd + g_d_m[gm - 1];
  jy += 33 * Math.floor(days / 12053); days %= 12053; jy += 4 * Math.floor(days / 1461); days %= 1461;
  if (days > 365) { jy += Math.floor((days - 1) / 365); days = (days - 1) % 365; }
  const jm = days < 186 ? 1 + Math.floor(days / 31) : 7 + Math.floor((days - 186) / 30);
  const jd = 1 + (days < 186 ? days % 31 : (days - 186) % 30);
  return [jy, jm, jd];
}
function toGregorian(jy, jm, jd) {
  let gy = jy <= 979 ? 621 : 1600; jy -= jy <= 979 ? 0 : 979;
  let days = 365 * jy + Math.floor(jy / 33) * 8 + Math.floor(((jy % 33) + 3) / 4) + 78 + jd + (jm < 7 ? (jm - 1) * 31 : (jm - 7) * 30 + 186);
  gy += 400 * Math.floor(days / 146097); days %= 146097;
  if (days > 36524) { gy += 100 * Math.floor(--days / 36524); days %= 36524; if (days >= 365) days++; }
  gy += 4 * Math.floor(days / 1461); days %= 1461;
  if (days > 365) { gy += Math.floor((days - 1) / 365); days = (days - 1) % 365; }
  let gd = days + 1; const sal = [0, 31, (gy % 4 === 0 && gy % 100 !== 0) || gy % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let gm = 0; for (gm = 1; gm <= 12 && gd > sal[gm]; gm++) gd -= sal[gm];
  return `${gy}-${String(gm).padStart(2, '0')}-${String(gd).padStart(2, '0')}`;
}
const jStr = iso => { if (!iso) return ''; const [y, m, d] = toJalali(iso); return `${y}/${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}`; };
const jParse = s => { const m = String(s || '').replace(/[۰-۹]/g, c => '۰۱۲۳۴۵۶۷۸۹'.indexOf(c)).match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/); if (!m) return null; const [, y, mo, d] = m.map(Number); if (mo < 1 || mo > 12 || d < 1 || d > 31) return null; return toGregorian(y, mo, d); };
// turn a hidden ISO input into a visible Jalali text box
function jalaliInput(isoInput, opts = {}) {
  const t = document.createElement('input'); t.dir = 'ltr'; t.placeholder = '1405/07/01'; t.style.textAlign = 'center'; t.className = isoInput.className;
  const sync = () => { t.value = jStr(isoInput.value); };
  t.onchange = () => { const iso = jParse(t.value); if (iso) { isoInput.value = iso; isoInput.dispatchEvent(new Event('change')); } sync(); };
  isoInput.type = 'hidden'; isoInput.insertAdjacentElement('afterend', t); sync();
  isoInput._j = t; return t;
}
const setISO = (input, iso) => { input.value = iso; if (input._j) input._j.value = jStr(iso); };

// ---- theme (light/dark), remembered per browser ----
(function () { try { const t = localStorage.getItem('theme'); if (t) document.documentElement.dataset.theme = t; } catch {} })();
function toggleTheme() { const d = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = d; try { localStorage.setItem('theme', d); } catch {} const ic = document.getElementById('theme-ic'); if (ic) ic.textContent = d === 'dark' ? '☀️' : '🌙'; }
document.addEventListener('DOMContentLoaded', () => { const ic = document.getElementById('theme-ic'); if (ic) ic.textContent = document.documentElement.dataset.theme === 'dark' ? '☀️' : '🌙'; });
