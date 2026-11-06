// IndexedDB wrapper.
//   docs  — full documents (bytes, page images, marks, field values)
//   meta  — light per-document records for the home screen (name, thumbnail, dates)
//   sigs  — saved signatures / initials (PNG data URLs; too big for localStorage)
const DB_NAME = 'formfill';
const DB_VER = 2;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = e => {
      const db = req.result;
      if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' }).createIndex('updatedAt', 'updatedAt');
      if (!db.objectStoreNames.contains('sigs')) db.createObjectStore('sigs', { keyPath: 'id' });
      // v1 → v2: build meta rows from the existing docs.
      if (e.oldVersion < 2 && e.oldVersion > 0) {
        const t = req.transaction;
        const docs = t.objectStore('docs'), meta = t.objectStore('meta');
        docs.openCursor().onsuccess = ev => { const c = ev.target.result; if (!c) return; meta.put(metaOf(c.value)); c.continue(); };
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Database is open in another tab'));
  });
  return dbp;
}

function metaOf(d) {
  return { id: d.id, name: d.name, updatedAt: d.updatedAt, createdAt: d.createdAt, kind: d.kind, thumb: d.thumb || null, pageCount: d.pages ? d.pages.length : 0 };
}

function tx(stores, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let out;
    try { out = fn(...stores.map(s => t.objectStore(s))); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(out instanceof IDBRequest ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export const db = {
  async put(doc) { return tx(['docs', 'meta'], 'readwrite', (docs, meta) => { docs.put(doc); meta.put(metaOf(doc)); }); },
  async get(id) { return tx(['docs'], 'readonly', s => s.get(id)); },
  async delete(id) { return tx(['docs', 'meta'], 'readwrite', (docs, meta) => { docs.delete(id); meta.delete(id); }); },
  async clear() { return tx(['docs', 'meta'], 'readwrite', (docs, meta) => { docs.clear(); meta.clear(); }); },
  async list() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const out = [];
      const t = db.transaction('meta', 'readonly');
      const req = t.objectStore('meta').index('updatedAt').openCursor(null, 'prev');
      req.onsuccess = () => { const c = req.result; if (!c) return; out.push(c.value); c.continue(); };
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
    });
  },
  // signatures
  async sigsAll() { return tx(['sigs'], 'readonly', s => s.getAll()); },
  async sigPut(sig) { return tx(['sigs'], 'readwrite', s => s.put(sig)); },
  async sigDelete(id) { return tx(['sigs'], 'readwrite', s => s.delete(id)); },
  async usage() {
    if (navigator.storage && navigator.storage.estimate) {
      try { return await navigator.storage.estimate(); } catch { /* ignore */ }
    }
    return null;
  }
};
