// Lógica pura (sin DOM ni base de datos): importes, fechas, CSV/JSON y totales.

export const CATEGORIES = [
  { name: 'Comida', emoji: '🍽️' },
  { name: 'Supermercado', emoji: '🛒' },
  { name: 'Transporte', emoji: '🚗' },
  { name: 'Casa', emoji: '🏠' },
  { name: 'Suscripciones', emoji: '🔁' },
  { name: 'Ocio', emoji: '🎉' },
  { name: 'Salud', emoji: '💊' },
  { name: 'Ropa', emoji: '👕' },
  { name: 'Agencia', emoji: '💼' },
  { name: 'Otros', emoji: '📦' },
];
export const INCOME_CATEGORIES = [
  { name: 'Sueldo', emoji: '💰' },
  { name: 'Agencia', emoji: '💼' },
  { name: 'Otros ingresos', emoji: '➕' },
];
export const METHODS = ['Tarjeta', 'Efectivo', 'Bizum', 'Transferencia'];
// Ámbito de un movimiento: 'personal' (por defecto) o 'business' (la agencia).
export const scopeOf = (e) => (e.scope === 'business' ? 'business' : 'personal');
export const scopeLabel = (scope) => (scope === 'business' ? 'Agencia' : scope === 'personal' ? 'Personal' : 'Todo');
/**
 * Movimientos de lo que se está viendo: '' todos, 'personal', 'business' o 'g:<id>' (un grupo).
 * Un movimiento de un grupo cuenta también en el ámbito del grupo (Personal o Agencia).
 */
export const inScope = (expenses, view) => {
  if (!view) return expenses;
  if (view.startsWith('g:')) { const id = view.slice(2); return expenses.filter((e) => e.group === id); }
  return expenses.filter((e) => scopeOf(e) === view);
};

/** Limpia la lista de grupos { id, name, emoji, scope }: un viaje, un proyecto... dentro de Personal o Agencia. */
export function normalizeGroups(raw) {
  const out = [];
  const seen = new Set();
  for (const g of Array.isArray(raw) ? raw : []) {
    const name = String((g && g.name) || '').trim().slice(0, 24);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({
      id: String(g.id || crypto.randomUUID()), name, scope: scopeOf(g),
      emoji: [...String(g.emoji || '').trim()].slice(0, 4).join('') || '📁',
    });
  }
  return out;
}

// ---------- Categorías (editables) ----------
const DEFAULT_CATEGORIES = [
  ...CATEGORIES.map((c) => ({ ...c, type: 'expense' })),
  ...INCOME_CATEGORIES.map((c) => ({ ...c, type: 'income' })),
];

/** Limpia una lista de categorías { name, emoji, type }. Garantiza al menos una de gasto y una de ingreso. */
export function normalizeCategories(raw) {
  const out = [];
  const seen = new Set();
  for (const c of Array.isArray(raw) ? raw : []) {
    const name = String((c && c.name) || '').trim().slice(0, 24);
    const type = c && c.type === 'income' ? 'income' : 'expense';
    if (!name || seen.has(type + '|' + name.toLowerCase())) continue;
    seen.add(type + '|' + name.toLowerCase());
    out.push({ name, emoji: [...String((c && c.emoji) || '').trim()].slice(0, 4).join('') || '📦', type });
  }
  for (const type of ['expense', 'income']) {
    if (!out.some((c) => c.type === type)) out.push(...DEFAULT_CATEGORIES.filter((c) => c.type === type));
  }
  return out;
}

let categories = DEFAULT_CATEGORIES;
/** Cambia la lista de categorías en uso (null o vacío vuelve a las de fábrica). */
export function setCategories(list) {
  categories = list && list.length ? normalizeCategories(list) : DEFAULT_CATEGORIES;
}
export const getCategories = () => categories;
export const categoriesFor = (type) => categories.filter((c) => c.type === (type === 'income' ? 'income' : 'expense'));
export const emojiFor = (category) => (categories.find((c) => c.name === category) || { emoji: '📦' }).emoji;

