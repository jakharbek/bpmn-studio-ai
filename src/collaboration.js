// Pools (participants), lanes and message flows.
//
// Model: one executable process, optionally wrapped in a pool with lanes, plus "external" pools
// (collapsed, black-box participants such as a customer or a bank) connected by message flows.

const POOL_HEADER = 30;      // vertical title band of a pool
const LANE_PAD_X = 50;       // free space left/right of the content inside lanes
const LANE_PAD_TOP = 40;     // room for labels placed above gateways
const LANE_PAD_BOTTOM = 50;  // room for labels below events / loop-back flows
const SUBROW_GAP = 60;
const LANE_MIN_H = 130;
const EXT_POOL_H = 60;
const EXT_POOL_GAP = 60;

/** Normalize ids of the collaboration parts; adds an implicit pool when lanes/external pools are used. */
export function normalizeCollaboration(spec, sanitizeId, taken) {
  const claim = (id, what) => {
    if (taken.has(id)) throw new Error(`Duplicate id "${id}" (${what})`);
    taken.add(id);
    return id;
  };
  const processId = sanitizeId(spec.processId || 'Process_1');
  const lanes = (spec.lanes || []).map(l => ({ ...l, id: claim(sanitizeId(l.id), 'lane') }));
  const externalPools = (spec.externalPools || []).map(p => ({
    ...p, id: claim(sanitizeId(p.id), 'external pool'), position: p.position === 'bottom' ? 'bottom' : 'top'
  }));
  const rawFlows = spec.messageFlows || [];
  let pool = spec.pool ? { ...spec.pool } : null;
  if (!pool && (lanes.length || externalPools.length || rawFlows.length)) pool = {};
  if (pool) pool.id = claim(sanitizeId(pool.id || `Participant_${processId}`), 'pool');

  const messageFlows = rawFlows.map(f => ({ ...f, from: sanitizeId(f.from), to: sanitizeId(f.to) }));
  for (const f of messageFlows) if (f.id) f.id = claim(sanitizeId(f.id), 'message flow');
  for (const f of messageFlows) {
    if (f.id) continue;
    let id = `MessageFlow_${f.from}_${f.to}`;
    while (taken.has(id)) id += '_';
    f.id = claim(id, 'message flow');
  }
  const out = { lanes, externalPools, messageFlows };
  if (pool) out.pool = pool;
  return out;
}

/**
 * Lane of every top-level flow node. Explicit `lane` wins; otherwise the lane of a predecessor,
 * then of a successor, then the first lane. Boundary events always sit in their host's lane.
 */
export function resolveLanes(spec) {
  const result = new Map();
  if (!spec.lanes?.length) return result;
  const laneIds = new Set(spec.lanes.map(l => l.id));
  const top = spec.elements.filter(e => !e.parent);
  const byId = new Map(top.map(e => [e.id, e]));
  for (const e of top) {
    if (e.lane === undefined || e.lane === null || e.type === 'boundaryEvent') continue;
    if (!laneIds.has(e.lane)) throw new Error(`Element "${e.id}": lane "${e.lane}" not found. Lanes: ${[...laneIds].join(', ')}`);
    result.set(e.id, e.lane);
  }
  const laneOfNode = id => {
    const e = byId.get(id);
    if (!e) return undefined;
    return e.type === 'boundaryEvent' ? result.get(e.attachedTo) : result.get(id);
  };
  const free = () => top.filter(e => e.type !== 'boundaryEvent' && !result.has(e.id));
  for (const direction of ['in', 'out']) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const e of free()) {
        const f = spec.flows.find(f => direction === 'in'
          ? f.to === e.id && laneOfNode(f.from)
          : f.from === e.id && laneOfNode(f.to));
        if (f) { result.set(e.id, laneOfNode(direction === 'in' ? f.from : f.to)); changed = true; }
      }
    }
  }
  for (const e of free()) result.set(e.id, spec.lanes[0].id);
  for (const e of top) if (e.type === 'boundaryEvent') result.set(e.id, result.get(e.attachedTo));
  return result;
}

