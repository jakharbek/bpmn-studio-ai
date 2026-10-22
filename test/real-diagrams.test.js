// Real-world diagrams (optional, not in the repository): an assistant edit must change nothing but
// what was asked — every attribute and extension of every element survives.
// Put a .zip of .bpmn files into backup/ (git-ignored) or point $REAL_DIAGRAMS_ZIP at one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createStudio } from '../web/assistant/core.js';
import { MemoryAdapter } from '../src/store.js';
import { parseXml, validateXml } from '../src/bpmn.js';
import { checkXml } from '../src/lint.js';

const BACKUP_DIR = new URL('../backup/', import.meta.url);
const BACKUP = process.env.REAL_DIAGRAMS_ZIP
  || (existsSync(BACKUP_DIR) ? readdirSync(BACKUP_DIR).filter(f => f.endsWith('.zip')).map(f => new URL(f, BACKUP_DIR).pathname)[0] : null);

/** Every non-DI element as "type#id-or-owner|attributes", independent of order. */
async function facts(xml) {
  const { definitions } = await parseXml(xml);
  const out = new Set();
  const seen = new Set();
  const walk = (el, owner) => {
    if (!el || typeof el !== 'object' || seen.has(el) || !el.$type || /^(bpmndi|dc|di):/.test(el.$type)) return;
    seen.add(el);
    const attrs = Object.entries(el.$attrs || {}).filter(([k]) => !k.startsWith('xmlns')).map(([k, v]) => `${k}=${v}`);
    const own = Object.keys(el).filter(k => !k.startsWith('$') && typeof el[k] !== 'object').map(k => `${k}=${el[k]}`);
    out.add(`${el.$type}#${el.id ?? owner}|${[...own, ...attrs].sort().join('|')}`);
    for (const [k, v] of Object.entries(el)) {
      if (k.startsWith('$') || k === 'diagrams') continue;
      for (const x of [].concat(v ?? [])) if (x && typeof x === 'object' && x.$parent === el) walk(x, el.id ?? owner);
    }
  };
  walk(definitions, 'root');
  return out;
}

test('every real diagram survives an assistant edit unchanged', { skip: !(BACKUP && existsSync(BACKUP)) && 'no real-diagrams zip (backup/*.zip)' }, async () => {
  const studio = createStudio({ adapter: new MemoryAdapter() });
  const report = await studio.importFiles([new File([readFileSync(BACKUP)], 'backup.zip')]);
  assert.deepEqual(report.failed, []);
  assert.ok(report.imported.length >= 10);
  for (const name of report.imported) {
    const before = (await studio.store.get(name)).xml;
    const read = await studio.assistantStudio.callTool('bpmn_read', { file: name });
    assert.equal(read.ok, true, `${name}: ${read.error}`);
    // rename the process to its own name: a full rebuild that must not change anything
    const edit = await studio.assistantStudio.callTool('bpmn_edit', { file: name, open: false, force: true, processName: read.result.spec.processName || 'P' });
    assert.equal(edit.ok, true, `${name}: ${edit.error}`);
    const after = (await studio.store.get(name)).xml;
    const [a, b] = [await facts(before), await facts(after)];
    // definitions: only the exporter attributes may change
    const norm = x => x.replace(/\|exporter(Version)?=[^|]*/g, '');
    const [na, nb] = [new Set([...a].map(norm)), new Set([...b].map(norm))];
    const lost = [...na].filter(x => !nb.has(x));
    const added = [...nb].filter(x => !na.has(x));
    assert.deepEqual({ lost, added }, { lost: [], added: [] }, name);
    assert.deepEqual((await validateXml(after)).filter(w => /duplicate|unresolved|unparsable/.test(w)), [], name);
    const errorsBefore = (await checkXml(before)).deployErrors;
    const newErrors = (await checkXml(after)).deployErrors.filter(e => !errorsBefore.includes(e));
    assert.deepEqual(newErrors, [], name);
  }
});
