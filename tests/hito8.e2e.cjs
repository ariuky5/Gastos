// Hito 8: borrar varios movimientos a la vez, fiado y deudas, gastos automáticos (atajos / Apple Pay) y reglas de comercio.
// Fecha fija: domingo 15 de noviembre de 2026 (hora de Madrid). Uso: node tests/hito8.e2e.cjs [captura.png]
const { chromium, devices } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const KEY = 'clave-de-prueba-0123456789';
const NOW = new Date('2026-11-15T12:00:00+01:00');
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
  const items = async (p = page) => (await p.locator('#list .item').allTextContents()).map(eur);
  async function add(amount, category, { note = '', person = '', income = false, date = '2026-11-15' } = {}, p = page) {
    await p.click(`#add-form .seg label:has-text("${income ? 'Ingreso' : 'Gasto'}")`);
    await p.fill('#add-amount', amount);
    await p.click(`#add-cats .chip:has-text("${category}")`);
    if (person) await p.fill('#add-person', person);
    await p.fill('#add-form [name=date]', date);
    await p.fill('#add-form [name=note]', note);
    await p.evaluate(() => { document.querySelector('#add-msg').textContent = ''; });
    await p.click('#add-submit');
    await p.waitForFunction(() => document.querySelector('#add-msg').textContent.length > 0);
  }
  const pushed = async (test) => { for (let i = 0; i < 100 && !test(); i++) await new Promise((res) => setTimeout(res, 100)); assert.ok(test(), 'el cambio no ha llegado al servidor'); };

  // ---------- 1. Seleccionar varios movimientos y borrarlos ----------
  await add('10', 'Comida', { note: 'uno' });
  await add('20', 'Ocio', { note: 'dos' });
  await add('30', 'Casa', { note: 'tres' });
  await add('40', 'Ropa', { note: 'cuatro', date: '2026-11-14' });
  assert.equal((await items()).length, 4);
  assert.equal(await page.isVisible('#select-bar'), false);
  await page.click('#select-toggle');
  assert.equal(await text('#select-toggle'), 'Cancelar');
  assert.equal(await page.isDisabled('#select-delete'), true);
  await page.click('#list .item:has-text("dos")');
  assert.equal(await page.isVisible('#edit-dialog'), false); // en modo selección no se abre el editor
  await page.click('#list .item:has-text("cuatro")');
  assert.match(await text('#select-count'), /^2 seleccionados · 60,00 €$/);
  assert.equal(await page.getAttribute('#list .item:has-text("dos")', 'aria-checked'), 'true');
  await page.click('#list .item:has-text("cuatro")'); // desmarcar
  assert.match(await text('#select-count'), /^1 seleccionado · 20,00 €$/);
  await page.click('#select-all');
  assert.match(await text('#select-count'), /^4 seleccionados · 100,00 €$/);
  assert.equal(await text('#select-all'), 'Ninguno');
  await page.click('#select-all');
  assert.equal(await page.isDisabled('#select-delete'), true);
  await page.click('#list .item:has-text("dos")');
  await page.click('#list .item:has-text("tres")');
  // Filtrar deja marcado solo lo que se ve
  await page.fill('#search', 'tres');
  assert.match(await text('#select-count'), /^1 seleccionado · 30,00 €$/);
  await page.fill('#search', '');
  await page.click('#list .item:has-text("dos")');
  assert.equal(await text('#select-delete'), 'Borrar (2)');
  await page.click('#select-delete'); // el confirm se acepta solo
  await page.waitForFunction(() => document.querySelectorAll('#list .item').length === 2);
  assert.match(await text('#list-msg'), /Borrados 2 movimientos/);
  assert.equal(await page.isVisible('#select-bar'), false);
  assert.match(await text('#month-total'), /^50,00 €$/);
  await page.click('#select-toggle');
  await page.click('#select-toggle'); // cancelar no borra nada
  assert.equal((await items()).length, 2);
  step('seleccionar, marcar todos, filtrar y borrar varios movimientos');

  // El borrado múltiple llega a otro dispositivo
  await page.click('#btn-data');
  await page.fill('#sync-url', hook);
  await page.fill('#sync-key', KEY);
  await page.click('#sync-save');
  await page.waitForFunction(() => /Sincronizado/.test(document.querySelector('#sync-msg').textContent));
  await page.click('#data-close');
  assert.equal([...table.values()].filter((r) => r.deleted).length, 2);
  const B = await device('B');
  await B.page.click('#btn-data');
  await B.page.fill('#sync-url', hook);
  await B.page.fill('#sync-key', KEY);
  await B.page.click('#sync-save');
  await B.page.waitForFunction(() => document.querySelectorAll('#list .item').length === 2);
  await B.page.click('#data-close');
  await B.page.click('#select-toggle');
  await B.page.click('#select-all');
  await B.page.click('#select-delete');
  await B.page.waitForFunction(() => document.querySelectorAll('#list .item').length === 0);
  await pushed(() => [...table.values()].filter((r) => r.deleted).length === 4);
  await page.click('#btn-refresh');
  await page.waitForFunction(() => document.querySelectorAll('#list .item').length === 0);
  step('el borrado múltiple se sincroniza entre dispositivos');

  // ---------- 2. Fiado y deudas ----------
  assert.match(await text('#debts'), /Nada pendiente/);
  assert.equal(await page.isVisible('#add-person'), false);
  await page.click('#add-cats .chip:has-text("Fiado")');
  assert.equal(await page.isVisible('#add-person'), true);
  assert.equal(await page.getAttribute('#add-person', 'placeholder'), '¿A quién se lo prestas?');
  await page.fill('#add-amount', '50');
  await page.click('#add-submit');
  assert.match(await text('#add-msg'), /nombre de la persona/);
  assert.equal((await items()).length, 0);
  await add('50', 'Fiado', { person: 'Juan' });
  assert.match(await text('#add-msg'), /Guardado: 50,00 € en Fiado \(Juan\)/);
  assert.equal(await page.isVisible('#add-person'), false); // vuelve a la categoría habitual
  await add('100', 'Deudas', { person: 'María', income: true });
  await add('20', 'Fiado', { person: 'juan', income: true, note: 'bizum' });
  assert.match(await text('#debts-total'), /^Te deben 30,00 € · Debes 100,00 €$/);
  assert.deepEqual((await page.locator('#debts li').allTextContents()).map(eur), ['Le debes a María100,00 €Saldar', 'Juan te debe30,00 €Saldar']);
  assert.ok((await items()).some((x) => /Fiado · Juan/.test(x)));
  assert.equal(await page.locator('#people option').count(), 2);
  // Editar: la persona se puede cambiar y solo sale en estas categorías
  await page.click('#list .item:has-text("Fiado · Juan"):not(:has-text("bizum"))');
  assert.equal(await page.inputValue('#edit-form [name=person]'), 'Juan');
  await page.selectOption('#edit-form [name=category]', 'Comida');
  assert.equal(await page.isVisible('#edit-person'), false);
  await page.selectOption('#edit-form [name=category]', 'Fiado');
  await page.fill('#edit-form [name=amount]', '60');
  await page.click('#edit-form button[type=submit]');
  await page.waitForFunction(() => !document.querySelector('#edit-dialog').open);
  assert.match(await text('#debts-total'), /^Te deben 40,00 € · Debes 100,00 €$/);
  // Saldar apunta el movimiento contrario
  await page.click('#debts li:has-text("Juan") button');
  await page.waitForFunction(() => /Saldado/.test(document.querySelector('#list-msg').textContent));
  assert.match(await text('#list-msg'), /Saldado: Juan ya no te debe nada/);
  assert.deepEqual((await page.locator('#debts li').allTextContents()).map(eur), ['Le debes a María100,00 €Saldar']);
  assert.ok((await items()).some((x) => /Devolución.*\+40,00 €/.test(x)));
  await page.click('#debts li:has-text("María") button');
  await page.waitForFunction(() => /Nada pendiente/.test(document.querySelector('#debts').textContent));
  assert.match(await text('#debts'), /Nada pendiente/);
  assert.ok((await items()).some((x) => /Pago de deuda.*100,00 €/.test(x)));
  // Fiado y Deudas no se pueden quitar, pero sí renombrar
  await openSettings(page);
  await page.click('#categories .cat-row:has(input[value="Fiado"]) button >> nth=0');
  assert.match(await text('#data-msg'), /no quitarla/);
  await page.click('#data-close');
  // La persona viaja en la sincronización
  await pushed(() => [...table.values()].some((r) => /"person":"María"/.test(r.data)));
  step('fiado y deudas: persona, saldo por persona, saldar y categorías fijas');

  // ---------- 3. Gastos automáticos y reglas de comercio ----------
  // a) Por dirección web (un atajo que abre la app)
  await page.goto(url + '?importe=12%2C50&comercio=MERCADONA%20VALENCIA');
  await page.waitForFunction(() => /Apuntado/.test(document.querySelector('#add-msg').textContent));
  assert.match(await text('#add-msg'), /Apuntado: 12,50 € en Supermercado \(MERCADONA VALENCIA\)\.$/);
  assert.equal(new URL(page.url()).search, '');
  await page.reload();
  assert.equal((await items()).filter((x) => /MERCADONA/.test(x)).length, 1); // recargar no lo duplica
  assert.ok((await items()).some((x) => /MERCADONA VALENCIASupermercado · Tarjeta · automático12,50 €/.test(x)), (await items()).join('\n'));

  // b) Desde n8n: lo que escribiría el atajo de Apple Pay (importe como texto, sin categoría)
  const quick = (id, amount, merchant) => table.set(id, { recordId: id, clientUpdatedAt: new Date().toISOString(), deleted: false, syncedAt: Date.now(),
    data: JSON.stringify({ amount, date: '2026-11-15', note: merchant, merchant, method: 'Tarjeta', auto: 'pending' }) });
  quick('q-1', '8,40 €', 'Bar Manolo');
  quick('q-2', '31,00 €', 'TIENDA RARA SL');
  quick('q-3', '9,99 €', 'TIENDA RARA SL');
  await page.click('#btn-refresh');
  await page.waitForFunction(() => document.querySelectorAll('#list .item .flag').length === 2);
  let list = await items();
  assert.ok(list.some((x) => /Bar ManoloComida · Tarjeta · automático8,40 €/.test(x)), list.join('\n'));
  assert.ok(list.some((x) => /TIENDA RARA SL⚠️ revisar categoría · Otros · Tarjeta31,00 €/.test(x)), list.join('\n'));
  // La categoría decidida vuelve al servidor (la ve el resumen semanal y el otro dispositivo)
  await pushed(() => /"auto":"review"/.test(table.get('q-2').data) && /"category":"Comida"/.test(table.get('q-1').data));

  // c) Corregir la categoría enseña la regla y arregla los iguales
  await page.click('#list .item:has-text("31,00")');
  assert.match(await text('#edit-msg'), /Apuntado solo desde «TIENDA RARA SL»/);
  await page.selectOption('#edit-form [name=category]', 'Ropa');
  await page.click('#edit-form button[type=submit]');
  await page.waitForFunction(() => !document.querySelector('#edit-dialog').open);
  assert.match(await text('#list-msg'), /Aprendido: «TIENDA RARA SL» irá a Ropa\. Otro movimiento igual también se ha cambiado\./);
  list = await items();
  assert.equal(list.filter((x) => /TIENDA RARA SLRopa/.test(x)).length, 2, list.join('\n'));
  assert.equal(await page.locator('#list .item .flag').count(), 0);
  quick('q-4', '15', 'Tienda Rara SL Madrid');
  await page.click('#btn-refresh');
  await page.waitForFunction(() => /Tienda Rara SL MadridRopa/.test(document.querySelector('#list').textContent));

  // d) Reglas en Ajustes: ver, cambiar, añadir y quitar
  await openSettings(page);
  assert.deepEqual(await page.locator('#rules .rule-text').allTextContents(), ['tienda rara sl']);
  await page.fill('#rule-add [name=match]', 'Manolo');
  await page.selectOption('#rule-add [name=category]', 'Ocio');
  await page.click('#rule-add button');
  await page.waitForFunction(() => /Regla guardada/.test(document.querySelector('#data-msg').textContent));
  assert.match(await text('#data-msg'), /Regla guardada: «manolo» irá a Ocio/);
  await page.selectOption('#rules select[data-match="tienda rara sl"]', 'Casa');
  await page.waitForFunction(() => /irá a Casa/.test(document.querySelector('#data-msg').textContent));
  await page.click('#rules li:has-text("manolo") button');
  await page.waitForFunction(() => document.querySelectorAll('#rules .rule-text').length === 1);
  assert.deepEqual(await page.locator('#rules .rule-text').allTextContents(), ['tienda rara sl']);
  await page.click('#data-close');
  await pushed(() => /"category":"Casa"/.test((table.get('meta:rules') || { data: '' }).data));
  // La regla llega al otro dispositivo
  await B.page.click('#btn-refresh');
  await B.page.waitForFunction(() => /Tienda Rara SL MadridRopa/.test(document.querySelector('#list').textContent));
  await openSettings(B.page);
  assert.deepEqual(await B.page.locator('#rules .rule-text').allTextContents(), ['tienda rara sl']);
  await B.page.click('#data-close');
  // Lo corregido a mano no vuelve atrás al sincronizar, aunque el reloj del servidor vaya adelantado
  await page.click('#btn-refresh');
  await page.waitForFunction(() => /Sincronizado/.test(document.querySelector('#sync-status').textContent));
  list = await items();
  assert.equal(await page.locator('#list .item .flag').count(), 0, list.join('\n'));
  assert.ok(list.some((x) => /TIENDA RARA SLRopa · Tarjeta31,00 €/.test(x)), list.join('\n'));
  // Borrar uno automático tampoco lo resucita
  await page.click('#select-toggle');
  await page.click('#list .item:has-text("9,99")');
  await page.click('#select-delete');
  await page.waitForFunction(() => !/9,99/.test(document.querySelector('#list').textContent));
  await pushed(() => table.get('q-3').deleted === true);
  await page.click('#btn-refresh');
  await page.waitForFunction(() => /Sincronizado/.test(document.querySelector('#sync-status').textContent));
  assert.ok(!/9,99/.test(await text('#list')));
  step('gastos automáticos por dirección web y por n8n, reglas que se aprenden y se sincronizan');

  // ---------- Copia y diseño ----------
  const [dl] = await Promise.all([page.waitForEvent('download'), (async () => { await page.click('#btn-data'); await page.click('#export-json'); })()]);
  const backup = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
  assert.deepEqual(backup.rules, [{ match: 'tienda rara sl', category: 'Casa' }]);
  assert.ok(backup.expenses.some((e) => e.person === 'María'));
  await page.click('#data-close');
  if (process.argv[2]) { await page.click('#select-toggle'); await page.click('#list .item >> nth=0'); await page.screenshot({ path: process.argv[2], fullPage: true }); await page.click('#select-toggle'); }
  const D = await device('D', { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } });
  assert.ok(await D.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  step('copia JSON con reglas y personas; sin scroll horizontal');

  assert.deepEqual(errors, []);
  await browser.close();
  server.close();
  api.close();
  console.log('TODO OK');
})().catch((e) => { console.error(e); process.exit(1); });
