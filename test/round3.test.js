// Regressions found in the third review round: Camunda 8 events, boundary containers, FEEL, names, imports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStudio } from '../web/assistant/core.js';
import { MemoryAdapter } from '../src/store.js';
import { specToXml } from '../src/bpmn.js';
import { checkXml } from '../src/lint.js';

const studio = createStudio({ adapter: new MemoryAdapter() });
const call = async (name, args) => {
  const r = await studio.assistantStudio.callTool(name, args);
  assert.equal(r.ok, true, r.error);
  return r.result;
};

test('Camunda 8: a message end event with a job worker is deployable (no invented message)', async () => {
  const r = await call('bpmn_create', { file: 'c8msg', processName: 'M', platform: 'camunda8', open: false,
    elements: [{ id: 'S', type: 'startEvent' }, { id: 'E', type: 'endEvent', eventDefinition: 'message', jobType: 'notify' }],
    flows: [{ from: 'S', to: 'E' }] });
  assert.deepEqual(r.deployErrors, []);
});

test('Camunda 8: a catch-all error boundary stays catch-all through edits', async () => {
  await call('bpmn_create', { file: 'c8err', processName: 'E', platform: 'camunda8', open: false,
    elements: [{ id: 'S', type: 'startEvent' }, { id: 'T', type: 'serviceTask', jobType: 'x' },
      { id: 'B', type: 'boundaryEvent', attachedTo: 'T', eventDefinition: 'error' },
      { id: 'E', type: 'endEvent' }, { id: 'E2', type: 'endEvent' }],
    flows: [{ from: 'S', to: 'T' }, { from: 'T', to: 'E' }, { from: 'B', to: 'E2' }] });
  const r = await call('bpmn_edit', { file: 'c8err', open: false, updateElements: [{ id: 'T', name: 'Do' }] });
  assert.deepEqual(r.deployErrors, []);
  assert.doesNotMatch((await studio.store.get('c8err')).xml, /<bpmn:error /);
});

test('a boundary event on a task inside a sub-process lands in the sub-process, also with lanes', async () => {
  const r = await call('bpmn_create', { file: 'nested', processName: 'N', platform: 'camunda7', open: false,
    lanes: [{ id: 'L1', name: 'A' }],
    elements: [{ id: 'S', type: 'startEvent', lane: 'L1' }, { id: 'Sub', type: 'subProcess', lane: 'L1' },
      { id: 'SS', type: 'startEvent', parent: 'Sub' }, { id: 'T', type: 'userTask', parent: 'Sub', assignee: 'a' },
      { id: 'TE', type: 'endEvent', parent: 'Sub' }, { id: 'B', type: 'boundaryEvent', attachedTo: 'T', eventDefinition: 'timer', timerValue: 'PT1H' },
      { id: 'BE', type: 'endEvent', parent: 'Sub' }, { id: 'E', type: 'endEvent', lane: 'L1' }],
    flows: [{ from: 'S', to: 'Sub' }, { from: 'SS', to: 'T' }, { from: 'T', to: 'TE' }, { from: 'B', to: 'BE' }, { from: 'Sub', to: 'E' }] });
  assert.deepEqual(r.deployErrors, []);
  const xml = (await studio.store.get('nested')).xml;
  assert.match(xml, /<bpmn:subProcess id="Sub"[\s\S]*<bpmn:boundaryEvent id="B"[\s\S]*<\/bpmn:subProcess>/);
});

test('Camunda 8 expressions get "=", Camunda 7 completion conditions get ${}', async () => {
  const base = { processName: 'F', elements: [{ id: 'S', type: 'startEvent' },
    { id: 'T', type: 'serviceTask', jobType: 'x', javaClass: 'a.B', multiInstance: { collection: 'items', element: 'item', completionCondition: 'done' }, inputs: [{ source: 'order.id', target: 'id' }] },
    { id: 'E', type: 'endEvent' }], flows: [{ from: 'S', to: 'T' }, { from: 'T', to: 'E' }] };
  const c8 = (await specToXml({ ...base, platform: 'camunda8' })).xml;
  assert.match(c8, /inputCollection="=items"/);
  assert.match(c8, /source="order.id"/, 'a source without "=" is a static value in Zeebe and stays one');
  assert.match(c8, /<bpmn:completionCondition[^>]*>=done</);
  const c7 = (await specToXml({ ...base, platform: 'camunda7' })).xml;
  assert.match(c7, /<bpmn:completionCondition[^>]*>\$\{done\}</);
  assert.deepEqual((await checkXml(c8)).deployErrors, []);
});

test('renaming an element with a message flow keeps the layout', async () => {
  await call('bpmn_create', { file: 'mf', processName: 'MF', platform: 'camunda7', open: false,
    externalPools: [{ id: 'Client', name: 'Клиент' }],
    elements: [{ id: 'S', type: 'startEvent' }, { id: 'T', type: 'sendTask', name: 'Send', javaClass: 'a.B' }, { id: 'E', type: 'endEvent' }],
    flows: [{ from: 'S', to: 'T' }, { from: 'T', to: 'E' }],
    messageFlows: [{ from: 'T', to: 'Client' }] });
  const r = await call('bpmn_edit', { file: 'mf', open: false, updateElements: [{ id: 'T', newId: 'Task_Send' }] });
  assert.equal(r.layout, 'kept');
});

test('message ids from the Camunda Modeler are kept through edits', async () => {
  const xml = (await specToXml({ processName: 'P', platform: 'camunda7',
    elements: [{ id: 'S', type: 'startEvent', eventDefinition: 'message', messageName: 'Order' }, { id: 'E', type: 'endEvent' }],
    flows: [{ from: 'S', to: 'E' }] })).xml.replace(/Message_Order/g, 'Message_0abc');
  await studio.importFiles([new File([xml], 'ids.bpmn')]);
  await call('bpmn_edit', { file: 'ids', open: false, updateElements: [{ id: 'E', name: 'Done' }] });
  const out = (await studio.store.get('ids')).xml;
  assert.match(out, /<bpmn:message id="Message_0abc" name="Order"/);
  assert.equal((out.match(/<bpmn:message /g) || []).length, 1);
});

