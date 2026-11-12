import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAmount, centsToInput, shiftMonth, summarize, normalizeExpense, toCSV, fromCSV, toJSON, fromJSON } from '../lib.js';

test('parseAmount entiende coma, punto y miles', () => {
  assert.equal(parseAmount('2,50'), 250);
  assert.equal(parseAmount('2.50'), 250);
  assert.equal(parseAmount('1.234,56'), 123456);
  assert.equal(parseAmount('1,234.56'), 123456);
  assert.equal(parseAmount(' 3 € '), 300);
  assert.equal(parseAmount('0,1'), 10);
  assert.equal(parseAmount('19,99'), 1999);
  assert.equal(parseAmount(',5'), 50);
  for (const bad of ['', 'abc', '0', '-5', '1,2,3', '2,5x']) assert.equal(parseAmount(bad), null, bad);
});

test('centsToInput', () => { assert.equal(centsToInput(1250), '12,50'); assert.equal(centsToInput(5), '0,05'); });

test('shiftMonth cruza de año', () => {
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
  assert.equal(shiftMonth('2026-12', 1), '2027-01');
});

test('summarize filtra el mes, suma y ordena categorías', () => {
  const mk = (amount, category, date) => normalizeExpense({ amount, category, date });
  const all = [mk(1000, 'Comida', '2026-11-02'), mk(250, 'Ocio', '2026-11-10'), mk(500, 'Comida', '2026-11-10'), mk(9999, 'Casa', '2026-10-31')];
  const s = summarize(all, '2026-11');
  assert.equal(s.total, 1750);
  assert.equal(s.items.length, 3);
  assert.equal(s.items[0].date, '2026-11-10');
  assert.deepEqual(s.byCategory, [{ category: 'Comida', amount: 1500 }, { category: 'Ocio', amount: 250 }]);
});

test('normalizeExpense rechaza datos malos', () => {
  assert.throws(() => normalizeExpense({ amount: '0', date: '2026-11-01' }), /Importe/);
  assert.throws(() => normalizeExpense({ amount: '5', date: '01/11/2026' }), /Fecha/);
});

test('CSV ida y vuelta, con comillas, punto y coma y saltos de línea', () => {
  const list = [
    normalizeExpense({ amount: '2,50', category: 'Comida', date: '2026-11-11', method: 'Bizum', note: 'café; con "leche"\ny tostada' }),
    normalizeExpense({ amount: '1.234,56', category: 'Casa', date: '2026-11-01', note: '' }),
  ];
  const { expenses, errors } = fromCSV(toCSV(list));
  assert.deepEqual(errors, []);
  assert.deepEqual(expenses.map(({ id, amount, category, date, method, note }) => ({ id, amount, category, date, method, note })),
    list.map(({ id, amount, category, date, method, note }) => ({ id, amount, category, date, method, note })));
});

test('CSV hecho a mano: separador coma, sin id, filas malas se saltan', () => {
  const { expenses, errors } = fromCSV('Fecha,Importe,Categoría,Nota\n2026-11-05,"12,30",Ocio,cine\n2026-13-45,5,Ocio,mala\n2026-11-06,4.5,,\n');
  assert.equal(expenses.length, 2);
  assert.equal(expenses[0].amount, 1230);
  assert.equal(expenses[1].amount, 450);
  assert.equal(expenses[1].category, 'Otros');
  assert.ok(expenses[0].id);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Fila 3/);
});

test('JSON ida y vuelta y errores', () => {
  const list = [normalizeExpense({ amount: '7', category: 'Ocio', date: '2026-11-11' })];
  assert.deepEqual(fromJSON(toJSON(list)).expenses, list);
  assert.equal(fromJSON('no es json').errors.length, 1);
  assert.equal(fromJSON('{"x":1}').errors.length, 1);
});

// ---------- Hito 2 ----------
import { budgetLevel, budgetRows, normalizeBudgets, normalizeRecurring, dueRecurring } from '../lib.js';

