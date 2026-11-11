// Sincronización con el webhook de n8n. Dos llamadas por pasada:
//   1) pull: pide las filas cambiadas desde la última vez y las fusiona (gana la más reciente).
//   2) push: envía lo que se ha cambiado en este dispositivo.
// La configuración (URL y clave) se guarda solo en este dispositivo.
import { toRow, fromRow, remoteWins, isDirty } from './lib.js';

const KEYS = { url: 'gastos.sync.url', key: 'gastos.sync.key', cursor: 'gastos.sync.cursor', last: 'gastos.sync.last' };
const read = (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
const write = (k, v) => { try { v === '' ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } };

export const getConfig = () => ({ url: read(KEYS.url), key: read(KEYS.key) });
export const isEnabled = () => Boolean(read(KEYS.url) && read(KEYS.key));
export const lastSync = () => read(KEYS.last);
export function setConfig(url, key) {
  const changed = url !== read(KEYS.url) || key !== read(KEYS.key);
  write(KEYS.url, url);
  write(KEYS.key, key);
  if (changed) { write(KEYS.cursor, ''); write(KEYS.last, ''); } // otro servidor: empezar de cero
}

export function randomKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function call(body) {
  const { url, key } = getConfig();
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Gastos-Key': key },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('Sin conexión con el servidor. Se reintentará.');
  }
  if (res.status === 401 || res.status === 403) throw new Error('El servidor rechaza la clave.');
  if (res.status === 404) throw new Error('No existe ese webhook. ¿Está publicado el workflow en n8n?');
  if (!res.ok) throw new Error(`El servidor ha respondido con un error (${res.status}).`);
  const data = await res.json().catch(() => null);
  if (!data || data.ok !== true) throw new Error('Respuesta inesperada del servidor.');
  return data;
}

let running = null;
let again = false;

/**
 * Una pasada de sincronización. "store" es el puente con la app:
 *   store.localRows()            -> [{ id, record }] con todo lo sincronizable (incluidos borrados)
 *   store.apply(kind, record)    -> guarda en local un registro que llega del servidor
 *   store.markClean(id, updatedAt) -> marca como enviado (si no ha cambiado desde entonces)
 * Devuelve { pulled, pushed }.
 */
export function syncNow(store) {
  if (!isEnabled()) return Promise.resolve(null);
  if (running) { again = true; return running; }
  running = (async () => {
    try {
      let result = await pass(store);
      while (again) { again = false; const more = await pass(store); result = { pulled: result.pulled + more.pulled, pushed: result.pushed + more.pushed }; }
      return result;
    } finally { running = null; again = false; }
  })();
  return running;
}

async function pass(store) {
  const pull = await call({ action: 'pull', since: Number(read(KEYS.cursor)) || 0 });
  const local = new Map(store.localRows().map((r) => [r.id, r.record]));
  let pulled = 0;
  for (const row of Array.isArray(pull.rows) ? pull.rows : []) {
    const parsed = fromRow(row);
    if (!parsed || !remoteWins(row, local.get(row.id))) continue;
    await store.apply(parsed.kind, parsed.record);
    pulled++;
  }
  if (Number.isFinite(pull.cursor)) write(KEYS.cursor, String(pull.cursor));

  const dirty = store.localRows().filter((r) => isDirty(r.record) && r.record.updatedAt);
  for (let i = 0; i < dirty.length; i += 100) {
    const batch = dirty.slice(i, i + 100);
    await call({ action: 'push', rows: batch.map((r) => toRow(r.id, r.record)) });
    for (const r of batch) await store.markClean(r.id, r.record.updatedAt);
  }
  write(KEYS.last, new Date().toISOString());
  return { pulled, pushed: dirty.length };
}
