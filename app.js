'use strict';

/* =========================================================
   Смета за 5 минут
   1. Документ   — тип, номер, дата, от кого / кому
   2. Позиции    — строки «кол-во × цена = сумма»
   3. Итоги      — скидка %, НДС % (сверху или в т.ч.)
   4. Сохранение — черновик в localStorage
   5. PDF        — печатная версия документа
   6. Отправка   — WhatsApp, Telegram, копирование, «Поделиться»
   ========================================================= */

const STORAGE_KEY = 'smeta-5min:v1';

const DOC_TYPES = {
  kp: {
    title: 'Коммерческое предложение',
    short: 'КП',
    from: 'Исполнитель',
    to: 'Клиент',
    fromPlaceholder: 'ИП Иванов А. А., +7 900 123-45-67',
    toPlaceholder: 'ООО «Ромашка»',
    signatures: ['Исполнитель'],
  },
  smeta: {
    title: 'Смета',
    short: 'Смета',
    from: 'Подготовил',
    to: 'Для кого',
    fromPlaceholder: 'Петрова М. И., офис-менеджер',
    toPlaceholder: 'Директору, Сидорову А. Б.',
    signatures: ['Подготовил', 'Согласовано'],
  },
};

// Оба примера дают одинаковые контрольные числа:
// сумма 40 000 → скидка 10 % = 4 000 → НДС 20 % = 7 200 → итого 43 200
const EXAMPLES = {
  kp: {
    from: 'ИП Иванов А. А., +7 900 123-45-67',
    to: 'ООО «Ромашка»',
    note: 'Срок выполнения — 5 рабочих дней. Предложение действует 14 дней.',
    items: [
      { name: 'Демонтаж старого покрытия', qty: '1', unit: 'усл.', price: '5000' },
      { name: 'Покраска стен', qty: '20', unit: 'м²', price: '1500' },
      { name: 'Грунтовка', qty: '2,5', unit: 'л', price: '2000' },
    ],
  },
  smeta: {
    from: 'Петрова М. И., офис-менеджер',
    to: 'Директору, Сидорову А. Б.',
    note: 'Закупка на следующий месяц. Доставка бесплатная, оплата по счёту.',
    items: [
      { name: 'Бумага А4, 500 листов', qty: '10', unit: 'упак.', price: '2500' },
      { name: 'Картридж для принтера', qty: '2', unit: 'шт', price: '6000' },
      { name: 'Ручки шариковые', qty: '30', unit: 'шт', price: '100' },
    ],
  },
};

/* ---------- Вспомогательные ---------- */

const $ = (sel, root = document) => root.querySelector(sel);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function todayISO() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

let uid = 0;
const newItem = (o = {}) => ({ name: '', qty: '1', unit: 'шт', price: '', ...o, id: ++uid });

/* ---------- Числа и расчёт ---------- */

// «1 500», «2,5», «2.5» → число; пусто → 0; мусор → NaN
function parseNum(raw) {
  const s = String(raw ?? '').replace(/[\s  ]/g, '').replace(',', '.');
  if (s === '') return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

function readNum(raw, max = Infinity) {
  const n = parseNum(raw);
  const bad = Number.isNaN(n) || n < 0 || n > max;
  return { n: bad ? 0 : n, bad };
}

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

function calc(s) {
  const lines = s.items.map((it) => {
    const q = readNum(it.qty);
    const p = readNum(it.price);
    return { qty: q.n, price: p.n, sum: round2(q.n * p.n), badQty: q.bad, badPrice: p.bad };
  });
  const subtotal = round2(lines.reduce((acc, l) => acc + l.sum, 0));
  const d = readNum(s.discount, 100);
  const v = readNum(s.vat, 100);
  const discount = round2((subtotal * d.n) / 100);
  const base = round2(subtotal - discount);
  const vat = s.vatIncluded ? round2((base * v.n) / (100 + v.n)) : round2((base * v.n) / 100);
  const total = s.vatIncluded ? base : round2(base + vat);
  return {
    lines, subtotal, base, total,
    discountPct: d.n, discount, badDiscount: d.bad,
    vatPct: v.n, vat, badVat: v.bad,
  };
}

/* ---------- Форматирование ---------- */

const nf0 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf3 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 });
const dateFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

