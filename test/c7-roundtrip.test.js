// Camunda 7 content the spec does not model must survive bpmn_edit (xmlToSpec → applyEdits → specToXml).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStudio } from '../web/assistant/core.js';
import { MemoryAdapter } from '../src/store.js';
import { validateXml } from '../src/bpmn.js';

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" xmlns:camunda="http://camunda.org/schema/1.0/bpmn" xmlns:modeler="http://camunda.org/schema/modeler/1.0" id="D" targetNamespace="http://bpmn.io/schema/bpmn" modeler:executionPlatform="Camunda Platform" modeler:executionPlatformVersion="7.24.0">
  <bpmn:error id="Error_1" name="Card declined" errorCode="DECLINED" />
  <bpmn:process id="p" isExecutable="true" camunda:historyTimeToLive="180">
    <bpmn:startEvent id="S" camunda:initiator="starter" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="Script" />
    <bpmn:scriptTask id="Script" name="Script" scriptFormat="groovy" camunda:resource="classpath://calc.groovy" camunda:resultVariable="sum" />
    <bpmn:sequenceFlow id="F2" sourceRef="Script" targetRef="T" />
    <bpmn:serviceTask id="T" name="Charge" camunda:asyncBefore="true" camunda:type="external" camunda:topic="charge">
      <bpmn:extensionElements>
        <camunda:executionListener class="org.Audit" event="start" />
        <camunda:errorEventDefinition id="CE" errorRef="Error_1" expression="\${true}" />
      </bpmn:extensionElements>
      <bpmn:multiInstanceLoopCharacteristics camunda:collection="\${items}" camunda:elementVariable="item" camunda:asyncBefore="true">
        <bpmn:extensionElements><camunda:failedJobRetryTimeCycle>R5/PT1M</camunda:failedJobRetryTimeCycle></bpmn:extensionElements>
      </bpmn:multiInstanceLoopCharacteristics>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="F3" sourceRef="T" targetRef="G" />
    <bpmn:exclusiveGateway id="G" default="F5" />
    <bpmn:sequenceFlow id="F4" sourceRef="G" targetRef="Loop">
      <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" language="groovy" camunda:resource="cond.groovy" />
    </bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="F5" sourceRef="G" targetRef="Rule">
      <bpmn:extensionElements><camunda:executionListener class="org.Take" event="take" /></bpmn:extensionElements>
    </bpmn:sequenceFlow>
    <bpmn:userTask id="Loop" name="Loop" camunda:assignee="demo"><bpmn:standardLoopCharacteristics /></bpmn:userTask>
    <bpmn:sequenceFlow id="F6" sourceRef="Loop" targetRef="Rule" />
    <bpmn:businessRuleTask id="Rule" name="Rule" camunda:decisionRef="d1" camunda:resultVariable="verdict" camunda:mapDecisionResult="singleEntry" />
    <bpmn:sequenceFlow id="F7" sourceRef="Rule" targetRef="E" />
    <bpmn:endEvent id="E" name="Notify">
      <bpmn:messageEventDefinition id="E_ed" camunda:class="org.Notify" />
    </bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

const studio = createStudio({ adapter: new MemoryAdapter() });
const edit = async args => {
  const res = await studio.assistantStudio.callTool('bpmn_edit', { file: 'c7', open: false, relayout: true, ...args });
  assert.equal(res.ok, true, res.error);
  return (await studio.store.get('c7')).xml;
};

test('import with auto layout', async () => {
  const r = await studio.assistantStudio.callTool('bpmn_write_xml', { file: 'c7', xml: XML, autoLayout: true, open: false });
  assert.equal(r.ok, true, r.error);
});

