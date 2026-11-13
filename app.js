import * as db from './db.js';
import * as sync from './sync.js';
import * as lock from './lock.js';
import {
  METHODS, categoriesFor, emojiFor, formatCents, centsToInput, parseAmount, todayISO, shiftMonth, monthLabel, dayLabel,
  summarize, budgetRows, normalizeExpense, normalizeRecurring, dueRecurring, toCSV, fromCSV, toJSON, fromJSON,
  setCategories, getCategories, normalizeCategories, normalizeFavorites, normalizeGroups, scopeOf, scopeLabel, inScope, tagsOf, filterExpenses, sortNewestFirst, monthlySeries, niceMax, shortMonth,
} from './lib.js';

const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

// "all" y "recurringAll" incluyen los borrados (hacen falta para sincronizar); "expenses" y "recurring" son los vivos.
const state = {
  all: [], expenses: [], recurringAll: [], recurring: [], budgets: {}, budgetsMeta: { updatedAt: '', dirty: false },
  // Ajustes sincronizables que se guardan enteros: botones rápidos y categorías.
  meta: {
    favorites: { value: [], updatedAt: '', dirty: false }, categories: { value: null, updatedAt: '', dirty: false },
    groups: { value: [], updatedAt: '', dirty: false },
  },
  month: todayISO().slice(0, 7), editingId: null,
  view: '', // '' = todo, 'personal', 'business' (agencia) o 'g:<id>' (un grupo)
};
/** Movimientos vivos del ámbito que se está viendo. Resumen, gráfico, lista y CSV salen de aquí. */
const visible = () => inScope(state.expenses, state.view);
const groupById = (id) => state.meta.groups.value.find((g) => g.id === id);
const viewGroup = () => (state.view.startsWith('g:') ? groupById(state.view.slice(2)) : null);
const viewLabel = () => { const g = viewGroup(); return g ? g.name : scopeLabel(state.view); };
const prefs = {
  get(key, fallback) { try { return localStorage.getItem('gastos.' + key) || fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem('gastos.' + key, value); } catch { /* sin almacenamiento: no pasa nada */ } },
};

// ---------- Guardado local (todo cambio pasa por aquí) ----------
const nowISO = () => new Date().toISOString();

function refresh() {
  state.expenses = state.all.filter((e) => !e.deleted);
  state.recurring = state.recurringAll.filter((r) => !r.deleted);
}
function setLocal(list, record) {
  const i = list.findIndex((x) => x.id === record.id);
  if (i >= 0) list[i] = record; else list.push(record);
}
/** dirty = true: cambio hecho aquí, pendiente de enviar. dirty = false: viene del servidor o ya se envió. */
async function saveExpense(record, dirty = true) {
  record.dirty = dirty;
  await db.put(record);
  setLocal(state.all, record);
  refresh();
}
async function saveRecurring(record, dirty = true) {
  record.dirty = dirty;
  setLocal(state.recurringAll, record);
  await db.setMeta('recurring', state.recurringAll);
  refresh();
}
async function saveBudgets(value, updatedAt = nowISO(), dirty = true) {
  state.budgets = value;
  state.budgetsMeta = { updatedAt, dirty };
  await db.setMeta('budgets', value);
  await db.setMeta('budgetsMeta', state.budgetsMeta);
}
async function saveMeta(key, value, updatedAt = nowISO(), dirty = true) {
  state.meta[key] = { value, updatedAt, dirty };
  await db.setMeta('m:' + key, state.meta[key]);
  if (key === 'categories') setCategories(value);
  if (key === 'groups') renderGroups();
}
const tombstone = (id) => ({ id, deleted: true, updatedAt: nowISO() });

const addForm = $('#add-form');
const editForm = $('#edit-form');
const editDialog = $('#edit-dialog');
const dataDialog = $('#data-dialog');

// ---------- Formularios ----------
function fillSelect(select, values) {
  select.replaceChildren(...values.map((v) => el('option', { value: v, textContent: v })));
}

/** Pinta los chips de categoría del alta según sea gasto o ingreso y marca la última usada. */
function renderAddCategories() {
  const type = addForm.type.value;
  const cats = categoriesFor(type);
  $('#add-cats').replaceChildren(...cats.map((c) =>
    el('label', { className: 'chip' },
      el('input', { type: 'radio', name: 'category', value: c.name }),
      `${c.emoji} ${c.name}`)));
  const last = prefs.get('category.' + type, cats[0].name);
  const radios = [...addForm.querySelectorAll('[name=category]')];
  (radios.find((r) => r.value === last) || radios[0]).checked = true;
  $('#add-submit').textContent = type === 'income' ? 'Guardar ingreso' : 'Guardar gasto';
}

function setupForms() {
  fillSelect(addForm.method, METHODS);
  fillSelect(editForm.method, METHODS);
  resetAddForm();
}

function resetAddForm() {
  addForm.amount.value = '';
  addForm.note.value = '';
  addForm.repeat.checked = false;
  addForm.favorite.checked = false;
  addForm.type.value = 'expense'; // lo habitual es apuntar gastos
  setAddGroup(); // apunta en lo que estés viendo: la agencia, un grupo...
  addForm.date.value = todayISO();
  addForm.method.value = prefs.get('method', METHODS[0]);
  renderAddCategories();
}

addForm.addEventListener('change', (ev) => {
  if (ev.target.name === 'type') renderAddCategories();
  // Elegir la categoría «Agencia» marca el movimiento como de la agencia.
  if (ev.target.name === 'category' && ev.target.value === 'Agencia' && !addForm.group.value) addForm.scope.value = 'business';
  // Un grupo vive dentro de Personal o de Agencia: el ámbito sigue al grupo.
  if (ev.target.name === 'group' && groupById(addForm.group.value)) addForm.scope.value = groupById(addForm.group.value).scope;
  if (ev.target.name === 'scope' && groupById(addForm.group.value) && groupById(addForm.group.value).scope !== ev.target.value) addForm.group.value = '';
});

/** Deja el alta apuntando a lo que se está viendo (un grupo, la agencia o personal). */
function setAddGroup() {
  const g = viewGroup();
  addForm.group.value = g ? g.id : '';
  addForm.scope.value = g ? g.scope : state.view === 'business' ? 'business' : 'personal';
}

// ---------- Grupos (un viaje, un proyecto...) ----------
const groupOptions = (select, current) => {
  const groups = state.meta.groups.value;
  select.replaceChildren(el('option', { value: '', textContent: 'Sin grupo' }),
    ...groups.map((g) => el('option', { value: g.id, textContent: `${g.emoji} ${g.name} · ${scopeLabel(g.scope)}` })));
  select.value = current && groupById(current) ? current : '';
};

