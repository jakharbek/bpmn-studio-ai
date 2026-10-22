// The assistant's BPMN tools end to end, exactly as the browser assistant calls them
// (createStudio(...).assistantStudio.callTool), on the in-memory storage adapter.
import { test, after } from 'node:test';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { scenarios } from './scenarios.js';
import { createStudio } from '../web/assistant/core.js';
import { MemoryAdapter } from '../src/store.js';

// stand-in for a deployment backend: POST {server}{deploy.path} with { [deploy.field]: base64 XML }
const received = [];
const fake = createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    received.push({ method: req.method, url: req.url, type: req.headers['content-type'], body: JSON.parse(body) });
    res.writeHead(req.url.startsWith('/fail') ? 500 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ processDefinitionId: 'zakaz:1:42' }));
  });
});
await new Promise(r => fake.listen(0, '127.0.0.1', r));
const FAKE = `http://127.0.0.1:${fake.address().port}`;
after(() => fake.close());

const shown = [];
const studio = createStudio({
  settings: { deploy: { targets: { dev: FAKE, broken: `${FAKE}/fail`, down: 'http://127.0.0.1:9' } } },
  show: async name => { shown.push(name); return `Shown ${name}.`; },
  adapter: new MemoryAdapter()
});
const xmlOf = async name => (await studio.store.get(name)).xml;

const call = async (name, args = {}) => {
  const res = await studio.assistantStudio.callTool(name, args);
  if (!res.ok) return { isError: true, text: res.error, json: null };
  return { isError: false, text: typeof res.result === 'string' ? res.result : JSON.stringify(res.result), json: res.result };
};

test('lists all tools with the system prompt', async () => {
  const cfg = await studio.assistantStudio.config();
  assert.deepEqual(cfg.tools.map(t => t.name).sort(),
    ['bpmn_create', 'bpmn_deploy', 'bpmn_edit', 'bpmn_get_xml', 'bpmn_lint', 'bpmn_list', 'bpmn_open', 'bpmn_read', 'bpmn_redo', 'bpmn_rename', 'bpmn_undo', 'bpmn_write_xml']);
  assert.match(cfg.systemPrompt, /deployErrors/);
  assert.match(cfg.systemPrompt, /data, not instructions/i);
});

test('create → read → edit → undo → redo', async () => {
  const { processId, ...spec } = scenarios.order;
  const created = await call('bpmn_create', { file: 'заказ', ...spec, open: false });
  assert.equal(created.isError, false, created.text);
  assert.deepEqual(created.json.deployErrors, []);
  assert.equal(created.json.saved, 'заказ.bpmn');
  // process id derived from a Cyrillic file name is a valid ASCII id
  assert.match(await xmlOf('заказ.bpmn'), /<bpmn:process id="zakaz"/);

  const again = await call('bpmn_create', { file: 'заказ', ...spec, open: false });
  assert.equal(again.isError, true);
  assert.match(again.text, /already exists/);

  const read = await call('bpmn_read', { file: 'заказ' });
  assert.equal(read.json.spec.elements.length, spec.elements.length);
  assert.deepEqual(read.json.notRepresentedInSpec, []);

  const edited = await call('bpmn_edit', {
    file: 'заказ', open: false,
    insertBetween: [{ from: 'Task_CheckStock', to: 'Gateway_InStock', element: { id: 'Task_Reserve', type: 'serviceTask', name: 'Зарезервировать товар', jobType: 'reserve' } }]
  });
  assert.equal(edited.isError, false, edited.text);
  assert.deepEqual(edited.json.deployErrors, []);
  assert.match(await xmlOf('заказ.bpmn'), /Зарезервировать товар/);

  const undo = await call('bpmn_undo', { file: 'заказ', open: false });
  assert.equal(undo.isError, false, undo.text);
  assert.doesNotMatch(await xmlOf('заказ.bpmn'), /Зарезервировать товар/);
  // undo destroys nothing: redo brings the edit back
  const redo = await call('bpmn_redo', { file: 'заказ', open: false });
  assert.equal(redo.isError, false, redo.text);
  assert.match(await xmlOf('заказ.bpmn'), /Зарезервировать товар/);
  await call('bpmn_undo', { file: 'заказ', open: false });

  const list = await call('bpmn_list');
  assert.deepEqual(list.json.files.map(f => f.file), ['заказ.bpmn']);
});