test('everything survives an unrelated edit, a rename and an insert', async () => {
  await edit({ updateElements: [{ id: 'Script', name: 'Посчитать' }] });
  await edit({ updateElements: [{ id: 'T', newId: 'Task_Charge' }] });
  const xml = await edit({ insertBetween: [{ from: 'Rule', to: 'E', element: { id: 'Log', type: 'serviceTask', name: 'Log', jobType: 'log' } }] });
  const checks = {
    initiator: /camunda:initiator="starter"/,
    'script resultVariable': /id="Script"[^>]*camunda:resultVariable="sum"|camunda:resultVariable="sum"[^>]*id="Script"/,
    'script format with resource': /scriptFormat="groovy"/,
    'script resource': /camunda:resource="classpath:\/\/calc.groovy"/,
    'rule resultVariable kept': /camunda:resultVariable="verdict"/,
    'mapDecisionResult': /camunda:mapDecisionResult="singleEntry"/,
    'renamed task keeps asyncBefore': /id="Task_Charge"[^>]*camunda:asyncBefore="true"/,
    'renamed task keeps listener': /class="org.Audit"/,
    'external task error': /camunda:errorEventDefinition[^>]*errorRef="Error_1"/,
    'error root kept': /<bpmn:error id="Error_1"/,
    'MI async': /multiInstanceLoopCharacteristics[^>]*camunda:asyncBefore="true"/,
    'MI retry cycle': /R5\/PT1M/,
    'resource condition': /conditionExpression[^>]*camunda:resource="cond.groovy"/,
    'standard loop': /standardLoopCharacteristics/,
    'take listener on split flow': /class="org.Take"/,
    'message end delegate on event definition': /messageEventDefinition[^>]*camunda:class="org.Notify"/
  };
  for (const [what, re] of Object.entries(checks)) assert.match(xml, re, what);
  assert.doesNotMatch(xml, /<bpmn:endEvent[^>]*camunda:class/, 'delegate is not on the end event itself');
  assert.doesNotMatch(xml, /<bpmn:message /, 'no invented message');
  assert.deepEqual((await validateXml(xml)).filter(w => /unresolved/.test(w)), []);
  // the split flow kept its id (listeners/properties stay attached to it)
  assert.match(xml, /<bpmn:sequenceFlow id="F7" sourceRef="Rule" targetRef="Log"/);
});

test('bpmn_write_xml does not overwrite an editor save made after bpmn_get_xml', async () => {
  const read = await studio.assistantStudio.callTool('bpmn_get_xml', { file: 'c7' });
  const current = await studio.store.get('c7');
  await studio.store.save('c7', current.xml.replace('name="Notify"', 'name="Notify (editor)"'), { baseHash: current.hash, source: 'editor' });
  const w = await studio.assistantStudio.callTool('bpmn_write_xml', { file: 'c7', xml: read.result, open: false });
  assert.equal(w.ok, false);
  assert.match(w.error, /changed in the editor/);
  assert.match((await studio.store.get('c7')).xml, /Notify \(editor\)/);
  // after reading again it works
  const again = await studio.assistantStudio.callTool('bpmn_get_xml', { file: 'c7' });
  assert.equal((await studio.assistantStudio.callTool('bpmn_write_xml', { file: 'c7', xml: again.result, open: false })).ok, true);
});

