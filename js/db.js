// IndexedDB wrapper: documents live here (bytes, page images, marks, field values).
const DB_NAME = 'formfill';
const DB_VER = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('docs')) {
        const s = db.createObjectStore('docs', { keyPath: 'id' });
        s.createIndex('updatedAt', 'updatedAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction('docs', mode);
    const store = t.objectStore('docs');
    let out;
    try { out = fn(store); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export const db = {
  async put(doc) { return tx('readwrite', s => s.put(doc)); },
  async get(id) { return tx('readonly', s => s.get(id)); },
  async delete(id) { return tx('readwrite', s => s.delete(id)); },
  async clear() { return tx('readwrite', s => s.clear()); },
  // Light listing: everything except the heavy fields.
  async list() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const out = [];
      const t = db.transaction('docs', 'readonly');
      const req = t.objectStore('docs').index('updatedAt').openCursor(null, 'prev');
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return;
        const d = c.value;
        out.push({ id: d.id, name: d.name, updatedAt: d.updatedAt, createdAt: d.createdAt, kind: d.kind, thumb: d.thumb, pageCount: d.pages ? d.pages.length : 0 });
        c.continue();
      };
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
    });
  },
  async usage() {
    if (navigator.storage && navigator.storage.estimate) {
      try { return await navigator.storage.estimate(); } catch { /* ignore */ }
    }
    return null;
  }
};
