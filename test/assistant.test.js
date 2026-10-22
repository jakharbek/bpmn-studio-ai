// Browser assistant core against stand-in providers: OpenAI-compatible streaming with tool_calls,
// and the Claude API through the real Anthropic SDK (request shape, streaming tool_use, tool_result).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { runAssistant, testConnection } from '../web/assistant/agent.js';

const TOOLS = [{ name: 'bpmn_list', description: 'List diagrams', parameters: { type: 'object', properties: {} } },
  { name: 'bpmn_deploy', description: 'Send', parameters: { type: 'object', properties: { file: { type: 'string' }, target: { type: 'string' } } } }];

function fakeStudio() {
  const calls = [];
  return {
    calls,
    config: async () => ({ systemPrompt: 'SYSTEM PROMPT', tools: TOOLS }),
    callTool: async (name, args) => { calls.push({ name, args }); return { ok: true, result: { files: [{ file: 'a.bpmn' }] } }; }
  };
}

let server, base, handler;
const requests = [];
before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
      handler(req, res, requests.at(-1));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const sse = (res, events) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const e of events) res.write(typeof e === 'string' ? e : `data: ${JSON.stringify(e)}\n\n`);
  res.end();
};

test('OpenAI-compatible: streamed tool_calls are executed and answered', async () => {
  requests.length = 0;
  let turn = 0;
  handler = (req, res) => {
    if (turn++ === 0) {
      return sse(res, [
        { choices: [{ index: 0, delta: { role: 'assistant', content: 'Смотрю ' } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'bpmn_list', arguments: '{' } }] } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '}' } }] } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        { choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } },
        'data: [DONE]\n\n'
      ]);
    }
    sse(res, [{ choices: [{ index: 0, delta: { content: 'Есть a.bpmn' }, finish_reason: 'stop' }] }, 'data: [DONE]\n\n']);
  };
  const studio = fakeStudio();
  const history = [];
  const events = [];
  const out = await runAssistant({
    settings: { provider: 'openrouter', apiKey: 'sk-or-x', model: 'vendor/model', baseUrl: base },
    history, text: 'Какие диаграммы?', studio, onEvent: e => events.push(e)
  });
  assert.deepEqual(studio.calls, [{ name: 'bpmn_list', args: {} }]);
  assert.equal(requests.length, 2);
  const [first, second] = requests;
  assert.equal(first.url, '/chat/completions');
  assert.equal(first.headers.authorization, 'Bearer sk-or-x');
  assert.equal(first.headers['x-title'], 'BPMN Studio');
  assert.deepEqual(first.body.messages[0], { role: 'system', content: 'SYSTEM PROMPT' });
  assert.equal(first.body.tools[0].function.name, 'bpmn_list');
  assert.equal(first.body.stream, true);
  // second request carries the assistant tool_calls and the tool result
  const msgs = second.body.messages;
  assert.deepEqual(msgs.at(-2).tool_calls, [{ id: 'call_1', type: 'function', function: { name: 'bpmn_list', arguments: '{}' } }]);
  assert.equal(msgs.at(-1).role, 'tool');
  assert.equal(msgs.at(-1).tool_call_id, 'call_1');
  assert.match(msgs.at(-1).content, /a\.bpmn/);
  assert.equal(events.filter(e => e.type === 'text').map(e => e.delta).join(''), 'Смотрю Есть a.bpmn');
  assert.equal(history.length, 4);
  assert.equal(out.usage.input, 100);
});