test('messages and errors do not pile up: Modeler ids, renamed messages, removed elements', async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:camunda="http://camunda.org/schema/1.0/bpmn" xmlns:modeler="http://camunda.org/schema/modeler/1.0" id="D" targetNamespace="http://bpmn.io/schema/bpmn" modeler:executionPlatform="Camunda Platform" modeler:executionPlatformVersion="7.24.0">
  <bpmn:message id="Message_0abc" name="Order" />
  <bpmn:error id="Error_0xyz" name="Fail" errorCode="F" />
  <bpmn:message id="Message_Pay" name="Pay" />
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S"><bpmn:messageEventDefinition messageRef="Message_0abc" /></bpmn:startEvent>
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="R" />
    <bpmn:receiveTask id="R" name="Wait" messageRef="Message_Pay" />
    <bpmn:sequenceFlow id="F2" sourceRef="R" targetRef="T" />
    <bpmn:serviceTask id="T" camunda:type="external" camunda:topic="t" />
    <bpmn:boundaryEvent id="B" attachedToRef="T"><bpmn:errorEventDefinition errorRef="Error_0xyz" /></bpmn:boundaryEvent>
    <bpmn:sequenceFlow id="F3" sourceRef="T" targetRef="E" />
    <bpmn:sequenceFlow id="F4" sourceRef="B" targetRef="E" />
    <bpmn:endEvent id="E" />
  </bpmn:process>
</bpmn:definitions>`;
  assert.equal((await studio.assistantStudio.callTool('bpmn_write_xml', { file: 'roots', xml, autoLayout: true, open: false })).ok, true);
  const edit2 = async args => {
    const r = await studio.assistantStudio.callTool('bpmn_edit', { file: 'roots', open: false, ...args });
    assert.equal(r.ok, true, r.error);
    return (await studio.store.get('roots')).xml;
  };
  const count = (x, re) => (x.match(re) || []).length;
  let out = await edit2({ updateElements: [{ id: 'T', name: 'Charge' }] });
  assert.equal(count(out, /<bpmn:message /g), 2);
  assert.equal(count(out, /<bpmn:error /g), 1);
  out = await edit2({ updateElements: [{ id: 'S', messageName: 'Order2' }] });
  out = await edit2({ updateElements: [{ id: 'S', messageName: 'Order3' }] });
  assert.equal(count(out, /<bpmn:message /g), 2, 'renaming a message does not keep the old ones');
  out = await edit2({ removeElements: ['R'], addFlows: [{ from: 'S', to: 'T' }] });
  assert.equal(count(out, /<bpmn:message /g), 1, 'the removed receive task\'s message is gone');
  const lint = await studio.assistantStudio.callTool('bpmn_lint', { file: 'roots' });
  assert.ok(!JSON.stringify(lint.result).includes('unused'), JSON.stringify(lint.result));
});

test('an edit that would produce a duplicate id is refused instead of saving invalid XML', async () => {
  const before = (await studio.store.get('roots')).xml;
  const msgId = /<bpmn:message id="([^"]+)"/.exec(before)[1];
  // a new element taking the id of a message: rebuilt messages get new ids, so this must still be valid or refused
  const r = await studio.assistantStudio.callTool('bpmn_edit', { file: 'roots', open: false,
    insertBetween: [{ from: 'T', to: 'E', element: { id: msgId, type: 'userTask', name: 'Clash' } }] });
  const after = (await studio.store.get('roots')).xml;
  if (r.ok) assert.equal(((after.match(new RegExp(`id="${msgId}"`, 'g'))) || []).length, 1);
  else { assert.match(r.error, /invalid BPMN/); assert.equal(after, before); }
});

test('a resource-based condition can be replaced by an inline one or removed', async () => {
  const cond = async () => /<bpmn:sequenceFlow id="F4"[\s\S]*?<\/bpmn:sequenceFlow>|<bpmn:sequenceFlow id="F4"[^>]*\/>/.exec((await studio.store.get('c7')).xml)[0];
  assert.match(await cond(), /camunda:resource="cond.groovy"/);
  await edit({ updateFlows: [{ id: 'F4', set: { condition: 'x > 1' } }] });
  let f = await cond();
  assert.match(f, /x &gt; 1/);
  assert.doesNotMatch(f, /camunda:resource/, 'the resource is not kept under an inline condition');
  await edit({ updateFlows: [{ id: 'F4', set: { condition: null, conditionLanguage: null } }] });
  f = await cond();
  assert.doesNotMatch(f, /conditionExpression/);
});

test('bpmn_write_xml: an existing diagram must be read first; a deleted one is not recreated', async () => {
  const s2 = createStudio({ adapter: new MemoryAdapter() });
  await s2.store.save('x', XML);
  const blind = await s2.assistantStudio.callTool('bpmn_write_xml', { file: 'x', xml: XML.replace('Notify', 'N2'), open: false });
  assert.equal(blind.ok, false);
  assert.match(blind.error, /bpmn_get_xml first/);
  const read = await s2.assistantStudio.callTool('bpmn_get_xml', { file: 'x' });
  await s2.store.delete('x');
  for (let i = 0; i < 2; i++) {
    const w = await s2.assistantStudio.callTool('bpmn_write_xml', { file: 'x', xml: read.result, open: false });
    assert.equal(w.ok, false);
    assert.match(w.error, /deleted/);
  }
  assert.equal(await s2.store.exists('x'), false);
});
