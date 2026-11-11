// Personal / agencia en un móvil simulado. Uso: node tests/hito4.e2e.cjs [captura.png]
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
  const eur = (s) => s.replace(/ /g, ' ');
  const text = async (sel) => eur(await page.textContent(sel));
  const step = (name) => console.log('ok -', name);
  const view = (name) => page.click(`#view label:has-text("${name}")`);
  async function add(amount, category, note, { income = false, scope } = {}) {
    if (income) await page.click('#add-form .seg label:has-text("Ingreso")');
    await page.fill('#add-amount', amount);
    await page.click(`.chip:has-text("${category}")`);
    if (scope) await page.click(`#add-form .seg.small label:has-text("${scope}")`);
    await page.fill('#add-form [name=note]', note);
    await page.click('#add-submit');
    await page.waitForFunction((n) => [...document.querySelectorAll('.item b')].some((b) => b.textContent === n) || document.querySelector('#add-amount').value === '', note);
    await page.waitForFunction(() => document.querySelector('#add-amount').value === '');
  }

  await page.goto(url);
  await add('40', 'Supermercado', 'compra');
  assert.ok(await page.isChecked('#add-form input[name=scope][value=personal]'));
  // Elegir la categoría Agencia marca el ámbito solo
  await page.fill('#add-amount', '29');
  await page.click('.chip:has-text("Agencia")');
  assert.ok(await page.isChecked('#add-form input[name=scope][value=business]'));
  await page.fill('#add-form [name=note]', 'VPS');
  await page.click('#add-submit');
  await page.waitForSelector('.item:has-text("VPS")');
  assert.ok(await page.isChecked('#add-form input[name=scope][value=personal]')); // vuelve a personal
  await add('15', 'Comida', 'comida con cliente', { scope: 'Agencia' });
  await add('900', 'Agencia', 'factura cliente', { income: true });
  step('apuntar personal y agencia');

  assert.equal(await text('#month-total'), '84,00 €');
  assert.match(await text('.item:has-text("VPS")'), /agencia/);
  assert.doesNotMatch(await text('.item:has-text("compra")'), /agencia/);

  await view('Agencia');
  assert.equal(await text('#month-total'), '44,00 €');
  assert.equal(await text('#month-income'), '900,00 €');
  assert.equal(await text('#month-balance'), '+856,00 €');
  assert.equal(await page.locator('.item').count(), 3);
  assert.match(await text('#chart-detail'), /44,00 € en gastos · 900,00 € en ingresos/);
  assert.ok(await page.isChecked('#add-form input[name=scope][value=business]')); // al ver la agencia se apunta en la agencia
  step('vista Agencia: resumen, gráfico y lista');

  await view('Personal');
  assert.equal(await text('#month-total'), '40,00 €');
  assert.equal(await text('#month-income'), '0,00 €');
  assert.equal(await page.locator('.item').count(), 1);
  step('vista Personal');

  // Mover un movimiento de ámbito desde la edición
  await page.click('.item:has-text("compra")');
  await page.selectOption('#edit-form [name=scope]', 'business');
  await page.click('#edit-form button[type=submit]');
  await page.waitForFunction(() => !document.querySelector('#edit-dialog').open);
  assert.equal(await text('#month-total'), '0,00 €');
  await view('Agencia');
  assert.equal(await text('#month-total'), '84,00 €');
  step('cambiar el ámbito al editar');

  // CSV de la vista y la vista se recuerda al recargar
  await page.reload();
  assert.ok(await page.isChecked('#view input[value=business]'));
  assert.equal(await text('#month-total'), '84,00 €');
  await page.click('#btn-data');
  assert.equal(await page.textContent('#export-csv'), 'Exportar CSV (solo agencia)');
  const [d] = await Promise.all([page.waitForEvent('download'), page.click('#export-csv')]);
  assert.match(d.suggestedFilename(), /^gastos-agencia-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = fs.readFileSync(await d.path(), 'utf8');
  assert.equal(csv.trim().split('\r\n').length, 5);
  assert.ok(csv.trim().split('\r\n').slice(1).every((l) => l.includes(';agencia;')));
  const [dj] = await Promise.all([page.waitForEvent('download'), page.click('#export-json')]);
  assert.equal(JSON.parse(fs.readFileSync(await dj.path(), 'utf8')).expenses.length, 4); // la copia completa no se filtra
  await page.click('#data-close');
  step('CSV solo de la agencia, copia JSON completa y vista recordada');

  await view('Todo');
  assert.equal(await text('#month-total'), '84,00 €');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  assert.deepEqual(errors, []);
  if (process.argv[2]) await page.screenshot({ path: process.argv[2] });
  await browser.close();
  server.close();
  console.log('TODO OK');
})().catch((e) => { console.error(e); process.exit(1); });