function renderGroups() {
  const groups = state.meta.groups.value;
  if (state.view.startsWith('g:') && !viewGroup()) { state.view = ''; prefs.set('view', 'all'); }
  const view = $('#view');
  view.querySelectorAll('.grp').forEach((n) => n.remove());
  const plus = $('#group-new');
  for (const g of groups) {
    const label = el('label', { className: 'grp' }, el('input', { type: 'radio', name: 'view', value: 'g:' + g.id }), `${g.emoji} ${g.name}`);
    view.insertBefore(label, plus);
  }
  const current = view.querySelector(`input[value="${state.view}"]`);
  if (current) current.checked = true;
  const typed = addForm.group.value;
  groupOptions(addForm.group, typed);
  addForm.group.hidden = !groups.length;
  if (state.editingId) groupOptions(editForm.group, editForm.group.value);
  $('#edit-group').hidden = !groups.length;
  const list = $('#groups-list');
  if (!groups.length) {
    list.replaceChildren(el('li', { className: 'empty', textContent: 'No tienes ninguno. Créalos con el botón + junto a Todo, Personal y Agencia.' }));
    return;
  }
  list.replaceChildren(...groups.map((g) => {
    const n = state.expenses.filter((e) => e.group === g.id).length;
    const btn = el('button', { type: 'button', className: 'danger', textContent: 'Quitar' });
    btn.dataset.id = g.id;
    return el('li', {}, el('span', { textContent: `${g.emoji} ${g.name} · ${scopeLabel(g.scope)} · ${n} ${n === 1 ? 'movimiento' : 'movimientos'}` }), btn);
  }));
}

const groupDialog = $('#group-dialog');
const groupForm = $('#group-form');
$('#group-new').addEventListener('click', () => {
  groupForm.reset();
  groupForm.scope.value = state.view === 'business' ? 'business' : 'personal';
  showMsg($('#group-msg'), '');
  groupDialog.showModal();
  groupForm.name.focus();
});
$('#group-cancel').addEventListener('click', () => groupDialog.close());
groupForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const name = groupForm.name.value.trim();
  if (!name) return showMsg($('#group-msg'), 'Ponle un nombre.', true);
  if (state.meta.groups.value.some((g) => g.name.toLowerCase() === name.toLowerCase())) return showMsg($('#group-msg'), `Ya tienes un grupo «${name}».`, true);
  const group = normalizeGroups([{ name, emoji: groupForm.emoji.value, scope: groupForm.scope.value }])[0];
  await saveMeta('groups', [...state.meta.groups.value, group]);
  groupDialog.close();
  state.view = 'g:' + group.id; // se abre la pestaña nueva
  prefs.set('view', state.view);
  renderGroups();
  setAddGroup();
  render();
  queueSync();
});

$('#groups-list').addEventListener('click', async (ev) => {
  const id = ev.target.dataset && ev.target.dataset.id;
  const g = id && groupById(id);
  if (!g || !confirm(`¿Quitar el grupo «${g.name}»? Sus movimientos se quedan en ${scopeLabel(g.scope)}.`)) return;
  await saveMeta('groups', state.meta.groups.value.filter((x) => x.id !== id));
  setAddGroup();
  render();
  queueSync();
});

/** Ámbito y grupo de un movimiento: si va en un grupo, el ámbito es el del grupo. */
function groupFields(groupId, scope) {
  const g = groupById(groupId);
  return g ? { scope: g.scope, group: g.id } : { scope, group: undefined };
}

function showMsg(node, text, isError = false) {
  node.textContent = text;
  node.classList.toggle('error', isError);
}

/** Texto de aviso si la categoría ha llegado al 80 % o al 100 % de su presupuesto ese mes. */
function budgetWarning(category, ym) {
  const row = budgetRows(summarize(state.expenses, ym).byCategory, state.budgets).find((r) => r.category === category);
  if (!row || !row.level || row.level === 'ok') return '';
  const icon = row.level === 'over' ? '🔴' : '🟡';
  return `${icon} ${category}: ${row.pct} % del presupuesto (${formatCents(row.amount)} de ${formatCents(row.budget)})`;
}

addForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const msg = $('#add-msg');
  let expense;
  try {
    expense = normalizeExpense({
      type: addForm.type.value, amount: addForm.amount.value,
      ...groupFields(addForm.group.value, addForm.scope.value),
      category: addForm.querySelector('[name=category]:checked').value,
      date: addForm.date.value, method: addForm.method.value, note: addForm.note.value,
    });
  } catch (err) {
    showMsg(msg, err.message, true);
    addForm.amount.focus();
    return;
  }
  const repeat = addForm.repeat.checked;
  if (repeat) {
    const rec = normalizeRecurring({
      amount: expense.amount, category: expense.category, method: expense.method, note: expense.note,
      type: expense.type, scope: expense.scope, day: Number(expense.date.slice(8)), lastGenerated: expense.date.slice(0, 7),
    });
    expense.recurringId = rec.id;
    await saveRecurring(rec);
  }
  await saveExpense(expense);
  if (addForm.favorite.checked) {
    const { amount, category, method, note, type, scope } = expense;
    await saveMeta('favorites', normalizeFavorites([...state.meta.favorites.value, { amount, category, method, note: note.replace(/\s+$/, ''), type, scope }]));
    renderFavorites();
  }
  prefs.set('category.' + expense.type, expense.category);
  prefs.set('method', expense.method);
  state.month = expense.date.slice(0, 7);
  if (repeat) await generateDue(); // por si la fecha es de un mes pasado
  resetAddForm();
  render();
  const warning = expense.type === 'expense' ? budgetWarning(expense.category, state.month) : '';
  showMsg(msg, warning || `Guardado: ${formatCents(expense.amount)} en ${expense.category}${repeat ? ' (se repetirá cada mes)' : ''}`, warning.startsWith('🔴'));
  queueSync();
  addForm.amount.focus();
});

// ---------- Botones rápidos ----------
const favLabel = (f) => `${emojiFor(f.category)} ${f.note || f.category}`;

