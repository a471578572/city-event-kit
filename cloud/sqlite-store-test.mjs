import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile, writeFile, stat, chmod, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { createSqliteStore } from './sqlite-store.mjs';
import { startLocal, validateLocalDeployment } from './local.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const runtimeArgs = process.execArgv.includes('--experimental-sqlite') ? ['--experimental-sqlite'] : [];

async function fixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'city-event-sqlite-'));
  const dataDir = resolve(root, 'private'), stores = [];
  t.after(async () => {
    for (const store of stores) await store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, dataDir, async open() {
    const store = await createSqliteStore({ dataDir }); stores.push(store); return store;
  } };
}

test('SQLite starts with one empty event and returns detached state snapshots', async t => {
  const files = await fixture(t), store = await files.open();
  const initial = await store.read();
  assert.equal(initial.version, 1);
  for (const field of ['teams', 'judges', 'voters', 'scores', 'ballots', 'decisions']) assert.deepEqual(initial.state[field], []);
  initial.state.teams.push({ id: 'unsaved' });
  assert.deepEqual((await store.read()).state.teams, []);
});

test('SQLite state and version survive closing and reopening', async t => {
  const files = await fixture(t), first = await files.open();
  const saved = await first.read(); saved.state.event.name = '持久保存测试';
  assert.equal(await first.compareAndSwap(saved.version, saved.state), true);
  await first.close();
  const second = await files.open(), restarted = await second.read();
  assert.equal(restarted.state.event.name, '持久保存测试');
  assert.equal(restarted.version, 2);
});

test('independent SQLite instances reject the stale writer atomically', async t => {
  const files = await fixture(t), first = await files.open(), second = await files.open();
  const left = await first.read(), right = await second.read();
  left.state.event.name = 'first'; right.state.event.name = 'stale';
  const results = await Promise.all([first.compareAndSwap(left.version, left.state), second.compareAndSwap(right.version, right.state)]);
  assert.deepEqual(results, [true, false]);
  assert.equal((await second.read()).state.event.name, 'first');
  assert.equal((await second.read()).version, 2);
});