function fmtNum(n) {
  const r = round2(n);
  return Number.isInteger(r) ? nf0.format(r) : nf2.format(r);
}
const fmtQty = (n) => nf3.format(n);
const money = (n) => `${fmtNum(n)} ${state.currency}`;
const pct = (n) => `${nf3.format(n)} %`;

function fmtDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  return m ? dateFmt.format(new Date(+m[1], +m[2] - 1, +m[3])) : '';
}

function heading() {
  const t = DOC_TYPES[state.docType];
  const date = fmtDate(state.date);
  return [t.title, state.number.trim() && `№ ${state.number.trim()}`, date && `от ${date}`]
    .filter(Boolean).join(' ');
}

// Строки итогов. compact — для PDF и сообщения: не повторяем «Сумму», если она равна «Итого».
function totalRows(c, compact = false) {
  const rows = [];
  const vatOnTop = c.vatPct > 0 && !state.vatIncluded;
  if (!compact || c.discountPct > 0 || vatOnTop) rows.push({ label: 'Сумма позиций', value: money(c.subtotal) });
  if (c.discountPct > 0) rows.push({ label: `Скидка ${pct(c.discountPct)}`, value: `−${money(c.discount)}` });
  if (vatOnTop) rows.push({ label: `НДС ${pct(c.vatPct)}`, value: money(c.vat) });
  rows.push({ label: 'Итого', value: money(c.total), cls: 't-total' });
  if (c.vatPct > 0 && state.vatIncluded) rows.push({ label: `в т.ч. НДС ${pct(c.vatPct)}`, value: money(c.vat), cls: 't-sub' });
  return rows;
}

// Позиции, которые попадут в документ (пустые строки пропускаем)
function filledItems(c) {
  return state.items
    .map((it, i) => ({ it, line: c.lines[i] }))
    .filter(({ it, line }) => it.name.trim() || line.sum > 0);
}

/* ---------- Состояние и сохранение ---------- */

function defaultState() {
  return {
    docType: 'kp',
    number: '1',
    date: todayISO(),
    from: '',
    to: '',
    currency: '₽',
    discount: '',
    vat: '',
    vatIncluded: false,
    note: '',
    items: [newItem()],
  };
}

function load() {
  const d = defaultState();
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (!s || typeof s !== 'object') return d;
    const str = (v, def) => (typeof v === 'string' ? v : def);
    return {
      docType: DOC_TYPES[s.docType] ? s.docType : d.docType,
      number: str(s.number, d.number),
      date: str(s.date, d.date),
      from: str(s.from, ''),
      to: str(s.to, ''),
      currency: str(s.currency, d.currency),
      discount: str(s.discount, ''),
      vat: str(s.vat, ''),
      vatIncluded: s.vatIncluded === true,
      note: str(s.note, ''),
      items: Array.isArray(s.items)
        ? s.items.map((it) => newItem({
          name: str(it?.name, ''), qty: str(it?.qty, ''), unit: str(it?.unit, ''), price: str(it?.price, ''),
        }))
        : d.items,
    };
  } catch {
    return d;
  }
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* приватный режим или запрет хранилища — просто работаем без автосохранения */
  }
}

const hasContent = () => Boolean(
  state.to.trim() || state.note.trim() || state.items.some((it) => it.name.trim() || it.price.trim()),
);

/* ---------- Отрисовка ---------- */

let state = defaultState();
let itemsEl = null;

function rowHTML(it, i) {
  return `
  <div class="row" data-id="${it.id}">
    <span class="row-num">${i + 1}</span>
    <label class="cell cell-name"><span class="cell-label">Наименование, позиция ${i + 1}</span>
      <input data-field="name" value="${esc(it.name)}" placeholder="Например, покраска стен" autocomplete="off"></label>
    <label class="cell cell-qty"><span class="cell-label">Кол-во</span>
      <input data-field="qty" value="${esc(it.qty)}" class="num" inputmode="decimal" autocomplete="off" placeholder="1"></label>
    <label class="cell cell-unit"><span class="cell-label">Ед.</span>
      <input data-field="unit" value="${esc(it.unit)}" list="units" autocomplete="off" placeholder="шт"></label>
    <label class="cell cell-price"><span class="cell-label">Цена</span>
      <input data-field="price" value="${esc(it.price)}" class="num" inputmode="decimal" autocomplete="off" placeholder="0"></label>
    <div class="cell cell-sum"><span class="cell-label">Сумма</span><output class="sum">0</output></div>
    <button type="button" class="row-del" aria-label="Удалить позицию ${i + 1}" title="Удалить позицию">×</button>
  </div>`;
}

