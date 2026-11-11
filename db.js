// Capa mínima sobre IndexedDB.
// "expenses": movimientos (clave "id"). "meta": ajustes sueltos (clave "key"): presupuestos y recurrentes.
const DB_NAME = 'gastos';
const DB_VERSION = 2;
const STORE = 'expenses';
const META = 'meta';

let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' }).createIndex('date', 'date');
        }
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(store, mode, work) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const result = work(t.objectStore(store));
    t.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const getAll = () => tx(STORE, 'readonly', (s) => s.getAll());
export const put = (expense) => tx(STORE, 'readwrite', (s) => s.put(expense));
export const remove = (id) => tx(STORE, 'readwrite', (s) => s.delete(id));
export const putMany = (list) => tx(STORE, 'readwrite', (s) => { list.forEach((e) => s.put(e)); });

export const getMeta = async (key, fallback) => {
  const row = await tx(META, 'readonly', (s) => s.get(key));
  return row ? row.value : fallback;
};
export const setMeta = (key, value) => tx(META, 'readwrite', (s) => s.put({ key, value }));