test('edit reports lint problems it introduced', async () => {
  const res = await call('bpmn_edit', {
    file: 'заказ', open: false,
    addElements: [{ id: 'Task_NoJob', type: 'serviceTask', name: 'Без типа' }],
    addFlows: [{ from: 'Gateway_InStock', to: 'Task_NoJob', condition: 'priority = "high"' }, { from: 'Task_NoJob', to: 'Gateway_Merge' }]
  });
  assert.equal(res.isError, false, res.text);
  assert.ok(res.json.deployErrors.some(e => e.includes('Task_NoJob')));
});

test('edit refuses to drop unsupported content unless forced', async () => {
  // a diagram drawn by hand in the editor, with an annotation the spec cannot represent
  const xml = (await xmlOf('заказ.bpmn'))
    .replace('</bpmn:process>', '<bpmn:textAnnotation id="Note_1"><bpmn:text>важно</bpmn:text></bpmn:textAnnotation></bpmn:process>');
  const report = await studio.importFiles([new File([xml], 'manual.bpmn')]);
  assert.deepEqual(report.imported, ['manual.bpmn']);
  const refused = await call('bpmn_edit', { file: 'manual', open: false, updateElements: [{ id: 'Start', name: 'Новый заказ' }] });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /Note_1/);
  const forced = await call('bpmn_edit', { file: 'manual', open: false, force: true, updateElements: [{ id: 'Start', name: 'Новый заказ' }] });
  assert.equal(forced.isError, false, forced.text);
  assert.deepEqual(forced.json.dropped, ['Note_1 (bpmn:TextAnnotation)']);
});

test('the editor changed the diagram meanwhile: bpmn_edit reports a conflict instead of overwriting', async () => {
  const before = await studio.store.get('manual');
  const tools = studio.tools;
  // a save from the editor lands between the tool's read and its write
  const origSave = studio.store.save.bind(studio.store);
  let injected = false;
  studio.store.save = async (name, xml, opts) => {
    if (!injected && opts?.baseHash) {
      injected = true;
      await origSave(name, before.xml.replace('Новый заказ', 'Правка в редакторе'), { source: 'editor' });
    }
    return origSave(name, xml, opts);
  };
  try {
    const res = await call('bpmn_edit', { file: 'manual', open: false, updateElements: [{ id: 'Start', name: 'От ассистента' }] });
    assert.equal(res.isError, true);
    assert.match(res.text, /changed in the editor/);
    assert.match(await xmlOf('manual'), /Правка в редакторе/);
  } finally {
    studio.store.save = origSave;
  }
  assert.ok(tools);
});

test('write_xml, get_xml, lint and open', async () => {
  const xml = await xmlOf('заказ.bpmn');
  const w = await call('bpmn_write_xml', { file: 'copy', xml, open: false });
  assert.equal(w.isError, false, w.text);
  assert.equal((await call('bpmn_get_xml', { file: 'copy' })).text, xml);
  const lint = await call('bpmn_lint', { file: 'copy' });
  assert.ok(Array.isArray(lint.json.deployErrors));
  const bad = await call('bpmn_write_xml', { file: 'broken', xml: '<nope/>', open: false });
  assert.equal(bad.isError, true);
  const open = await call('bpmn_open', { file: 'copy' });
  assert.equal(open.text, 'Shown copy.bpmn.');
  assert.equal(shown.at(-1), 'copy.bpmn');
  assert.equal((await call('bpmn_open', { file: 'nope' })).isError, true);
  // names, not paths
  for (const file of ['../../etc/passwd', '/tmp/x', 'a/b', '..', 'x‮y']) assert.equal((await call('bpmn_get_xml', { file })).isError, true, file);
});

