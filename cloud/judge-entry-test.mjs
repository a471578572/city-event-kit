import assert from 'node:assert/strict';
import { randomBytes, createHmac } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import { freshState, updateState, roleOf, contextFor, validateRestore, judgeEntryKey } from './business.mjs';
import { createServer } from './server.mjs';

const ADMIN = 'TEST_ONLY_ADMIN_JUDGE_QR_0123456789';
const ORIGIN = 'https://judge-qr-tests.example.invalid';
const BASE = '/event';
const key = () => randomBytes(32).toString('base64url');
const clone = value => structuredClone(value);
const mutate = (state, route, payload, token = ADMIN) => updateState(state, route, payload, token, ADMIN);
function fixture() {
  const state = freshState();
  mutate(state, '/api/roster/import', { people: [
    { name: '虚构选手甲', phone: '19900001001', role: 'player' },
    { name: '虚构选手乙', phone: '19900001002', role: 'player' },
  ] });
  mutate(state, '/api/roster/judges', { judges: [{ name: '虚构评委甲' }, { name: '虚构评委乙' }, { name: '虚构评委丙' }] });
  mutate(state, '/api/teams/create', { name: '测试甲队' }, state.voters[0].token);
  mutate(state, '/api/teams/create', { name: '测试乙队' }, state.voters[1].token);
  return state;
}
const judgePayload = (name = '虚构评委甲', deviceKey = key()) => ({ name, entryKey: judgeEntryKey(ADMIN), deviceKey });
function rejectedWithoutMutation(state, payload) {
  const before = clone(state);
  assert.throws(() => mutate(state, '/api/judges/login', payload, ''));
  assert.deepEqual(state, before);
}

test('judge entry key uses its own fixed HMAC domain and is not stored in event or public context', () => {
  const state = fixture();
  const derived = judgeEntryKey(ADMIN);
  assert.equal(derived, createHmac('sha256', ADMIN).update('city-event-kit:judge-entry:v1').digest('base64url'));
  assert.equal(derived.length, 43);
  assert.notEqual(derived, judgeEntryKey(ADMIN + '_rotated'));
  assert(!JSON.stringify(state).includes(derived));
  assert(!JSON.stringify(contextFor(state, 'guest', null)).includes(derived));
});

test('a shared judge QR selects the same phone-less judge from any device', () => {
  const state = fixture();
  const payload = judgePayload();
  const reply = mutate(state, '/api/judges/login', { ...payload, name: '  虚构评委甲  ' }, '');
  assert.equal(roleOf(state, reply.token, ADMIN, true)[0], 'judge');
  assert.equal(reply.token, state.judges[0].token);
  assert.equal(state.judges[0].phone, '');
  assert(state.judges[0].deviceHash);
  assert(!JSON.stringify(state).includes(payload.deviceKey));
  assert.equal(mutate(state, '/api/judges/login', payload, '').token, reply.token);
  const before = clone(state.judges[0]);
  assert.equal(mutate(state, '/api/judges/login', { ...payload, deviceKey: key() }, '').token, reply.token);
  assert.deepEqual(state.judges[0], before);
  assert(!state.judges[1].deviceHash);
});

test('judge login rejects absent or wrong QR capability, unknown names and malformed device keys', () => {
  const state = fixture();
  const payload = judgePayload();
  for (const entryKey of [undefined, '', 'x'.repeat(43), ADMIN]) rejectedWithoutMutation(state, { ...payload, entryKey });
  rejectedWithoutMutation(state, { ...payload, name: '不存在的虚构评委' });
  rejectedWithoutMutation(state, { ...payload, name: state.voters[0].name });
  rejectedWithoutMutation(state, { ...payload, deviceKey: 'tiny' });
  assert(!state.judges.some(j => j.deviceHash));
});