test('names that differ only in letter case are refused (they would clash in the backup zip)', async () => {
  await studio.store.save('Order', (await studio.store.get('ids')).xml);
  await assert.rejects(studio.store.save('order', (await studio.store.get('ids')).xml), err => err.status === 409 && err.twin === 'Order.bpmn');
});

test('a BPMN file without a diagram section is laid out on import', async () => {
  const xml = '<?xml version="1.0"?><bpmn2:definitions xmlns:bpmn2="http://www.omg.org/spec/BPMN/20100524/MODEL" id="d" targetNamespace="x"><bpmn2:process id="P" isExecutable="true"><bpmn2:startEvent id="S"/><bpmn2:sequenceFlow id="f" sourceRef="S" targetRef="E"/><bpmn2:endEvent id="E"/></bpmn2:process></bpmn2:definitions>';
  const r = await studio.importFiles([new File([xml], 'nodi.bpmn')]);
  assert.deepEqual(r.imported, ['nodi.bpmn'], JSON.stringify(r.failed));
  assert.match((await studio.store.get('nodi')).xml, /BPMNDiagram/);
});

test('an existing pair "Order"/"order" (older data) can still be saved; only new twins are refused', async () => {
  const adapter = new MemoryAdapter();
  const s = createStudio({ adapter });
  const xml = (await studio.store.get('ids')).xml;
  // as if saved before the rule existed
  for (const name of ['Pair.bpmn', 'pair.bpmn']) adapter.records.set(name, { name, xml, hash: 'x', created: '', updated: '', undo: [], redo: [] });
  await s.store.save('Pair', xml.replace('Done', 'Done 2'));
  await s.store.save('pair', xml.replace('Done', 'Done 3'));
  await assert.rejects(s.store.save('PAIR', xml), err => err.status === 409);
});

test('an external-task error shared with a boundary event stays one error through edits', async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:camunda="http://camunda.org/schema/1.0/bpmn" xmlns:modeler="http://camunda.org/schema/modeler/1.0" id="D" targetNamespace="x" modeler:executionPlatform="Camunda Platform">
  <bpmn:error id="Error_1" name="Fail" errorCode="E1" />
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" /><bpmn:sequenceFlow id="f1" sourceRef="S" targetRef="T" />
    <bpmn:serviceTask id="T" camunda:type="external" camunda:topic="t">
      <bpmn:extensionElements><camunda:errorEventDefinition id="CE" errorRef="Error_1" expression="\${true}" /></bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:boundaryEvent id="B" attachedToRef="T"><bpmn:errorEventDefinition errorRef="Error_1" /></bpmn:boundaryEvent>
    <bpmn:sequenceFlow id="f2" sourceRef="T" targetRef="E" /><bpmn:sequenceFlow id="f3" sourceRef="B" targetRef="E" />
    <bpmn:endEvent id="E" />
  </bpmn:process>
</bpmn:definitions>`;
  await studio.importFiles([new File([xml], 'shared-error.bpmn')]);
  for (let i = 0; i < 2; i++) await call('bpmn_edit', { file: 'shared-error', open: false, updateElements: [{ id: 'T', name: `Run ${i}` }] });
  const out = (await studio.store.get('shared-error')).xml;
  assert.equal((out.match(/<bpmn:error /g) || []).length, 1, out);
  assert.match(out, /camunda:errorEventDefinition[^>]*errorRef="Error_1"/);
});

test('an unnamed message keeps its id and stays unnamed', async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0" xmlns:modeler="http://camunda.org/schema/modeler/1.0" id="D" targetNamespace="x" modeler:executionPlatform="Camunda Cloud">
  <bpmn:message id="Message_0abc" />
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" /><bpmn:sequenceFlow id="f1" sourceRef="S" targetRef="E" />
    <bpmn:endEvent id="E"><bpmn:messageEventDefinition messageRef="Message_0abc" /></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;
  await studio.importFiles([new File([xml], 'unnamed.bpmn')]);
  await call('bpmn_edit', { file: 'unnamed', open: false, processName: 'U' });
  const out = (await studio.store.get('unnamed')).xml;
  assert.match(out, /<bpmn:message id="Message_0abc" \/>/);
  assert.match(out, /messageRef="Message_0abc"/);
});

test('a file with lanes but no diagram section keeps its lanes on import', async () => {
  const { xml } = await specToXml({ processName: 'L', platform: 'camunda7', lanes: [{ id: 'L1', name: 'A' }, { id: 'L2', name: 'B' }],
    elements: [{ id: 'S', type: 'startEvent', lane: 'L1' }, { id: 'T', type: 'userTask', lane: 'L2', assignee: 'x' }, { id: 'E', type: 'endEvent', lane: 'L2' }],
    flows: [{ from: 'S', to: 'T' }, { from: 'T', to: 'E' }] });
  const noDi = xml.replace(/<bpmndi:BPMNDiagram[\s\S]*<\/bpmndi:BPMNDiagram>/, '<!-- <bpmndi:BPMNDiagram> was here -->');
  const r = await studio.importFiles([new File([noDi], 'lanes-nodi.bpmn')]);
  assert.deepEqual(r.failed, []);
  const out = (await studio.store.get('lanes-nodi')).xml;
  assert.match(out, /<bpmndi:BPMNShape id="L1_di"/);
  assert.match(out, /<bpmndi:BPMNShape id="T_di"/);
});
