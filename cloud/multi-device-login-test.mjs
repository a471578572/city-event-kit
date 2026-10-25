import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { freshState, updateState, contextFor, roleOf, judgeEntryKey, validateRestore } from './business.mjs';
import { createServer } from './server.mjs';

// Fictional local identities only. No production data or credentials.
const ADMIN = 'MULTI_DEVICE_TEST_ADMIN_0123456789abcdef';
const clone = value => structuredClone(value);
const key = () => randomBytes(32).toString('hex');
const change = (state, route, payload, token = ADMIN) => updateState(state, route, payload, token, ADMIN);
const phoneLogin = (state, phone, deviceKey = key()) => change(state, '/api/login', { phone, deviceKey }, '');
const qrLogin = (state, judge, deviceKey = key()) => change(state, '/api/judges/login', {
  name: judge.name, entryKey: judgeEntryKey(ADMIN), deviceKey,
}, '');
function fixture() {
  const state = freshState();
  change(state, '/api/roster/import', { people: Array.from({ length: 3 }, (_, index) => ({
    name: `虚构选手${index + 1}`, phone: `1990000000${index + 1}`, role: 'player', profile: { skills: '测试技能' },
  })) });
  change(state, '/api/roster/judges', { judges: [{ name: '虚构评委甲', phone: '19900000901' }, { name: '虚构评委乙' }] });
  change(state, '/api/roster/import', { people: [{ name: state.voters[0].name, phone: state.voters[0].phone,
    role: 'player', profile: {}, linkedJudgeId: state.judges[0].id }] });
  change(state, '/api/roster/settings', { teamsOpen: true, audienceEnabled: true });
  for (let index = 0; index < 3; index++) change(state, '/api/teams/create', {
    name: `虚构队伍${index + 1}`, project: `虚构作品${index + 1}`,
  }, state.voters[index].token);
  change(state, '/api/presentation-order', { requestId: 'multi_device_test_draw', expectedRevision: 0 });
  return state;
}
const protectedRecords = state => clone({ event: state.event, teams: state.teams, scores: state.scores,
  ballots: state.ballots, presentationOrder: state.presentationOrder });

test('cross-device phone, judge QR and existing audience entry preserve one identity and all results', () => {
  const state = fixture(), player = state.voters[0], judge = state.judges[0];
  const first = phoneLogin(state, player.phone), firstJudge = qrLogin(state, judge);
  const registered = change(state, '/api/audience/register', { name: '虚构观众', phone: '19900000801', deviceKey: key() }, '');
  const audience = state.voters.find(person => person.phone === '19900000801');
  change(state, '/api/phase', { phase: 'open' });
  change(state, '/api/score', { teamId: state.teams[1].id, scores: [7, 8, 9, 8] }, firstJudge.token);
  change(state, '/api/vote', { allocations: { [state.teams[1].id]: 1 } }, first.token);
  change(state, '/api/vote', { allocations: { [state.teams[0].id]: 1 } }, registered.token);
  const before = clone(state);
  assert.equal(phoneLogin(state, player.phone).token, first.token);
  assert.equal(qrLogin(state, judge).token, firstJudge.token);
  assert.equal(phoneLogin(state, judge.phone).token, firstJudge.token);
  assert.equal(change(state, '/api/audience/register', { name: '不应覆盖原称呼', phone: audience.phone, deviceKey: key() }, '').token, registered.token);
  assert.deepEqual(state, before, 're-entry keeps first metadata, credentials, memberships, ballots, scores, and draw unchanged');
  assert.equal(contextFor(state, 'player', player).ballot.voterId, player.id);
  assert.equal(contextFor(state, 'judge', judge).scores.length, 1);
  assert.equal(contextFor(state, 'judge', judge).judge.recusals[0].automatic, true);
  assert.equal(state.judges.length, 2);
  assert.deepEqual(validateRestore({ schemaVersion: 2, state: clone(state) }), state);
});

test('the same browser can re-enter registered identities but cannot create additional audience identities', () => {
  const state = fixture(), sharedKey = key();
  phoneLogin(state, state.voters[0].phone, sharedKey);
  const before = clone(state.voters[1]);
  assert.equal(change(state, '/api/audience/register', { name: '不覆盖选手', phone: before.phone, deviceKey: sharedKey }, '').token, before.token);
  assert.equal(state.voters[1].role, 'player');
  assert.equal(state.voters[1].teamId, before.teamId);
  const stored = clone(state);
  assert.throws(() => change(state, '/api/audience/register', { name: '虚构新观众', phone: '19900000802', deviceKey: sharedKey }, ''), error => error.status === 401);
  assert.deepEqual(state, stored);
});

