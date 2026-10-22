// The BPMN tools of the studio's assistant. They run in the browser (web/assistant/core.js) on the diagram store.
import { z } from 'zod';
import {
  ELEMENT_TYPES, EVENT_DEFINITIONS, applyEdits, extractGeometry, sameStructure, sanitizeId, specToXml, validateXml, xmlToSpec
} from './bpmn.js';
import { checkXml as check } from './lint.js';
import { config, deploySchema, deployTarget } from './config.js';
import { normalizeName } from './names.js';

// ------------------------------------------------------------------ schemas

const ioParam = z.object({ source: z.string().describe('FEEL expression, e.g. "=order.id"'), target: z.string() });

const elementSchema = z.looseObject({
  id: z.string().describe('Unique ASCII id, e.g. "Task_CheckOrder", "Gateway_InStock". Referenced by flows. Non-ASCII is transliterated.'),
  type: z.enum(ELEMENT_TYPES),
  name: z.string().optional().describe('Label shown in the diagram'),
  parent: z.string().optional().describe('Id of the subProcess this element lives in (omit for top level)'),
  lane: z.string().optional().describe('Lane id (top-level elements only). If omitted, taken from the previous element in the flow'),
  documentation: z.string().optional(),
  // events
  eventDefinition: z.enum(EVENT_DEFINITIONS).optional().describe('For events. "none" = plain event'),
  timerType: z.enum(['duration', 'date', 'cycle']).optional(),
  timerValue: z.string().optional().describe('ISO 8601: "PT15M", "2026-01-01T09:00:00Z", "R3/PT1H"'),
  messageName: z.string().optional().describe('Message events and receiveTask'),
  correlationKey: z.string().optional().describe('Camunda 8 message correlation key (FEEL), e.g. "=orderId"'),
  signalName: z.string().optional(),
  errorCode: z.string().optional().describe('Error events; required on throwing error end events in Camunda 8'),
  errorName: z.string().optional(),
  escalationCode: z.string().optional(),
  escalationName: z.string().optional(),
  linkName: z.string().optional().describe('Link events: a throw and a catch with the same linkName are connected'),
  initiator: z.string().optional().describe('Camunda 7 start event: variable receiving the starting user id'),
  condition: z.string().optional().describe('For conditional events'),
  attachedTo: z.string().optional().describe('boundaryEvent: id of the host activity'),
  cancelActivity: z.boolean().optional().describe('boundaryEvent: false = non-interrupting'),
  interrupting: z.boolean().optional().describe('startEvent inside event subProcess: false = non-interrupting'),
  triggeredByEvent: z.boolean().optional().describe('subProcess: true = event sub-process'),
  // implementation
  jobType: z.string().optional().describe('Camunda 8 job worker type (serviceTask/sendTask/...); Camunda 7: external task topic'),
  retries: z.number().optional(),
  headers: z.record(z.string(), z.string()).optional().describe('Camunda 8 task headers'),
  assignee: z.string().optional(),
  candidateGroups: z.string().optional().describe('Comma separated'),
  candidateUsers: z.string().optional(),
  formId: z.string().optional().describe('Camunda 8 linked form id'),
  formKey: z.string().optional().describe('C7: embedded/external form, e.g. "embedded:app:forms/approve.html"'),
  formFields: z.array(z.object({
    id: z.string().describe('Process variable name'),
    label: z.string().optional(),
    // the default applies to fields the assistant adds; fields read from a file keep "no type" as is
    type: z.enum(['string', 'long', 'boolean', 'date', 'enum']).default('string'),
    defaultValue: z.string().optional(),
    datePattern: z.string().optional(),
    values: z.array(z.object({ id: z.string(), name: z.string().optional() })).optional().describe('Options of an enum field'),
    validation: z.array(z.object({ name: z.string().describe('required, minlength, maxlength, min, max, readonly'), config: z.string().optional() })).optional(),
    properties: z.record(z.string(), z.string()).optional()
  })).optional().describe('Camunda 7 Generated Task Form (camunda:formData) of a userTask or start event'),
  formBusinessKey: z.string().optional().describe('C7 start form: id of the field that is the business key'),
  calledElement: z.string().optional().describe('callActivity: called process id'),
  decisionId: z.string().optional().describe('businessRuleTask: DMN decision id'),
  script: z.string().optional(),
  scriptFormat: z.string().optional().describe('scriptTask language, e.g. "javascript" (default), "groovy"'),
  resultVariable: z.string().optional(),
  inputs: z.array(ioParam).optional().describe('Camunda 8 input mappings'),
  outputs: z.array(ioParam).optional().describe('Camunda 8 output mappings'),
  multiInstance: z.object({
    sequential: z.boolean().optional(),
    loopCardinality: z.string().optional().describe('Camunda 7 only: fixed number of instances'),
    completionCondition: z.string().optional().describe('e.g. "=approved = true" (C8) / "${nrOfCompletedInstances >= 2}" (C7)'),
    collection: z.string().optional().describe('e.g. "=items"'),
    element: z.string().optional().describe('e.g. "item"'),
    outputCollection: z.string().optional(),
    outputElement: z.string().optional()
  }).optional(),
  delegateExpression: z.string().optional().describe('Camunda 7 only'),
  javaClass: z.string().optional().describe('Camunda 7 only'),
  expression: z.string().optional().describe('Camunda 7 only')
});