test('separate processes share the same conditional SQLite update', async t => {
  const files = await fixture(t), store = await files.open();
  const moduleUrl = new URL('./sqlite-store.mjs', import.meta.url).href;
  const worker = name => new Promise((accept, reject) => {
    const script = `import { createSqliteStore } from ${JSON.stringify(moduleUrl)}; const store = await createSqliteStore({dataDir:process.env.TEST_DATA_DIR}); const {state}=await store.read(); state.event.name=process.env.TEST_NAME; console.log(await store.compareAndSwap(1,state)); await store.close();`;
    const child = spawn(process.execPath, [...runtimeArgs, '--input-type=module', '-e', script], {
      env: { ...process.env, TEST_DATA_DIR: files.dataDir, TEST_NAME: name }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '', errors = '';
    child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { errors += value; });
    child.on('error', reject); child.on('close', code => code === 0 ? accept(output.trim()) : reject(new Error(`worker failed: ${errors}`)));
  });
  const results = await Promise.all([worker('one'), worker('two')]);
  assert.deepEqual(results.sort(), ['false', 'true']);
  assert.equal((await store.read()).version, 2);
});

test('failed SQLite writes roll back both state and version', async t => {
  const files = await fixture(t), store = await files.open();
  const previous = await store.read();
  const { DatabaseSync } = await import('node:sqlite');
  const control = new DatabaseSync(resolve(files.dataDir, 'event.sqlite3'));
  try {
    control.exec("CREATE TRIGGER fail_update BEFORE UPDATE ON event_state BEGIN SELECT RAISE(ABORT, 'test_write_failure'); END;");
    const candidate = structuredClone(previous.state); candidate.event.name = 'must not save';
    await assert.rejects(store.compareAndSwap(previous.version, candidate), /test_write_failure/);
    assert.deepEqual(await store.read(), previous);
    control.exec('DROP TRIGGER fail_update');
    assert.equal(await store.compareAndSwap(previous.version, candidate), true);
  } finally { control.close(); }
});

test('invalid state and unsafe versions never replace stored data', async t => {
  const files = await fixture(t), store = await files.open(), previous = await store.read();
  await assert.rejects(store.compareAndSwap(-1, previous.state), /VERSION_INVALID/);
  await assert.rejects(store.compareAndSwap(Number.MAX_SAFE_INTEGER, previous.state), /VERSION_INVALID/);
  await assert.rejects(store.compareAndSwap(previous.version, { ...previous.state, teams: null }), /STATE_INVALID/);
  const cycle = structuredClone(previous.state); cycle.self = cycle;
  await assert.rejects(store.compareAndSwap(previous.version, cycle));
  assert.deepEqual(await store.read(), previous);
});

test('SQLite private directory and database have restricted permissions', { skip: process.platform === 'win32' }, async t => {
  const files = await fixture(t), store = await files.open();
  await chmod(files.dataDir, 0o755); await chmod(resolve(files.dataDir, 'event.sqlite3'), 0o644);
  await store.close(); await files.open();
  assert.equal((await stat(files.dataDir)).mode & 0o777, 0o700);
  assert.equal((await stat(resolve(files.dataDir, 'event.sqlite3'))).mode & 0o777, 0o600);
});

test('SQLite refuses linked database files instead of following them', { skip: process.platform === 'win32' }, async t => {
  const files = await fixture(t), store = await files.open(); await store.close();
  const destination = resolve(files.root, 'outside.sqlite3');
  await writeFile(destination, 'unmodified');
  await rm(resolve(files.dataDir, 'event.sqlite3'));
  await symlink(destination, resolve(files.dataDir, 'event.sqlite3'));
  await assert.rejects(files.open(), /DATABASE_FILE_INVALID/);
  assert.equal(await readFile(destination, 'utf8'), 'unmodified');
});

async function availablePort() {
  const server = net.createServer();
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  const port = server.address().port;
  await new Promise(accept => server.close(accept)); return port;
}

async function launchLocal(t, directory, overrides = {}) {
  const port = await availablePort(), origin = `http://localhost:${port}`;
  const child = spawn(process.execPath, [...runtimeArgs, resolve(HERE, 'local.mjs')], {
    env: { ...process.env, DATA_DIR: directory, PORT: String(port), HOST: '127.0.0.1', PUBLIC_ORIGIN: origin,
      BASE_PATH: '/event', AWARDS_ADMIN_TOKEN: 'fictional-local-admin-token-12345', ...overrides },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', errors = '';
  child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { errors += value; });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const done = new Promise(accept => child.once('close', accept)); child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000); timer.unref();
    await done; clearTimeout(timer);
  };
  t.after(stop);
  await new Promise((accept, reject) => {
    const timeout = setTimeout(() => reject(new Error('local startup timeout')), 8000);
    const onData = () => { if (output.includes('活动入口：')) { cleanup(); accept(); } };
    const onClose = () => { cleanup(); reject(new Error(`local startup failed: ${errors}`)); };
    function cleanup() { clearTimeout(timeout); child.stdout.removeListener('data', onData); child.removeListener('close', onClose); }
    child.stdout.on('data', onData); child.once('close', onClose); child.once('error', reject); onData();
  });
  return { origin, baseUrl: `http://127.0.0.1:${port}/event`, stop, output: () => output + errors };
}

test('local startup persists private admin credentials and serves only empty official data', async t => {
  const files = await fixture(t), running = await launchLocal(t, files.dataDir);
  const key = (await readFile(resolve(files.dataDir, 'admin.key'), 'utf8')).trim();
  const entry = await readFile(resolve(files.dataDir, 'admin-entry.html'), 'utf8');
  assert.ok(entry.includes(`${running.origin}/event/#token=${key}`));
  assert.ok(!running.output().includes(key));
  const context = await (await fetch(`${running.baseUrl}/api/context`)).json();
  assert.equal(context.deploymentMode, 'cloud');
  assert.equal(context.publicBaseUrl, `${running.origin}/event/`);
  const stateResponse = await fetch(`${running.baseUrl}/api/admin`, { headers: { Authorization: `Bearer ${key}` } });
  assert.equal(stateResponse.status, 200);
  const state = await stateResponse.json();
  assert.equal(state.event.phase, 'setup');
  assert.deepEqual(state.teams, []); assert.deepEqual(state.judges, []); assert.deepEqual(state.voters, []);
  assert.equal((await fetch(`${running.baseUrl}/admin-entry.html`)).status, 404);
  assert.equal((await fetch(`${running.baseUrl}/admin.key`)).status, 404);
  if (process.platform !== 'win32') {
    assert.equal((await stat(files.dataDir)).mode & 0o777, 0o700);
    for (const filename of ['event.sqlite3', 'admin.key', 'admin-entry.html']) {
      assert.equal((await stat(resolve(files.dataDir, filename))).mode & 0o777, 0o600);
    }
  }
  await running.stop();
});

