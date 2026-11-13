// Sincronización oculta por defecto (para compartir la app). Uso: node tests/sync-oculta.e2e.cjs
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

// Webhook de pega que imita n8n y cuenta las llamadas.
let calls = 0;
const api = http.createServer((req, res) => {
  const cors = { 'access-control-allow-origin': req.headers.origin || '*', 'access-control-allow-headers': req.headers['access-control-request-headers'] || '', 'access-control-allow-methods': 'POST, OPTIONS' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    calls++;
    res.writeHead(req.headers['x-gastos-key'] === KEY ? 200 : 403, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, cursor: Date.now(), rows: [] }));
  });
});

(async () => {
  await new Promise((r) => app.listen(0, r));
  await new Promise((r) => api.listen(0, r));
  const url = `http://localhost:${app.address().port}/`;
  const hook = `http://127.0.0.1:${api.address().port}/webhook/gastos-sync`;
  const browser = await chromium.launch();
  const errors = [];
  const step = (name) => console.log('ok -', name);
  const visible = (page) => page.locator('#sync-section').isVisible();
  const tapVersion = async (page, n = 5) => { for (let i = 0; i < n; i++) await page.click('#app-version'); };

  // 1) Amigo/familiar: dispositivo nuevo, sin nada configurado.
  const ctx = await browser.newContext({ ...devices['iPhone 13'], locale: 'es-ES' });
  const page = await ctx.newPage();
  const external = [];
  page.on('request', (r) => { if (!r.url().startsWith(url)) external.push(r.url()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url);
  await page.fill('#add-amount', '3');
  await page.click('.chip:has-text("Comida")');
  await page.fill('#add-form [name=note]', 'café');
  await page.click('#add-submit');
  await page.waitForSelector('.item:has-text("café")');
  await page.click('#btn-data');
  assert.equal(await visible(page), false);
  assert.equal(await page.locator('#export-json').isVisible(), true);
  assert.equal(await page.locator('#export-csv').isVisible(), true);
  assert.doesNotMatch(await page.locator('#data-dialog').innerText(), /n8n|webhook|Sincroniz/i);
  step('sin configurar: Ajustes no muestra la sincronización y sí la exportación');

  await tapVersion(page, 4);
  assert.equal(await visible(page), false);
  step('4 toques no la desbloquean');

  await page.click('#data-close');
  await page.click('#btn-refresh'); // sin sync, ↻ solo recarga la página
  await page.waitForLoadState('load');
  await page.waitForTimeout(1500);
  assert.deepEqual(external, []);
  assert.equal(calls, 0);
  step('sin configurar no hay ninguna petición fuera de la app');

  // 2) Desbloqueo discreto: 5 toques seguidos, se recuerda al recargar.
  await page.click('#btn-data');
  await tapVersion(page);
  assert.equal(await visible(page), true);
  assert.match(await page.textContent('#data-msg'), /visible/);
  await page.click('#data-close');
  await page.reload();
  await page.click('#btn-data');
  assert.equal(await visible(page), true);
  assert.equal(calls, 0);
  step('5 toques en la versión la muestran y se recuerda en este dispositivo');

  // Otros 5 toques sin configurar la vuelven a ocultar.
  await tapVersion(page);
  assert.equal(await visible(page), false);
  await tapVersion(page);
  assert.equal(await visible(page), true);
  step('sin configurar, otros 5 toques la ocultan de nuevo');

  // 3) Configurada: sincroniza y no se puede ocultar por error.
  await page.fill('#sync-url', hook);
  await page.fill('#sync-key', KEY);
  await page.click('#sync-save');
  await page.waitForFunction(() => /^Sincronizado/.test(document.querySelector('#sync-msg').textContent));
  assert.ok(calls > 0);
  await tapVersion(page);
  assert.equal(await visible(page), true);
  step('con sync configurada sigue visible aunque se toque la versión');
  await ctx.close();

  // 4) Dispositivo de Arian de antes del cambio: URL y clave guardadas, sin la marca de desbloqueo.
  const old = await browser.newContext({ ...devices['iPhone 13'], locale: 'es-ES' });
  await old.addInitScript(([u, k]) => {
    if (!localStorage.getItem('gastos.sync.url')) { localStorage.setItem('gastos.sync.url', u); localStorage.setItem('gastos.sync.key', k); }
  }, [hook, KEY]);
  const p2 = await old.newPage();
  p2.on('pageerror', (e) => errors.push(String(e)));
  const before = calls;
  await p2.goto(url);
  await p2.waitForFunction(() => /^Sincronizado/.test(document.querySelector('#sync-status').textContent));
  assert.ok(calls > before);
  await p2.click('#btn-data');
  assert.equal(await visible(p2), true);
  assert.equal(await p2.inputValue('#sync-url'), hook);
  assert.equal(await p2.evaluate(() => localStorage.getItem('gastos.sync.unlocked')), null);
  step('dispositivo ya configurado: ve la sincronización y sigue sincronizando');
  await old.close();

  assert.deepEqual(errors, []);
  await browser.close();
  app.close(); api.close();
  console.log('Todo bien.');
})().catch((e) => { console.error(e); process.exit(1); });
