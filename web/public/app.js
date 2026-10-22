// BPMN Studio client. Everything runs in this browser: the editor, the diagram storage (IndexedDB),
// the assistant and its tools (BpmnCore). Other tabs of the same browser are kept in sync with a
// BroadcastChannel. There is no studio server.
(() => {
'use strict';

const $ = id => document.getElementById(id);
const TAB_ID = Math.random().toString(36).slice(2);
const local = {
  get(key, fallback) { try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
  /** @returns {boolean} false when the browser refused (quota, private mode) */
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } },
  remove(key) { try { localStorage.removeItem(key); } catch {} }
};

const Core = window.BpmnCore;
let studio = null;            // set at start: Core.createStudio(...)
let config = { defaultPlatform: 'camunda7', camunda7Editor: 'legacy', deploy: { targets: {} } };
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('bpmn-studio') : null;

// ================================================================== modeler

// Editors:
//   legacy  – Camunda 7, the classic stack: bpmn-js 7.4.0 + properties panel 0.42.0
//   camunda7 / camunda8 – camunda-bpmn-js (Camunda Modeler 5 distribution)
const EDITORS = {
  legacy: { script: 'legacy/modeler.js', global: 'LegacyBpmnModeler', css: 'legacy', label: 'классический редактор · bpmn-js 7.4' },
  camunda7: { script: 'vendor/modeler-platform.js', global: 'BpmnModeler', css: 'modern', label: 'camunda-bpmn-js' },
  camunda8: { script: 'vendor/modeler-cloud.js', global: 'BpmnModeler', css: 'modern', label: 'camunda-bpmn-js' }
};
const modelerClasses = {};
const loading = {};

function loadModelerClass(editor) {
  if (modelerClasses[editor]) return Promise.resolve(modelerClasses[editor]);
  // the modern bundles share the global "BpmnModeler": load one at a time and capture it right away
  return (loading[editor] ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = EDITORS[editor].script;
    s.onload = () => { modelerClasses[editor] = window[EDITORS[editor].global]; resolve(modelerClasses[editor]); };
    s.onerror = () => { delete loading[editor]; reject(new Error(`failed to load ${s.src}`)); };
    document.head.appendChild(s);
  }));
}

const editorFor = platform => platform === 'camunda7' && config.camunda7Editor !== 'modern' ? 'legacy' : platform;

// legacy and modern diagram-js stylesheets use the same class names: only one set may be active
function useStyles(kind) {
  for (const link of document.querySelectorAll('link[data-css]')) link.disabled = link.dataset.css !== kind;
}

function detectPlatform(xml) {
  if (/executionPlatform="Camunda Platform"/.test(xml) || (/xmlns:camunda=/.test(xml) && !/xmlns:zeebe=/.test(xml))) return 'camunda7';
  if (/executionPlatform="Camunda Cloud"/.test(xml) || /xmlns:zeebe=/.test(xml)) return 'camunda8';
  return config.defaultPlatform || 'camunda7'; // plain BPMN: the studio's platform
}

const doc = {
  file: null,       // name of the open diagram
  hash: null,       // stored version the editor content is based on
  platform: null,
  editor: null,
  dirty: false,
  gone: false,      // the stored diagram vanished under the editor (deleted — or renamed, see 'renamed')
  saving: null      // promise of the running save
};
let modeler = null;
let importing = false;
let saveTimer = null;
let openSeq = 0;      // the latest openFile call wins; older ones stop at their next await

async function ensureModeler(platform, seq) {
  const editor = editorFor(platform);
  if (modeler && doc.editor === editor) return modeler;
  const Modeler = await loadModelerClass(editor);
  if (seq !== undefined && seq !== openSeq) return null;
  if (modeler) modeler.destroy();
  $('canvas').innerHTML = ''; $('props').innerHTML = '';
  useStyles(EDITORS[editor].css);
  modeler = new Modeler({
    container: '#canvas', propertiesPanel: { parent: '#props' },
    // diagram-js 6 (legacy editor) listens to the keyboard only when told where; diagram-js 15 rejects bindTo
    ...(editor === 'legacy' ? { keyboard: { bindTo: document } } : {})
  });
  doc.editor = editor;
  modeler.on('commandStack.changed', () => {
    if (importing) return;
    doc.dirty = true;
    setSaveState('Есть изменения…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => save(), 600);
  });
  modeler.on('selection.changed', updateContextChip);
  return modeler;
}

/** @returns {Promise<boolean>} false if a newer openFile took over meanwhile */
async function importXml(xml, { keepView, seq }) {
  const platform = detectPlatform(xml);
  const m = await ensureModeler(platform, seq);
  if (!m || seq !== openSeq) return false;
  const canvas = m.get('canvas');
  const view = keepView ? canvas.viewbox() : null;
  importing = true;
  try {
    const { warnings } = await m.importXML(xml);
    if (warnings.length) console.warn('import warnings', warnings);
  } finally {
    importing = false;
  }
  if (seq !== openSeq) return false;
  markedRefs = new Set(); // a fresh import has no markers: the referenced elements get theirs again
  if (view) canvas.viewbox({ x: view.x, y: view.y, width: view.width, height: view.height });
  else canvas.zoom('fit-viewport', 'auto');
  doc.platform = platform;
  const version = /executionPlatformVersion="([^"]+)"/.exec(xml)?.[1];
  $('platform').textContent = `${platform === 'camunda7' ? 'Camunda 7' : 'Camunda 8'}${version ? ' ' + version : ''} · ${EDITORS[doc.editor].label}`;
  return true;
}

async function openFile(file, { keepView = false, discard = false } = {}) {
  if (doc.file && doc.file !== file && !discard) {
    if (!(await leaveCurrent())) { $('files').value = doc.file; return; }
  }
  const seq = ++openSeq;
  const { name, xml, hash } = await studio.store.get(file);
  if (seq !== openSeq) return;
  const sameFile = doc.file === name;
  let shown;
  try {
    shown = await importXml(xml, { keepView: keepView && sameFile, seq });
  } catch (err) {
    if (seq !== openSeq) return;
    // the editor may already be cleared or switched: show the previous diagram again
    const prev = doc.file;
    $('files').value = prev || '';
    if (prev && prev !== name) await openFile(prev, { discard: true }).catch(() => {});
    const why = /no diagram to display/i.test(err.message) ? 'в файле нет диаграммы (раздела BPMNDiagram)' : err.message;
    throw new Error(`Не удалось открыть «${name}»: ${why}`);
  }
  if (!shown) return;
  // only now the editor shows this diagram: from here on, saves go to it (under its current name,
  // if it was renamed while it loaded)
  doc.file = followRenames(name); doc.hash = hash; doc.dirty = false; doc.gone = false; doc.goneHash = null;
  hideBanner();
  $('files').value = name;
  $('placeholder').hidden = true;
  $('delete').disabled = $('rename').disabled = false;
  local.set('bpmn-studio:file', name);
  setSaveState('Сохранено');
  updateContextChip();
  refreshLint(xml);
}

/** Before switching away: save, or — with an unresolved conflict — ask. */
async function leaveCurrent() {
  if (!$('banner').hidden && doc.dirty) {
    return confirm(`В «${doc.file}» есть несохранённые правки, которые конфликтуют с другой версией. Перейти и потерять их?`);
  }
  await flushSave();
  return true;
}

// ---- saving

function setSaveState(text, isError = false) {
  const el = $('save-state');
  el.textContent = text;
  el.classList.toggle('err', isError);
}

/**
 * Save the editor content. Calls are serialized: one save at a time, a later call waits and then
 * saves whatever is dirty by then. force = overwrite the stored version (conflict banner "keep mine").
 */
async function save({ force = false } = {}) {
  clearTimeout(saveTimer);
  while (doc.saving) await doc.saving;
  if (!modeler || !doc.file || !doc.dirty) return;
  if (!$('banner').hidden && !force) return; // an unresolved conflict waits for the user's choice
  const file = doc.file;
  const run = (async () => {
    setSaveState('Сохранение…');
    const { xml } = await modeler.saveXML({ format: true });
    doc.dirty = false;
    try {
      const res = await studio.store.save(file, xml, { baseHash: force ? undefined : doc.hash, source: TAB_ID });
      if (doc.file !== file) return;
      doc.hash = res.hash; doc.gone = false; doc.goneHash = null;
      hideBanner();
      setSaveState('Сохранено');
      refreshLint(xml);
    } catch (err) {
      doc.dirty = true;
      if (err.status === 409 && err.deleted && doc.file !== file) {
        // renamed while this save was running: the edits go to the new name
        doc.saving = null;
        return save();
      } else if (err.status === 409 && err.deleted) {
        setSaveState('Диаграмма удалена', true);
        showBanner('Эту диаграмму удалили в другой вкладке. «Оставить мою версию» сохранит её снова.');
        doc.goneHash = doc.hash; doc.hash = null; doc.gone = true;
      } else if (err.status === 409 && err.current) {
        setSaveState('Конфликт', true);
        showBanner('Диаграмму изменили в другом месте (ассистент или другая вкладка), пока вы её правили.');
      } else {
        setSaveState(`Ошибка сохранения: ${err.message}`, true);
      }
    }
  })();
  doc.saving = run;
  try { await run; } finally { if (doc.saving === run) doc.saving = null; }
}