function renderFavorites() {
  $('#favorites').replaceChildren(...state.meta.favorites.value.map((f) => {
    const btn = el('button', { type: 'button', className: 'fav' }, favLabel(f) + ' ', el('b', { textContent: (f.type === 'income' ? '+' : '') + formatCents(f.amount) }));
    btn.dataset.id = f.id;
    btn.setAttribute('aria-label', `Apuntar ${f.note || f.category}, ${formatCents(f.amount)}`);
    return btn;
  }));
  const list = $('#favorites-list');
  if (!state.meta.favorites.value.length) {
    list.replaceChildren(el('li', { className: 'empty', textContent: 'No tienes ninguno. Marca «Guardar como botón rápido» al apuntar un movimiento.' }));
    return;
  }
  list.replaceChildren(...state.meta.favorites.value.map((f) => {
    const btn = el('button', { type: 'button', className: 'danger', textContent: 'Quitar' });
    btn.dataset.id = f.id;
    return el('li', {}, el('span', { textContent: `${favLabel(f)} · ${formatCents(f.amount)} · ${f.method}` }), btn);
  }));
}

// Un toque apunta el movimiento con la fecha de hoy.
$('#favorites').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('.fav');
  const f = btn && state.meta.favorites.value.find((x) => x.id === btn.dataset.id);
  if (!f) return;
  const { amount, category, method, note, type, scope } = f;
  const expense = normalizeExpense({ amount, category, method, note, type, scope, date: todayISO() });
  await saveExpense(expense);
  state.month = expense.date.slice(0, 7);
  render();
  const warning = expense.type === 'expense' ? budgetWarning(expense.category, state.month) : '';
  showMsg($('#add-msg'), warning || `Guardado: ${formatCents(expense.amount)} en ${expense.category}. Toca el movimiento si quieres cambiarlo.`, warning.startsWith('🔴'));
  queueSync();
});

$('#favorites-list').addEventListener('click', async (ev) => {
  const id = ev.target.dataset && ev.target.dataset.id;
  if (!id) return;
  await saveMeta('favorites', state.meta.favorites.value.filter((f) => f.id !== id));
  renderFavorites();
  queueSync();
});

// ---------- Categorías editables ----------
function renderCategories() {
  $('#categories').replaceChildren(...getCategories().map((c, i) => {
    const emoji = el('input', { value: c.emoji, maxLength: 8 });
    emoji.dataset.field = 'emoji';
    emoji.setAttribute('aria-label', `Emoji de ${c.name}`);
    const name = el('input', { value: c.name, maxLength: 24 });
    name.dataset.field = 'name';
    name.setAttribute('value', c.name);
    name.setAttribute('aria-label', `Nombre de la categoría ${c.name}`);
    const remove = el('button', { type: 'button', className: 'danger', textContent: 'Quitar' });
    const row = el('div', { className: 'cat-row' }, emoji, name, el('span', { className: 'kind', textContent: c.type === 'income' ? 'Ingreso' : 'Gasto' }), remove);
    row.dataset.index = i;
    return row;
  }));
}

/** Guarda la lista y repinta todo lo que enseña categorías. */
async function saveCategories(list) {
  await saveMeta('categories', normalizeCategories(list));
  renderCategories();
  renderBudgets();
  renderFavorites();
  const typed = addForm.amount.value;
  renderAddCategories();
  addForm.amount.value = typed;
  render();
  queueSync();
}

$('#categories').addEventListener('change', async (ev) => {
  const row = ev.target.closest('.cat-row');
  const field = ev.target.dataset.field;
  if (!row || !field) return;
  const list = getCategories().map((c) => ({ ...c }));
  const cat = list[Number(row.dataset.index)];
  const value = ev.target.value.trim();
  if (field === 'emoji') { cat.emoji = value; return saveCategories(list); }
  const old = cat.name;
  const clash = list.some((c) => c !== cat && c.type === cat.type && c.name.toLowerCase() === value.toLowerCase());
  if (!value || clash || value === old) {
    ev.target.value = old;
    if (clash) showMsg($('#data-msg'), `Ya existe la categoría «${value}».`, true);
    return;
  }
  cat.name = value;
  // Renombrar: los movimientos, recurrentes, botones rápidos y el presupuesto pasan al nombre nuevo.
  const sameType = (x) => (x.type === 'income' ? 'income' : 'expense') === cat.type;
  const stamp = nowISO();
  const moved = state.all.filter((e) => !e.deleted && e.category === old && sameType(e));
  moved.forEach((e) => { e.category = value; e.updatedAt = stamp; e.dirty = true; });
  if (moved.length) await db.putMany(moved);
  for (const r of state.recurringAll.filter((x) => !x.deleted && x.category === old && sameType(x))) await saveRecurring({ ...r, category: value, updatedAt: stamp });
  if (state.meta.favorites.value.some((f) => f.category === old && sameType(f))) {
    await saveMeta('favorites', state.meta.favorites.value.map((f) => (f.category === old && sameType(f) ? { ...f, category: value } : f)));
  }
  if (cat.type === 'expense' && state.budgets[old]) {
    const next = { ...state.budgets, [value]: state.budgets[old] };
    delete next[old];
    await saveBudgets(next);
  }
  for (const key of ['category.expense', 'category.income']) if (prefs.get(key, '') === old) prefs.set(key, value);
  refresh();
  showMsg($('#data-msg'), moved.length ? `«${old}» ahora es «${value}» (${moved.length} movimientos actualizados).` : `«${old}» ahora es «${value}».`);
  await saveCategories(list);
});

$('#categories').addEventListener('click', async (ev) => {
  const row = ev.target.closest('.cat-row');
  if (!row || ev.target.tagName !== 'BUTTON') return;
  const list = getCategories().map((c) => ({ ...c }));
  const cat = list[Number(row.dataset.index)];
  if (list.filter((c) => c.type === cat.type).length <= 1) return showMsg($('#data-msg'), 'Tiene que quedar al menos una categoría de cada tipo.', true);
  if (!confirm(`¿Quitar la categoría «${cat.name}»? Los movimientos que ya la usan no se borran.`)) return;
  list.splice(Number(row.dataset.index), 1);
  await saveCategories(list);
});

$('#category-add').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const form = ev.target;
  const name = form.name.value.trim();
  const type = form.type.value;
  if (!name) return;
  if (getCategories().some((c) => c.type === type && c.name.toLowerCase() === name.toLowerCase())) {
    return showMsg($('#data-msg'), `Ya existe la categoría «${name}».`, true);
  }
  await saveCategories([...getCategories(), { name, emoji: form.emoji.value, type }]);
  form.reset();
  showMsg($('#data-msg'), `Categoría «${name}» añadida.`);
});

// ---------- Modo privado ----------
function setPrivate(on) {
  document.body.classList.toggle('private', on);
  const btn = $('#btn-private');
  btn.setAttribute('aria-pressed', String(on));
  btn.textContent = on ? '🙈' : '👁';
  prefs.set('private', on ? 'on' : 'off');
}
$('#btn-private').addEventListener('click', () => setPrivate(!document.body.classList.contains('private')));

