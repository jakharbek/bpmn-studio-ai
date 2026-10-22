#!/usr/bin/env node
"use strict";

/**
 * BPMN Studio — local assistant server.
 *
 * An OpenAI-compatible Chat Completions API on this machine that answers with the locally
 * installed Claude Code CLI (`claude -p`), using its existing login (subscription; no API key).
 * BPMN Studio in the browser connects to it in "Local API" mode.
 *
 * Differences from a plain CLI wrapper:
 *   - OpenAI function calling: requests with `tools` get `tool_calls` back. The CLI runs with
 *     --json-schema, so the model's answer is constrained to {message, tool_calls[]} and arrives
 *     already validated; the CLI itself never runs any tool (--tools "" --strict-mcp-config).
 *   - Conversation history with `role: "tool"` messages and assistant `tool_calls`.
 *   - Browser access from the studio's (remote) origin: CORS + Private Network Access headers,
 *     origin allow-list and a Bearer token from config.json.
 *
 * Endpoints:
 *   GET  /health                 status, version, whether `claude` is installed
 *   GET  /v1/models
 *   POST /v1/chat/completions    OpenAI-compatible, "stream": true supported, "tools" supported
 */

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const crypto = require("crypto");
const { spawn, execFile } = require("child_process");

const VERSION = "1.0.0";

// ---------------------------------------------------------------- configuration

function fail(message) {
  console.error(`config: ${message}`);
  process.exit(1);
}

function loadConfig() {
  const file = path.join(__dirname, "config.json");
  let cfg = {};
  if (fs.existsSync(file)) {
    try {
      // editors on Windows like to save with a byte order mark
      cfg = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    } catch (err) {
      fail(`config.json: ${err.message}`);
    }
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) fail("config.json must contain a JSON object");
  }
  const env = process.env;
  const list = (v) => (Array.isArray(v) ? v : String(v || "").split(",")).map((s) => String(s).trim()).filter(Boolean);
  const int = (name, value, min, max) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max) fail(`${name} must be an integer from ${min} to ${max} (got ${JSON.stringify(value)})`);
    return n;
  };
  const str = (name, value) => {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "string") fail(`${name} must be a string`);
    return value;
  };
  const token = str("token", env.BPMN_LOCAL_TOKEN || cfg.token);
  if (token !== null && token.length < 16) fail("token must be at least 16 characters");
  const origins = [...list(cfg.allowedOrigins), ...list(env.BPMN_LOCAL_ALLOWED_ORIGINS)];
  if (origins.includes("*") && !token) fail('allowedOrigins "*" needs a token: any website could use your Claude subscription otherwise');
  return {
    port: int("port", env.BPMN_LOCAL_PORT || cfg.port || 8138, 1, 65535),
    host: str("host", env.BPMN_LOCAL_HOST || cfg.host) || "127.0.0.1",
    token,
    allowedOrigins: new Set([...list(cfg.allowedOrigins), ...list(env.BPMN_LOCAL_ALLOWED_ORIGINS)]),
    claudeBin: str("claudeBin", env.CLAUDE_BIN || cfg.claudeBin) || "claude",
    timeoutMs: int("timeoutMs", env.BPMN_LOCAL_TIMEOUT_MS || cfg.timeoutMs || 30 * 60 * 1000, 1000, 24 * 60 * 60 * 1000),
    maxConcurrent: int("maxConcurrent", env.BPMN_LOCAL_MAX_CONCURRENT || cfg.maxConcurrent || 2, 1, 16),
    defaultModel: str("defaultModel", cfg.defaultModel) || "opus",
  };
}

const CFG = loadConfig();
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MAX_BODY_BYTES = 20 * 1024 * 1024;
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);
const MODELS = ["opus", "sonnet", "haiku"];

// Anyone who can reach a non-loopback address could use the Claude subscription: require the token.
if (!LOOPBACK_HOSTS.has(CFG.host) && CFG.host !== "::1" && !CFG.token) {
  fail(`host ${CFG.host} is reachable from other machines: set "token" in config.json (or BPMN_LOCAL_TOKEN)`);
}

