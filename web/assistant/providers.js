// Model providers for the BPMN Studio assistant. All four speak "one turn with tools":
//   OpenAI API, OpenRouter API, Local API (the downloadable claude-cli proxy) → OpenAI Chat Completions
//   Claude API → Anthropic Messages API through the official SDK
import Anthropic from '@anthropic-ai/sdk';

export const PROVIDERS = {
  openai: {
    label: 'OpenAI API', kind: 'openai', needsKey: true, baseUrl: 'https://api.openai.com/v1',
    keyHint: 'sk-…', help: 'Ключ: platform.openai.com → API keys'
  },
  anthropic: {
    label: 'Claude API', kind: 'anthropic', needsKey: true, defaultModel: 'claude-opus-5-5',
    keyHint: 'sk-ant-…', help: 'Ключ: platform.claude.com → API keys'
  },
  openrouter: {
    label: 'OpenRouter API', kind: 'openai', needsKey: true, baseUrl: 'https://openrouter.ai/api/v1',
    keyHint: 'sk-or-…', help: 'Ключ: openrouter.ai → Keys'
  },
  local: {
    label: 'Local API', kind: 'openai', needsKey: false, baseUrl: 'http://127.0.0.1:8138/v1', defaultModel: 'opus',
    keyHint: 'токен из config.json сервера (подставляется сам при скачивании)',
    help: 'Локальный сервер с Claude Code на вашем компьютере (подписка Claude, без API-ключа)'
  },
  custom: {
    label: 'Custom LLM Provider', kind: 'openai', needsKey: false, needsBaseUrl: true,
    keyHint: 'если сервис требует ключ', help: 'Любой OpenAI-совместимый API (Chat Completions + tools)'
  }
};

