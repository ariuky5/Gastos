// Botones rápidos, categorías editables y modo privado. Uso: node tests/hito5.e2e.cjs [captura.png]
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
  page.on('dialog', (d) => d.accept());
  const eur = (s) => s.replace(/ /g, ' ');
  const text = async (sel) => eur(await page.textContent(sel));
  const step = (name) => console.log('ok -', name);

  await page.goto(url);
  assert.equal(await page.locator('.fav').count(), 0);
  assert.ok(await page.locator('.logo').isVisible());

  // Crear un botón rápido al apuntar
  await page.fill('#add-amount', '1,50');
  await page.click('.chip:has-text("Comida")');
  await page.fill('#add-form [name=note]', 'café');
  await page.selectOption('#add-form [name=method]', 'Efectivo');
  await page.check('#add-form [name=favorite]');
  await page.click('#add-submit');
  await page.waitForSelector('.fav');
  assert.match(await text('.fav'), /café 1,50 €/);
  assert.equal(await page.locator('.item').count(), 1);
  step('guardar como botón rápido');

  // Un toque apunta el gasto de hoy con todos sus datos
  await page.click('.fav');
  await page.waitForFunction(() => document.querySelectorAll('.item').length === 2);
  assert.equal(await text('#month-total'), '3,00 €');
  assert.match(await text('.item'), /café.*Comida · Efectivo/);
  assert.match(await text('#add-msg'), /Guardado: 1,50 € en Comida/);
  await page.reload();
  assert.equal(await page.locator('.fav').count(), 1);
  step('un toque apunta el gasto y el botón sobrevive a recargar');

  // Categoría nueva
  await page.click('#btn-data'); await page.$$eval('details.fold', (ds) => ds.forEach((d) => { d.open = true; }));
  await page.fill('#category-add [name=emoji]', '🐶');
  await page.fill('#category-add [name=name]', 'Mascota');
  await page.click('#category-add button');
  await page.waitForSelector('#categories input[value="Mascota"]');
  await page.fill('#category-add [name=name]', 'mascota');
  await page.click('#category-add button');
  assert.match(await page.textContent('#data-msg'), /Ya existe/);
  assert.equal(await page.locator('#budgets input[data-category="Mascota"]').count(), 1);
  step('añadir categoría (y no duplicarla)');

  // Renombrar: movimientos, botón rápido y presupuesto pasan al nombre nuevo
  await page.fill('#budgets input[data-category="Comida"]', '100');
  await page.locator('#budgets input[data-category="Comida"]').blur();
  await page.waitForFunction(() => /Presupuesto de Comida/.test(document.querySelector('#data-msg').textContent));
  const nameInput = page.locator('#categories input[value="Comida"]');
  await nameInput.fill('Restaurantes');
  await nameInput.blur();
  await page.waitForFunction(() => /ahora es «Restaurantes» \(2 movimientos/.test(document.querySelector('#data-msg').textContent));
  assert.equal(await page.inputValue('#budgets input[data-category="Restaurantes"]'), '100,00');
  assert.equal(await page.locator('#budgets input[data-category="Comida"]').count(), 0);
  // Cambiar el emoji
  const emojiInput = page.locator('.cat-row:has(input[value="Restaurantes"]) input[data-field="emoji"]');
  await emojiInput.fill('🍕');
  await emojiInput.blur();
  await page.waitForFunction(() => document.querySelector('.fav').textContent.includes('🍕'));
  await page.click('#data-close');
  assert.match(await text('.item'), /café.*Restaurantes · Efectivo/);
  assert.match(await text('#by-cat'), /🍕 Restaurantes.*3,00 € de 100,00 €/);
  assert.equal(await page.locator('.chip:has-text("Restaurantes")').count(), 1);
  assert.equal(await page.locator('.chip:has-text("Comida")').count(), 0);
  assert.ok((await page.locator('#chart-category option').allTextContents()).includes('Mascota'));
  step('renombrar categoría y cambiar emoji');

  // Quitar categoría: los movimientos se quedan
  await page.click('#btn-data'); await page.$$eval('details.fold', (ds) => ds.forEach((d) => { d.open = true; }));
  await page.click('.cat-row:has(input[value="Restaurantes"]) button');
  await page.waitForFunction(() => !document.querySelector('#categories input[value="Restaurantes"]'));
  await page.click('#data-close');
  assert.equal(await page.locator('.item').count(), 2);
  assert.equal(await text('#month-total'), '3,00 €');
  step('quitar categoría conserva los movimientos');

  // Copia JSON con botones y categorías, restaurada en un navegador limpio
  await page.click('#btn-data'); await page.$$eval('details.fold', (ds) => ds.forEach((d) => { d.open = true; }));
  const [d] = await Promise.all([page.waitForEvent('download'), page.click('#export-json')]);
  const backup = fs.readFileSync(await d.path());
  const parsed = JSON.parse(backup);
  assert.equal(parsed.favorites.length, 1);
  assert.ok(parsed.categories.some((c) => c.name === 'Mascota'));
  await page.click('#data-close');
  const ctx2 = await browser.newContext({ ...devices['iPhone 13'], locale: 'es-ES' });
  const p2 = await ctx2.newPage();
  await p2.goto(url);
  await p2.click('#btn-data'); await p2.$$eval('details.fold', (ds) => ds.forEach((d) => { d.open = true; }));
  await p2.setInputFiles('#import-file', { name: 'gastos.json', mimeType: 'application/json', buffer: backup });
  await p2.waitForFunction(() => /Importados 2 nuevos/.test(document.querySelector('#data-msg').textContent));
  await p2.click('#data-close');
  assert.equal(await p2.locator('.fav').count(), 1);
  assert.equal(await p2.locator('.chip:has-text("Mascota")').count(), 1);
  step('la copia JSON incluye botones rápidos y categorías');

  // Modo privado
  const blurred = (sel) => page.evaluate((s) => getComputedStyle(document.querySelector(s)).filter, sel);
  assert.equal(await blurred('#month-total'), 'none');
  await page.click('#btn-private');
  assert.match(await blurred('#month-total'), /blur/);
  assert.match(await blurred('.item .amt'), /blur/);
  assert.match(await blurred('.fav b'), /blur/);
  assert.equal(await blurred('.item .what'), 'none');
  assert.equal(await page.getAttribute('#btn-private', 'aria-pressed'), 'true');
  await page.reload();
  assert.match(await blurred('#month-total'), /blur/);
  if (process.argv[2]) await page.screenshot({ path: process.argv[2] });
  await page.click('#btn-private');
  assert.equal(await blurred('#month-total'), 'none');
  step('modo privado difumina importes y se recuerda');

  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  assert.deepEqual(errors, []);
  await browser.close();
  server.close();
  console.log('TODO OK');
})().catch((e) => { console.error(e); process.exit(1); });
