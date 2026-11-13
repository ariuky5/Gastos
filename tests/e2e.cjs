// Prueba de extremo a extremo en un móvil simulado. Uso: node tests/e2e.cjs
const { chromium, devices } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise((r) => server.listen(0, r));
  const url = `http://localhost:${server.address().port}/`;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['iPhone 13'], locale: 'es-ES', acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('dialog', (d) => d.accept());
  const eur = (s) => s.replace(/ /g, ' ');
  const total = async () => eur(await page.textContent('#month-total'));
  const step = (name) => console.log('ok -', name);

  await page.goto(url);
  assert.equal(await total(), '0,00 €');
  step('arranca vacía');

  // Alta rápida: importe + Enter
  const t0 = Date.now();
  await page.fill('#add-amount', '2,50');
  await page.click('.chip:has-text("Comida")');
  await page.fill('#add-form [name=note]', 'café');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.item');
  step(`alta de gasto (${Date.now() - t0} ms automatizado)`);
  assert.equal(await total(), '2,50 €');

  await page.fill('#add-amount', '47.30');
  await page.click('.chip:has-text("Supermercado")');
  await page.selectOption('#add-form [name=method]', 'Bizum');
  await page.click('#add-form button[type=submit]');
  await page.waitForFunction(() => document.querySelectorAll('.item').length === 2);
  assert.equal(await total(), '49,80 €');
  assert.equal(await page.textContent('#month-count'), '2 gastos');
  assert.match(eur(await page.textContent('#by-cat li:first-child')), /Supermercado.*47,30 €.*95%/);
  step('total mensual y desglose por categoría');

  // Recuerda la última categoría y método
  assert.equal(await page.inputValue('#add-form [name=method]'), 'Bizum');
  assert.ok(await page.isChecked('.chip:has-text("Supermercado") input'));
  step('recuerda última categoría y método');

  // Importe inválido
  await page.fill('#add-amount', 'abc');
  await page.keyboard.press('Enter');
  assert.equal(await page.textContent('#add-msg'), 'Importe no válido');
  assert.equal(await page.locator('.item').count(), 2);
  step('rechaza importe inválido');

  // Gasto en otro mes: la vista salta a ese mes
  await page.fill('#add-amount', '10');
  await page.fill('#add-form [name=date]', '2026-01-15');
  await page.click('#add-form button[type=submit]');
  await page.waitForFunction(() => document.querySelector('#month-label').textContent.includes('enero'));
  assert.equal(await total(), '10,00 €');
  await page.click('#next-month');
  assert.match(await page.textContent('#month-label'), /febrero de 2026/);
  assert.equal(await page.textContent('#list'), 'No hay movimientos este mes.');
  await page.click('#prev-month');
  step('navegación por meses');

  // Editar
  await page.click('.item');
  await page.fill('#edit-form [name=amount]', '12,00');
  await page.selectOption('#edit-form [name=category]', 'Ocio');
  await page.fill('#edit-form [name=note]', 'cine');
  await page.click('#edit-form button[type=submit]');
  await page.waitForFunction(() => !document.querySelector('#edit-dialog').open);
  assert.equal(await total(), '12,00 €');
  assert.match(await page.textContent('.item'), /cine.*Ocio/);
  step('editar');

  // Persistencia tras recargar
  await page.reload();
  await page.waitForSelector('#month-label');
  for (let i = 0; i < 24 && !(await page.textContent('#month-label')).includes('enero de 2026'); i++) await page.click('#prev-month');
  assert.equal(await total(), '12,00 €');
  step('los datos sobreviven a recargar');

  // Exportar JSON y CSV
  await page.click('#btn-data'); await page.$$eval('details.fold', (ds) => ds.forEach((d) => { d.open = true; }));
  const [dj] = await Promise.all([page.waitForEvent('download'), page.click('#export-json')]);
  const jsonPath = await dj.path();
  const exported = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  assert.equal(exported.expenses.length, 3);
  const [dc] = await Promise.all([page.waitForEvent('download'), page.click('#export-csv')]);
  const csv = fs.readFileSync(await dc.path(), 'utf8');
  assert.equal(csv.trim().split('\r\n').length, 4);
  assert.match(csv, /;"12,00";Ocio;/);
  step('exportar JSON y CSV');
  await page.click('#data-close');

  // Borrar
  await page.click('.item');
  await page.click('#edit-delete');
  await page.waitForFunction(() => !document.querySelector('#edit-dialog').open);
  assert.equal(await total(), '0,00 €');
  step('borrar');

  // Importar JSON restaura el borrado sin duplicar; importar CSV tampoco duplica
  await page.click('#btn-data'); await page.$$eval('details.fold', (ds) => ds.forEach((d) => { d.open = true; }));
  await page.setInputFiles('#import-file', { name: 'gastos.json', mimeType: 'application/json', buffer: fs.readFileSync(jsonPath) });
  await page.waitForFunction(() => /Importados 1 nuevos y 2 actualizados/.test(document.querySelector('#data-msg').textContent));
  await page.setInputFiles('#import-file', { name: 'gastos.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.waitForFunction(() => /Importados 0 nuevos y 3 actualizados/.test(document.querySelector('#data-msg').textContent));
  await page.setInputFiles('#import-file', { name: 'malo.csv', mimeType: 'text/csv', buffer: Buffer.from('a;b\n1;2\n') });
  await page.waitForFunction(() => /Faltan las columnas/.test(document.querySelector('#data-msg').textContent));
  await page.click('#data-close');
  assert.equal(await total(), '12,00 €');
  step('importar JSON y CSV fusiona por id');

  // Sin conexión
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload(); // primera carga controlada por el service worker
  await ctx.setOffline(true);
  await page.reload();
  await page.waitForSelector('#add-amount');
  await page.fill('#add-amount', '1');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('.item').length === 3);
  assert.equal(await total(), '50,80 €');
  await ctx.setOffline(false);
  step('funciona sin conexión');

  // ---------- Hito 2 ----------
  const text = async (sel) => eur(await page.textContent(sel));
  const pad = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const monthsAgo = (n) => { const d = new Date(now.getFullYear(), now.getMonth() - n, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
  const goTo = async (ym) => {
    const label = new Date(Number(ym.slice(0, 4)), Number(ym.slice(5)) - 1, 1).toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });
    for (let i = 0; i < 36 && (await page.textContent('#month-label')) !== label; i++) await page.click('#prev-month');
    assert.equal(await page.textContent('#month-label'), label);
  };

  // Ingreso y balance
  await page.click('.seg label:has-text("Ingreso")');
  assert.ok(await page.isVisible('.chip:has-text("Sueldo")'));
  await page.fill('#add-amount', '1500');
  await page.click('#add-submit');
  await page.waitForFunction(() => document.querySelector('#month-income').textContent.startsWith('1.500'));
  assert.equal(await total(), '50,80 €');
  assert.equal(await text('#month-balance'), '+1.449,20 €');
  assert.equal(await page.textContent('#month-count'), '3 gastos');
  assert.ok(await page.isChecked('.seg input[value=expense]'));
  step('ingresos y balance');

  // Presupuesto: aviso al 80 % y al 100 %
  await page.click('#btn-data'); await page.$$eval('details.fold', (ds) => ds.forEach((d) => { d.open = true; }));
  await page.fill('#budgets input[data-category="Comida"]', '3');
  await page.locator('#budgets input[data-category="Comida"]').blur();
  await page.waitForFunction(() => /Presupuesto de Comida/.test(document.querySelector('#data-msg').textContent));
  await page.click('#data-close');
  assert.match(await text('#alerts'), /🟡 Comida: vas por el 83 % del presupuesto \(quedan 0,50 €\)/);
  await page.fill('#add-amount', '1');
  await page.click('.chip:has-text("Comida")');
  await page.click('#add-submit');
  await page.waitForFunction(() => document.querySelector('#add-msg').textContent.startsWith('🔴'));
  assert.match(await text('#add-msg'), /🔴 Comida: 117 % del presupuesto \(3,50 € de 3,00 €\)/);
  assert.match(await text('#alerts'), /🔴 Comida: presupuesto superado \(117 %, 0,50 € de más\)/);
  assert.equal(await page.locator('#by-cat .bar.over').count(), 1);
  step('presupuestos con aviso al 80 % y 100 %');

  // Recurrente creado hace dos meses: genera el mes pasado y este, sin duplicar al recargar
  await page.fill('#add-amount', '9,99');
  await page.click('.chip:has-text("Suscripciones")');
  await page.fill('#add-form [name=note]', 'Netflix');
  await page.fill('#add-form [name=date]', monthsAgo(2) + '-01');
  await page.check('#add-form [name=repeat]');
  await page.click('#add-submit');
  await page.waitForFunction(() => /se repetirá/.test(document.querySelector('#add-msg').textContent));
  const netflix = page.locator('.item:has-text("Netflix")');
  for (const n of [2, 1, 0]) {
    await page.reload();
    await goTo(monthsAgo(n));
    assert.equal(await netflix.count(), 1, `Netflix en ${monthsAgo(n)}`);
  }
  assert.match(await netflix.textContent(), /recurrente/);
  step('recurrente genera los meses pendientes sin duplicar');

  // Borrar uno generado no lo vuelve a crear
  await goTo(monthsAgo(1));
  await netflix.click();
  await page.click('#edit-delete');
  await page.waitForFunction(() => !document.querySelector('#edit-dialog').open);
  await page.reload();
  await goTo(monthsAgo(1));
  assert.equal(await netflix.count(), 0);
  step('un recurrente borrado no reaparece');

  // Copia completa con presupuestos y recurrentes; quitar el recurrente
  await page.click('#btn-data'); await page.$$eval('details.fold', (ds) => ds.forEach((d) => { d.open = true; }));
  assert.match(await text('#recurring-list'), /Netflix · 9,99 € · día 1/);
  assert.equal(await page.inputValue('#budgets input[data-category="Comida"]'), '3,00');
  const [d2] = await Promise.all([page.waitForEvent('download'), page.click('#export-json')]);
  const full = JSON.parse(fs.readFileSync(await d2.path(), 'utf8'));
  assert.deepEqual(full.budgets, { Comida: 300 });
  assert.equal(full.recurring.length, 1);
  assert.equal(full.recurring[0].lastGenerated, monthsAgo(0));
  await page.click('#recurring-list button.danger');
  await page.waitForFunction(() => /No tienes ninguno/.test(document.querySelector('#recurring-list').textContent));
  await page.click('#data-close');
  step('copia completa y quitar recurrente');

  // Manifest e iconos
  const manifest = await (await page.request.get(url + 'manifest.webmanifest')).json();
  for (const icon of manifest.icons) assert.equal((await page.request.get(url + icon.src)).status(), 200);
  step('manifest e iconos');

  // Sin scroll horizontal en móvil
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  step('sin scroll horizontal');

  assert.deepEqual(errors.filter((e) => !/ERR_INTERNET_DISCONNECTED|Failed to load resource/.test(e)), []);
  if (process.argv[2]) {
    await page.reload();
    await page.screenshot({ path: process.argv[2], fullPage: true });
  }
  await browser.close();
  server.close();
  console.log('TODO OK');
})().catch((e) => { console.error(e); process.exit(1); });
