// run.sh: start / status / restart / stop of the studio's static server, on a free port and a
// temporary state directory (never touches a running instance).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort } from './fixtures/ports.js';

const RUN = new URL('../run.sh', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'bpmn-run-'));
const port = String(await freePort());
const env = { ...process.env, BPMN_RUN_DIR: dir, PORT: port, NO_BUILD: '1', NO_COLOR: '1' };
const run = (...args) => spawnSync('bash', [RUN, ...args], { env, encoding: 'utf8', timeout: 60000 });
after(() => { run('stop'); rmSync(dir, { recursive: true, force: true }); });

test('lifecycle', { skip: process.platform === 'win32' }, async () => {
  assert.equal(run('status').status, 3, 'not running');
  const start = run('start');
  assert.equal(start.status, 0, start.stderr);
  assert.match(start.stdout, new RegExp(`http://127.0.0.1:${port}/`));
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
  assert.equal(run('start').status, 0, 'second start is a no-op');
  const status = run('status');
  assert.equal(status.status, 0);
  assert.match(status.stdout, /Ответ:\s+OK/);

  const pid = (await import('node:fs')).readFileSync(join(dir, 'studio.pid'), 'utf8').trim();
  assert.equal(run('restart').status, 0);
  const pid2 = (await import('node:fs')).readFileSync(join(dir, 'studio.pid'), 'utf8').trim();
  assert.notEqual(pid, pid2, 'a new process after restart');
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200, 'same port after restart');

  const busy = spawnSync('bash', [RUN, 'start'], { env: { ...env, BPMN_RUN_DIR: join(dir, 'other') }, encoding: 'utf8', timeout: 60000 });
  assert.equal(busy.status, 1);
  assert.match(busy.stderr, /уже занят/);

  assert.equal(run('stop').status, 0);
  assert.ok(!existsSync(join(dir, 'studio.pid')));
  assert.equal(run('status').status, 3);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/`));
});

test('bad input', () => {
  assert.equal(spawnSync('bash', [RUN, 'start'], { env: { ...env, PORT: 'abc' }, encoding: 'utf8' }).status, 2);
  assert.equal(run('frobnicate').status, 2);
  assert.equal(run('logs', 'x').status, 2);
});

test('restart keeps the address, refuses a busy new port without stopping, works via a symlink and with a proxy set', { skip: process.platform === 'win32' }, async () => {
  const d = mkdtempSync(join(tmpdir(), 'bpmn-run2-'));
  const p1 = String(await freePort());
  const base = { ...process.env, BPMN_RUN_DIR: d, NO_BUILD: '1', NO_COLOR: '1' };
  delete base.PORT; delete base.HOST;
  const sh = (args, extra = {}, script = RUN) => spawnSync('bash', [script, ...args], { env: { ...base, ...extra }, encoding: 'utf8', timeout: 60000 });
  try {
    assert.equal(sh(['start'], { PORT: p1 }).status, 0);
    // no PORT given: the running instance's port is kept
    const r = sh(['restart'], { http_proxy: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal((await fetch(`http://127.0.0.1:${p1}/`)).status, 200);
    // a busy target port: refused, the running instance stays
    const busy = await import('node:net').then(net => new Promise(res => { const s = net.createServer().listen(0, '127.0.0.1', () => res(s)); }));
    const moved = sh(['restart'], { PORT: String(busy.address().port) });
    busy.close();
    assert.equal(moved.status, 1);
    assert.match(moved.stderr, /не тронут/);
    assert.equal((await fetch(`http://127.0.0.1:${p1}/`)).status, 200);
    // through a symlink from another directory
    const link = join(d, 'studio');
    (await import('node:fs')).symlinkSync(RUN, link);
    const st = spawnSync('bash', [link, 'status'], { env: base, encoding: 'utf8', cwd: tmpdir(), timeout: 60000 });
    assert.equal(st.status, 0, st.stdout + st.stderr);
  } finally {
    sh(['stop']);
    rmSync(d, { recursive: true, force: true });
  }
});
