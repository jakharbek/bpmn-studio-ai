// The downloadable local assistant server, with a stand-in for the Claude Code CLI.
import { test, before, after } from 'node:test';
import { freePort } from './fixtures/ports.js';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';

const dir = mkdtempSync(join(tmpdir(), 'bpmn-local-'));
const LOG = join(dir, 'claude.log');
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'secret-token-1234567890';
const STUDIO = 'https://studio.example.com';
let server;

before(async () => {
  server = spawn(process.execPath, [new URL('../local-server/server.js', import.meta.url).pathname], {
    env: { ...process.env, BPMN_LOCAL_PORT: String(PORT), BPMN_LOCAL_TOKEN: TOKEN, BPMN_LOCAL_ALLOWED_ORIGINS: STUDIO,
      CLAUDE_BIN: new URL('./fixtures/fake-claude.mjs', import.meta.url).pathname, FAKE_CLAUDE_LOG: LOG },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', d => String(d).includes('Claude Code:') && resolve());
    server.on('exit', code => reject(new Error(`exited ${code}`)));
  });
});
after(() => server?.kill('SIGTERM'));

const auth = { authorization: `Bearer ${TOKEN}` };
const post = (body, headers = {}) => fetch(`${BASE}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth, ...headers }, body: JSON.stringify(body) });
const lastCli = () => JSON.parse(readFileSync(LOG, 'utf8').trim().split('\n').at(-1));
const TOOLS = [{ type: 'function', function: { name: 'bpmn_list', description: 'List diagrams', parameters: { type: 'object', properties: {} } } }];

test('health, models, auth, origins, private network access', async () => {
  const health = await (await fetch(`${BASE}/health`, { headers: auth })).json();
  assert.deepEqual(health.claude, { available: true, version: '9.9.9 (Claude Code)' });
  assert.equal(health.capabilities.tools, true);
  assert.equal((await fetch(`${BASE}/health`)).status, 401);
  // with a token any studio address may connect, but only with the token (and the answer is readable)
  const foreign = await fetch(`${BASE}/v1/models`, { headers: { origin: 'https://evil.example' } });
  assert.equal(foreign.status, 401);
  assert.equal(foreign.headers.get('access-control-allow-origin'), 'https://evil.example');
  assert.equal((await fetch(`${BASE}/v1/models`, { headers: { ...auth, origin: 'https://pages.example.io' } })).status, 200);
  const models = await (await fetch(`${BASE}/v1/models`, { headers: { ...auth, origin: STUDIO } })).json();
  assert.deepEqual(models.data.map(m => m.id), ['opus', 'sonnet', 'haiku']);

  const pre = await fetch(`${BASE}/v1/chat/completions`, { method: 'OPTIONS', headers: {
    origin: STUDIO, 'access-control-request-method': 'POST', 'access-control-request-private-network': 'true' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), STUDIO);
  assert.equal(pre.headers.get('access-control-allow-private-network'), 'true');

  const rebinding = await new Promise(resolve => request({ host: '127.0.0.1', port: PORT, path: '/health', headers: { host: `evil.example:${PORT}`, ...auth } },
    res => { res.resume(); resolve(res.statusCode); }).end());
  assert.equal(rebinding, 403);
  assert.equal((await fetch(`${BASE}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'text/plain', ...auth }, body: '{}' })).status, 415);
});

test('tools: structured CLI answer becomes OpenAI tool_calls; the CLI runs without tools', async () => {
  const res = await post({ model: 'sonnet', tools: TOOLS, messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'Какие диаграммы?' }] });
  const body = await res.json();
  const choice = body.choices[0];
  assert.equal(choice.finish_reason, 'tool_calls');
  assert.equal(choice.message.content, 'Смотрю список');
  assert.equal(choice.message.tool_calls.length, 1, 'tools that were not offered are dropped');
  assert.equal(choice.message.tool_calls[0].function.name, 'bpmn_list');
  assert.equal(choice.message.tool_calls[0].function.arguments, '{}');
  assert.equal(body.usage.total_tokens, 15);

  const { args, stdin, system, cwd } = lastCli();
  for (const flag of ['--tools', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands', '--json-schema', '--system-prompt-file']) assert.ok(args.includes(flag), flag);
  assert.ok(!args.includes('--system-prompt'), 'the system prompt is not on the command line (Windows: 32 KB limit)');
  assert.ok(args.join(' ').length < 4000, 'command line stays small');
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--model') + 1], 'sonnet');
  assert.match(system, /^SYS/);
  assert.match(system, /only callable tool is StructuredOutput/);
  assert.match(system, /NOT tools/);
  assert.match(system, /"name":"bpmn_list"/);
  assert.equal(stdin, 'User: Какие диаграммы?');
  // each run had its own scratch directory, removed afterwards
  assert.ok(!existsSync(cwd), 'scratch directory removed');
  const schema = JSON.parse(args[args.indexOf('--json-schema') + 1]);
  assert.deepEqual(schema.properties.tool_calls.items.properties.name.enum, ['bpmn_list']);
});