test('summarize separa ingresos y calcula balance', () => {
  const all = [
    normalizeExpense({ amount: 150000, type: 'income', category: 'Sueldo', date: '2026-11-01' }),
    normalizeExpense({ amount: 40000, category: 'Casa', date: '2026-11-02' }),
    { id: 'viejo', amount: 1000, category: 'Ocio', date: '2026-11-03', method: 'Tarjeta', note: '' }, // dato del hito 1, sin "type"
  ];
  const s = summarize(all, '2026-11');
  assert.equal(s.total, 41000);
  assert.equal(s.income, 150000);
  assert.equal(s.balance, 109000);
  assert.deepEqual(s.byCategory.map((c) => c.category), ['Casa', 'Ocio']);
});

test('budgetLevel: aviso al 80 % y al 100 %', () => {
  assert.equal(budgetLevel(7999, 10000), 'ok');
  assert.equal(budgetLevel(8000, 10000), 'warn');
  assert.equal(budgetLevel(9999, 10000), 'warn');
  assert.equal(budgetLevel(10000, 10000), 'over');
  assert.equal(budgetLevel(500, undefined), null);
});

test('budgetRows incluye categorías con presupuesto y sin gasto', () => {
  const rows = budgetRows([{ category: 'Comida', amount: 9000 }, { category: 'Ocio', amount: 100 }], { Comida: 10000, Ropa: 5000 });
  assert.deepEqual(rows, [
    { category: 'Comida', amount: 9000, budget: 10000, pct: 90, level: 'warn' },
    { category: 'Ocio', amount: 100, budget: null, pct: null, level: null },
    { category: 'Ropa', amount: 0, budget: 5000, pct: 0, level: 'ok' },
  ]);
  assert.deepEqual(normalizeBudgets({ a: 100, b: 0, c: -5, d: '7', e: 1.5 }), { a: 100 });
});

test('dueRecurring genera los meses pendientes sin duplicar y ajusta el día al fin de mes', () => {
  const rec = normalizeRecurring({ id: 'r1', amount: '12,99', category: 'Suscripciones', note: 'Netflix', day: 31, lastGenerated: '2026-01' });
  const first = dueRecurring([rec], '2026-04-15');
  assert.deepEqual(first.expenses.map((e) => [e.id, e.date]), [['r1-2026-02', '2026-02-28'], ['r1-2026-03', '2026-03-31']]);
  assert.equal(first.expenses[0].amount, 1299);
  assert.equal(first.expenses[0].recurringId, 'r1');
  assert.equal(first.recurring[0].lastGenerated, '2026-03');
  const again = dueRecurring(first.recurring, '2026-04-15');
  assert.equal(again.expenses.length, 0);
  assert.equal(dueRecurring(first.recurring, '2026-04-30').expenses[0].date, '2026-04-30');
  assert.throws(() => normalizeRecurring({ amount: 5, day: 32, lastGenerated: '2026-01' }), /Día/);
});

test('CSV conserva el tipo y JSON v2 conserva presupuestos y recurrentes', () => {
  const list = [normalizeExpense({ amount: 100000, type: 'income', category: 'Agencia', date: '2026-11-05' }), normalizeExpense({ amount: 500, date: '2026-11-05' })];
  assert.deepEqual(fromCSV(toCSV(list)).expenses.map((e) => e.type), ['income', 'expense']);
  const rec = [normalizeRecurring({ amount: 999, day: 5, lastGenerated: '2026-11' })];
  const back = fromJSON(toJSON(list, { Comida: 20000 }, rec));
  assert.deepEqual(back.expenses, list);
  assert.deepEqual(back.budgets, { Comida: 20000 });
  assert.deepEqual(back.recurring, rec);
  assert.deepEqual(fromJSON(JSON.stringify({ expenses: [] })).budgets, {}); // copia del hito 1
});

// ---------- Sincronización ----------
import { toRow, fromRow, remoteWins, isDirty, clean } from '../lib.js';