/** Create bpmn:Collaboration, bpmn:LaneSet and message flows. Returns null without a pool. */
export function buildCollaboration({ moddle, spec, process, processId, elementsById }) {
  if (!spec.pool) return null;
  const participant = moddle.create('bpmn:Participant', { id: spec.pool.id, name: spec.pool.name ?? spec.processName, processRef: process });
  const participants = new Map([[spec.pool.id, participant]]);
  for (const p of spec.externalPools) participants.set(p.id, moddle.create('bpmn:Participant', { id: p.id, name: p.name }));

  const lanesById = new Map();
  if (spec.lanes.length) {
    const laneOf = resolveLanes(spec);
    for (const l of spec.lanes) lanesById.set(l.id, moddle.create('bpmn:Lane', { id: l.id, name: l.name, flowNodeRef: [] }));
    for (const e of spec.elements) {
      if (e.parent) continue;
      lanesById.get(laneOf.get(e.id)).flowNodeRef.push(elementsById.get(e.id));
    }
    process.laneSets = [moddle.create('bpmn:LaneSet', { id: `LaneSet_${processId}`, lanes: [...lanesById.values()] })];
  }

  const messageFlowsById = new Map();
  const side = id => (id === spec.pool.id || elementsById.has(id)) ? 'main' : participants.has(id) ? 'external' : null;
  for (const f of spec.messageFlows) {
    const s = side(f.from), t = side(f.to);
    if (!s) throw new Error(`Message flow ${f.id}: source "${f.from}" is neither an element nor a pool`);
    if (!t) throw new Error(`Message flow ${f.id}: target "${f.to}" is neither an element nor a pool`);
    if (s === 'main' && t === 'main') throw new Error(`Message flow ${f.from} -> ${f.to}: both ends are in the same pool; use a sequence flow`);
    if (f.from === f.to) throw new Error(`Message flow ${f.id}: source and target are the same`);
    const ref = id => participants.get(id) || elementsById.get(id);
    const mf = moddle.create('bpmn:MessageFlow', { id: f.id, sourceRef: ref(f.from), targetRef: ref(f.to) });
    if (f.name) mf.name = f.name;
    messageFlowsById.set(f.id, mf);
  }

  const collaboration = moddle.create('bpmn:Collaboration', {
    id: `Collaboration_${processId}`,
    participants: [...participants.values()],
    messageFlows: [...messageFlowsById.values()]
  });
  return { collaboration, participants, lanesById, messageFlowsById };
}

// ---------------------------------------------------------------- layout

const box = g => ({ x: g.x, y: g.y, w: g.width, h: g.height, cx: g.x + g.width / 2, cy: g.y + g.height / 2, r: g.x + g.width, b: g.y + g.height });
const shiftShape = (g, dy) => ({ ...g, y: g.y + dy });
const shiftEdge = (g, dy) => ({ ...g, waypoints: g.waypoints.map(p => ({ x: p.x, y: p.y + dy })) });

/** Orthogonal route between two shapes (used after elements were moved into lanes). */
function route(sg, tg, { fromBoundary } = {}) {
  const s = box(sg), t = box(tg);
  if (fromBoundary) {
    const down = t.cy >= s.cy;
    const start = { x: s.cx, y: down ? s.b : s.y };
    if (t.x > s.cx) return [start, { x: s.cx, y: t.cy }, { x: t.x, y: t.cy }];
    const yb = Math.max(s.b, t.b) + 25;
    return [start, { x: s.cx, y: yb }, { x: t.cx, y: yb }, { x: t.cx, y: t.b }];
  }
  if (t.x >= s.r) {
    if (Math.abs(s.cy - t.cy) < 2) return [{ x: s.r, y: s.cy }, { x: t.x, y: t.cy }];
    const mx = Math.round((s.r + t.x) / 2);
    return [{ x: s.r, y: s.cy }, { x: mx, y: s.cy }, { x: mx, y: t.cy }, { x: t.x, y: t.cy }];
  }
  // loop back: leave at the bottom, run underneath, enter from the bottom
  const yb = Math.max(s.b, t.b) + 25;
  return [{ x: s.cx, y: s.b }, { x: s.cx, y: yb }, { x: t.cx, y: yb }, { x: t.cx, y: t.b }];
}

/**
 * Add pool / lane / external pool / message flow geometry; with lanes, move the auto-laid-out
 * elements into their lanes (keeping their columns) and re-route the top-level sequence flows.
 */
