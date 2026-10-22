// Diagram storage. In the studio it lives in the user's browser (IndexedDB, src/idbAdapter.js);
// tests use the in-memory adapter below. The logic — conflicts, history, undo/redo, limits — is
// the same for both.
import { StoreError, normalizeName } from './names.js';

export { StoreError, normalizeName };

export const MAX_XML = 5 * 1024 * 1024;     // characters per diagram
export const HISTORY_LIMIT = 50;            // undo steps kept per diagram

export async function hashOf(text) {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Storage adapter contract (all methods async):
 *   list() → [{ name, updated }]
 *   names() → [name]                     keys only (cheap)
 *   move(from, to, fn) → fn's result      atomically: fn(fromRecord | undefined, toRecord | undefined) → { record?, result };
 *                                         the returned record is stored under `to` and `from` is removed
 *   get(name) → record | undefined       record = { name, xml, hash, created, updated, undo: [], redo: [] }
 *   update(name, fn) → fn's result        atomically: fn(record | undefined) → { record?, result }
 *                                         (record undefined = no change, null = delete)
 * undo/redo entries: { xml, hash, saved }
 */
export class MemoryAdapter {
  constructor() { this.records = new Map(); }
  async list() { return [...this.records.values()].map(r => ({ name: r.name, updated: r.updated })); }
  async names() { return [...this.records.keys()]; }
  async move(from, to, fn) {
    const a = this.records.get(from), b = this.records.get(to);
    const { record, result } = fn(a && structuredClone(a), b && structuredClone(b));
    if (record) { this.records.delete(from); this.records.set(to, structuredClone(record)); }
    return result;
  }
  async get(name) { const r = this.records.get(name); return r && structuredClone(r); }
  async update(name, fn) {
    const current = this.records.get(name);
    const { record, result } = fn(current && structuredClone(current));
    if (record === null) this.records.delete(name);
    else if (record) this.records.set(name, structuredClone(record));
    return result;
  }
}

export class DiagramStore extends EventTarget {
  /** @param {MemoryAdapter|import('./idbAdapter.js').IdbAdapter} adapter */
  constructor(adapter = new MemoryAdapter()) {
    super();
    this.adapter = adapter;
  }

  #emit(detail) { this.dispatchEvent(new CustomEvent('change', { detail })); }

  async list() {
    const rows = await this.adapter.list();
    return rows.sort((a, b) => b.updated.localeCompare(a.updated) || a.name.localeCompare(b.name))
      .map(r => ({ file: r.name, modified: r.updated }));
  }

  async exists(name) { return !!(await this.adapter.get(normalizeName(name))); }

  /** @returns {Promise<{ name, xml, hash, updated }>} */
  async get(name) {
    const n = normalizeName(name);
    const r = await this.adapter.get(n);
    if (!r) throw new StoreError(`Схема «${n}» не найдена`, 404);
    return { name: r.name, xml: r.xml, hash: r.hash, updated: r.updated };
  }

  /**
   * Save a diagram; the previous content becomes an undo step.
   * @param {object} [opts]
   * @param {string} [opts.baseHash]  the version the caller started from: 409 if it changed meanwhile
   * @param {boolean} [opts.create]   409 if the diagram already exists
   * @param {string} [opts.source]    who saved (passed on in the change event)
   */
  async save(name, xml, { baseHash, create = false, source } = {}) {
    const n = normalizeName(name);
    if (typeof xml !== 'string' || !xml.trim()) throw new StoreError('Пустая схема', 400);
    if (xml.length > MAX_XML) throw new StoreError(`Схема слишком большая (${Math.round(xml.length / 1024)} КБ, максимум ${MAX_XML / 1024 / 1024} МБ)`, 413);
    const hash = await hashOf(xml);
    // a new name must not differ from an existing one only in letter case: "Order" and "order" would
    // overwrite each other when the backup .zip is unpacked on Windows/macOS. Existing diagrams are
    // never blocked (older data may already contain such a pair).
    // (a save with baseHash edits an existing version: if that is gone, the "deleted" answer below matters)
    const names = await this.adapter.names();
    if (!names.includes(n) && !baseHash) {
      const twin = names.find(x => x.toLowerCase() === n.toLowerCase());
      if (twin) throw new StoreError(`Уже есть схема «${twin}»: имена не должны отличаться только регистром букв`, 409, { twin });
    }
    const now = new Date().toISOString();
    const outcome = await this.adapter.update(n, current => {
      if (current && create) throw new StoreError(`Схема «${n}» уже существует`, 409);
      // the same content is already stored: nothing to do (e.g. a retried save), never a conflict
      if (current && current.hash === hash) return { result: { changed: false, created: false } };
      // the caller edited a version that was deleted meanwhile: never silently recreate it
      if (!current && baseHash) throw new StoreError(`Схема «${n}» удалена`, 409, { deleted: true });
      if (current && baseHash && current.hash !== baseHash) {
        throw new StoreError('conflict', 409, { current: { xml: current.xml, hash: current.hash } });
      }
      if (!current) {
        return { record: { name: n, xml, hash, created: now, updated: now, undo: [], redo: [] }, result: { changed: true, created: true } };
      }
      const undo = [...current.undo, { xml: current.xml, hash: current.hash, saved: current.updated }].slice(-HISTORY_LIMIT);
      // a new edit starts a new branch: what was undone cannot be redone any more
      return { record: { ...current, xml, hash, updated: now, undo, redo: [] }, result: { changed: true, created: false } };
    });
    if (outcome.changed) {
      this.#emit({ type: 'changed', file: n, hash, source });
      if (outcome.created) this.#emit({ type: 'files' });
    }
    return { name: n, hash, created: outcome.created };
  }

  /** Step back one version; the current content is kept for redo (nothing is destroyed). */
  async undo(name, { baseHash, source } = {}) {
    return this.#step(name, 'undo', 'redo', { baseHash, source });
  }

  /** Re-apply what the last undo replaced. */
  async redo(name, { baseHash, source } = {}) {
    return this.#step(name, 'redo', 'undo', { baseHash, source });
  }

  async #step(name, from, to, { baseHash, source }) {
    const n = normalizeName(name);
    const now = new Date().toISOString();
    const result = await this.adapter.update(n, current => {
      if (!current) throw new StoreError(`Схема «${n}» не найдена`, 404);
      if (baseHash && current.hash !== baseHash) throw new StoreError('conflict', 409, { current: { xml: current.xml, hash: current.hash } });
      const stack = current[from];
      if (!stack.length) throw new StoreError(from === 'undo' ? 'Нет предыдущих версий' : 'Нечего возвращать', 409);
      const target = stack[stack.length - 1];
      const record = {
        ...current, xml: target.xml, hash: target.hash, updated: now,
        [from]: stack.slice(0, -1),
        [to]: [...current[to], { xml: current.xml, hash: current.hash, saved: current.updated }].slice(-HISTORY_LIMIT)
      };
      return { record, result: { name: n, hash: target.hash, from: target.saved, remaining: record[from].length } };
    });
    this.#emit({ type: 'changed', file: n, hash: result.hash, source });
    return result;
  }

  /**
   * Rename a diagram. The whole record moves (history included); the XML is unchanged, so the
   * process id — the engine's deployment key — stays the same. A rename that only changes letter
   * case ("order" → "Order") is allowed.
   */
  async rename(name, newName, { source } = {}) {
    const from = normalizeName(name);
    const to = normalizeName(newName);
    if (from === to) return { name: to, renamed: false };
    const names = await this.adapter.names();
    const twin = names.find(x => x !== from && x.toLowerCase() === to.toLowerCase());
    if (twin) throw new StoreError(`Уже есть схема «${twin}»`, 409, { twin });
    const now = new Date().toISOString();
    await this.adapter.move(from, to, (current, existing) => {
      if (!current) throw new StoreError(`Схема «${from}» не найдена`, 404);
      if (existing) throw new StoreError(`Уже есть схема «${to}»`, 409, { twin: to });
      return { record: { ...current, name: to, updated: now }, result: null };
    });
    this.#emit({ type: 'renamed', file: from, to, source });
    this.#emit({ type: 'files' });
    return { name: to, renamed: true };
  }

  async delete(name, { source } = {}) {
    const n = normalizeName(name);
    const existed = await this.adapter.update(n, current => ({ record: current ? null : undefined, result: !!current }));
    if (!existed) throw new StoreError(`Схема «${n}» не найдена`, 404);
    this.#emit({ type: 'deleted', file: n, source });
    this.#emit({ type: 'files' });
  }
}