async function flushSave() {
  clearTimeout(saveTimer);
  if (doc.dirty) await save();
  else while (doc.saving) await doc.saving;
}

// ---- conflicts

function showBanner(text) { $('banner-text').textContent = text; $('banner').hidden = false; }
function hideBanner() { $('banner').hidden = true; }

$('banner-load').onclick = () => openFile(doc.file, { keepView: true, discard: true }).catch(err => {
  setSaveState(err.status === 404 ? 'Диаграммы больше нет — можно только «Оставить мою версию»' : err.message, true);
});
$('banner-keep').onclick = async () => {
  if (doc.gone) {
    // "deleted" may be a rename whose notice from another tab is still on its way
    await new Promise(r => setTimeout(r, 400));
    if (!doc.gone) return; // it was a rename: the edits are already being saved under the new name
  }
  doc.dirty = true;
  await save({ force: true });
};

// ---- diagrams

async function refreshFiles() {
  const files = await studio.store.list();
  const sel = $('files');
  sel.innerHTML = '';
  for (const f of [...files].sort((a, b) => a.file.localeCompare(b.file))) {
    const o = document.createElement('option');
    o.value = f.file; o.textContent = f.file.replace(/\.bpmn$/, '');
    sel.appendChild(o);
  }
  if (doc.file) sel.value = doc.file;
  $('placeholder').hidden = files.length > 0;
  $('delete').disabled = $('rename').disabled = !doc.file;
  return files;
}

$('files').onchange = e => openFile(e.target.value).catch(err => toast(err.message, 'err', 10000));

$('new').onclick = async () => {
  const name = prompt('Имя новой диаграммы (например order-process):');
  if (!name) return;
  try {
    const { name: file } = await studio.createBlank(name, { source: TAB_ID });
    await refreshFiles();
    await openFile(file);
  } catch (err) { toast(err.message, 'err'); }
};

$('rename').onclick = async () => {
  if (!doc.file) return;
  const from = doc.file;
  const input = prompt('Новое имя диаграммы:', from.replace(/\.bpmn$/, ''));
  if (input === null || !input.trim() || input.trim() === from.replace(/\.bpmn$/, '')) return;
  try {
    await flushSave(); // pending edits go to the current name first
    const { name, renamed } = await studio.store.rename(from, input, { source: TAB_ID });
    if (renamed) toast(`Переименовано: ${from} → ${name}`);
  } catch (err) { toast(err.message, 'err', 8000); }
};

$('delete').onclick = async () => {
  if (!doc.file || !confirm(`Удалить «${doc.file}» из этого браузера? Это нельзя отменить (сделайте копию: Скачать ▾ → Все схемы).`)) return;
  const name = doc.file;
  // pending edits of a diagram being deleted are dropped, a running save finishes first
  clearTimeout(saveTimer);
  doc.dirty = false;
  while (doc.saving) await doc.saving;
  try {
    await studio.store.delete(name, { source: TAB_ID });
    doc.file = null; doc.hash = null; doc.dirty = false;
    hideBanner();
    local.remove('bpmn-studio:file');
    const files = await refreshFiles();
    if (files[0]) await openFile(files[0].file, { discard: true });
    else { modeler?.clear?.(); $('platform').textContent = ''; setSaveState(''); showLint({ deployErrors: [], modelingIssues: [] }); }
    updateContextChip();
    toast(`Удалена ${name}`);
  } catch (err) { toast(err.message, 'err'); }
};

$('toggle-props').onclick = () => {
  $('props').hidden = !$('props').hidden;
  // narrow screens: an overlay below the header, so the button stays reachable to close it
  $('props').style.top = matchMedia('(max-width: 900px)').matches ? `${document.querySelector('header').getBoundingClientRect().bottom}px` : '';
  local.set('bpmn-studio:props', !$('props').hidden);
  modeler?.get('canvas').resized();
};
$('props').hidden = !local.get('bpmn-studio:props', innerWidth >= 1300);

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/** Show a header menu, shifted to stay inside the window on narrow screens. */
function toggleMenu(menu, others) {
  for (const o of others) o.hidden = true;
  menu.hidden = !menu.hidden;
  if (menu.hidden) return;
  menu.style.right = '';
  const r = menu.getBoundingClientRect();
  if (r.left < 8) menu.style.right = `${r.left - 8}px`;
  else if (r.right > innerWidth - 8) menu.style.right = `${r.right - innerWidth + 8}px`;
}
$('download').onclick = e => { e.stopPropagation(); toggleMenu($('download-menu'), [$('deploy-menu')]); };
document.addEventListener('click', () => { $('download-menu').hidden = true; $('deploy-menu').hidden = true; });
$('download-menu').onclick = async e => {
  const kind = e.target.closest('button')?.dataset.dl;
  if (!kind) return;
  try {
    if (kind === 'all') {
      await flushSave();
      const zip = await studio.exportAll();
      downloadBlob(new Blob([zip], { type: 'application/zip' }), `bpmn-studio-${new Date().toISOString().slice(0, 10)}.zip`);
      return;
    }
    if (!modeler || !doc.file) return toast('Сначала откройте или создайте схему', 'err');
    const base = doc.file.replace(/\.bpmn$/, '');
    const { xml, svg } = kind === 'svg' ? await modeler.saveSVG() : await modeler.saveXML({ format: true });
    downloadBlob(new Blob([kind === 'svg' ? svg : xml], { type: kind === 'svg' ? 'image/svg+xml' : 'application/xml' }), `${base}.${kind}`);
  } catch (err) { toast(err.message, 'err'); }
};

document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
});
// browsers cannot wait for an async save on unload: save when the tab is hidden, warn on close
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSave(); });
window.addEventListener('beforeunload', e => { if (doc.dirty) { save(); e.preventDefault(); } });

// ---- lint

let problemsOpen = local.get('bpmn-studio:problems', false);
let lastLint = null;
let lintSeq = 0;

async function refreshLint(xml) {
  const seq = ++lintSeq;
  try {
    const res = await studio.lint(xml);
    if (seq === lintSeq) showLint(res);
  } catch (err) { console.warn('lint failed', err); }
}

/** 1 ошибка, 2 ошибки, 5 ошибок, 21 ошибка … */
function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  const word = m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
  return `${n} ${word}`;
}

function parseIssue(line, severity) {
  const m = /^\[([^\]]+)\]\s*(?:([A-Za-z_][\w.-]*):\s)?(.*)$/.exec(line);
  return m ? { severity, rule: m[1], id: m[2], message: m[3] } : { severity, rule: '', id: null, message: line };
}

function showLint(res) {
  if (!res || (!res.deployErrors && !res.modelingIssues)) return;
  const issues = [
    ...(res.deployErrors || []).map(l => parseIssue(l, 'err')),
    ...(res.modelingIssues || []).map(l => parseIssue(l, 'warn'))
  ];
  lastLint = issues;
  const errs = issues.filter(i => i.severity === 'err').length, warns = issues.length - errs;
  $('problems-summary').innerHTML = issues.length
    ? `<span class="count-err">${plural(errs, 'ошибка', 'ошибки', 'ошибок')} деплоя</span> · <span class="count-warn">${plural(warns, 'замечание', 'замечания', 'замечаний')}</span> ${problemsOpen ? '▾' : '▸'}`
    : '<span class="count-ok">✓ нет проблем — модель можно деплоить</span>';
  const ul = $('problems-list');
  ul.innerHTML = '';
  for (const i of issues) {
    const li = document.createElement('li');
    li.className = i.severity;
    li.textContent = `${i.id ? i.id + ': ' : ''}${i.message} `;
    const code = document.createElement('code'); code.textContent = i.rule; li.appendChild(code);
    if (i.id) {
      li.tabIndex = 0;
      li.setAttribute('role', 'button');
      li.onclick = () => focusElement(i.id);
      li.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); focusElement(i.id); } };
    }
    ul.appendChild(li);
  }
  ul.hidden = !problemsOpen || !issues.length;
  markIssues(issues);
}

function markIssues(issues) {
  if (!modeler) return;
  const canvas = modeler.get('canvas'), registry = modeler.get('elementRegistry');
  for (const el of registry.getAll()) { canvas.removeMarker(el, 'lint-err'); canvas.removeMarker(el, 'lint-warn'); }
  for (const i of issues) if (i.id && registry.get(i.id)) canvas.addMarker(i.id, i.severity === 'err' ? 'lint-err' : 'lint-warn');
}

function focusElement(id) {
  const el = modeler?.get('elementRegistry').get(id);
  if (!el) return;
  modeler.get('selection').select(el);
  const canvas = modeler.get('canvas');
  if (canvas.scrollToElement) return canvas.scrollToElement(el);
  // diagram-js 6 (legacy editor) has no scrollToElement: centre the element in the current zoom
  const vb = canvas.viewbox();
  canvas.viewbox({ x: el.x + el.width / 2 - vb.width / 2, y: el.y + el.height / 2 - vb.height / 2, width: vb.width, height: vb.height });
}

