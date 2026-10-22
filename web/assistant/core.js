// Browser core of BPMN Studio (bundled to core.js, global BpmnCore): storage, the assistant's tools,
// linting, deployment, import/export and the assistant itself. Everything runs in the user's browser;
// there is no studio server.
import { parseXml, specToXml, xmlToSpec } from '../../src/bpmn.js';
import { checkXml } from '../../src/lint.js';
import { applyConfig, config, deploySchema, deployTarget } from '../../src/config.js';
import { DiagramStore, MAX_XML, StoreError, normalizeName } from '../../src/store.js';
import { IdbAdapter } from '../../src/idbAdapter.js';
import { createTools, runTool, toolJsonSchemas } from '../../src/tools.js';
import { systemPrompt } from '../../src/prompt.js';
import { createZip, readZip } from '../../src/zip.js';
import { layoutProcess } from 'bpmn-auto-layout';
import { CUSTOM_PRESETS, PROVIDERS, ProviderError, providerLabel, runAssistant, testConnection } from './agent.js';

export { CUSTOM_PRESETS, PROVIDERS, ProviderError, providerLabel, runAssistant, testConnection, StoreError, normalizeName, config };

const hasDiagram = xml => /<([\w.-]+:)?BPMNDiagram[\s>]/.test(xml.replace(/<!--[\s\S]*?-->/g, ''));

/**
 * Positions for a file without a diagram section. The studio's own layout knows pools and lanes and
 * keeps every extension (it rebuilds from the spec with the file as "previous version"); content
 * the spec cannot represent falls back to bpmn-auto-layout (process only).
 */
async function withLayout(xml) {
  try {
    const { spec, lossy } = await xmlToSpec(xml);
    if (!lossy.length) return (await specToXml(spec, { previousXml: xml })).xml;
  } catch { /* fall back */ }
  return layoutProcess(xml);
}

/** Validate BPMN XML; returns an error message or null. */
export async function invalidBpmn(xml) {
  if (typeof xml !== 'string' || !xml.trim()) return 'пустой файл';
  if (xml.length > MAX_XML) return `слишком большой (максимум ${MAX_XML / 1024 / 1024} МБ)`;
  try { await parseXml(xml); return null; } catch (err) { return err.message; }
}

/**
 * @param {object} opts
 * @param {object} [opts.settings]        contents of bpmn-studio.config.json
 * @param {(name: string) => string} opts.show  switch the editor to a diagram (used by the assistant)
 * @param {object} [opts.adapter]         storage adapter (default: IndexedDB in this browser)
 */
