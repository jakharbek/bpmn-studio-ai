// Minimal ZIP writer/reader (deflate via the built-in CompressionStream; works in browsers and Node 18+).

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function pipe(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}
const deflate = bytes => pipe(bytes, new CompressionStream('deflate-raw'));

/** Inflate, stopping as soon as the output exceeds `limit` bytes (zip bombs lie about their sizes). */
async function inflate(bytes, limit, name) {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new Error(`${name}: unpacks to more than its declared size`);
    }
    chunks.push(value);
  }
  return concat(chunks);
}

const toBytes = data => (typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data));

function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

/**
 * @param {{ name: string, data: Uint8Array|string, mode?: number }[]} files  paths use "/" separators
 * @returns {Promise<Uint8Array>}
 */
export async function createZip(files, date = new Date()) {
  const { time, day } = dosDateTime(date);
  const parts = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const name = new TextEncoder().encode(file.name);
    const data = toBytes(file.data);
    const packed = await deflate(data);
    const crc = crc32(data);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);           // version needed
    local.setUint16(6, 0x0800, true);       // UTF-8 names
    local.setUint16(8, 8, true);            // deflate
    local.setUint16(10, time, true);
    local.setUint16(12, day, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, packed.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    parts.push(new Uint8Array(local.buffer), name, packed);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, (3 << 8) | 20, true); // made by: Unix, so the file mode below is honoured
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(10, 8, true);
    entry.setUint16(12, time, true);
    entry.setUint16(14, day, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, packed.length, true);
    entry.setUint32(24, data.length, true);
    entry.setUint16(28, name.length, true);
    entry.setUint32(38, ((file.mode || 0o644) << 16) >>> 0, true);
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), name);

    offset += 30 + name.length + packed.length;
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return concat([...parts, ...central, new Uint8Array(end.buffer)]);
}

function concat(chunks) {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/**
 * Name of an entry without the UTF-8 flag (Windows Explorer, macOS Archive Utility, old tools):
 * the Info-ZIP Unicode Path extra field if present, else UTF-8 if the bytes are valid UTF-8,
 * else the DOS code page of Russian Windows (CP866).
 */
function legacyName(raw, extra) {
  for (let i = 0; i + 4 <= extra.length;) {
    const tag = extra[i] | (extra[i + 1] << 8), size = extra[i + 2] | (extra[i + 3] << 8);
    if (tag === 0x7075 && size > 5 && i + 4 + size <= extra.length) {
      return new TextDecoder('utf-8').decode(extra.subarray(i + 9, i + 4 + size));
    }
    i += 4 + size;
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { /* not UTF-8 */ }
  return new TextDecoder('ibm866').decode(raw);
}

/**
 * Read a ZIP archive (stored or deflated entries, no encryption, no ZIP64).
 * @returns {Promise<{ name: string, data: Uint8Array }[]>} files only, directories skipped
 */
export async function readZip(input, { maxTotal = 200 * 1024 * 1024, maxEntries = 10000 } = {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const inside = (at, len) => { if (at < 0 || at + len > bytes.length) throw new Error('corrupt ZIP archive'); };
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a ZIP archive');
  const count = view.getUint16(eocd + 10, true);
  if (count > maxEntries) throw new Error(`ZIP archive has too many entries (${count}, max ${maxEntries})`);
  let at = view.getUint32(eocd + 16, true);
  const files = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    inside(at, 46);
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error('corrupt ZIP central directory');
    const method = view.getUint16(at + 10, true);
    const flags = view.getUint16(at + 8, true);
    const packedSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const localAt = view.getUint32(at + 42, true);
    inside(at + 46, nameLen);
    inside(at + 46 + nameLen, extraLen);
    const name = flags & 0x0800
      ? new TextDecoder('utf-8').decode(bytes.subarray(at + 46, at + 46 + nameLen))
      : legacyName(bytes.subarray(at + 46, at + 46 + nameLen), bytes.subarray(at + 46 + nameLen, at + 46 + nameLen + extraLen));
    at += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (flags & 1) throw new Error(`${name}: encrypted entries are not supported`);
    total += size;
    if (total > maxTotal) throw new Error('ZIP archive is too large');
    inside(localAt, 30);
    const dataAt = localAt + 30 + view.getUint16(localAt + 26, true) + view.getUint16(localAt + 28, true);
    inside(dataAt, packedSize);
    const raw = bytes.subarray(dataAt, dataAt + packedSize);
    if (method !== 0 && method !== 8) throw new Error(`${name}: unsupported compression method ${method}`);
    const data = method === 0 ? raw.slice() : await inflate(raw, size, name);
    if (data.length !== size) throw new Error(`${name}: size does not match the archive directory`);
    if (crc32(data) !== view.getUint32(at - 46 - nameLen - extraLen - commentLen + 16, true)) throw new Error(`${name}: CRC mismatch`);
    files.push({ name, data });
  }
  return files;
}
