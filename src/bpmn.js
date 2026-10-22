// BPMN model helpers: a simple JSON "spec" <-> BPMN 2.0 XML (with auto-layout).
import { BpmnModdle } from 'bpmn-moddle';
import zeebeDescriptor from 'zeebe-bpmn-moddle/resources/zeebe.json' with { type: 'json' };
import camundaDescriptor from 'camunda-bpmn-moddle/resources/camunda.json' with { type: 'json' };
import { layoutProcess } from 'bpmn-auto-layout';
import {
  buildCollaboration, collaborationIds, collaborationSignature, layoutCollaboration, normalizeCollaboration, readCollaboration
} from './collaboration.js';
import { config, platformVersion } from './config.js';


export const ELEMENT_TYPES = [
  'startEvent', 'endEvent', 'intermediateCatchEvent', 'intermediateThrowEvent', 'boundaryEvent',
  'task', 'userTask', 'serviceTask', 'scriptTask', 'sendTask', 'receiveTask', 'manualTask', 'businessRuleTask',
  'subProcess', 'callActivity',
  'exclusiveGateway', 'parallelGateway', 'inclusiveGateway', 'eventBasedGateway'
];

export const EVENT_DEFINITIONS = [
  'none', 'timer', 'message', 'signal', 'error', 'escalation', 'conditional', 'terminate', 'compensate', 'link'
];

const PLATFORMS = {
  camunda8: { name: 'Camunda Cloud', version: platformVersion('camunda8') },
  camunda7: { name: 'Camunda Platform', version: platformVersion('camunda7') }
};

const NS_MODELER = 'http://camunda.org/schema/modeler/1.0';

// zeebe and camunda descriptors cannot be loaded into one moddle instance
function newModdle(platform) {
  if (platform === 'camunda7') return new BpmnModdle({ camunda: camundaDescriptor });
  return new BpmnModdle({ zeebe: zeebeDescriptor });
}

function detectPlatform(xml) {
  if (/executionPlatform="Camunda Platform"/.test(xml) || (/xmlns:camunda=/.test(xml) && !/xmlns:zeebe=/.test(xml))) return 'camunda7';
  if (/executionPlatform="Camunda Cloud"/.test(xml) || /xmlns:zeebe=/.test(xml)) return 'camunda8';
  // plain BPMN without engine extensions: treat as the studio's platform
  return config.defaultPlatform;
}

const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const isCatching = e => e.type === 'boundaryEvent' || e.type === 'startEvent' || e.type === 'intermediateCatchEvent';
const ROOT_TYPES = /^bpmn:(Message|Error|Signal|Escalation)$/;
const uncap = s => s.charAt(0).toLowerCase() + s.slice(1);

const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', ў: 'o', қ: 'q', ғ: 'g', ҳ: 'h', і: 'i', ї: 'yi', є: 'ye', ґ: 'g'
};

function transliterate(str) {
  return [...str].map(ch => {
    const lower = ch.toLowerCase();
    const t = TRANSLIT[lower];
    if (t === undefined) return ch;
    return ch === lower ? t : t.charAt(0).toUpperCase() + t.slice(1);
  }).join('');
}

// BPMN ids must be XML NCNames; Camunda tooling expects ASCII.
export function sanitizeId(raw) {
  let id = transliterate(String(raw).trim()).replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/_+/g, '_');
  if (!/^[A-Za-z_]/.test(id)) id = '_' + id;
  return id;
}

// ---------------------------------------------------------------- spec -> XML

// Sanitize ids and assign stable flow ids, so partial builds (used for layout) agree on ids.
function normalizeSpec(spec) {
  const elements = (spec.elements || []).map(e => {
    const n = { ...e, id: sanitizeId(e.id) };
    if (e.parent) n.parent = sanitizeId(e.parent);
    if (e.attachedTo) n.attachedTo = sanitizeId(e.attachedTo);
    if (e.lane !== undefined && e.lane !== null) n.lane = sanitizeId(e.lane);
    else delete n.lane;
    return n;
  });
  // a boundary event lives in the same container as its host
  const byId = new Map(elements.map(e => [e.id, e]));
  for (const e of elements) {
    if (e.type === 'boundaryEvent' && e.attachedTo && !e.parent && byId.get(e.attachedTo)?.parent) e.parent = byId.get(e.attachedTo).parent;
  }
  const taken = new Set(elements.map(e => e.id));
  const flows = (spec.flows || []).map(f => ({ ...f, from: sanitizeId(f.from), to: sanitizeId(f.to) }));
  for (const f of flows) if (f.id) { f.id = sanitizeId(f.id); taken.add(f.id); }
  for (const f of flows) {
    if (f.id) continue;
    let id = `Flow_${f.from}_${f.to}`;
    while (taken.has(id)) id += '_';
    taken.add(id);
    f.id = id;
  }
  const { pool, lanes, externalPools, messageFlows, ...rest } = spec;
  return { ...rest, elements, flows, ...normalizeCollaboration(spec, sanitizeId, taken) };
}

/**
 * @param {object} rawSpec
 * @param {{ geometry?: Map, previousXml?: string, renames?: Map<string, string> }} [options]
 *   geometry: positions to reuse instead of auto-layout (see extractGeometry / sameStructure), must cover
 *   every element and flow; previousXml: the version being edited, whose unmodeled content is carried
 *   over; renames: old id -> new id of elements renamed by the edit.
 */
export async function specToXml(rawSpec, options = {}) {
  const spec = normalizeSpec(rawSpec);
  let previous = null;
  if (options.previousXml) {
    previous = (await newModdle(spec.platform || config.defaultPlatform).fromXML(options.previousXml, 'bpmn:Definitions')).rootElement;
  }
  // messages, errors, … keep the ids they had (Modeler's "Message_0abc"), matched by type and name
  // (unnamed ones by their id, which the spec then uses as their name)
  const rootIds = new Map((previous?.rootElements || []).filter(r => ROOT_TYPES.test(r.$type))
    .map(r => [`${r.$type.slice(5)}:${r.name ?? r.id}`, { id: r.id, named: r.name != null }]));
  const built = buildModel(spec, { rootIds });
  const { moddle, definitions, elementsById, warnings } = built;
  warnings.push(...lint(spec.elements, spec.flows, elementsById));
  const needed = [...spec.elements.map(e => e.id), ...spec.flows.map(f => f.id), ...collaborationIds(spec)];
  let geometry;
  if (options.geometry && needed.every(id => options.geometry.has(id))) {
    geometry = options.geometry;
  } else {
    geometry = await computeLayout(spec);
    // a lane must leave room for the tallest label placed above a gateway (see createDi)
    const gatewayLabel = Math.max(0, ...spec.elements.filter(e => e.type.endsWith('Gateway') && e.name).map(e => labelBounds(e.name).height + 12));
    layoutCollaboration(spec, geometry, { padTop: Math.max(40, gatewayLabel) });
  }
  if (previous) preserveExtras(built, previous, options.renames);
  definitions.diagrams = [createDi(built, spec, geometry)];
  const { xml } = await moddle.toXML(definitions, { format: true });
  return { xml, warnings };
}