$('problems-head').onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('problems-head').click(); } };
$('problems-head').onclick = () => {
  problemsOpen = !problemsOpen;
  local.set('bpmn-studio:problems', problemsOpen);
  if (lastLint) {
    showLint({
      deployErrors: lastLint.filter(i => i.severity === 'err').map(i => `[${i.rule}] ${i.id ? i.id + ': ' : ''}${i.message}`),
      modelingIssues: lastLint.filter(i => i.severity === 'warn').map(i => `[${i.rule}] ${i.id ? i.id + ': ' : ''}${i.message}`)
    });
  }
};

// ================================================================== changes from the assistant and from other tabs

// recent renames (old name → new name), to follow a diagram renamed while it was being opened
const renames = new Map();
function followRenames(name) {
  for (let i = 0; i < 20 && renames.has(name); i++) name = renames.get(name);
  return name;
}

async function onStoredChange({ type, file, to, hash, source }) {
  if (type === 'renamed') {
    renames.set(file, to);
    // the open diagram was renamed (here, in another tab or by the assistant): keep editing it
    if (doc.file === file) {
      doc.file = to;
      local.set('bpmn-studio:file', to);
      updateContextChip();
      if (doc.gone) {
        // a save of this tab hit the old name just after the rename: not deleted after all. Save
        // against the version the edits were based on, so a real conflict still shows.
        doc.gone = false;
        doc.hash = doc.goneHash; doc.goneHash = null;
        hideBanner();
        await refreshFiles();
        return save();
      }
    }
    await refreshFiles();
    return;
  }
  if (type === 'files' || type === 'deleted') await refreshFiles();
  if (type === 'deleted' && file === doc.file && source !== TAB_ID) {
    showBanner('Эту диаграмму удалили в другой вкладке. «Оставить мою версию» сохранит её снова.');
    doc.goneHash = doc.hash; doc.hash = null; doc.dirty = true; doc.gone = true;
    return;
  }
  if (type !== 'changed' || source === TAB_ID) return;
  if (!doc.file) { await refreshFiles(); return openFile(file); }
  if (file !== doc.file || hash === doc.hash) return;
  if (doc.dirty || doc.saving) {
    showBanner('Диаграмму изменили в другом месте (ассистент или другая вкладка), пока у вас были несохранённые правки.');
  } else {
    await openFile(doc.file, { keepView: true, discard: true });
    flash();
  }
}

function flash() {
  $('canvas').animate([{ boxShadow: 'inset 0 0 0 3px var(--accent)' }, { boxShadow: 'inset 0 0 0 0 transparent' }], { duration: 900 });
}

// ================================================================== assistant settings

const SETTINGS_KEY = 'bpmn-studio:assistant';

function loadSettings() {
  const s = local.get(SETTINGS_KEY, null) || { provider: null, profiles: {} };
  s.profiles = s.profiles || {};
  return s;
}
let assistantSettings = loadSettings();

/** Flat settings of the active provider, as the assistant core expects them. */
function activeSettings(s = assistantSettings) {
  if (!s.provider || !Core.PROVIDERS[s.provider]) return null;
  const p = s.profiles[s.provider] || {};
  return {
    provider: s.provider,
    apiKey: p.apiKey || '',
    model: p.model || Core.PROVIDERS[s.provider].defaultModel || '',
    baseUrl: p.baseUrl || '',
    effort: p.effort || 'default',
    name: p.name || '',
    headers: p.headers || null
  };
}