test('switching devices cannot create a second ballot, and judge scores retain the original judge ID', () => {
  const state = fixture(), player = state.voters[0], judge = state.judges[0];
  change(state, '/api/phase', { phase: 'open' });
  const allocation = { [state.teams[1].id]: 1 };
  change(state, '/api/vote', { allocations: allocation }, phoneLogin(state, player.phone).token);
  const secondPlayer = phoneLogin(state, player.phone);
  change(state, '/api/vote', { allocations: allocation }, secondPlayer.token);
  assert.throws(() => change(state, '/api/vote', { allocations: { [state.teams[2].id]: 1 } }, secondPlayer.token), error => error.status === 409);
  assert.equal(state.ballots.length, 1);
  const firstJudge = qrLogin(state, judge);
  change(state, '/api/score', { teamId: state.teams[1].id, scores: [7, 7, 7, 7] }, firstJudge.token);
  const secondJudge = qrLogin(state, judge);
  change(state, '/api/score', { teamId: state.teams[1].id, scores: [8, 8, 8, 8] }, secondJudge.token);
  assert.equal(state.scores.length, 1);
  assert.equal(state.scores[0].judgeId, judge.id);
  assert.deepEqual(state.scores[0].scores, [8, 8, 8, 8]);
});

test('staff recovery revokes the old credential while every device can use the same phone identity again', () => {
  const state = fixture(), player = state.voters[0], oldKey = key();
  const old = phoneLogin(state, player.phone, oldKey);
  change(state, '/api/phase', { phase: 'open' });
  change(state, '/api/vote', { allocations: { [state.teams[1].id]: 1 } }, old.token);
  const protectedBefore = protectedRecords(state), linkedJudgeId = player.linkedJudgeId;
  change(state, '/api/roster/reset-device', { personId: player.id });
  assert.throws(() => roleOf(state, old.token, ADMIN, true), error => error.status === 401);
  const newLogin = phoneLogin(state, player.phone);
  assert.notEqual(newLogin.token, old.token);
  assert.equal(phoneLogin(state, player.phone, oldKey).token, newLogin.token);
  assert.equal(player.linkedJudgeId, linkedJudgeId);
  assert.deepEqual(protectedRecords(state), protectedBefore);
});

test('unknown phones, malformed devices and wrong QR capabilities still cannot acquire an identity', () => {
  const state = fixture(), before = clone(state);
  assert.throws(() => phoneLogin(state, '19900000777'), error => error.status === 401);
  assert.throws(() => phoneLogin(state, state.voters[0].phone, 'invalid'), error => error.status === 400);
  assert.throws(() => change(state, '/api/judges/login', { name: state.judges[0].name,
    deviceKey: key(), entryKey: 'x'.repeat(43) }, ''), error => error.status === 401);
  assert.deepEqual(state, before);
});

async function serve(t, initial) {
  let state = clone(initial), version = 0;
  const store = { read: async () => { const snapshot = { state: clone(state), version }; await nextTurn(); return snapshot; },
    compareAndSwap: async (expected, replacement) => {
      if (expected !== version) return false;
      state = clone(replacement); version++; return true;
    } };
  const server = createServer({ store, adminToken: ADMIN, publicOrigin: 'http://localhost' });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}/event`;
  const post = async (path, payload, token) => {
    const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(payload) });
    return { status: response.status, body: await response.json() };
  };
  return { post, state: () => clone(state) };
}

test('concurrent judge QR logins on different devices share one credential and scoring identity', async t => {
  const initial = fixture(); change(initial, '/api/phase', { phase: 'open' });
  const { post, state } = await serve(t, initial);
  const responses = await Promise.all(Array.from({ length: 3 }, () => post('/api/judges/login', {
    name: initial.judges[0].name, entryKey: judgeEntryKey(ADMIN), deviceKey: key(),
  })));
  assert.deepEqual(responses.map(response => response.status), [200, 200, 200]);
  assert.equal(new Set(responses.map(response => response.body.token)).size, 1);
  assert.equal(responses[0].body.token, initial.judges[0].token);
  assert.equal(state().judges.length, initial.judges.length);
  const scores = await Promise.all(responses.slice(0, 2).map((response, index) => post('/api/score', {
    teamId: initial.teams[index + 1].id, scores: [8, 7, 8, 9],
  }, response.body.token)));
  assert.deepEqual(scores.map(response => response.status), [200, 200]);
  assert.equal(state().scores.length, 2);
  assert.ok(state().scores.every(score => score.judgeId === initial.judges[0].id));
  assert.deepEqual(state().presentationOrder, initial.presentationOrder);
});
