// Grupos (viaje, proyecto...) dentro de Personal o Agencia. Uso: node tests/grupos.e2e.cjs [captura.png]
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
  assert.ok(await page.locator('#add-group').isHidden(), 'sin grupos no sale el selector');

  // Un gasto personal normal y uno de la agencia
  const add = async (amount, cat, scope) => {
    await page.fill('#add-amount', amount);
    await page.click(`.chip:has-text("${cat}")`);
    if (scope) await page.check(`#add-form [name=scope][value=${scope}]`, { force: true });
    await page.click('#add-submit');
    await page.waitForFunction((a) => document.querySelector('#add-msg').textContent.includes(a), amount);
  };
  await add('10', 'Comida');
  await add('100', 'Otros', 'business');
  step('movimientos base');

  // Crear grupo con el +
  await page.click('#group-new');
  await page.fill('#group-form [name=emoji]', '✈️');
  await page.fill('#group-form [name=name]', 'Viaje Roma');
  await page.click('#group-form button[type=submit]');
  await page.waitForSelector('#view .grp:has-text("Viaje Roma") input:checked', { state: 'attached' });
  assert.equal(await page.inputValue('#add-group'), await page.$eval('#view .grp input', (i) => i.value.slice(2)));
  assert.equal(await page.$eval('#add-form [name=scope]:checked', (i) => i.value), 'personal');
  step('grupo creado con el + y pestaña abierta');

  // Gasto dentro del grupo
  await add('50', 'Ocio');
  assert.equal(await text('#month-total'), '50,00 €');
  step('el grupo solo muestra lo suyo');

  // Cuenta también en Personal
  await page.click('#view label:has-text("Personal")');
  assert.equal(await text('#month-total'), '60,00 €');
  assert.ok((await page.textContent('#list')).includes('Viaje Roma'), 'la lista marca el grupo');
  await page.click('#view label:has-text("Agencia")');
  assert.equal(await text('#month-total'), '100,00 €');
  await page.click('#view label:has-text("Todo")');
  assert.equal(await text('#month-total'), '160,00 €');
  step('cuenta en Personal y en Todo');

  // Mover un gasto al grupo desde Editar
  await page.click('.item:has-text("Comida")');
  await page.selectOption('#edit-form [name=group]', { label: '✈️ Viaje Roma · Personal' });
  await page.click('#edit-form button[type=submit]');
  await page.click('#view .grp');
  assert.equal(await text('#month-total'), '60,00 €');
  step('mover un gasto al grupo al editar');

  // Grupo de agencia: el ámbito sigue al grupo
  await page.click('#group-new');
  await page.fill('#group-form [name=name]', 'Cliente X');
  await page.check('#group-form [name=scope][value=business]', { force: true });
  await page.click('#group-form button[type=submit]');
  await page.waitForSelector('#view .grp:has-text("Cliente X") input:checked', { state: 'attached' });
  assert.equal(await page.$eval('#add-form [name=scope]:checked', (i) => i.value), 'business');
  await add('20', 'Otros');
  await page.click('#view label:has-text("Agencia")');
  assert.equal(await text('#month-total'), '120,00 €');
  step('grupo dentro de Agencia');

  // Recargar: se mantienen grupos y vista
  await page.click('#view .grp:has-text("Viaje Roma")');
  await page.reload();
  await page.waitForSelector('#view .grp:has-text("Viaje Roma") input:checked', { state: 'attached' });
  assert.equal(await text('#month-total'), '60,00 €');
  step('se guarda al recargar');

  if (process.argv[2]) await page.screenshot({ path: process.argv[2], fullPage: false });

  // Quitar el grupo: los movimientos siguen en Personal
  await page.click('#btn-data'); await page.$$eval('details.fold', (ds) => ds.forEach((d) => { d.open = true; }));
  await page.click('#groups-list li:has-text("Viaje Roma") button');
  await page.click('#data-close');
  assert.equal(await page.$eval('#view input:checked', (i) => i.value), '');
  await page.click('#view label:has-text("Personal")');
  assert.equal(await text('#month-total'), '60,00 €');
  assert.equal(await page.locator('#view .grp').count(), 1);
  step('quitar grupo no borra movimientos');

  assert.deepEqual(errors, []);
  await browser.close();
  server.close();
  console.log('TODO OK');
})().catch((e) => { console.error(e); process.exit(1); });