// ---------- Recurrentes ----------
/** Crea los movimientos recurrentes que tocan hasta hoy. Devuelve cuántos ha creado. */
async function generateDue() {
  const { expenses, recurring } = dueRecurring(state.recurringAll, todayISO(), new Set(state.all.map((e) => e.id)));
  if (recurring.some((r, i) => r !== state.recurringAll[i])) {
    state.recurringAll = recurring; // "lastGenerated" es un dato local: no hace falta enviarlo
    await db.setMeta('recurring', recurring);
  }
  if (expenses.length) {
    expenses.forEach((e) => { e.dirty = true; });
    await db.putMany(expenses);
    state.all.push(...expenses);
  }
  refresh();
  return expenses.length;
}

function renderRecurring() {
  const list = $('#recurring-list');
  if (!state.recurring.length) {
    list.replaceChildren(el('li', { className: 'empty', textContent: 'No tienes ninguno. Marca «Repetir cada mes» al apuntar un gasto o ingreso.' }));
    return;
  }
  list.replaceChildren(...state.recurring.map((r) => {
    const btn = el('button', { type: 'button', className: 'danger', textContent: 'Quitar' });
    btn.dataset.id = r.id;
    const sign = r.type === 'income' ? '+' : '';
    return el('li', {}, el('span', { textContent: `${emojiFor(r.category)} ${r.note || r.category} · ${sign}${formatCents(r.amount)} · día ${r.day}` }), btn);
  }));
}

$('#recurring-list').addEventListener('click', async (ev) => {
  const id = ev.target.dataset && ev.target.dataset.id;
  if (!id || !confirm('¿Dejar de repetir este movimiento? Los ya apuntados no se borran.')) return;
  await saveRecurring(tombstone(id));
  renderRecurring();
  queueSync();
});

// ---------- Presupuestos ----------
function renderBudgets() {
  $('#budgets').replaceChildren(...categoriesFor('expense').map((c) => {
    const input = el('input', { inputMode: 'decimal', placeholder: 'Sin límite', value: state.budgets[c.name] ? centsToInput(state.budgets[c.name]) : '' });
    input.dataset.category = c.name;
    input.setAttribute('aria-label', `Presupuesto de ${c.name} en euros`);
    return el('label', {}, el('span', { textContent: `${c.emoji} ${c.name}` }), input);
  }));
}

$('#budgets').addEventListener('change', async (ev) => {
  const input = ev.target;
  const category = input.dataset.category;
  if (!category) return;
  const cents = parseAmount(input.value);
  if (input.value.trim() && !cents) {
    input.value = state.budgets[category] ? centsToInput(state.budgets[category]) : '';
    return showMsg($('#data-msg'), 'Presupuesto no válido', true);
  }
  const next = { ...state.budgets };
  if (cents) next[category] = cents; else delete next[category];
  input.value = cents ? centsToInput(cents) : '';
  await saveBudgets(next);
  queueSync();
  showMsg($('#data-msg'), cents ? `Presupuesto de ${category}: ${formatCents(cents)} al mes` : `${category} sin límite`);
  render();
});

// ---------- Editar / borrar ----------
function fillEditCategories(type, current) {
  const cats = categoriesFor(type).map((c) => c.name);
  if (current && !cats.includes(current)) cats.push(current); // categorías importadas que no están en la lista
  fillSelect(editForm.category, cats);
  if (current) editForm.category.value = current;
}

function openEdit(id) {
  const e = state.expenses.find((x) => x.id === id);
  if (!e) return;
  state.editingId = id;
  editForm.type.value = e.type === 'income' ? 'income' : 'expense';
  editForm.scope.value = scopeOf(e);
  groupOptions(editForm.group, e.group);
  $('#edit-group').hidden = !state.meta.groups.value.length;
  fillEditCategories(editForm.type.value, e.category);
  fillSelect(editForm.method, METHODS.includes(e.method) ? METHODS : [...METHODS, e.method]);
  editForm.amount.value = centsToInput(e.amount);
  editForm.date.value = e.date;
  editForm.method.value = e.method;
  editForm.note.value = e.note;
  showMsg($('#edit-msg'), e.recurringId ? 'Movimiento recurrente: los cambios solo afectan a este mes.' : '');
  editDialog.showModal();
}

editForm.type.addEventListener('change', () => fillEditCategories(editForm.type.value));
editForm.group.addEventListener('change', () => { const g = groupById(editForm.group.value); if (g) editForm.scope.value = g.scope; });
editForm.scope.addEventListener('change', () => { const g = groupById(editForm.group.value); if (g && g.scope !== editForm.scope.value) editForm.group.value = ''; });

editForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const original = state.expenses.find((x) => x.id === state.editingId);
  if (!original) return editDialog.close();
  let updated;
  try {
    updated = normalizeExpense({
      ...original, type: editForm.type.value, ...groupFields(editForm.group.value, editForm.scope.value), amount: editForm.amount.value, category: editForm.category.value,
      date: editForm.date.value, method: editForm.method.value, note: editForm.note.value,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    return showMsg($('#edit-msg'), err.message, true);
  }
  await saveExpense(updated);
  editDialog.close();
  render();
  queueSync();
});

$('#edit-delete').addEventListener('click', async () => {
  const e = state.expenses.find((x) => x.id === state.editingId);
  if (!e || !confirm(`¿Borrar este movimiento de ${formatCents(e.amount)}?`)) return;
  await saveExpense(tombstone(e.id)); // se guarda la marca de borrado para que el borrado también se sincronice
  editDialog.close();
  render();
  queueSync();
});
$('#edit-cancel').addEventListener('click', () => editDialog.close());

