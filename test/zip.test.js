import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createZip, readZip } from '../src/zip.js';

test('round trip with UTF-8 names and binary data', async () => {
  const bin = new Uint8Array(70000).map((_, i) => (i * 31) & 255);
  const zip = await createZip([{ name: 'схемы/заказ.bpmn', data: '<x>привет</x>' }, { name: 'b.bin', data: bin }]);
  const files = await readZip(zip);
  assert.deepEqual(files.map(f => f.name), ['схемы/заказ.bpmn', 'b.bin']);
  assert.equal(new TextDecoder().decode(files[0].data), '<x>привет</x>');
  assert.deepEqual(files[1].data, bin);
});

test('interoperates with the system zip/unzip', async t => {
  try { execFileSync('zip', ['-v'], { stdio: 'ignore' }); execFileSync('unzip', ['-v'], { stdio: 'ignore' }); } catch { return t.skip('zip/unzip not installed'); }
  const dir = mkdtempSync(join(tmpdir(), 'zip-test-'));
  try {
    writeFileSync(join(dir, 'ours.zip'), await createZip([{ name: 'a.txt', data: 'hello '.repeat(100) }, { name: 'run.sh', data: '#!/bin/sh\n', mode: 0o755 }]));
    execFileSync('unzip', ['-tq', join(dir, 'ours.zip')]);
    writeFileSync(join(dir, 'x.bpmn'), 'abc'.repeat(1000));
    writeFileSync(join(dir, 'y.bpmn'), 'z');
    execFileSync('zip', ['-q', join(dir, 'theirs.zip'), 'x.bpmn', 'y.bpmn'], { cwd: dir });
    const files = await readZip(readFileSync(join(dir, 'theirs.zip')));
    assert.deepEqual(files.map(f => [f.name, f.data.length]), [['x.bpmn', 3000], ['y.bpmn', 1]]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('rejects corrupt, oversized and non-zip input', async () => {
  await assert.rejects(readZip(new Uint8Array(100)), /not a ZIP/);
  const zip = await createZip([{ name: 'a.txt', data: 'a'.repeat(5000) }]);
  await assert.rejects(readZip(zip, { maxTotal: 1000 }), /too large/);
  const broken = zip.slice();
  broken[40] ^= 0xff; // inside the compressed data
  await assert.rejects(readZip(broken));
});

test('zip bombs: an entry that unpacks to more than it declares is refused early', async () => {
  // 50 MB of zeros, declared as 1 byte
  const zip = await createZip([{ name: 'bomb.bpmn', data: new Uint8Array(50 * 1024 * 1024) }]);
  const view = new DataView(zip.buffer);
  for (let i = zip.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x02014b50) { view.setUint32(i + 24, 1, true); break; }
  }
  view.setUint32(22, 1, true); // local header too
  const t = Date.now();
  await assert.rejects(readZip(zip, { maxTotal: 1024 }), /declared size|does not match/);
  assert.ok(Date.now() - t < 5000);
});

test('offsets outside the archive are a clear error', async () => {
  const zip = await createZip([{ name: 'a.txt', data: 'abc' }]);
  const view = new DataView(zip.buffer);
  for (let i = zip.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x02014b50) { view.setUint32(i + 42, 10_000_000, true); break; }
  }
  await assert.rejects(readZip(zip), /corrupt ZIP/);
});

test('names from Windows (CP866) and from tools without the UTF-8 flag', async () => {
  const zip = await createZip([{ name: 'AAAA.bpmn', data: 'x' }, { name: 'BBBBBBBBBB.bpmn', data: 'y' }]);
  const view = new DataView(zip.buffer);
  const cp866 = new Uint8Array([0x87, 0xa0, 0xaa, 0xa0]);            // "Зака" in CP866
  const utf8 = new TextEncoder().encode('Заказ');                      // 10 bytes, flag cleared
  let n = 0;
  for (let i = 0; i < zip.length - 4; i++) {
    const sig = view.getUint32(i, true);
    if (sig !== 0x04034b50 && sig !== 0x02014b50) continue;
    const central = sig === 0x02014b50;
    view.setUint16(i + (central ? 8 : 6), 0, true);                    // clear the UTF-8 flag
    const nameAt = i + (central ? 46 : 30);
    const nameLen = view.getUint16(i + (central ? 28 : 26), true);
    if (nameLen === 9) zip.set(cp866, nameAt);
    if (nameLen === 15) zip.set(utf8, nameAt);
    n++;
  }
  assert.equal(n, 4);
  const names = (await readZip(zip)).map(f => f.name);
  assert.deepEqual(names, ['Зака.bpmn', 'Заказ.bpmn']);
});