/** Limpia la lista de botones rápidos: { id, amount, category, method, note, type, scope }. */
export function normalizeFavorites(raw) {
  const out = [];
  for (const f of Array.isArray(raw) ? raw : []) {
    if (!f || !Number.isInteger(f.amount) || f.amount <= 0) continue;
    const type = f.type === 'income' ? 'income' : 'expense';
    out.push({
      id: String(f.id || crypto.randomUUID()), amount: f.amount, type, scope: scopeOf(f),
      category: String(f.category || (type === 'income' ? 'Otros ingresos' : 'Otros')).trim(),
      method: String(f.method || METHODS[0]).trim() || METHODS[0],
      note: String(f.note || '').trim().slice(0, 120),
    });
  }
  return out;
}

const eur = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', useGrouping: 'always' });
export const formatCents = (cents) => eur.format(cents / 100);

/** "2,50", "2.50", "1.234,56", "3 €" -> céntimos (entero). Devuelve null si no es un importe válido > 0. */
export function parseAmount(text) {
  let s = String(text ?? '').replace(/[\s€]/g, '');
  if (!s) return null;
  const comma = s.lastIndexOf(',');
  const dot = s.lastIndexOf('.');
  if (comma > -1 && dot > -1) {
    // El último separador es el decimal; el otro es de miles.
    s = comma > dot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (comma > -1) {
    s = s.replace(',', '.');
  }
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(s)) return null;
  const cents = Math.round(parseFloat(s) * 100);
  return cents > 0 ? cents : null;
}

/** Céntimos -> "12,50" (para formularios y CSV). */
export const centsToInput = (cents) => (cents / 100).toFixed(2).replace('.', ',');

export function todayISO(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
export const isISODate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

export function shiftMonth(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
export function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });
}
export function dayLabel(iso, withYear = false) {
  const [y, m, d] = iso.split('-').map(Number);
  const opts = { weekday: 'long', day: 'numeric', month: 'short' };
  if (withYear) opts.year = 'numeric';
  return new Date(y, m - 1, d).toLocaleDateString('es-ES', opts);
}
export function shortMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('es-ES', { month: 'short' }).replace('.', '');
}

/** Resumen de un mes: movimientos ordenados, total de gastos, ingresos, balance y gastos por categoría. */
export function summarize(expenses, ym) {
  const items = expenses
    .filter((e) => e.date.startsWith(ym))
    .sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || '').localeCompare(a.createdAt || ''));
  let total = 0, income = 0;
  const map = new Map();
  for (const e of items) {
    if (e.type === 'income') { income += e.amount; continue; }
    total += e.amount;
    map.set(e.category, (map.get(e.category) || 0) + e.amount);
  }
  const byCategory = [...map].map(([category, amount]) => ({ category, amount })).sort((a, b) => b.amount - a.amount);
  return { items, total, income, balance: income - total, byCategory };
}

/** Nivel de un presupuesto: 'over' desde el 100 %, 'warn' desde el 80 %, 'ok' por debajo. */
export const budgetLevel = (spent, budget) => (!budget ? null : spent >= budget ? 'over' : spent * 100 >= budget * 80 ? 'warn' : 'ok');

/** Filas para pintar el desglose: categorías con gasto más las que tienen presupuesto aunque no tengan gasto. */
export function budgetRows(byCategory, budgets = {}) {
  const rows = byCategory.map((r) => ({ ...r }));
  for (const category of Object.keys(budgets)) {
    if (budgets[category] > 0 && !rows.some((r) => r.category === category)) rows.push({ category, amount: 0 });
  }
  return rows.map((r) => {
    const budget = budgets[r.category] > 0 ? budgets[r.category] : null;
    return { ...r, budget, pct: budget ? Math.round((r.amount / budget) * 100) : null, level: budgetLevel(r.amount, budget) };
  });
}

/** Limpia un mapa de presupuestos { categoría: céntimos }. */
export function normalizeBudgets(raw) {
  const out = {};
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) if (Number.isInteger(v) && v > 0) out[String(k)] = v;
  }
  return out;
}