function isConfigured(s = activeSettings()) {
  if (!s) return false;
  const meta = Core.PROVIDERS[s.provider];
  // Local API: the token is created with the downloaded server; without it every request gets 401
  return (!meta.needsKey || !!s.apiKey) && (s.provider !== 'local' || !!s.apiKey) && (!meta.needsBaseUrl || /^https?:\/\//.test(s.baseUrl)) && !!s.model;
}

function renderAssistantChip() {
  const s = activeSettings();
  $('assistant-chip').textContent = isConfigured(s) ? `${Core.providerLabel(s)} · ${s.model}` : 'Ассистент не настроен';
  $('assistant-chip').classList.toggle('warn', !isConfigured(s));
}

function saveSettings() {
  if (!local.set(SETTINGS_KEY, assistantSettings)) toast('Браузер не дал сохранить настройки (переполнено хранилище или приватный режим).', 'err', 10000);
}

// ---- settings dialog

const dlg = $('assistant-settings');
let draft = null; // settings being edited

const profileOf = provider => (draft.profiles[provider] = draft.profiles[provider] || {});
const autoLocalUrl = port => `http://127.0.0.1:${port}/v1`;

function openSettings(message) {
  draft = structuredClone(assistantSettings);
  if (!draft.provider) draft.provider = 'local';
  renderSettings();
  setStatus(message || '', message ? 'info' : '');
  dlg.showModal();
}

function setStatus(text, kind = '') {
  const el = $('as-status');
  el.textContent = text;
  el.className = `as-status ${kind}`;
}

function renderSettings() {
  for (const r of dlg.querySelectorAll('input[name="as-provider"]')) r.checked = r.value === draft.provider;
  const meta = Core.PROVIDERS[draft.provider];
  const prof = profileOf(draft.provider);
  const custom = draft.provider === 'custom';
  // Local API: the token comes with the downloaded server, but can be typed for a server set up by hand
  $('as-key-row').hidden = !meta.needsKey && !custom && draft.provider !== 'local';
  $('as-key').value = prof.apiKey || '';
  $('as-key').placeholder = meta.keyHint || '';
  $('as-key-help').textContent = meta.help || '';
  $('as-model').value = prof.model || meta.defaultModel || '';
  $('as-model').placeholder = meta.defaultModel || 'выберите после проверки соединения';
  $('as-base').value = prof.baseUrl || '';
  $('as-base').placeholder = meta.baseUrl || 'https://api.anthropic.com';
  $('as-custom').hidden = !custom;
  $('as-base-row').hidden = custom; // custom has its own, required Base URL field
  $('as-headers-row').hidden = !custom;
  if (custom) {
    $('as-preset').value = prof.preset || 'other';
    $('as-name').value = prof.name || '';
    $('as-custom-base').value = prof.baseUrl || '';
    $('as-headers').value = prof.headers ? JSON.stringify(prof.headers) : '';
    $('as-preset-hint').textContent = Core.CUSTOM_PRESETS.find(p => p.id === $('as-preset').value)?.hint || '';
  }
  $('as-effort-row').hidden = !(draft.provider === 'anthropic' || draft.provider === 'local');
  $('as-effort').value = prof.effort || 'default';
  $('as-local').hidden = draft.provider !== 'local';
  $('as-port').value = prof.port || 8138;
  $('as-token').textContent = draft.provider === 'local' && prof.apiKey ? `${prof.apiKey.slice(0, 6)}…${prof.apiKey.slice(-4)}` : 'ещё не создан — скачайте сервер';
  fillModels(prof.models || []);
}

function fillModels(models) {
  const list = $('as-models');
  list.innerHTML = '';
  for (const m of models.slice(0, 500)) {
    const o = document.createElement('option');
    o.value = m;
    list.appendChild(o);
  }
}

/** Copy the form into the draft profile; throws (changing nothing) on invalid input. */
function readForm() {
  const prof = profileOf(draft.provider);
  const meta = Core.PROVIDERS[draft.provider];
  let headers = prof.headers ?? null;
  if (draft.provider === 'custom') {
    const raw = $('as-headers').value.trim();
    headers = null;
    if (raw) {
      let h;
      try { h = JSON.parse(raw); } catch { h = null; }
      if (!h || typeof h !== 'object' || Array.isArray(h) || Object.values(h).some(v => typeof v !== 'string')) {
        throw new Error('Дополнительные заголовки: нужен JSON-объект со строковыми значениями, например {"X-Workspace": "abc"}');
      }
      headers = h;
    }
  }
  if (meta.needsKey || draft.provider === 'custom' || draft.provider === 'local') prof.apiKey = $('as-key').value.trim();
  prof.model = $('as-model').value.trim();
  prof.effort = $('as-effort').value;
  if (draft.provider === 'custom') {
    prof.preset = $('as-preset').value;
    prof.name = $('as-name').value.trim();
    prof.baseUrl = $('as-custom-base').value.trim();
    prof.headers = headers;
  } else if (draft.provider === 'local') {
    const oldAuto = autoLocalUrl(prof.port || 8138);
    prof.port = Number($('as-port').value) || 8138;
    const typed = $('as-base').value.trim();
    // follow the port unless the user typed an address of their own
    prof.baseUrl = !typed || typed === oldAuto ? autoLocalUrl(prof.port) : typed;
    $('as-base').value = prof.baseUrl; // the next comparison must see what was derived
  } else {
    prof.baseUrl = $('as-base').value.trim();
  }
}

for (const r of dlg.querySelectorAll('input[name="as-provider"]')) {
  r.onchange = () => {
    try { readForm(); } catch { /* invalid input stays in the old profile untouched */ }
    draft.provider = r.value; renderSettings(); setStatus('');
  };
}
for (const p of Core.CUSTOM_PRESETS) {
  const o = document.createElement('option');
  o.value = p.id; o.textContent = p.name || 'Другой (свой адрес)';
  $('as-preset').appendChild(o);
}
$('as-preset').onchange = () => {
  const p = Core.CUSTOM_PRESETS.find(x => x.id === $('as-preset').value);
  $('as-preset-hint').textContent = p?.hint || '';
  if (p && p.id !== 'other') {
    $('as-name').value = p.name.replace(/ \(.*\)$/, '');
    $('as-custom-base').value = p.baseUrl;
    $('as-model').value = '';
    fillModels([]);
  }
  setStatus('Укажите ключ (если нужен) и нажмите «Проверить соединение», чтобы загрузить список моделей.', 'info');
};
$('as-key-toggle').onclick = () => { $('as-key').type = $('as-key').type === 'password' ? 'text' : 'password'; };

$('as-test').onclick = async () => {
  try { readForm(); } catch (err) { return setStatus(`✗ ${err.message}`, 'err'); }
  const s = activeSettings(draft);
  setStatus('Проверяю соединение…', 'info');
  $('as-test').disabled = true;
  try {
    const { models, detail } = await Core.testConnection(s);
    profileOf(draft.provider).models = models;
    fillModels(models);
    if (!$('as-model').value && models.length) {
      const preferred = Core.PROVIDERS[draft.provider].defaultModel;
      $('as-model').value = models.includes(preferred) ? preferred : models[0];
    }
    setStatus(`✓ ${detail}`, 'ok');
  } catch (err) {
    setStatus(`✗ ${err.message}`, 'err');
  } finally {
    $('as-test').disabled = false;
  }
};

$('as-download').onclick = async () => {
  try { readForm(); } catch (err) { return setStatus(`✗ ${err.message}`, 'err'); }
  const prof = profileOf('local');
  if (!prof.apiKey) {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    prof.apiKey = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }
  try {
    const zip = await studio.localServerZip({ token: prof.apiKey, port: prof.port || 8138 });
    downloadBlob(new Blob([zip], { type: 'application/zip' }), 'bpmn-studio-local.zip');
    // the token inside the zip must match the one we use: persist right away
    assistantSettings.profiles.local = { ...(assistantSettings.profiles.local || {}), apiKey: prof.apiKey, port: prof.port, baseUrl: prof.baseUrl };
    saveSettings();
    renderSettings();
    setStatus('Архив скачан. Распакуйте его, запустите сервер (node server.js) и нажмите «Проверить соединение».', 'info');
  } catch (err) {
    setStatus(`✗ Не удалось собрать архив: ${err.message}`, 'err');
  }
};

$('as-new-token').onclick = () => {
  if (!confirm('Создать новый токен? Старый локальный сервер перестанет принимать запросы — скачайте и запустите архив заново.')) return;
  profileOf('local').apiKey = '';
  renderSettings();
  setStatus('Токен сброшен. Скачайте сервер ещё раз.', 'info');
};

$('as-save').onclick = e => {
  e.preventDefault();
  try { readForm(); } catch (err) { return setStatus(`✗ ${err.message}`, 'err'); }
  const s = activeSettings(draft);
  if (!isConfigured(s)) {
    const meta = Core.PROVIDERS[s.provider];
    setStatus(s.provider === 'local' && !s.apiKey ? 'Сначала скачайте сервер («Скачать сервер (.zip)»): в нём создаётся токен, без него сервер не ответит.'
      : meta.needsKey && !s.apiKey ? 'Укажите API-ключ.'
      : meta.needsBaseUrl && !/^https?:\/\//.test(s.baseUrl) ? 'Укажите Base URL (http:// или https://).'
        : 'Выберите модель (нажмите «Проверить соединение», чтобы получить список).', 'err');
    return;
  }
  assistantSettings = draft;
  saveSettings();
  renderAssistantChip();
  dlg.close();
};
$('as-cancel').onclick = () => dlg.close();
$('assistant-chip').onclick = () => openSettings();
$('assistant-gear').onclick = () => openSettings();

// ================================================================== chat

const log = $('log'), input = $('input'), form = $('form');
const EXAMPLES = [
  'Нарисуй процесс выдачи кредита: заявка → скоринг (сервис scoring) → если балл > 700 автоодобрение, иначе ручная проверка группой risk; если проверка дольше 2 дней — эскалация.',
  'Добавь в эту диаграмму уведомление клиента после одобрения.',
  'Проверь, можно ли задеплоить эту диаграмму, и исправь ошибки.'
];
const TOOL_LABELS = {
  bpmn_create: 'Создаю диаграмму', bpmn_edit: 'Изменяю диаграмму', bpmn_read: 'Читаю диаграмму',
  bpmn_lint: 'Проверяю диаграмму', bpmn_list: 'Смотрю список диаграмм', bpmn_open: 'Открываю в редакторе',
  bpmn_rename: 'Переименовываю диаграмму', bpmn_undo: 'Откатываю изменение', bpmn_redo: 'Возвращаю изменение', bpmn_get_xml: 'Читаю XML',
  bpmn_write_xml: 'Записываю XML', bpmn_deploy: 'Отправляю схему'
};
const CHAT_KEY = 'bpmn-studio:chat2';
// messages: what the chat shows; history: provider-native conversation sent to the model
let chat = { provider: null, history: [], messages: [] };

// The chat lives in IndexedDB, complete: the history is sent back to the model exactly as it was
// (Claude checks that earlier turns are unchanged; a shortened history would cost its reasoning).
// localStorage, size-limited and shortened, only when IndexedDB is unavailable.
const chatDb = {
  open() {
    return (this.db ||= new Promise((resolve, reject) => {
      const req = indexedDB.open('bpmn-studio-chat', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  },
  async get(key) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const r = db.transaction('kv').objectStore('kv').get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  },
  async set(key, value) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  }
};

/** Tool results can be huge (whole XML): the localStorage fallback keeps a shortened copy. */
function compactForStorage(c) {
  const cut = text => (typeof text === 'string' && text.length > 4000 ? `${text.slice(0, 2000)}\n…[shortened in the saved chat; call the tool again if you need it]` : text);
  const bigArgs = v => (typeof v === 'string' ? v : JSON.stringify(v ?? '')).length > 4000;
  const history = c.history.map(m => {
    if (m.role === 'tool') return { ...m, content: cut(m.content) };
    // tool call arguments can hold a whole diagram (bpmn_write_xml): keep the call, drop the payload
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      return { ...m, tool_calls: m.tool_calls.map(t => (bigArgs(t.function?.arguments) ? { ...t, function: { ...t.function, arguments: '{"_omitted":"shortened in the saved chat"}' } } : t)) };
    }
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      return { ...m, content: m.content.map(b => (b.type === 'tool_use' && bigArgs(b.input) ? { ...b, input: { _omitted: 'shortened in the saved chat' } } : b)) };
    }
    if (m.role === 'user' && Array.isArray(m.content)) return { ...m, content: m.content.map(b => (b.type === 'tool_result' ? { ...b, content: cut(b.content) } : b)) };
    return m;
  });
  return { ...c, history };
}

let chatSaveTimer = null;
/** Save the chat; while the assistant streams, at most every 2 s. */
function saveChat({ soon = false } = {}) {
  clearTimeout(chatSaveTimer);
  if (soon) { chatSaveTimer = setTimeout(() => saveChat(), 2000); return; }
  const snapshot = { ...chat, messages: chat.messages.map(({ live, ...m }) => m) };
  chatDb.set('chat', snapshot).then(() => local.remove(CHAT_KEY)).catch(() => {
    if (local.set(CHAT_KEY, compactForStorage(snapshot))) return;
    local.remove(CHAT_KEY);
    toast('Переписка стала слишком большой и не сохраняется в браузере. Начните новый чат.', 'err', 10000);
  });
}

/**
 * A history saved mid-run (page closed while a tool ran) can end with tool calls that have no
 * results — every later request would be rejected. Drop such a trailing turn (the tail only, so
 * earlier turns and their reasoning stay valid).
 */
function dropUnansweredToolCalls(history) {
  for (;;) {
    const last = history[history.length - 1];
    const pending = last && last.role === 'assistant' && (
      (Array.isArray(last.tool_calls) && last.tool_calls.length) ||
      (Array.isArray(last.content) && last.content.some(b => b.type === 'tool_use')));
    if (!pending) return;
    history.pop();
  }
}

async function loadChat() {
  let saved = null;
  try { saved = await chatDb.get('chat'); } catch { /* no IndexedDB */ }
  // older versions kept the chat in localStorage
  chat = saved || local.get(CHAT_KEY, null) || { provider: null, history: [], messages: [] };
  dropUnansweredToolCalls(chat.history || (chat.history = []));
  for (const m of chat.messages) {
    delete m.live;
    for (const p of m.parts || []) if (p.kind === 'tool' && p.status === 'run') p.status = 'bad';
  }
}

// Model output is untrusted (it can echo text planted in diagram names): no images or other
// auto-loading content, links open in a new tab without referrer.
if (window.DOMPurify) {
  DOMPurify.addHook('afterSanitizeAttributes', node => {
    if (node.nodeName.toLowerCase() === 'a') { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer'); }
  });
}
const md = text => {
  if (window.marked && window.DOMPurify) {
    return DOMPurify.sanitize(marked.parse(text, { breaks: true }), {
      USE_PROFILES: { html: true }, // no SVG/MathML: <svg><image href=…> would load remote content
      FORBID_TAGS: ['img', 'picture', 'source', 'video', 'audio', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'style', 'link', 'meta'],
      FORBID_ATTR: ['style', 'srcset', 'background', 'poster']
    });
  }
  const d = document.createElement('div'); d.textContent = text; return d.innerHTML.replace(/\n/g, '<br>');
};

// ---------------------------------------------------------------- referenced elements
// The elements a message is about: the current selection (follows it, "auto"), plus elements the
// user pinned or mentioned with @ ("pinned"). Shown as chips above the input, marked on the canvas,
// described to the model, and kept as chips on the sent message.

const TYPE_LABELS = {
  startEvent: 'Старт', endEvent: 'Конец', intermediateCatchEvent: 'Событие', intermediateThrowEvent: 'Событие',
  boundaryEvent: 'Граничное событие', task: 'Задача', userTask: 'Задача пользователя', serviceTask: 'Сервисная задача',
  scriptTask: 'Скрипт', businessRuleTask: 'Бизнес-правило', sendTask: 'Отправка', receiveTask: 'Получение',
  manualTask: 'Ручная задача', callActivity: 'Вызов процесса', subProcess: 'Подпроцесс', transaction: 'Транзакция',
  exclusiveGateway: 'Шлюз XOR', parallelGateway: 'Шлюз AND', inclusiveGateway: 'Шлюз OR', eventBasedGateway: 'Шлюз событий',
  complexGateway: 'Шлюз', sequenceFlow: 'Поток', messageFlow: 'Поток сообщений', participant: 'Пул', lane: 'Дорожка',
  textAnnotation: 'Аннотация', dataObjectReference: 'Данные', dataStoreReference: 'Хранилище', group: 'Группа'
};
const shortType = el => (el.type || '').replace(/^bpmn:/, '').replace(/^./, c => c.toLowerCase());
const typeLabel = el => TYPE_LABELS[shortType(el)] || shortType(el);
const nameOf = el => (el?.businessObject?.name || '').trim();
const titleOf = el => nameOf(el) || el.id;

const refs = { file: null, auto: [], pinned: [], excluded: new Set() };

/** Elements of the diagram that can be referenced (no labels, no root). */
function referencable() {
  if (!modeler) return [];
  const root = modeler.get('canvas').getRootElement();
  return modeler.get('elementRegistry').filter(el => el !== root && el.type !== 'label' && el.businessObject && !/^bpmndi:/.test(el.type));
}

function selectionContext() {
  if (!modeler) return [];
  const root = modeler.get('canvas').getRootElement();
  const seen = new Set();
  return modeler.get('selection').get()
    .map(el => (el.type === 'label' ? el.labelTarget : el)) // a selected label means its element
    .filter(el => el && el !== root && el.businessObject && !seen.has(el.id) && seen.add(el.id))
    .map(el => el.id);
}

/** Ids attached to the next message, in order: pinned / mentioned first, then the live selection. */
function attachedIds() {
  const reg = modeler?.get('elementRegistry');
  if (!reg) return [];
  const ids = [...refs.pinned, ...refs.auto.filter(id => !refs.pinned.includes(id) && !refs.excluded.has(id))];
  return ids.filter(id => reg.get(id));
}

function pinRef(id) {
  if (!refs.pinned.includes(id)) refs.pinned.push(id);
  refs.excluded.delete(id);
  renderRefs();
}

function unref(id) {
  refs.pinned = refs.pinned.filter(x => x !== id);
  if (refs.auto.includes(id)) refs.excluded.add(id);
  renderRefs();
}

let markedRefs = new Set();
/** Dashed outline on the canvas for everything in the context. */
function markRefsOnCanvas(ids) {
  if (!modeler) return;
  const canvas = modeler.get('canvas'), reg = modeler.get('elementRegistry');
  const next = new Set(ids);
  for (const id of markedRefs) if (!next.has(id) && reg.get(id)) canvas.removeMarker(id, 'ctx-ref');
  for (const id of next) if (!markedRefs.has(id)) canvas.addMarker(id, 'ctx-ref');
  markedRefs = next;
}

function hoverRef(id, on) {
  const el = modeler?.get('elementRegistry').get(id);
  if (!el) return;
  modeler.get('canvas')[on ? 'addMarker' : 'removeMarker'](el, 'ctx-hover');
}

/** A chip for an element. editable: × and 📌 (above the input); otherwise it only points (sent messages). */
function refChip({ id, type, name, file }, { editable = false, pinned = false } = {}) {
  const chip = document.createElement('span');
  chip.className = `ref${pinned ? ' pinned' : ''}`;
  const t = document.createElement('span'); t.className = 'ref-type'; t.textContent = type;
  const n = document.createElement('span'); n.className = 'ref-name'; n.textContent = name || id;
  n.title = `${name ? `${name} · ` : ''}${id} — показать на схеме`;
  n.tabIndex = 0;
  const show = async () => {
    try {
      if (file && file !== doc.file) await openFile(file);
      if (!modeler.get('elementRegistry').get(id)) return toast(`Элемента ${id} больше нет на схеме`, 'err');
      focusElement(id);
    } catch (err) { toast(err.message, 'err'); }
  };
  n.onclick = show;
  n.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); show(); } };
  chip.onmouseenter = () => (!file || file === doc.file) && hoverRef(id, true);
  chip.onmouseleave = () => hoverRef(id, false);
  chip.append(t, n);
  if (editable) {
    const pin = document.createElement('button');
    pin.type = 'button'; pin.className = 'ref-pin'; pin.textContent = '📌';
    pin.title = pinned ? 'Закреплено: останется в контексте при смене выделения' : 'Закрепить: оставить в контексте при смене выделения';
    pin.setAttribute('aria-pressed', String(pinned));
    pin.onclick = () => { if (pinned) { refs.pinned = refs.pinned.filter(x => x !== id); renderRefs(); } else pinRef(id); };
    const x = document.createElement('button');
    x.type = 'button'; x.className = 'ref-x'; x.textContent = '×';
    x.title = 'Убрать из контекста'; x.setAttribute('aria-label', `Убрать ${name || id} из контекста`);
    x.onclick = () => { hoverRef(id, false); unref(id); input.focus(); };
    chip.append(pin, x);
  }
  return chip;
}

