// Diagram names: flat names ending in ".bpmn", never paths, safe to show and to use as file names.

export class StoreError extends Error {
  constructor(message, status, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

const MAX_BASE = 120;
// control, format (bidi overrides, zero-width), line/paragraph separators
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
// characters that are not allowed in file names on Windows/macOS/Linux, plus path separators
const FILE_UNSAFE = /[<>:"|?*\\/]/;

/** "Credit approval" / "credit-approval" / "Credit.BPMN" → "credit-approval.bpmn"-style name; rejects anything else. */
export function normalizeName(raw) {
  if (typeof raw !== 'string') throw new StoreError('Имя схемы должно быть строкой', 400);
  let base = raw.normalize('NFC').trim().replace(/\.bpmn$/i, '').trim();
  const shown = JSON.stringify(raw.length > 60 ? raw.slice(0, 60) + '…' : raw);
  if (!base) throw new StoreError('Имя схемы пустое', 400);
  if (base.length > MAX_BASE) throw new StoreError(`Имя схемы слишком длинное (не больше ${MAX_BASE} символов)`, 400);
  if (INVISIBLE.test(base) || FILE_UNSAFE.test(base) || base.startsWith('.') || base.includes('..')) {
    throw new StoreError(`Недопустимое имя схемы ${shown}: нельзя использовать < > : " | ? * \\ /, невидимые символы, точку в начале и ".."`, 400);
  }
  return `${base}.bpmn`;
}
