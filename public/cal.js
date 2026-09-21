/* Jalali calendar: date picker popup + helpers. Requires common.js (toJalali/toGregorian/jStr/jParse). */
const JMONTHS = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];
const JDAYS = ['ش', 'ی', 'د', 'س', 'چ', 'پ', 'ج'];
const jDaysInMonth = (jy, jm) => jm <= 6 ? 31 : jm <= 11 ? 30 : (jLeap(jy) ? 30 : 29);
const jLeap = jy => { const r = jy - (jy > 0 ? 474 : 473); const rr = (r % 2820) + 474; return ((rr + 38) * 682) % 2816 < 682; };
const dow = iso => (new Date(iso + 'T12:00:00').getDay() + 1) % 7; // 0=Sat
// official Iranian holidays inside the term (lunar ones approximate ±1 day; admin can toggle any day)
const HOLIDAYS_DEFAULT = {
  '2026-11-13': 'شهادت حضرت فاطمه (س) (تقریبی)', '2026-12-23': 'ولادت امام علی (ع) (تقریبی)', '2027-01-06': 'مبعث (تقریبی)', '2027-01-24': 'نیمه شعبان (تقریبی)',
  '2027-02-11': '۲۲ بهمن، پیروزی انقلاب', '2027-02-28': 'شهادت امام علی (ع) (تقریبی)', '2027-03-09': 'عید فطر (تقریبی)', '2027-03-10': 'تعطیل عید فطر (تقریبی)',
  '2027-03-20': '۲۹ اسفند، ملی شدن نفت', '2027-03-21': 'نوروز', '2027-03-22': 'نوروز', '2027-03-23': 'نوروز', '2027-03-24': 'نوروز', '2027-04-01': '۱۲ فروردین، روز جمهوری اسلامی', '2027-04-02': '۱۳ فروردین، طبیعت',
  '2027-04-03': 'شهادت امام صادق (ع) (تقریبی)', '2027-05-17': 'عید قربان (تقریبی)',
};

/* render one Jalali month grid; opts: {selected:Set<iso>, marks:{iso:{cls,title}}, onDay(iso,ev), min, max} */
function jMonthGrid(jy, jm, opts = {}) {
  const n = jDaysInMonth(jy, jm), first = toGregorian(jy, jm, 1), off = dow(first);
  let html = `<div class="jm"><div class="jm-h">${JMONTHS[jm - 1]} ${fa(jy)}</div><div class="jm-g">${JDAYS.map(d => `<span class="jm-d">${d}</span>`).join('')}`;
  for (let i = 0; i < off; i++) html += '<span></span>';
  for (let d = 1; d <= n; d++) {
    const iso = toGregorian(jy, jm, d), m = opts.marks?.[iso] || {}, out = (opts.min && iso < opts.min) || (opts.max && iso > opts.max);
    html += `<span class="jm-c ${out ? 'out' : ''} ${opts.selected?.has(iso) ? 'sel' : ''} ${m.cls || ''} ${iso === todayISO() ? 'today' : ''}" data-iso="${iso}" title="${esc(m.title || '')}">${fa(d)}${m.badge ? `<i>${m.badge}</i>` : ''}</span>`;
  }
  return html + '</div></div>';
}
/* popup picker attached to a jalaliInput text box */
function attachPicker(textInput, isoInput) {
  let pop = null;
  const close = () => { pop?.remove(); pop = null; document.removeEventListener('click', onDoc); };
  const onDoc = e => { if (pop && !pop.contains(e.target) && e.target !== textInput) close(); };
  const open = () => {
    close();
    let [jy, jm] = isoInput.value ? toJalali(isoInput.value) : toJalali(todayISO());
    pop = document.createElement('div'); pop.className = 'jpick';
    const draw = () => {
      pop.innerHTML = `<div class="jp-nav"><button type="button" data-n="-1">‹</button><span>${JMONTHS[jm - 1]} ${fa(jy)}</span><button type="button" data-n="1">›</button></div>` + jMonthGrid(jy, jm, { selected: new Set([isoInput.value]) }) + `<div class="jp-foot"><button type="button" data-t="1">امروز</button></div>`;
      pop.querySelectorAll('[data-n]').forEach(b => b.onclick = e => { e.stopPropagation(); jm += +b.dataset.n; if (jm < 1) { jm = 12; jy--; } if (jm > 12) { jm = 1; jy++; } draw(); });
      pop.querySelector('[data-t]').onclick = e => { e.stopPropagation(); setISO(isoInput, todayISO()); isoInput.dispatchEvent(new Event('change')); close(); };
      pop.querySelectorAll('.jm-c').forEach(c => c.onclick = e => { e.stopPropagation(); setISO(isoInput, c.dataset.iso); isoInput.dispatchEvent(new Event('change')); close(); });
    };
    draw();
    const r = textInput.getBoundingClientRect(); pop.style.top = (r.bottom + scrollY + 4) + 'px'; pop.style.left = Math.max(8, r.left + scrollX) + 'px';
    document.body.appendChild(pop); setTimeout(() => document.addEventListener('click', onDoc), 0);
  };
  textInput.onfocus = open; textInput.onclick = e => { e.stopPropagation(); if (!pop) open(); };
}
// upgrade jalaliInput: also attach picker
const _jalaliInput = jalaliInput;
jalaliInput = function (isoInput, opts) { const t = _jalaliInput(isoInput, opts); attachPicker(t, isoInput); t.readOnly = false; return t; };