/** Starting points for the Custom provider; any OpenAI-compatible endpoint works. */
export const CUSTOM_PRESETS = [
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', hint: 'Ключ: platform.deepseek.com → API keys' },
  { id: 'qwen-intl', name: 'Qwen (Alibaba Cloud, international)', baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', hint: 'Ключ: Alibaba Cloud Model Studio (DashScope)' },
  { id: 'qwen-cn', name: 'Qwen (Alibaba Cloud, China)', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', hint: 'Ключ: DashScope (материковый Китай)' },
  { id: 'mistral', name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', hint: 'Ключ: console.mistral.ai' },
  { id: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', hint: 'Ключ: console.groq.com' },
  { id: 'ollama', name: 'Ollama (на этом компьютере)', baseUrl: 'http://127.0.0.1:11434/v1', hint: 'Ключ не нужен. Разрешите адрес студии: OLLAMA_ORIGINS=<адрес студии> ollama serve' },
  { id: 'lmstudio', name: 'LM Studio (на этом компьютере)', baseUrl: 'http://127.0.0.1:1234/v1', hint: 'Ключ не нужен. Включите CORS в настройках сервера LM Studio' },
  { id: 'other', name: '', baseUrl: '', hint: 'Укажите Base URL OpenAI-совместимого API (обычно оканчивается на /v1)' }
];

/** Display name of the configured provider. */
export const providerLabel = s => (s.provider === 'custom' && s.name) ? s.name : PROVIDERS[s.provider]?.label || s.provider;

// Server-side refusal fallback ("default" routing) is available for these models on the Claude API.
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

export class ProviderError extends Error {
  constructor(message, { status, retryable = false } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

const baseUrlOf = s => (s.baseUrl || PROVIDERS[s.provider].baseUrl || '').replace(/\/+$/, '');

function openAiHeaders(s) {
  const h = { 'content-type': 'application/json' };
  // extra headers of a custom provider first, so they cannot replace the content type or auth
  if (s.provider === 'custom' && s.headers && typeof s.headers === 'object') {
    for (const [k, v] of Object.entries(s.headers)) if (k && typeof v === 'string') h[k.toLowerCase()] = v;
    h['content-type'] = 'application/json';
  }
  if (s.apiKey) h.authorization = `Bearer ${s.apiKey}`;
  if (s.provider === 'openrouter') {
    h['HTTP-Referer'] = globalThis.location?.origin || 'https://bpmn-studio.local';
    h['X-Title'] = 'BPMN Studio';
  }
  return h;
}

async function httpError(res, s) {
  let detail = '';
  try {
    const body = await res.json();
    detail = body?.error?.message || body?.message || JSON.stringify(body).slice(0, 300);
  } catch { /* not JSON */ }
  const who = providerLabel(s);
  if (res.status === 401 || res.status === 403) return new ProviderError(`${who}: доступ запрещён (${res.status}) — проверьте ключ/токен. ${detail}`, { status: res.status });
  if (res.status === 429) return new ProviderError(`${who}: превышен лимит запросов (429). ${detail}`, { status: 429, retryable: true });
  return new ProviderError(`${who}: HTTP ${res.status}. ${detail}`, { status: res.status, retryable: res.status >= 500 });
}

function networkError(err, s) {
  if (err.name === 'AbortError') return err;
  if (s.provider === 'local') {
    return new ProviderError(`Браузер не смог обратиться к локальному серверу (${baseUrlOf(s)}). Проверьте: ` +
      '1) сервер запущен (node server.js) и порт совпадает; ' +
      '2) сервер скачан не слишком давно — старые версии принимают запросы только с адреса студии, откуда их скачали: скачайте сервер заново на этой странице; ' +
      '3) Chrome мог спросить «разрешить доступ к устройствам в локальной сети» — разрешите (значок слева от адреса сайта). ' +
      (err.message || ''));
  }
  if (s.provider === 'custom') {
    return new ProviderError(`${providerLabel(s)}: браузер не смог обратиться к ${baseUrlOf(s)} — адрес недоступен или сервис не разрешает запросы из браузера (CORS). ${err.message || ''}`);
  }
  return new ProviderError(`${PROVIDERS[s.provider].label}: сеть недоступна — ${err.message || err}`);
}

// ---------------------------------------------------------------- connection check

/** @returns {Promise<{ ok: true, models: string[], detail: string }>} */
export async function testConnection(s, { fetchImpl = fetch } = {}) {
  const p = PROVIDERS[s.provider];
  if (!p) throw new ProviderError('Неизвестный провайдер');
  if (p.needsKey && !s.apiKey) throw new ProviderError('Укажите API-ключ');
  if (p.needsBaseUrl && !/^https?:\/\/[^\s/]+/.test(s.baseUrl || '')) throw new ProviderError('Укажите Base URL (http:// или https://)');

  if (p.kind === 'anthropic') {
    const client = anthropicClient(s, fetchImpl);
    try {
      const models = [];
      for await (const m of client.models.list({ limit: 100 })) models.push(m.id);
      return { ok: true, models, detail: `Claude API доступен, моделей: ${models.length}` };
    } catch (err) {
      throw anthropicError(err);
    }
  }

  let detail = '';
  if (s.provider === 'local') {
    const root = baseUrlOf(s).replace(/\/v1$/, '');
    let health;
    try {
      const res = await fetchImpl(`${root}/health?refresh`, { headers: openAiHeaders(s) });
      if (!res.ok) throw await httpError(res, s);
      health = await res.json();
    } catch (err) {
      throw err instanceof ProviderError ? err : networkError(err, s);
    }
    if (!health.claude?.available) throw new ProviderError(`Сервер запущен, но Claude Code недоступен: ${health.claude?.error || 'нет ответа'}`);
    if (!health.capabilities?.tools) throw new ProviderError('Сервер не поддерживает вызов функций — скачайте актуальную версию локального сервера');
    detail = `Локальный сервер ${health.version}, ${health.claude.version}`;
  }
  let res;
  try {
    res = await fetchImpl(`${baseUrlOf(s)}/models`, { headers: openAiHeaders(s) });
  } catch (err) {
    throw networkError(err, s);
  }
  // some OpenAI-compatible services have no model list: check the configured model with a tiny request
  if (s.provider === 'custom' && [404, 405, 501].includes(res.status)) return pingModel(s, fetchImpl);
  if (!res.ok) throw await httpError(res, s);
  const body = await res.json();
  const models = (body.data || body.models || []).map(m => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean).sort();
  return { ok: true, models, detail: detail || `${providerLabel(s)} доступен, моделей: ${models.length}` };
}

async function pingModel(s, fetchImpl) {
  if (!s.model) throw new ProviderError(`${providerLabel(s)} не отдаёт список моделей — укажите модель вручную и проверьте ещё раз`);
  let res;
  try {
    res = await fetchImpl(`${baseUrlOf(s)}/chat/completions`, {
      method: 'POST', headers: openAiHeaders(s),
      body: JSON.stringify({ model: s.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 })
    });
  } catch (err) {
    throw networkError(err, s);
  }
  if (!res.ok) throw await httpError(res, s);
  return { ok: true, models: [], detail: `${providerLabel(s)} отвечает, модель ${s.model} доступна (список моделей сервис не отдаёт)` };
}

// ---------------------------------------------------------------- OpenAI Chat Completions (OpenAI / OpenRouter / Local)

/**
 * Read an SSE response body and yield the JSON payload of each event: "data:" lines are joined until
 * a blank line; the final event is processed even without a trailing newline.
 */
async function* sseEvents(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let data = [];
  const flush = function* () {
    if (!data.length) return;
    const payload = data.join('\n');
    data = [];
    if (payload === '[DONE]') return;
    try { yield JSON.parse(payload); } catch { /* keep-alive or garbage */ }
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buf += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (line === '') yield* flush();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (done) {
        if (buf.startsWith('data:')) data.push(buf.slice(5).replace(/^ /, ''));
        yield* flush();
        return;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

/**
 * One assistant turn. History is in OpenAI message format; returns the assistant message to append
 * and the tool calls to run.
 */
async function openAiTurn(s, { system, history, tools, onText, onProgress, signal, fetchImpl = fetch }) {
  const body = {
    model: s.model,
    messages: [{ role: 'system', content: system }, ...history],
    tools: tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
    stream: true
  };
  body.stream_options = { include_usage: true };
  if (s.provider === 'local' && s.effort && s.effort !== 'default') body.effort = s.effort;

  let res;
  try {
    res = await fetchImpl(`${baseUrlOf(s)}/chat/completions`, { method: 'POST', headers: openAiHeaders(s), body: JSON.stringify(body), signal });
  } catch (err) {
    throw networkError(err, s);
  }
  if (!res.ok) throw await httpError(res, s);

  let content = '';
  const calls = [];
  let finish = null;
  let usage = null;
  let sawProgress = false; // the local server reports the whole answer's progress itself
  for await (const chunk of sseEvents(res)) {
    if (chunk.error) throw new ProviderError(`${providerLabel(s)}: ${chunk.error.message || JSON.stringify(chunk.error)}`);
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const d = choice.delta || {};
    if (d.content) { content += d.content; onText?.(d.content); }
    // reasoning, where the provider streams it: DeepSeek / Qwen "reasoning_content", OpenRouter "reasoning".
    // Shown to the user only; never sent back (some providers reject it in the history).
    const reasoning = typeof d.reasoning_content === 'string' ? d.reasoning_content : typeof d.reasoning === 'string' ? d.reasoning : '';
    if (reasoning) onProgress?.({ type: 'thinking', delta: reasoning });
    // the local server reports how far a structured answer (tool calls) has been generated
    if (chunk.x_bpmn_progress) {
      sawProgress = true;
      onProgress?.({ type: 'tool_draft', index: 0, name: '', chars: Number(chunk.x_bpmn_progress.chars) || 0 });
    }
    for (const tc of d.tool_calls || []) {
      // providers differ: some omit "index" on continuation chunks, some repeat the name in every chunk
      let i = tc.index;
      if (typeof i !== 'number') {
        // known id → that call; new id → a new call; no id → continuation of the last call, unless the
        // chunk names a function while the last call's arguments are already complete JSON (a second call)
        const known = tc.id ? calls.findIndex(c => c?.id === tc.id) : -1;
        const last = calls[calls.length - 1];
        const startsNew = !tc.id && !!tc.function?.name && !!last?.name && isCompleteJson(last.arguments);
        i = known >= 0 ? known : (tc.id || !calls.length || startsNew) ? calls.length : calls.length - 1;
      }
      const call = calls[i] || (calls[i] = { id: '', name: '', arguments: '' });
      if (tc.id && !call.id) call.id = tc.id;
      if (tc.function?.name && !call.name) call.name = tc.function.name;
      if (tc.function?.arguments) call.arguments += tc.function.arguments;
      if (!sawProgress) onProgress?.({ type: 'tool_draft', index: i, name: call.name, chars: call.arguments.length });
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  }
  const toolCalls = calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${Date.now()}_${i}` }));
  if (finish === 'length' && toolCalls.length) throw new ProviderError('Ответ модели обрезан (лимит токенов) посреди вызова инструмента');

  const message = { role: 'assistant', content: content || null };
  if (toolCalls.length) message.tool_calls = toolCalls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } }));
  return {
    // an empty turn (no text, no tool calls, e.g. a content filter) is not kept: the API would reject it later
    append: content || toolCalls.length ? [message] : [],
    toolCalls: toolCalls.map(c => ({ id: c.id, name: c.name, input: c.arguments })),
    usage: usage && { input: usage.prompt_tokens, output: usage.completion_tokens }
  };
}

function openAiToolResults(results) {
  return results.map(r => ({ role: 'tool', tool_call_id: r.id, content: r.content }));
}

// ---------------------------------------------------------------- Claude API (Anthropic SDK)

function anthropicClient(s, fetchImpl) {
  return new Anthropic({
    apiKey: s.apiKey,
    dangerouslyAllowBrowser: true, // the key is the user's own and never leaves their browser except to Anthropic
    ...(s.baseUrl ? { baseURL: s.baseUrl } : {}),
    ...(fetchImpl !== fetch ? { fetch: fetchImpl } : {}),
    maxRetries: 2
  });
}

function anthropicError(err) {
  if (err instanceof Anthropic.AuthenticationError) return new ProviderError('Claude API: неверный API-ключ', { status: 401 });
  if (err instanceof Anthropic.PermissionDeniedError) return new ProviderError(`Claude API: нет доступа — ${err.message}`, { status: 403 });
  if (err instanceof Anthropic.NotFoundError) return new ProviderError(`Claude API: не найдено (модель?) — ${err.message}`, { status: 404 });
  if (err instanceof Anthropic.RateLimitError) return new ProviderError('Claude API: превышен лимит запросов, повторите позже', { status: 429, retryable: true });
  if (err instanceof Anthropic.BadRequestError) return new ProviderError(`Claude API: ${err.message}`, { status: 400 });
  if (err instanceof Anthropic.APIConnectionError) return new ProviderError(`Claude API: сеть недоступна — ${err.message}`, { retryable: true });
  if (err instanceof Anthropic.APIError) return new ProviderError(`Claude API: ${err.status ?? ''} ${err.message}`, { status: err.status, retryable: (err.status ?? 0) >= 500 });
  return err;
}

/** Adaptive thinking with a readable summary: Claude 5.x and Opus/Sonnet 4.6+ (older models reject it). */
function supportsAdaptiveThinking(model) {
  // the minor version has 1–2 digits: in "claude-opus-4-20250514" the 8 digits are a date, not 4.20250514
  const m = /^claude-(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?!\d)/.exec(model || '');
  if (!m) return false;
  const major = Number(m[2]), minor = Number(m[3] || 0);
  return major >= 5 || (major === 4 && minor >= 6 && m[1] !== 'haiku');
}

/** A thinking block bound to a different conversation prefix (history edited somewhere): 400. */
const isThinkingBindingError = err => err instanceof Anthropic.BadRequestError && /signature.*thinking|thinking.*signature|bound to a different conversation/i.test(err.message || '');

/**
 * One-time recovery for that 400: drop every thinking block from the history (text and tool_use stay),
 * in place, so the stored conversation is valid from now on.
 */
function stripThinking(history) {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    m.content = m.content.filter(b => b.type !== 'thinking' && b.type !== 'redacted_thinking');
    if (!m.content.length) history.splice(i, 1);
  }
}

async function anthropicTurn(s, { system, history, tools, onText, onProgress, onReset, signal, fetchImpl = fetch }) {
  const client = anthropicClient(s, fetchImpl);
  const model = s.model || PROVIDERS.anthropic.defaultModel;
  const params = {
    model,
    max_tokens: 64000,
    // tools + system form a stable prefix; cache it
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters, eager_input_streaming: true })),
    messages: history
  };
  if (s.effort && s.effort !== 'default') params.output_config = { effort: s.effort };
  // the reasoning is shown while the model works ("omitted", the default, looks like a long silence)
  if (supportsAdaptiveThinking(model)) params.thinking = { type: 'adaptive', display: 'summarized' };
  const useFallback = FALLBACK_MODELS.has(model);

  for (let jsonRetries = 0, strippedThinking = false; ; ) {
    const stream = useFallback
      ? client.beta.messages.stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }, { signal })
      : client.messages.stream(params, { signal });
    let streamed = false;
    stream.on('text', delta => { streamed = true; onText?.(delta); });
    stream.on('thinking', delta => { streamed = true; onProgress?.({ type: 'thinking', delta }); });
    // tool calls are visible while their arguments are generated (eager input streaming)
    const drafts = new Map();
    stream.on('streamEvent', ev => {
      if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
        drafts.set(ev.index, { name: ev.content_block.name, chars: 0 });
        streamed = true;
        onProgress?.({ type: 'tool_draft', index: ev.index, name: ev.content_block.name, chars: 0 });
      } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'input_json_delta' && drafts.has(ev.index)) {
        const d = drafts.get(ev.index);
        d.chars += ev.delta.partial_json?.length || 0;
        onProgress?.({ type: 'tool_draft', index: ev.index, name: d.name, chars: d.chars });
      }
    });
    let message;
    try {
      message = await stream.finalMessage();
    } catch (err) {
      if (err instanceof Anthropic.APIUserAbortError || err?.name === 'AbortError') throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      if (isThinkingBindingError(err) && !strippedThinking) {
        strippedThinking = true;
        stripThinking(history);
        onProgress?.({ type: 'note', text: 'История разговора была изменена — прежние размышления модели отброшены, запрос повторён.' });
        continue;
      }
      if (err instanceof Anthropic.APIError) throw anthropicError(err);
      // eager input streaming: a tool input that cannot be parsed at all → re-issue the turn,
      // after taking back the text this attempt already showed
      // the SDK wraps the JSON.parse error of a streamed tool input into an AnthropicError
      const badToolJson = err instanceof SyntaxError || err?.cause instanceof SyntaxError || /parse tool parameter JSON/i.test(err?.message || '');
      if (badToolJson && jsonRetries++ < 2) {
        if (streamed) onReset?.();
        continue;
      }
      if (err instanceof ProviderError) throw err;
      throw new ProviderError(badToolJson
        ? 'Claude API: модель несколько раз прислала повреждённые аргументы инструмента. Повторите запрос.'
        : `Claude API: ${err?.message || err}`);
    }
    if (message.stop_reason === 'refusal') {
      throw new ProviderError(`Claude отказался отвечать на этот запрос${message.stop_details?.category ? ` (${message.stop_details.category})` : ''}.`);
    }
    const toolUse = message.content.filter(b => b.type === 'tool_use');
    if (message.stop_reason === 'max_tokens' && toolUse.length) throw new ProviderError('Ответ модели обрезан (max_tokens) посреди вызова инструмента');
    return {
      // the full content (thinking, fallback blocks …) goes back unchanged on the next request;
      // an empty turn is not kept (the API rejects empty assistant messages before the last one)
      append: message.content.length ? [{ role: 'assistant', content: message.content }] : [],
      toolCalls: toolUse.map(b => ({ id: b.id, name: b.name, input: b.input })),
      pause: message.stop_reason === 'pause_turn',
      usage: { input: (message.usage.input_tokens || 0) + (message.usage.cache_read_input_tokens || 0) + (message.usage.cache_creation_input_tokens || 0), output: message.usage.output_tokens }
    };
  }
}

function anthropicToolResults(results) {
  // all results of one turn in a single user message
  return [{ role: 'user', content: results.map(r => ({ type: 'tool_result', tool_use_id: r.id, content: r.content, ...(r.isError ? { is_error: true } : {}) })) }];
}

// ---------------------------------------------------------------- public

export function providerKind(provider) {
  return PROVIDERS[provider]?.kind;
}

export function runTurn(settings, opts) {
  return providerKind(settings.provider) === 'anthropic' ? anthropicTurn(settings, opts) : openAiTurn(settings, opts);
}

export function toolResultMessages(settings, results) {
  return providerKind(settings.provider) === 'anthropic' ? anthropicToolResults(results) : openAiToolResults(results);
}

export function userMessage(text) {
  return { role: 'user', content: text };
}

function isCompleteJson(text) {
  if (!text || !text.trim()) return false;
  try { JSON.parse(text); return true; } catch { return false; }
}