test('tools: history with tool results, streamed in OpenAI chunk format', async () => {
  const res = await post({ stream: true, stream_options: { include_usage: true }, tools: TOOLS, messages: [
    { role: 'user', content: 'Какие диаграммы?' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'bpmn_list', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: '{"files":["a.bpmn"]}' }
  ] });
  const chunks = (await res.text()).split('\n\n').filter(Boolean).map(l => l.replace(/^data: /, ''));
  assert.equal(chunks.at(-1), '[DONE]');
  const parsed = chunks.slice(0, -1).map(c => JSON.parse(c));
  assert.equal(parsed.map(c => c.choices[0]?.delta?.content || '').join(''), 'Готово: a.bpmn');
  assert.equal(parsed.find(c => c.choices[0]?.finish_reason)?.choices[0].finish_reason, 'stop');
  assert.equal(parsed.at(-1).usage.total_tokens, 15);
  // progress while the structured answer is generated: the reasoning, and how far the answer is
  assert.equal(parsed.map(c => c.choices[0]?.delta?.reasoning_content || '').join(''), 'Нужно посмотреть список схем.');
  assert.ok(parsed.some(c => c.x_bpmn_progress?.chars > 0));
  const { args } = lastCli();
  assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json');
  assert.ok(args.includes('--json-schema'));
  const { stdin } = lastCli();
  assert.match(stdin, /User: Какие диаграммы\?/);
  assert.match(stdin, /\[tool call call_1\] bpmn_list\(\{\}\)/);
  assert.match(stdin, /Tool result for call_1:\n\{"files":\["a\.bpmn"\]\}/);
});

test('plain chat: stream and non-stream; effort is passed through', async () => {
  const res = await post({ stream: true, effort: 'low', messages: [{ role: 'user', content: 'Привет' }] });
  const chunks = (await res.text()).split('\n\n').filter(l => l && !l.endsWith('[DONE]')).map(l => JSON.parse(l.slice(6)));
  assert.equal(chunks.map(c => c.choices[0]?.delta?.content || '').join(''), 'Привет');
  assert.ok(chunks.every(c => !c.usage), 'no usage chunk unless stream_options.include_usage');
  const { args } = lastCli();
  assert.equal(args[args.indexOf('--effort') + 1], 'low');
  assert.ok(!args.includes('--json-schema'));

  const plain = await (await post({ messages: [{ role: 'user', content: 'Привет' }] })).json();
  assert.equal(plain.choices[0].message.content, 'Привет');
  assert.equal((await post({ messages: [] })).status, 400);
});

test('input starting with "/" is a message, not a slash command', async () => {
  await post({ messages: [{ role: 'user', content: '/login' }] });
  assert.equal(lastCli().stdin, 'User: /login');
});

test('multi-byte text split across output chunks arrives intact', async () => {
  const body = await (await post({ messages: [{ role: 'user', content: 'long' }] })).json();
  assert.equal(body.choices[0].message.content, 'Привет'.repeat(5000));
});

test('a run without structured output: the text becomes the answer', async () => {
  const body = await (await post({ tools: TOOLS, messages: [{ role: 'user', content: 'plain-result' }] })).json();
  assert.equal(body.choices[0].message.content, 'Не могу это сделать');
  assert.equal(body.choices[0].finish_reason, 'stop');
});

test('images and other non-text parts are refused, not dropped', async () => {
  const res = await post({ messages: [{ role: 'user', content: [{ type: 'text', text: 'что тут?' }, { type: 'image_url', image_url: { url: 'data:,' } }] }] });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error.message, /image_url/);
});

test('too large bodies get a 413 answer', async () => {
  const big = 'x'.repeat(21 * 1024 * 1024);
  const res = await post({ messages: [{ role: 'user', content: big }] });
  assert.equal(res.status, 413);
});

test('at most maxConcurrent CLI runs at a time', async () => {
  const slow = () => post({ messages: [{ role: 'user', content: 'slow' }] });
  const results = await Promise.all([slow(), slow(), slow()]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 200, 429]);
  await Promise.all(results.map(r => r.text()));
});

const startFails = (env, cwdConfig) => new Promise(resolve => {
  const p = spawn(process.execPath, [new URL('../local-server/server.js', import.meta.url).pathname], {
    env: { ...process.env, CLAUDE_BIN: 'false', ...env }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let err = '';
  p.stderr.on('data', d => { err += d; });
  const t = setTimeout(() => { p.kill(); resolve({ code: 'running', err }); }, 3000);
  p.on('exit', code => { clearTimeout(t); resolve({ code, err }); });
});

test('invalid configuration and an open network address without a token are refused', async () => {
  const port = String(await freePort());
  let r = await startFails({ BPMN_LOCAL_PORT: 'abc' });
  assert.equal(r.code, 1); assert.match(r.err, /port/);
  r = await startFails({ BPMN_LOCAL_PORT: port, BPMN_LOCAL_TIMEOUT_MS: '-5' });
  assert.equal(r.code, 1); assert.match(r.err, /timeoutMs/);
  r = await startFails({ BPMN_LOCAL_PORT: port, BPMN_LOCAL_TOKEN: 'short' });
  assert.equal(r.code, 1); assert.match(r.err, /token/);
  r = await startFails({ BPMN_LOCAL_PORT: port, BPMN_LOCAL_HOST: '0.0.0.0', BPMN_LOCAL_TOKEN: '' });
  assert.equal(r.code, 1); assert.match(r.err, /token/);
  r = await startFails({ BPMN_LOCAL_PORT: port, BPMN_LOCAL_TOKEN: '', BPMN_LOCAL_ALLOWED_ORIGINS: '*' });
  assert.equal(r.code, 1); assert.match(r.err, /needs a token/);
});