function renderItems() {
  itemsEl.innerHTML = state.items.map(rowHTML).join('');
}

function renderDocType() {
  const t = DOC_TYPES[state.docType];
  $('#l-from').textContent = t.from;
  $('#l-to').textContent = t.to;
  $('#f-from').placeholder = t.fromPlaceholder;
  $('#f-to').placeholder = t.toPlaceholder;
}

function renderAll() {
  document.querySelectorAll('[data-key]').forEach((el) => {
    const key = el.dataset.key;
    if (el.type === 'checkbox') {
      el.checked = Boolean(state[key]);
    } else {
      el.value = state[key] ?? '';
      if (el.tagName === 'SELECT' && el.value !== state[key]) state[key] = el.value; // неизвестная валюта → первая из списка
    }
  });
  document.querySelectorAll('input[name="docType"]').forEach((r) => { r.checked = r.value === state.docType; });
  renderDocType();
  renderItems();
  refresh();
}

function markInvalid(el, bad, hint) {
  if (bad) {
    el.setAttribute('aria-invalid', 'true');
    el.title = hint;
  } else {
    el.removeAttribute('aria-invalid');
    el.removeAttribute('title');
  }
}

// Пересчёт без перерисовки полей — курсор и фокус остаются на месте
function refresh() {
  const c = calc(state);
  [...itemsEl.children].forEach((row, i) => {
    const line = c.lines[i];
    if (!line) return;
    row.querySelector('.sum').textContent = fmtNum(line.sum);
    markInvalid(row.querySelector('[data-field="qty"]'), line.badQty, 'Введите число, например 2 или 2,5');
    markInvalid(row.querySelector('[data-field="price"]'), line.badPrice, 'Введите число, например 1500');
  });
  markInvalid($('#f-discount'), c.badDiscount, 'Скидка — число от 0 до 100');
  markInvalid($('#f-vat'), c.badVat, 'НДС — число от 0 до 100');

  $('#items-empty').hidden = state.items.length > 0;
  $('#h-price').textContent = `Цена, ${state.currency}`;
  $('#h-sum').textContent = `Сумма, ${state.currency}`;
  $('#totals').innerHTML = totalRows(c)
    .map((r) => `<div class="t-row ${r.cls || ''}"><dt>${esc(r.label)}</dt><dd>${esc(r.value)}</dd></div>`)
    .join('');
  $('#sticky-total').textContent = money(c.total);
}

function renderPrint() {
  const c = calc(state);
  const t = DOC_TYPES[state.docType];
  const date = fmtDate(state.date);
  const parties = [[t.from, state.from], [t.to, state.to]]
    .filter(([, v]) => v.trim())
    .map(([label, v]) => `<div><dt>${esc(label)}</dt><dd>${esc(v.trim())}</dd></div>`)
    .join('');
  const rows = filledItems(c).map(({ it, line }, i) => `
    <tr>
      <td class="n">${i + 1}</td>
      <td>${esc(it.name.trim() || '—')}</td>
      <td class="num">${fmtQty(line.qty)}</td>
      <td>${esc(it.unit.trim())}</td>
      <td class="num">${fmtNum(line.price)}</td>
      <td class="num">${fmtNum(line.sum)}</td>
    </tr>`).join('');
  const totals = totalRows(c, true)
    .map((r) => `<tr class="${r.cls || ''}"><td>${esc(r.label)}</td><td>${esc(r.value)}</td></tr>`)
    .join('');
  const signs = t.signatures
    .map((s) => `<div class="doc-sign"><span>${esc(s)}</span><span class="doc-sign-line"></span></div>`)
    .join('');
  const cur = esc(state.currency);

  $('#print').innerHTML = `
  <article class="doc">
    <h1>${esc(t.title)}${state.number.trim() ? ` № ${esc(state.number.trim())}` : ''}</h1>
    <p class="doc-date">${date ? `от ${esc(date)}` : ''}</p>
    ${parties ? `<dl class="doc-parties">${parties}</dl>` : ''}
    <table class="doc-table">
      <thead><tr>
        <th class="n">№</th><th>Наименование</th><th class="num">Кол-во</th><th>Ед.</th>
        <th class="num">Цена, ${cur}</th><th class="num">Сумма, ${cur}</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <table class="doc-totals"><tbody>${totals}</tbody></table>
    ${state.note.trim() ? `<p class="doc-note">${esc(state.note.trim())}</p>` : ''}
    <div class="doc-signs">${signs}</div>
  </article>`;
}

