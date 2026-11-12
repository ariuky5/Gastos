// Nodo Code de n8n (Run Once for All Items). Entrada: todas las filas de la tabla gastos_sync.
// Salida: un único item { subject, html, hasData } con el resumen de la semana (ver fechas abajo).
const APP_URL = 'https://ariuky5.github.io/Gastos/';
const TZ = 'Europe/Madrid';

// ---------- Fechas (en hora de Madrid) ----------
const todayISO = (() => {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
  catch (e) { return new Date().toISOString().slice(0, 10); }
})();
const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
// El lunes (envío automático) resume la semana pasada de lunes a domingo.
// Cualquier otro día (ejecución a mano) resume la semana en curso, de lunes a hoy.
const weekday = (new Date(todayISO + 'T12:00:00Z').getUTCDay() + 6) % 7; // 0 = lunes
const isMonday = weekday === 0;
const weekStart = isMonday ? addDays(todayISO, -7) : addDays(todayISO, -weekday);
const weekEnd = isMonday ? addDays(todayISO, -1) : todayISO;
const month = weekEnd.slice(0, 7);
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const dayMonth = (iso) => `${Number(iso.slice(8))} de ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;
const rangeLabel = weekStart.slice(0, 7) === weekEnd.slice(0, 7)
  ? `${Number(weekStart.slice(8))} al ${dayMonth(weekEnd)}`
  : `${dayMonth(weekStart)} al ${dayMonth(weekEnd)}`;

// ---------- Datos ----------
const DEFAULT_EMOJI = { Comida: '🍽️', Supermercado: '🛒', Transporte: '🚗', Casa: '🏠', Suscripciones: '🔁', Ocio: '🎉', Salud: '💊', Ropa: '👕', Agencia: '💼', Otros: '📦', Sueldo: '💰', 'Otros ingresos': '➕' };
const expenses = [];
let budgets = {};
let emoji = { ...DEFAULT_EMOJI };
for (const item of $input.all()) {
  const row = item.json || {};
  if (!row.recordId || row.deleted === true) continue;
  let data;
  try { data = JSON.parse(row.data); } catch (e) { continue; }
  if (row.recordId === 'meta:budgets') { budgets = (data && data.value) || {}; continue; }
  if (row.recordId === 'meta:categories') {
    if (data && Array.isArray(data.value)) { emoji = { ...DEFAULT_EMOJI }; for (const c of data.value) emoji[c.name] = c.emoji; }
    continue;
  }
  if (row.recordId.startsWith('meta:') || row.recordId.startsWith('rec:')) continue;
  if (!data || !Number.isInteger(data.amount) || typeof data.date !== 'string') continue;
  expenses.push(data);
}

const isIncome = (e) => e.type === 'income';
const sum = (list) => list.reduce((s, e) => s + e.amount, 0);
const inWeek = expenses.filter((e) => e.date >= weekStart && e.date <= weekEnd);
const inMonth = expenses.filter((e) => e.date.startsWith(month) && e.date <= weekEnd);
const weekSpend = inWeek.filter((e) => !isIncome(e));
const weekIncome = inWeek.filter(isIncome);
const monthSpend = inMonth.filter((e) => !isIncome(e));
const monthBalance = sum(inMonth.filter(isIncome)) - sum(monthSpend);

const group = (list) => {
  const map = {};
  for (const e of list) map[e.category] = (map[e.category] || 0) + e.amount;
  return Object.keys(map).map((category) => ({ category, amount: map[category] })).sort((a, b) => b.amount - a.amount);
};
const byCategory = group(weekSpend);
const monthByCategory = group(monthSpend);
const budgetRows = Object.keys(budgets)
  .filter((c) => budgets[c] > 0)
  .map((category) => {
    const spent = (monthByCategory.find((r) => r.category === category) || { amount: 0 }).amount;
    return { category, spent, budget: budgets[category], pct: Math.round((spent / budgets[category]) * 100) };
  })
  .sort((a, b) => b.pct - a.pct);
const top = [...weekSpend].sort((a, b) => b.amount - a.amount).slice(0, 5);
const agency = sum(weekSpend.filter((e) => e.scope === 'business'));

// ---------- HTML ----------
const eur = (cents) => (cents / 100).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: 'always' }).replace(/ /g, ' ') + ' €';
const esc = (t) => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const C = { ink: '#17201e', muted: '#6b7673', line: '#e6e9e7', bg: '#f4f5f3', card: '#ffffff', accent: '#0f766e', warn: '#b54708', over: '#b42318', ok: '#067647', track: '#eef1f0' };
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

const bar = (pct, color) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:6px"><tr>
  <td style="background:${C.track};border-radius:3px;height:6px;font-size:0;line-height:0">
    <table role="presentation" width="${Math.max(2, Math.min(100, pct))}%" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr><td style="background:${color};border-radius:3px;height:6px;font-size:0;line-height:0">&nbsp;</td></tr></table>
  </td></tr></table>`;

