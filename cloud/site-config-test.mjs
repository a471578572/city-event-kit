import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { SITE_CONFIG, validateSiteConfig } from './site-config.mjs';
import { freshState, updateState, publicEventFor, publicGuideFor } from './business.mjs';
import { createServer } from './server.mjs';

const ADMIN = 'PUBLIC_CONFIG_TEST_0123456789abcdef';
const clone = value => structuredClone(value);
test('public site configuration is strictly validated and starts an empty phone event', () => {
  assert.deepEqual(validateSiteConfig(clone(SITE_CONFIG)), SITE_CONFIG);
  assert.equal(Object.isFrozen(SITE_CONFIG), true);
  const state = freshState();
  assert.equal(state.event.name, SITE_CONFIG.name);
  assert.equal(state.event.entryMode, 'phone');
  assert.equal(state.event.teamsOpen, true);
  assert.equal(state.voters.length + state.judges.length + state.teams.length, 0);
  assert.equal(SITE_CONFIG.publicPlayerWall, false);
});
test('public configuration rejects secret fields, executable URLs, paths outside assets and invalid dates', () => {
  for (const patch of [{ adminToken: 'must_not_publish' }, { publicPlayerWall: 'true' }, { date: '2026-02-30' },
    { logos: [{ name: '示例', src: '../data/admin.key' }] }, { logos: [{ name: '示例', src: 'assets/../admin.key' }] },
    { logos: [{ name: '示例', src: 'https://outside.example.invalid/logo.svg' }] },
    { logos: [{ name: '示例', src: 'assets/logo.svg', onload: 'alert(1)' }] },
    { registrationUrl: 'javascript:alert(1)' }, { handbookUrl: 'https://user:password@example.invalid/' },
    { name: 'bad\nname' }, { certificateIssuer: '' }]) {
    assert.throws(() => validateSiteConfig({ ...clone(SITE_CONFIG), ...patch }));
  }
});
test('public event exposes only configuration and safe judge introductions, while player profiles stay private by default', () => {
  const state = freshState();
  updateState(state, '/api/roster/import', { people: [{ name: '虚构选手', phone: '19900000001', role: 'player', profile: { background: '默认私密资料' } }] }, ADMIN, ADMIN);
  updateState(state, '/api/roster/judges', { judges: [{ name: '虚构评委', bio: '示例介绍', phone: '19900000901' }] }, ADMIN, ADMIN);
  const before = clone(state), visible = publicEventFor(state);
  assert.deepEqual(visible, { event: SITE_CONFIG, judges: [{ name: '虚构评委', bio: '示例介绍' }] });
  assert.deepEqual(publicGuideFor(state).players, []);
  assert.equal(publicGuideFor(state, { ...SITE_CONFIG, publicPlayerWall: true }).players.length, 1);
  const encoded = JSON.stringify(visible);
  for (const person of [...state.voters, ...state.judges]) {
    assert.equal(encoded.includes(person.id), false); assert.equal(encoded.includes(person.phone), false); assert.equal(encoded.includes(person.token), false);
  }
  visible.event.logos[0].name = '只改副本';
  assert.notEqual(SITE_CONFIG.logos[0].name, '只改副本');
  assert.deepEqual(state, before);
});
test('HTTP public configuration cannot expose administrator data through forged credentials or query switches', async t => {
  const state = freshState();
  updateState(state, '/api/roster/judges', { judges: [{ name: '虚构评委', bio: '公开介绍', phone: '19900000901' }] }, ADMIN, ADMIN);
  let writes = 0;
  const server = createServer({ adminToken: ADMIN, store: { read: async () => ({ state: clone(state), version: 0 }),
    compareAndSwap: async () => { writes++; return false; } }, publicDir: fileURLToPath(new URL('../web/', import.meta.url)) });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}/event`;
  for (const authorization of ['', 'invalid', `Bearer ${ADMIN}`]) {
    const response = await fetch(base + '/api/public-event?include=phone,token&role=admin', { headers: authorization ? { Authorization: authorization } : {} });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), publicEventFor(state));
  }
  const config = await fetch(base + '/site-config.json');
  assert.equal(config.status, 200); assert.match(config.headers.get('content-type'), /^application\/json/u);
  assert.deepEqual(await config.json(), SITE_CONFIG);
  for (const path of ['/data/admin.key', '/admin-entry.html', '/cloud/business.mjs', '/site-config.mjs']) assert.equal((await fetch(base + path)).status, 404);
  assert.equal(writes, 0);
});