// ---------- Etiquetas, búsqueda y series para gráficos ----------
/** Etiquetas de una nota: las palabras que empiezan por #. "cena #Viaje #lisboa" -> ['viaje', 'lisboa'] */
export function tagsOf(note) {
  const found = String(note || '').match(/#[\p{L}\p{N}_-]+/gu) || [];
  return [...new Set(found.map((t) => t.slice(1).toLowerCase()))];
}

const fold = (text) => String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/**
 * Filtra movimientos. Todos los criterios son opcionales:
 * { query, category, method, tag, ym }. La búsqueda ignora mayúsculas y acentos
 * y mira nota, categoría, método e importe ("12,50").
 */
export function filterExpenses(expenses, { query = '', category = '', method = '', tag = '', ym = '' } = {}) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  return expenses.filter((e) => {
    if (ym && !e.date.startsWith(ym)) return false;
    if (category && e.category !== category) return false;
    if (method && e.method !== method) return false;
    if (tag && !tagsOf(e.note).includes(tag)) return false;
    if (!words.length) return true;
    const haystack = fold(`${e.note} ${e.category} ${e.method} ${centsToInput(e.amount)}`);
    return words.every((w) => haystack.includes(w));
  });
}

export const sortNewestFirst = (list) =>
  [...list].sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || '').localeCompare(a.createdAt || ''));

/** Gastos e ingresos de los últimos n meses hasta endYm (incluido). Con categoría, solo gastos de esa categoría. */
export function monthlySeries(expenses, endYm, n = 6, category = '') {
  const months = [];
  for (let i = n - 1; i >= 0; i--) months.push({ ym: shiftMonth(endYm, -i), expense: 0, income: 0 });
  const byYm = new Map(months.map((m) => [m.ym, m]));
  for (const e of expenses) {
    const m = byYm.get(e.date.slice(0, 7));
    if (!m) continue;
    if (e.type === 'income') { if (!category) m.income += e.amount; }
    else if (!category || e.category === category) m.expense += e.amount;
  }
  return months;
}

/** Tope "redondo" para el eje: 1, 2 o 5 por una potencia de 10 (en céntimos). */
export function niceMax(cents) {
  if (cents <= 1000) return 1000; // como mínimo, un eje de 10 €
  const pow = 10 ** Math.floor(Math.log10(cents));
  const lead = cents / pow;
  return (lead <= 1 ? 1 : lead <= 2 ? 2 : lead <= 5 ? 5 : 10) * pow;
}

// ---------- Recurrentes ----------
const isYM = (s) => /^\d{4}-(0[1-9]|1[0-2])$/.test(s);

/** Valida un recurrente: { id, amount, category, method, note, type, day, lastGenerated }. */
export function normalizeRecurring(raw) {
  const amount = typeof raw.amount === 'number' && Number.isInteger(raw.amount) ? raw.amount : parseAmount(raw.amount);
  if (!amount || amount <= 0) throw new Error('Importe no válido');
  const day = Number(raw.day);
  if (!Number.isInteger(day) || day < 1 || day > 31) throw new Error('Día no válido');
  if (!isYM(raw.lastGenerated)) throw new Error('Mes no válido');
  const type = raw.type === 'income' ? 'income' : 'expense';
  return {
    id: raw.id || crypto.randomUUID(),
    updatedAt: raw.updatedAt || new Date().toISOString(),
    amount, day, type, scope: scopeOf(raw), lastGenerated: raw.lastGenerated,
    category: String(raw.category || (type === 'income' ? 'Otros ingresos' : 'Otros')).trim(),
    method: String(raw.method || METHODS[0]).trim() || METHODS[0],
    note: String(raw.note || '').trim().slice(0, 120),
  };
}

const daysInMonth = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(y, m, 0).getDate(); };

/**
 * Movimientos recurrentes que tocan hasta hoy y aún no se han generado.
 * El id de cada movimiento es "<id del recurrente>-<mes>", así nunca se duplica.
 * Devuelve { expenses, recurring } con los recurrentes ya actualizados.
 */
export function dueRecurring(recurring, today = todayISO(), existingIds = new Set()) {
  const expenses = [];
  const updated = recurring.map((rec) => {
    if (rec.deleted) return rec;
    let last = rec.lastGenerated;
    for (let i = 0; i < 240; i++) {
      const ym = shiftMonth(last, 1);
      const date = `${ym}-${String(Math.min(rec.day, daysInMonth(ym))).padStart(2, '0')}`;
      if (date > today) break;
      const id = `${rec.id}-${ym}`;
      // La fecha de alta es fija (el día que toca): así dos dispositivos generan exactamente lo mismo
      // y un borrado o una edición posterior siempre gana al sincronizar.
      const stamp = `${date}T00:00:00.000Z`;
      if (!existingIds.has(id)) {
        expenses.push(normalizeExpense({
          id, amount: rec.amount, category: rec.category, method: rec.method,
          note: rec.note, type: rec.type, scope: rec.scope, date, recurringId: rec.id, createdAt: stamp, updatedAt: stamp,
        }));
      }
      last = ym;
    }
    return last === rec.lastGenerated ? rec : { ...rec, lastGenerated: last };
  });
  return { expenses, recurring: updated };
}