const sectionTitle = (text) => `<tr><td style="padding:28px 32px 4px;font:600 12px ${FONT};letter-spacing:.08em;text-transform:uppercase;color:${C.muted}">${esc(text)}</td></tr>`;
const line = (left, right, extra) => `<tr><td style="padding:10px 32px 0">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr>
    <td style="font:400 15px ${FONT};color:${C.ink}">${left}</td>
    <td align="right" style="font:600 15px ${FONT};color:${C.ink};white-space:nowrap">${right}</td>
  </tr></table>${extra || ''}</td></tr>`;

const stat = (label, value, color) => `<td width="33%" valign="top" style="padding:0 6px">
  <div style="font:400 12px ${FONT};color:${C.muted}">${esc(label)}</div>
  <div style="font:700 19px ${FONT};color:${color || C.ink};padding-top:4px;white-space:nowrap">${value}</div></td>`;

const totalSpend = sum(weekSpend);
let body = '';
if (!inWeek.length) {
  body += `<tr><td style="padding:28px 32px 0;font:400 15px/1.5 ${FONT};color:${C.ink}">No apuntaste ningún movimiento esta semana. Si es porque no gastaste, enhorabuena. Si se te pasó, estás a tiempo de apuntarlo.</td></tr>`;
} else {
  if (byCategory.length) {
    body += sectionTitle('En qué se fue');
    for (const r of byCategory) {
      const pct = totalSpend ? Math.round((r.amount / totalSpend) * 100) : 0;
      body += line(`${esc(emoji[r.category] || '📦')}&nbsp; ${esc(r.category)}`, `${eur(r.amount)} <span style="font-weight:400;color:${C.muted}">· ${pct} %</span>`, bar(pct, C.accent));
    }
  }
  if (top.length) {
    body += sectionTitle('Los gastos más grandes');
    for (const e of top) {
      body += line(`${esc(e.note || e.category)} <span style="color:${C.muted};font-size:13px">· ${dayMonth(e.date)}</span>`, eur(e.amount));
    }
  }
  if (agency > 0) {
    body += sectionTitle('Personal y agencia');
    body += line('Personal', eur(totalSpend - agency));
    body += line('Agencia', eur(agency));
  }
}
if (budgetRows.length) {
  body += sectionTitle(`Presupuestos de ${MONTHS[Number(month.slice(5)) - 1]}`);
  for (const r of budgetRows) {
    const color = r.pct >= 100 ? C.over : r.pct >= 80 ? C.warn : C.accent;
    const tag = r.pct >= 100 ? ' · superado' : r.pct >= 80 ? ' · cerca del límite' : '';
    body += line(`${esc(emoji[r.category] || '📦')}&nbsp; ${esc(r.category)}<span style="color:${color};font-size:13px">${tag}</span>`,
      `${eur(r.spent)} <span style="font-weight:400;color:${C.muted}">de ${eur(r.budget)}</span>`, bar(r.pct, color));
  }
}

const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tu semana</title></head>
<body style="margin:0;padding:0;background:${C.bg}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">Gastaste ${eur(totalSpend)} del ${rangeLabel}. Balance del mes: ${eur(monthBalance)}.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:${C.bg}"><tr><td align="center" style="padding:32px 12px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;max-width:560px;background:${C.card};border:1px solid ${C.line};border-radius:16px">
    <tr><td style="padding:32px 32px 0">
      <div style="font:600 12px ${FONT};letter-spacing:.14em;text-transform:uppercase;color:${C.accent}">uky_system · Gastos</div>
      <div style="font:700 28px/1.2 ${FONT};color:${C.ink};padding-top:10px">Tu semana</div>
      <div style="font:400 15px ${FONT};color:${C.muted};padding-top:4px">Del ${rangeLabel}</div>
    </td></tr>
    <tr><td style="padding:24px 32px 0">
      <div style="font:400 13px ${FONT};color:${C.muted}">Gastado esta semana</div>
      <div style="font:700 40px/1.1 ${FONT};color:${C.ink};padding-top:4px;letter-spacing:-.01em">${eur(totalSpend)}</div>
    </td></tr>
    <tr><td style="padding:20px 26px 0">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border-top:1px solid ${C.line}"><tr><td style="padding-top:16px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr>
          ${stat('Movimientos', String(inWeek.length))}
          ${stat('Ingresos semana', eur(sum(weekIncome)))}
          ${stat('Balance del mes', (monthBalance > 0 ? '+' : '') + eur(monthBalance), monthBalance > 0 ? C.ok : monthBalance < 0 ? C.over : C.ink)}
        </tr></table>
      </td></tr></table>
    </td></tr>
    ${body}
    <tr><td align="center" style="padding:32px 32px 0">
      <a href="${APP_URL}" style="display:inline-block;background:${C.accent};color:#ffffff;text-decoration:none;font:600 15px ${FONT};padding:13px 26px;border-radius:10px">Abrir la app</a>
    </td></tr>
    <tr><td align="center" style="padding:24px 32px 28px;font:400 12px/1.5 ${FONT};color:${C.muted}">
      <span style="letter-spacing:.1em;font-weight:600">uky_system</span>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;

return [{ json: { subject: `Tu semana: ${eur(totalSpend)} gastados (${rangeLabel})`, html, hasData: inWeek.length > 0 } }];