export function layoutCollaboration(spec, geometry, { padTop = LANE_PAD_TOP } = {}) {
  if (!spec.pool) return;
  const byId = new Map(spec.elements.map(e => [e.id, e]));
  const laneGeo = [];

  if (spec.lanes.length) {
    const laneOf = resolveLanes(spec);
    const top = spec.elements.filter(e => !e.parent && e.type !== 'boundaryEvent');
    const dyOf = new Map();
    let laneY = 0;
    for (const lane of spec.lanes) {
      const rows = [];
      const members = top.filter(e => laneOf.get(e.id) === lane.id && geometry.has(e.id))
        .sort((a, b) => box(geometry.get(a.id)).cy - box(geometry.get(b.id)).cy);
      for (const e of members) {
        const g = box(geometry.get(e.id));
        let row = rows.find(r => Math.abs(r.center - g.cy) < 5);
        if (!row) rows.push(row = { center: g.cy, members: [], height: 0 });
        row.members.push(e);
        row.height = Math.max(row.height, g.h);
      }
      let y = laneY + padTop;
      for (const row of rows) {
        for (const e of row.members) {
          const g = geometry.get(e.id);
          dyOf.set(e.id, y + (row.height - g.height) / 2 - g.y);
        }
        y += row.height + SUBROW_GAP;
      }
      const height = Math.max(LANE_MIN_H, rows.length ? y - SUBROW_GAP + LANE_PAD_BOTTOM - laneY : 0);
      laneGeo.push({ id: lane.id, y: laneY, height });
      laneY += height;
    }

    // move every element with its top-level ancestor (sub-process content, boundary events)
    const anchor = e => {
      let cur = e;
      while (cur.parent) cur = byId.get(cur.parent);
      return cur.type === 'boundaryEvent' ? cur.attachedTo : cur.id;
    };
    for (const e of spec.elements) {
      const dy = dyOf.get(anchor(e)) || 0;
      if (geometry.has(e.id)) geometry.set(e.id, shiftShape(geometry.get(e.id), dy));
    }
    for (const f of spec.flows) {
      const src = byId.get(f.from), tgt = byId.get(f.to);
      if (!geometry.has(f.id) || !src || !tgt) continue;
      if (src.parent) {
        // inside a sub-process: keep the auto-layout route, moved along
        geometry.set(f.id, shiftEdge(geometry.get(f.id), dyOf.get(anchor(src)) || 0));
      } else {
        geometry.set(f.id, { waypoints: route(geometry.get(f.from), geometry.get(f.to), { fromBoundary: src.type === 'boundaryEvent' }) });
      }
    }
  }

  // pool around everything
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const add = (x1, y1, x2, y2) => { minX = Math.min(minX, x1); minY = Math.min(minY, y1); maxX = Math.max(maxX, x2); maxY = Math.max(maxY, y2); };
  for (const e of spec.elements) {
    const g = geometry.get(e.id);
    if (g) add(g.x, g.y, g.x + g.width, g.y + g.height + 30);
  }
  for (const f of spec.flows) for (const p of geometry.get(f.id)?.waypoints || []) add(p.x, p.y, p.x, p.y);
  if (minX === Infinity) { minX = 0; maxX = 300; minY = 0; maxY = 100; }

  const poolX = minX - POOL_HEADER - LANE_PAD_X;
  const poolW = Math.max(maxX + LANE_PAD_X - poolX, 400);
  let poolY, poolH;
  if (laneGeo.length) {
    poolY = laneGeo[0].y;
    poolH = laneGeo.reduce((s, l) => s + l.height, 0);
    for (const l of laneGeo) geometry.set(l.id, { x: poolX + POOL_HEADER, y: l.y, width: poolW - POOL_HEADER, height: l.height });
  } else {
    poolY = minY - padTop;
    poolH = Math.max(maxY - minY + padTop + 20, LANE_MIN_H);
  }
  geometry.set(spec.pool.id, { x: poolX, y: poolY, width: poolW, height: poolH });

  const tops = spec.externalPools.filter(p => p.position !== 'bottom');
  const bottoms = spec.externalPools.filter(p => p.position === 'bottom');
  tops.forEach((p, i) => geometry.set(p.id, {
    x: poolX, y: poolY - (tops.length - i) * (EXT_POOL_H + EXT_POOL_GAP), width: poolW, height: EXT_POOL_H
  }));
  bottoms.forEach((p, i) => geometry.set(p.id, {
    x: poolX, y: poolY + poolH + EXT_POOL_GAP + i * (EXT_POOL_H + EXT_POOL_GAP), width: poolW, height: EXT_POOL_H
  }));

  // message flows: vertical lines; several flows on one element are spread out horizontally,
  // and a flow that would cross another shape steps aside to the nearest free vertical
  const perEnd = new Map();
  for (const f of spec.messageFlows) for (const id of [f.from, f.to]) perEnd.set(id, (perEnd.get(id) || 0) + 1);
  const used = new Map();
  const xFor = (id, g) => {
    const n = perEnd.get(id) || 1, k = used.get(id) || 0;
    used.set(id, k + 1);
    const spread = Math.min(16, (g.width - 10) / Math.max(n, 1));
    return g.x + g.width / 2 + (k - (n - 1) / 2) * spread;
  };
  const ancestors = id => {
    const out = new Set([id]);
    let cur = byId.get(id);
    while (cur) {
      if (cur.attachedTo) out.add(cur.attachedTo);
      cur = cur.parent ? byId.get(cur.parent) : null;
      if (cur) out.add(cur.id);
    }
    // boundary events sitting on the element are part of it visually
    for (const e of spec.elements) if (e.attachedTo && out.has(e.attachedTo)) out.add(e.id);
    return out;
  };
  const obstacles = spec.elements.filter(e => geometry.has(e.id)).map(e => ({ id: e.id, ...box(geometry.get(e.id)) }));
  const blocked = (x1, y1, x2, y2, skip) => obstacles.some(o => !skip.has(o.id) &&
    Math.max(x1, x2) >= o.x - 6 && Math.min(x1, x2) <= o.r + 6 && Math.max(y1, y2) >= o.y - 6 && Math.min(y1, y2) <= o.b + 6);

  /** Route from element `el` (box) to the horizontal edge `edgeY` of a pool, as points element → pool. */
  const elementToPool = (id, el, edgeY) => {
    const skip = ancestors(id);
    const up = edgeY < el.cy;
    const x = xFor(id, { x: el.x, width: el.w });
    const startY = up ? el.y : el.b;
    if (!blocked(x, startY, x, edgeY, skip)) return [{ x, y: startY }, { x, y: edgeY }];
    // leave sideways slightly off-centre (the centre line usually carries a sequence flow)
    const y = el.cy + (up ? -1 : 1) * Math.min(12, el.h / 4);
    for (let d = 20; d <= 400; d += 10) {
      for (const [sideX, fx] of [[el.r, el.r + d], [el.x, el.x - d]]) {
        if (!blocked(sideX, y, fx, y, skip) && !blocked(fx, y, fx, edgeY, skip)) {
          return [{ x: sideX, y }, { x: fx, y }, { x: fx, y: edgeY }];
        }
      }
    }
    return [{ x, y: startY }, { x, y: edgeY }];
  };

  const isPool = id => id === spec.pool.id || spec.externalPools.some(p => p.id === id);
  for (const f of spec.messageFlows) {
    const sg = geometry.get(f.from), tg = geometry.get(f.to);
    if (!sg || !tg) continue;
    const down = tg.y + tg.height / 2 > sg.y + sg.height / 2;
    let waypoints;
    if (!isPool(f.from)) {
      waypoints = elementToPool(f.from, box(sg), down ? tg.y : tg.y + tg.height);
    } else if (!isPool(f.to)) {
      waypoints = elementToPool(f.to, box(tg), down ? sg.y + sg.height : sg.y).reverse();
    } else {
      const x = Math.max(sg.x, tg.x) + Math.min(sg.width, tg.width) / 2;
      waypoints = [{ x, y: down ? sg.y + sg.height : sg.y }, { x, y: down ? tg.y : tg.y + tg.height }];
    }
    geometry.set(f.id, { waypoints });
  }

  // detours may run outside the pool: widen pool, lanes and external pools to contain them
  const xs = spec.messageFlows.flatMap(f => (geometry.get(f.id)?.waypoints || []).map(p => p.x));
  const pg = geometry.get(spec.pool.id);
  const left = Math.min(pg.x, ...xs.map(x => x - 20 - POOL_HEADER));
  const right = Math.max(pg.x + pg.width, ...xs.map(x => x + 30));
  if (left < pg.x || right > pg.x + pg.width) {
    for (const id of [spec.pool.id, ...spec.externalPools.map(p => p.id)]) {
      geometry.set(id, { ...geometry.get(id), x: left, width: right - left });
    }
    for (const l of spec.lanes) {
      geometry.set(l.id, { ...geometry.get(l.id), x: left + POOL_HEADER, width: right - left - POOL_HEADER });
    }
  }
}

