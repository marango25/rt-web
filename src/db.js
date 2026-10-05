/**
 * db.js
 *
 * Persistencia local de sesiones de logging usando IndexedDB (la base de
 * datos que ya trae el navegador). Se eligió sobre SQLite porque esta app
 * es solo archivos estáticos servidos por el ESP8266/una Raspberry Pi/el
 * navegador local, sin backend - SQLite necesitaría o un servidor real
 * (rompe esa decisión) o compilarlo a WebAssembly (y aun así necesita algo
 * como IndexedDB por debajo para persistir). IndexedDB da exactamente lo
 * que hace falta: persistente, indexable por vehículo, sin dependencias.
 *
 * Cada sesión guarda: { id, vehicleTag, startedAt, updatedAt, paramsSnapshot, rows }
 * - paramsSnapshot: [{id, name, units}] - copia de los parámetros del .adx
 *   usado, para poder reconstruir las columnas al recargar la sesión aunque
 *   ya no esté cargada esa misma definición.
 * - rows: mismo formato que sessionLog en main.js ({t, values, raw, evento, fueraDeRango}).
 */

const DB_NAME = "rtweb";
const DB_VERSION = 1;
const STORE = "sessions";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("vehicleTag", "vehicleTag", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveSession(session) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(session);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function listSessions() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result.sort((a, b) => b.startedAt - a.startedAt));
    req.onerror = () => reject(req.error);
  });
}

export async function getSession(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteSession(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