const flowSchema = z.object({
  id: z.string().optional(),
  from: z.string().describe('Source element id'),
  to: z.string().describe('Target element id'),
  name: z.string().optional().describe('Label, e.g. "Yes" / "No"'),
  condition: z.string().optional().describe('Condition for flows leaving exclusive/inclusive gateways. Camunda 8 FEEL: "amount > 1000" ("=" is added automatically). Camunda 7: JUEL "${amount > 1000}"'),
  isDefault: z.boolean().optional().describe('Default flow of the gateway (no condition needed)'),
  conditionLanguage: z.string().optional().describe('C7 script condition language (javascript, groovy); condition is then the script')
});

const laneSchema = z.object({ id: z.string().describe('e.g. "Lane_Manager"'), name: z.string().optional().describe('Role, e.g. "Менеджер"') });
const poolSchema = z.object({ id: z.string().optional(), name: z.string().optional().describe('Usually the organisation, e.g. "Банк"; default: processName') });
const externalPoolSchema = z.object({
  id: z.string().describe('e.g. "Pool_Client"'),
  name: z.string().optional().describe('External party, e.g. "Клиент", "Банк-партнёр"'),
  position: z.enum(['top', 'bottom']).optional().describe('Above (default) or below the main pool')
});
const messageFlowSchema = z.object({
  id: z.string().optional(),
  from: z.string().describe('Element id or pool id'),
  to: z.string().describe('Element id or pool id'),
  name: z.string().optional().describe('What is sent, e.g. "Заявка", "Договор"')
});
const flowSelector = z.object({ id: z.string().optional(), from: z.string().optional(), to: z.string().optional() });

const fileParam = z.string().describe('Diagram file name, e.g. "credit-approval" (".bpmn" is appended if missing)');
const openParam = z.boolean().default(true).describe('Switch the web modeler to this file (it refreshes on save anyway)');
const platformParam = z.enum(['camunda8', 'camunda7', 'none']);

// ------------------------------------------------------------------ tools