// Every run gets its own empty scratch directory (the CLI never sees the user's files), removed afterwards.
const WORK_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bpmn-assistant-"));
function cleanup() {
  try { fs.rmSync(WORK_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
}
process.on("exit", cleanup);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------- request guards

// With a token every request must carry it, so any studio address may connect (GitHub Pages, own
// domain, localhost …) without editing config.json. Without a token only localhost and the listed
// origins may: otherwise any website you open could use your Claude subscription.
const ANY_ORIGIN = !!CFG.token;

function isAllowedOrigin(origin) {
  if (origin === undefined) return true; // curl, SDKs
  return ANY_ORIGIN || LOOPBACK_ORIGIN.test(origin) || CFG.allowedOrigins.has(origin);
}

function checkRequest(req) {
  if (!isAllowedOrigin(req.headers.origin)) throw new HttpError(403, `Origin ${req.headers.origin} is not allowed (config.json → allowedOrigins)`);
  if (LOOPBACK_HOSTS.has(CFG.host) || CFG.host === "::1") {
    // DNS rebinding: a foreign hostname resolving to 127.0.0.1 must not reach us
    const host = String(req.headers.host || "").replace(/:\d+$/, "").toLowerCase();
    if (!LOOPBACK_HOSTS.has(host)) throw new HttpError(403, "Host not allowed");
  }
  if (req.method === "POST") {
    const type = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (type !== "application/json") throw new HttpError(415, "Content-Type must be application/json");
  }
}

function checkAuth(req) {
  if (!CFG.token) return;
  // compare fixed-size digests: no early exit on length, no throw on multi-byte input
  const digest = (v) => crypto.createHash("sha256").update(v).digest();
  const ok = crypto.timingSafeEqual(digest(String(req.headers.authorization || "")), digest(`Bearer ${CFG.token}`));
  if (!ok) throw new HttpError(401, "Missing or invalid token (Authorization: Bearer …)");
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin === undefined || !isAllowedOrigin(origin)) return;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "600");
  // Chrome's Private Network Access: a page from a public origin may reach 127.0.0.1 only if allowed
  if (req.headers["access-control-request-private-network"] === "true") {
    res.setHeader("Access-Control-Allow-Private-Network", "true");
  }
}

// ---------------------------------------------------------------- helpers

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // stop buffering but let the 413 reach the client; the connection is closed after the answer
        req.removeAllListeners("data");
        req.resume();
        const err = new HttpError(413, "Request body too large");
        err.closeConnection = true;
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        reject(new HttpError(400, "Body must be valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(payload), ...headers });
  res.end(payload);
}

const genId = (prefix) => `${prefix}-${crypto.randomBytes(12).toString("hex")}`;

function textOf(content) {
  if (typeof content === "string") return content;
  if (content === null || content === undefined) return "";
  if (Array.isArray(content)) {
    return content.map((p) => {
      if (p && p.type === "text" && typeof p.text === "string") return p.text;
      // silently dropping an image would make the model answer about something it never saw
      throw new HttpError(400, `Unsupported content part "${p && p.type}": only text is supported`);
    }).join("");
  }
  throw new HttpError(400, "Message content must be a string or an array of text parts");
}

// ---------------------------------------------------------------- OpenAI messages → one CLI prompt

/**
 * `claude -p` takes a single prompt, so the OpenAI history (including assistant tool_calls and
 * tool results) is rendered as a transcript; system/developer messages become --system-prompt.
 */
function buildPrompt(messages, tools) {
  if (!Array.isArray(messages) || !messages.length) throw new HttpError(400, '"messages" must be a non-empty array');
  const system = [];
  const turns = [];
  for (const m of messages) {
    if (!m || typeof m.role !== "string") continue;
    const text = textOf(m.content);
    if (m.role === "system" || m.role === "developer") {
      if (text) system.push(text);
    } else if (m.role === "user") {
      turns.push(`User: ${text}`);
    } else if (m.role === "assistant") {
      const parts = [];
      if (text) parts.push(text);
      for (const c of m.tool_calls || []) {
        parts.push(`[tool call ${c.id}] ${c.function && c.function.name}(${c.function && c.function.arguments})`);
      }
      turns.push(`Assistant: ${parts.join("\n")}`);
    } else if (m.role === "tool") {
      turns.push(`Tool result for ${m.tool_call_id}:\n${text}`);
    }
  }
  if (!turns.length) throw new HttpError(400, "No user/assistant messages");

  if (tools.length) {
    system.push(
      [
        "# Actions the client application can perform for you",
        "Your only callable tool is StructuredOutput: every answer is exactly one StructuredOutput call. The actions listed below are NOT tools — never call them by name (such a call fails and wastes a turn); request them inside StructuredOutput.tool_calls instead.",
        "The client application performs those actions for you. The available actions (with a JSON Schema of their arguments in `parameters`):",
        JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))),
        "",
        "How to answer — always by filling the structured response:",
        '- To have actions performed: list them in "tool_calls" (`name` + `arguments` = the arguments as a JSON object encoded in a string) and put a short note for the user into "message" (may be empty). The client runs them and sends you the results in the next turn as "Tool result for …".',
        '- To answer the user without actions: "tool_calls" = [] and the full answer in "message" (Markdown is fine).',
        "- Never invent action results; wait for them.",
        "- Do not mention StructuredOutput, this answer format or how actions are delivered; to the user, actions are simply things you do.",
      ].join("\n")
    );
  }
  return {
    systemPrompt: system.join("\n\n") || "You are a helpful assistant.",
    // always a transcript: input starting with "/" must never reach the CLI as a slash command
    prompt: turns.join("\n\n"),
  };
}

