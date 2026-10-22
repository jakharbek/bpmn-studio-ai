// Linting with the same rule sets Camunda Desktop Modeler uses (bpmnlint + camunda-compat).
import { Linter } from 'bpmnlint';
import StaticResolver from 'bpmnlint/lib/resolver/static-resolver.js';
import { parseXml } from './bpmn.js';
import { platformVersion } from './config.js';
import { COMPAT_CONFIGS, LINT_CACHE } from './lintRules.generated.js';

// rules are bundled statically (scripts/gen-lint-rules.mjs), so linting works in the browser too
const resolver = new StaticResolver(LINT_CACHE);

// Rules from bpmnlint:recommended that are pure style noise for generated diagrams.
const STYLE_OFF = {
  'no-bpmndi': 'off'
};

/** Rule set for the diagram's engine version; the nearest available one if there is no exact match. */
export function compatConfigName(platform, version) {
  const prefix = platform === 'camunda7' ? 'camunda-platform' : 'camunda-cloud';
  const [major, minor] = String(version || platformVersion(platform)).split('.').map(Number);
  const exact = `${prefix}-${major}-${minor}`;
  if (COMPAT_CONFIGS.includes(exact)) return exact;
  const rank = (ma, mi) => ma * 1000 + mi;
  const want = rank(major, minor);
  return COMPAT_CONFIGS.filter(k => k.startsWith(prefix + '-'))
    .map(k => { const [ma, mi] = k.slice(prefix.length + 1).split('-').map(Number); return { k, d: Math.abs(rank(ma, mi) - want) }; })
    .sort((a, b) => a.d - b.d)[0].k;
}

/**
 * What the Camunda 7 engine's BPMN parser rejects at deployment. The camunda-compat rule set for
 * Camunda 7 only checks history time to live, so the common parse errors are checked here.
 */
function camunda7Checks(definitions) {
  const errors = [];
  const add = (rule, id, message) => errors.push(`[camunda7/${rule}] ${id}: ${message}`);
  const attr = (el, name) => el.get ? el.get(`camunda:${name}`) : undefined;
  const processes = definitions.rootElements.filter(r => r.$type === 'bpmn:Process' && r.flowElements?.length);
  if (processes.length && !processes.some(p => p.isExecutable)) {
    add('executable-process', processes[0].id, 'Process is not executable (isExecutable="false"), the engine will not create a process definition');
  }
  const walk = container => {
    for (const el of container.flowElements || []) {
      const t = el.$type;
      if (['bpmn:ServiceTask', 'bpmn:SendTask', 'bpmn:BusinessRuleTask'].includes(t)) {
        const impl = ['class', 'delegateExpression', 'expression', 'type'].some(k => attr(el, k)) ||
          (t === 'bpmn:BusinessRuleTask' && attr(el, 'decisionRef'));
        const connector = (el.extensionElements?.values || []).some(v => v.$type === 'camunda:Connector');
        if (!impl && !connector) add('implementation', el.id, 'Needs an implementation: external task topic, delegate expression, Java class, expression or connector');
        if (attr(el, 'type') === 'external' && !attr(el, 'topic')) add('implementation', el.id, 'External task needs a topic');
      }
      if (t === 'bpmn:ScriptTask') {
        if (!el.scriptFormat) add('script', el.id, 'Script task needs a script format (e.g. javascript, groovy)');
        if (!el.script && !attr(el, 'resource')) add('script', el.id, 'Script task needs a script or a resource');
      }
      if (t === 'bpmn:CallActivity' && !el.calledElement && !attr(el, 'caseRef')) add('called-element', el.id, 'Call activity needs calledElement (process key)');
      for (const ed of el.eventDefinitions || []) {
        if (ed.$type === 'bpmn:TimerEventDefinition' && !(ed.timeDate?.body || ed.timeDuration?.body || ed.timeCycle?.body)) {
          add('timer', el.id, 'Timer needs a date, duration or cycle');
        }
        if (ed.$type === 'bpmn:MessageEventDefinition' && !/Throw|EndEvent/.test(t) && !ed.messageRef?.name) {
          add('message-reference', el.id, 'Message event needs a message with a name');
        }
        if (ed.$type === 'bpmn:SignalEventDefinition' && !ed.signalRef?.name) add('signal-reference', el.id, 'Signal event needs a signal with a name');
        if (ed.$type === 'bpmn:ErrorEventDefinition' && t === 'bpmn:EndEvent' && !ed.errorRef?.errorCode) {
          add('error-reference', el.id, 'Error end event needs an error with an error code');
        }
      }
      if (t === 'bpmn:ReceiveTask' && el.messageRef && !el.messageRef.name) add('message-reference', el.id, 'Message needs a name');
      if (t === 'bpmn:SubProcess') walk(el);
    }
  };
  for (const p of processes) walk(p);
  return errors;
}

/**
 * @returns {Promise<{ errors: string[], warnings: string[], config: string[] }>}
 */
export async function lintXml(xml) {
  const { definitions, platform, platformVersion } = await parseXml(xml);
  const extend = ['bpmnlint:recommended'];
  if (platform === 'camunda8' || platform === 'camunda7') {
    extend.push(`plugin:camunda-compat/${compatConfigName(platform, platformVersion)}`);
  }
  const linter = new Linter({ config: { extends: extend, rules: STYLE_OFF }, resolver });
  const reports = await linter.lint(definitions);

  const errors = [], warnings = [];
  for (const [rule, items] of Object.entries(reports)) {
    for (const r of items) {
      const line = `[${rule}] ${r.id ? r.id + ': ' : ''}${r.message}`;
      (r.category === 'error' ? errors : warnings).push(line);
    }
  }
  if (platform === 'camunda7') errors.push(...camunda7Checks(definitions));
  return { errors, warnings, config: extend };
}

/** Linter output split into what blocks deployment (camunda-compat) and modeling-quality hints. */
export async function checkXml(xml) {
  try {
    const { errors, warnings } = await lintXml(xml);
    const isCompat = l => l.startsWith('[camunda-compat/') || l.startsWith('[camunda7/');
    return {
      deployErrors: errors.filter(isCompat),
      modelingIssues: [...errors.filter(l => !isCompat(l)), ...warnings]
    };
  } catch (err) {
    return { lintFailed: String(err.message || err) };
  }
}
