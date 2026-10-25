import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { freshState, updateState, contextFor, validateRestore, calculateResults } from './business.mjs';
import { createServer } from './server.mjs';

const ADMIN = 'TEAM_IMPORT_TEST_ONLY_0123456789abcdef';
const clone = value => structuredClone(value);
const phone = index => `1990000${String(index).padStart(4, '0')}`;
const change = (state, route, payload, token = ADMIN) => updateState(state, route, payload, token, ADMIN);
function fixture() {
  const state = freshState();
  change(state, '/api/roster/import', { people: [
    ...Array.from({ length: 8 }, (_, index) => ({ name: `虚构选手${index + 1}`, phone: phone(index + 1), role: 'player', profile: {} })),
    { name: '虚构观众', phone: phone(100), role: 'audience', profile: {} },
  ] });
  change(state, '/api/roster/judges', { judges: [{ name: '虚构评委' }] });
  return state;
}
const teams = () => [{ name: '示例甲队', project: '示例甲作品', track: 'office', captainPhone: phone(2), memberPhones: [phone(1), phone(2)] },
  { name: '示例乙队', project: '示例乙作品', memberPhones: [phone(3)] },
  { name: '示例待补录队', project: '示例独立作品', track: 'game', memberPhones: [] }];
const imported = state => change(state, '/api/teams/import', { teams: teams() });
function rejectUnchanged(state, list, status) {
  const before = clone(state);
  assert.throws(() => change(state, '/api/teams/import', { teams: list }), error => !status || error.status === status);
  assert.deepEqual(state, before, 'a rejected batch must preserve every original record');
}
test('team import uses registered players, supports real captains and empty supplement teams, and never creates vote identities', () => {
  const state = fixture(), people = clone(state.voters), judges = clone(state.judges);
  assert.deepEqual(imported(state), { added: 3, updated: 0 });
  assert.equal(state.teams[0].captainVoterId, state.voters[1].id);
  assert.equal(state.teams[0].members, 2);
  assert.equal(state.teams[0].track, 'office');
  assert.equal(state.teams[2].members, 0); assert.equal(state.teams[2].captainVoterId, null);
  assert.equal(state.teams[2].organizerCreated, true);
  assert.deepEqual(state.judges, judges);
  assert.deepEqual(state.voters.map(({ teamId, ...person }) => person), people.map(({ teamId, ...person }) => person));
  const before = clone(state);
  assert.deepEqual(imported(state), { added: 0, updated: 3 });
  assert.deepEqual(state, before, 'same import preserves team IDs and all credentials');
});
test('incremental updates retain team IDs and optional track and explicitly release removed members', () => {
  const state = fixture(); imported(state);
  const teamId = state.teams[0].id, credentials = state.voters.map(person => person.token);
  change(state, '/api/teams/import', { teams: [{ name: '示例甲队', project: '更新示例作品', memberPhones: [phone(1), phone(4)] }] });
  assert.equal(state.teams[0].id, teamId); assert.equal(state.teams[0].track, 'office');
  assert.equal(state.voters[1].teamId, null); assert.equal(state.voters[3].teamId, teamId);
  assert.equal(state.teams[0].captainVoterId, state.voters[0].id);
  assert.deepEqual(state.voters.map(person => person.token), credentials);
});
test('all rows are checked before committing, and invalid members, duplicated assignments and captains reject the whole batch', () => {
  const state = fixture();
  const valid = teams()[0];
  for (const invalid of [
    { name: '坏队', project: '', memberPhones: [phone(999)] },
    { name: '坏队', project: '', memberPhones: [phone(100)] },
    { name: '坏队', project: '', memberPhones: [phone(4), phone(4)] },
    { name: '坏队', project: '', memberPhones: [phone(1)] },
    { name: '坏队', project: '', memberPhones: [phone(4)], captainPhone: phone(999) },
    { name: '坏队', project: '', memberPhones: [phone(4)], track: 'invalid' },
    { name: '坏队', project: '', memberPhones: [phone(4)], token: 'not-allowed' },
    { name: '坏队', project: '', memberPhones: [4, 5] },
    { name: '坏队', project: '', memberPhones: [phone(4), phone(5), phone(6), phone(7), phone(8)] },
    { ...valid },
  ]) rejectUnchanged(state, [valid, invalid]);
  for (const list of [[], null, Array.from({ length: 101 }, (_, index) => ({ name: `虚构队${index}`, project: '', memberPhones: [] }))]) rejectUnchanged(state, list);
});
test('a separate registered captain is merged once into the member list and counts toward the four-person limit', () => {
  const state = fixture();
  change(state, '/api/teams/import', { teams: [{ name: '示例单列队长队', project: '', captainPhone: phone(1), memberPhones: [phone(2), phone(3)] }] });
  assert.equal(state.teams[0].members, 3);
  assert.equal(state.teams[0].captainVoterId, state.voters[0].id);
  rejectUnchanged(state, [{ name: '示例超员队', project: '', captainPhone: phone(4), memberPhones: [phone(5), phone(6), phone(7), phone(8)] }]);
  const before = clone(state);
  change(state, '/api/teams/import', { teams: [{ name: '示例单列队长队', project: '', captainPhone: phone(1), memberPhones: [phone(1), phone(2), phone(3)] }] });
  assert.deepEqual(state, before);
});
test('imports cannot silently move existing members from other teams and cannot change protected records', () => {
  const state = fixture(); imported(state);
  rejectUnchanged(state, [{ name: '别的示例队', project: '', memberPhones: [phone(1)] }], 409);
  change(state, '/api/phase', { phase: 'open' });
  change(state, '/api/score', { teamId: state.teams[0].id, scores: [8, 8, 8, 8] }, state.judges[0].token);
  change(state, '/api/vote', { allocations: { [state.teams[0].id]: 1 } }, state.voters[2].token);
  rejectUnchanged(state, teams(), 409);
});
test('team imports are administrator-only and setup-only', () => {
  const state = fixture();
  for (const token of ['', state.voters[0].token, state.judges[0].token]) {
    const before = clone(state);
    assert.throws(() => change(state, '/api/teams/import', { teams: teams() }, token));
    assert.deepEqual(state, before);
  }
  for (const phase of ['open', 'closed', 'published']) {
    const candidate = clone(state); candidate.event.phase = phase;
    rejectUnchanged(candidate, teams(), 409);
  }
});
test('imported teams appear to judges and retain strict v2/v3 backup compatibility', () => {
  for (const version of [2, 3]) {
    const state = fixture(); imported(state); if (version === 3) state.invitations = [];
    assert.deepEqual(validateRestore({ schemaVersion: version, state: clone(state) }), state);
    assert.equal(contextFor(state, 'judge', state.judges[0]).teams.length, 3);
    change(state, '/api/phase', { phase: 'open' });
    for (const team of state.teams) change(state, '/api/score', { teamId: team.id, scores: [8, 9, 7, 8] }, state.judges[0].token);
    assert.equal(calculateResults(state).tally.receivedScores, 3);
    assert.deepEqual(validateRestore({ schemaVersion: version, state: clone(state) }), state);
  }
});
test('HTTP import saves only validated batches and does not grant public access to roster changes', async t => {
  let state = fixture(), version = 0, commits = 0;
  const server = createServer({ adminToken: ADMIN, store: { read: async () => ({ state: clone(state), version }),
    compareAndSwap: async (expected, next) => { if (expected !== version) return false; state = clone(next); version++; commits++; return true; } } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}/event/api/teams/import`;
  const post = async (list, token) => {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ teams: list }) });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await post(teams())).status, 401); assert.equal(commits, 0);
  assert.equal((await post([...teams(), { name: '错误队', project: '', memberPhones: [phone(999)] }], ADMIN)).status, 400);
  assert.equal(commits, 0); assert.equal(state.teams.length, 0);
  assert.deepEqual(await post(teams(), ADMIN), { status: 200, body: { ok: true, added: 3, updated: 0 } });
  assert.equal(commits, 1); assert.equal(state.voters.length, 9);
});