/** Valida y normaliza un gasto que viene de un formulario o de una importación. Lanza Error si no vale. */
export function normalizeExpense(raw) {
  const amount = typeof raw.amount === 'number' && Number.isInteger(raw.amount) ? raw.amount : parseAmount(raw.amount);
  if (!amount || amount <= 0) throw new Error('Importe no válido');
  if (!isISODate(raw.date)) throw new Error('Fecha no válida');
  const now = new Date().toISOString();
  const type = raw.type === 'income' ? 'income' : 'expense';
  const fallback = type === 'income' ? 'Otros ingresos' : 'Otros';
  const expense = {
    id: raw.id || crypto.randomUUID(),
    type,
    scope: scopeOf(raw),
    amount,
    category: String(raw.category || fallback).trim() || fallback,
    date: raw.date,
    method: String(raw.method || METHODS[0]).trim() || METHODS[0],
    note: String(raw.note || '').trim().slice(0, 120),
    createdAt: raw.createdAt || now,
    updatedAt: raw.updatedAt || now,
  };
  if (raw.recurringId) expense.recurringId = String(raw.recurringId);
  if (raw.group) expense.group = String(raw.group);
  return expense;
}

// ---------- CSV (separador ";" y coma decimal: abre bien en Excel en español) ----------
const CSV_HEAD = ['id', 'fecha', 'tipo', 'ambito', 'importe', 'categoria', 'metodo', 'nota'];
const csvCell = (v) => (/[";\n\r,]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export function toCSV(expenses) {
  const rows = expenses.map((e) => [e.id, e.date, e.type === 'income' ? 'ingreso' : 'gasto', scopeOf(e) === 'business' ? 'agencia' : 'personal', centsToInput(e.amount), e.category, e.method, e.note].map((v) => csvCell(String(v))).join(';'));
  return '﻿' + [CSV_HEAD.join(';'), ...rows].join('\r\n') + '\r\n';
}

function parseCSVRows(text, sep) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c !== '')) rows.push(row);
  return rows;
}

/** Devuelve { expenses, errors } a partir de un CSV con cabecera (fecha e importe obligatorios). */
export function fromCSV(text) {
  text = text.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0];
  const sep = firstLine.includes(';') ? ';' : ',';
  const rows = parseCSVRows(text, sep);
  if (rows.length < 1) return { expenses: [], errors: ['El archivo está vacío'] };
  const head = rows[0].map((h) => h.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''));
  const col = (...names) => head.findIndex((h) => names.includes(h));
  const idx = {
    id: col('id'), date: col('fecha', 'date'), amount: col('importe', 'amount', 'cantidad'),
    category: col('categoria', 'category'), method: col('metodo', 'method'), note: col('nota', 'note', 'concepto'),
    type: col('tipo', 'type'), scope: col('ambito', 'scope'),
  };
  if (idx.date < 0 || idx.amount < 0) return { expenses: [], errors: ['Faltan las columnas "fecha" e "importe"'] };
  const expenses = [], errors = [];
  rows.slice(1).forEach((r, i) => {
    const get = (k) => (idx[k] >= 0 ? (r[idx[k]] || '').trim() : '');
    try {
      const type = /^(ingreso|income)$/i.test(get('type')) ? 'income' : 'expense';
      const scope = /^(agencia|business|negocio)$/i.test(get('scope')) ? 'business' : 'personal';
      expenses.push(normalizeExpense({ id: get('id'), date: get('date'), amount: get('amount'), category: get('category'), method: get('method'), note: get('note'), type, scope }));
    } catch (err) { errors.push(`Fila ${i + 2}: ${err.message}`); }
  });
  return { expenses, errors };
}

