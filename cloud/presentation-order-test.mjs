import { legacyFreshState } from './test-fixtures.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { buildSetup, freshState, updateState, contextFor, presentationOrderFor, validateRestore } from './business.mjs';
import { createServer } from './server.mjs';

// Fictional, in-memory events only. No production credentials or event data.
const ADMIN = 'PRESENTATION_TEST_ADMIN_0123456789abcdef';
const REQUEST = 'draw_request_0123456789abcdef';
const clone = value => structuredClone(value);
const change = (state, route, payload, token = ADMIN) => updateState(state, route, payload, token, ADMIN);
const draw = (state, requestId = REQUEST, expectedRevision) => change(state, '/api/presentation-order', {
  requestId, ...(expectedRevision === undefined ? {} : { expectedRevision }),
});
function legacy(count = 3) {
  return buildSetup({ name: '虚构路演测试', audienceEnabled: true, allowRepeat: false, audienceCount: 1,
    teams: Array.from({ length: count }, (_, i) => ({ name: `虚构队伍${i + 1}`, project: `虚构作品${i + 1}`, members: 1 })),
    judges: [{ name: '虚构评委' }],
  });
}
function phone() {
  const state = freshState();
  change(state, '/api/roster/import', { people: Array.from({ length: 4 }, (_, i) => ({
    name: `虚构选手${i + 1}`, phone: `1990000${String(i + 1).padStart(4, '0')}`, role: 'player', profile: {},
  })) });
  change(state, '/api/roster/judges', { judges: [{ name: '虚构评委' }] });
  change(state, '/api/roster/settings', { teamsOpen: true, audienceEnabled: true });
  for (let i = 0; i < 3; i++) change(state, '/api/teams/create', { name: `虚构队伍${i + 1}`, project: `虚构作品${i + 1}` }, state.voters[i].token);
  return state;
}
function rejected(state, action, status) {
  const before = clone(state);
  assert.throws(action, error => !status || error.status === status);
  assert.deepEqual(state, before, 'a rejected draw must not mutate any event record');
}

test('undrawn public projection is explicit, narrow, and available in every role context', () => {
  const state = legacy(), expected = { revision: 0, drawnAt: null, teams: [],
    pendingTeams: state.teams.map(({ id, name, project }) => ({ id, name, project })) };
  assert.deepEqual(presentationOrderFor(state), expected);
  for (const [role, person] of [['guest', null], ['admin', null], ['judge', state.judges[0]],
    ['player', state.voters[0]], ['audience', state.voters.at(-1)]]) {
    assert.deepEqual(contextFor(state, role, person).presentationOrder, expected);
  }
  assert.equal(Object.hasOwn(state, 'presentationOrder'), false);
});

test('administrator draws all teams exactly once without changing scores, ballots, people, or settings', () => {
  const state = legacy(100);
  change(state, '/api/phase', { phase: 'open' });
  change(state, '/api/score', { teamId: state.teams[0].id, scores: [8, 9, 7, 8] }, state.judges[0].token);
  change(state, '/api/vote', { allocations: { [state.teams[1].id]: 1 } }, state.voters[0].token);
  const before = clone(state), result = draw(state, REQUEST, 0);
  assert.deepEqual(new Set(state.presentationOrder.teamIds), new Set(state.teams.map(team => team.id)));
  assert.equal(state.presentationOrder.teamIds.length, 100);
  assert.equal(state.presentationOrder.revision, 1);
  assert.ok(Number.isFinite(Date.parse(state.presentationOrder.drawnAt)));
  assert.deepEqual(result.presentationOrder.teams.map(team => team.position), Array.from({ length: 100 }, (_, i) => i + 1));
  assert.deepEqual(result.presentationOrder.pendingTeams, []);
  const unchanged = clone(state); delete unchanged.presentationOrder;
  assert.deepEqual(unchanged, before);
  assert.deepEqual(Object.keys(state.presentationOrder).sort(), ['drawnAt', 'requestId', 'revision', 'teamIds']);
});

