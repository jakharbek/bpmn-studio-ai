// IndexedDB storage adapter: the studio's diagrams live in the user's browser.
// Every update runs in one readwrite transaction, so concurrent saves (two tabs, editor + assistant)
// are serialized by the browser and the conflict check in DiagramStore stays atomic.

const STORE = 'diagrams';

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class IdbAdapter {
  constructor(dbName = 'bpmn-studio') {
    this.dbName = dbName;
    this.db = null;
  }

  async #open() {
    if (this.db) return this.db;
    const req = indexedDB.open(this.dbName, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'name' });
    };
    this.db = await request(req);
    // another tab upgraded the database: let it, reopen lazily
    this.db.onversionchange = () => { this.db.close(); this.db = null; };
    return this.db;
  }

  async list() {
    const db = await this.#open();
    const rows = await request(db.transaction(STORE).objectStore(STORE).getAll());
    return rows.map(r => ({ name: r.name, updated: r.updated }));
  }

  /** Just the names (keys): no record — with its undo history — is read. */
  async names() {
    const db = await this.#open();
    return request(db.transaction(STORE).objectStore(STORE).getAllKeys());
  }

  async get(name) {
    const db = await this.#open();
    return request(db.transaction(STORE).objectStore(STORE).get(name));
  }

  async update(name, fn) {
    const db = await this.#open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const os = tx.objectStore(STORE);
      let result;
      let failure = null;
      const get = os.get(name);
      get.onsuccess = () => {
        try {
          const out = fn(get.result);
          result = out.result;
          if (out.record === null) os.delete(name);
          else if (out.record) os.put(out.record);
        } catch (err) {
          failure = err;
          tx.abort();
        }
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure || tx.error || new Error('IndexedDB transaction aborted'));
      tx.onerror = () => { if (!failure) failure = tx.error; };
    });
  }

  /** Move a record to another key in one transaction (rename). See the contract in store.js. */
  async move(from, to, fn) {
    const db = await this.#open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const os = tx.objectStore(STORE);
      let result;
      let failure = null;
      const a = os.get(from);
      const b = os.get(to);
      b.onsuccess = () => {
        try {
          const out = fn(a.result, b.result);
          result = out.result;
          if (out.record) { os.delete(from); os.put({ ...out.record, name: to }); }
        } catch (err) {
          failure = err;
          tx.abort();
        }
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure || tx.error || new Error('IndexedDB transaction aborted'));
      tx.onerror = () => { if (!failure) failure = tx.error; };
    });
  }

  /** Ask the browser not to evict the studio's data under storage pressure (best effort). */
  static async persist() {
    try { return await navigator.storage?.persist?.(); } catch { return false; }
  }
}
