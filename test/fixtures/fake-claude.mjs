#!/usr/bin/env node
// Stand-in for the Claude Code CLI used by the local server tests: records its arguments, system
// prompt file and stdin, and answers like `claude -p --output-format json|stream-json`.
import { appendFileSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('9.9.9 (Claude Code)'); process.exit(0); }
const stdin = readFileSync(0, 'utf8');
const promptFile = args.includes('--system-prompt-file') ? args[args.indexOf('--system-prompt-file') + 1] : null;
const system = promptFile ? readFileSync(promptFile, 'utf8') : null;
if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, stdin, system, cwd: process.cwd() }) + '\n');
const usage = { input_tokens: 10, output_tokens: 5 };
const format = args[args.indexOf('--output-format') + 1];
const delay = /slow/.test(stdin) ? 1500 : 0;

setTimeout(() => {
  if (args.includes('--json-schema')) {
    if (stdin.includes('plain-result')) {
      // an answer without structured_output (e.g. a refusal): the text is the message
      console.log(JSON.stringify({ type: 'result', is_error: false, result: 'Не могу это сделать', usage }));
      return;
    }
    const structured = stdin.includes('Tool result for')
      ? { message: 'Готово: a.bpmn', tool_calls: [] }
      : { message: 'Смотрю список', tool_calls: [{ name: 'bpmn_list', arguments: '{}' }, { name: 'not_offered', arguments: '{}' }] };
    if (format === 'stream-json') {
      // like the CLI with --include-partial-messages: reasoning, then the structured answer in pieces
      const ev = event => console.log(JSON.stringify({ type: 'stream_event', event }));
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Нужно посмотреть список схем.' } });
      const json = JSON.stringify(structured);
      for (let i = 0; i < json.length; i += 8) ev({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: json.slice(i, i + 8) } });
    }
    console.log(JSON.stringify({ type: 'result', is_error: false, result: JSON.stringify(structured), structured_output: structured, usage }));
  } else if (format === 'stream-json') {
    for (const text of ['Прив', 'ет']) {
      console.log(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } }));
    }
    console.log(JSON.stringify({ type: 'result', is_error: false, result: 'Привет', usage }));
  } else {
    // a long multi-byte answer written in small pieces: chunk borders fall inside characters
    const text = 'Привет'.repeat(5000);
    const out = Buffer.from(JSON.stringify({ type: 'result', is_error: false, result: stdin.includes('long') ? text : 'Привет', usage }) + '\n');
    for (let i = 0; i < out.length; i += 7) process.stdout.write(out.subarray(i, i + 7));
  }
}, delay);
