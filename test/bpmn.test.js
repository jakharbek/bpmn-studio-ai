import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { applyEdits, parseXml, sameStructure, specToXml, xmlToSpec } from '../src/bpmn.js';
import { lintXml } from '../src/lint.js';
import { scenarios } from './scenarios.js';

const require = createRequire(import.meta.url);
const XSD = join(require.resolve('bpmn-moddle/package.json'), '..', 'resources/bpmn/xsd/BPMN20.xsd');
const tmp = mkdtempSync(join(tmpdir(), 'bpmn-test-'));

function hasXmllint() {
  try { execFileSync('xmllint', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

const sortById = arr => [...arr].sort((a, b) => (a.id + a.from + a.to).localeCompare(b.id + b.from + b.to));
const normalized = spec => ({ ...spec, elements: sortById(spec.elements), flows: sortById(spec.flows) });

// Lint findings that are expected in specific scenarios (test data, not generator bugs).
const EXPECTED_WARNINGS = { timerSignal: [/timer-past-date/] };

for (const [name, spec] of Object.entries(scenarios)) {
  test(`${name}: passes Camunda Modeler lint`, async () => {
    const { xml, warnings } = await specToXml(spec);
    assert.deepEqual(warnings, []);
    const lint = await lintXml(xml);
    assert.deepEqual(lint.errors, [], lint.errors.join('\n'));
    const unexpected = lint.warnings.filter(w => !(EXPECTED_WARNINGS[name] || []).some(re => re.test(w)));
    assert.deepEqual(unexpected, []);
  });

  test(`${name}: valid against BPMN 2.0 XSD`, { skip: !hasXmllint() && 'xmllint not installed' }, async () => {
    const { xml } = await specToXml(spec);
    const file = join(tmp, `${name}.bpmn`);
    writeFileSync(file, xml);
    execFileSync('xmllint', ['--noout', '--schema', XSD, file], { stdio: 'pipe' });
  });

  test(`${name}: round-trip is lossless and reaches a fixpoint`, async () => {
    const { xml: xml1 } = await specToXml(spec);
    const r1 = await xmlToSpec(xml1);
    assert.deepEqual(r1.lossy, []);
    assert.deepEqual(r1.warnings, []);
    const { xml: xml2 } = await specToXml(r1.spec);
    const r2 = await xmlToSpec(xml2);
    const { xml: xml3 } = await specToXml(r2.spec);
    assert.equal(xml3, xml2);
    assert.deepEqual(normalized(r2.spec), normalized(r1.spec));
  });

  test(`${name}: every element and flow has DI`, async () => {
    const { xml } = await specToXml(spec);
    const { definitions } = await parseXml(xml);
    const diIds = new Set(definitions.diagrams[0].plane.planeElement.map(d => d.bpmnElement.id));
    const { spec: back } = await xmlToSpec(xml);
    const parts = [...back.elements, ...back.flows, ...(back.lanes || []), ...(back.externalPools || []), ...(back.messageFlows || [])];
    if (back.pool) parts.push(back.pool);
    for (const e of parts) assert.ok(diIds.has(e.id), `missing DI for ${e.id}`);
  });
}

test('cyrillic ids are transliterated and unique', async () => {
  const { xml } = await specToXml(scenarios.cyrillicIds);
  const { spec } = await xmlToSpec(xml);
  assert.deepEqual(spec.elements.map(e => e.id), ['Start', 'Zadacha_odin', 'Zadacha_dva', 'Soobschenie', 'Soobschenie2', 'Konets']);
  const ids = [...xml.matchAll(/ id="([^"]+)"/g)].map(m => m[1]);
  assert.equal(new Set(ids).size, ids.length, 'duplicate ids in XML');
  assert.match(xml, /<bpmn:signal id="Signal_Alfa" name="Альфа"/);
  assert.match(xml, /<bpmn:signal id="Signal_Beta" name="Бета"/);
});

test('event sub-processes are placed below the main flow', async () => {
  const { xml } = await specToXml(scenarios.eventSub);
  const { definitions } = await parseXml(xml);
  const shapes = new Map(definitions.diagrams[0].plane.planeElement
    .filter(d => d.bounds).map(d => [d.bpmnElement.id, d.bounds]));
  const mainBottom = Math.max(...['Start', 'Task_Score', 'Gateway_Kyc', 'End_Ok', 'End_Fraud'].map(id => shapes.get(id).y + shapes.get(id).height));
  for (const id of ['ESub_Error', 'ESub_Msg']) assert.ok(shapes.get(id).y > mainBottom, `${id} overlaps main flow`);
  // start event of the main flow is directly followed by the first task (no gap from event sub-processes)
  assert.ok(shapes.get('Task_Score').x - shapes.get('Start').x < 200);
  // children inside their event sub-process box
  for (const [child, parent] of [['Task_Block', 'ESub_Error'], ['Task_Status', 'ESub_Msg']]) {
    const c = shapes.get(child), p = shapes.get(parent);
    assert.ok(c.x > p.x && c.y > p.y && c.x + c.width < p.x + p.width && c.y + c.height < p.y + p.height, `${child} outside ${parent}`);
  }
});

test('Camunda 8 specifics', async () => {
  const { xml } = await specToXml(scenarios.eventSub);
  assert.match(xml, /modeler:executionPlatform="Camunda Cloud"/);
  assert.match(xml, /<zeebe:calledDecision decisionId="scoring" resultVariable="score"/);
  assert.match(xml, /<zeebe:script expression="=score \* 1000" resultVariable="limit"/);
  assert.match(xml, /<zeebe:calledElement processId="kyc-process" propagateAllChildVariables="true"/);
  assert.match(xml, /conditionExpression xsi:type="bpmn:tFormalExpression">=kycPassed</);
  assert.match(xml, /<zeebe:subscription correlationKey="=applicationId"/);
  assert.match(xml, /isInterrupting="false"/);
});

test('Camunda 7 specifics', async () => {
  const { xml } = await specToXml(scenarios.camunda7);
  assert.match(xml, /modeler:executionPlatform="Camunda Platform"/);
  assert.match(xml, /camunda:historyTimeToLive="180"/);
  assert.match(xml, /camunda:type="external" camunda:topic="hr-order"/);
  assert.match(xml, />\$\{approved\}</);
  assert.match(xml, />\$\{!approved\}</);
  assert.match(xml, /camunda:formKey="embedded:app:forms\/start.html"/);
});

test('lint reports deploy errors for incomplete Camunda 8 models', async () => {
  const { xml } = await specToXml({
    processName: 'Bad', platform: 'camunda8', elements: [
      { id: 'S', type: 'startEvent', name: 's' }, { id: 'T', type: 'serviceTask', name: 't' },
      { id: 'M', type: 'intermediateCatchEvent', name: 'm', eventDefinition: 'message', messageName: 'm' },
      { id: 'E', type: 'endEvent', name: 'e', eventDefinition: 'error' }
    ],
    flows: [{ from: 'S', to: 'T' }, { from: 'T', to: 'M' }, { from: 'M', to: 'E' }]
  });
  const { errors } = await lintXml(xml);
  assert.ok(errors.some(e => e.includes('camunda-compat/implementation') && e.includes('T:')));
  assert.ok(errors.some(e => e.includes('camunda-compat/subscription')));
  assert.ok(errors.some(e => e.includes('camunda-compat/error-reference')));
});

test('edits: insert, update, rename, remove, flows', async () => {
  const { spec } = await xmlToSpec((await specToXml(scenarios.camunda7)).xml);
  const { spec: s1, log } = applyEdits(spec, {
    insertBetween: [{ from: 'Task_Approve', to: 'Gateway', element: { id: 'Task_Log', type: 'serviceTask', name: 'Записать в журнал', jobType: 'log' } }],
    updateElements: [{ id: 'Task_Notify', name: 'Сообщить сотруднику', delegateExpression: null, jobType: 'notify' }, { id: 'End_No', newId: 'End_Rejected' }],
    updateFlows: [{ from: 'Gateway', to: 'Task_Book', set: { name: 'Одобрено' } }]
  });
  assert.equal(log.length, 4);
  const { xml } = await specToXml(s1);
  const { spec: s2 } = await xmlToSpec(xml);
  const el = id => s2.elements.find(e => e.id === id);
  const has = (from, to) => s2.flows.some(f => f.from === from && f.to === to);
  assert.ok(has('Task_Approve', 'Task_Log') && has('Task_Log', 'Gateway') && !has('Task_Approve', 'Gateway'));
  assert.equal(el('Task_Notify').name, 'Сообщить сотруднику');
  assert.equal(el('Task_Notify').delegateExpression, undefined);
  assert.equal(el('Task_Notify').jobType, 'notify');
  assert.ok(el('End_Rejected') && !el('End_No') && has('Task_Notify', 'End_Rejected'));
  assert.equal(s2.flows.find(f => f.to === 'Task_Book').name, 'Одобрено');

  // removing a sub-process removes children, attached boundary events and their flows
  const { spec: o } = await xmlToSpec((await specToXml(scenarios.order)).xml);
  const { spec: o2 } = applyEdits(o, { removeElements: ['Sub_Delivery', 'Task_Approve'] });
  for (const id of ['Sub_Start', 'Task_Ship', 'Sub_End', 'Timer_Approve']) assert.ok(!o2.elements.some(e => e.id === id));
  assert.ok(!o2.flows.some(f => ['Sub_Delivery', 'Task_Approve', 'Timer_Approve'].includes(f.from)));

  assert.throws(() => applyEdits(spec, { removeElements: ['Nope'] }), /not found/);
  assert.throws(() => applyEdits(spec, { addElements: [{ id: 'Start', type: 'task' }] }), /already exists/);
});

test('invalid specs fail with a clear message', async () => {
  await assert.rejects(specToXml({ elements: [{ id: 'A', type: 'foo' }], flows: [] }), /Unknown element type/);
  await assert.rejects(specToXml({ elements: [{ id: 'A', type: 'task' }], flows: [{ from: 'A', to: 'B' }] }), /target "B" not found/);
  await assert.rejects(specToXml({ elements: [{ id: 'A', type: 'task' }, { id: 'A', type: 'task' }], flows: [] }), /Duplicate element id/);
  await assert.rejects(specToXml({ elements: [{ id: 'B', type: 'boundaryEvent' }], flows: [] }), /needs attachedTo/);
  await assert.rejects(specToXml({
    elements: [{ id: 'P', type: 'subProcess' }, { id: 'A', type: 'task', parent: 'P' }, { id: 'B', type: 'task' }],
    flows: [{ from: 'A', to: 'B' }]
  }), /different containers/);
});

test('content the spec cannot represent is reported as lossy', async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
  xmlns:modeler="http://camunda.org/schema/modeler/1.0" id="D" targetNamespace="http://bpmn.io/schema/bpmn" modeler:executionPlatform="Camunda Cloud" modeler:executionPlatformVersion="8.8.0">
  <bpmn:collaboration id="C"><bpmn:participant id="P" processRef="Proc" /><bpmn:participant id="P2" processRef="Other" /></bpmn:collaboration>
  <bpmn:process id="Other"><bpmn:task id="OtherTask" /></bpmn:process>
  <bpmn:process id="Proc" isExecutable="true">
    <bpmn:laneSet id="LS"><bpmn:lane id="L1"><bpmn:childLaneSet id="CLS"><bpmn:lane id="L1a" /></bpmn:childLaneSet></bpmn:lane></bpmn:laneSet>
    <bpmn:startEvent id="S" />
    <bpmn:serviceTask id="T"><bpmn:extensionElements><zeebe:taskDefinition type="x" /><zeebe:executionListeners /></bpmn:extensionElements></bpmn:serviceTask>
    <bpmn:dataObjectReference id="DO" dataObjectRef="DObj" /><bpmn:dataObject id="DObj" />
    <bpmn:textAnnotation id="A"><bpmn:text>note</bpmn:text></bpmn:textAnnotation>
    <bpmn:sequenceFlow id="F" sourceRef="S" targetRef="T" />
  </bpmn:process>
</bpmn:definitions>`;
  const { spec, lossy } = await xmlToSpec(xml);
  assert.equal(spec.elements.find(e => e.id === 'T').jobType, 'x');
  const text = lossy.join('\n');
  for (const needle of ['P2 with its own process', 'nested lanes', 'DO (bpmn:DataObjectReference)', 'A (bpmn:TextAnnotation)']) {
    assert.ok(text.includes(needle), `expected lossy entry for ${needle}:\n${text}`);
  }
});

// ---------------------------------------------------------------- pools & lanes

const shapesOf = async xml => {
  const { definitions } = await parseXml(xml);
  return new Map(definitions.diagrams[0].plane.planeElement.map(d => [d.bpmnElement.id, d]));
};
const inside = (c, p) => c.x >= p.x && c.y >= p.y && c.x + c.width <= p.x + p.width && c.y + c.height <= p.y + p.height;

test('lanes: every element sits inside its lane, lanes fill the pool', async () => {
  const { xml } = await specToXml(scenarios.loanLanes);
  const di = await shapesOf(xml);
  const { spec } = await xmlToSpec(xml);
  const pool = di.get(spec.pool.id).bounds;
  let y = pool.y;
  for (const lane of spec.lanes) {
    const lb = di.get(lane.id).bounds;
    assert.equal(lb.y, y, `${lane.id} not stacked`);
    assert.equal(lb.x + lb.width, pool.x + pool.width);
    y += lb.height;
  }
  assert.equal(y, pool.y + pool.height);
  for (const e of spec.elements) {
    const lane = e.type === 'boundaryEvent' ? spec.elements.find(h => h.id === e.attachedTo).lane : e.lane;
    if (e.type === 'boundaryEvent') continue; // straddles the host border by design
    assert.ok(inside(di.get(e.id).bounds, di.get(lane).bounds), `${e.id} outside ${lane}`);
  }
  // lane inferred from the predecessor
  assert.equal(spec.elements.find(e => e.id === 'End_Rejected').lane, 'Lane_Manager');
  // external pools above / below
  assert.ok(di.get('Pool_Client').bounds.y + di.get('Pool_Client').bounds.height < pool.y);
  assert.ok(di.get('Pool_Bureau').bounds.y > pool.y + pool.height);
});

test('lanes: message flows do not cross other shapes', async () => {
  const { xml } = await specToXml(scenarios.loanLanes);
  const di = await shapesOf(xml);
  const { spec } = await xmlToSpec(xml);
  const shapes = spec.elements.map(e => ({ id: e.id, b: di.get(e.id).bounds }));
  for (const f of spec.messageFlows) {
    const pts = di.get(f.id).waypoint;
    const skip = new Set([f.from, f.to, ...spec.elements.filter(e => e.attachedTo === f.from || e.attachedTo === f.to).map(e => e.id)]);
    for (let i = 1; i < pts.length; i++) {
      const [a, b] = [pts[i - 1], pts[i]];
      for (const { id, b: s } of shapes) {
        if (skip.has(id)) continue;
        const hit = Math.max(a.x, b.x) > s.x && Math.min(a.x, b.x) < s.x + s.width && Math.max(a.y, b.y) > s.y && Math.min(a.y, b.y) < s.y + s.height;
        assert.ok(!hit, `${f.id} crosses ${id}`);
      }
    }
  }
});

test('lanes: edits', async () => {
  const { xml } = await specToXml(scenarios.loanLanes);
  const { spec } = await xmlToSpec(xml);

  // rename + reorder keep elements, remove re-assigns
  const { spec: s1 } = applyEdits(spec, {
    lanes: [{ id: 'Lane_Back', name: 'Операционный отдел' }, { id: 'Lane_Manager', name: 'Менеджер' }],
    updateElements: [{ id: 'Task_Score', lane: 'Lane_Back' }]
  });
  const { xml: x1 } = await specToXml(s1);
  const { spec: r1 } = await xmlToSpec(x1);
  assert.deepEqual(r1.lanes.map(l => l.name), ['Операционный отдел', 'Менеджер']);
  assert.equal(r1.elements.find(e => e.id === 'Task_Score').lane, 'Lane_Back');
  // Task_Request was in the removed Risk lane: inferred from its predecessor (manager lane)
  assert.equal(r1.elements.find(e => e.id === 'Task_Request').lane, 'Lane_Manager');
  const di = await shapesOf(x1);
  assert.ok(inside(di.get('Task_Score').bounds, di.get('Lane_Back').bounds));

  // removing an external pool drops its message flows
  const { spec: s2 } = applyEdits(r1, { externalPools: [{ id: 'Pool_Client', name: 'Клиент' }] });
  assert.ok(!s2.messageFlows.some(f => f.from === 'Pool_Bureau' || f.to === 'Pool_Bureau'));
  assert.equal(s2.messageFlows.length, 3);

  assert.throws(() => applyEdits(r1, { pool: null }), /cannot remove the pool/);
  await assert.rejects(specToXml({ ...spec, messageFlows: [{ from: 'Task_Check', to: 'Task_Score' }] }), /same pool/);
  await assert.rejects(specToXml({ ...spec, elements: [...spec.elements, { id: 'X', type: 'task', lane: 'Nope' }] }), /lane "Nope" not found/);
});

test('lanes: renaming a lane keeps positions, moving an element re-lays out', async () => {
  const { xml } = await specToXml(scenarios.loanLanes);
  const { spec } = await xmlToSpec(xml);
  const { spec: renamed } = applyEdits(spec, { lanes: spec.lanes.map(l => ({ ...l, name: l.name + '!' })) });
  assert.ok(sameStructure(spec, renamed));
  const { spec: moved } = applyEdits(spec, { updateElements: [{ id: 'Task_Score', lane: 'Lane_Back' }] });
  assert.ok(!sameStructure(spec, moved));
});

test('pool without lanes, and a pool drawn in bpmn-js (empty process per pool)', async () => {
  const { xml } = await specToXml({ ...scenarios.camunda7, pool: { name: 'Компания' } });
  const { spec, lossy } = await xmlToSpec(xml);
  assert.deepEqual(lossy, []);
  assert.equal(spec.pool.name, 'Компания');
  assert.deepEqual((await lintXml(xml)).errors, []);

  const drawn = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="D" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:collaboration id="C">
    <bpmn:participant id="Main" name="Мы" processRef="P1" />
    <bpmn:participant id="Ext" name="Партнёр" processRef="P2" />
    <bpmn:messageFlow id="M1" sourceRef="T" targetRef="Ext" />
  </bpmn:collaboration>
  <bpmn:process id="P2" />
  <bpmn:process id="P1" isExecutable="true">
    <bpmn:startEvent id="S" /><bpmn:task id="T" /><bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="T" /><bpmn:sequenceFlow id="F2" sourceRef="T" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;
  const r = await xmlToSpec(drawn);
  assert.deepEqual(r.lossy, []);
  assert.equal(r.spec.processId, 'P1');
  assert.deepEqual(r.spec.externalPools, [{ id: 'Ext', name: 'Партнёр' }]);
  assert.deepEqual(r.spec.messageFlows, [{ id: 'M1', from: 'T', to: 'Ext' }]);
});

// ---------------------------------------------------------------- Camunda 7 defaults (bpmn-studio.config.json)

test('new diagrams default to Camunda 7 (7.24) and are checked with the nearest rule set', async () => {
  const { compatConfigName } = await import('../src/lint.js');
  const { xml } = await specToXml({
    processName: 'C7', elements: [
      { id: 'S', type: 'startEvent', name: 's' },
      { id: 'T', type: 'serviceTask', name: 't', jobType: 'topic-a' },
      { id: 'E', type: 'endEvent', name: 'e' }
    ],
    flows: [{ from: 'S', to: 'T' }, { from: 'T', to: 'E' }]
  });
  assert.match(xml, /modeler:executionPlatform="Camunda Platform" modeler:executionPlatformVersion="7.24.0"/);
  assert.match(xml, /camunda:type="external" camunda:topic="topic-a"/);
  const lint = await lintXml(xml);
  assert.ok(lint.config.some(c => c.startsWith('plugin:camunda-compat/camunda-platform-7-')), lint.config.join());
  // a version without its own rule set (e.g. 7.18) is checked with the nearest one
  assert.equal(compatConfigName('camunda7', '7.18.0'), 'camunda-platform-7-19');
  assert.deepEqual(lint.errors, []);
  assert.equal(compatConfigName('camunda7', '7.23.0'), 'camunda-platform-7-23');
  assert.equal(compatConfigName('camunda8', '8.8.0'), 'camunda-cloud-8-8');
});

test('plain BPMN from the old modeler (no engine extensions) is read as Camunda 7', async () => {
  const old = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn2:definitions xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:bpmn2="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" id="sample-diagram" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn2:process id="Process_1" isExecutable="false">
    <bpmn2:startEvent id="StartEvent_1"/>
  </bpmn2:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Process_1">
      <bpmndi:BPMNShape id="_BPMNShape_StartEvent_2" bpmnElement="StartEvent_1"><dc:Bounds height="36.0" width="36.0" x="412.0" y="240.0"/></bpmndi:BPMNShape>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn2:definitions>`;
  const { spec, lossy } = await xmlToSpec(old);
  assert.deepEqual(lossy, []);
  assert.equal(spec.platform, 'camunda7');
});

test('Camunda 7 engine parse errors are reported as deploy errors', async () => {
  const { checkXml } = await import('../src/lint.js');
  const { xml } = await specToXml({
    processName: 'Bad C7', platform: 'camunda7', isExecutable: false, elements: [
      { id: 'S', type: 'startEvent', name: 's' },
      { id: 'Svc', type: 'serviceTask', name: 'svc' },
      { id: 'Scr', type: 'scriptTask', name: 'scr' },
      { id: 'Call', type: 'callActivity', name: 'call' },
      { id: 'Err', type: 'endEvent', name: 'err', eventDefinition: 'error', errorName: 'Oops' }
    ],
    flows: [{ from: 'S', to: 'Svc' }, { from: 'Svc', to: 'Scr' }, { from: 'Scr', to: 'Call' }, { from: 'Call', to: 'Err' }]
  });
  const { deployErrors } = await checkXml(xml);
  for (const needle of ['[camunda7/executable-process]', '[camunda7/implementation] Svc', '[camunda7/script] Scr', '[camunda7/called-element] Call', '[camunda7/error-reference] Err']) {
    assert.ok(deployErrors.some(e => e.startsWith(needle)), `missing ${needle}:\n${deployErrors.join('\n')}`);
  }
});

// ---------------------------------------------------------------- Camunda 7 content of the legacy properties panel

const LEGACY_C7 = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn2:definitions xmlns:bpmn2="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:camunda="http://camunda.org/schema/1.0/bpmn" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" id="Definitions_x" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn2:process id="Process_leg" name="Заявка" isExecutable="true" camunda:versionTag="v3" camunda:historyTimeToLive="30">
    <bpmn2:startEvent id="Start" name="Заявка подана">
      <bpmn2:extensionElements>
        <camunda:formData businessKey="requestId">
          <camunda:formField id="requestId" label="Номер" type="string" />
          <camunda:formField id="amount" label="Сумма" type="long" defaultValue="0">
            <camunda:validation><camunda:constraint name="required" /><camunda:constraint name="min" config="1" /></camunda:validation>
          </camunda:formField>
          <camunda:formField id="kind" label="Вид" type="enum">
            <camunda:value id="a" name="Аванс" /><camunda:value id="b" name="Командировка" />
          </camunda:formField>
        </camunda:formData>
      </bpmn2:extensionElements>
      <bpmn2:outgoing>F1</bpmn2:outgoing>
    </bpmn2:startEvent>
    <bpmn2:userTask id="Approve" name="Согласовать" camunda:assignee="boss" camunda:asyncBefore="true" camunda:jobPriority="50" camunda:dueDate="\${due}">
      <bpmn2:extensionElements>
        <camunda:executionListener class="com.acme.AuditListener" event="start" />
        <camunda:taskListener delegateExpression="\${notify}" event="create" />
        <camunda:inputOutput><camunda:inputParameter name="limit">100</camunda:inputParameter></camunda:inputOutput>
        <camunda:formData><camunda:formField id="approved" label="Одобрено" type="boolean" /></camunda:formData>
      </bpmn2:extensionElements>
      <bpmn2:incoming>F1</bpmn2:incoming><bpmn2:outgoing>F2</bpmn2:outgoing>
    </bpmn2:userTask>
    <bpmn2:exclusiveGateway id="Gw" name="Одобрено?"><bpmn2:incoming>F2</bpmn2:incoming><bpmn2:outgoing>F3</bpmn2:outgoing><bpmn2:outgoing>F4</bpmn2:outgoing></bpmn2:exclusiveGateway>
    <bpmn2:serviceTask id="Pay" name="Выплатить" camunda:class="com.acme.Pay">
      <bpmn2:extensionElements><camunda:field name="account"><camunda:string>main</camunda:string></camunda:field></bpmn2:extensionElements>
      <bpmn2:incoming>F3</bpmn2:incoming><bpmn2:outgoing>F5</bpmn2:outgoing>
    </bpmn2:serviceTask>
    <bpmn2:endEvent id="EndOk" name="Выплачено"><bpmn2:incoming>F5</bpmn2:incoming></bpmn2:endEvent>
    <bpmn2:endEvent id="EndNo" name="Отказ"><bpmn2:incoming>F4</bpmn2:incoming></bpmn2:endEvent>
    <bpmn2:sequenceFlow id="F1" sourceRef="Start" targetRef="Approve" />
    <bpmn2:sequenceFlow id="F2" sourceRef="Approve" targetRef="Gw" />
    <bpmn2:sequenceFlow id="F3" name="Да" sourceRef="Gw" targetRef="Pay"><bpmn2:conditionExpression xsi:type="bpmn2:tFormalExpression" language="javascript">approved == true</bpmn2:conditionExpression></bpmn2:sequenceFlow>
    <bpmn2:sequenceFlow id="F4" name="Нет" sourceRef="Gw" targetRef="EndNo"><bpmn2:conditionExpression xsi:type="bpmn2:tFormalExpression">\${!approved}</bpmn2:conditionExpression></bpmn2:sequenceFlow>
    <bpmn2:sequenceFlow id="F5" sourceRef="Pay" targetRef="EndOk" />
  </bpmn2:process>
</bpmn2:definitions>`;

test('legacy C7: generated task forms are part of the spec', async () => {
  const { spec, lossy } = await xmlToSpec(LEGACY_C7);
  assert.deepEqual(lossy, []);
  const start = spec.elements.find(e => e.id === 'Start');
  assert.equal(start.formBusinessKey, 'requestId');
  assert.deepEqual(start.formFields.find(f => f.id === 'amount'), { id: 'amount', label: 'Сумма', type: 'long', defaultValue: '0', validation: [{ name: 'required' }, { name: 'min', config: '1' }] });
  assert.deepEqual(start.formFields.find(f => f.id === 'kind').values, [{ id: 'a', name: 'Аванс' }, { id: 'b', name: 'Командировка' }]);
  assert.equal(spec.historyTimeToLive, '30');
  assert.equal(spec.flows.find(f => f.id === 'F3').conditionLanguage, 'javascript');
});

test('legacy C7: an edit keeps listeners, I/O, async, field injections, version tag, script conditions', async () => {
  const { spec } = await xmlToSpec(LEGACY_C7);
  const { spec: next } = applyEdits(spec, {
    updateElements: [{ id: 'Approve', name: 'Согласовать заявку', formFields: [{ id: 'approved', label: 'Одобрено', type: 'boolean' }, { id: 'comment', label: 'Комментарий' }] }],
    insertBetween: [{ from: 'Pay', to: 'EndOk', element: { id: 'Notify', type: 'serviceTask', name: 'Уведомить', jobType: 'notify' } }]
  });
  const { xml } = await specToXml(next, { previousXml: LEGACY_C7 });
  for (const needle of [
    'camunda:versionTag="v3"', 'camunda:historyTimeToLive="30"',
    'camunda:asyncBefore="true"', 'camunda:jobPriority="50"', 'camunda:dueDate="${due}"',
    '<camunda:executionListener class="com.acme.AuditListener" event="start"', '<camunda:taskListener delegateExpression="${notify}" event="create"',
    '<camunda:inputParameter name="limit">100</camunda:inputParameter>',
    '<camunda:field name="account">', '<camunda:string>main</camunda:string>',
    'language="javascript">approved == true<', '>${!approved}<',
    '<camunda:formField id="comment" label="Комментарий" type="string"', 'camunda:class="com.acme.Pay"'
  ]) assert.ok(xml.includes(needle), `lost: ${needle}`);
  // the edited form replaced the old one instead of being duplicated
  assert.equal((xml.match(/<camunda:formData>/g) || []).length + (xml.match(/<camunda:formData businessKey/g) || []).length, 2);
  const lint = await lintXml(xml);
  assert.deepEqual(lint.errors, [], lint.errors.join('\n'));
  // removing spec-owned values still works
  const { spec: s2 } = await xmlToSpec(xml);
  const { spec: s3 } = applyEdits(s2, { updateElements: [{ id: 'Approve', assignee: null, formFields: null }] });
  const { xml: x3 } = await specToXml(s3, { previousXml: xml });
  assert.ok(!x3.includes('camunda:assignee="boss"'));
  assert.ok(!/<camunda:formField id="approved"/.test(x3));
  assert.ok(x3.includes('camunda:asyncBefore="true"'));
});

test('generated task forms from the spec pass the Camunda 7 checks', async () => {
  const { xml } = await specToXml({
    processName: 'Форма', platform: 'camunda7', elements: [
      { id: 'S', type: 'startEvent', name: 's', formFields: [{ id: 'name', label: 'Имя', validation: [{ name: 'required' }] }] },
      { id: 'U', type: 'userTask', name: 'u', formFields: [{ id: 'level', type: 'enum', values: [{ id: 'low', name: 'Низкий' }, { id: 'high' }] }] },
      { id: 'E', type: 'endEvent', name: 'e' }
    ],
    flows: [{ from: 'S', to: 'U' }, { from: 'U', to: 'E' }]
  });
  assert.match(xml, /<camunda:formField id="level" type="enum">\s*<camunda:value id="low" name="Низкий" \/>\s*<camunda:value id="high" name="high" \/>/);
  assert.deepEqual((await lintXml(xml)).errors, []);
  await assert.rejects(specToXml({ processName: 'x', platform: 'camunda7', elements: [{ id: 'U', type: 'userTask', formFields: [{ id: 'k', type: 'enum' }] }], flows: [] }), /needs values/);
});