test('local restarts retain the key and rewrite the private link for the current origin', async t => {
  const files = await fixture(t), first = await launchLocal(t, files.dataDir);
  const key = await readFile(resolve(files.dataDir, 'admin.key'), 'utf8'); await first.stop();
  const second = await launchLocal(t, files.dataDir, { AWARDS_ADMIN_TOKEN: 'different-but-valid-admin-token-12345', BASE_PATH: '/new-event' });
  assert.equal(await readFile(resolve(files.dataDir, 'admin.key'), 'utf8'), key);
  const entry = await readFile(resolve(files.dataDir, 'admin-entry.html'), 'utf8');
  assert.ok(entry.includes(`${second.origin}/new-event/#token=${key.trim()}`));
  assert.ok(!second.output().includes(key.trim())); await second.stop();
});

test('local startup generates a random persisted key when none was supplied', async t => {
  const files = await fixture(t), running = await launchLocal(t, files.dataDir, { AWARDS_ADMIN_TOKEN: undefined });
  const key = (await readFile(resolve(files.dataDir, 'admin.key'), 'utf8')).trim();
  assert.match(key, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(!running.output().includes(key)); await running.stop();
});

test('local startup refuses to place private data in the public web directory', async () => {
  await assert.rejects(startLocal({ env: { DATA_DIR: resolve(HERE, '../web/private-data') } }), /MUST_BE_PRIVATE/);
});

test('a linked ancestor cannot place administrator files inside the public directory', { skip: process.platform === 'win32' }, async t => {
  const files = await fixture(t), publicDir = resolve(HERE, '../web');
  const linkedAncestor = resolve(files.root, 'public-alias');
  const uniqueName = `private-path-test-${process.pid}-${Date.now()}`;
  const actualDirectory = resolve(publicDir, uniqueName);
  t.after(() => rm(actualDirectory, { recursive: true, force: true }));
  await symlink(publicDir, linkedAncestor, 'dir');
  await assert.rejects(startLocal({ env: { DATA_DIR: resolve(linkedAncestor, uniqueName) } }), /MUST_BE_PRIVATE/);
  // Directory preparation must not be followed by any secret or database writes.
  assert.deepEqual(await readdir(actualDirectory), []);
});

test('demo mode accepts only loopback and the fixed project data-demo path', async () => {
  const dataDir = resolve(HERE, '../data-demo');
  for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]']) {
    const options = validateLocalDeployment({ deploymentMode: 'demo', host, dataDir });
    assert.equal(options.deploymentMode, 'demo');
    assert.equal(options.dataDir, dataDir);
    assert.equal(options.host, host === '[::1]' ? '::1' : host);
  }
  await assert.rejects(startLocal({ deploymentMode: 'demo', env: { HOST: '0.0.0.0', DATA_DIR: dataDir } }), /DEMO_LOOPBACK_REQUIRED/);
  await assert.rejects(startLocal({ deploymentMode: 'demo', env: { HOST: '192.0.2.1', DATA_DIR: dataDir } }), /DEMO_LOOPBACK_REQUIRED/);
  await assert.rejects(startLocal({ deploymentMode: 'demo', env: { HOST: '127.0.0.1', DATA_DIR: resolve(HERE, '../data') } }), /DEMO_DATA_DIRECTORY_REQUIRED/);
  await assert.rejects(startLocal({ deploymentMode: 'demo', env: { HOST: 'localhost', DATA_DIR: resolve(tmpdir(), 'unapproved-demo-data') } }), /DEMO_DATA_DIRECTORY_REQUIRED/);
  await assert.rejects(startLocal({ deploymentMode: 'unknown', env: {} }), /DEPLOYMENT_MODE_INVALID/);
});
