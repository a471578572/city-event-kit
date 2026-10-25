import { legacyFreshState } from './test-fixtures.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { freshState, updateState, contextFor, validateRestore, presentationOrderFor, calculateResults } from './business.mjs';

// Fictional, in-memory teams only; never imports live entrants or contacts production.
const ADMIN = 'ADMIN_TEAM_TEST_ONLY_0123456789abcdef';
const clone = value => structuredClone(value);
const change = (state, route, payload, token = ADMIN) => updateState(state, route, payload, token, ADMIN);
const add = (state, payload = {}, token = ADMIN) => change(state, '/api/teams/admin-create', {
  name: '虚构补录队伍', project: '虚构补录作品', track: 'short-drama', ...payload,
}, token);
function fixture() {
  const state = freshState();
  change(state, '/api/roster/import', { people: Array.from({ length: 5 }, (_, i) => ({
    name: `虚构选手${i + 1}`, phone: `1990000000${i + 1}`, role: 'player', profile: {},
  })) });
  change(state, '/api/roster/judges', { judges: [{ name: '虚构评委' }] });
  change(state, '/api/roster/settings', { teamsOpen: true, audienceEnabled: true });
  for (let i = 0; i < 3; i++) change(state, '/api/teams/create', {
    name: `虚构队伍${i + 1}`, project: `虚构作品${i + 1}`,
  }, state.voters[i].token);
  change(state, '/api/presentation-order', { requestId: 'admin_team_saved_draw', expectedRevision: 0 });
  return state;
}
function rejectsUnchanged(state, action, status) {
  const before = clone(state);
  assert.throws(action, error => !status || error.status === status);
  assert.deepEqual(state, before);
}

test('administrator can add a scoring-only team without manufacturing entrants or changing an existing draw', () => {
  const state = fixture(), before = clone(state);
  const { teamId } = add(state);
  assert.deepEqual(state.teams.at(-1), { id: teamId, name: '虚构补录队伍', project: '虚构补录作品',
    members: 0, captainVoterId: null, organizerCreated: true, track: 'short-drama' });
  const unchanged = clone(state); unchanged.teams.pop();
  assert.deepEqual(unchanged, before);
  assert.equal(presentationOrderFor(state).teams.length, before.teams.length);
  assert.deepEqual(presentationOrderFor(state).pendingTeams, [{ id: teamId, name: '虚构补录队伍', project: '虚构补录作品' }]);
  assert.deepEqual(state.presentationOrder, before.presentationOrder);
  const judgeTeam = contextFor(state, 'judge', state.judges[0]).teams.find(team => team.id === teamId);
  assert.equal(judgeTeam.track, 'short-drama');
  assert.equal(judgeTeam.members, 0);
  assert.equal(judgeTeam.locked, false);
  assert.equal(contextFor(state, 'guest', null).teams.find(team => team.id === teamId).track, 'short-drama');
  change(state, '/api/phase', { phase: 'open' });
  change(state, '/api/score', { teamId, scores: [8, 8, 9, 7] }, state.judges[0].token);
  assert.equal(calculateResults(state).jury.find(team => team.teamId === teamId).complete, true);
  assert.equal(state.voters.length, before.voters.length);
});

test('admin-create requires administrator, phone entry, setup or open phase, and valid track metadata', () => {
  const state = fixture();
  for (const token of ['', state.voters[0].token, state.judges[0].token]) {
    rejectsUnchanged(state, () => add(state, {}, token), token ? 403 : 401);
  }
  for (const phase of ['closed', 'published']) {
    const candidate = clone(state); candidate.event.phase = phase;
    rejectsUnchanged(candidate, () => add(candidate), 409);
  }
  const legacy = legacyFreshState();
  rejectsUnchanged(legacy, () => add(legacy), 409);
  for (const track of ['', 'film', 'unknown', null, 4, 'short-drama ']) rejectsUnchanged(state, () => add(state, { track }), 400);
  for (const track of ['dining', 'detective', 'office', 'short-drama', 'opc', 'game']) {
    const candidate = clone(state); add(candidate, { track });
    assert.equal(candidate.teams.at(-1).track, track);
  }
  const noTrack = clone(state);
  change(noTrack, '/api/teams/admin-create', { name: '虚构无赛道队伍', project: '虚构作品' });
  assert.equal(Object.hasOwn(noTrack.teams.at(-1), 'track'), false);
  const open = clone(state); change(open, '/api/phase', { phase: 'open' });
  change(open, '/api/roster/settings', { teamsOpen: false, audienceEnabled: true });
  assert.ok(add(open).teamId, 'staff may supplement a team while self-service teaming is paused');
});