test('toRow / fromRow: ida y vuelta de movimiento, recurrente, presupuestos y borrado', () => {
  const e = { ...normalizeExpense({ amount: 250, category: 'Comida', date: '2026-11-11' }), dirty: true };
  const row = toRow(e.id, e);
  assert.equal(row.deleted, false);
  assert.ok(!row.data.includes('dirty'));
  assert.deepEqual(fromRow(row), { kind: 'expense', record: { ...clean(e), dirty: false } });

  const rec = normalizeRecurring({ id: 'r1', amount: 999, day: 5, lastGenerated: '2026-11' });
  assert.deepEqual(fromRow(toRow('rec:r1', rec)), { kind: 'recurring', record: { ...rec, dirty: false } });

  const budgets = { value: { Comida: 300 }, updatedAt: '2026-11-11T10:00:00.000Z', dirty: true };
  assert.deepEqual(fromRow(toRow('meta:budgets', budgets)).record, { value: { Comida: 300 }, updatedAt: budgets.updatedAt, dirty: false });

  const tomb = toRow('x', { id: 'x', deleted: true, updatedAt: '2026-11-11T11:00:00.000Z' });
  assert.deepEqual(tomb, { id: 'x', data: '{}', updatedAt: '2026-11-11T11:00:00.000Z', deleted: true });
  assert.deepEqual(fromRow({ ...tomb, id: 'rec:x' }), { kind: 'recurring', record: { id: 'x', deleted: true, updatedAt: tomb.updatedAt, dirty: false } });
});

test('fromRow descarta filas rotas y remoteWins aplica "gana el más reciente"', () => {
  assert.equal(fromRow({ id: 'a', data: 'no json', updatedAt: 'x', deleted: false }), null);
  assert.equal(fromRow({ id: 'a', data: '{"amount":-1,"date":"2026-11-11"}', updatedAt: 'x', deleted: false }), null);
  assert.equal(fromRow({ id: 'meta:otro', data: '{}', updatedAt: 'x', deleted: false }), null);
  assert.equal(fromRow(null), null);
  const local = { updatedAt: '2026-11-11T10:00:00.000Z' };
  assert.equal(remoteWins({ updatedAt: '2026-11-11T10:00:00.001Z' }, local), true);
  assert.equal(remoteWins({ updatedAt: '2026-11-11T10:00:00.000Z' }, local), false);
  assert.equal(remoteWins({ updatedAt: '2026-11-10T10:00:00.000Z' }, local), false);
  assert.equal(remoteWins({ updatedAt: '2026-11-10T10:00:00.000Z' }, undefined), true);
  assert.equal(isDirty({}), true);
  assert.equal(isDirty({ dirty: false }), false);
});

test('recurrentes: mismo resultado en dos dispositivos y respeta los ya existentes o borrados', () => {
  const rec = normalizeRecurring({ id: 'r1', amount: 999, day: 5, lastGenerated: '2026-09' });
  const a = dueRecurring([rec], '2026-11-11').expenses;
  const b = dueRecurring([rec], '2026-11-11').expenses;
  assert.deepEqual(a, b);
  assert.equal(a[0].updatedAt, '2026-10-05T00:00:00.000Z');
  const skip = dueRecurring([rec], '2026-11-11', new Set(['r1-2026-10']));
  assert.deepEqual(skip.expenses.map((e) => e.id), ['r1-2026-11']);
  assert.equal(skip.recurring[0].lastGenerated, '2026-11');
  const gone = dueRecurring([{ id: 'r1', deleted: true, updatedAt: 'x' }], '2026-11-11');
  assert.equal(gone.expenses.length, 0);
});

// ---------- Hito 3 ----------
import { tagsOf, filterExpenses, monthlySeries, niceMax } from '../lib.js';

test('tagsOf saca las #etiquetas de la nota', () => {
  assert.deepEqual(tagsOf('cena #Viaje #lisboa-2026 con #viaje y #niño'), ['viaje', 'lisboa-2026', 'niño']);
  assert.deepEqual(tagsOf('sin etiquetas # nada'), []);
  assert.deepEqual(tagsOf(undefined), []);
});