test('request ID retries keep the persisted draw and stale revisions cannot overwrite it', () => {
  const state = legacy();
  const first = draw(state, REQUEST, 0), saved = clone(state);
  assert.deepEqual(draw(state, REQUEST, 0), first, 'retry succeeds despite old expected revision');
  assert.deepEqual(state, saved);
  rejected(state, () => draw(state, 'second_request_0123456789', 0), 409);
  const second = draw(state, 'second_request_0123456789', 1);
  assert.equal(second.presentationOrder.revision, 2);
  assert.equal(state.presentationOrder.requestId, 'second_request_0123456789');
});

test('zero teams reject, one team can draw, and published events cannot be redrawn', () => {
  const empty = freshState();
  rejected(empty, () => draw(empty), 409);
  const single = legacy(); single.teams = single.teams.slice(0, 1);
  assert.equal(draw(single).presentationOrder.teams.length, 1);
  for (const phase of ['setup', 'open', 'closed']) {
    const state = legacy(); state.event.phase = phase;
    assert.equal(draw(state).presentationOrder.revision, 1);
  }
  const state = legacy(); draw(state); state.event.phase = 'published';
  const before = clone(state);
  assert.deepEqual(draw(state).presentationOrder, presentationOrderFor(state), 'published retry acknowledges the existing draw');
  assert.deepEqual(state, before);
  rejected(state, () => draw(state, 'new_request_0123456789'), 409);
});

test('only administrators may draw and malformed requests do not mutate state', () => {
  const state = legacy();
  for (const token of ['', state.judges[0].token, state.voters[0].token, state.voters.at(-1).token]) {
    rejected(state, () => change(state, '/api/presentation-order', { requestId: REQUEST }, token), token ? 403 : 401);
  }
  for (const requestId of ['', 'short', 'a'.repeat(101), null, 17, 'request with spaces 1234', '请求编号0123456789abcdef']) {
    rejected(state, () => draw(state, requestId), 400);
  }
  for (const expectedRevision of [-1, 1.2, '0', null, Number.MAX_SAFE_INTEGER + 1]) {
    rejected(state, () => draw(state, REQUEST, expectedRevision), 400);
  }
});

test('renames use current names, removed teams disappear, and later teams remain pending without changing the draw', () => {
  const state = phone(); draw(state);
  const saved = clone(state.presentationOrder), removedId = saved.teamIds[0];
  state.teams.find(team => team.id === saved.teamIds[1]).name = '虚构改名队伍';
  state.teams = state.teams.filter(team => team.id !== removedId);
  state.teams.push({ id: 'team_later_012345', name: '虚构后来队伍', project: '后来作品', members: 1, captainVoterId: 'voter_later' });
  const visible = presentationOrderFor(state);
  assert.equal(visible.teams.some(team => team.id === removedId), false);
  assert.equal(visible.teams.find(team => team.id === saved.teamIds[1]).name, '虚构改名队伍');
  assert.deepEqual(visible.teams.map(team => team.position), [1, 2]);
  assert.deepEqual(visible.pendingTeams, [{ id: 'team_later_012345', name: '虚构后来队伍', project: '后来作品' }]);
  assert.deepEqual(state.presentationOrder, saved);
});

test('old schema 1, 2, and 3 backups retain exact shape, while optional draws round-trip in each', () => {
  const invitationState = phone();
  change(invitationState, '/api/invitations/send', { targetId: invitationState.voters[3].id }, invitationState.voters[0].token);
  for (const [schemaVersion, state] of [[1, legacy()], [2, phone()], [3, invitationState]]) {
    assert.deepEqual(validateRestore({ schemaVersion, state: clone(state) }), state);
    assert.equal(Object.hasOwn(validateRestore({ schemaVersion, state: clone(state) }), 'presentationOrder'), false);
    draw(state);
    assert.deepEqual(validateRestore({ schemaVersion, state: clone(state) }), state);
    state.presentationOrder.teamIds.push('team_deleted_historical');
    assert.deepEqual(validateRestore({ schemaVersion, state: clone(state) }), state, 'historical deleted IDs survive restoration');
    assert.equal(presentationOrderFor(state).teams.some(team => team.id === 'team_deleted_historical'), false);
  }
});