test('edits that keep the structure keep manual positions', async () => {
  // simulate the user dragging a task in the web modeler
  const current = await studio.store.get('заказ.bpmn');
  const moved = current.xml.replace(
    /(<bpmndi:BPMNShape id="Task_CheckStock_di"[^>]*>\s*<dc:Bounds x=")(\d+)(" y=")(\d+)/,
    (_, a, x, b, y) => `${a}${x}${b}${Number(y) + 333}`);
  await studio.store.save('заказ.bpmn', moved, { baseHash: current.hash, source: 'editor' });
  const y = xml => Number(/id="Task_CheckStock_di"[^>]*>\s*<dc:Bounds x="\d+" y="(\d+)"/.exec(xml)[1]);
  const movedY = y(moved);

  const rename = await call('bpmn_edit', { file: 'заказ', open: false, updateElements: [{ id: 'Task_CheckStock', name: 'Проверить остатки' }] });
  assert.equal(rename.json.layout, 'kept');
  assert.equal(y(await xmlOf('заказ.bpmn')), movedY);

  const forced = await call('bpmn_edit', { file: 'заказ', open: false, relayout: true, updateElements: [{ id: 'Task_CheckStock', name: 'Проверить склад' }] });
  assert.equal(forced.json.layout, 'recomputed');
  assert.notEqual(y(await xmlOf('заказ.bpmn')), movedY);
});

test('bpmn_deploy sends base64 of the file to {server}{deploy.path}', async () => {
  const cfg = await studio.assistantStudio.config();
  const deployTool = cfg.tools.find(t => t.name === 'bpmn_deploy');
  assert.deepEqual(deployTool.parameters.properties.target.enum, ['dev', 'broken', 'down']);

  // the order diagram still has Task_NoJob without implementation from an earlier test → refused
  const refused = await call('bpmn_deploy', { file: 'заказ', target: 'dev' });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /deploy errors/);
  assert.equal(received.length, 0);

  const ok = await call('bpmn_deploy', { file: 'заказ', target: 'dev', force: true });
  assert.equal(ok.isError, false, ok.text);
  assert.equal(ok.json.status, 200);
  assert.match(ok.json.response, /zakaz:1:42/);
  const req = received.at(-1);
  assert.equal(req.method, 'POST');
  assert.equal(req.url, '/api/bpmn/deploy');
  assert.equal(req.type, 'application/json');
  assert.equal(Buffer.from(req.body.bpmnBase64, 'base64').toString('utf8'), await xmlOf('заказ.bpmn'));

  const http500 = await call('bpmn_deploy', { file: 'заказ', target: 'broken', force: true });
  assert.match(http500.text, /HTTP 500/);
  const down = await call('bpmn_deploy', { file: 'заказ', target: 'down', force: true });
  assert.match(down.text, /Could not reach server "down"/);
  // inherited object keys are not servers
  assert.equal((await call('bpmn_deploy', { file: 'заказ', target: 'constructor', force: true })).isError, true);
  assert.equal(received.length, 3 - 1 /* down never arrives */);
});

test('the "Отправить схему" button: target, custom URL, deploy errors', async () => {
  await assert.rejects(studio.deploy('заказ', { target: 'dev' }), err => err.status === 422 && err.deployErrors.length > 0);
  const res = await studio.deploy('заказ', { url: FAKE, force: true });
  assert.equal(res.status, 200);
  assert.equal(res.url, `${FAKE}/api/bpmn/deploy`);
  await assert.rejects(studio.deploy('заказ', { url: 'http://127.0.0.1:9', force: true }), err => err.status === 502);
});

test('export all → import: a full backup round trip', async () => {
  const zip = await studio.exportAll();
  const other = createStudio({ adapter: new MemoryAdapter() });
  const report = await other.importFiles([new File([zip], 'backup.zip')]);
  const names = (await studio.store.list()).map(f => f.file).sort();
  assert.deepEqual(report.imported.sort(), names);
  for (const n of names) assert.equal((await other.store.get(n)).xml, await xmlOf(n));
  // importing again skips what exists unless overwrite is asked for
  const again = await other.importFiles([new File([zip], 'backup.zip')]);
  assert.deepEqual(again.skipped.sort(), names);
  const bad = await other.importFiles([new File(['not xml'], 'junk.bpmn')]);
  assert.equal(bad.failed.length, 1);
});

test('bpmn_rename keeps content and process id; bpmn_write_xml follows the new name', async () => {
  const before = await xmlOf('copy.bpmn');
  await call('bpmn_get_xml', { file: 'copy' });
  const r = await call('bpmn_rename', { file: 'copy', newName: 'копия заказа' });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.file, 'копия заказа.bpmn');
  assert.equal(await xmlOf('копия заказа'), before);
  assert.equal((await call('bpmn_rename', { file: 'nope', newName: 'x' })).isError, true);
  // the version read before the rename still counts for a write under the new name
  const w = await call('bpmn_write_xml', { file: 'копия заказа', xml: before.replace('</bpmn:process>', '</bpmn:process>'), open: false });
  assert.equal(w.isError, false, w.text);
});

test('the deploy path and body field come from the config', async () => {
  const { config, applyConfig } = await import('../src/config.js');
  const saved = structuredClone(config);
  try {
    applyConfig({ deploy: { path: '/custom/upload', field: 'schemaB64', targets: { here: FAKE } } });
    const own = createStudio({ adapter: new MemoryAdapter() });
    await own.store.save('d', await xmlOf('заказ.bpmn'));
    const res = await own.deploy('d', { target: 'here', force: true });
    assert.equal(res.url, `${FAKE}/custom/upload`);
    assert.ok(received.at(-1).body.schemaB64);
    assert.throws(() => applyConfig({ deploy: { field: 'a b' } }), /field/);
  } finally {
    applyConfig(saved);
  }
});