// ---------- Vista del mes ----------
function render() {
  const { items, total, income, balance, byCategory } = summarize(visible(), state.month);
  const spendCount = items.filter((e) => e.type !== 'income').length;
  $('#month-label').textContent = monthLabel(state.month);
  $('#month-total').textContent = formatCents(total);
  $('#month-count').textContent = spendCount === 1 ? '1 gasto' : `${spendCount} gastos`;
  $('#month-income').textContent = formatCents(income);
  const bal = $('#month-balance');
  bal.textContent = (balance > 0 ? '+' : '') + formatCents(balance);
  bal.className = balance > 0 ? 'pos' : balance < 0 ? 'neg' : '';

  const rows = budgetRows(byCategory, state.budgets);
  $('#alerts').replaceChildren(...rows.filter((r) => r.level === 'warn' || r.level === 'over').map((r) =>
    el('li', {
      className: r.level,
      textContent: r.level === 'over'
        ? `🔴 ${r.category}: presupuesto superado (${r.pct} %, ${formatCents(r.amount - r.budget)} de más)`
        : `🟡 ${r.category}: vas por el ${r.pct} % del presupuesto (quedan ${formatCents(r.budget - r.amount)})`,
    })));

  $('#by-cat').replaceChildren(...rows.map((r) => {
    const share = total ? Math.round((r.amount / total) * 100) : 0;
    const fill = el('i');
    fill.style.width = Math.min(r.budget ? r.pct : share, 100) + '%';
    const right = r.budget
      ? el('span', {}, `${formatCents(r.amount)} de ${formatCents(r.budget)}`, el('span', { className: 'pct', textContent: r.pct + '%' }))
      : el('span', {}, formatCents(r.amount), el('span', { className: 'pct', textContent: share + '%' }));
    return el('li', {},
      el('div', { className: 'line' }, el('span', {}, `${emojiFor(r.category)} ${r.category}`), right),
      el('div', { className: 'bar ' + (r.level || '') }, fill));
  }));

  renderChart();
  renderList(items);
}

// ---------- Gráfico de evolución (SVG hecho a mano, sin librerías) ----------
const SVG = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}, text) => {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
};
const wholeEuros = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0, useGrouping: 'always' });
/** Barra con las esquinas de arriba redondeadas y la base recta. */
function barPath(x, y, w, base) {
  const r = Math.min(3, w / 2, base - y);
  return `M${x},${base}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${base}Z`;
}

function renderChart() {
  const select = $('#chart-category');
  const category = select.value;
  const wanted = ['', ...categoriesFor('expense').map((c) => c.name)];
  if ([...select.options].map((o) => o.value).join('|') !== wanted.join('|')) {
    select.replaceChildren(...wanted.map((v) => el('option', { value: v, textContent: v || 'Todo' })));
    select.value = wanted.includes(category) ? category : '';
  }
  const endYm = todayISO().slice(0, 7) > state.month ? todayISO().slice(0, 7) : state.month;
  const series = monthlySeries(visible(), endYm, 6, category);
  const showIncome = !category;

  $('#chart-legend').replaceChildren(
    el('li', {}, Object.assign(el('i'), { style: 'background: var(--series-1)' }), category ? `Gastos en ${category}` : 'Gastos'),
    ...(showIncome ? [el('li', {}, Object.assign(el('i'), { style: 'background: var(--series-2)' }), 'Ingresos')] : []));

  const W = 320, H = 170, left = 44, right = 4, top = 8, base = 140;
  const max = niceMax(Math.max(...series.map((m) => Math.max(m.expense, showIncome ? m.income : 0))));
  const y = (cents) => base - ((base - top) * cents) / max;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'group', 'aria-label': 'Gastos e ingresos de los últimos seis meses. Toca un mes para verlo.' });
  for (const frac of [0, 0.5, 1]) {
    const gy = y(max * frac);
    svg.append(svgEl('line', { class: 'grid', x1: left, x2: W - right, y1: gy, y2: gy }));
    svg.append(svgEl('text', { x: left - 6, y: gy + 4, 'text-anchor': 'end' }, `${wholeEuros.format((max * frac) / 100)} €`));
  }
  const slot = (W - left - right) / series.length;
  const barW = showIncome ? 13 : 20;
  const detail = (m) => `${monthLabel(m.ym)}: ${formatCents(m.expense)} en gastos${showIncome ? ` · ${formatCents(m.income)} en ingresos` : ''}`;
  series.forEach((m, i) => {
    const cx = left + slot * i + slot / 2;
    const hit = svgEl('rect', { class: 'hit' + (m.ym === state.month ? ' active' : ''), x: cx - slot / 2 + 2, y: top - 4, width: slot - 4, height: base - top + 26, rx: 6, tabindex: 0, role: 'button', 'aria-label': detail(m) });
    hit.dataset.ym = m.ym;
    hit.append(svgEl('title', {}, detail(m)));
    svg.append(hit);
    const x1 = showIncome ? cx - barW - 1 : cx - barW / 2; // 2 px de hueco entre las dos barras
    if (m.expense > 0) svg.append(svgEl('path', { class: 's1', d: barPath(x1, y(m.expense), barW, base), 'pointer-events': 'none' }));
    if (showIncome && m.income > 0) svg.append(svgEl('path', { class: 's2', d: barPath(cx + 1, y(m.income), barW, base), 'pointer-events': 'none' }));
    svg.append(svgEl('text', { class: m.ym === state.month ? 'current' : '', x: cx, y: base + 16, 'text-anchor': 'middle', 'pointer-events': 'none' }, shortMonth(m.ym)));
  });
  $('#chart').replaceChildren(svg);
  const current = series.find((m) => m.ym === state.month);
  showMsg($('#chart-detail'), current ? detail(current) : 'Toca un mes del gráfico para verlo.');
  $('#chart-rows').replaceChildren(...series.map((m) => el('tr', {},
    el('td', { textContent: monthLabel(m.ym) }), el('td', { textContent: formatCents(m.expense) }), el('td', { textContent: showIncome ? formatCents(m.income) : '—' }))));
}

function pickChartMonth(ev) {
  const hit = ev.target.closest('.hit');
  if (!hit || (ev.type === 'keydown' && ev.key !== 'Enter' && ev.key !== ' ')) return;
  ev.preventDefault();
  state.month = hit.dataset.ym;
  render();
}
$('#chart').addEventListener('click', pickChartMonth);
$('#chart').addEventListener('keydown', pickChartMonth);
$('#chart').addEventListener('pointerover', (ev) => {
  const hit = ev.target.closest('.hit');
  if (hit) showMsg($('#chart-detail'), hit.getAttribute('aria-label'));
});
$('#chart-category').addEventListener('change', renderChart);

// ---------- Lista con búsqueda y filtros ----------
const filters = { query: '', category: '', method: '', tag: '', all: false };
const filtersActive = () => Boolean(filters.query || filters.category || filters.method || filters.tag || filters.all);

/** Rellena un desplegable de filtro conservando lo elegido (aunque ya no haya movimientos con ese valor). */
function fillFilter(select, values, emptyLabel, current) {
  const list = current && !values.includes(current) ? [...values, current] : values;
  select.replaceChildren(el('option', { value: '', textContent: emptyLabel }), ...list.map((v) => el('option', { value: v, textContent: v })));
  select.value = current;
}