test('OpenAI-compatible: deploy needs the user\'s confirmation; HTTP errors are readable', async () => {
  let turn = 0;
  handler = (req, res) => {
    if (turn++ === 0) {
      return sse(res, [{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'bpmn_deploy', arguments: '{"file":"a","target":"prod"}' } }] }, finish_reason: 'tool_calls' }] }, 'data: [DONE]\n\n']);
    }
    sse(res, [{ choices: [{ index: 0, delta: { content: 'Ок, не отправляю' }, finish_reason: 'stop' }] }, 'data: [DONE]\n\n']);
  };
  const studio = fakeStudio();
  const asked = [];
  await runAssistant({
    settings: { provider: 'openai', apiKey: 'k', model: 'm', baseUrl: base }, history: [], text: 'отправь на prod', studio,
    onEvent: () => {}, confirm: async call => { asked.push(call.args); return false; }
  });
  assert.deepEqual(asked, [{ file: 'a', target: 'prod' }]);
  assert.equal(studio.calls.length, 0);
  assert.match(requests.at(-1).body.messages.at(-1).content, /declined/);

  handler = (req, res) => { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":{"message":"bad key"}}'); };
  const history = [];
  await assert.rejects(runAssistant({ settings: { provider: 'openai', apiKey: 'k', model: 'm', baseUrl: base }, history, text: 'x', studio, onEvent: () => {} }),
    /доступ запрещён \(401\).*bad key/);
  assert.equal(history.length, 0, 'a failed exchange is not kept in the history');
});

test('Claude API via the Anthropic SDK: request shape, streamed tool_use, tool_result', async () => {
  requests.length = 0;
  let turn = 0;
  const start = { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, usage: { input_tokens: 50, output_tokens: 1 } } };
  handler = (req, res) => {
    const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    if (turn++ === 0) {
      return sse(res, [
        ev('message_start', start),
        ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
        ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Проверю.' } }),
        ev('content_block_stop', { index: 0 }),
        ev('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'bpmn_list', input: {} } }),
        ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } }),
        ev('content_block_stop', { index: 1 }),
        ev('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } }),
        ev('message_stop', {})
      ]);
    }
    sse(res, [
      ev('message_start', start),
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Готово' } }),
      ev('content_block_stop', { index: 0 }),
      ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }),
      ev('message_stop', {})
    ]);
  };
  const studio = fakeStudio();
  const history = [];
  const events = [];
  await runAssistant({
    settings: { provider: 'anthropic', apiKey: 'sk-ant-test', model: 'claude-opus-5-5', baseUrl: base, effort: 'high' },
    history, text: 'Какие диаграммы?', studio, onEvent: e => events.push(e)
  });
  assert.deepEqual(studio.calls, [{ name: 'bpmn_list', args: {} }]);
  const [first, second] = requests;
  assert.equal(first.url, '/v1/messages?beta=true');
  assert.equal(first.headers['x-api-key'], 'sk-ant-test');
  assert.match(first.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
  assert.equal(first.body.fallbacks, 'default');
  assert.equal(first.body.model, 'claude-opus-5-5');
  assert.equal(first.body.stream, true);
  assert.deepEqual(first.body.output_config, { effort: 'high' });
  assert.deepEqual(first.body.system, [{ type: 'text', text: 'SYSTEM PROMPT', cache_control: { type: 'ephemeral' } }]);
  assert.equal(first.body.tools[0].eager_input_streaming, true);
  assert.deepEqual(first.body.tools[0].input_schema, TOOLS[0].parameters);
  // the assistant content goes back unchanged, tool results in one user message
  const msgs = second.body.messages;
  assert.equal(msgs[1].role, 'assistant');
  assert.deepEqual(msgs[1].content.map(b => b.type), ['text', 'tool_use']);
  assert.equal(msgs[2].role, 'user');
  assert.equal(msgs[2].content[0].type, 'tool_result');
  assert.equal(msgs[2].content[0].tool_use_id, 'toolu_1');
  assert.equal(events.filter(e => e.type === 'text').map(e => e.delta).join(''), 'Проверю.Готово');
});

test('Claude API: models without server-side fallback use the plain endpoint; refusals are reported', async () => {
  requests.length = 0;
  handler = (req, res) => {
    const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    sse(res, [
      ev('message_start', { message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } }),
      ev('message_delta', { delta: { stop_reason: 'refusal' }, usage: { output_tokens: 1 } }),
      ev('message_stop', {})
    ]);
  };
  await assert.rejects(runAssistant({
    settings: { provider: 'anthropic', apiKey: 'k', model: 'claude-haiku-5-5', baseUrl: base }, history: [], text: 'x', studio: fakeStudio(), onEvent: () => {}
  }), /отказался/);
  assert.equal(requests[0].url, '/v1/messages');
  assert.equal(requests[0].body.fallbacks, undefined);
  assert.equal(requests[0].body.output_config, undefined);
});

