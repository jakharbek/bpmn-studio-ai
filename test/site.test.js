// The built static site (npm run build → dist/site) has everything the page references.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve } from '../scripts/serve.mjs';

const SITE = fileURLToPath(new URL('../dist/site/', import.meta.url));
let server, base;
before(async () => {
  if (!existsSync(SITE + 'index.html')) throw new Error('dist/site is missing: run npm run build');
  server = await serve(0, SITE);
  base = `http://127.0.0.1:${server.address().port}/`;
});
after(() => server?.close());

test('every script and stylesheet of index.html is served, with relative paths', async () => {
  const html = readFileSync(SITE + 'index.html', 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map(m => m[1]).filter(r => !/^https?:/.test(r));
  assert.ok(refs.includes('core.js') && refs.includes('app.js'));
  for (const r of refs) {
    assert.ok(!r.startsWith('/'), `absolute path breaks hosting in a sub-folder: ${r}`);
    const res = await fetch(base + r);
    assert.equal(res.status, 200, r);
  }
});

test('files the app loads at runtime exist', async () => {
  for (const f of ['legacy/modeler.js', 'vendor/modeler-platform.js', 'vendor/modeler-cloud.js', 'bpmn-studio.config.json',
    'local-server/server.js', 'local-server/package.json', 'local-server/README.md']) {
    assert.equal((await fetch(base + f)).status, 200, f);
  }
  const cfg = await (await fetch(base + 'bpmn-studio.config.json')).json();
  assert.equal(cfg.defaultPlatform, 'camunda7');
});

test('static server: no traversal, no writes', async () => {
  assert.equal((await fetch(base + '..%2f..%2fpackage.json')).status, 404);
  assert.equal((await fetch(base + 'index.html', { method: 'POST' })).status, 405);
  assert.equal((await fetch(base + 'nope.js')).status, 404);
});

test('the core bundle has no server API calls left', () => {
  const app = readFileSync(SITE + 'app.js', 'utf8');
  assert.doesNotMatch(app, /\/api\//);
  assert.doesNotMatch(app, /EventSource/);
});

test('the downloadable local server is the current one (the zip is built from these files)', () => {
  for (const f of ['server.js', 'package.json', 'README.md']) {
    assert.equal(readFileSync(SITE + 'local-server/' + f, 'utf8'), readFileSync(new URL(`../local-server/${f}`, import.meta.url), 'utf8'), f);
  }
});