function renderRefs() {
  const box = $('ctx-refs');
  box.innerHTML = '';
  const reg = modeler?.get('elementRegistry');
  const ids = attachedIds();
  for (const id of ids) {
    const el = reg.get(id);
    box.appendChild(refChip({ id, type: typeLabel(el), name: nameOf(el) }, { editable: true, pinned: refs.pinned.includes(id) }));
  }
  markRefsOnCanvas(ids);
}

function updateContextChip() {
  // another diagram: what was pinned belonged to the previous one
  if (refs.file !== doc.file) { refs.file = doc.file; refs.pinned = []; refs.excluded.clear(); markedRefs = new Set(); }
  const auto = selectionContext();
  if (auto.join() !== refs.auto.join()) { refs.auto = auto; refs.excluded.clear(); }
  $('ctx-chip').textContent = doc.file ? `📄 ${doc.file}` : '';
  renderRefs();
}

/** What the model gets about one element: enough to act on it without reading the whole diagram first. */
function describeElement(el) {
  const reg = modeler.get('elementRegistry');
  const bo = el.businessObject;
  const label = x => (x ? `${x.id}${nameOf(x) ? ` «${nameOf(x)}»` : ''}` : '?');
  const parts = [`${label(el)} (${shortType(el)})`];
  if (el.waypoints) {
    parts.push(`${label(el.source)} → ${label(el.target)}`);
    const cond = bo.conditionExpression?.body;
    if (cond) parts.push(`condition ${cond}`);
    if (el.source?.businessObject?.default === bo) parts.push('default flow');
  } else {
    const lane = reg.filter(l => l.type === 'bpmn:Lane').find(l => (l.businessObject.flowNodeRef || []).includes(bo));
    if (lane) parts.push(`lane ${label(lane)}`);
    if (el.parent && /SubProcess|Transaction/.test(el.parent.type)) parts.push(`inside ${label(el.parent)}`);
    if (el.host) parts.push(`attached to ${label(el.host)}`);
    const into = (el.incoming || []).filter(c => c.type === 'bpmn:SequenceFlow').map(c => label(c.source));
    const out = (el.outgoing || []).filter(c => c.type === 'bpmn:SequenceFlow').map(c => label(c.target));
    if (into.length) parts.push(`from ${into.join(', ')}`);
    if (out.length) parts.push(`to ${out.join(', ')}`);
    const ed = bo.eventDefinitions?.[0];
    if (ed) {
      const kind = ed.$type.replace(/^bpmn:|EventDefinition$/g, '');
      const timer = ed.timeDuration?.body || ed.timeDate?.body || ed.timeCycle?.body;
      parts.push(`${kind}${timer ? ` ${timer}` : ''}${ed.messageRef?.name ? ` message ${ed.messageRef.name}` : ''}${ed.errorRef?.errorCode ? ` error ${ed.errorRef.errorCode}` : ''}`);
    }
    const attr = k => (bo.get ? bo.get(k) : undefined);
    const props = [];
    for (const [k, label2] of [['camunda:assignee', 'assignee'], ['camunda:candidateGroups', 'candidateGroups'], ['camunda:formKey', 'formKey'],
      ['camunda:topic', 'topic'], ['camunda:class', 'class'], ['camunda:delegateExpression', 'delegateExpression'], ['camunda:expression', 'expression'],
      ['camunda:decisionRef', 'decisionRef']]) {
      const v = attr(k);
      if (v) props.push(`${label2}=${v}`);
    }
    if (bo.calledElement) props.push(`calledElement=${bo.calledElement}`);
    for (const v of bo.extensionElements?.values || []) {
      if (v.$type === 'zeebe:TaskDefinition' && v.type) props.push(`jobType=${v.type}`);
      if (v.$type === 'zeebe:AssignmentDefinition' && v.assignee) props.push(`assignee=${v.assignee}`);
      if (v.$type === 'zeebe:FormDefinition' && v.formId) props.push(`formId=${v.formId}`);
      if (v.$type === 'camunda:FormData') props.push(`form fields: ${(v.fields || []).map(f => f.id).join(', ')}`);
    }
    if (props.length) parts.push(props.join(', '));
  }
  const line = parts.join('; ');
  return line.length > 500 ? `${line.slice(0, 500)}…` : line;
}