function renderList(monthItems) {
  const uniq = (values) => [...new Set(values)].sort((a, b) => a.localeCompare(b, 'es'));
  fillFilter($('#f-category'), uniq(state.expenses.map((e) => e.category)), 'Todas las categorías', filters.category);
  fillFilter($('#f-method'), uniq(state.expenses.map((e) => e.method)), 'Todos los métodos', filters.method);
  fillFilter($('#f-tag'), uniq(state.expenses.flatMap((e) => tagsOf(e.note))).map((t) => '#' + t), 'Todas las etiquetas', filters.tag ? '#' + filters.tag : '');

  const source = filters.all ? sortNewestFirst(visible()) : monthItems;
  const items = filterExpenses(source, filters);

  const summary = $('#filter-summary');
  if (filtersActive()) {
    const spent = items.filter((e) => e.type !== 'income').reduce((s, e) => s + e.amount, 0);
    const earned = items.filter((e) => e.type === 'income').reduce((s, e) => s + e.amount, 0);
    const count = items.length === 1 ? '1 movimiento' : `${items.length} movimientos`;
    const clear = el('button', { type: 'button', id: 'filters-clear', className: 'ghost', textContent: 'Quitar filtros' });
    summary.replaceChildren(el('span', { textContent: `${count} · ${formatCents(spent)} en gastos${earned ? ` · ${formatCents(earned)} en ingresos` : ''}` }), clear);
  } else summary.replaceChildren();

  const list = $('#list');
  if (!items.length) {
    list.replaceChildren(el('p', { className: 'empty', textContent: filtersActive() ? 'Ningún movimiento coincide con la búsqueda.' : 'No hay movimientos este mes.' }));
    return;
  }
  const signed = (e) => (e.type === 'income' ? e.amount : -e.amount);
  const nodes = [];
  let day = null;
  for (const e of items) {
    if (e.date !== day) {
      day = e.date;
      const dayTotal = items.filter((x) => x.date === day).reduce((s, x) => s + signed(x), 0);
      nodes.push(el('div', { className: 'day' },
        el('span', { textContent: dayLabel(day, filters.all) }),
        el('span', { textContent: (dayTotal > 0 ? '+' : '') + formatCents(dayTotal) })));
    }
    const isIncome = e.type === 'income';
    const details = [
      e.note ? e.category : null, e.method, e.recurringId ? 'recurrente' : null,
      scopeOf(e) === 'business' && state.view !== 'business' && !(viewGroup() && e.group === viewGroup().id) ? 'agencia' : null,
      e.group && groupById(e.group) && state.view !== 'g:' + e.group ? `${groupById(e.group).emoji} ${groupById(e.group).name}` : null,
    ].filter(Boolean).join(' · ');
    const amountText = (isIncome ? '+' : '') + formatCents(e.amount);
    const row = el('button', { className: 'item', type: 'button' },
      el('span', { className: 'emoji', textContent: emojiFor(e.category) }),
      el('span', { className: 'what' }, el('b', { textContent: e.note || e.category }), el('small', { textContent: details })),
      el('span', { className: 'amt' + (isIncome ? ' pos' : ''), textContent: amountText }));
    row.dataset.id = e.id;
    row.setAttribute('aria-label', `Editar ${e.note || e.category}, ${amountText}`);
    nodes.push(row);
  }
  list.replaceChildren(...nodes);
}

// ---------- Vista: todo, personal o agencia ----------
$('#view').addEventListener('change', (ev) => {
  if (ev.target.name !== 'view') return;
  state.view = ev.target.value;
  prefs.set('view', state.view || 'all');
  setAddGroup();
  render();
});

