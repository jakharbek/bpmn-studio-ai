// The assistant's tool loop: model turn → run tools on the studio server → model turn … until done.
import { CUSTOM_PRESETS, PROVIDERS, ProviderError, providerLabel, runTurn, testConnection, toolResultMessages, userMessage } from './providers.js';

export { CUSTOM_PRESETS, PROVIDERS, ProviderError, providerLabel, testConnection };

const MAX_TURNS = 25;
// Tools with effects outside the studio: the user confirms each call in the browser.
const CONFIRM_TOOLS = new Set(['bpmn_deploy']);

/**
 * @param {object} opts
 * @param {object} opts.settings         { provider, apiKey, model, baseUrl, effort }
 * @param {object[]} opts.history        provider-native message history (mutated)
 * @param {string} opts.text             user message
 * @param {(event: object) => void} opts.onEvent
 *   step {n} – a model turn starts · text {delta} · thinking {delta} · tool_draft {index, name, chars} – a tool
 *   call being generated · tool {id, name, input} – runs now · tool_result {id, ok, summary, content, ms} ·
 *   usage · segment · reset · note {text}
 * @param {(call: object) => Promise<boolean>} [opts.confirm]
 * @param {AbortSignal} [opts.signal]
 * @param {object} opts.studio           { config(): Promise<{systemPrompt, tools}>, callTool(name, args): Promise<{ok, result?, error?}> }
 */
export async function runAssistant({ settings, history, text, onEvent, confirm, signal, studio, fetchImpl }) {
  if (!PROVIDERS[settings.provider]) throw new ProviderError('Ассистент не настроен: выберите тип подключения в настройках');
  if (PROVIDERS[settings.provider].needsBaseUrl && !settings.baseUrl) throw new ProviderError('Укажите Base URL провайдера в настройках');
  const { systemPrompt, tools } = await studio.config();
  const start = history.length;
  history.push(userMessage(text));
  let usage = { input: 0, output: 0 };

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      if (turn > 0) onEvent({ type: 'segment' });
      onEvent({ type: 'step', n: turn + 1 });
      const result = await runTurn(settings, {
        system: systemPrompt, history, tools, signal, fetchImpl,
        onText: delta => onEvent({ type: 'text', delta }),
        onProgress: ev => onEvent(ev),
        onReset: () => onEvent({ type: 'reset' })
      });
      history.push(...result.append);
      if (result.usage) {
        usage = { input: usage.input + (result.usage.input || 0), output: usage.output + (result.usage.output || 0) };
        onEvent({ type: 'usage', usage });
      }
      if (result.pause) continue;
      if (!result.toolCalls.length) return { usage };

      const results = [];
      try {
        for (const call of result.toolCalls) {
          onEvent({ type: 'tool', id: call.id, name: call.name, input: call.input });
          const started = Date.now();
          const { content, isError, summary } = await executeCall(call, { studio, confirm, signal });
          onEvent({ type: 'tool_result', id: call.id, ok: !isError, summary, content, ms: Date.now() - started });
          results.push({ id: call.id, content, isError });
        }
      } catch (err) {
        // stopped between calls: what already ran (a save, a deploy) stays in the conversation,
        // the calls that did not run get a result saying so — the model must not repeat or forget them
        if (results.length) {
          const why = err?.name === 'AbortError' ? 'Not run: the user stopped the assistant.' : `Not run: ${err?.message || err}`;
          for (const call of result.toolCalls.slice(results.length)) results.push({ id: call.id, content: why, isError: true });
          history.push(...toolResultMessages(settings, results));
        }
        throw err;
      }
      history.push(...toolResultMessages(settings, results));
    }
    throw new ProviderError(`Ассистент сделал ${MAX_TURNS} шагов и остановлен. Уточните задачу или продолжите.`);
  } catch (err) {
    // keep the history valid for the next request: drop an unfinished exchange
    trimToValid(history, start);
    throw err;
  }
}

/**
 * Make the history valid for the next request: drop a trailing assistant turn whose tool calls have
 * no results (or that is empty). Completed turns of this run stay — their tools really ran.
 * If nothing but the user's message is left, drop it too (the user sends it again).
 */
function trimToValid(history, start) {
  const last = history[history.length - 1];
  const dangling = history.length > start && last && last.role === 'assistant' && (
    (Array.isArray(last.tool_calls) && last.tool_calls.length) ||
    (Array.isArray(last.content) && (!last.content.length || last.content.some(b => b.type === 'tool_use'))) ||
    (!last.content && !last.tool_calls?.length));
  if (dangling) history.length -= 1;
  if (history.length === start + 1) history.length = start;
}

async function executeCall(call, { studio, confirm, signal }) {
  let args = call.input;
  if (typeof args === 'string') {
    try {
      args = args.trim() ? JSON.parse(args) : {};
    } catch {
      return { isError: true, content: `Invalid JSON in the arguments of ${call.name}; send them again as a valid JSON object.`, summary: 'неверные аргументы' };
    }
  }
  // no confirmation callback = no permission
  if (CONFIRM_TOOLS.has(call.name) && !(confirm && await confirm({ ...call, args }))) {
    return { isError: true, content: 'The user declined this action.', summary: 'отменено пользователем' };
  }
  if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  let res;
  try {
    res = await studio.callTool(call.name, args);
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    res = { ok: false, error: err?.message };
  }
  if (!res?.ok) {
    const error = String(res?.error ?? 'unknown error');
    return { isError: true, content: `Error: ${error}`, summary: error.slice(0, 300) };
  }
  const content = typeof res.result === 'string' ? res.result : JSON.stringify(res.result);
  return { isError: false, content, summary: summarize(res.result) };
}

function summarize(r) {
  if (!r || typeof r !== 'object') return '';
  const parts = [];
  if (r.saved) parts.push(r.saved);
  if (r.restored) parts.push(`восстановлен ${r.restored}`);
  if (r.renamed && r.renamed !== 'unchanged') parts.push(`переименовано: ${r.renamed}`);
  if (r.sent) parts.push(`отправлено на ${r.target} · HTTP ${r.status}`);
  if (r.layout === 'kept') parts.push('раскладка сохранена');
  if (Array.isArray(r.files)) parts.push(`${r.files.length} файл(ов)`);
  if (Array.isArray(r.deployErrors)) parts.push(r.deployErrors.length ? `ошибок деплоя: ${r.deployErrors.length}` : 'деплой: OK');
  if (Array.isArray(r.modelingIssues) && r.modelingIssues.length) parts.push(`замечаний: ${r.modelingIssues.length}`);
  return parts.join(' · ');
}