function buildModel(spec, { rootIds = new Map() } = {}) {
  const warnings = [];
  const platform = spec.platform || config.defaultPlatform;
  const moddle = newModdle(platform);
  const rootElements = [];
  const sharedRoots = new Map(); // "Message:name" -> moddle element

  const processId = sanitizeId(spec.processId || 'Process_1');
  const process = moddle.create('bpmn:Process', {
    id: processId,
    name: spec.processName,
    isExecutable: spec.isExecutable !== false,
    flowElements: []
  });
  if (platform === 'camunda7') process.set('camunda:historyTimeToLive', String(spec.historyTimeToLive ?? '180'));
  if (spec.documentation) process.documentation = [moddle.create('bpmn:Documentation', { text: spec.documentation })];

  const usedIds = new Set([processId, ...(spec.elements || []).map(e => sanitizeId(e.id)), ...(spec.flows || []).map(f => f.id).filter(Boolean)]);
  const uniqueId = base => {
    let id = base, n = 2;
    while (usedIds.has(id)) id = `${base}_${n++}`;
    usedIds.add(id);
    return id;
  };

  const getShared = (type, name, extra = {}) => {
    const key = `${type}:${name}`;
    if (!sharedRoots.has(key)) {
      const old = rootIds.get(key);
      const id = old && !usedIds.has(old.id) ? (usedIds.add(old.id), old.id) : uniqueId(sanitizeId(`${type}_${name}`));
      const el = moddle.create(`bpmn:${type}`, { id, ...(old && !old.named ? {} : { name }), ...extra });
      sharedRoots.set(key, el);
    }
    return sharedRoots.get(key);
  };

  const expr = body => moddle.create('bpmn:FormalExpression', { body: String(body) });

  const fixCondition = cond => {
    if (cond == null || cond === '') return cond;
    cond = String(cond).trim();
    if (platform === 'camunda8' && !cond.startsWith('=')) return '=' + cond;
    if (platform === 'camunda7' && !/^[$#]\{/.test(cond)) return '${' + cond + '}';
    return cond;
  };

  const elementsById = new Map();
  const containers = new Map([[processId, process]]);

  // 1) create elements (containers first so children can attach)
  const specElements = (spec.elements || []).map(e => ({ ...e, id: sanitizeId(e.id) }));
  const seen = new Set();
  for (const e of specElements) {
    if (seen.has(e.id)) throw new Error(`Duplicate element id "${e.id}"`);
    seen.add(e.id);
    if (!ELEMENT_TYPES.includes(e.type)) throw new Error(`Unknown element type "${e.type}" (id ${e.id}). Allowed: ${ELEMENT_TYPES.join(', ')}`);
  }

  for (const e of specElements) {
    const bo = moddle.create(`bpmn:${cap(e.type)}`, { id: e.id });
    if (e.name) bo.name = e.name;
    if (e.documentation) bo.documentation = [moddle.create('bpmn:Documentation', { text: e.documentation })];
    if (e.type === 'subProcess') {
      bo.flowElements = [];
      if (e.triggeredByEvent) bo.triggeredByEvent = true;
      containers.set(e.id, bo);
    }
    elementsById.set(e.id, bo);
  }

  const extensionValues = bo => {
    if (!bo.extensionElements) bo.extensionElements = moddle.create('bpmn:ExtensionElements', { values: [] });
    return bo.extensionElements.values;
  };

  // Shared bpmn:Message; Camunda 8 keeps the correlation key on the message itself.
  // Top-level message start events must not have one, every other catching element needs one.
  const messageFor = e => {
    const msg = getShared('Message', e.messageName || e.name || e.id);
    if (platform === 'camunda8' && e.correlationKey && !(e.type === 'startEvent' && !e.parent)) {
      const values = extensionValues(msg);
      const existing = values.find(v => v.$type === 'zeebe:Subscription');
      if (existing && existing.correlationKey !== fixCondition(e.correlationKey)) {
        warnings.push(`${e.id}: message "${msg.name}" already has correlation key ${existing.correlationKey}; ` +
          `Camunda 8 keeps one key per message — use a different messageName for ${e.correlationKey}`);
      }
      if (!existing) {
        values.push(moddle.create('zeebe:Subscription', { correlationKey: fixCondition(e.correlationKey) }));
      }
    }
    return msg;
  };

  // 2) properties
  for (const e of specElements) {
    const bo = elementsById.get(e.id);
    const parentId = e.parent ? sanitizeId(e.parent) : processId;
    const container = containers.get(parentId);
    if (!container) throw new Error(`Element "${e.id}": parent "${e.parent}" is not a subProcess`);
    container.flowElements.push(bo);
    bo.$parent = container;

    // events
    if (e.type.endsWith('Event')) {
      const def = e.eventDefinition && e.eventDefinition !== 'none' ? e.eventDefinition : null;
      if (def) {
        if (!EVENT_DEFINITIONS.includes(def)) throw new Error(`Unknown eventDefinition "${def}" on ${e.id}`);
        const ed = moddle.create(`bpmn:${cap(def)}EventDefinition`, { id: `${e.id}_ed` });
        switch (def) {
          case 'timer': {
            const t = e.timerType || 'duration';
            const key = { duration: 'timeDuration', date: 'timeDate', cycle: 'timeCycle' }[t];
            if (!key) throw new Error(`timerType must be duration|date|cycle (${e.id})`);
            ed[key] = expr(e.timerValue || 'PT1H');
            break;
          }
          case 'message':
            // message throw/end events work without a message (the job worker / delegate sends it);
            // an invented one would even be a deploy error on Camunda 8 (no subscription)
            if (!(/Throw|endEvent/.test(e.type) && !e.messageName)) ed.messageRef = messageFor(e);
            break;
          case 'signal':
            ed.signalRef = getShared('Signal', e.signalName || e.name || e.id);
            break;
          // a catching event without name/code catches every error (escalation): no reference then
          case 'error':
            if (e.errorName || e.errorCode || !isCatching(e)) {
              ed.errorRef = getShared('Error', e.errorName || e.errorCode || e.name || e.id, e.errorCode ? { errorCode: e.errorCode } : {});
            }
            break;
          case 'escalation':
            if (e.escalationName || e.escalationCode || !isCatching(e)) {
              ed.escalationRef = getShared('Escalation', e.escalationName || e.escalationCode || e.name || e.id,
                e.escalationCode ? { escalationCode: e.escalationCode } : {});
            }
            break;
          case 'conditional':
            ed.condition = expr(fixCondition(e.condition || 'true'));
            break;
          case 'link':
            ed.name = e.linkName || e.name || e.id;
            break;
        }
        bo.eventDefinitions = [ed];
      }
      if (e.type === 'boundaryEvent') {
        if (!e.attachedTo) throw new Error(`boundaryEvent "${e.id}" needs attachedTo`);
        const host = elementsById.get(sanitizeId(e.attachedTo));
        if (!host) throw new Error(`boundaryEvent "${e.id}": attachedTo "${e.attachedTo}" not found`);
        bo.attachedToRef = host;
        if (e.cancelActivity === false) bo.cancelActivity = false;
      }
      if (e.type === 'startEvent' && e.interrupting === false) bo.isInterrupting = false;
    }

    if (e.type === 'receiveTask' && (e.messageName || platform !== 'none')) bo.messageRef = messageFor(e);

    // platform specific implementation details
    if (platform === 'camunda8') applyZeebe(moddle, bo, e, extensionValues, warnings);
    if (platform === 'camunda7') applyCamunda7(moddle, bo, e, extensionValues);
  }

  // 3) flows
  const flowsById = new Map();
  for (const [i, f] of (spec.flows || []).entries()) {
    const src = elementsById.get(sanitizeId(f.from));
    const tgt = elementsById.get(sanitizeId(f.to));
    if (!src) throw new Error(`Flow ${f.id || i}: source "${f.from}" not found`);
    if (!tgt) throw new Error(`Flow ${f.id || i}: target "${f.to}" not found`);
    if (src.$parent !== tgt.$parent) {
      throw new Error(`Flow ${f.from} -> ${f.to}: source and target are in different containers (subProcess boundaries cannot be crossed)`);
    }
    const id = sanitizeId(f.id);
    if (flowsById.has(id) || elementsById.has(id)) throw new Error(`Duplicate id "${id}" (flow ${f.from} -> ${f.to})`);
    const flow = moddle.create('bpmn:SequenceFlow', { id, sourceRef: src, targetRef: tgt });
    flowsById.set(id, flow);
    if (f.name) flow.name = f.name;
    if (f.condition) {
      // script conditions (language="javascript", "groovy", ...) are taken verbatim
      flow.conditionExpression = moddle.create('bpmn:FormalExpression', f.conditionLanguage
        ? { body: String(f.condition), language: f.conditionLanguage }
        : { body: fixCondition(f.condition) });
    }
    src.outgoing = [...(src.outgoing || []), flow];
    tgt.incoming = [...(tgt.incoming || []), flow];
    src.$parent.flowElements.push(flow);
    if (f.isDefault) {
      if (!/Gateway$/.test(src.$type) && !/Task$|SubProcess|CallActivity/.test(src.$type)) {
        warnings.push(`Flow ${id}: isDefault only makes sense from a gateway or activity`);
      }
      src.default = flow;
    }
  }

  const collab = buildCollaboration({ moddle, spec, process, processId, elementsById });
  rootElements.push(...sharedRoots.values(), ...(collab ? [collab.collaboration] : []), process);

  const definitions = moddle.create('bpmn:Definitions', {
    id: 'Definitions_' + processId,
    targetNamespace: 'http://bpmn.io/schema/bpmn',
    exporter: 'Camunda Modeler',
    exporterVersion: '5.52.0',
    rootElements
  });
  if (PLATFORMS[platform]) {
    definitions.$attrs['xmlns:modeler'] = NS_MODELER;
    definitions.$attrs['modeler:executionPlatform'] = PLATFORMS[platform].name;
    definitions.$attrs['modeler:executionPlatformVersion'] = spec.platformVersion || PLATFORMS[platform].version;
  }

  // flows whose condition lives in a script resource (language set, no body in the spec): see copyNestedExtras
  const resourceConditionFlows = new Set((spec.flows || []).filter(f => f.conditionLanguage && !f.condition).map(f => sanitizeId(f.id)));
  return { moddle, definitions, process, elementsById, flowsById, collab, warnings, resourceConditionFlows };
}

// ---------------------------------------------------------------- layout

const EVENT_SUB_GAP = 60;   // vertical gap between main flow and event sub-processes
const EVENT_SUB_PAD = 30;   // inner padding of an event sub-process box

/**
 * Compute element geometry with bpmn-auto-layout.
 * Event sub-processes have no incoming flows, so the grid layouter would put them into the first
 * columns and push the main flow to the right. They are laid out separately and placed below.
 *
 * @returns {Map<string, {x,y,width,height}|{waypoints}>}
 */
async function computeLayout(spec) {
  const isEventSub = e => e.type === 'subProcess' && e.triggeredByEvent && !e.parent;
  const eventSubs = spec.elements.filter(isEventSub);
  const owner = new Map(); // element id -> top-level event sub id
  const findOwner = e => {
    let cur = e;
    while (cur) {
      if (isEventSub(cur)) return cur.id;
      cur = cur.parent && spec.elements.find(x => x.id === cur.parent);
    }
    return null;
  };
  for (const e of spec.elements) owner.set(e.id, findOwner(e));

  const pick = ownerId => {
    const elements = spec.elements.filter(e => owner.get(e.id) === ownerId && e.id !== ownerId)
      .map(e => (ownerId && e.parent === ownerId ? (({ parent, ...rest }) => rest)(e) : e));
    const ids = new Set(elements.map(e => e.id));
    return { elements, flows: spec.flows.filter(f => ids.has(f.from) && ids.has(f.to)) };
  };

  const geometry = await layoutPart(pick(null));
  let bb = bbox(geometry);
  let x = bb ? bb.minX : 0;
  const y = bb ? bb.maxY + EVENT_SUB_GAP : 0;

  for (const es of eventSubs) {
    const part = await layoutPart(pick(es.id));
    const pb = bbox(part) || { minX: 0, minY: 0, maxX: 140, maxY: 60 };
    const dx = x + EVENT_SUB_PAD - pb.minX;
    const dy = y + EVENT_SUB_PAD + 10 - pb.minY;
    for (const [id, g] of part) geometry.set(id, shift(g, dx, dy));
    const width = pb.maxX - pb.minX + 2 * EVENT_SUB_PAD;
    const height = pb.maxY - pb.minY + 2 * EVENT_SUB_PAD + 10;
    geometry.set(es.id, { x, y, width, height });
    x += width + 40;
  }
  return geometry;
}

async function layoutPart({ elements, flows }) {
  const geometry = new Map();
  if (!elements.length) return geometry;
  const { moddle, definitions, process, elementsById } = buildModel({ processId: 'Layout', platform: 'none', elements, flows });
  // bpmn-auto-layout draws sub-process content inside the sub-process only if its shape is
  // marked expanded; otherwise children land on the root plane.
  const subProcesses = elements.filter(e => e.type === 'subProcess').map(e => elementsById.get(e.id));
  if (subProcesses.length) {
    definitions.diagrams = [moddle.create('bpmndi:BPMNDiagram', {
      id: 'BPMNDiagram_1',
      plane: moddle.create('bpmndi:BPMNPlane', {
        id: 'BPMNPlane_1', bpmnElement: process,
        planeElement: subProcesses.map(sp => moddle.create('bpmndi:BPMNShape', {
          id: `${sp.id}_di`, bpmnElement: sp, isExpanded: true,
          bounds: moddle.create('dc:Bounds', { x: 0, y: 0, width: 100, height: 80 })
        }))
      })
    })];
  }
  const { xml } = await moddle.toXML(definitions);
  const laidOut = await layoutProcess(xml);
  const { rootElement } = await new BpmnModdle().fromXML(laidOut, 'bpmn:Definitions');
  for (const di of rootElement.diagrams[0].plane.planeElement) {
    const id = di.bpmnElement?.id;
    if (!id) continue;
    if (di.$type === 'bpmndi:BPMNShape') {
      const { x, y, width, height } = di.bounds;
      geometry.set(id, { x, y, width, height });
    } else if (di.$type === 'bpmndi:BPMNEdge') {
      geometry.set(id, { waypoints: di.waypoint.map(p => ({ x: p.x, y: p.y })) });
    }
  }
  return geometry;
}

function bbox(geometry) {
  let b = null;
  const add = (x1, y1, x2, y2) => {
    b = b ? { minX: Math.min(b.minX, x1), minY: Math.min(b.minY, y1), maxX: Math.max(b.maxX, x2), maxY: Math.max(b.maxY, y2) }
      : { minX: x1, minY: y1, maxX: x2, maxY: y2 };
  };
  for (const g of geometry.values()) {
    if (g.waypoints) for (const p of g.waypoints) add(p.x, p.y, p.x, p.y);
    else add(g.x, g.y, g.x + g.width, g.y + g.height + 30); // + room for external labels
  }
  return b;
}

const shift = (g, dx, dy) => g.waypoints
  ? { waypoints: g.waypoints.map(p => ({ x: p.x + dx, y: p.y + dy })) }
  : { ...g, x: g.x + dx, y: g.y + dy };

// Rough text metrics of bpmn-js external labels (11px Arial, wrapped at 90px).
function labelBounds(text) {
  const width = 90, lineHeight = 14;
  const lines = text.split(/\s+/).reduce((acc, word) => {
    const last = acc[acc.length - 1];
    if (last !== undefined && (last + ' ' + word).length * 6 <= width) acc[acc.length - 1] = last + ' ' + word;
    else acc.push(word);
    return acc;
  }, []);
  const longest = Math.min(width, Math.max(...lines.map(l => l.length * 6)));
  return { width: longest, height: lines.length * lineHeight };
}

function createDi({ moddle, process, elementsById, flowsById, collab, warnings }, spec, geometry) {
  const planeElement = [];
  const bounds = g => moddle.create('dc:Bounds', { x: Math.round(g.x), y: Math.round(g.y), width: Math.round(g.width), height: Math.round(g.height) });
  const points = g => g.waypoints.map(p => moddle.create('dc:Point', { x: Math.round(p.x), y: Math.round(p.y) }));

  // pools and lanes first, so they are drawn below the flow elements
  if (collab) {
    for (const [id, bo] of [...collab.participants, ...collab.lanesById]) {
      const g = geometry.get(id);
      if (!g) { warnings.push(`layout: no position computed for ${id}`); continue; }
      planeElement.push(moddle.create('bpmndi:BPMNShape', { id: `${id}_di`, bpmnElement: bo, isHorizontal: true, bounds: bounds(g) }));
    }
  }

  for (const e of spec.elements) {
    const g = geometry.get(e.id);
    if (!g) { warnings.push(`layout: no position computed for ${e.id}`); continue; }
    const shape = moddle.create('bpmndi:BPMNShape', { id: `${e.id}_di`, bpmnElement: elementsById.get(e.id), bounds: bounds(g) });
    if (e.type === 'subProcess') shape.isExpanded = g.isExpanded ?? true;
    if (e.type === 'exclusiveGateway') shape.isMarkerVisible = true;
    if (g.label && e.name) {
      shape.label = moddle.create('bpmndi:BPMNLabel', { bounds: bounds(g.label) });
    } else if (e.type.endsWith('Gateway') && e.name) {
      // Gateway branches leave downwards and would cross a label placed below, so put it above.
      const lb = labelBounds(e.name);
      shape.label = moddle.create('bpmndi:BPMNLabel', {
        bounds: bounds({ x: g.x + g.width / 2 - lb.width / 2, y: g.y - lb.height - 6, width: lb.width, height: lb.height })
      });
    }
    planeElement.push(shape);
  }
  for (const f of spec.flows) {
    const g = geometry.get(f.id);
    if (!g) { warnings.push(`layout: no route computed for flow ${f.id}`); continue; }
    const edge = moddle.create('bpmndi:BPMNEdge', {
      id: `${f.id}_di`, bpmnElement: flowsById.get(f.id),
      waypoint: points(g)
    });
    if (g.label && f.name) edge.label = moddle.create('bpmndi:BPMNLabel', { bounds: bounds(g.label) });
    planeElement.push(edge);
  }
  for (const [id, bo] of collab?.messageFlowsById || []) {
    const g = geometry.get(id);
    if (!g) { warnings.push(`layout: no route computed for message flow ${id}`); continue; }
    const edge = moddle.create('bpmndi:BPMNEdge', { id: `${id}_di`, bpmnElement: bo, waypoint: points(g) });
    if (g.label && bo.name) edge.label = moddle.create('bpmndi:BPMNLabel', { bounds: bounds(g.label) });
    planeElement.push(edge);
  }
  return moddle.create('bpmndi:BPMNDiagram', {
    id: 'BPMNDiagram_1',
    plane: moddle.create('bpmndi:BPMNPlane', { id: 'BPMNPlane_1', bpmnElement: collab ? collab.collaboration : process, planeElement })
  });
}

/** Camunda 8 expressions are FEEL and start with "="; a bare variable name becomes "=name". */
const feel = v => (v == null || v === '' ? v : String(v).trim().startsWith('=') ? String(v).trim() : `=${String(v).trim()}`);

function applyZeebe(moddle, bo, e, ext, warnings) {
  const t = e.type;
  const jobTypes = ['serviceTask', 'sendTask', 'scriptTask', 'businessRuleTask'];
  if (jobTypes.includes(t) || (t === 'intermediateThrowEvent' && e.eventDefinition === 'message') ||
      (t === 'endEvent' && e.eventDefinition === 'message')) {
    if (t === 'scriptTask' && e.script) {
      ext(bo).push(moddle.create('zeebe:Script', { expression: e.script.startsWith('=') ? e.script : '=' + e.script, resultVariable: e.resultVariable || 'result' }));
    } else if (t === 'businessRuleTask' && e.decisionId) {
      ext(bo).push(moddle.create('zeebe:CalledDecision', { decisionId: e.decisionId, resultVariable: e.resultVariable || 'decisionResult' }));
    } else if (e.jobType) {
      // no retries attribute = the engine default (3); written only when set
      ext(bo).push(moddle.create('zeebe:TaskDefinition', { type: e.jobType, ...(e.retries != null ? { retries: String(e.retries) } : {}) }));
    } else if (jobTypes.includes(t)) {
      warnings.push(`${e.id} (${t}): no jobType set – Camunda 8 will require one before deploy`);
    }
    if (e.headers && Object.keys(e.headers).length) {
      ext(bo).push(moddle.create('zeebe:TaskHeaders', {
        values: Object.entries(e.headers).map(([key, value]) => moddle.create('zeebe:Header', { key, value: String(value) }))
      }));
    }
  }
  if (t === 'userTask') {
    ext(bo).push(moddle.create('zeebe:UserTask'));
    if (e.assignee || e.candidateGroups || e.candidateUsers) {
      ext(bo).push(moddle.create('zeebe:AssignmentDefinition', {
        assignee: e.assignee, candidateGroups: e.candidateGroups, candidateUsers: e.candidateUsers
      }));
    }
  }
  // linked / external form: user tasks and the process' start event
  if (t === 'userTask' || (t === 'startEvent' && !e.parent)) {
    if (e.formId != null) ext(bo).push(moddle.create('zeebe:FormDefinition', { formId: e.formId }));
    else if (e.formKey) ext(bo).push(moddle.create('zeebe:FormDefinition', { externalReference: e.formKey }));
  }
  if (t === 'callActivity') {
    if (!e.calledElement) warnings.push(`${e.id} (callActivity): calledElement (processId) missing`);
    else ext(bo).push(moddle.create('zeebe:CalledElement', { processId: e.calledElement, propagateAllChildVariables: e.propagateAllChildVariables ?? true }));
  }
  if (e.inputs?.length || e.outputs?.length) {
    ext(bo).push(moddle.create('zeebe:IoMapping', {
      // a source without "=" is a static value in Zeebe, so it is written exactly as given
      inputParameters: (e.inputs || []).map(p => moddle.create('zeebe:Input', { source: p.source, target: p.target })),
      outputParameters: (e.outputs || []).map(p => moddle.create('zeebe:Output', { source: p.source, target: p.target }))
    }));
  }
  if (e.multiInstance) addMultiInstance(moddle, bo, e, () => {
    const mi = bo.loopCharacteristics;
    mi.extensionElements = moddle.create('bpmn:ExtensionElements', {
      values: [moddle.create('zeebe:LoopCharacteristics', {
        inputCollection: feel(e.multiInstance.collection), inputElement: e.multiInstance.element,
        outputCollection: e.multiInstance.outputCollection, outputElement: feel(e.multiInstance.outputElement)
      })]
    });
  }, feel);
}

function formData(moddle, e) {
  return moddle.create('camunda:FormData', {
    businessKey: e.formBusinessKey,
    fields: e.formFields.map(f => {
      if (!f.id) throw new Error(`${e.id}: every form field needs an id (process variable name)`);
      if (f.type === 'enum' && !f.values?.length) throw new Error(`${e.id}: enum form field "${f.id}" needs values`);
      const field = moddle.create('camunda:FormField', {
        id: f.id, label: f.label, type: f.type, defaultValue: f.defaultValue, datePattern: f.datePattern
      });
      if (f.values?.length) field.values = f.values.map(v => moddle.create('camunda:Value', { id: v.id, name: v.name ?? v.id }));
      if (f.validation?.length) {
        field.validation = moddle.create('camunda:Validation', {
          constraints: f.validation.map(c => moddle.create('camunda:Constraint', { name: c.name, config: c.config }))
        });
      }
      if (f.properties && Object.keys(f.properties).length) {
        field.properties = moddle.create('camunda:Properties', {
          values: Object.entries(f.properties).map(([id, value]) => moddle.create('camunda:Property', { id, value: String(value) }))
        });
      }
      return field;
    })
  });
}

function applyCamunda7(moddle, bo, e, ext) {
  if (e.formFields?.length && (e.type === 'userTask' || (e.type === 'startEvent' && !e.parent))) ext(bo).push(formData(moddle, e));
  const t = e.type;
  const isTask = ['serviceTask', 'sendTask', 'businessRuleTask'].includes(t);
  const isMessageThrow = e.eventDefinition === 'message' && /Throw|endEvent/.test(t);
  if (isTask || isMessageThrow) {
    // the engine reads the implementation of a message throw/end event from its messageEventDefinition
    const impl = isMessageThrow ? bo.eventDefinitions?.[0] : bo;
    if (impl) {
      if (e.jobType) { impl.set('camunda:type', 'external'); impl.set('camunda:topic', e.jobType); }
      if (e.delegateExpression) impl.set('camunda:delegateExpression', e.delegateExpression);
      if (e.javaClass) impl.set('camunda:class', e.javaClass);
      if (e.expression) impl.set('camunda:expression', e.expression);
      if (e.resultVariable && isMessageThrow) impl.set('camunda:resultVariable', e.resultVariable);
    }
    if (t === 'businessRuleTask' && e.decisionId) bo.set('camunda:decisionRef', e.decisionId);
    if (isTask && (e.resultVariable || (t === 'businessRuleTask' && e.decisionId))) {
      bo.set('camunda:resultVariable', e.resultVariable || 'decisionResult');
    }
  }
  if (t === 'scriptTask') {
    // inline script or camunda:resource (carried over): both need the format
    if (e.script || e.scriptFormat) bo.scriptFormat = e.scriptFormat || 'javascript';
    if (e.script) bo.script = e.script;
    if (e.resultVariable) bo.set('camunda:resultVariable', e.resultVariable);
  }
  if (t === 'userTask') {
    if (e.assignee) bo.set('camunda:assignee', e.assignee);
    if (e.candidateGroups) bo.set('camunda:candidateGroups', e.candidateGroups);
    if (e.candidateUsers) bo.set('camunda:candidateUsers', e.candidateUsers);
    if (e.formKey) bo.set('camunda:formKey', e.formKey);
  }
  if (t === 'startEvent' && e.formKey) bo.set('camunda:formKey', e.formKey);
  if (t === 'startEvent' && e.initiator) bo.set('camunda:initiator', e.initiator);
  if (t === 'callActivity' && e.calledElement) bo.calledElement = e.calledElement;
  if (e.multiInstance) addMultiInstance(moddle, bo, e, () => {
    const mi = bo.loopCharacteristics;
    if (e.multiInstance.collection) mi.set('camunda:collection', e.multiInstance.collection);
    if (e.multiInstance.element) mi.set('camunda:elementVariable', e.multiInstance.element);
  }, v => (v == null || v === '' || /^[$#]\{/.test(String(v).trim()) ? v : `\${${String(v).trim()}}`));
}

function addMultiInstance(moddle, bo, e, extend, expression = v => v) {
  if (!/Task$|SubProcess|CallActivity/.test(bo.$type)) return;
  const { sequential, loopCardinality } = e.multiInstance;
  const completionCondition = expression(e.multiInstance.completionCondition);
  const mi = bo.loopCharacteristics = moddle.create('bpmn:MultiInstanceLoopCharacteristics', { isSequential: !!sequential });
  if (loopCardinality) mi.loopCardinality = moddle.create('bpmn:FormalExpression', { body: String(loopCardinality) });
  if (completionCondition) mi.completionCondition = moddle.create('bpmn:FormalExpression', { body: String(completionCondition) });
  extend();
}

function lint(elements, flows, byId) {
  const w = [];
  const incoming = new Map(), outgoing = new Map();
  for (const f of flows) {
    outgoing.set(sanitizeId(f.from), (outgoing.get(sanitizeId(f.from)) || 0) + 1);
    incoming.set(sanitizeId(f.to), (incoming.get(sanitizeId(f.to)) || 0) + 1);
  }
  const topLevel = elements.filter(e => !e.parent);
  if (!topLevel.some(e => e.type === 'startEvent')) w.push('Process has no startEvent');
  if (!topLevel.some(e => e.type === 'endEvent')) w.push('Process has no endEvent');
  for (const e of elements) {
    const inc = incoming.get(e.id) || 0, out = outgoing.get(e.id) || 0;
    const bo = byId.get(e.id);
    const inEventSub = bo.$parent?.triggeredByEvent;
    const isLinkCatch = e.type === 'intermediateCatchEvent' && e.eventDefinition === 'link';
    const isLinkThrow = e.type === 'intermediateThrowEvent' && e.eventDefinition === 'link';
    const isEventSub = e.type === 'subProcess' && e.triggeredByEvent;
    const isCompensation = e.type === 'boundaryEvent' && e.eventDefinition === 'compensate';
    if (!['startEvent', 'boundaryEvent'].includes(e.type) && !isLinkCatch && !isEventSub && inc === 0 && !inEventSub) w.push(`${e.id} has no incoming flow`);
    if (e.type !== 'endEvent' && !isLinkThrow && !isEventSub && !isCompensation && out === 0) w.push(`${e.id} has no outgoing flow`);
    if (e.type === 'exclusiveGateway' || e.type === 'inclusiveGateway') {
      if (out > 1) {
        const outs = flows.filter(f => sanitizeId(f.from) === e.id);
        const unconditioned = outs.filter(f => !f.condition && !f.isDefault);
        if (unconditioned.length) w.push(`Gateway ${e.id}: outgoing flows without condition/isDefault: ${unconditioned.map(f => f.to).join(', ')}`);
      }
    }
  }
  return w;
}

// ---------------------------------------------------------------- XML -> spec

export async function xmlToSpec(xml) {
  const moddle = newModdle(detectPlatform(xml));
  const { rootElement: defs, warnings: importWarnings } = await moddle.fromXML(xml, 'bpmn:Definitions');
  // "lossy" = content that exists in the XML but cannot be expressed in the spec,
  // i.e. it would be dropped if the diagram is rebuilt from the spec.
  const lossy = [];
  // the main process: the one with content (bpmn-js creates empty processes for drawn pools)
  const processes = defs.rootElements.filter(r => r.$type === 'bpmn:Process')
    .sort((a, b) => (b.flowElements?.length || 0) - (a.flowElements?.length || 0) || (b.isExecutable ? 1 : 0) - (a.isExecutable ? 1 : 0));
  const process = processes[0];
  if (!process) throw new Error('No bpmn:Process found');
  const referenced = new Set(defs.rootElements.filter(r => r.$type === 'bpmn:Collaboration')
    .flatMap(c => (c.participants || []).map(p => p.processRef)).filter(Boolean));
  for (const p of processes.slice(1)) {
    if (p.flowElements?.length || !referenced.has(p)) lossy.push(`additional process ${p.id}`);
  }
  for (const v of process.extensionElements?.values || []) lossy.push(`process extension ${v.$type}`);

  const platform = detectPlatform(xml);

  const spec = {
    processId: process.id,
    processName: process.name,
    platform,
    platformVersion: defs.$attrs['modeler:executionPlatformVersion'],
    isExecutable: process.isExecutable,
    documentation: process.documentation?.[0]?.text,
    ...(process.get('camunda:historyTimeToLive') && process.get('camunda:historyTimeToLive') !== '180'
      ? { historyTimeToLive: process.get('camunda:historyTimeToLive') } : {}),
    elements: [],
    flows: []
  };

  const walk = (container, parentId) => {
    for (const a of container.artifacts || []) lossy.push(`${a.id} (${a.$type})`);
    for (const el of container.flowElements || []) {
      if (el.$type === 'bpmn:SequenceFlow') {
        const f = { id: el.id, from: el.sourceRef.id, to: el.targetRef.id };
        if (el.name) f.name = el.name;
        if (el.conditionExpression?.body) f.condition = el.conditionExpression.body;
        if (el.conditionExpression?.language) f.conditionLanguage = el.conditionExpression.language;
        if (el.sourceRef.default === el) f.isDefault = true;
        spec.flows.push(f);
        continue;
      }
      const type = uncap(el.$type.replace('bpmn:', ''));
      if (!ELEMENT_TYPES.includes(type)) { lossy.push(`${el.id} (${el.$type})`); continue; }
      const e = { id: el.id, type };
      if (el.name) e.name = el.name;
      if (parentId) e.parent = parentId;
      if (el.documentation?.[0]?.text) e.documentation = el.documentation[0].text;
      readEvent(el, e);
      readExtensions(el, e, lossy);
      spec.elements.push(e);
      if (type === 'subProcess') {
        if (el.triggeredByEvent) e.triggeredByEvent = true;
        walk(el, el.id);
      }
    }
  };
  walk(process, null);
  readCollaboration(defs, process, spec, lossy);

  return { spec, lossy, warnings: importWarnings.map(w => w.message) };
}

function readEvent(el, e) {
  if (el.attachedToRef) { e.attachedTo = el.attachedToRef.id; if (el.cancelActivity === false) e.cancelActivity = false; }
  if (el.$type === 'bpmn:StartEvent' && el.isInterrupting === false) e.interrupting = false;
  const ed = el.eventDefinitions?.[0];
  if (!ed) return;
  const def = uncap(ed.$type.replace('bpmn:', '').replace('EventDefinition', ''));
  e.eventDefinition = def;
  if (def === 'timer') {
    for (const [k, t] of [['timeDuration', 'duration'], ['timeDate', 'date'], ['timeCycle', 'cycle']]) {
      if (ed[k]) { e.timerType = t; e.timerValue = ed[k].body; }
    }
  }
  if (def === 'message' && ed.messageRef) {
    // an unnamed message is referred to by its id (see rootIds in specToXml)
    e.messageName = ed.messageRef.name ?? ed.messageRef.id;
    const sub = ed.messageRef.extensionElements?.values?.find(v => v.$type === 'zeebe:Subscription');
    if (sub?.correlationKey) e.correlationKey = sub.correlationKey;
  }
  if (def === 'signal' && ed.signalRef) e.signalName = ed.signalRef.name;
  if (def === 'error' && ed.errorRef) { e.errorName = ed.errorRef.name; if (ed.errorRef.errorCode) e.errorCode = ed.errorRef.errorCode; }
  if (def === 'escalation' && ed.escalationRef) { e.escalationName = ed.escalationRef.name; if (ed.escalationRef.escalationCode) e.escalationCode = ed.escalationRef.escalationCode; }
  if (def === 'conditional' && ed.condition) e.condition = ed.condition.body;
  if (def === 'link' && ed.name) e.linkName = ed.name;
}

// Extension elements and attributes that the spec describes: on edit they come from the spec (so the
// user can change or remove them); everything else is carried over from the previous file.
const SPEC_OWNED_ATTRS = new Set([
  'camunda:assignee', 'camunda:candidateGroups', 'camunda:candidateUsers', 'camunda:formKey', 'camunda:initiator',
  'camunda:type', 'camunda:topic', 'camunda:class', 'camunda:delegateExpression', 'camunda:expression',
  'camunda:decisionRef', 'camunda:resultVariable', 'camunda:historyTimeToLive', 'camunda:collection', 'camunda:elementVariable'
]);
const KNOWN_EXTENSIONS = new Set([
  'zeebe:Subscription', 'zeebe:LoopCharacteristics',
  'camunda:FormData',
  'zeebe:TaskDefinition', 'zeebe:TaskHeaders', 'zeebe:AssignmentDefinition', 'zeebe:FormDefinition',
  'zeebe:CalledElement', 'zeebe:CalledDecision', 'zeebe:Script', 'zeebe:IoMapping', 'zeebe:UserTask'
]);

function readExtensions(el, e, lossy) {
  if (el.$type === 'bpmn:ReceiveTask' && el.messageRef) {
    e.messageName = el.messageRef.name ?? el.messageRef.id;
    const sub = el.messageRef.extensionElements?.values?.find(v => v.$type === 'zeebe:Subscription');
    if (sub?.correlationKey) e.correlationKey = sub.correlationKey;
  }
  const values = el.extensionElements?.values || [];
  for (const v of values) {
    // other extensions (listeners, input/output, properties, ...) are carried over on edit, see preserveExtras()
    switch (v.$type) {
      case 'camunda:FormData':
        e.formFields = (v.fields || []).map(f => {
          const field = { id: f.id };
          for (const k of ['label', 'type', 'defaultValue', 'datePattern']) if (f[k] !== undefined) field[k] = f[k];
          if (f.values?.length) field.values = f.values.map(x => ({ id: x.id, ...(x.name !== undefined ? { name: x.name } : {}) }));
          if (f.validation?.constraints?.length) field.validation = f.validation.constraints.map(c => ({ name: c.name, ...(c.config !== undefined ? { config: c.config } : {}) }));
          if (f.properties?.values?.length) field.properties = Object.fromEntries(f.properties.values.map(p => [p.id ?? p.name, p.value]));
          return field;
        });
        if (v.businessKey) e.formBusinessKey = v.businessKey;
        break;
      case 'zeebe:TaskDefinition': e.jobType = v.type; if (v.retries !== undefined) e.retries = Number(v.retries) || v.retries; break;
      case 'zeebe:TaskHeaders': e.headers = Object.fromEntries((v.values || []).map(h => [h.key, h.value])); break;
      case 'zeebe:AssignmentDefinition':
        if (v.assignee) e.assignee = v.assignee;
        if (v.candidateGroups) e.candidateGroups = v.candidateGroups;
        if (v.candidateUsers) e.candidateUsers = v.candidateUsers;
        break;
      // an empty linked form (formId="") is kept as it is: the user may still fill it in the editor
      case 'zeebe:FormDefinition': if (v.formId !== undefined) e.formId = v.formId; if (v.externalReference) e.formKey = v.externalReference; break;
      case 'zeebe:CalledElement': e.calledElement = v.processId; if (v.propagateAllChildVariables === false) e.propagateAllChildVariables = false; break;
      case 'zeebe:CalledDecision': e.decisionId = v.decisionId; e.resultVariable = v.resultVariable; break;
      case 'zeebe:Script': e.script = v.expression; e.resultVariable = v.resultVariable; break;
      case 'zeebe:IoMapping':
        if (v.inputParameters?.length) e.inputs = v.inputParameters.map(p => ({ source: p.source, target: p.target }));
        if (v.outputParameters?.length) e.outputs = v.outputParameters.map(p => ({ source: p.source, target: p.target }));
        break;
    }
  }
  // Camunda 7 attributes (a message throw/end event keeps its implementation on the event definition)
  const g = k => el.get ? el.get(k) : undefined;
  const ed = el.eventDefinitions?.[0];
  const implOf = ed?.$type === 'bpmn:MessageEventDefinition' && /Throw|EndEvent/.test(el.$type) ? ed : el;
  const gi = k => implOf.get ? implOf.get(k) : undefined;
  if (gi('camunda:topic')) e.jobType = gi('camunda:topic');
  if (gi('camunda:delegateExpression')) e.delegateExpression = gi('camunda:delegateExpression');
  if (gi('camunda:class')) e.javaClass = gi('camunda:class');
  if (gi('camunda:expression')) e.expression = gi('camunda:expression');
  if (gi('camunda:resultVariable')) e.resultVariable = gi('camunda:resultVariable');
  if (g('camunda:initiator')) e.initiator = g('camunda:initiator');
  if (g('camunda:assignee')) e.assignee = g('camunda:assignee');
  if (g('camunda:candidateGroups')) e.candidateGroups = g('camunda:candidateGroups');
  if (g('camunda:candidateUsers')) e.candidateUsers = g('camunda:candidateUsers');
  if (g('camunda:formKey')) e.formKey = g('camunda:formKey');
  if (g('camunda:decisionRef')) e.decisionId = g('camunda:decisionRef');
  if (el.$type === 'bpmn:ScriptTask') {
    if (el.script) e.script = el.script;
    if (el.scriptFormat) e.scriptFormat = el.scriptFormat;
  }
  if (el.$type === 'bpmn:CallActivity' && el.calledElement) e.calledElement = el.calledElement;

  const mi = el.loopCharacteristics;
  if (mi?.$type === 'bpmn:MultiInstanceLoopCharacteristics') {
    e.multiInstance = { sequential: !!mi.isSequential };
    const zl = mi.extensionElements?.values?.find(v => v.$type === 'zeebe:LoopCharacteristics');
    if (zl) Object.assign(e.multiInstance, {
      collection: zl.inputCollection, element: zl.inputElement,
      outputCollection: zl.outputCollection, outputElement: zl.outputElement
    });
    if (mi.loopCardinality?.body) e.multiInstance.loopCardinality = mi.loopCardinality.body;
    if (mi.completionCondition?.body) e.multiInstance.completionCondition = mi.completionCondition.body;
    if (mi.get('camunda:collection')) e.multiInstance.collection = mi.get('camunda:collection');
    if (mi.get('camunda:elementVariable')) e.multiInstance.element = mi.get('camunda:elementVariable');
  }
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
}

// ---------------------------------------------------------------- spec edits

export function applyEdits(spec, edits) {
  const s = structuredClone(spec);
  const log = [];
  const renames = new Map(); // old id -> new id
  const idx = id => s.elements.findIndex(e => e.id === id);

  for (const id of edits.removeElements || []) {
    const i = idx(id);
    if (i < 0) throw new Error(`removeElements: "${id}" not found`);
    s.elements.splice(i, 1);
    // children of removed subprocess and attached boundary events
    const doomed = new Set([id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const e of [...s.elements]) {
        if ((e.parent && doomed.has(e.parent)) || (e.attachedTo && doomed.has(e.attachedTo))) {
          doomed.add(e.id); s.elements.splice(idx(e.id), 1); changed = true;
        }
      }
    }
    const before = s.flows.length;
    s.flows = s.flows.filter(f => !doomed.has(f.from) && !doomed.has(f.to));
    if (s.messageFlows) s.messageFlows = s.messageFlows.filter(f => !doomed.has(f.from) && !doomed.has(f.to));
    log.push(`removed ${[...doomed].join(', ')} (+${before - s.flows.length} flows)`);
  }
  for (const sel of edits.removeFlows || []) {
    const before = s.flows.length;
    s.flows = s.flows.filter(f => !(sel.id ? f.id === sel.id : f.from === sel.from && f.to === sel.to));
    if (before === s.flows.length) throw new Error(`removeFlows: no flow matches ${JSON.stringify(sel)}`);
    log.push(`removed flow ${sel.id || sel.from + '->' + sel.to}`);
  }
  if (edits.pool !== undefined) {
    if (edits.pool === null) {
      if (edits.lanes?.length || (edits.lanes === undefined && s.lanes?.length) ||
          (edits.externalPools ?? s.externalPools ?? []).length) {
        throw new Error('pool: cannot remove the pool while lanes or external pools exist (set lanes: [] and externalPools: [] too)');
      }
      delete s.pool; s.messageFlows = [];
      log.push('removed pool');
    } else {
      s.pool = { ...(s.pool || {}), ...edits.pool };
      log.push('set pool');
    }
  }
  if (edits.lanes) {
    s.lanes = edits.lanes;
    const ids = new Set(s.lanes.map(l => l.id));
    for (const e of s.elements) if (e.lane && !ids.has(e.lane)) delete e.lane;
    log.push(`lanes: ${s.lanes.map(l => l.name || l.id).join(', ') || '(none)'}`);
  }
  if (edits.externalPools) {
    s.externalPools = edits.externalPools;
    const ids = new Set(s.externalPools.map(p => p.id));
    const before = (s.messageFlows || []).length;
    const isGone = id => !ids.has(id) && !s.elements.some(e => e.id === id) && id !== s.pool?.id;
    s.messageFlows = (s.messageFlows || []).filter(f => !isGone(f.from) && !isGone(f.to));
    log.push(`external pools: ${s.externalPools.map(p => p.name || p.id).join(', ') || '(none)'}` +
      (before > s.messageFlows.length ? ` (removed ${before - s.messageFlows.length} message flows)` : ''));
  }
  for (const sel of edits.removeMessageFlows || []) {
    const before = (s.messageFlows || []).length;
    s.messageFlows = (s.messageFlows || []).filter(f => !(sel.id ? f.id === sel.id : f.from === sel.from && f.to === sel.to));
    if (before === s.messageFlows.length) throw new Error(`removeMessageFlows: no message flow matches ${JSON.stringify(sel)}`);
    log.push(`removed message flow ${sel.id || sel.from + '->' + sel.to}`);
  }
  for (const upd of edits.updateElements || []) {
    const i = idx(upd.id);
    if (i < 0) throw new Error(`updateElements: "${upd.id}" not found`);
    const { newId, ...rest } = upd;
    if (Array.isArray(rest.formFields)) {
      // a field sent without a type keeps the type it had (or had not); a new one is a string field
      const before = new Map((s.elements[i].formFields || []).map(f => [f.id, f]));
      rest.formFields = rest.formFields.map(f => (f && f.type === undefined
        ? (before.has(f.id) ? { ...f, ...(before.get(f.id).type !== undefined ? { type: before.get(f.id).type } : {}) } : { ...f, type: 'string' })
        : f));
    }
    const merged = { ...s.elements[i], ...rest };
    for (const k of Object.keys(merged)) if (merged[k] === null) delete merged[k];
    s.elements[i] = merged;
    if (newId && newId !== upd.id) {
      merged.id = newId;
      renames.set(upd.id, newId);
      for (const f of s.flows) { if (f.from === upd.id) f.from = newId; if (f.to === upd.id) f.to = newId; }
      for (const e of s.elements) { if (e.parent === upd.id) e.parent = newId; if (e.attachedTo === upd.id) e.attachedTo = newId; }
      for (const f of s.messageFlows || []) { if (f.from === upd.id) f.from = newId; if (f.to === upd.id) f.to = newId; }
    }
    log.push(`updated ${upd.id}`);
  }
  for (const upd of edits.updateFlows || []) {
    const f = s.flows.find(f => upd.id ? f.id === upd.id : f.from === upd.from && f.to === upd.to);
    if (!f) throw new Error(`updateFlows: no flow matches ${JSON.stringify({ id: upd.id, from: upd.from, to: upd.to })}`);
    for (const [k, v] of Object.entries(upd.set || {})) { if (v === null) delete f[k]; else f[k] = v; }
    log.push(`updated flow ${f.id || f.from + '->' + f.to}`);
  }
  for (const e of edits.addElements || []) {
    if (idx(e.id) >= 0) throw new Error(`addElements: "${e.id}" already exists`);
    s.elements.push(e);
    log.push(`added ${e.type} ${e.id}`);
  }
  for (const ins of edits.insertBetween || []) {
    // replace flow from->to with from->element->to
    const f = s.flows.find(f => f.from === ins.from && f.to === ins.to);
    if (!f) throw new Error(`insertBetween: no flow ${ins.from} -> ${ins.to}`);
    if (idx(ins.element.id) >= 0) throw new Error(`insertBetween: "${ins.element.id}" already exists`);
    const parent = s.elements.find(e => e.id === ins.from)?.parent;
    s.elements.push({ ...(parent ? { parent } : {}), ...ins.element });
    s.flows = s.flows.filter(x => x !== f);
    // the first half keeps the original flow's id, so its listeners and properties stay with it
    const { to: _to, ...keep } = f;
    s.flows.push({ ...keep, from: ins.from, to: ins.element.id });
    s.flows.push({ from: ins.element.id, to: ins.to });
    log.push(`inserted ${ins.element.id} between ${ins.from} and ${ins.to}`);
  }
  for (const f of edits.addFlows || []) {
    s.flows.push(f);
    log.push(`added flow ${f.from} -> ${f.to}`);
  }
  for (const f of edits.addMessageFlows || []) {
    s.messageFlows = [...(s.messageFlows || []), f];
    log.push(`added message flow ${f.from} -> ${f.to}`);
  }
  for (const k of ['processName', 'processId', 'platform', 'documentation']) {
    if (edits[k] !== undefined) { s[k] = edits[k]; log.push(`set ${k}`); }
  }
  return { spec: s, log, renames };
}

export async function validateXml(xml) {
  const moddle = newModdle(detectPlatform(xml));
  const { warnings } = await moddle.fromXML(xml, 'bpmn:Definitions');
  return warnings.map(w => w.message);
}

export async function parseXml(xml) {
  const platform = detectPlatform(xml);
  const { rootElement, warnings } = await newModdle(platform).fromXML(xml, 'bpmn:Definitions');
  return {
    definitions: rootElement,
    warnings: warnings.map(w => w.message),
    platform,
    platformVersion: rootElement.$attrs['modeler:executionPlatformVersion']
  };
}

// ---------------------------------------------------------------- layout reuse

/** Positions (shapes, edges, labels) of an existing diagram, keyed by element / flow id. */
export async function extractGeometry(xml) {
  const { definitions } = await parseXml(xml);
  const geometry = new Map();
  for (const diagram of definitions.diagrams || []) {
    for (const di of diagram.plane?.planeElement || []) {
      const id = di.bpmnElement?.id;
      if (!id) continue;
      const label = di.label?.bounds && { x: di.label.bounds.x, y: di.label.bounds.y, width: di.label.bounds.width, height: di.label.bounds.height };
      if (di.$type === 'bpmndi:BPMNShape' && di.bounds) {
        const { x, y, width, height } = di.bounds;
        geometry.set(id, { x, y, width, height, ...(label ? { label } : {}), ...(di.isExpanded !== undefined ? { isExpanded: di.isExpanded } : {}) });
      } else if (di.$type === 'bpmndi:BPMNEdge' && di.waypoint?.length) {
        geometry.set(id, { waypoints: di.waypoint.map(p => ({ x: p.x, y: p.y })), ...(label ? { label } : {}) });
      }
    }
  }
  return geometry;
}

const SHAPE_CLASS = t => t.endsWith('Event') ? 'event' : t.endsWith('Gateway') ? 'gateway' : t === 'subProcess' ? 'sub' : 'activity';

/** Same nodes (by id and shape class), containment, attachments and flows → old positions still fit. */
export function sameStructure(a, b) {
  const sig = spec => {
    const s = normalizeSpec(spec);
    return JSON.stringify([
      s.elements.map(e => [e.id, SHAPE_CLASS(e.type), e.parent || '', e.attachedTo || '']).sort(),
      s.flows.map(f => [f.id, f.from, f.to]).sort(),
      collaborationSignature(s)
    ]);
  };
  return sig(a) === sig(b);
}

// ---------------------------------------------------------------- carry over what the spec does not model

/** Every element with an id in a definitions tree (flow elements, processes, pools, lanes, message flows). */
function indexById(definitions) {
  const map = new Map();
  const visit = el => {
    if (!el || typeof el !== 'object' || !el.$type) return;
    if (el.id && !map.has(el.id)) map.set(el.id, el);
    for (const child of el.flowElements || []) visit(child);
    for (const ls of el.laneSets || []) for (const lane of ls.lanes || []) visit(lane);
    for (const p of el.participants || []) visit(p);
    for (const mf of el.messageFlows || []) visit(mf);
  };
  for (const root of definitions.rootElements || []) visit(root);
  return map;
}

const COMMON_EXTENSIONS = new Set(['camunda:ExecutionListener', 'camunda:Properties', 'zeebe:ExecutionListeners', 'zeebe:Properties']);

function copyExtras(from, to, moddle) {
  const sameType = from.$type === to.$type;
  if (sameType) {
    // namespaced attributes, e.g. camunda:asyncBefore, camunda:jobPriority, camunda:versionTag
    for (const prop of from.$descriptor.properties) {
      const name = prop.ns?.name || prop.name;
      if (!prop.ns || prop.ns.prefix === 'bpmn' || !prop.isAttr || SPEC_OWNED_ATTRS.has(name)) continue;
      // get() returns declared defaults (asyncBefore=false); only explicitly set values are own properties
      const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
      if (own(from, prop.name) && !own(to, prop.name)) to.set(name, from.get(name));
    }
    for (const [name, value] of Object.entries(from.$attrs || {})) {
      if (name.startsWith('xmlns') || SPEC_OWNED_ATTRS.has(name)) continue;
      if (to.$attrs[name] === undefined) to.$attrs[name] = value;
    }
  }
  // extension elements, e.g. listeners, input/output, properties, field injections, connectors
  const values = from.extensionElements?.values || [];
  for (const v of values) {
    if (KNOWN_EXTENSIONS.has(v.$type)) continue;
    if (!sameType && !COMMON_EXTENSIONS.has(v.$type)) continue;
    if (!to.extensionElements) to.extensionElements = moddle.create('bpmn:ExtensionElements', { values: [] });
    if (to.extensionElements.values.some(x => x.$type === v.$type && !v.$type.endsWith('Listener'))) continue;
    v.$parent = to.extensionElements;
    to.extensionElements.values.push(v);
  }
}

/** Copy attributes / extension elements the spec does not model from the previous version of the diagram. */
function preserveExtras(built, previous, renames = new Map()) {
  const { moddle, definitions, process, elementsById, flowsById, collab, resourceConditionFlows } = built;
  const old = indexById(previous);
  const oldIdOf = new Map([...renames].map(([from, to]) => [to, from]));
  const targets = new Map([[process.id, process], ...elementsById, ...flowsById,
    ...(collab ? [...collab.participants, ...collab.lanesById, ...collab.messageFlowsById] : [])]);
  for (const [id, to] of targets) {
    const from = old.get(oldIdOf.get(id) ?? id);
    if (!from) continue;
    copyExtras(from, to, moddle);
    copyNestedExtras(from, to, moddle, resourceConditionFlows);
  }
  keepContainerIds(definitions, previous);
  adoptReferencedRoots(definitions);
}

/** Definitions, collaboration and lane set are rebuilt from the spec: give them back the ids they had. */
function keepContainerIds(definitions, previous) {
  const ids = new Set();
  walkModdle(definitions, el => { if (el.id) ids.add(el.id); });
  const reuse = (to, from) => {
    if (!to || !from?.id || to.id === from.id || ids.has(from.id)) return;
    ids.delete(to.id);
    to.id = from.id;
    ids.add(from.id);
  };
  reuse(definitions, previous);
  if (previous.targetNamespace) definitions.targetNamespace = previous.targetNamespace;
  const collabOf = d => (d.rootElements || []).find(r => r.$type === 'bpmn:Collaboration');
  reuse(collabOf(definitions), collabOf(previous));
  const mainProcess = d => (d.rootElements || []).filter(r => r.$type === 'bpmn:Process')
    .sort((a, b) => (b.flowElements?.length || 0) - (a.flowElements?.length || 0))[0];
  reuse(mainProcess(definitions)?.laneSets?.[0], mainProcess(previous)?.laneSets?.[0]);
}

/** Visit every element of a moddle tree once (containment only, references are not followed). */
function walkModdle(root, visit) {
  const seen = new Set();
  const go = el => {
    if (!el || typeof el !== 'object' || !el.$descriptor || seen.has(el)) return;
    seen.add(el);
    visit(el);
    for (const p of el.$descriptor.properties) {
      if (p.isReference) continue;
      const v = el[p.name];
      if (Array.isArray(v)) v.forEach(go); else go(v);
    }
  };
  go(root);
}

/**
 * Carried-over content can reference a message / error / signal / escalation of the previous version
 * (e.g. camunda:errorEventDefinition of an external task). Exactly those are added to the new
 * definitions — unreferenced old ones are not, so nothing piles up — with a fresh id on a clash.
 */
function adoptReferencedRoots(definitions) {
  const roots = definitions.rootElements;
  const inRoots = new Set(roots);
  // the rebuilt definitions may already have this root (same id, or same type + name): use that one
  const sameRoot = v => roots.find(r => r.$type === v.$type && (r.id === v.id || (v.name != null && r.name === v.name)));
  const ids = new Set();
  const dangling = new Set();
  walkModdle(definitions, el => {
    if (el.id) ids.add(el.id);
    for (const p of el.$descriptor.properties) {
      if (!p.isReference) continue;
      const value = el[p.name];
      const fix = v => {
        if (!v || typeof v !== 'object' || !ROOT_TYPES.test(v.$type) || inRoots.has(v)) return v;
        const existing = sameRoot(v);
        if (existing) return existing;
        dangling.add(v);
        return v;
      };
      if (Array.isArray(value)) value.forEach((v, i) => { value[i] = fix(v); });
      else if (value) el[p.name] = fix(value);
    }
  });
  for (const r of dangling) {
    if (ids.has(r.id)) {
      let n = 2;
      while (ids.has(`${r.id}_${n}`)) n++;
      r.id = `${r.id}_${n}`;
    }
    ids.add(r.id);
    r.$parent = definitions;
    roots.unshift(r);
  }
}

/** Event definition, loop characteristics and condition expression carry attributes of their own. */
function copyNestedExtras(from, to, moddle, resourceConditionFlows = new Set()) {
  const fromEd = from.eventDefinitions?.[0], toEd = to.eventDefinitions?.[0];
  if (fromEd && toEd && fromEd.$type === toEd.$type) copyExtras(fromEd, toEd, moddle);

  const fromLoop = from.loopCharacteristics;
  if (fromLoop && to.loopCharacteristics?.$type === fromLoop.$type) copyExtras(fromLoop, to.loopCharacteristics, moddle);
  // the spec has no standard loops: keep the old one unless the edit added a multi-instance
  else if (fromLoop?.$type === 'bpmn:StandardLoopCharacteristics' && !to.loopCharacteristics && from.$type === to.$type) {
    fromLoop.$parent = to;
    to.loopCharacteristics = fromLoop;
  }
  if (from.isForCompensation && from.$type === to.$type && to.isForCompensation === undefined) to.isForCompensation = true;

  // a condition loaded from a resource (camunda:resource, no body) is not in the spec: keep it while the
  // spec flow still has its language and no condition of its own (an inline condition replaces it,
  // removing condition + conditionLanguage removes it)
  const fromCond = from.conditionExpression;
  if (fromCond && !fromCond.body && !to.conditionExpression && to.$type === 'bpmn:SequenceFlow' && resourceConditionFlows.has(to.id)) {
    fromCond.$parent = to;
    to.conditionExpression = fromCond;
  }
}
