// Hito 6: actualización casi en tiempo real, botón ↻, ajustes plegables, nota, CSP y bloqueo con PIN. Uso: node tests/hito6.e2e.cjs
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
  const step = (name) => console.log('ok -', name);
  async function device(name) {
    const ctx = await browser.newContext({ ...devices['iPhone 13'], locale: 'es-ES' });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${name}: ${e}`));
    page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) errors.push(`${name} CSP: ${m.text()}`); });
    page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? '1234' : undefined));
    await page.goto(url);
    return page;
  }
  const A = await device('A');

  // Nota y ajustes plegados
  assert.equal(await A.getAttribute('#add-form [name=note]', 'placeholder'), 'Nota');
  await A.click('#btn-data');
  const folds = A.locator('#data-dialog details.fold');
  assert.equal(await folds.count(), 2);
  assert.equal(await folds.nth(0).locator('summary').textContent(), 'Presupuesto mensual por categoría');
  assert.equal(await A.locator('#budgets').isVisible(), false);
  await folds.nth(0).locator('summary').click();
  assert.equal(await A.locator('#budgets').isVisible(), true);
  step('nota simple y presupuesto/categorías plegables');

  // Sincronización entre A y B sin tocar nada en B
  await A.fill('#sync-url', hook);
  await A.fill('#sync-key', KEY);
  await A.click('#sync-save');
  await A.waitForFunction(() => /^Sincronizado/.test(document.querySelector('#sync-msg').textContent));
  await A.click('#data-close');
  const B = await device('B');
  await B.click('#btn-data');
  await B.fill('#sync-url', hook);
  await B.fill('#sync-key', KEY);
  await B.click('#sync-save');
  await B.waitForFunction(() => /^Sincronizado/.test(document.querySelector('#sync-msg').textContent));
  await B.click('#data-close');
  await A.fill('#add-amount', '7');
  await A.click('.chip:has-text("Comida")');
  await A.fill('#add-form [name=note]', 'llega-solo');
  await A.click('#add-submit');
  await A.waitForFunction(() => /^Sincronizado/.test(document.querySelector('#sync-status').textContent) && document.querySelector('.item'));
  await new Promise((r) => setTimeout(r, 2500)); // espera al envío (1,5 s de margen en la app)
  const t0 = Date.now();
  await B.waitForSelector('.item:has-text("llega-solo")', { timeout: 40000 });
  step(`B recibe el gasto sin tocar nada (${Math.round((Date.now() - t0) / 1000)} s)`);

  // Botón ↻: trae al momento
  await B.fill('#add-amount', '3');
  await B.click('.chip:has-text("Comida")');
  await B.fill('#add-form [name=note]', 'con-boton');
  await B.click('#add-submit');
  await new Promise((r) => setTimeout(r, 2500));
  await A.click('#btn-refresh');
  await A.waitForSelector('.item:has-text("con-boton")', { timeout: 5000 });
  step('botón ↻ trae los cambios al momento');

  // PIN
  await A.click('#btn-data');
  await A.fill('#pin-form [name=pin]', '1234');
  await A.fill('#pin-form [name=pin2]', '1243');
  await A.click('#pin-save');
  assert.match(await A.textContent('#pin-msg'), /no coinciden/);
  await A.fill('#pin-form [name=pin]', '1234');
  await A.fill('#pin-form [name=pin2]', '1234');
  await A.click('#pin-save');
  await A.waitForFunction(() => /activado/.test(document.querySelector('#pin-msg').textContent));
  const saved = await A.evaluate(() => localStorage.getItem('gastos.lock'));
  assert.ok(!saved.includes('1234'));
  await A.reload();
  assert.equal(await A.locator('#lock').isVisible(), true);
  assert.equal(await A.locator('#add-form').isVisible(), false);
  await A.fill('#lock-form [name=pin]', '0000');
  await A.click('#lock-form button');
  await A.waitForFunction(() => /incorrecto/.test(document.querySelector('#lock-msg').textContent));
  await A.fill('#lock-form [name=pin]', '1234');
  await A.click('#lock-form button');
  await A.waitForSelector('#lock', { state: 'hidden' });
  assert.equal(await A.locator('#add-form').isVisible(), true);
  step('PIN: se guarda como hash, bloquea al abrir, rechaza el incorrecto y abre con el bueno');

  await A.reload();
  for (let i = 0; i < 5; i++) {
    await A.fill('#lock-form [name=pin]', '9999');
    await A.click('#lock-form button');
    await A.waitForFunction((n) => document.querySelector('#lock-msg').textContent !== '' , i);
    await A.evaluate(() => { document.querySelector('#lock-msg').textContent = ''; });
  }
  await A.fill('#lock-form [name=pin]', '1234');
  await A.click('#lock-form button');
  await A.waitForFunction(() => /Demasiados intentos/.test(document.querySelector('#lock-msg').textContent));
  assert.equal(await A.locator('#lock').isVisible(), true);
  step('5 fallos: espera obligatoria aunque luego pongas el bueno');

  // Quitar PIN (el prompt responde 1234) tras pasar la espera
  await A.evaluate(() => localStorage.removeItem('gastos.lock.fails'));
  await A.fill('#lock-form [name=pin]', '1234');
  await A.click('#lock-form button');
  await A.waitForSelector('#lock', { state: 'hidden' });
  await A.click('#btn-data');
  await A.click('#pin-remove');
  await A.waitForFunction(() => /quitado/.test(document.querySelector('#pin-msg').textContent));
  await A.reload();
  assert.equal(await A.locator('#lock').isVisible(), false);
  step('quitar PIN');

  assert.deepEqual(errors, []);
  step('sin errores ni bloqueos de la política de seguridad (CSP)');
  console.log('TODO OK');
  await browser.close(); app.close(); api.close();
})().catch((e) => { console.error(e); process.exit(1); });