test('judging can open without judge phone numbers and first-device metadata survives v2 backup', () => {
  const state = fixture();
  const payload = judgePayload();
  const reply = mutate(state, '/api/judges/login', payload, '');
  assert.deepEqual(validateRestore({ schemaVersion: 2, state: clone(state) }), state);
  mutate(state, '/api/phase', { phase: 'open' });
  assert.equal(state.event.teamsOpen, true);
  mutate(state, '/api/score', { teamId: state.teams[0].id, scores: [9, 8, 8, 7] }, reply.token);
  assert.deepEqual(validateRestore({ schemaVersion: 2, state: clone(state) }), state);
});

test('staff can recover judge QR entry on another device without changing scores', () => {
  const state = fixture();
  const payload = judgePayload();
  const old = mutate(state, '/api/judges/login', payload, '');
  mutate(state, '/api/phase', { phase: 'open' });
  mutate(state, '/api/score', { teamId: state.teams[0].id, scores: [8, 8, 8, 8] }, old.token);
  const scores = clone(state.scores);
  mutate(state, '/api/roster/reset-device', { personId: state.judges[0].id });
  const renewed = mutate(state, '/api/judges/login', judgePayload(), '');
  assert.notEqual(renewed.token, old.token);
  assert.throws(() => roleOf(state, old.token, ADMIN, true));
  assert.deepEqual(state.scores, scores);
});

function memoryStore(initial) {
  let state = clone(initial), version = 0;
  return {
    async read() { return { state: clone(state), version }; },
    async compareAndSwap(expected, replacement) {
      if (expected !== version) return false;
      state = clone(replacement); version++; return true;
    },
  };
}
async function withHttp(t, store) {
  const server = createServer({ store, adminToken: ADMIN, publicOrigin: ORIGIN, basePath: BASE });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}${BASE}`;
  return async (path, data, token) => {
    const response = await fetch(base + path, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json', Origin: ORIGIN }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    return { status: response.status, body: await response.json() };
  };
}

test('only the admin endpoint discloses the derived judge QR key; context and backup omit it', async t => {
  const state = fixture(), request = await withHttp(t, memoryStore(state));
  assert.equal((await request('/api/admin')).status, 403);
  assert.equal((await request('/api/admin', undefined, state.voters[0].token)).status, 403);
  const admin = await request('/api/admin', undefined, ADMIN);
  assert.equal(admin.body.judgeEntryKey, judgeEntryKey(ADMIN));
  for (const [path, token] of [['/api/context', undefined], ['/api/context', state.voters[0].token], ['/api/backup', ADMIN]]) {
    assert(!JSON.stringify((await request(path, undefined, token)).body).includes(judgeEntryKey(ADMIN)));
  }
  const login = await request('/api/judges/login', judgePayload());
  assert.equal(login.status, 200); assert.equal(login.body.ok, true);
  assert.equal(roleOf(state, login.body.token, ADMIN, true)[0], 'judge');
});

test('an unknown judge login write outcome never retries or returns a token', async t => {
  let state = fixture(), writes = 0;
  const request = await withHttp(t, {
    async read() { return { state: clone(state), version: 0 }; },
    async compareAndSwap(_version, replacement) { state = clone(replacement); writes++; throw new Error('FICTIONAL_UNKNOWN_COMMIT'); },
  });
  const reply = await request('/api/judges/login', judgePayload());
  assert.equal(reply.status, 503);
  assert.equal(writes, 1);
  assert(!('token' in reply.body)); assert.notEqual(reply.body.ok, true);
  assert(!JSON.stringify(reply.body).includes(state.judges[0].token));
  assert(state.judges[0].deviceHash);
});

test('judge login rate limits names independently from each other and phone login', async t => {
  const state = fixture(), request = await withHttp(t, memoryStore(state));
  const failed = { ...judgePayload(), entryKey: 'x'.repeat(43) };
  for (let index = 0; index < 12; index++) assert.equal((await request('/api/judges/login', failed)).status, 401);
  assert.equal((await request('/api/judges/login', failed)).status, 429);
  assert.equal((await request('/api/judges/login', judgePayload('虚构评委乙'))).status, 200);
  assert.equal((await request('/api/login', { phone: '19900001001', deviceKey: key() })).status, 200);
});