/** Ids that need geometry for a diagram to be drawable without auto-layout. */
export function collaborationIds(spec) {
  if (!spec.pool) return [];
  return [spec.pool.id, ...spec.lanes.map(l => l.id), ...spec.externalPools.map(p => p.id), ...spec.messageFlows.map(f => f.id)];
}

/** Structure part of sameStructure(): what makes stored positions invalid. */
export function collaborationSignature(spec) {
  if (!spec.pool) return null;
  let lanes;
  try { lanes = [...resolveLanes(spec)].sort(); } catch { lanes = 'invalid'; }
  return [spec.pool.id, spec.lanes.map(l => l.id), lanes,
    spec.externalPools.map(p => [p.id, p.position]), spec.messageFlows.map(f => [f.id, f.from, f.to]).sort()];
}

// ---------------------------------------------------------------- XML -> spec

/** Fill pool / lanes / external pools / message flows of the spec from parsed definitions. */
export function readCollaboration(defs, process, spec, lossy) {
  const collab = defs.rootElements.find(r => r.$type === 'bpmn:Collaboration');
  const plane = defs.diagrams?.[0]?.plane?.planeElement || [];
  const diOf = el => plane.find(d => d.bpmnElement === el)?.bounds;
  const elementIds = new Set(spec.elements.map(e => e.id));

  if (collab) {
    const main = (collab.participants || []).find(p => p.processRef === process);
    if (!main) {
      lossy.push(`collaboration ${collab.id}: the process is not in a pool`);
    } else {
      spec.pool = { id: main.id, ...(main.name ? { name: main.name } : {}) };
      const mainY = diOf(main)?.y ?? 0;
      spec.externalPools = [];
      for (const p of collab.participants) {
        if (p === main) continue;
        if (p.processRef?.flowElements?.length) {
          lossy.push(`pool ${p.id} with its own process (only black-box external pools are supported)`);
          continue;
        }
        const y = diOf(p)?.y;
        spec.externalPools.push({ id: p.id, ...(p.name ? { name: p.name } : {}), ...(y !== undefined && y > mainY ? { position: 'bottom' } : {}) });
      }
      const known = new Set([main.id, ...spec.externalPools.map(p => p.id), ...elementIds]);
      spec.messageFlows = [];
      for (const mf of collab.messageFlows || []) {
        const from = mf.sourceRef?.id, to = mf.targetRef?.id;
        if (!known.has(from) || !known.has(to)) { lossy.push(`${mf.id} (message flow to an element outside the main pool)`); continue; }
        spec.messageFlows.push({ id: mf.id, from, to, ...(mf.name ? { name: mf.name } : {}) });
      }
      for (const a of collab.artifacts || []) lossy.push(`${a.id} (${a.$type})`);
    }
  }

  const laneSets = process.laneSets || [];
  if (laneSets.length > 1) lossy.push('more than one lane set');
  const lanes = laneSets[0]?.lanes || [];
  if (lanes.length) {
    if (!spec.pool) lossy.push('lanes outside a pool');
    spec.lanes = [];
    const byId = new Map(spec.elements.map(e => [e.id, e]));
    // top-to-bottom as drawn (the XML order is creation order)
    const ordered = [...lanes].sort((a, b) => (diOf(a)?.y ?? 0) - (diOf(b)?.y ?? 0));
    for (const lane of ordered) {
      if (lane.childLaneSet?.lanes?.length) lossy.push(`${lane.id}: nested lanes`);
      spec.lanes.push({ id: lane.id, ...(lane.name ? { name: lane.name } : {}) });
      for (const ref of lane.flowNodeRef || []) {
        const e = byId.get(ref.id);
        if (e && !e.parent && e.type !== 'boundaryEvent') e.lane = lane.id;
      }
    }
  }
}
