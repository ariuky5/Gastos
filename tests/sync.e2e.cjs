// Prueba la sincronización entre dos "dispositivos" contra un servidor de pega que imita el workflow de n8n.
// Uso: node tests/sync.e2e.cjs
const { chromium, devices } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const KEY = 'clave-de-prueba-0123456789';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

const app = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

// Mismo contrato que el workflow: cabecera X-Gastos-Key, action pull/push, tabla con syncedAt.
const table = new Map();
const calls = { pull: 0, push: 0 };
const api = http.createServer((req, res) => {
  const cors = { 'access-control-allow-origin': req.headers.origin || '*', 'access-control-allow-headers': req.headers['access-control-request-headers'] || '', 'access-control-allow-methods': 'POST, OPTIONS' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const send = (code, body) => { res.writeHead(code, { ...cors, 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.headers['x-gastos-key'] !== KEY) return send(403, { message: 'Authorization data is wrong!' });
    const body = JSON.parse(raw || '{}');
    if (body.action === 'pull') {
      calls.pull++;
      const since = Number(body.since) || 0;
      const rows = [...table.values()].filter((r) => r.syncedAt > since).map((r) => ({ id: r.recordId, data: r.data, updatedAt: r.clientUpdatedAt, deleted: r.deleted === true }));
      return send(200, { ok: true, cursor: Date.now() - 60000, rows });
    }
    if (body.action === 'push') {
      calls.push++;
      for (const row of body.rows) table.set(row.id, { recordId: row.id, data: row.data, clientUpdatedAt: row.updatedAt, deleted: row.deleted === true, syncedAt: Date.now() });
      return send(200, { ok: true });
    }
    send(400, { ok: false });
  });
});

(async () => {
  await new Promise((r) => app.listen(0, r));
  await new Promise((r) => api.listen(0, r));
  const url = `http://localhost:${app.address().port}/`;
  const hook = `http://127.0.0.1:${api.address().port}/webhook/gastos-sync`;
  const browser = await chromium.launch();
  const errors = [];
  const eur = (s) => s.replace(/ /g, ' ');
  const step = (name) => console.log('ok -', name);

  async function device(name) {
    const ctx = await browser.newContext({ ...devices['iPhone 13'], locale: 'es-ES' });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${name}: ${e}`));
    page.on('dialog', (d) => d.accept());
    await page.goto(url);
    const d = {
      ctx, page,
      total: async () => eur(await page.textContent('#month-total')),
      synced: () => page.waitForFunction(() => /^Sincronizado a las/.test(document.querySelector('#sync-status').textContent)),
      async add(amount, category, note) {
        await page.fill('#add-amount', amount);
        await page.click(`.chip:has-text("${category}")`);
        await page.fill('#add-form [name=note]', note);
        await page.click('#add-submit');
        await page.waitForSelector(`.item:has-text("${note}")`);
      },
      async connect(key = KEY) {
        await page.click('#btn-data');
        await page.fill('#sync-url', hook);
        await page.fill('#sync-key', key);
        await page.click('#sync-save');
      },
      async reload() { await page.reload(); await d.synced(); },
    };
    return d;
  }

  // A: datos previos a activar la sincronización
  const A = await device('A');
  await A.add('2,50', 'Comida', 'café');
  await A.add('40', 'Supermercado', 'compra');
  await A.page.click('#btn-data');
  await A.page.fill('#budgets input[data-category="Comida"]', '3');
  await A.page.locator('#budgets input[data-category="Comida"]').blur();
  await A.page.click('#data-close');
  await A.page.fill('#add-amount', '9,99');
  await A.page.click('.chip:has-text("Suscripciones")');
  await A.page.fill('#add-form [name=note]', 'Netflix');
  await A.page.check('#add-form [name=repeat]');
  await A.page.click('#add-submit');
  await A.page.waitForSelector('.item:has-text("Netflix")');
  assert.equal(calls.pull + calls.push, 0);
  step('sin configurar no se llama a ningún servidor');

  // Validaciones del formulario
  await A.page.click('#btn-data');
  await A.page.fill('#sync-url', 'http://inseguro.example/webhook');
  await A.page.fill('#sync-key', KEY);
  await A.page.click('#sync-save');
  assert.match(await A.page.textContent('#sync-msg'), /https/);
  await A.page.click('#sync-generate');
  assert.match(await A.page.inputValue('#sync-key'), /^[0-9a-f]{48}$/);
  await A.page.click('#data-close');
  step('valida la URL y genera claves');

  await A.connect();
  await A.synced();
  await A.page.click('#data-close');
  assert.equal([...table.values()].filter((r) => !r.deleted).length, 5); // 3 movimientos + recurrente + presupuestos
  assert.ok(table.has('meta:budgets'));
  step('A sube todo lo que ya tenía');

  // B: dispositivo nuevo
  const B = await device('B');
  assert.equal(await B.total(), '0,00 €');
  await B.connect();
  await B.synced();
  assert.match(eur(await B.page.textContent('#recurring-list')), /Netflix · 9,99 € · día/);
  assert.equal(await B.page.inputValue('#budgets input[data-category="Comida"]'), '3,00');
  await B.page.click('#data-close');
  assert.equal(await B.total(), '52,49 €');
  assert.equal(await B.page.locator('.item').count(), 3);
  assert.match(eur(await B.page.textContent('#alerts')), /🟡 Comida/);
  step('B recibe movimientos, presupuestos y recurrentes');

  // Edición en B llega a A
  await B.page.click('.item:has-text("compra")');
  await B.page.fill('#edit-form [name=amount]', '45');
  await B.page.click('#edit-form button[type=submit]');
  await B.page.waitForFunction(() => document.querySelector('#month-total').textContent.startsWith('57,49'));
  await B.page.waitForTimeout(2500); // el envío va con 1,5 s de retardo
  await A.reload();
  assert.equal(await A.total(), '57,49 €');
  step('una edición en B aparece en A');

  // Borrado en A llega a B
  await A.page.click('.item:has-text("café")');
  await A.page.click('#edit-delete');
  await A.page.waitForFunction(() => !document.querySelector('#edit-dialog').open);
  await A.page.waitForTimeout(2500);
  await B.reload();
  assert.equal(await B.page.locator('.item:has-text("café")').count(), 0);
  assert.equal(await B.total(), '54,99 €');
  step('un borrado en A desaparece en B');

  // Conflicto: A edita sin conexión, B edita después. Gana el cambio más reciente (B).
  await A.page.evaluate(() => navigator.serviceWorker.ready);
  await A.page.reload();
  await A.synced();
  await A.ctx.setOffline(true);
  await A.page.click('.item:has-text("compra")');
  await A.page.fill('#edit-form [name=amount]', '10');
  await A.page.click('#edit-form button[type=submit]');
  await A.page.waitForFunction(() => /^Sin sincronizar/.test(document.querySelector('#sync-status').textContent));
  step('sin conexión avisa y guarda en local');
  await B.page.click('.item:has-text("compra")');
  await B.page.fill('#edit-form [name=amount]', '60');
  await B.page.click('#edit-form button[type=submit]');
  await B.page.waitForTimeout(2500);
  await A.ctx.setOffline(false);
  await A.reload();
  assert.equal(await A.total(), '69,99 €'); // 60 + 9,99
  await B.reload();
  assert.equal(await B.total(), '69,99 €');
  step('conflicto: gana el cambio más reciente en los dos');

  // Cambio sin conexión que sí es el más reciente: se envía al volver
  await A.ctx.setOffline(true);
  await A.add('5', 'Ocio', 'cine');
  await A.ctx.setOffline(false);
  await A.reload();
  await B.reload();
  assert.equal(await B.page.locator('.item:has-text("cine")').count(), 1);
  assert.equal(await B.total(), '74,99 €');
  step('lo apuntado sin conexión se envía al volver');

  // Quitar un recurrente en B se propaga a A
  await B.page.click('#btn-data');
  await B.page.click('#recurring-list button');
  await B.page.waitForFunction(() => /No tienes ninguno/.test(document.querySelector('#recurring-list').textContent));
  await B.page.click('#data-close');
  await B.page.waitForTimeout(2500);
  await A.reload();
  await A.page.click('#btn-data');
  assert.match(await A.page.textContent('#recurring-list'), /No tienes ninguno/);
  await A.page.click('#data-close');
  step('quitar un recurrente se propaga');

  // Sin duplicados en ningún lado
  for (const d of [A, B]) assert.equal(await d.page.locator('.item').count(), 3);
  assert.equal(new Set([...table.keys()]).size, table.size);
  step('sin duplicados');

  // Clave incorrecta
  const C = await device('C');
  await C.connect('clave-equivocada-000000');
  await C.page.waitForFunction(() => /rechaza la clave/.test(document.querySelector('#sync-msg').textContent));
  assert.equal(await C.total(), '0,00 €');
  step('clave incorrecta: no entra y lo dice');

  assert.deepEqual(errors, []);
  await browser.close();
  app.close(); api.close();
  console.log('TODO OK');
})().catch((e) => { console.error(e); process.exit(1); });