function normalizeTools(body) {
  if (!Array.isArray(body.tools) || body.tool_choice === "none") return [];
  return body.tools
    .filter((t) => t && t.type === "function" && t.function && t.function.name)
    .map((t) => ({ name: t.function.name, description: t.function.description || "", parameters: t.function.parameters || { type: "object" } }));
}

function toolCallSchema(tools) {
  return {
    type: "object",
    properties: {
      message: { type: "string" },
      tool_calls: {
        type: "array",
        items: {
          type: "object",
          properties: { name: { type: "string", enum: tools.map((t) => t.name) }, arguments: { type: "string" } },
          required: ["name", "arguments"],
          additionalProperties: false,
        },
      },
    },
    required: ["message", "tool_calls"],
    additionalProperties: false,
  };
}

// ---------------------------------------------------------------- running the CLI

/**
 * The system prompt (with the tool catalog, ~30 KB) goes in a file: command lines are limited
 * (32 KB on Windows, 128 KB per argument on Linux).
 */
function cliArgs({ systemPromptFile, model, effort, jsonSchema, stream }) {
  const args = ["-p", "--system-prompt-file", systemPromptFile, "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands"];
  args.push("--output-format", stream ? "stream-json" : "json");
  if (stream) args.push("--include-partial-messages", "--verbose");
  if (model) args.push("--model", model);
  if (effort && EFFORT_LEVELS.has(effort)) args.push("--effort", effort);
  if (jsonSchema) args.push("--json-schema", JSON.stringify(jsonSchema));
  return args;
}

/**
 * How to start the CLI without a shell. On Windows npm installs "claude.cmd", which spawn() cannot
 * run without shell:true (and a shell would re-parse the arguments): run its cli.js with node instead.
 */
function resolveClaude(bin) {
  if (process.platform !== "win32" || path.extname(bin)) return { command: bin, prefix: [] };
  const dirs = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    if (fs.existsSync(path.join(dir, `${bin}.exe`))) return { command: path.join(dir, `${bin}.exe`), prefix: [] };
    if (fs.existsSync(path.join(dir, `${bin}.cmd`))) {
      const cli = path.join(dir, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
      if (fs.existsSync(cli)) return { command: process.execPath, prefix: [cli] };
    }
  }
  return { command: bin, prefix: [] };
}
const CLAUDE = resolveClaude(CFG.claudeBin);

// A few CLI processes at a time: each one is a full Claude Code session.
let running = 0;
function acquireSlot() {
  if (running >= CFG.maxConcurrent) throw new HttpError(429, `Busy: ${running} requests are running (config.json → maxConcurrent)`);
  running++;
  let released = false;
  return () => { if (!released) { released = true; running--; } };
}

