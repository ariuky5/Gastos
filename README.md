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
- `lock.js`: bloqueo con PIN (solo guarda un hash PBKDF2 con sal).
- `tests/`: pruebas (`node --test tests/lib.test.mjs` y, con Playwright, `node tests/e2e.cjs`, `hito3`, `hito4`, `hito5`, `hito6`, `hito7`, `grupos`, `sync` y `sync-oculta` `.e2e.cjs`).

## Recurrentes, objetivos y comparativa

- **Recurrentes** (Ajustes → Recurrentes): se crean marcando «Repetir cada mes» al apuntar o con «+ Añadir recurrente». Se pueden editar (importe, día, nota, cada 1, 3, 6 o 12 meses...) y los cambios valen desde el próximo cargo. Cada cargo generado tiene el id `<recurrente>-<AAAA-MM>` y fecha de cambio fija, así que dos dispositivos sincronizados generan lo mismo y no se duplica.
- **Avisos de presupuesto**: al 80 % (🟡) y al 100 % (🔴) en la tarjeta del mes y al apuntar; también salen en el resumen semanal por email.
- **Objetivos de ahorro**: nombre, meta, lo ahorrado y fecha límite opcional (calcula cuánto apartar al mes). Se sincronizan como `meta:goals` y van en la copia JSON. No son movimientos, así que no salen en el CSV.
- **Comparativa**: gasto por categoría del mes que estás viendo frente al anterior. En el mes en curso compara por defecto los mismos días (del 1 a hoy en los dos meses); se puede cambiar a mes completo.

## Sincronización entre dispositivos (opcional)

La app habla con el workflow de n8n «Gastos - Sincronización», que guarda los datos en la tabla `gastos_sync`.

El apartado va **oculto** en Ajustes para quien use la app sin n8n. Se ve solo si el dispositivo ya tiene URL y clave guardadas, o tras tocar 5 veces seguidas el texto «Gastos · versión» al final de Ajustes (se recuerda en ese dispositivo; otros 5 toques lo vuelven a ocultar mientras no esté configurado). Sin URL y clave no se hace ninguna petición a n8n.

1. En la app: Ajustes → «Generar clave nueva» y copia la clave.
2. En n8n: en el nodo «Sync Webhook» crea una credencial *Header Auth* con nombre `X-Gastos-Key` y esa clave como valor. Publica el workflow.
3. En la app de cada dispositivo: Ajustes → pega la URL de producción del webhook (`https://TU-N8N/webhook/gastos-sync`) y la clave → «Guardar y sincronizar».

Contrato del webhook (POST, JSON, cabecera `X-Gastos-Key`):

- `{ "action": "pull", "since": <cursor> }` → `{ "ok": true, "cursor": <número>, "rows": [...] }`
- `{ "action": "push", "rows": [{ "id", "data", "updatedAt", "deleted" }] }` → `{ "ok": true }`

## Resumen semanal por email

El flujo de n8n «Gastos - Resumen semanal» lee la tabla `gastos_sync` cada lunes a las 9:00 (Europe/Madrid) y envía por Gmail el resumen de los 7 días anteriores. El código del nodo «Montar resumen» está en `n8n/resumen-semanal.code.js`. Solo cuenta lo que ya se ha sincronizado con n8n.
