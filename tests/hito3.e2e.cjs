// Gráfico, etiquetas, búsqueda y filtros en un móvil simulado. Uso: node tests/hito3.e2e.cjs [captura.png] [captura-oscura.png]
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
  const ctx = await browser.newContext({ ...devices['iPhone 13'], locale: 'es-ES' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const eur = (s) => s.replace(/ /g, ' ');
  const text = async (sel) => eur(await page.textContent(sel));
  const step = (name) => console.log('ok -', name);
  const pad = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const ym = (back) => { const d = new Date(now.getFullYear(), now.getMonth() - back, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
  const label = (back) => new Date(now.getFullYear(), now.getMonth() - back, 1).toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });

  await page.goto(url);
  let n = 0;
  async function add({ amount, category, note = '', back = 0, income = false, method }) {
    if (income) await page.click('.seg label:has-text("Ingreso")');
    await page.fill('#add-amount', amount);
    await page.click(`.chip:has-text("${category}")`);
    await page.fill('#add-form [name=note]', note);
    await page.fill('#add-form [name=date]', `${ym(back)}-01`);
    if (method) await page.selectOption('#add-form [name=method]', method);
    await page.click('#add-submit');
    n++;
    try { await page.waitForFunction((k) => document.querySelectorAll('#chart-rows tr').length === 6 && document.querySelector('#add-amount').value === '', n, { timeout: 5000 }); }
    catch (e) { console.log('add-msg:', await page.textContent('#add-msg'), '| amount:', await page.inputValue('#add-amount')); throw e; }
  }
  await add({ amount: '1200', category: 'Sueldo', back: 2, income: true });
  await add({ amount: '300', category: 'Casa', note: 'alquiler', back: 2, method: 'Transferencia' });
  await add({ amount: '1500', category: 'Sueldo', back: 1, income: true });
  await add({ amount: '420', category: 'Casa', note: 'alquiler y luz', back: 1 });
  await add({ amount: '80', category: 'Comida', note: 'Cena con Raúl #viaje #lisboa', back: 1, method: 'Tarjeta' });
  await add({ amount: '1500', category: 'Sueldo', back: 0, income: true });
  await add({ amount: '2,50', category: 'Comida', note: 'café #trabajo', back: 0 });
  await add({ amount: '45', category: 'Ocio', note: 'Museo #viaje', back: 0, method: 'Bizum' });

  // Gráfico
  assert.equal(await page.locator('#chart .hit').count(), 6);
  assert.equal(await page.locator('#chart path.s1').count(), 3);
  assert.equal(await page.locator('#chart path.s2').count(), 3);
  assert.equal(await page.locator('#chart-legend li').count(), 2);
  assert.match(await text('#chart-detail'), new RegExp(`${label(0)}: 47,50 € en gastos · 1.500,00 € en ingresos`));
  assert.match(await text('#chart svg'), /2.000 €/);
  step('gráfico de 6 meses con gastos e ingresos y leyenda');

  await page.locator(`#chart .hit[data-ym="${ym(1)}"]`).click();
  assert.equal(await page.textContent('#month-label'), label(1));
  assert.equal(await text('#month-total'), '500,00 €');
  assert.match(await text('#chart-detail'), /500,00 € en gastos · 1.500,00 € en ingresos/);
  step('tocar un mes del gráfico lleva a ese mes');

  await page.selectOption('#chart-category', 'Casa');
  assert.equal(await page.locator('#chart path.s2').count(), 0);
  assert.equal(await page.locator('#chart path.s1').count(), 2);
  assert.equal(await page.locator('#chart-legend li').count(), 1);
  assert.match(await text('#chart-detail'), /420,00 € en gastos$/);
  await page.click('.chart-table summary');
  assert.match(await text('#chart-rows'), /300,00 €/);
  await page.selectOption('#chart-category', '');
  step('gráfico por categoría y tabla de datos');

  // Búsqueda dentro del mes (sin acentos ni mayúsculas)
  await page.fill('#search', 'raul');
  assert.equal(await page.locator('.item').count(), 1);
  assert.match(await text('#filter-summary'), /1 movimiento · 80,00 € en gastos/);
  await page.fill('#search', 'nada que ver');
  assert.equal(await page.textContent('#list'), 'Ningún movimiento coincide con la búsqueda.');
  await page.click('#filters-clear');
  assert.equal(await page.locator('.item').count(), 3);
  assert.equal(await page.textContent('#filter-summary'), '');
  step('búsqueda en el mes y quitar filtros');

  // Etiqueta en todos los meses
  await page.click('#filters summary');
  assert.deepEqual(await page.locator('#f-tag option').allTextContents(), ['Todas las etiquetas', '#lisboa', '#trabajo', '#viaje']);
  await page.selectOption('#f-tag', '#viaje');
  assert.equal(await page.locator('.item').count(), 1);
  await page.check('#f-all');
  assert.equal(await page.locator('.item').count(), 2);
  assert.match(await text('#filter-summary'), /2 movimientos · 125,00 € en gastos/);
  assert.match(await text('.day'), /\d{4}/); // con año al buscar en todos los meses
  step('filtro por etiqueta en todos los meses');

  // Categoría + método, y los filtros sobreviven a un alta
  await page.selectOption('#f-tag', '');
  await page.selectOption('#f-category', 'Casa');
  assert.equal(await page.locator('.item').count(), 2);
  await page.selectOption('#f-method', 'Transferencia'); // el segundo alquiler heredó el último método usado
  assert.equal(await page.locator('.item').count(), 2);
  await page.selectOption('#f-method', 'Bizum');
  assert.equal(await page.locator('.item').count(), 0);
  await page.selectOption('#f-method', '');
  await add({ amount: '30', category: 'Casa', note: 'bombillas', back: 0 });
  assert.equal(await page.inputValue('#f-category'), 'Casa');
  assert.equal(await page.locator('.item').count(), 3);
  assert.match(await text('#filter-summary'), /3 movimientos · 750,00 € en gastos/);
  await page.fill('#search', '#');
  await page.fill('#search', '+1.500');
  assert.equal(await page.locator('.item').count(), 0);
  await page.click('#filters-clear');
  step('categoría, método y filtros que se mantienen al apuntar');

  // Editar desde un resultado de búsqueda
  await page.fill('#search', 'museo');
  await page.click('.item');
  await page.fill('#edit-form [name=note]', 'Museo #cultura');
  await page.click('#edit-form button[type=submit]');
  await page.waitForFunction(() => !document.querySelector('#edit-dialog').open);
  assert.ok((await page.locator('#f-tag option').allTextContents()).includes('#cultura'));
  await page.click('#filters-clear');
  step('editar desde la búsqueda actualiza las etiquetas');

  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  assert.deepEqual(errors, []);
  if (process.argv[2]) await page.locator('section.card:has(#chart)').screenshot({ path: process.argv[2] });
  if (process.argv[3]) { await page.emulateMedia({ colorScheme: 'dark' }); await page.screenshot({ path: process.argv[3], fullPage: true }); }
  await browser.close();
  server.close();
  console.log('TODO OK');
})().catch((e) => { console.error(e); process.exit(1); });