/** Run claude in a fresh scratch directory with the system prompt file; the prompt goes to stdin. */
async function runCli(opts, prompt, res, onLine) {
  const dir = fs.mkdtempSync(path.join(WORK_ROOT, "run-"));
  try {
    const systemPromptFile = path.join(dir, ".system-prompt.txt");
    fs.writeFileSync(systemPromptFile, opts.systemPrompt, { mode: 0o600 });
    return await spawnCli(cliArgs({ ...opts, systemPromptFile }), prompt, res, onLine, dir);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Spawn claude with the prompt on stdin; kill it on timeout or when the HTTP client goes away. */
function spawnCli(args, prompt, res, onLine, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE.command, [...CLAUDE.prefix, ...args], { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    // decode as a stream: a multi-byte character split between two chunks must not turn into U+FFFD
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (fn) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      res.removeListener("close", onClose);
      fn();
    };
    const timer = setTimeout(() => finish(() => { child.kill("SIGKILL"); reject(new HttpError(504, `claude did not finish within ${CFG.timeoutMs} ms`)); }), CFG.timeoutMs);
    const onClose = () => { if (!res.writableEnded) finish(() => { child.kill("SIGKILL"); reject(new HttpError(499, "Client disconnected")); }); };
    res.on("close", onClose);

    let lastResult = null;
    if (onLine) {
      readline.createInterface({ input: child.stdout }).on("line", (line) => {
        if (!line.trim()) return;
        let obj;
        try { obj = JSON.parse(line); } catch { return; /* not JSON */ }
        if (obj && obj.type === "result") lastResult = obj;
        onLine(obj);
      });
    } else {
      child.stdout.on("data", (d) => (stdout += d));
    }
    child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-8000)));
    child.on("error", (err) => finish(() => reject(new HttpError(500, `Cannot start "${CFG.claudeBin}": ${err.message}. Is Claude Code installed?`))));
    child.on("close", (code) => finish(() => {
      if (onLine) {
        if (code === 0) return resolve(null);
        // the CLI's own explanation ("Credit balance is too low", …) beats a bare exit code
        const reason = lastResult && lastResult.is_error && lastResult.result ? String(lastResult.result) : stderr.trim();
        return reject(new HttpError(502, reason || `claude exited with code ${code}`));
      }
      let parsed = null;
      try { parsed = JSON.parse(stdout); } catch { /* fall through */ }
      if (parsed && parsed.is_error) return reject(new HttpError(502, String(parsed.result || "claude reported an error")));
      if (code !== 0) return reject(new HttpError(502, stderr.trim() || `claude exited with code ${code}`));
      if (!parsed) return reject(new HttpError(502, "claude returned no JSON result"));
      resolve(parsed);
    }));
  });
}