test('exact duplicates are idempotent and conflicting names cannot silently replace a team or its project', () => {
  const state = fixture(), first = add(state), before = clone(state);
  assert.deepEqual(add(state), first);
  assert.deepEqual(state, before);
  rejectsUnchanged(state, () => add(state, { project: '不应覆盖的作品' }), 409);
  rejectsUnchanged(state, () => add(state, { track: 'game' }), 409);
  assert.deepEqual(change(state, '/api/teams/admin-create', { name: state.teams[0].name,
    project: state.teams[0].project }), { teamId: state.teams[0].id });
  const other = state.voters[3];
  change(state, '/api/teams/create', { name: '普通选手不能冒充补录', project: '', organizerCreated: true, members: 0 }, other.token);
  assert.equal(state.teams.at(-1).members, 1);
  assert.equal(Object.hasOwn(state.teams.at(-1), 'organizerCreated'), false);
});

test('ordinary team exits do not delete staff-created empty teams, and their own last member can leave them empty', () => {
  const state = fixture(), { teamId } = add(state), ordinaryId = state.teams[0].id;
  change(state, '/api/teams/leave', {}, state.voters[0].token);
  assert.equal(state.teams.some(team => team.id === ordinaryId), false);
  assert.equal(state.teams.find(team => team.id === teamId).members, 0);
  change(state, '/api/teams/join', { teamId }, state.voters[0].token);
  assert.equal(state.teams.find(team => team.id === teamId).captainVoterId, state.voters[0].id);
  change(state, '/api/teams/leave', {}, state.voters[0].token);
  assert.equal(state.teams.find(team => team.id === teamId).members, 0);
  assert.equal(state.teams.find(team => team.id === teamId).captainVoterId, null);
  change(state, '/api/roster/import', { people: [{ name: state.voters[3].name, phone: state.voters[3].phone, role: 'player', profile: {} }] });
  assert.equal(state.teams.find(team => team.id === teamId).members, 0, 'phone-mode roster maintenance keeps a legitimate staff-created empty team');
});

test('schema 2 and 3 round-trip optional team metadata and scores, while old backups gain no new fields', () => {
  for (const schemaVersion of [2, 3]) {
    const state = fixture(); if (schemaVersion === 3) state.invitations = [];
    assert.deepEqual(validateRestore({ schemaVersion, state: clone(state) }), state);
    const { teamId } = add(state);
    assert.deepEqual(validateRestore({ schemaVersion, state: clone(state) }), state);
    change(state, '/api/phase', { phase: 'open' });
    change(state, '/api/score', { teamId, scores: [9, 9, 9, 9] }, state.judges[0].token);
    assert.deepEqual(validateRestore({ schemaVersion, state: clone(state) }), state);
  }
});

test('restore accepts zero members only for explicitly staff-created teams with no captain and no invented member', () => {
  const state = fixture(); add(state);
  const invalid = [
    team => { delete team.organizerCreated; },
    team => { team.organizerCreated = false; },
    team => { team.organizerCreated = 'true'; },
    team => { team.captainVoterId = state.voters[0].id; },
    team => { delete team.captainVoterId; },
    team => { team.members = 1; },
    team => { team.track = 'film'; },
    team => { team.track = null; },
    team => { team.members = 5; },
    team => { team.privateNote = 'unexpected'; },
  ];
  for (const corrupt of invalid) {
    const candidate = clone(state); corrupt(candidate.teams.at(-1));
    assert.throws(() => validateRestore({ schemaVersion: 2, state: candidate }));
  }
  const ordinary = fixture(); ordinary.teams[0].members = 0; ordinary.teams[0].captainVoterId = null;
  assert.throws(() => validateRestore({ schemaVersion: 2, state: ordinary }));
});

test('staff supplements still enforce the one hundred team limit without changing existing records', () => {
  const state = fixture();
  while (state.teams.length < 100) add(state, { name: `虚构补录队伍${state.teams.length}` });
  rejectsUnchanged(state, () => add(state, { name: '虚构第101队' }), 409);
});