function contextBlock(ids) {
  const lines = [];
  if (doc.file) lines.push(`Open diagram: ${doc.file}`);
  const reg = modeler?.get('elementRegistry');
  const els = ids.map(id => reg?.get(id)).filter(Boolean);
  if (els.length) {
    lines.push(`Referenced elements (${els.length}) — "this", "it", "selected", "these", or @name in the message mean these; use their ids in tool calls:`);
    for (const el of els.slice(0, 30)) lines.push(`- ${describeElement(el)}`);
    if (els.length > 30) lines.push(`- … and ${els.length - 30} more: ${els.slice(30).map(e => e.id).join(', ')}`);
  }
  return lines.length ? `[Editor context]\n${lines.join('\n')}\n\n` : '';
}

// ---- @-mentions in the input

const mention = { open: false, start: 0, items: [], active: 0 };

function closeMention() {
  mention.open = false;
  $('mention').hidden = true;
  input.removeAttribute('aria-activedescendant');
}

function updateMention() {
  if (!modeler || !doc.file) return closeMention();
  const caret = input.selectionStart;
  const before = input.value.slice(0, caret);
  const m = /(^|\s)@([^\s@]*)$/.exec(before);
  if (!m) return closeMention();
  const query = m[2].toLowerCase();
  mention.start = caret - m[2].length - 1;
  const score = el => {
    const name = nameOf(el).toLowerCase(), id = el.id.toLowerCase();
    if (!query) return 1;
    if (name.startsWith(query) || id.startsWith(query)) return 3;
    if (name.split(/\s+/).some(w => w.startsWith(query))) return 2;
    return name.includes(query) || id.includes(query) ? 1 : 0;
  };
  mention.items = referencable().map(el => ({ el, s: score(el) })).filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s || (nameOf(b.el) ? 1 : 0) - (nameOf(a.el) ? 1 : 0) || titleOf(a.el).localeCompare(titleOf(b.el)))
    .slice(0, 12).map(x => x.el);
  mention.active = Math.min(mention.active, Math.max(mention.items.length - 1, 0));
  mention.open = true;
  renderMention();
}

function renderMention() {
  const box = $('mention');
  box.innerHTML = '';
  if (!mention.items.length) {
    const none = document.createElement('div'); none.className = 'none'; none.textContent = 'Нет элементов с таким именем';
    box.appendChild(none);
  }
  mention.items.forEach((el, i) => {
    const opt = document.createElement('div');
    opt.className = `opt${i === mention.active ? ' active' : ''}`;
    opt.id = `mention-${i}`; opt.setAttribute('role', 'option'); opt.setAttribute('aria-selected', String(i === mention.active));
    opt.innerHTML = '<span class="t"></span><span class="n"></span><span class="i"></span>';
    opt.querySelector('.t').textContent = typeLabel(el);
    opt.querySelector('.n').textContent = nameOf(el) || '(без имени)';
    opt.querySelector('.i').textContent = el.id;
    opt.onmousedown = e => { e.preventDefault(); pickMention(i); }; // keep the focus in the input
    opt.onmouseenter = () => hoverRef(el.id, true);
    opt.onmouseleave = () => hoverRef(el.id, false);
    box.appendChild(opt);
  });
  box.hidden = false;
  if (mention.items.length) {
    input.setAttribute('aria-activedescendant', `mention-${mention.active}`);
    box.querySelector('.opt.active')?.scrollIntoView({ block: 'nearest' });
  }
}

function pickMention(i) {
  const el = mention.items[i];
  if (!el) return;
  hoverRef(el.id, false);
  const caret = input.selectionStart;
  const text = `@${titleOf(el)} `;
  input.value = input.value.slice(0, mention.start) + text + input.value.slice(caret);
  const pos = mention.start + text.length;
  input.setSelectionRange(pos, pos);
  closeMention();
  pinRef(el.id);
  autosize();
}

input.addEventListener('input', updateMention);
input.addEventListener('click', updateMention);
input.addEventListener('blur', () => setTimeout(closeMention, 120));
input.addEventListener('keydown', e => {
  if (!mention.open) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = mention.items.length;
    if (n) mention.active = (mention.active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
    renderMention();
  } else if ((e.key === 'Enter' || e.key === 'Tab') && mention.items.length) {
    e.preventDefault(); e.stopImmediatePropagation();
    pickMention(mention.active);
  } else if (e.key === 'Escape') {
    e.preventDefault(); closeMention();
  }
}, true);

// Ctrl+K: to the chat, with whatever is selected on the diagram
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    updateContextChip();
    input.focus();
  }
});

function renderEmpty() {
  log.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'empty';
  box.innerHTML = '<div>Опишите процесс — ассистент построит диаграмму слева. Можно выделить элемент и попросить изменить его.</div>';
  const ex = document.createElement('div'); ex.className = 'examples';
  for (const t of EXAMPLES) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = t;
    b.onclick = () => { input.value = t; autosize(); input.focus(); };
    ex.appendChild(b);
  }
  box.appendChild(ex);
  log.appendChild(box);
}

function userBubble(m) {
  const d = document.createElement('div');
  d.className = 'msg user';
  if (m.ctx) { const c = document.createElement('span'); c.className = 'ctx'; c.textContent = m.ctx; d.appendChild(c); }
  if (m.refs?.length) {
    const box = document.createElement('div'); box.className = 'refs';
    for (const r of m.refs) box.appendChild(refChip(r));
    d.appendChild(box);
  }
  d.appendChild(document.createTextNode(m.text));
  log.appendChild(d);
}

const fmtChars = n => (n >= 1000 ? `${(n / 1000).toFixed(1).replace('.', ',')} тыс. символов` : `${n} символов`);
const fmtSec = ms => (ms < 1000 ? `${Math.max(1, Math.round(ms))} мс` : ms < 10000 ? `${(ms / 1000).toFixed(1).replace('.', ',')} с` : `${Math.round(ms / 1000)} с`);
const clip = (text, max = 3000) => (text.length > max ? `${text.slice(0, max)}\n… (ещё ${fmtChars(text.length - max)})` : text);
const pretty = v => {
  if (v == null) return '';
  if (typeof v !== 'string') return JSON.stringify(v, null, 2);
  try { return JSON.stringify(JSON.parse(v), null, 2); } catch { return v; }
};

/** What the assistant is doing right now, for the live status line. */
function liveText(live, now = Date.now()) {
  const total = fmtSec(now - live.started);
  const quiet = now - live.lastEvent;
  let what;
  switch (live.phase) {
    case 'thinking': what = 'Думает'; break;
    case 'writing': what = 'Пишет ответ'; break;
    case 'drafting': what = `${live.draft?.name ? `Готовит действие «${TOOL_LABELS[live.draft.name] || live.draft.name}»` : 'Готовит ответ'}${live.draft?.chars ? ` · ${fmtChars(live.draft.chars)}` : ''}`; break;
    case 'tool': what = `Выполняет «${live.tool}»`; break;
    default: what = live.step > 1 ? 'Передаю результат модели, жду ответ' : 'Отправил запрос, жду ответ модели';
  }
  const parts = [what, live.step ? `шаг ${live.step}` : '', `${total}`];
  let line = parts.filter(Boolean).join(' · ');
  if (quiet > 20000 && live.phase !== 'tool') {
    line += ` — ответа нет ${Math.round(quiet / 1000)} с: модель ещё работает (большие схемы и размышления занимают время); «Стоп» прервёт`;
  }
  return line;
}