test('restore strictly validates optional draw fields and keeps legacy empty backups compatible', () => {
  const empty = legacyFreshState();
  assert.deepEqual(validateRestore({ schemaVersion: 1, state: clone(empty) }), empty);
  const state = legacy(); draw(state);
  const invalid = [null, [], {}, { ...state.presentationOrder, token: 'private' },
    { ...state.presentationOrder, teamIds: [] }, { ...state.presentationOrder, teamIds: ['team_duplicate', 'team_duplicate'] },
    { ...state.presentationOrder, teamIds: ['invalid id'] }, { ...state.presentationOrder, teamIds: ['a'.repeat(81)] },
    { ...state.presentationOrder, teamIds: [42] }, { ...state.presentationOrder, teamIds: Array.from({ length: 101 }, (_, i) => `team_${i}`) },
    { ...state.presentationOrder, revision: 0 }, { ...state.presentationOrder, revision: 1.5 },
    { ...state.presentationOrder, requestId: 'bad' }, { ...state.presentationOrder, drawnAt: 'yesterday' },
    { ...state.presentationOrder, drawnAt: '2026-02-30T09:00:00.000Z' }];
  for (const presentationOrder of invalid) {
    const candidate = clone(state); candidate.presentationOrder = presentationOrder;
    assert.throws(() => validateRestore({ schemaVersion: 1, state: candidate }));
  }
});

async function serve(t, initial, options = {}) {
  let stored = clone(initial), version = 0;
  const store = { read: async () => ({ state: clone(stored), version }),
    compareAndSwap: async (expected, state) => {
      if (expected !== version) return false;
      stored = clone(state); version++;
      return true;
    } };
  const server = createServer({ store, adminToken: ADMIN, publicOrigin: 'http://localhost', ...options });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}/event`;
  const post = async (payload, token = ADMIN) => {
    const response = await fetch(base + '/api/presentation-order', { method: 'POST', headers: {
      'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
    }, body: JSON.stringify(payload) });
    return { status: response.status, value: await response.json() };
  };
  return { base, post, state: () => clone(stored) };
}

test('HTTP public projection ignores malformed credentials and never exposes private fields', async t => {
  const state = phone(); draw(state);
  const { base, post } = await serve(t, state);
  const response = await fetch(base + '/api/presentation-order', { headers: { Authorization: 'not-a-valid-bearer' } });
  assert.equal(response.status, 200);
  const visible = await response.json();
  assert.deepEqual(visible, presentationOrderFor(state));
  const encoded = JSON.stringify(visible);
  for (const forbidden of ['token', 'phone', 'profile', 'deviceHash', 'captainVoterId', 'requestId', 'recusals', 'scores', 'ballots']) {
    assert.equal(encoded.includes(`"${forbidden}"`), false);
  }
  assert.equal((await post({ requestId: REQUEST }, state.judges[0].token)).status, 403);
  assert.equal((await post({ requestId: REQUEST }, '')).status, 401);
});

test('HTTP concurrent identical requests persist one draw, and competing stale draws cannot overwrite it', async t => {
  const { base, post, state } = await serve(t, legacy());
  const same = await Promise.all(Array.from({ length: 4 }, () => post({ requestId: REQUEST, expectedRevision: 0 })));
  assert.ok(same.every(result => result.status === 200));
  assert.ok(same.every(result => result.value.presentationOrder.revision === 1));
  assert.ok(same.every(result => JSON.stringify(result.value.presentationOrder) === JSON.stringify(same[0].value.presentationOrder)));
  assert.equal(state().presentationOrder.revision, 1);
  const competing = await Promise.all(['competing_request_alpha', 'competing_request_beta'].map(requestId => post({ requestId, expectedRevision: 1 })));
  assert.deepEqual(competing.map(result => result.status).sort(), [200, 409]);
  assert.equal(state().presentationOrder.revision, 2);
  const backup = await fetch(base + '/api/backup', { headers: { Authorization: `Bearer ${ADMIN}` } });
  const document = await backup.json();
  assert.deepEqual(validateRestore(document), state());
});
