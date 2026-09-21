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