/* ---------- Текст для мессенджера ---------- */

function buildText() {
  const c = calc(state);
  const t = DOC_TYPES[state.docType];
  const out = [heading()];
  if (state.from.trim()) out.push(`${t.from}: ${state.from.trim()}`);
  if (state.to.trim()) out.push(`${t.to}: ${state.to.trim()}`);
  out.push('');
  filledItems(c).forEach(({ it, line }, i) => {
    const qty = [fmtQty(line.qty), it.unit.trim()].filter(Boolean).join(' ');
    out.push(`${i + 1}. ${it.name.trim() || 'Без названия'} — ${qty} × ${money(line.price)} = ${money(line.sum)}`);
  });
  out.push('');
  totalRows(c, true).forEach((r) => out.push(`${r.label}: ${r.value}`));
  if (state.note.trim()) out.push('', state.note.trim());
  return out.join('\n');
}

/* ---------- Действия ---------- */

function commit() {
  refresh();
  save();
}

function addItem() {
  state.items.push(newItem());
  renderItems();
  commit();
  itemsEl.lastElementChild.querySelector('[data-field="name"]').focus();
}

function removeItem(id) {
  const index = state.items.findIndex((it) => String(it.id) === id);
  if (index < 0) return;
  const [item] = state.items.splice(index, 1);
  renderItems();
  commit();
  const next = itemsEl.children[index] || itemsEl.lastElementChild;
  (next ? next.querySelector('[data-field="name"]') : $('#btn-add')).focus();

  if (!item.name.trim() && !item.price.trim()) return; // пустую строку удаляем молча
  toast(`Удалено: ${item.name.trim() || 'позиция без названия'}`, 'Вернуть', () => {
    state.items.splice(Math.min(index, state.items.length), 0, item);
    renderItems();
    commit();
  });
}

function onItemsKeydown(e) {
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
  const input = e.target.closest('input[data-field]');
  if (!input) return;
  e.preventDefault();
  const inputs = [...itemsEl.querySelectorAll('input[data-field]')];
  const next = inputs[inputs.indexOf(input) + 1];
  if (next) {
    next.focus();
    next.select();
  } else {
    addItem();
  }
}

function fillExample() {
  if (hasContent() && !confirm('Заменить текущий документ примером?')) return;
  const ex = EXAMPLES[state.docType];
  Object.assign(state, {
    from: ex.from,
    to: ex.to,
    note: ex.note,
    date: todayISO(),
    discount: '10',
    vat: '20',
    vatIncluded: false,
    items: ex.items.map((it) => newItem(it)),
  });
  renderAll();
  save();
  toast(`Проверка: итого должно быть 43 200 ${state.currency}`);
}

function newDocument() {
  if (hasContent() && !confirm('Начать новый документ? Позиции и получатель очистятся, ваши данные останутся.')) return;
  const num = state.number.trim();
  Object.assign(state, {
    number: hasContent() && /^\d+$/.test(num) ? String(Number(num) + 1) : num,
    date: todayISO(),
    to: '',
    note: '',
    discount: '',
    items: [newItem()],
  });
  renderAll();
  save();
  (state.from.trim() ? $('#f-to') : $('#f-from')).focus();
}

// Перед отправкой: есть хотя бы одна позиция и нет красных полей
function ready() {
  const c = calc(state);
  const bad = c.badDiscount || c.badVat || c.lines.some((l) => l.badQty || l.badPrice);
  if (bad) {
    toast('Исправьте поля, выделенные красным');
    $('[aria-invalid="true"]')?.focus();
    return false;
  }
  if (!filledItems(c).length) {
    toast('Добавьте хотя бы одну позицию');
    (itemsEl.querySelector('[data-field="name"]') || $('#btn-add')).focus();
    return false;
  }
  return true;
}