test('connection check: OpenAI models list and local health', async () => {
  handler = (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url.startsWith('/health')) return res.end(JSON.stringify({ ok: true, version: '1.0.0', claude: { available: true, version: '2.1 (Claude Code)' }, capabilities: { tools: true } }));
    res.end(JSON.stringify({ data: [{ id: 'sonnet' }, { id: 'opus' }] }));
  };
  const r = await testConnection({ provider: 'local', apiKey: 'tok', baseUrl: `${base}/v1` });
  assert.deepEqual(r.models, ['opus', 'sonnet']);
  assert.match(r.detail, /Claude Code/);
  assert.equal(requests.at(-1).headers.authorization, 'Bearer tok');

  handler = (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, claude: { available: false, error: 'not found' }, capabilities: { tools: true } })); };
  await assert.rejects(testConnection({ provider: 'local', apiKey: 'tok', baseUrl: `${base}/v1` }), /Claude Code недоступен/);
  await assert.rejects(testConnection({ provider: 'local', baseUrl: 'http://127.0.0.1:9/v1' }), /не смог обратиться к локальному серверу.*сервер запущен.*скачайте сервер заново.*локальной сети/);
  await assert.rejects(testConnection({ provider: 'openai', apiKey: '' }), /API-ключ/);
});

test('Custom LLM Provider (Qwen/DeepSeek style): own base URL, optional key, extra headers, tool loop', async () => {
  requests.length = 0;
  let turn = 0;
  handler = (req, res) => {
    if (turn++ === 0) {
      return sse(res, [{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'q1', type: 'function', function: { name: 'bpmn_list', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }, 'data: [DONE]\n\n']);
    }
    sse(res, [{ choices: [{ index: 0, delta: { content: 'Готово' }, finish_reason: 'stop' }] }, 'data: [DONE]\n\n']);
  };
  const studio = fakeStudio();
  await runAssistant({
    settings: { provider: 'custom', name: 'Qwen', baseUrl: `${base}/compatible-mode/v1`, model: 'qwen-plus', headers: { 'X-Workspace': 'ws1', Authorization: 'evil' } },
    history: [], text: 'список', studio, onEvent: () => {}
  });
  assert.deepEqual(studio.calls, [{ name: 'bpmn_list', args: {} }]);
  assert.equal(requests[0].url, '/compatible-mode/v1/chat/completions');
  assert.equal(requests[0].headers['x-workspace'], 'ws1');
  assert.equal(requests[0].body.model, 'qwen-plus');
  // no key configured → the header from "extra headers" is used as is, but a configured key always wins
  requests.length = 0;
  turn = 1;
  await runAssistant({
    settings: { provider: 'custom', baseUrl: base, apiKey: 'sk-ds', model: 'deepseek-chat', headers: { authorization: 'evil' } },
    history: [], text: 'x', studio, onEvent: () => {}
  });
  assert.equal(requests[0].headers.authorization, 'Bearer sk-ds');
  assert.equal(requests[0].headers['content-type'], 'application/json');
});

test('Custom LLM Provider: connection check with and without a model list; readable network errors', async () => {
  handler = (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] })); };
  const listed = await testConnection({ provider: 'custom', name: 'DeepSeek', baseUrl: base, apiKey: 'k' });
  assert.deepEqual(listed.models, ['deepseek-chat', 'deepseek-reasoner']);
  assert.match(listed.detail, /^DeepSeek доступен/);

  requests.length = 0;
  handler = (req, res) => {
    if (req.url.endsWith('/models')) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'p' } }] }));
  };
  await assert.rejects(testConnection({ provider: 'custom', name: 'X', baseUrl: base }), /укажите модель вручную/);
  const pinged = await testConnection({ provider: 'custom', name: 'X', baseUrl: base, model: 'my-model' });
  assert.match(pinged.detail, /модель my-model доступна/);
  assert.deepEqual(requests.at(-1).body, { model: 'my-model', messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 });

  await assert.rejects(testConnection({ provider: 'custom', baseUrl: 'ftp://x' }), /Base URL/);
  const blocked = () => Promise.reject(new TypeError('Failed to fetch'));
  await assert.rejects(testConnection({ provider: 'custom', name: 'Corp', baseUrl: 'https://llm.corp.example/v1' }, { fetchImpl: blocked }), /Corp: браузер не смог обратиться.*CORS/);
  await assert.rejects(runAssistant({ settings: { provider: 'custom', model: 'm' }, history: [], text: 'x', studio: fakeStudio(), onEvent: () => {} }), /Base URL/);
});