// ---------- JSON (copia completa: movimientos, presupuestos y recurrentes) ----------
export const toJSON = (expenses, budgets = {}, recurring = [], extra = {}) =>
  JSON.stringify({
    app: 'gastos', version: 3, exportedAt: new Date().toISOString(),
    expenses: expenses.map(clean), budgets, recurring: recurring.map(clean),
    favorites: extra.favorites || [], categories: extra.categories || null, groups: extra.groups || [],
  }, null, 2);

export function fromJSON(text) {
  const empty = { expenses: [], budgets: {}, recurring: [] };
  let data;
  try { data = JSON.parse(text); } catch { return { ...empty, errors: ['El archivo no es un JSON válido'] }; }
  const list = Array.isArray(data) ? data : data && Array.isArray(data.expenses) ? data.expenses : null;
  if (!list) return { ...empty, errors: ['El JSON no contiene una lista de gastos'] };
  const expenses = [], recurring = [], errors = [];
  list.forEach((raw, i) => {
    try { expenses.push(normalizeExpense(raw || {})); } catch (err) { errors.push(`Gasto ${i + 1}: ${err.message}`); }
  });
  (Array.isArray(data.recurring) ? data.recurring : []).forEach((raw, i) => {
    try { recurring.push(normalizeRecurring(raw || {})); } catch (err) { errors.push(`Recurrente ${i + 1}: ${err.message}`); }
  });
  return {
    expenses, budgets: normalizeBudgets(data.budgets), recurring, errors,
    favorites: normalizeFavorites(data.favorites),
    categories: Array.isArray(data.categories) && data.categories.length ? normalizeCategories(data.categories) : null,
    groups: normalizeGroups(data.groups),
  };
}

// ---------- Sincronización ----------
// Cada cosa sincronizable viaja como una fila { id, data, updatedAt, deleted }.
// Ids: el del movimiento tal cual, "rec:<id>" para recurrentes y "meta:<clave>" para presupuestos,
// botones rápidos (favorites), categorías y grupos.
// Regla de conflicto: gana la versión con "updatedAt" más reciente.

/** Quita los campos internos que no deben salir del dispositivo. */
export function clean(record) {
  const { dirty, ...rest } = record;
  return rest;
}

export const isDirty = (record) => record.dirty !== false;

export function toRow(id, record) {
  return record.deleted
    ? { id, data: '{}', updatedAt: record.updatedAt, deleted: true }
    : { id, data: JSON.stringify(clean(record)), updatedAt: record.updatedAt, deleted: false };
}

/** ¿La fila remota debe sustituir a lo que hay en local? */
export const remoteWins = (row, local) => !local || String(row.updatedAt) > String(local.updatedAt || '');

/**
 * Convierte una fila remota en el registro local que hay que guardar (o null si la fila no es válida).
 * kind: 'expense' | 'recurring' | 'budgets'.
 */
export function fromRow(row) {
  if (!row || typeof row.id !== 'string' || typeof row.updatedAt !== 'string') return null;
  const metaKey = row.id.startsWith('meta:') ? row.id.slice(5) : '';
  const kind = metaKey === 'budgets' ? 'budgets' : metaKey === 'favorites' || metaKey === 'categories' || metaKey === 'groups' ? 'meta'
    : metaKey ? null : row.id.startsWith('rec:') ? 'recurring' : 'expense';
  if (!kind) return null;
  if (kind === 'meta') {
    if (row.deleted) return null;
    try {
      const data = JSON.parse(row.data);
      const value = metaKey === 'favorites' ? normalizeFavorites(data.value) : metaKey === 'groups' ? normalizeGroups(data.value) : normalizeCategories(data.value);
      return { kind, record: { key: metaKey, value, updatedAt: row.updatedAt, dirty: false } };
    } catch { return null; }
  }
  const localId = kind === 'recurring' ? row.id.slice(4) : row.id;
  if (row.deleted) return { kind, record: { id: localId, deleted: true, updatedAt: row.updatedAt, dirty: false } };
  let data;
  try { data = JSON.parse(row.data); } catch { return null; }
  try {
    if (kind === 'budgets') return { kind, record: { value: normalizeBudgets(data.value), updatedAt: row.updatedAt, dirty: false } };
    const record = kind === 'recurring' ? normalizeRecurring({ ...data, id: localId }) : normalizeExpense({ ...data, id: localId });
    return { kind, record: { ...record, updatedAt: row.updatedAt, dirty: false } };
  } catch { return null; }
}