function fileName() {
  const t = DOC_TYPES[state.docType];
  const name = [t.short, state.number.trim() && `№${state.number.trim()}`, state.to.trim()]
    .filter(Boolean).join(' ')
    .replace(/[\\/:*?"<>|«»]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return name || 'Смета';
}

function savePdf() {
  if (!ready()) return;
  renderPrint();
  const prevTitle = document.title;
  document.title = fileName(); // браузер предложит это имя для PDF
  window.addEventListener('afterprint', () => { document.title = prevTitle; }, { once: true });
  window.print();
}

function openLink(url) {
  window.open(url, '_blank', 'noopener');
}

function sendWhatsApp() {
  if (!ready()) return;
  openLink(`https://wa.me/?text=${encodeURIComponent(buildText())}`);
}

function sendTelegram() {
  if (!ready()) return;
  const [first, ...rest] = buildText().split('\n');
  openLink(`https://t.me/share/url?url=${encodeURIComponent(first)}&text=${encodeURIComponent(rest.join('\n'))}`);
}

async function copyText() {
  if (!ready()) return;
  const text = buildText();
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text, readOnly: true });
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('Текст скопирован — вставьте его в любой мессенджер');
}

function shareText() {
  if (!ready()) return;
  navigator.share({ title: heading(), text: buildText() }).catch(() => { /* пользователь закрыл окно */ });
}

/* ---------- Подсказка-тост ---------- */

let toastTimer = 0;

function hideToast() {
  $('#toast').classList.remove('show');
}

function toast(message, actionLabel, action) {
  const el = $('#toast');
  el.replaceChildren(Object.assign(document.createElement('span'), { textContent: message }));
  if (actionLabel) {
    const btn = Object.assign(document.createElement('button'), { type: 'button', textContent: actionLabel });
    btn.addEventListener('click', () => { action(); hideToast(); });
    el.append(btn);
  }
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, actionLabel ? 6000 : 3500);
}

/* ---------- Запуск ---------- */

function bind() {
  document.querySelectorAll('[data-key]').forEach((el) => {
    const evt = el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(evt, () => {
      state[el.dataset.key] = el.type === 'checkbox' ? el.checked : el.value;
      commit();
    });
  });

  document.querySelectorAll('input[name="docType"]').forEach((r) => {
    r.addEventListener('change', () => {
      state.docType = r.value;
      renderDocType();
      commit();
    });
  });

  itemsEl.addEventListener('input', (e) => {
    const input = e.target.closest('[data-field]');
    if (!input) return;
    const item = state.items.find((it) => String(it.id) === input.closest('.row').dataset.id);
    if (!item) return;
    item[input.dataset.field] = input.value;
    commit();
  });
  itemsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.row-del');
    if (btn) removeItem(btn.closest('.row').dataset.id);
  });
  itemsEl.addEventListener('keydown', onItemsKeydown);

  $('#btn-add').addEventListener('click', addItem);
  $('#btn-example').addEventListener('click', fillExample);
  $('#btn-new').addEventListener('click', newDocument);
  $('#btn-pdf').addEventListener('click', savePdf);
  $('#btn-wa').addEventListener('click', sendWhatsApp);
  $('#btn-tg').addEventListener('click', sendTelegram);
  $('#btn-copy').addEventListener('click', copyText);
  $('#btn-share').addEventListener('click', shareText);

  window.addEventListener('beforeprint', renderPrint); // Ctrl/Cmd+P тоже печатает документ, а не форму
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideToast(); });
}

function focusFirstEmpty() {
  if (!window.matchMedia('(pointer: fine)').matches) return; // на телефоне не открываем клавиатуру сами
  const fields = [$('#f-from'), $('#f-to'), ...itemsEl.querySelectorAll('[data-field="name"]')];
  fields.find((el) => !el.value.trim())?.focus();
}

function init() {
  state = load();
  itemsEl = $('#items');
  $('#btn-share').hidden = typeof navigator.share !== 'function';
  bind();
  renderAll();
  focusFirstEmpty();
}

if (typeof document !== 'undefined') init();