// ---------------------------------------------------------------- robustness (review findings)

test('stream quirks: repeated names, missing index, last event without a newline, empty turns', async () => {
  let turn = 0;
  handler = (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (turn++ === 0) {
      // name repeated in every chunk, no "index" on continuation chunks, CRLF line ends
      res.write('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"id":"c1","function":{"name":"bpmn_list","arguments":"{"}}]}}]}\r\n\r\n');
      res.write('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"function":{"name":"bpmn_list","arguments":"}"}}]}}]}\r\n\r\n');
      return res.end('data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n');
    }
    if (turn === 2) return res.end('data: {"choices":[{"index":0,"delta":{},"finish_reason":"content_filter"}]}'); // empty turn, no newline
    res.end('data: {"choices":[{"index":0,"delta":{"content":"Готово"},"finish_reason":"stop"}]}'); // no trailing newline
  };
  const studio = fakeStudio();
  const history = [];
  const settings = { provider: 'openai', apiKey: 'k', model: 'm', baseUrl: base };
  await runAssistant({ settings, history, text: 'список', studio, onEvent: () => {} });
  assert.deepEqual(studio.calls, [{ name: 'bpmn_list', args: {} }]);
  assert.ok(!history.some(m => m.role === 'assistant' && !m.content && !m.tool_calls), 'no empty assistant message kept');
  const events = [];
  await runAssistant({ settings, history, text: 'ещё раз', studio, onEvent: e => events.push(e) });
  assert.equal(events.filter(e => e.type === 'text').map(e => e.delta).join(''), 'Готово');
});

test('a throwing tool or an ok:false without message does not abort the run', async () => {
  let turn = 0;
  handler = (req, res) => {
    if (turn++ < 2) return sse(res, [{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `c${turn}`, function: { name: 'bpmn_list', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }, 'data: [DONE]\n\n']);
    sse(res, [{ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }, 'data: [DONE]\n\n']);
  };
  let n = 0;
  const studio = {
    config: async () => ({ systemPrompt: 'S', tools: TOOLS }),
    callTool: async () => { if (n++ === 0) throw new Error('boom'); return { ok: false }; }
  };
  const history = [];
  await runAssistant({ settings: { provider: 'openai', apiKey: 'k', model: 'm', baseUrl: base }, history, text: 'x', studio, onEvent: () => {} });
  const toolMsgs = history.filter(m => m.role === 'tool').map(m => m.content);
  assert.deepEqual(toolMsgs, ['Error: boom', 'Error: unknown error']);
});

test('Claude API: a tool input that is not valid JSON makes the turn retry, with the shown text taken back', async () => {
  let turn = 0;
  const start = { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } };
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  handler = (req, res) => {
    const n = turn++;
    if (n === 0) {
      return sse(res, [ev('message_start', start),
        ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
        ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Черновик' } }),
        ev('content_block_stop', { index: 0 }),
        ev('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'toolu_x', name: 'bpmn_list', input: {} } }),
        ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"file": "a"}}garbage' } }),
        ev('content_block_stop', { index: 1 }),
        ev('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } }), ev('message_stop', {})]);
    }
    sse(res, [ev('message_start', start),
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Готово' } }),
      ev('content_block_stop', { index: 0 }),
      ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }), ev('message_stop', {})]);
  };
  const events = [];
  await runAssistant({ settings: { provider: 'anthropic', apiKey: 'k', model: 'claude-haiku-5-5', baseUrl: base }, history: [], text: 'x', studio: fakeStudio(), onEvent: e => events.push(e) });
  assert.equal(turn, 2, 'the turn was requested again');
  assert.ok(events.some(e => e.type === 'reset'));
});