export function createStudio({ settings, show, adapter } = {}) {
  if (settings) applyConfig(settings);
  const store = new DiagramStore(adapter || new IdbAdapter());
  const tools = createTools({ store, show });

  const assistantStudio = {
    async config() { return { systemPrompt: systemPrompt(), tools: toolJsonSchemas(tools) }; },
    // a failing tool is conversation content: the model reads the error and corrects itself
    async callTool(name, args) {
      try {
        return { ok: true, result: await runTool(tools, name, args) };
      } catch (err) {
        return { ok: false, error: String(err?.message ?? err ?? 'unknown error') };
      }
    }
  };

  async function createBlank(name, { platform, source = 'editor' } = {}) {
    const n = normalizeName(name);
    const base = n.replace(/\.bpmn$/, '');
    const { xml } = await specToXml({
      processName: base, processId: base,
      platform: ['camunda7', 'camunda8'].includes(platform) ? platform : config.defaultPlatform,
      elements: [{ id: 'StartEvent_1', type: 'startEvent' }], flows: []
    });
    return store.save(n, xml, { create: true, source });
  }

  /** Import a .bpmn (or .xml) file or a .zip of them. @returns {{ imported: string[], skipped: string[], failed: {name, error}[] }} */
  async function importFiles(files, { overwrite = false, source = 'import' } = {}) {
    const report = { imported: [], skipped: [], failed: [] };
    const entries = [];
    for (const file of files) {
      if (/\.zip$/i.test(file.name)) {
        for (const e of await readZip(await file.arrayBuffer())) {
          // macOS adds __MACOSX/._name resource forks next to every file
          if (/(^|\/)__MACOSX\//.test(e.name) || /(^|\/)\._/.test(e.name)) continue;
          if (/\.(bpmn|xml)$/i.test(e.name)) entries.push({ name: e.name.split('/').pop(), text: new TextDecoder().decode(e.data) });
        }
      } else {
        entries.push({ name: file.name, text: await file.text() });
      }
    }
    const seen = new Set();
    for (let { name, text } of entries) {
      try {
        const n = normalizeName(name.replace(/\.xml$/i, ''));
        // a/p.bpmn and b/p.bpmn in one archive: the second would replace the first
        if (seen.has(n.toLowerCase())) throw new Error(`имя ${n} встречается в импорте дважды`);
        seen.add(n.toLowerCase());
        const problem = await invalidBpmn(text);
        if (problem) throw new Error(`это не BPMN 2.0: ${problem}`);
        // a process without a diagram section (some exporters): lay it out, or the editor shows nothing
        if (!hasDiagram(text)) text = await withLayout(text);
        if (!overwrite && await store.exists(n)) { report.skipped.push(n); continue; }
        await store.save(n, text, { source });
        report.imported.push(n);
      } catch (err) {
        report.failed.push({ name, error: err.message });
      }
    }
    return report;
  }

  /** All diagrams as one .zip (backup / moving to another browser). */
  async function exportAll() {
    const files = [];
    for (const { file } of await store.list()) files.push({ name: file, data: (await store.get(file)).xml });
    return createZip(files);
  }

  /** "Отправить схему": to a configured target or to a URL the user typed. */
  async function deploy(name, { target, url, force = false }) {
    const { xml } = await store.get(name);
    const server = target ? deployTarget(target) : url;
    if (!server) throw new StoreError('Не указан сервер', 400);
    const lint = await checkXml(xml);
    if (lint.deployErrors?.length && !force) throw new StoreError('В схеме есть ошибки деплоя', 422, { deployErrors: lint.deployErrors });
    try {
      return await deploySchema(server, xml);
    } catch (err) {
      throw new StoreError(err.name === 'TimeoutError' ? 'Сервер не ответил за 30 с'
        : `Сервер недоступен или не разрешает запросы из браузера (CORS): ${server}`, 502);
    }
  }

  /** The local assistant server, pre-configured for this studio page and token. */
  async function localServerZip({ token, port = 8138, base = 'local-server/' }) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(token)) throw new Error('неверный токен');
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('порт должен быть числом от 1024 до 65535');
    const text = async name => {
      const res = await fetch(base + name);
      if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
      return res.text();
    };
    const root = 'bpmn-studio-local';
    // with the token, the server accepts any studio address ("*"): the same zip works on GitHub Pages and locally
    const cfg = { port, token, allowedOrigins: ['*'], defaultModel: 'opus' };
    return createZip([
      { name: `${root}/server.js`, data: await text('server.js'), mode: 0o755 },
      { name: `${root}/package.json`, data: await text('package.json') },
      { name: `${root}/README.md`, data: await text('README.md') },
      { name: `${root}/config.json`, data: JSON.stringify(cfg, null, 2) + '\n', mode: 0o600 },
      { name: `${root}/start.sh`, data: '#!/bin/sh\ncd "$(dirname "$0")" && exec node server.js\n', mode: 0o755 },
      { name: `${root}/start.cmd`, data: '@echo off\r\ncd /d "%~dp0"\r\nnode server.js\r\npause\r\n' }
    ]);
  }

  return {
    store, tools, assistantStudio, config,
    lint: xml => checkXml(xml),
    createBlank, importFiles, exportAll, deploy, localServerZip,
    persist: () => IdbAdapter.persist()
  };
}