test('filterExpenses: texto sin acentos ni mayúsculas, importe, categoría, método, etiqueta y mes', () => {
  const mk = (amount, category, date, note, method = 'Tarjeta') => normalizeExpense({ amount, category, date, note, method });
  const all = [
    mk(250, 'Comida', '2026-11-02', 'Café con Raúl #trabajo'),
    mk(4500, 'Ocio', '2026-11-05', 'Cine #finde', 'Bizum'),
    mk(1250, 'Comida', '2026-10-20', 'menú #trabajo'),
  ];
  const notes = (f) => filterExpenses(all, f).map((e) => e.note);
  assert.deepEqual(notes({ query: 'cafe raul' }), ['Café con Raúl #trabajo']);
  assert.deepEqual(notes({ query: 'COMIDA' }).length, 2);
  assert.deepEqual(notes({ query: '12,50' }), ['menú #trabajo']);
  assert.deepEqual(notes({ query: 'bizum' }), ['Cine #finde']);
  assert.deepEqual(notes({ tag: 'trabajo' }).length, 2);
  assert.deepEqual(notes({ tag: 'trabajo', ym: '2026-11' }), ['Café con Raúl #trabajo']);
  assert.deepEqual(notes({ category: 'Ocio', method: 'Tarjeta' }), []);
  assert.equal(notes({}).length, 3);
});

test('monthlySeries y niceMax', () => {
  const all = [
    normalizeExpense({ amount: 1000, category: 'Comida', date: '2026-11-02' }),
    normalizeExpense({ amount: 500, category: 'Ocio', date: '2026-11-03' }),
    normalizeExpense({ amount: 90000, type: 'income', category: 'Sueldo', date: '2026-10-01' }),
    normalizeExpense({ amount: 777, category: 'Comida', date: '2025-01-01' }),
  ];
  const s = monthlySeries(all, '2026-11', 3);
  assert.deepEqual(s, [{ ym: '2026-09', expense: 0, income: 0 }, { ym: '2026-10', expense: 0, income: 90000 }, { ym: '2026-11', expense: 1500, income: 0 }]);
  assert.deepEqual(monthlySeries(all, '2026-11', 2, 'Comida'), [{ ym: '2026-10', expense: 0, income: 0 }, { ym: '2026-11', expense: 1000, income: 0 }]);
  assert.deepEqual([0, 900, 1000, 1001, 4999, 5001, 150000].map(niceMax), [1000, 1000, 1000, 2000, 5000, 10000, 200000]);
});

// ---------- Hito 4: personal / agencia ----------
import { scopeOf, inScope } from '../lib.js';

test('ámbito: personal por defecto, se conserva en CSV, JSON y sincronización', () => {
  const personal = normalizeExpense({ amount: 500, date: '2026-11-11' });
  const agency = normalizeExpense({ amount: 2900, date: '2026-11-11', category: 'Agencia', scope: 'business', note: 'VPS' });
  assert.equal(personal.scope, 'personal');
  assert.equal(agency.scope, 'business');
  assert.equal(scopeOf({ id: 'dato-antiguo-sin-ambito' }), 'personal');
  assert.equal(normalizeExpense({ amount: 1, date: '2026-11-11', scope: 'cualquier cosa' }).scope, 'personal');
  assert.deepEqual(inScope([personal, agency], 'business'), [agency]);
  assert.deepEqual(inScope([personal, agency], ''), [personal, agency]);
  assert.match(toCSV([agency]), /;gasto;agencia;/);
  assert.deepEqual(fromCSV(toCSV([personal, agency])).expenses.map((e) => e.scope), ['personal', 'business']);
  assert.deepEqual(fromCSV('fecha;importe\n2026-11-11;5\n').expenses[0].scope, 'personal');
  assert.deepEqual(fromJSON(toJSON([agency])).expenses, [agency]);
  assert.equal(fromRow(toRow(agency.id, agency)).record.scope, 'business');
});