test('stopping between tool calls keeps what already ran in the history', async () => {
  let turn = 0;
  handler = (req, res) => {
    if (turn++ === 0) {
      return sse(res, [{ choices: [{ index: 0, delta: { tool_calls: [
        { index: 0, id: 'c1', function: { name: 'bpmn_deploy', arguments: '{"file":"a","target":"dev"}' } },
        { index: 1, id: 'c2', function: { name: 'bpmn_list', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }, 'data: [DONE]\n\n']);
    }
    sse(res, [{ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }, 'data: [DONE]\n\n']);
  };
  const controller = new AbortController();
  const studio = fakeStudio();
  const inner = studio.callTool;
  studio.callTool = async (name, args) => { const r = await inner(name, args); controller.abort(); return r; };
  const history = [];
  await assert.rejects(runAssistant({ settings: { provider: 'openai', apiKey: 'k', model: 'm', baseUrl: base }, history, text: 'отправь',
    studio, signal: controller.signal, confirm: async () => true, onEvent: () => {} }), err => err.name === 'AbortError');
  assert.deepEqual(studio.calls.map(c => c.name), ['bpmn_deploy']);
  const tools = history.filter(m => m.role === 'tool');
  assert.deepEqual(tools.map(t => t.tool_call_id), ['c1', 'c2'], 'every call has a result');
  assert.match(tools[1].content, /stopped/);
  assert.equal(history[0].role, 'user', 'the run is kept');
});

test('bpmn_deploy never runs without a confirmation callback', async () => {
  let turn = 0;
  handler = (req, res) => {
    if (turn++ === 0) return sse(res, [{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'd', function: { name: 'bpmn_deploy', arguments: '{"file":"a","target":"prod"}' } }] }, finish_reason: 'tool_calls' }] }, 'data: [DONE]\n\n']);
    sse(res, [{ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }, 'data: [DONE]\n\n']);
  };
  const studio = fakeStudio();
  await runAssistant({ settings: { provider: 'openai', apiKey: 'k', model: 'm', baseUrl: base }, history: [], text: 'x', studio, onEvent: () => {} });
  assert.deepEqual(studio.calls, []);
});

test('two calls in one chunk without index or id stay two calls', async () => {
  let turn = 0;
  handler = (req, res) => {
    if (turn++ === 0) {
      return sse(res, [{ choices: [{ index: 0, delta: { tool_calls: [
        { function: { name: 'bpmn_list', arguments: '{"file":"a"}' } },
        { function: { name: 'bpmn_list', arguments: '{"file":"b"}' } }] }, finish_reason: 'tool_calls' }] }, 'data: [DONE]\n\n']);
    }
    sse(res, [{ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }, 'data: [DONE]\n\n']);
  };
  const studio = fakeStudio();
  await runAssistant({ settings: { provider: 'openai', apiKey: 'k', model: 'm', baseUrl: base }, history: [], text: 'x', studio, onEvent: () => {} });
  assert.deepEqual(studio.calls.map(c => c.args.file), ['a', 'b']);
});

test('progress events: reasoning, tool calls while generated, steps and tool timing (OpenAI-compatible)', async () => {
  let turn = 0;
  handler = (req, res) => {
    if (turn++ === 0) {
      return sse(res, [
        { choices: [{ index: 0, delta: { reasoning_content: 'Нужно ' } }] },
        { choices: [{ index: 0, delta: { reasoning: 'посмотреть список.' } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'bpmn_list', arguments: '{' } }] } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '}' } }] } }] },
        { choices: [{ index: 0, delta: {} , finish_reason: 'tool_calls' }], x_bpmn_progress: { chars: 2 } },
        'data: [DONE]\n\n'
      ]);
    }
    sse(res, [{ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }, 'data: [DONE]\n\n']);
  };
  const events = [];
  const history = [];
  await runAssistant({ settings: { provider: 'openai', apiKey: 'k', model: 'm', baseUrl: base }, history, text: 'x', studio: fakeStudio(), onEvent: e => events.push(e) });
  assert.equal(events.filter(e => e.type === 'thinking').map(e => e.delta).join(''), 'Нужно посмотреть список.');
  assert.deepEqual(events.filter(e => e.type === 'tool_draft').map(e => [e.name, e.chars]).slice(0, 2), [['bpmn_list', 1], ['bpmn_list', 2]]);
  assert.deepEqual(events.filter(e => e.type === 'step').map(e => e.n), [1, 2]);
  assert.ok(typeof events.find(e => e.type === 'tool_result').ms === 'number');
  assert.ok(!JSON.stringify(history).includes('посмотреть'), 'reasoning is never sent back');
});