/** Instructions for the model; a function because they include the current settings. */
export const instructions = () => `Build BPMN 2.0 diagrams from natural-language descriptions. Diagrams are stored in the studio's cloud storage (refer to them by name, e.g. "credit-approval"); the web modeler (bpmn.io / camunda-bpmn-js) shows every saved change live, and the user can also edit there.

Workflow
- New diagram: turn the user's text into elements + flows and call bpmn_create.
- Change: bpmn_read first, then bpmn_edit (targeted changes) or bpmn_create with overwrite=true (restructure).
- Every write returns "deployErrors" (Camunda Modeler's own camunda-compat lint – the engine would reject the model) and "modelingIssues" (bpmnlint recommended rules). Fix deployErrors with bpmn_edit before reporting success; fix modelingIssues unless the user wants otherwise.
- bpmn_edit refuses when the file contains content the spec cannot represent (annotations, data objects, nested lanes, several expanded pools). Tell the user what would be lost; only pass force=true if they agree.

Modeling conventions
- Tasks: verb + object ("Проверить заказ"). Events: object + state ("Заказ получен"). XOR gateways: question ("Товар в наличии?"), outgoing flows named with answers.
- Name every start/end event, task and splitting gateway. Use the user's language for names, ASCII ids (Task_CheckOrder).
- Exclusive/inclusive gateway branches: a condition on each flow, or conditions + one isDefault flow.
- Do not join flows directly on a task/end event: merge with a gateway of the same kind (XOR merge for XOR split, parallel join for parallel split), or use separate end events.
- Default platform: ${config.defaultPlatform === 'camunda7' ? `Camunda 7 (engine ${config.camunda7Version})` : 'Camunda 8'}; omit "platform" unless the user asks for the other one.
- Camunda 7 forms: "Generated Task Forms" = formFields on a userTask / start event (id = variable, label, type string|long|boolean|date|enum, validation e.g. [{name:"required"}]); or formKey for embedded/external forms.
- Camunda 7: serviceTask/sendTask need an implementation — jobType (external task topic), delegateExpression ("\${myDelegate}") or javaClass; user tasks: assignee / candidateGroups / formKey; conditions are JUEL ("\${amount > 1000}"; a bare expression is wrapped automatically); message correlation is done by the application (no correlationKey).
- Camunda 8: serviceTask/sendTask/message throw events need jobType; message catch events/receiveTask need messageName + correlationKey (not on top-level message start events); conditions are FEEL ("amount > 1000"); timer start events use timerType date|cycle.

Deployment ("отправить схему")
- bpmn_rename renames the diagram (studio file name) only when the user asks to rename the diagram/file; "rename the process" means bpmn_edit processName.
- bpmn_deploy sends a saved diagram to one of the configured servers (${Object.keys(config.deploy.targets).join(', ') || 'none configured'}). Only call it when the user explicitly asks to send/deploy in their current message, to the target they named; never send to prod on your own initiative. Fix deployErrors first.

Pools & lanes
- Roles/departments doing the work → lanes (each top-level element gets "lane"). Lanes imply a pool (default name = processName).
- Parties outside the organisation (customer, bank, partner system) → externalPools (black-box pools) + messageFlows between them and elements of the process (or the main pool). Never connect two elements of the main pool with a message flow, use a sequence flow.
- Message flows are documentation; the process still needs the matching message events / send tasks.
- Lanes can be renamed/reordered/added/removed via bpmn_edit "lanes" (full list, top to bottom); move an element with updateElements {id, lane}.

Preservation: bpmn_edit keeps everything the spec does not describe (listeners, input/output, async continuations, job priority, properties, field injections, version tag, ...) on elements that still exist.

Layout: new diagrams and structural edits (added/removed elements or flows) are auto-laid out; edits that only change names/properties keep the user's positions. Pass relayout=true only when the user asks to tidy the layout.
Nested lanes, several expanded pools, annotations and data objects only via bpmn_get_xml + bpmn_write_xml.`;

/**
 * @param {object} host
 * @param {import('./store.js').DiagramStore} host.store  the studio's diagram storage
 * @param {(name: string) => string} host.show            switch open editor tabs to a diagram
 * @returns {{ name: string, title: string, description: string, shape: object, handler: (args: object) => Promise<object|string> }[]}
 */
