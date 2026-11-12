// Bloqueo con PIN (por dispositivo). Se guarda solo un hash PBKDF2 con sal, nunca el PIN.
// Ojo: protege contra quien coge el móvil o el ordenador desbloqueado, no cifra los datos guardados.
const KEY = 'gastos.lock';
const FAILS = 'gastos.lock.fails';
const ITERATIONS = 150000;

const read = (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
const write = (k, v) => { try { v === '' ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } };
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (s) => new Uint8Array(s.match(/../g).map((h) => parseInt(h, 16)));

export const isValidPin = (pin) => /^[0-9]{4,8}$/.test(pin);

async function derive(pin, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, 256));
}

function stored() {
  try { const v = JSON.parse(read(KEY)); return v && v.salt && v.hash ? v : null; } catch { return null; }
}

export const hasPin = () => Boolean(stored());

export async function setPin(pin) {
  if (!isValidPin(pin)) throw new Error('El PIN tiene que tener de 4 a 8 cifras.');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(pin, salt, ITERATIONS);
  write(KEY, JSON.stringify({ v: 1, salt: hex(salt), iterations: ITERATIONS, hash }));
  write(FAILS, '');
}

export function clearPin() { write(KEY, ''); write(FAILS, ''); }

// Tras 5 fallos seguidos hay que esperar, y cada fallo de más dobla la espera (30 s, 60 s, 120 s… hasta 1 h).
function failState() {
  try { const v = JSON.parse(read(FAILS)); return { count: v.count || 0, until: v.until || 0 }; } catch { return { count: 0, until: 0 }; }
}
export function waitSeconds(now = Date.now()) {
  return Math.max(0, Math.ceil((failState().until - now) / 1000));
}

/** Devuelve true si el PIN es correcto. Lanza un error con el tiempo de espera si hay bloqueo temporal. */
export async function checkPin(pin, now = Date.now()) {
  const s = stored();
  if (!s) return true;
  const wait = waitSeconds(now);
  if (wait) throw new Error(`Demasiados intentos. Espera ${wait} s.`);
  const ok = (await derive(String(pin), unhex(s.salt), s.iterations || ITERATIONS)) === s.hash;
  if (ok) { write(FAILS, ''); return true; }
  const f = failState();
  const count = f.count + 1;
  const until = count >= 5 ? now + Math.min(3600, 30 * 2 ** (count - 5)) * 1000 : 0;
  write(FAILS, JSON.stringify({ count, until }));
  return false;
}