function onFilterChange() {
  filters.query = $('#search').value.trim();
  filters.category = $('#f-category').value;
  filters.method = $('#f-method').value;
  filters.tag = $('#f-tag').value.replace(/^#/, '');
  filters.all = $('#f-all').checked;
  renderList(summarize(visible(), state.month).items);
}
$('#search').addEventListener('input', onFilterChange);
for (const id of ['#f-category', '#f-method', '#f-tag', '#f-all']) $(id).addEventListener('change', onFilterChange);
$('#filter-summary').addEventListener('click', (ev) => {
  if (ev.target.id !== 'filters-clear') return;
  $('#search').value = '';
  $('#f-all').checked = false;
  for (const id of ['#f-category', '#f-method', '#f-tag']) $(id).value = '';
  onFilterChange();
});

$('#list').addEventListener('click', (ev) => {
  const row = ev.target.closest('.item');
  if (row) openEdit(row.dataset.id);
});
$('#prev-month').addEventListener('click', () => { state.month = shiftMonth(state.month, -1); render(); });
$('#next-month').addEventListener('click', () => { state.month = shiftMonth(state.month, 1); render(); });

// ---------- Ajustes: exportar / importar ----------
function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('#btn-data').addEventListener('click', () => {
  renderBudgets();
  renderRecurring();
  renderFavorites();
  renderCategories();
  renderSyncSection();
  const cfg = sync.getConfig();
  $('#sync-url').value = cfg.url;
  $('#sync-key').value = cfg.key;
  $('#export-csv').textContent = state.view ? `Exportar CSV (solo ${viewGroup() ? viewLabel() : viewLabel().toLowerCase()})` : 'Exportar CSV (Excel / Sheets)';
  renderGroups();
  renderPin();
  showMsg($('#data-msg'), `${state.expenses.length} movimientos guardados en este dispositivo.`);
  dataDialog.showModal();
});
$('#data-close').addEventListener('click', () => dataDialog.close());
$('#export-json').addEventListener('click', () => download(`gastos-${todayISO()}.json`, toJSON(state.expenses, state.budgets, state.recurring, { favorites: state.meta.favorites.value, categories: state.meta.categories.value, groups: state.meta.groups.value }), 'application/json'));
$('#export-csv').addEventListener('click', () => download(`gastos-${state.view ? viewLabel().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-') + '-' : ''}${todayISO()}.csv`, toCSV(visible()), 'text/csv;charset=utf-8'));
$('#import-btn').addEventListener('click', () => $('#import-file').click());

$('#import-file').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  const msg = $('#data-msg');
  const text = await file.text();
  const isJSON = file.name.toLowerCase().endsWith('.json') || /^\s*[\[{]/.test(text);
  const { expenses, errors, budgets = {}, recurring = [], favorites = [], categories = null, groups = [] } = isJSON ? fromJSON(text) : fromCSV(text);
  if (!expenses.length && !recurring.length && !Object.keys(budgets).length && !favorites.length && !categories && !groups.length) {
    return showMsg(msg, errors[0] || 'No se ha encontrado ningún movimiento en el archivo.', true);
  }
  // Fusión por id: lo importado sustituye a lo que tenga el mismo id; el resto se añade.
  // Importar cuenta como un cambio hecho ahora, así gana también al sincronizar.
  const stamp = nowISO();
  const known = new Set(state.expenses.map((e) => e.id));
  const updated = expenses.filter((e) => known.has(e.id)).length;
  expenses.forEach((e) => { e.updatedAt = stamp; e.dirty = true; });
  await db.putMany(expenses);
  expenses.forEach((e) => setLocal(state.all, e));
  refresh();
  if (Object.keys(budgets).length) await saveBudgets({ ...state.budgets, ...budgets });
  for (const r of recurring) {
    const mine = state.recurringAll.find((x) => x.id === r.id);
    // Si ya lo tengo, me quedo con el mes más avanzado para no regenerar movimientos borrados.
    const lastGenerated = mine && !mine.deleted && mine.lastGenerated > r.lastGenerated ? mine.lastGenerated : r.lastGenerated;
    await saveRecurring({ ...r, lastGenerated, updatedAt: stamp });
  }
  if (recurring.length) await generateDue();
  if (categories) await saveMeta('categories', categories);
  if (groups.length) {
    const mine = new Set(state.meta.groups.value.map((g) => g.id));
    await saveMeta('groups', normalizeGroups([...state.meta.groups.value, ...groups.filter((g) => !mine.has(g.id))]));
  }
  if (favorites.length) {
    const mine = new Set(state.meta.favorites.value.map((f) => f.id));
    await saveMeta('favorites', [...state.meta.favorites.value, ...favorites.filter((f) => !mine.has(f.id))]);
  }
  renderFavorites();
  renderCategories();
  { const typed = addForm.amount.value; renderAddCategories(); addForm.amount.value = typed; }
  queueSync();
  renderBudgets();
  renderRecurring();
  render();
  const skipped = errors.length ? ` ${errors.length} con errores se han saltado (${errors[0]}).` : '';
  showMsg(msg, `Importados ${expenses.length - updated} nuevos y ${updated} actualizados.${skipped}`, errors.length > 0);
});

// ---------- Sincronización ----------
const store = {
  localRows() {
    const rows = state.all.map((record) => ({ id: record.id, record }));
    for (const r of state.recurringAll) rows.push({ id: 'rec:' + r.id, record: r });
    if (state.budgetsMeta.updatedAt) rows.push({ id: 'meta:budgets', record: { value: state.budgets, ...state.budgetsMeta } });
    for (const key of Object.keys(state.meta)) if (state.meta[key].updatedAt) rows.push({ id: 'meta:' + key, record: state.meta[key] });
    return rows;
  },
  async apply(kind, record) {
    if (kind === 'expense') return saveExpense(record, false);
    if (kind === 'budgets') return saveBudgets(record.value, record.updatedAt, false);
    if (kind === 'meta') return saveMeta(record.key, record.value, record.updatedAt, false);
    const mine = state.recurringAll.find((r) => r.id === record.id);
    if (!record.deleted && mine && !mine.deleted && mine.lastGenerated > record.lastGenerated) record.lastGenerated = mine.lastGenerated;
    return saveRecurring(record, false);
  },
  // Solo se marca como enviado si no se ha vuelto a tocar mientras se enviaba.
  async markClean(id, updatedAt) {
    if (id === 'meta:budgets') {
      if (state.budgetsMeta.updatedAt === updatedAt) await saveBudgets(state.budgets, updatedAt, false);
    } else if (id.startsWith('meta:')) {
      const m = state.meta[id.slice(5)];
      if (m && m.updatedAt === updatedAt) await saveMeta(id.slice(5), m.value, updatedAt, false);
    } else if (id.startsWith('rec:')) {
      const r = state.recurringAll.find((x) => x.id === id.slice(4));
      if (r && r.updatedAt === updatedAt) await saveRecurring({ ...r }, false);
    } else {
      const e = state.all.find((x) => x.id === id);
      if (e && e.updatedAt === updatedAt) await saveExpense({ ...e }, false);
    }
  },
};

function setSyncStatus(text, isError = false) {
  showMsg($('#sync-status'), text, isError);
  showMsg($('#sync-msg'), text, isError);
}

let syncTimer;
function queueSync() {
  if (!sync.isEnabled()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(runSync, 1500);
}

async function runSync() {
  if (!sync.isEnabled()) return setSyncStatus('');
  setSyncStatus('Sincronizando…');
  try {
    const result = await sync.syncNow(store);
    if (result && result.pulled) {
      const created = await generateDue();
      const typed = addForm.amount.value; // no pisar lo que se esté escribiendo
      renderAddCategories();
      addForm.amount.value = typed;
      renderFavorites();
      render();
      if (dataDialog.open) { renderBudgets(); renderRecurring(); renderCategories(); }
      if (created) queueSync();
    }
    const time = new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    setSyncStatus(`Sincronizado a las ${time}`);
  } catch (err) {
    setSyncStatus(`Sin sincronizar: ${err.message}`, true);
  }
}

// La sincronización es solo para quien tiene su propio n8n: va oculta salvo que ya esté configurada
// en este dispositivo o se haya desbloqueado tocando 5 veces seguidas el texto de versión.
const SYNC_UNLOCK = 'sync.unlocked';
function syncVisible() { return sync.isEnabled() || prefs.get(SYNC_UNLOCK, '') === '1'; }
function renderSyncSection() { $('#sync-section').hidden = !syncVisible(); }
let versionTaps = [];
$('#app-version').addEventListener('click', () => {
  const now = Date.now();
  versionTaps = versionTaps.filter((t) => now - t < 3000).concat(now);
  if (versionTaps.length < 5) return;
  versionTaps = [];
  if (sync.isEnabled()) return showMsg($('#data-msg'), 'La sincronización ya está configurada en este dispositivo.');
  const show = prefs.get(SYNC_UNLOCK, '') !== '1';
  try { show ? localStorage.setItem('gastos.' + SYNC_UNLOCK, '1') : localStorage.removeItem('gastos.' + SYNC_UNLOCK); } catch { /* sin almacenamiento */ }
  renderSyncSection();
  showMsg($('#data-msg'), show ? 'Sincronización visible en este dispositivo.' : 'Sincronización oculta.');
  if (show) $('#sync-section').scrollIntoView({ block: 'nearest' });
});

$('#sync-generate').addEventListener('click', () => { $('#sync-key').value = sync.randomKey(); $('#sync-key').select(); });

$('#sync-save').addEventListener('click', async () => {
  const url = $('#sync-url').value.trim();
  const key = $('#sync-key').value.trim();
  if (!url && !key) {
    sync.setConfig('', '');
    return setSyncStatus('');
  }
  if (!/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(url)) return showMsg($('#sync-msg'), 'La URL tiene que empezar por https://', true);
  if (key.length < 16) return showMsg($('#sync-msg'), 'La clave tiene que tener al menos 16 caracteres. Usa «Generar clave nueva».', true);
  const before = sync.getConfig();
  sync.setConfig(url, key);
  if (before.url !== url || before.key !== key) {
    // Servidor nuevo: hay que enviarle todo otra vez.
    state.all.forEach((e) => { e.dirty = true; });
    state.recurringAll.forEach((r) => { r.dirty = true; });
    await db.putMany(state.all);
    await db.setMeta('recurring', state.recurringAll);
    if (state.budgetsMeta.updatedAt) await saveBudgets(state.budgets, state.budgetsMeta.updatedAt, true);
    for (const key of Object.keys(state.meta)) if (state.meta[key].updatedAt) await saveMeta(key, state.meta[key].value, state.meta[key].updatedAt, true);
  }
  await runSync();
  schedulePoll();
});

// Casi tiempo real: mientras la app está a la vista, mira si hay cambios cada 30 s (una llamada al webhook).
// En segundo plano no consulta nada.
const POLL_MS = 30000;
let pollTimer;
function schedulePoll() {
  clearInterval(pollTimer);
  if (document.visibilityState === 'visible' && sync.isEnabled()) pollTimer = setInterval(runSync, POLL_MS);
}
window.addEventListener('online', runSync);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') runSync();
  schedulePoll();
});