test('Claude API: summarized reasoning is requested and streamed; tool calls show while generated', async () => {
  requests.length = 0;
  let turn = 0;
  const start = { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } };
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  handler = (req, res) => {
    if (turn++ === 0) {
      return sse(res, [ev('message_start', start),
        ev('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }),
        ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'Сначала список.' } }),
        ev('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'sig' } }),
        ev('content_block_stop', { index: 0 }),
        ev('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'bpmn_list', input: {} } }),
        ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } }),
        ev('content_block_stop', { index: 1 }),
        ev('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } }), ev('message_stop', {})]);
    }
    sse(res, [ev('message_start', start),
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Готово' } }),
      ev('content_block_stop', { index: 0 }),
      ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }), ev('message_stop', {})]);
  };
  const events = [];
  const history = [];
  await runAssistant({ settings: { provider: 'anthropic', apiKey: 'k', model: 'claude-opus-5-5', baseUrl: base }, history, text: 'x', studio: fakeStudio(), onEvent: e => events.push(e) });
  assert.deepEqual(requests[0].body.thinking, { type: 'adaptive', display: 'summarized' });
  assert.equal(events.filter(e => e.type === 'thinking').map(e => e.delta).join(''), 'Сначала список.');
  assert.ok(events.some(e => e.type === 'tool_draft' && e.name === 'bpmn_list'));
  // the thinking block goes back unchanged on the next request (preserved thinking)
  assert.equal(requests[1].body.messages[1].content[0].type, 'thinking');
  assert.equal(requests[1].body.messages[1].content[0].signature, 'sig');

  requests.length = 0;
  turn = 1;
  await runAssistant({ settings: { provider: 'anthropic', apiKey: 'k', model: 'claude-haiku-4-5', baseUrl: base }, history: [], text: 'x', studio: fakeStudio(), onEvent: () => {} });
  assert.equal(requests[0].body.thinking, undefined, 'older models get no adaptive thinking');
});

test('Claude API: a history whose reasoning no longer matches (400) is repaired once and retried', async () => {
  requests.length = 0;
  let n = 0;
  const start = { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } };
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  handler = (req, res) => {
    if (n++ === 0) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.' } }));
    }
    sse(res, [ev('message_start', start), ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ok' } }), ev('content_block_stop', { index: 0 }),
      ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }), ev('message_stop', {})]);
  };
  const history = [
    { role: 'user', content: 'a' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 't', signature: 's' }, { type: 'text', text: 'b' }] }
  ];
  const events = [];
  await runAssistant({ settings: { provider: 'anthropic', apiKey: 'k', model: 'claude-opus-5-5', baseUrl: base }, history, text: 'c', studio: fakeStudio(), onEvent: e => events.push(e) });
  assert.equal(n, 2);
  assert.deepEqual(requests[1].body.messages[1].content, [{ type: 'text', text: 'b' }], 'thinking stripped, text kept');
  assert.ok(events.some(e => e.type === 'note'));
});

test('local server refusals become instructions', async () => {
  handler = (req, res) => {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Origin https://x.io is not allowed: this server runs without a token' } }));
  };
  await assert.rejects(testConnection({ provider: 'local', baseUrl: `${base}/v1` }), /запущен без токена.*Скачайте сервер на этой странице/);
  handler = (req, res) => { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":{"message":"bad token"}}'); };
  await assert.rejects(testConnection({ provider: 'local', apiKey: 'x', baseUrl: `${base}/v1` }), /отклонил токен/);
});
