// Diagram storage: conflicts, history, names, limits (the same logic runs on IndexedDB in the browser).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DiagramStore, MemoryAdapter, HISTORY_LIMIT, MAX_XML, normalizeName } from '../src/store.js';

const X = n => `<?xml version="1.0"?><definitions id="v${n}"/>`;
const fresh = () => new DiagramStore(new MemoryAdapter());

test('save, get, list, events', async () => {
  const s = fresh();
  const events = [];
  s.addEventListener('change', e => events.push(e.detail));
  const a = await s.save('order', X(1), { source: 'tab-1' });
  assert.equal(a.name, 'order.bpmn');
  assert.equal(a.created, true);
  assert.equal((await s.get('order.bpmn')).xml, X(1));
  assert.deepEqual((await s.list()).map(f => f.file), ['order.bpmn']);
  assert.deepEqual(events, [{ type: 'changed', file: 'order.bpmn', hash: a.hash, source: 'tab-1' }, { type: 'files' }]);
  await assert.rejects(s.get('missing'), err => err.status === 404);
});

test('conflicts: a stale base version is refused, the same content never conflicts', async () => {
  const s = fresh();
  const v1 = await s.save('d', X(1));
  const v2 = await s.save('d', X(2), { baseHash: v1.hash });
  await assert.rejects(s.save('d', X(3), { baseHash: v1.hash }), err => err.status === 409 && err.current.hash === v2.hash);
  // a retried save of what is already stored: no conflict, no new history step
  const same = await s.save('d', X(2), { baseHash: v1.hash });
  assert.equal(same.hash, v2.hash);
  await assert.rejects(s.save('d', X(9), { create: true }), err => err.status === 409);
});

test('concurrent saves from the same base: exactly one wins', async () => {
  const s = fresh();
  const base = await s.save('d', X(0));
  const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => s.save('d', X(i + 1), { baseHash: base.hash })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.ok(results.filter(r => r.status === 'rejected').every(r => r.reason.status === 409));
});

test('undo and redo lose nothing; a new edit drops the redo branch', async () => {
  const s = fresh();
  await s.save('d', X(1)); await s.save('d', X(2)); await s.save('d', X(3));
  await s.undo('d'); await s.undo('d');
  assert.equal((await s.get('d')).xml, X(1));
  await assert.rejects(s.undo('d'), err => err.status === 409);
  await s.redo('d');
  assert.equal((await s.get('d')).xml, X(2));
  await s.redo('d');
  assert.equal((await s.get('d')).xml, X(3));
  await assert.rejects(s.redo('d'), err => err.status === 409);
  await s.undo('d');
  await s.save('d', X(4));
  await assert.rejects(s.redo('d'), err => err.status === 409);
  await s.undo('d');
  assert.equal((await s.get('d')).xml, X(2));
});

test('history is bounded', async () => {
  const s = fresh();
  for (let i = 0; i < HISTORY_LIMIT + 10; i++) await s.save('d', X(i));
  let steps = 0;
  while (await s.undo('d').then(() => true, () => false)) steps++;
  assert.equal(steps, HISTORY_LIMIT);
});

test('delete', async () => {
  const s = fresh();
  await s.save('d', X(1));
  const events = [];
  s.addEventListener('change', e => events.push(e.detail));
  await s.delete('d', { source: 't' });
  assert.equal(await s.exists('d'), false);
  assert.deepEqual(events, [{ type: 'deleted', file: 'd.bpmn', source: 't' }, { type: 'files' }]);
  await assert.rejects(s.delete('d'), err => err.status === 404);
});

test('limits and names', async () => {
  const s = fresh();
  await assert.rejects(s.save('d', ''), err => err.status === 400);
  await assert.rejects(s.save('d', 'x'.repeat(MAX_XML + 1)), err => err.status === 413);
  assert.equal(normalizeName('Заказ.BPMN'), 'Заказ.bpmn');
  assert.equal(normalizeName('é'), 'é.bpmn'); // NFC: one name for one visible text
  for (const bad of ['', ' ', '..', '.hidden', 'a/b', 'a\\b', 'a:b', 'x‮y', 'x\u0000', 'a'.repeat(200), null, 42]) {
    assert.throws(() => normalizeName(bad), err => err.status === 400, String(bad));
  }
});

test('a save based on a version that was deleted meanwhile does not recreate the diagram', async () => {
  const s = fresh();
  const v1 = await s.save('d', X(1));
  await s.delete('d');
  await assert.rejects(s.save('d', X(2), { baseHash: v1.hash }), err => err.status === 409 && err.deleted === true);
  assert.equal(await s.exists('d'), false);
  // without a base version ("keep mine" / import) it is created again on purpose
  assert.equal((await s.save('d', X(2))).created, true);
});

test('rename moves the whole record (history included) atomically', async () => {
  const s = fresh();
  await s.save('a', X(1)); await s.save('a', X(2));
  await s.save('b', X(9));
  const events = [];
  s.addEventListener('change', e => events.push(e.detail));
  const r = await s.rename('a', 'Заказ v2', { source: 't' });
  assert.deepEqual(r, { name: 'Заказ v2.bpmn', renamed: true });
  assert.equal(await s.exists('a'), false);
  assert.equal((await s.get('Заказ v2')).xml, X(2));
  await s.undo('Заказ v2');
  assert.equal((await s.get('Заказ v2')).xml, X(1), 'undo history moved too');
  assert.deepEqual(events[0], { type: 'renamed', file: 'a.bpmn', to: 'Заказ v2.bpmn', source: 't' });
  // taken names, case twins, missing source, invalid names
  await assert.rejects(s.rename('Заказ v2', 'b'), err => err.status === 409);
  await assert.rejects(s.rename('Заказ v2', 'B'), err => err.status === 409);
  await assert.rejects(s.rename('nope', 'c'), err => err.status === 404);
  await assert.rejects(s.rename('b', 'x/y'), err => err.status === 400);
  // only the letter case changes: allowed
  assert.equal((await s.rename('b', 'B')).name, 'B.bpmn');
  assert.deepEqual((await s.list()).map(f => f.file).sort(), ['B.bpmn', 'Заказ v2.bpmn']);
  assert.deepEqual(await s.rename('B', 'B.bpmn'), { name: 'B.bpmn', renamed: false });
  // a save based on the old name's version no longer finds it
  const { hash } = await s.get('B');
  await assert.rejects(s.save('b', X(3), { baseHash: hash }), err => err.status === 409 && err.deleted);
});