$('#btn-refresh').addEventListener('click', async () => {
  if (!sync.isEnabled()) return location.reload();
  const btn = $('#btn-refresh');
  btn.classList.add('spinning');
  btn.disabled = true;
  try { await runSync(); } finally { btn.classList.remove('spinning'); btn.disabled = false; schedulePoll(); }
});

// ---------- Bloqueo con PIN ----------
const LOCK_AFTER_MS = 60000;
let hiddenAt = 0;
function showLock() {
  if (!lock.hasPin()) return;
  document.querySelectorAll('dialog[open]').forEach((d) => d.close());
  document.body.classList.add('locked');
  $('#lock').hidden = false;
  $('#lock-msg').textContent = '';
  const input = $('#lock-form').pin;
  input.value = '';
  input.focus();
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') hiddenAt = Date.now();
  else if (hiddenAt && Date.now() - hiddenAt >= LOCK_AFTER_MS) showLock();
});
$('#lock-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const input = ev.target.pin;
  try {
    if (await lock.checkPin(input.value)) {
      $('#lock').hidden = true;
      document.body.classList.remove('locked');
      input.value = '';
      return;
    }
    showMsg($('#lock-msg'), 'PIN incorrecto.', true);
  } catch (err) {
    showMsg($('#lock-msg'), err.message, true);
  }
  input.value = '';
  input.focus();
});

function renderPin() {
  const on = lock.hasPin();
  $('#pin-save').textContent = on ? 'Cambiar PIN' : 'Activar PIN';
  $('#pin-remove').hidden = !on;
}
$('#pin-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  if (!lock.isValidPin(f.pin.value)) return showMsg($('#pin-msg'), 'El PIN tiene que tener de 4 a 8 cifras.', true);
  if (f.pin.value !== f.pin2.value) return showMsg($('#pin-msg'), 'Los dos PIN no coinciden.', true);
  await lock.setPin(f.pin.value);
  f.reset();
  renderPin();
  showMsg($('#pin-msg'), 'PIN activado. Te lo pediré al abrir la app.');
});
$('#pin-remove').addEventListener('click', async () => {
  const pin = prompt('Escribe tu PIN actual para quitarlo');
  if (pin === null) return;
  try {
    if (!(await lock.checkPin(pin))) return showMsg($('#pin-msg'), 'PIN incorrecto.', true);
  } catch (err) { return showMsg($('#pin-msg'), err.message, true); }
  lock.clearPin();
  renderPin();
  showMsg($('#pin-msg'), 'PIN quitado.');
});

// ---------- Arranque ----------
async function start() {
  showLock();
  setPrivate(prefs.get('private', 'off') === 'on');
  try {
    // Las categorías y los grupos van primero: el formulario de alta los necesita.
    const [favorites, categories, groups] = await Promise.all([db.getMeta('m:favorites', null), db.getMeta('m:categories', null), db.getMeta('m:groups', null)]);
    if (favorites) state.meta.favorites = favorites;
    if (categories) { state.meta.categories = categories; setCategories(categories.value); }
    if (groups) state.meta.groups = groups;
  } catch { /* el aviso de almacenamiento sale más abajo */ }
  const savedView = prefs.get('view', 'all');
  state.view = savedView === 'personal' || savedView === 'business' || savedView.startsWith('g:') ? savedView : '';
  renderGroups(); // pinta las pestañas de los grupos y marca la vista guardada (si el grupo ya no existe, vuelve a Todo)
  if (!state.view) document.querySelector('#view input[value=""]').checked = true;
  setupForms();
  renderFavorites();
  let created = 0;
  try {
    const [all, budgets, budgetsMeta, recurringAll] = await Promise.all([
      db.getAll(), db.getMeta('budgets', {}), db.getMeta('budgetsMeta', null), db.getMeta('recurring', []),
    ]);
    state.all = all;
    state.budgets = budgets;
    state.recurringAll = recurringAll;
    // Datos de versiones anteriores a la sincronización: se les pone fecha de cambio para poder enviarlos.
    if (budgetsMeta) state.budgetsMeta = budgetsMeta;
    else if (Object.keys(budgets).length) await saveBudgets(budgets);
    if (recurringAll.some((r) => !r.updatedAt)) {
      recurringAll.forEach((r) => { if (!r.updatedAt) r.updatedAt = nowISO(); });
      await db.setMeta('recurring', recurringAll);
    }
    refresh();
    created = await generateDue();
  } catch (err) {
    showMsg($('#add-msg'), 'No se puede abrir el almacenamiento de este navegador. ¿Estás en modo privado?', true);
  }
  render();
  if (created) showMsg($('#add-msg'), created === 1 ? 'Se ha apuntado 1 movimiento recurrente.' : `Se han apuntado ${created} movimientos recurrentes.`);
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  runSync();
  schedulePoll();
}
start();
