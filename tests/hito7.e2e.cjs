// Recurrentes desde Ajustes (también anuales), comparativa con el mes anterior y objetivos de ahorro.
// Fecha fija: viernes 13 de noviembre de 2026 (hora de Madrid). Uso: node tests/hito7.e2e.cjs [captura.png]
const { chromium, devices } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const KEY = 'clave-de-prueba-0123456789';
const NOW = new Date('2026-11-13T12:00:00+01:00');
const START = Date.now();
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

// Servidor de pega con el mismo contrato que el workflow de n8n (ver tests/sync.e2e.cjs).
const table = new Map();
const api = http.createServer((req, res) => {
  const cors = { 'access-control-allow-origin': req.headers.origin || '*', 'access-control-allow-headers': req.headers['access-control-request-headers'] || '', 'access-control-allow-methods': 'POST, OPTIONS' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const send = (code, body) => { res.writeHead(code, { ...cors, 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.headers['x-gastos-key'] !== KEY) return send(403, {});
    const body = JSON.parse(raw || '{}');
    if (body.action === 'pull') {
      const since = Number(body.since) || 0;
      const rows = [...table.values()].filter((r) => r.syncedAt > since).map((r) => ({ id: r.recordId, data: r.data, updatedAt: r.clientUpdatedAt, deleted: r.deleted }));
      return send(200, { ok: true, cursor: Date.now() - 60000, rows });
    }
    if (body.action === 'push') {
      for (const row of body.rows) table.set(row.id, { recordId: row.id, data: row.data, clientUpdatedAt: row.updatedAt, deleted: row.deleted === true, syncedAt: Date.now() });
      return send(200, { ok: true });
    }
    send(400, {});
  });
});

(async () => {
  await new Promise((r) => server.listen(0, r));
  await new Promise((r) => api.listen(0, r));
  const url = `http://localhost:${server.address().port}/`;
  const hook = `http://127.0.0.1:${api.address().port}/webhook/gastos-sync`;
  const browser = await chromium.launch();
  const errors = [];
  const eur = (s) => s.replace(/ /g, ' ');
  const step = (name) => console.log('ok -', name);

  async function device(name, opts = {}, offsetMs = 0) {
    const ctx = await browser.newContext({ ...devices['iPhone 13'], locale: 'es-ES', timezoneId: 'Europe/Madrid', acceptDownloads: true, ...opts });
    await ctx.addInitScript(() => localStorage.setItem('gastos.sync.unlocked', '1'));
    const page = await ctx.newPage();
    // Todos los dispositivos comparten la misma línea temporal, que avanza en tiempo real desde NOW.
    await page.clock.install({ time: new Date(NOW.getTime() + offsetMs + (Date.now() - START)) });
    page.on('pageerror', (e) => errors.push(`${name}: ${e}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
    page.on('dialog', (d) => d.accept());
    await page.goto(url);
    return { ctx, page, text: async (sel) => eur(await page.textContent(sel)) };
  }
  const openSettings = async (page) => { await page.click('#btn-data'); await page.$$eval('details.fold', (ds) => ds.forEach((d) => { d.open = true; })); };

  const A = await device('A');
  const { page, text } = A;

  // ---------- 4. Comparativa ----------
  async function add(amount, category, date, note = '') {
    if (category === 'Sueldo') await page.click('#add-form .seg label:has-text("Ingreso")');
    await page.fill('#add-amount', amount);
    await page.click(`.chip:has-text("${category}")`);
    await page.fill('#add-form [name=date]', date);
    await page.fill('#add-form [name=note]', note);
    await page.evaluate(() => { document.querySelector('#add-msg').textContent = ''; });
    await page.click('#add-submit');
    await page.waitForFunction(() => document.querySelector('#add-msg').textContent.length > 0);
  }
  await add('10', 'Comida', '2026-10-02');
  await add('40', 'Comida', '2026-10-25');
  await add('20', 'Ocio', '2026-10-05');
  await add('30', 'Comida', '2026-11-03');
  await add('15', 'Casa', '2026-11-10');
  await add('2000', 'Sueldo', '2026-11-01');
  assert.match(await text('#month-label'), /noviembre/);
  assert.equal(await page.isVisible('#cmp-mode'), true);
  assert.match(await text('#cmp-sub'), /^noviembre frente a octubre \(del 1 al 13 de cada mes\)$/);
  const rows = async () => (await page.locator('#cmp-rows li').allTextContents()).map(eur);
  let r = await rows();
  assert.match(r[0], /Total gastos45,00 €antes 30,00 €▲ 15,00 € · \+50 %/);
  assert.ok(r.some((x) => /Comida30,00 €antes 10,00 €▲ 20,00 € · \+200 %/.test(x)), r.join('\n'));
  assert.ok(r.some((x) => /Ocio0,00 €antes 20,00 €▼ 20,00 € · -100 %/.test(x)), r.join('\n'));
  assert.ok(r.some((x) => /Casa15,00 €antes 0,00 €▲ 15,00 € · nuevo/.test(x)), r.join('\n'));
  assert.match(r[r.length - 1], /Ingresos2\.000,00 €antes 0,00 €▲ 2\.000,00 € · nuevo/);
  assert.equal(await page.getAttribute('#cmp-rows li.cmp-total .cmp-diff', 'class'), 'cmp-diff worse');
  assert.equal(await page.getAttribute('#cmp-rows li.cmp-income .cmp-diff', 'class'), 'cmp-diff better');
  step('comparativa del mes en curso con los mismos días del mes anterior');

  await page.click('#cmp-mode label:has-text("Mes completo")');
  r = await rows();
  assert.match(r[0], /Total gastos45,00 €antes 70,00 €▼ 25,00 € · -36 %/);
  assert.equal(await page.getAttribute('#cmp-rows li.cmp-total .cmp-diff', 'class'), 'cmp-diff better');
  assert.match(await text('#cmp-sub'), /^noviembre frente a octubre$/);
  await page.reload();
  assert.ok(await page.isChecked('#cmp-mode input[value=full]'));
  await page.click('#prev-month');
  assert.equal(await page.isVisible('#cmp-mode'), false);
  assert.match(await text('#cmp-sub'), /^octubre frente a septiembre$/);
  assert.match((await rows())[0], /Total gastos70,00 €antes 0,00 €▲ 70,00 € · nuevo/);
  await page.click('#view label:has-text("Agencia")');
  assert.match(await text('#cmp-rows'), /Sin movimientos en octubre ni en septiembre/);
  await page.click('#view label:has-text("Todo")');
  await page.click('#next-month');
  await page.click('#cmp-mode label:has-text("Mismos días")');
  step('mes completo, se recuerda, meses pasados y vistas');

  // ---------- 2. Avisos de presupuesto (ya existían): siguen funcionando ----------
  await openSettings(page);
  await page.fill('#budgets input[data-category="Comida"]', '36');
  await page.locator('#budgets input[data-category="Comida"]').blur();
  await page.click('#data-close');
  assert.match(await text('#alerts'), /🟡 Comida: vas por el 83 % del presupuesto \(quedan 6,00 €\)/);
  await add('10', 'Comida', '2026-11-12');
  assert.match(await text('#add-msg'), /🔴 Comida: 111 % del presupuesto/);
  assert.match(await text('#alerts'), /🔴 Comida: presupuesto superado \(111 %, 4,00 € de más\)/);
  step('avisos de presupuesto al 80 % y al 100 %');

  // ---------- 1. Recurrentes desde Ajustes ----------
  await openSettings(page);
  await page.click('#rec-new');
  assert.equal(await page.inputValue('#rec-form [name=next]'), '2026-11-13');
  assert.equal(await page.isVisible('#rec-delete'), false);
  await page.fill('#rec-form [name=amount]', '120');
  await page.selectOption('#rec-form [name=category]', 'Suscripciones');
  await page.fill('#rec-form [name=note]', 'Dominio web');
  await page.selectOption('#rec-form [name=every]', '12');
  await page.fill('#rec-form [name=next]', '2026-11-01');
  await page.click('#rec-form button[type=submit]');
  await page.waitForFunction(() => /Recurrente añadido/.test(document.querySelector('#data-msg').textContent));
  assert.match(await text('#data-msg'), /próximo cargo el 1 nov\.? 2027\. Se ha apuntado 1 movimiento/);
  assert.match(await text('#recurring-list'), /Dominio web · 120,00 € · día 1 · cada año · próximo 1 nov\.? 2027/);

  await page.click('#rec-new');
  await page.selectOption('#rec-form [name=type]', 'income');
  await page.fill('#rec-form [name=amount]', '500');
  await page.fill('#rec-form [name=note]', 'Cliente fijo');
  await page.selectOption('#rec-form [name=scope]', 'business');
  await page.fill('#rec-form [name=next]', '2026-12-05');
  await page.click('#rec-form button[type=submit]');
  await page.waitForFunction(() => /Cliente fijo/.test(document.querySelector('#recurring-list').textContent));
  assert.doesNotMatch(await text('#data-msg'), /apuntado/);
  // Ordenados por próximo cargo
  const recRows = (await page.locator('#recurring-list li').allTextContents()).map(eur);
  assert.match(recRows[0], /Cliente fijo · \+500,00 € · día 5 · próximo 5 dic/);
  assert.match(recRows[1], /Dominio web/);

  // Editar: cambia lo que viene, no lo ya apuntado
  await page.click('#recurring-list li:has-text("Dominio web") button:has-text("Editar")');
  assert.equal(await page.inputValue('#rec-form [name=amount]'), '120,00');
  assert.equal(await page.inputValue('#rec-form [name=every]'), '12');
  assert.equal(await page.inputValue('#rec-form [name=next]'), '2027-11-01');
  await page.fill('#rec-form [name=amount]', '130');
  await page.click('#rec-form button[type=submit]');
  await page.waitForFunction(() => /130,00/.test(document.querySelector('#recurring-list').textContent));
  await page.click('#data-close');
  const dominio = page.locator('.item:has-text("Dominio web")');
  assert.equal(await dominio.count(), 1);
  assert.match(eur(await dominio.textContent()), /recurrente.*-?120,00 €/);
  await page.reload();
  assert.equal(await page.locator('.item:has-text("Dominio web")').count(), 1);
  assert.equal(await page.locator('.item:has-text("Cliente fijo")').count(), 0);
  step('añadir (anual, con cargo pasado) y editar recurrentes desde Ajustes sin duplicar');

  // ---------- 3. Objetivos de ahorro ----------
  assert.match(await text('#goals'), /Aún no tienes objetivos/);
  await page.click('#goal-new');
  await page.fill('#goal-form [name=emoji]', '🛟');
  await page.fill('#goal-form [name=name]', 'Colchón');
  await page.fill('#goal-form [name=target]', '3000');
  await page.fill('#goal-form [name=saved]', '750');
  await page.fill('#goal-form [name=deadline]', '2027-04-30');
  await page.click('#goal-form button[type=submit]');
  await page.waitForSelector('#goals .goal-open');
  assert.match(await text('#goals li'), /🛟 Colchón750,00 € de 3\.000,00 €25 % · faltan 2\.250,00 € · 375,00 €\/mes hasta abril de 2027/);
  assert.equal(await page.getAttribute('#goals [role=progressbar]', 'aria-valuenow'), '25');

  await page.click('#goals button:has-text("Aportar")');
  assert.match(await text('#save-msg'), /Llevas 750,00 € de 3\.000,00 €/);
  await page.fill('#save-form [name=amount]', '250');
  await page.click('#save-in');
  await page.waitForFunction(() => /1\.000,00/.test(document.querySelector('#goals').textContent));
  assert.match(await text('#add-msg'), /Colchón: 1\.000,00 € de 3\.000,00 € \(33 %\)/);
  await page.click('#goals button:has-text("Aportar")');
  await page.fill('#save-form [name=amount]', '2000');
  await page.click('#save-out');
  assert.match(await text('#save-msg'), /Solo llevas 1\.000,00 €/);
  await page.fill('#save-form [name=amount]', '100');
  await page.click('#save-out');
  await page.waitForFunction(() => /900,00\s€ de/.test(document.querySelector('#goals').textContent));

  // Validación del formulario
  await page.click('#goal-new');
  await page.fill('#goal-form [name=name]', 'Coche');
  await page.click('#goal-form button[type=submit]');
  assert.match(await text('#goal-msg'), /La meta tiene que ser/);
  await page.fill('#goal-form [name=target]', '8000');
  await page.click('#goal-form button[type=submit]');
  await page.waitForFunction(() => document.querySelectorAll('#goals .goal-open').length === 2);
  assert.match(await text('#goals li:nth-child(2)'), /🎯 Coche0,00 € de 8\.000,00 €0 % · faltan 8\.000,00 €\+ Aportar$/);

  // Editar: meta alcanzada
  await page.click('#goals .goal-open:has-text("Colchón")');
  assert.equal(await page.inputValue('#goal-form [name=saved]'), '900,00');
  await page.fill('#goal-form [name=target]', '900');
  await page.click('#goal-form button[type=submit]');
  await page.waitForFunction(() => /conseguido/.test(document.querySelector('#goals').textContent));
  assert.match(await page.getAttribute('#goals li:first-child .bar', 'class'), /done/);
  await page.reload();
  assert.equal(await page.locator('#goals .goal-open').count(), 2);
  step('crear, aportar, sacar y editar objetivos (y se guardan)');

  // Modo privado
  await page.click('#btn-private');
  const blurred = (sel) => page.evaluate((s) => getComputedStyle(document.querySelector(s)).filter, sel);
  for (const sel of ['.goal-amt', '.goal-foot small', '.cmp-amt', '.cmp-diff', '.cmp-before']) assert.match(await blurred(sel), /blur/, sel);
  assert.equal(await blurred('.goal-name'), 'none');
  if (process.argv[2]) {
    await page.click('#btn-private');
    await page.locator('.card-compare').scrollIntoViewIfNeeded();
    await page.screenshot({ path: process.argv[2], fullPage: true });
    await page.click('#btn-private');
  }
  await page.click('#btn-private');
  step('modo privado oculta los importes nuevos');

  // ---------- Copia JSON con objetivos y recurrentes anuales ----------
  await openSettings(page);
  const [d] = await Promise.all([page.waitForEvent('download'), page.click('#export-json')]);
  const backup = fs.readFileSync(await d.path());
  const parsed = JSON.parse(backup);
  assert.equal(parsed.goals.length, 2);
  assert.equal(parsed.recurring.find((x) => x.note === 'Dominio web').every, 12);
  await page.click('#data-close');
  const C = await device('C');
  await openSettings(C.page);
  await C.page.setInputFiles('#import-file', { name: 'gastos.json', mimeType: 'application/json', buffer: backup });
  await C.page.waitForFunction(() => /Importados/.test(document.querySelector('#data-msg').textContent));
  assert.match(await C.text('#recurring-list'), /Dominio web · 130,00 € · día 1 · cada año/);
  await C.page.click('#data-close');
  assert.equal(await C.page.locator('#goals .goal-open').count(), 2);
  assert.equal(await C.page.locator('.item:has-text("Dominio web")').count(), 1);
  await C.ctx.close();
  step('la copia JSON incluye objetivos y periodicidad, y se restaura sin duplicar');

  // ---------- Sincronización entre dos dispositivos ----------
  async function connect(dev) {
    await openSettings(dev.page);
    await dev.page.fill('#sync-url', hook);
    await dev.page.fill('#sync-key', KEY);
    await dev.page.click('#sync-save');
    await dev.page.waitForFunction(() => /^Sincronizado a las/.test(document.querySelector('#sync-status').textContent));
    await dev.page.click('#data-close');
  }
  await connect(A);
  // Recurrente mensual que empezó en septiembre: A apunta septiembre, octubre y noviembre
  await openSettings(page);
  await page.click('#rec-new');
  await page.fill('#rec-form [name=amount]', '650');
  await page.selectOption('#rec-form [name=category]', 'Casa');
  await page.fill('#rec-form [name=note]', 'Alquiler');
  await page.fill('#rec-form [name=next]', '2026-09-01');
  await page.click('#rec-form button[type=submit]');
  await page.waitForFunction(() => /Se han apuntado 3 movimientos/.test(document.querySelector('#data-msg').textContent));
  await page.click('#data-close');
  await page.waitForFunction(() => /^Sincronizado a las/.test(document.querySelector('#sync-status').textContent) && !document.querySelector('#sync-status').textContent.includes('…'));
  await page.click('#btn-refresh');
  await page.waitForFunction(() => /^Sincronizado a las/.test(document.querySelector('#sync-status').textContent));

  const B = await device('B', {}, 3600000); // B va una hora por delante: sus cambios son siempre los más recientes
  await connect(B);
  await B.page.click('#btn-refresh');
  await B.page.waitForFunction(() => /^Sincronizado a las/.test(document.querySelector('#sync-status').textContent));
  assert.equal(await B.page.locator('#goals .goal-open').count(), 2);
  assert.match(await B.text('#goals'), /Colchón900,00 € de 900,00 €/);
  assert.equal(await B.page.locator('.item:has-text("Alquiler")').count(), 1);
  await B.page.reload();
  await B.page.click('#btn-refresh');
  await B.page.waitForFunction(() => /^Sincronizado a las/.test(document.querySelector('#sync-status').textContent));
  const alquiler = [...table.values()].filter((x) => !x.deleted && x.recordId.includes('-2026-') && x.data.includes('Alquiler'));
  assert.equal(alquiler.length, 3, alquiler.map((x) => x.recordId).join(', '));
  assert.equal(await B.page.evaluate(() => document.querySelectorAll('.item').length), await page.evaluate(() => document.querySelectorAll('.item').length));

  // Aportar en B llega a A
  await B.page.click('#goals li:nth-child(2) button:has-text("Aportar")');
  await B.page.fill('#save-form [name=amount]', '300');
  await B.page.click('#save-in');
  await B.page.waitForFunction(() => /300,00\s€ de 8\.000,00/.test(document.querySelector('#goals').textContent));
  // La app envía el cambio 1,5 s después: esperar a que llegue al servidor.
  for (let i = 0; i < 100 && !/"saved":30000/.test((table.get('meta:goals') || { data: '' }).data); i++) await new Promise((res) => setTimeout(res, 100));
  await page.click('#btn-refresh');
  await page.waitForFunction(() => /300,00\s€ de 8\.000,00/.test(document.querySelector('#goals').textContent));
  step('objetivos y recurrentes se sincronizan sin duplicar movimientos');

  // ---------- Ordenador: las tarjetas nuevas caben ----------
  const D = await device('D', { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } });
  await D.page.click('#goal-new');
  await D.page.click('#goal-cancel');
  const box = async (sel) => D.page.locator(sel).boundingBox();
  const cmp = await box('.card-compare'), goals = await box('.card-goals'), sum = await box('.card-summary');
  assert.ok(cmp.y > sum.y && Math.abs(cmp.y - goals.y) < 2 && goals.x > cmp.x, 'comparativa y objetivos en la misma fila');
  assert.ok(await D.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  step('diseño de ordenador y móvil sin scroll horizontal');

  assert.deepEqual(errors, []);
  await browser.close();
  server.close();
  api.close();
  console.log('TODO OK');
})().catch((e) => { console.error(e); process.exit(1); });