function assistantView(msg) {
  const el = document.createElement('div');
  el.className = 'msg assistant';
  log.appendChild(el);
  let statusEl = null;
  // open/closed only as the user set it; otherwise the default (reasoning open while it streams)
  const userOpen = new Map();
  const remember = (d, key) => d.querySelector('summary').addEventListener('click', () => userOpen.set(key, !d.open));
  const paint = () => {
    el.innerHTML = '';
    const lastThinking = msg.parts.map(p => p.kind).lastIndexOf('thinking');
    msg.parts.forEach((p, i) => {
      if (p.kind === 'text' && p.text.trim()) {
        const t = document.createElement('div'); t.className = 'md'; t.innerHTML = md(p.text); el.appendChild(t);
      } else if (p.kind === 'thinking' && p.text.trim()) {
        const d = document.createElement('details');
        d.className = 'thinking'; d.dataset.key = `th${i}`;
        // the reasoning being written right now is open; finished ones fold away
        const streaming = !!msg.live && i === lastThinking && msg.live.phase === 'thinking';
        d.open = userOpen.has(d.dataset.key) ? userOpen.get(d.dataset.key) : streaming;
        const sum = document.createElement('summary');
        sum.textContent = streaming ? 'Размышляет…' : `Размышления · ${fmtChars(p.text.length)}`;
        const body = document.createElement('div'); body.className = 'thinking-text'; body.textContent = p.text;
        d.append(sum, body); el.appendChild(d);
        remember(d, d.dataset.key);
        if (streaming) body.scrollTop = body.scrollHeight;
      } else if (p.kind === 'tool') {
        const d = document.createElement('details');
        d.className = 'tool ' + (p.status || 'run'); d.dataset.key = `tool${p.id}`;
        d.open = userOpen.get(d.dataset.key) ?? false;
        const sum = document.createElement('summary');
        sum.innerHTML = '<span class="st"></span><span class="tl"><b></b> <span class="sum"></span></span><span class="ms"></span>';
        sum.querySelector('b').textContent = p.label + (p.file ? ` · ${p.file}` : '');
        sum.querySelector('.sum').textContent = p.summary ? `— ${p.summary}` : p.status === 'run' ? '— выполняется…' : '';
        sum.querySelector('.ms').textContent = p.ms != null ? fmtSec(p.ms) : '';
        d.appendChild(sum);
        if (p.args) { const h = document.createElement('div'); h.className = 'tool-h'; h.textContent = 'Аргументы'; const pre = document.createElement('pre'); pre.textContent = p.args; d.append(h, pre); }
        if (p.result) { const h = document.createElement('div'); h.className = 'tool-h'; h.textContent = 'Результат'; const pre = document.createElement('pre'); pre.textContent = p.result; d.append(h, pre); }
        el.appendChild(d);
        remember(d, d.dataset.key);
      } else if (p.kind === 'error') {
        const t = document.createElement('div'); t.className = 'err-text'; t.textContent = p.text; el.appendChild(t);
      } else if (p.kind === 'note') {
        const t = document.createElement('div'); t.className = 'meta'; t.textContent = p.text; el.appendChild(t);
      }
    });
    statusEl = null;
    if (msg.live) {
      statusEl = document.createElement('div');
      statusEl.className = 'live';
      statusEl.setAttribute('role', 'status');
      statusEl.innerHTML = '<span class="spin"></span><span class="live-text"></span>';
      statusEl.querySelector('.live-text').textContent = liveText(msg.live);
      el.appendChild(statusEl);
    }
    if (msg.meta) { const m = document.createElement('div'); m.className = 'meta'; m.textContent = msg.meta; el.appendChild(m); }
  };
  paint();
  // the clock ticks without a full repaint
  const tick = () => {
    if (!msg.live || !statusEl) return;
    statusEl.querySelector('.live-text').textContent = liveText(msg.live);
    statusEl.classList.toggle('quiet', Date.now() - msg.live.lastEvent > 20000 && msg.live.phase !== 'tool');
  };
  return { paint, tick };
}

function renderChat() {
  if (!chat.messages.length) return renderEmpty();
  log.innerHTML = '';
  for (const m of chat.messages) m.role === 'user' ? userBubble(m) : assistantView(m);
  log.scrollTop = log.scrollHeight;
}

function scrollDown(force) {
  if (force || log.scrollHeight - log.scrollTop - log.clientHeight < 120) log.scrollTop = log.scrollHeight;
}

let controller = null;
function setSending(b) {
  $('send').hidden = b; $('stop').hidden = !b; $('new-chat').disabled = b;
  $('dot').classList.toggle('busy', b);
}

const kTok = n => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

async function send(text) {
  const settings = activeSettings();
  if (!isConfigured(settings)) {
    input.value = text; autosize();
    return openSettings('Сначала выберите, через что работает ассистент.');
  }
  await flushSave(); // the assistant must see what is on the screen
  updateContextChip();
  const refIds = attachedIds();
  const reg = modeler?.get('elementRegistry');
  const msgRefs = refIds.map(id => reg.get(id)).map(el => ({ id: el.id, type: typeLabel(el), name: nameOf(el), file: doc.file }));
  const ctxLabel = doc.file || '';
  const context = contextBlock(refIds);
  // pinned and mentioned elements belonged to this message; the selection keeps following the diagram
  refs.pinned = []; refs.excluded.clear();
  renderRefs();

  if (!chat.messages.length) log.innerHTML = '';
  const um = { role: 'user', text, ctx: ctxLabel, refs: msgRefs };
  chat.messages.push(um); userBubble(um);
  const started = Date.now();
  const msg = { role: 'assistant', parts: [], live: { phase: 'waiting', started, lastEvent: started, step: 0 } };
  chat.messages.push(msg);
  // provider-native histories are not interchangeable: start a new context when the connection changes
  const connection = settings.provider === 'custom' ? `custom:${settings.baseUrl}` : settings.provider;
  if (chat.provider && chat.provider !== connection && chat.history.length) {
    chat.history = [];
    msg.parts.push({ kind: 'note', text: `Подключение сменилось на ${Core.providerLabel(settings)} — контекст разговора начат заново.` });
  }
  chat.provider = connection;
  const view = assistantView(msg);
  saveChat(); scrollDown(true); setSending(true);
  const ticker = setInterval(view.tick, 500);

  // repaint at most once per frame: reasoning and text arrive in many small pieces
  let frame = 0;
  const repaint = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; view.paint(); scrollDown(); });
  };

  // each model turn writes into parts of its own: a retried turn ('reset') drops exactly those
  let turnStart = msg.parts.length;
  let newTurn = true;
  const lastPart = kind => {
    let last = msg.parts[msg.parts.length - 1];
    if (newTurn || !last || last.kind !== kind) { last = { kind, text: '' }; msg.parts.push(last); newTurn = false; }
    return last;
  };
  let usage = null;
  controller = new AbortController();
  try {
    await Core.runAssistant({
      settings, history: chat.history, studio: studio.assistantStudio, signal: controller.signal,
      text: context + text,
      confirm: async call => {
        const url = Object.hasOwn(config.deploy.targets, call.args?.target) ? config.deploy.targets[call.args.target] : 'неизвестный сервер';
        const forced = call.args?.force ? '\n\n⚠ Принудительно: схема будет отправлена, даже если в ней есть ошибки деплоя.' : '';
        return confirm(`Ассистент хочет отправить схему «${call.args?.file}» на сервер «${call.args?.target}» (${url}).${forced}\n\nРазрешить?`);
      },
      onEvent: ev => {
        const live = msg.live;
        live.lastEvent = Date.now();
        switch (ev.type) {
          case 'step':
            live.step = ev.n; live.phase = 'waiting'; live.draft = null;
            turnStart = msg.parts.length; newTurn = true;
            break;
          case 'thinking':
            lastPart('thinking').text += ev.delta; live.phase = 'thinking';
            break;
          case 'text':
            lastPart('text').text += ev.delta; live.phase = 'writing';
            break;
          case 'tool_draft':
            live.phase = 'drafting'; live.draft = { name: ev.name || live.draft?.name, chars: ev.chars };
            break;
          case 'reset':
            // a model turn is being retried: take back what it already streamed
            msg.parts.length = turnStart; newTurn = true;
            live.phase = 'waiting'; live.draft = null;
            break;
          case 'tool': {
            let args;
            try { args = typeof ev.input === 'string' ? JSON.parse(ev.input || '{}') : ev.input; } catch { args = ev.input; }
            const label = TOOL_LABELS[ev.name] || ev.name;
            msg.parts.push({ kind: 'tool', id: ev.id, label, file: args?.file, status: 'run', args: clip(pretty(args)) });
            newTurn = true;
            live.phase = 'tool'; live.tool = label; live.draft = null;
            break;
          }
          case 'tool_result': {
            const t = msg.parts.find(p => p.kind === 'tool' && p.id === ev.id);
            if (t) { t.status = ev.ok ? 'ok' : 'bad'; t.summary = ev.summary; t.ms = ev.ms; t.result = clip(pretty(ev.content)); }
            live.phase = 'waiting';
            break;
          }
          case 'note':
            msg.parts.push({ kind: 'note', text: ev.text });
            break;
          case 'usage':
            usage = ev.usage;
            break;
        }
        repaint();
        if (ev.type === 'tool_result' || ev.type === 'tool') saveChat({ soon: true });
      }
    });
  } catch (err) {
    msg.parts.push({ kind: 'error', text: err.name === 'AbortError' ? 'Остановлено.' : err.message });
  } finally {
    clearInterval(ticker);
    cancelAnimationFrame(frame);
    for (const p of msg.parts) if (p.kind === 'tool' && p.status === 'run') p.status = 'bad';
    const steps = msg.live?.step || 0;
    const tools = msg.parts.filter(p => p.kind === 'tool').length;
    const bits = [fmtSec(Date.now() - started), `${Core.providerLabel(settings)} · ${settings.model}`];
    if (steps > 1) bits.push(`шагов: ${steps}`);
    if (tools) bits.push(`действий: ${tools}`);
    if (usage) bits.push(`токены ↑${kTok(usage.input)} ↓${kTok(usage.output)}`);
    msg.meta = bits.join(' · ');
    delete msg.live;
    controller = null;
    view.paint(); saveChat(); setSending(false); scrollDown(); input.focus();
  }
}