test('un recurrente de la agencia genera movimientos de la agencia', () => {
  const rec = normalizeRecurring({ id: 'r9', amount: 2900, day: 1, lastGenerated: '2026-10', scope: 'business' });
  assert.equal(dueRecurring([rec], '2026-11-11').expenses[0].scope, 'business');
  assert.equal(normalizeRecurring({ amount: 1, day: 1, lastGenerated: '2026-10' }).scope, 'personal');
});

// ---------- Botones rápidos y categorías editables ----------
import { normalizeCategories, normalizeFavorites, setCategories, categoriesFor, emojiFor } from '../lib.js';

test('categorías: limpia, quita duplicados y garantiza una de cada tipo', () => {
  const list = normalizeCategories([{ name: ' Mascota ', emoji: '🐶' }, { name: 'mascota' }, { name: '' }, { name: 'Sin emoji' }]);
  assert.deepEqual(list.filter((c) => c.type === 'expense'), [{ name: 'Mascota', emoji: '🐶', type: 'expense' }, { name: 'Sin emoji', emoji: '📦', type: 'expense' }]);
  assert.ok(list.some((c) => c.type === 'income')); // se añaden las de ingreso de fábrica
  setCategories(list);
  assert.equal(emojiFor('Mascota'), '🐶');
  assert.equal(emojiFor('Comida'), '📦'); // ya no está en la lista
  assert.deepEqual(categoriesFor('expense').map((c) => c.name), ['Mascota', 'Sin emoji']);
  setCategories(null);
  assert.equal(emojiFor('Comida'), '🍽️');
});

test('botones rápidos: valida y viajan por sincronización y copia JSON', () => {
  const favs = normalizeFavorites([{ amount: 150, category: 'Comida', note: 'café' }, { amount: 0 }, { amount: '5' }, null]);
  assert.equal(favs.length, 1);
  assert.equal(favs[0].scope, 'personal');
  const meta = { value: favs, updatedAt: '2026-11-12T10:00:00.000Z', dirty: true };
  assert.deepEqual(fromRow(toRow('meta:favorites', meta)), { kind: 'meta', record: { key: 'favorites', value: favs, updatedAt: meta.updatedAt, dirty: false } });
  const cats = normalizeCategories([{ name: 'Mascota', emoji: '🐶' }]);
  assert.deepEqual(fromRow(toRow('meta:categories', { value: cats, updatedAt: 'x' })).record.value, cats);
  const back = fromJSON(toJSON([], {}, [], { favorites: favs, categories: cats }));
  assert.deepEqual(back.favorites, favs);
  assert.deepEqual(back.categories, cats);
  assert.equal(fromJSON(toJSON([])).categories, null);
});

test('grupos: cuentan en su ámbito y viajan por sincronización y copia JSON', async () => {
  const { normalizeGroups, inScope } = await import('../lib.js');
  const groups = normalizeGroups([{ name: 'Viaje Roma', emoji: '✈️', scope: 'personal' }, { name: 'viaje roma' }, { name: '' }, { name: 'Cliente X', scope: 'business' }]);
  assert.equal(groups.length, 2);
  assert.equal(groups[1].scope, 'business');
  const [roma] = groups;
  const list = [
    normalizeExpense({ amount: '50', date: '2026-11-10', category: 'Ocio', scope: roma.scope, group: roma.id }),
    normalizeExpense({ amount: '10', date: '2026-11-10', category: 'Comida' }),
    normalizeExpense({ amount: '99', date: '2026-11-10', category: 'Agencia', scope: 'business' }),
  ];
  assert.equal(list[0].group, roma.id);
  assert.equal(list[1].group, undefined);
  assert.equal(inScope(list, 'g:' + roma.id).length, 1);
  assert.equal(inScope(list, 'personal').length, 2); // el gasto del viaje cuenta también en Personal
  assert.equal(inScope(list, 'business').length, 1);
  assert.equal(inScope(list, '').length, 3);
  assert.deepEqual(fromRow(toRow('meta:groups', { value: groups, updatedAt: 'x' })).record.value, groups);
  assert.deepEqual(fromJSON(toJSON([], {}, [], { groups })).groups, groups);
});