export function createTools({ store, show = async () => 'No editor is attached.' } = {}) {
  const SOURCE = 'assistant';
  const tools = [];
  const tool = (name, title, description, shape, handler) => tools.push({ name, title, description, shape, handler });
  // version of each diagram the assistant last read or wrote: bpmn_write_xml must not overwrite newer editor saves
  const xmlReadAt = new Map();
  // a rebuilt diagram must be valid XML (e.g. no duplicate ids) before it is saved
  const assertValid = async xml => {
    const problems = (await validateXml(xml)).filter(w => /duplicate|unparsable|unresolved/i.test(w));
    if (problems.length) throw new Error(`The result would be invalid BPMN, nothing was saved: ${problems.join('; ')}`);
  };

  tool('bpmn_create', 'Create BPMN diagram',
    'Create a BPMN process diagram from a list of elements and sequence flows, auto-layout it, save it and show it in the web modeler.',
    {
      file: fileParam,
      processName: z.string(),
      processId: z.string().optional().describe('Executable process id, e.g. "order-process"'),
      platform: platformParam.default(config.defaultPlatform),
      documentation: z.string().optional(),
      elements: z.array(elementSchema),
      flows: z.array(flowSchema),
      pool: poolSchema.optional().describe('Wrap the process in a pool (implied by lanes/externalPools)'),
      lanes: z.array(laneSchema).optional().describe('Lanes top to bottom'),
      externalPools: z.array(externalPoolSchema).optional(),
      messageFlows: z.array(messageFlowSchema).optional(),
      overwrite: z.boolean().default(false),
      open: openParam
    },
    async ({ file, open, overwrite, ...spec }) => {
      const name = normalizeName(file);
      if (!overwrite && await store.exists(name)) throw new Error(`${name} already exists. Use bpmn_edit, or overwrite=true.`);
      if (!spec.processId) spec.processId = sanitizeId(name.replace(/\.bpmn$/, '')).replace(/^_+/, '') || 'Process_1';
      const { xml, warnings } = await specToXml(spec);
      await assertValid(xml);
      try {
        // create: true closes the gap between the check above and the save (another tab may create it)
        xmlReadAt.set(name, (await store.save(name, xml, { create: !overwrite, source: SOURCE })).hash);
      } catch (err) {
        if (err.status === 409) throw new Error(`${name} already exists. Use bpmn_edit, or overwrite=true.`);
        throw err;
      }
      return {
        saved: name, elements: spec.elements.length, flows: spec.flows.length,
        ...(await check(xml)), warnings, modeler: open ? await show(name) : undefined
      };
    });

  tool('bpmn_read', 'Read BPMN diagram',
    'Read a diagram and return it as the editable spec (elements + flows). Call before bpmn_edit.',
    { file: fileParam },
    async ({ file }) => {
      const { name, xml, hash } = await store.get(file);
      xmlReadAt.set(name, hash);
      const { spec, lossy, warnings } = await xmlToSpec(xml);
      return { file: name, notRepresentedInSpec: lossy, warnings, ...(await check(xml)), spec };
    });

  tool('bpmn_edit', 'Edit BPMN diagram',
    `Apply changes to an existing diagram, save it and refresh the web modeler.
Positions are kept when the structure is unchanged (renames, properties, conditions); otherwise the diagram is re-laid out.
Order of application: removeElements (also removes their flows), removeFlows, pool, lanes, externalPools, removeMessageFlows, updateElements, updateFlows, addElements, insertBetween, addFlows, addMessageFlows.
Use insertBetween to put a new step into an existing flow A->B (gives A->new->B).`,
    {
      file: fileParam,
      addElements: z.array(elementSchema).optional(),
      updateElements: z.array(z.looseObject({ id: z.string(), newId: z.string().optional() }))
        .optional().describe('Partial element objects merged into existing ones by id; set a field to null to remove it'),
      removeElements: z.array(z.string()).optional(),
      addFlows: z.array(flowSchema).optional(),
      updateFlows: z.array(z.object({
        id: z.string().optional(), from: z.string().optional(), to: z.string().optional(),
        set: z.record(z.string(), z.any()).describe('Fields to set (name, condition, isDefault, from, to); null removes')
      })).optional(),
      removeFlows: z.array(flowSelector).optional(),
      pool: poolSchema.nullable().optional().describe('Set/rename the pool; null removes it (only without lanes and external pools)'),
      lanes: z.array(laneSchema).optional().describe('Replace the full lane list (top to bottom). Elements of removed lanes are re-assigned automatically'),
      externalPools: z.array(externalPoolSchema).optional().describe('Replace the full list; message flows of removed pools are dropped'),
      addMessageFlows: z.array(messageFlowSchema).optional(),
      removeMessageFlows: z.array(flowSelector).optional(),
      insertBetween: z.array(z.object({ from: z.string(), to: z.string(), element: elementSchema })).optional(),
      processName: z.string().optional(),
      platform: platformParam.optional(),
      documentation: z.string().optional(),
      force: z.boolean().default(false).describe('Rebuild even if content that the spec cannot represent would be lost'),
      relayout: z.boolean().default(false).describe('Recompute the layout even if the structure is unchanged'),
      open: openParam
    },
    async ({ file, open, force, relayout, ...edits }) => {
      const { name, xml: before, hash: baseHash } = await store.get(file);
      const { spec, lossy, warnings: readWarnings } = await xmlToSpec(before);
      if (lossy.length && !force) {
        throw new Error(`Editing would drop content not supported by the spec: ${lossy.join('; ')}. ` +
          'Ask the user; then retry with force=true, or edit the XML via bpmn_get_xml + bpmn_write_xml.');
      }
      const { spec: next, log, renames } = applyEdits(spec, edits);
      let geometry;
      if (!relayout) {
        const old = await extractGeometry(before);
        for (const [from, to] of renames) if (old.has(from)) { old.set(to, old.get(from)); old.delete(from); }
        const renamed = { ...spec, elements: spec.elements.map(e => ({ ...e, id: renames.get(e.id) || e.id,
          ...(e.parent ? { parent: renames.get(e.parent) || e.parent } : {}),
          ...(e.attachedTo ? { attachedTo: renames.get(e.attachedTo) || e.attachedTo } : {}) })),
          flows: spec.flows.map(f => ({ ...f, from: renames.get(f.from) || f.from, to: renames.get(f.to) || f.to })),
          ...(spec.messageFlows ? { messageFlows: spec.messageFlows.map(f => ({ ...f, from: renames.get(f.from) || f.from, to: renames.get(f.to) || f.to })) } : {}) };
        if (sameStructure(renamed, next)) geometry = old;
      }
      const { xml, warnings } = await specToXml(next, { geometry, previousXml: before, renames });
      // baseHash: if the user saved the diagram meanwhile, fail instead of overwriting their change
      await assertValid(xml);
      try {
        xmlReadAt.set(name, (await store.save(name, xml, { baseHash, source: SOURCE })).hash);
      } catch (err) {
        if (err.status === 409 && err.deleted) throw new Error(`${name} was renamed or deleted in the editor while you were editing it. Call bpmn_list to find it.`);
        if (err.status === 409) throw new Error(`${name} was changed in the editor while you were editing it; call bpmn_read and apply your change again.`);
        throw err;
      }
      return {
        saved: name, changes: log, layout: geometry ? 'kept' : 'recomputed', dropped: lossy.length ? lossy : undefined,
        ...(await check(xml)), warnings: [...readWarnings, ...warnings], modeler: open ? await show(name) : undefined
      };
    });

  tool('bpmn_get_xml', 'Get BPMN XML', 'Return the raw BPMN XML of a diagram.', { file: fileParam },
    async ({ file }) => {
      const { name, xml, hash } = await store.get(file);
      xmlReadAt.set(name, hash);
      return xml;
    });

  tool('bpmn_write_xml', 'Write raw BPMN XML',
    'Last resort: save hand-written BPMN 2.0 XML, only for what bpmn_create/bpmn_edit cannot express (nested lanes, several expanded pools, data objects, annotations). Pools, lanes, external pools and message flows are supported by bpmn_create/bpmn_edit — use those. Validated with bpmn-moddle. If the XML has no BPMNDiagram section set autoLayout=true (single process only).',
    { file: fileParam, xml: z.string(), autoLayout: z.boolean().default(false), open: openParam },
    async ({ file, xml, autoLayout, open }) => {
      const name = normalizeName(file);
      // without a diagram section the editor has nothing to show: lay it out
      if (autoLayout || !/<([\w.-]+:)?BPMNDiagram[\s>]/.test(xml.replace(/<!--[\s\S]*?-->/g, ''))) xml = await (await import('bpmn-auto-layout')).layoutProcess(xml);
      const warnings = await validateXml(xml);
      // an existing diagram the assistant never read in this conversation: it must look first
      if (!xmlReadAt.has(name) && await store.exists(name)) {
        throw new Error(`${name} already exists. Call bpmn_get_xml first, then write your changed version.`);
      }
      try {
        const { hash } = await store.save(name, xml, { baseHash: xmlReadAt.get(name), source: SOURCE });
        xmlReadAt.set(name, hash);
      } catch (err) {
        if (err.status === 409 && err.deleted) {
          throw new Error(`${name} no longer exists: it was renamed or deleted in the editor. Call bpmn_list to find it; do not create it again unless the user asks.`);
        }
        if (err.status === 409) {
          xmlReadAt.delete(name);
          throw new Error(`${name} was changed in the editor after you read it. Call bpmn_get_xml again and reapply your change.`);
        }
        throw err;
      }
      return { saved: name, ...(await check(xml)), warnings, modeler: open ? await show(name) : undefined };
    });

  tool('bpmn_lint', 'Lint BPMN diagram',
    'Check a diagram with the rules Camunda Modeler uses (camunda-compat for the diagram\'s execution platform + bpmnlint recommended + Camunda 7 engine parse checks).',
    { file: fileParam },
    async ({ file }) => {
      const { name, xml } = await store.get(file);
      return { file: name, ...(await check(xml)) };
    });

  const targetNames = Object.keys(config.deploy.targets);
  tool('bpmn_deploy', 'Send diagram to server',
    `Send ("отправить схему") a saved diagram to a deployment server: POST {server}${config.deploy.path} with {"${config.deploy.field}": <base64 XML>}. ` +
    `Servers: ${targetNames.map(n => `${n} = ${config.deploy.targets[n]}`).join(', ') || 'none configured (bpmn-studio.config.json)'}. ` +
    'Only when the user explicitly asks to send/deploy, to the server they named. Refuses diagrams with deployErrors unless force=true.',
    {
      file: fileParam,
      target: (targetNames.length ? z.enum(targetNames) : z.string()).describe('Configured server name'),
      force: z.boolean().default(false).describe('Send even with deployErrors (only if the user insists)')
    },
    async ({ file, target, force }) => {
      const url = deployTarget(target);
      if (!url) throw new Error(`Unknown server "${target}". Configured: ${targetNames.join(', ') || 'none'}`);
      const { name, xml } = await store.get(file);
      const lint = await check(xml);
      if (lint.deployErrors?.length && !force) {
        throw new Error(`Not sent: the diagram has deploy errors:\n${lint.deployErrors.join('\n')}`);
      }
      let res;
      try {
        res = await deploySchema(url, xml);
      } catch (err) {
        throw new Error(`Could not reach server "${target}" (${url}): ${err.name === 'TimeoutError' ? 'timeout (30 s)' : 'the server is unreachable or does not allow requests from the studio (CORS)'}`);
      }
      if (!res.ok) throw new Error(`Server ${target} (${res.url}) answered HTTP ${res.status}: ${res.body}`);
      return { sent: name, target, url: res.url, status: res.status, response: res.body };
    });

  tool('bpmn_list', 'List diagrams', 'List the saved diagrams.', {},
    async () => ({ files: await store.list() }));

  tool('bpmn_open', 'Show in web modeler', 'Switch the web modeler to a diagram.', { file: fileParam },
    async ({ file }) => {
      const { name } = await store.get(file);
      return await show(name);
    });

  tool('bpmn_rename', 'Rename diagram',
    'Rename a diagram (its file name in the studio). Only the name changes: the content, the process id (the engine\'s deployment key) and the undo history stay. To change the process name shown in the diagram use bpmn_edit processName.',
    { file: fileParam, newName: z.string().describe('New diagram name, e.g. "order-v2"') },
    async ({ file, newName }) => {
      const { name, renamed } = await store.rename(file, newName, { source: SOURCE });
      const from = normalizeName(file);
      if (xmlReadAt.has(from)) { xmlReadAt.set(name, xmlReadAt.get(from)); xmlReadAt.delete(from); }
      return { renamed: renamed ? `${from} → ${name}` : 'unchanged', file: name };
    });

  tool('bpmn_undo', 'Undo last change', 'Restore the previous saved version of a diagram (the current one stays available for bpmn_redo).', { file: fileParam, open: openParam },
    async ({ file, open }) => {
      const { name, from, remaining } = await store.undo(file, { source: SOURCE });
      return { restored: name, from, remaining, redoAvailable: true, modeler: open ? await show(name) : undefined };
    });

  tool('bpmn_redo', 'Redo', 'Re-apply the change that the last bpmn_undo reverted.', { file: fileParam, open: openParam },
    async ({ file, open }) => {
      const { name, from, remaining } = await store.redo(file, { source: SOURCE });
      return { restored: name, from, remaining, modeler: open ? await show(name) : undefined };
    });

  return tools;
}

/** Tool definitions as JSON Schema (for OpenAI "functions" and Anthropic "tools"). */
export function toolJsonSchemas(tools) {
  return tools.map(t => {
    const schema = z.toJSONSchema(z.object(t.shape), { io: 'input', unrepresentable: 'any' });
    delete schema.$schema;
    return { name: t.name, description: t.description, parameters: schema };
  });
}

/** Validate arguments with the tool's zod shape and run it. */
export async function runTool(tools, name, args) {
  const t = tools.find(x => x.name === name);
  if (!t) throw Object.assign(new Error(`Unknown tool "${name}"`), { status: 404 });
  const parsed = z.object(t.shape).safeParse(args ?? {});
  if (!parsed.success) {
    throw Object.assign(new Error(`Invalid arguments for ${name}: ${z.prettifyError(parsed.error)}`), { status: 400 });
  }
  return t.handler(parsed.data);
}