form.addEventListener('submit', e => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || controller) return;
  input.value = ''; autosize();
  send(text);
});
input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
});
function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight + 2, innerHeight * 0.35) + 'px'; }
input.addEventListener('input', autosize);

$('stop').onclick = () => controller?.abort();
$('new-chat').onclick = () => {
  if (chat.messages.length && !confirm('Начать новый чат? Переписка очистится, диаграммы останутся.')) return;
  chat = { provider: null, history: [], messages: [] }; saveChat(); renderChat(); input.focus();
};

// ================================================================== toast

let toastTimer;
function toast(text, kind = 'ok', ms = 5000) {
  const el = $('toast');
  el.textContent = text; el.className = `toast ${kind}`; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}
$('toast').onclick = () => { $('toast').hidden = true; };

// ================================================================== open files (.bpmn / .xml / .zip)

async function importLocalFiles(files) {
  if (!files?.length) return;
  try {
    let report = await studio.importFiles(files, { source: TAB_ID });
    if (report.skipped.length && confirm(`Уже есть: ${report.skipped.join(', ')}. Заменить их? (старые версии останутся в истории отмены)`)) {
      // source "import": an open tab showing a replaced diagram reloads it
      const again = await studio.importFiles(files, { overwrite: true, source: 'import' });
      report = {
        imported: [...report.imported, ...again.imported.filter(n => report.skipped.includes(n))],
        skipped: [],
        failed: [...report.failed, ...again.failed.filter(f => !report.failed.some(x => x.name === f.name))]
      };
    }
    await refreshFiles();
    if (report.imported.length) await openFile(report.imported[0]);
    const lines = [];
    if (report.imported.length) lines.push(`Импортировано: ${report.imported.length}${report.imported.length > 1 ? ` (открыта ${report.imported[0]})` : ''}`);
    if (report.skipped.length) lines.push(`Пропущено (уже есть): ${report.skipped.length}`);
    for (const f of report.failed) lines.push(`Ошибка: ${f.name} — ${f.error}`);
    toast(lines.join('\n') || 'Нечего открывать', report.failed.length ? 'err' : 'ok', report.failed.length ? 10000 : 5000);
  } catch (err) {
    toast(err.message, 'err', 8000);
  }
}

$('open-file').onclick = () => $('file-input').click();
$('file-input').onchange = e => { importLocalFiles([...e.target.files]); e.target.value = ''; };

// drag & drop .bpmn/.zip files from the desktop, like the original modeler
let dragDepth = 0;
const isFileDrag = e => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', e => { if (isFileDrag(e)) { dragDepth++; $('drop-hint').hidden = false; } });
window.addEventListener('dragleave', e => { if (isFileDrag(e) && --dragDepth <= 0) { dragDepth = 0; $('drop-hint').hidden = true; } });
window.addEventListener('dragover', e => { if (isFileDrag(e)) e.preventDefault(); });
window.addEventListener('drop', e => {
  if (!isFileDrag(e)) return;
  e.preventDefault(); dragDepth = 0; $('drop-hint').hidden = true;
  importLocalFiles([...e.dataTransfer.files]);
});

// ================================================================== send schema to the server

function renderDeployMenu() {
  const menu = $('deploy-menu');
  menu.innerHTML = '';
  for (const [name, url] of Object.entries(config.deploy.targets)) {
    const b = document.createElement('button');
    b.type = 'button'; b.dataset.target = name;
    b.innerHTML = '<span></span><small></small>';
    b.querySelector('span').textContent = name;
    b.querySelector('small').textContent = url;
    menu.appendChild(b);
  }
  const other = document.createElement('button');
  other.type = 'button'; other.dataset.custom = '1'; other.textContent = 'Другой адрес…';
  menu.appendChild(other);
}

$('deploy').onclick = e => { e.stopPropagation(); toggleMenu($('deploy-menu'), [$('download-menu')]); };
$('deploy-menu').onclick = async e => {
  const btn = e.target.closest('button');
  if (!btn) return;
  if (!doc.file) return toast('Сначала откройте или создайте схему', 'err');
  let target = btn.dataset.target, url;
  if (btn.dataset.custom) {
    target = undefined;
    url = prompt(`Адрес сервера (без ${config.deploy.path || '/'}):`, local.get('bpmn-studio:deploy-url', 'http://'));
    if (!url) return;
    if (!/^https?:\/\/[^\s/@]+/.test(url)) return toast('Адрес должен начинаться с http:// или https://', 'err');
    // the full endpoint pasted from somewhere: keep only the server part (the path is added on send)
    const path = config.deploy.path || '/';
    url = url.trim().replace(/\/+$/, '');
    if (url.endsWith(path)) url = url.slice(0, -path.length);
    local.set('bpmn-studio:deploy-url', url);
  } else {
    url = config.deploy.targets[target];
    if (!confirm(`Отправить ${doc.file} на ${target} (${url})?`)) return;
  }
  await flushSave();
  try {
    setSaveState('Отправка…');
    const res = await studio.deploy(doc.file, { target, url }).catch(async err => {
      if (err.status !== 422) throw err;
      if (!confirm(`В схеме есть ошибки деплоя:\n\n${err.deployErrors.join('\n')}\n\nВсё равно отправить?`)) throw Object.assign(new Error('Отправка отменена'), { quiet: true });
      return studio.deploy(doc.file, { target, url, force: true });
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}${res.body ? '\n' + res.body.slice(0, 300) : ''}`);
    toast(`Схема отправлена на ${target || url} · HTTP ${res.status}${res.body ? '\n' + res.body.slice(0, 300) : ''}`);
  } catch (err) {
    if (!err.quiet) toast(`Не отправлено: ${err.message}`, 'err', 10000);
  } finally {
    setSaveState(doc.dirty ? 'Есть изменения…' : 'Сохранено');
  }
};

// for debugging from DevTools
window.bpmnStudio = { get modeler() { return modeler; }, get studio() { return studio; }, doc, save, openFile };

// ================================================================== start

(async () => {
  await loadChat();
  renderChat();
  try {
    const res = await fetch('bpmn-studio.config.json', { cache: 'no-cache' });
    if (res.ok) config = await res.json();
  } catch { /* defaults */ }
  studio = Core.createStudio({
    settings: config,
    // the assistant opened or created a diagram: show it in this tab
    show: name => { if (name !== doc.file) openFile(name).catch(err => setSaveState(err.message, true)); return 'Shown in the editor.'; }
  });
  config = studio.config;
  studio.store.addEventListener('change', e => {
    onStoredChange(e.detail).catch(err => setSaveState(err.message, true));
    channel?.postMessage({ ...e.detail, source: e.detail.source === 'assistant' ? `assistant:${TAB_ID}` : e.detail.source });
  });
  if (channel) channel.onmessage = e => onStoredChange(e.data).catch(err => setSaveState(err.message, true));
  studio.persist();
  renderAssistantChip();
  renderDeployMenu();
  await loadModelerClass(editorFor(config.defaultPlatform || 'camunda7'));
  let files;
  try {
    files = await refreshFiles();
  } catch (err) {
    // no IndexedDB: private mode of some browsers, blocked site data, very old browser
    await ensureModeler(config.defaultPlatform || 'camunda7');
    setSaveState('Хранилище недоступно', true);
    toast(`Браузер не даёт студии хранить схемы (приватный режим или запрет данных сайтов): ${err.message}\n` +
      'Редактор работает, но сохранить можно только через «Скачать». Откройте студию в обычном окне или разрешите данные сайта.', 'err', 600000);
    return;
  }
  const last = local.get('bpmn-studio:file', null);
  const initial = files.find(f => f.file === last)?.file || files[0]?.file;
  if (initial) await openFile(initial);
  else { await ensureModeler(config.defaultPlatform || 'camunda7'); $('placeholder').hidden = false; }
  updateContextChip();
})().catch(err => setSaveState(err.message, true));

})();
