# Gastos

App personal de control de gastos. PWA sin dependencias ni paso de compilación: HTML, CSS y JavaScript.
Los datos se guardan en el dispositivo (IndexedDB) y se pueden exportar e importar en JSON y CSV.

## Probar en el ordenador

    npx serve .        # o: python3 -m http.server 8080

Abre la dirección que te indique. Para instalarla en el móvil hay que publicarla en una URL con HTTPS.

## Archivos

- `index.html`, `styles.css`: pantalla y estilos.
- `app.js`: interfaz (formularios, lista, exportar/importar).
- `lib.js`: lógica pura (importes, fechas, totales, CSV/JSON). Las categorías y métodos de pago están aquí arriba.
- `db.js`: guardado en IndexedDB.
- `sync.js`: sincronización opcional con un webhook de n8n (pull y push, gana el cambio más reciente).
- `sw.js`: funcionamiento sin conexión. Sube `CACHE` de versión si cambias la lista de archivos.
- `tests/`: pruebas (`node --test tests/lib.test.mjs`, `node tests/e2e.cjs`, `node tests/hito3.e2e.cjs`, `node tests/hito4.e2e.cjs`, `node tests/hito5.e2e.cjs` y `node tests/sync.e2e.cjs`; las cinco últimas necesitan Playwright).

## Sincronización entre dispositivos (opcional)

La app habla con el workflow de n8n «Gastos - Sincronización», que guarda los datos en la tabla `gastos_sync`.

1. En la app: Ajustes → «Generar clave nueva» y copia la clave.
2. En n8n: en el nodo «Sync Webhook» crea una credencial *Header Auth* con nombre `X-Gastos-Key` y esa clave como valor. Publica el workflow.
3. En la app de cada dispositivo: Ajustes → pega la URL de producción del webhook (`https://TU-N8N/webhook/gastos-sync`) y la clave → «Guardar y sincronizar».

Contrato del webhook (POST, JSON, cabecera `X-Gastos-Key`):

- `{ "action": "pull", "since": <cursor> }` → `{ "ok": true, "cursor": <número>, "rows": [...] }`
- `{ "action": "push", "rows": [{ "id", "data", "updatedAt", "deleted" }] }` → `{ "ok": true }`