function usageOf(u) {
  u = u || {};
  const prompt = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  const completion = u.output_tokens || 0;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

/** The structured answer of a --json-schema run; a plain text result (older CLI, refusal) becomes the message. */
function structuredOf(result) {
  if (result && result.structured_output && typeof result.structured_output === "object") return result.structured_output;
  if (result && typeof result.result === "string") {
    try {
      const parsed = JSON.parse(result.result);
      if (parsed && typeof parsed === "object" && typeof parsed.message === "string") return parsed;
    } catch { /* plain text */ }
    return { message: result.result, tool_calls: [] };
  }
  return { message: "", tool_calls: [] };
}

/** Turn the CLI's structured {message, tool_calls} answer into an OpenAI assistant message. */
function toOpenAiMessage(structured, tools) {
  const names = new Set(tools.map((t) => t.name));
  const calls = (structured && Array.isArray(structured.tool_calls) ? structured.tool_calls : [])
    .filter((c) => c && names.has(c.name))
    .map((c) => {
      let args = typeof c.arguments === "string" ? c.arguments : JSON.stringify(c.arguments || {});
      try { args = JSON.stringify(JSON.parse(args)); } catch { /* keep as is; the client reports invalid JSON back */ }
      return { id: genId("call"), type: "function", function: { name: c.name, arguments: args } };
    });
  const text = structured && typeof structured.message === "string" ? structured.message : "";
  return { message: { role: "assistant", content: text || (calls.length ? null : ""), ...(calls.length ? { tool_calls: calls } : {}) }, finish: calls.length ? "tool_calls" : "stop" };
}

// ---------------------------------------------------------------- handlers

async function handleChat(req, res) {
  checkAuth(req);
  const body = await readJsonBody(req);
  const release = acquireSlot();
  try {
    return await chat(body, res);
  } finally {
    release();
  }
}

async function chat(body, res) {
  const tools = normalizeTools(body);
  const { systemPrompt, prompt } = buildPrompt(body.messages, tools);
  const model = typeof body.model === "string" && body.model ? body.model : CFG.defaultModel;
  const effort = typeof body.effort === "string" ? body.effort : typeof body.reasoning_effort === "string" ? body.reasoning_effort : undefined;
  const stream = body.stream === true;
  // OpenAI sends a usage chunk in streams only on request
  const streamUsage = !!(body.stream_options && body.stream_options.include_usage);
  const id = genId("chatcmpl");
  const created = Math.floor(Date.now() / 1000);

  if (tools.length) {
    // Structured answer: one constrained-decoding result, not streamed token by token.
    const run = () => runCli({ systemPrompt, model, effort, jsonSchema: toolCallSchema(tools) }, prompt, res);
    if (!stream) {
      const result = await run();
      const { message, finish } = toOpenAiMessage(structuredOf(result), tools);
      return sendJson(res, 200, { id, object: "chat.completion", created, model, choices: [{ index: 0, message, finish_reason: finish }], usage: usageOf(result.usage) });
    }
    openStream(res);
    const chunk = (delta, finish) => writeChunk(res, { id, created, model }, delta, finish);
    chunk({ role: "assistant", content: "" }, null);
    const stopBeat = heartbeat(res);
    try {
      // stream the CLI's progress while the structured answer is generated: its reasoning as
      // "reasoning_content", and how far the answer has come as x_bpmn_progress (clients ignore
      // unknown fields); the answer itself arrives complete at the end
      let result = null;
      let chars = 0;
      let lastProgress = 0;
      await runCli({ systemPrompt, model, effort, jsonSchema: toolCallSchema(tools), stream: true }, prompt, res, (obj) => {
        const delta = obj.type === "stream_event" && obj.event && obj.event.type === "content_block_delta" ? obj.event.delta : null;
        if (delta && delta.type === "thinking_delta" && delta.thinking) {
          chunk({ reasoning_content: delta.thinking }, null);
        } else if (delta && (delta.type === "input_json_delta" || delta.type === "text_delta")) {
          chars += (delta.partial_json || delta.text || "").length;
          if (Date.now() - lastProgress > 250) {
            lastProgress = Date.now();
            res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: null }], x_bpmn_progress: { chars } })}\n\n`);
          }
        } else if (obj.type === "result") {
          result = obj;
        }
      });
      if (!result) throw new HttpError(502, "claude returned no result");
      if (result.is_error) throw new HttpError(502, String(result.result || "claude reported an error"));
      const { message, finish } = toOpenAiMessage(structuredOf(result), tools);
      if (message.content) chunk({ content: message.content }, null);
      (message.tool_calls || []).forEach((c, index) => chunk({ tool_calls: [{ index, ...c }] }, null));
      chunk({}, finish);
      endStream(res, streamUsage ? usageOf(result.usage) : null, { id, created, model });
    } catch (err) {
      failStream(res, err);
    } finally {
      stopBeat();
    }
    return;
  }

  // Plain text
  if (!stream) {
    const result = await runCli({ systemPrompt, model, effort }, prompt, res);
    return sendJson(res, 200, {
      id, object: "chat.completion", created, model,
      choices: [{ index: 0, message: { role: "assistant", content: String(result.result || "") }, finish_reason: "stop" }],
      usage: usageOf(result.usage),
    });
  }
  openStream(res);
  writeChunk(res, { id, created, model }, { role: "assistant", content: "" }, null);
  const stopBeat = heartbeat(res);
  let usage = null;
  let finish = "stop";
  let resultError = null;
  try {
    await runCli({ systemPrompt, model, effort, stream: true }, prompt, res, (obj) => {
      if (obj.type === "stream_event" && obj.event && obj.event.type === "content_block_delta" && obj.event.delta && obj.event.delta.type === "text_delta") {
        writeChunk(res, { id, created, model }, { content: obj.event.delta.text || "" }, null);
      } else if (obj.type === "stream_event" && obj.event && obj.event.type === "content_block_delta" && obj.event.delta && obj.event.delta.type === "thinking_delta") {
        writeChunk(res, { id, created, model }, { reasoning_content: obj.event.delta.thinking || "" }, null);
      } else if (obj.type === "result") {
        usage = usageOf(obj.usage);
        if (obj.stop_reason === "max_tokens") finish = "length";
        if (obj.is_error) resultError = String(obj.result || "claude reported an error");
      }
    });
    if (resultError) throw new HttpError(502, resultError);
    writeChunk(res, { id, created, model }, {}, finish);
    endStream(res, streamUsage ? usage : null, { id, created, model });
  } catch (err) {
    failStream(res, err);
  } finally {
    stopBeat();
  }
}

/** An SSE comment every 15 s: proxies keep the connection, clients see the server is alive. */
function heartbeat(res) {
  const timer = setInterval(() => { if (!res.writableEnded) res.write(": keep-alive\n\n"); }, 15000);
  return () => clearInterval(timer);
}

function openStream(res) {
  res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
}
function writeChunk(res, { id, created, model }, delta, finish) {
  res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
}
function endStream(res, usage, { id, created, model }) {
  if (usage) res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [], usage })}\n\n`);
  res.end("data: [DONE]\n\n");
}
function failStream(res, err) {
  if (res.writableEnded) return;
  res.write(`data: ${JSON.stringify({ error: { message: err.message || "Internal error", type: "server_error" } })}\n\n`);
  res.end("data: [DONE]\n\n");
}

let claudeStatus = null;
function checkClaude() {
  return new Promise((resolve) => {
    execFile(CLAUDE.command, [...CLAUDE.prefix, "--version"], { timeout: 15000, windowsHide: true }, (err, stdout) => {
      resolve(err ? { available: false, error: err.code === "ENOENT" ? `"${CFG.claudeBin}" not found — install Claude Code and run "claude login"` : err.message }
        : { available: true, version: String(stdout).trim() });
    });
  });
}

const server = http.createServer(async (req, res) => {
  applyCors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(isAllowedOrigin(req.headers.origin) ? 204 : 403);
    return res.end();
  }
  try {
    checkRequest(req);
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/health") {
      checkAuth(req);
      if (!claudeStatus || url.searchParams.has("refresh")) claudeStatus = await checkClaude();
      return sendJson(res, 200, { ok: true, name: "bpmn-studio-local", version: VERSION, claude: claudeStatus, capabilities: { tools: true, stream: true } });
    }
    if (req.method === "GET" && url.pathname === "/v1/models") {
      checkAuth(req);
      const created = Math.floor(Date.now() / 1000);
      return sendJson(res, 200, { object: "list", data: MODELS.map((id) => ({ id, object: "model", created, owned_by: "anthropic" })) });
    }
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") return await handleChat(req, res);
    throw new HttpError(404, "Not found");
  } catch (err) {
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) return res.end();
    sendJson(res, err instanceof HttpError ? err.status : 500, { error: { message: err.message || "Internal error", type: "server_error" } },
      err.closeConnection ? { Connection: "close" } : {});
  }
});

server.on("error", (err) => {
  console.error(err.code === "EADDRINUSE" ? `Port ${CFG.port} is busy — change "port" in config.json` : err.message);
  process.exit(1);
});

server.listen(CFG.port, CFG.host, async () => {
  claudeStatus = await checkClaude();
  console.log(`BPMN Studio local assistant ${VERSION} on http://${CFG.host}:${CFG.port}`);
  console.log(`  Claude Code: ${claudeStatus.available ? claudeStatus.version : "NOT AVAILABLE — " + claudeStatus.error}`);
  console.log(`  Allowed studio origins: ${ANY_ORIGIN ? "any (requests need the token)" : [...CFG.allowedOrigins].join(", ") || "(localhost only)"}`);
  console.log(`  Token: ${CFG.token ? "required" : "not set"}`);
  console.log("  In BPMN Studio: Ассистент → настройки → Local API → «Проверить соединение».");
});

// "exit" runs cleanup(); these make the usual ways of stopping the server end in a normal exit
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
  try { process.on(sig, () => process.exit(0)); } catch { /* signal not supported on this platform */ }
}
