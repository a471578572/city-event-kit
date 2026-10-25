import assert from 'node:assert/strict';
import test from 'node:test';
import { freshState, buildSetup, updateState, contextFor, validateRestore, calculateResults } from './business.mjs';

// Fictional in-memory identities only. This suite never reads event data or calls production.
const ADMIN = 'LIVE_TEAM_TEST_ADMIN_0123456789abcdef';
const copy = value => structuredClone(value);
function change(state, route, payload, token = ADMIN) { return updateState(state, route, payload, token, ADMIN); }
function fixture({ judges = true } = {}) {
  const state = freshState();
  change(state, '/api/roster/import', { people: Array.from({ length: 10 }, (_, i) => ({
    name: `虚构选手${i + 1}`, phone: `1990000${String(i + 1).padStart(4, '0')}`, role: 'player', profile: {},
  })) });
  if (judges) change(state, '/api/roster/judges', { judges: [{ name: '虚构评委' }] });
  change(state, '/api/roster/settings', { teamsOpen: true, audienceEnabled: true });
  return state;
}
const player = (state, index) => state.voters[index - 1];
const credential = (state, index) => player(state, index).token;
function create(state, index) {
  return change(state, '/api/teams/create', { name: `虚构队伍${index}`, project: `虚构作品${index}` }, credential(state, index)).teamId;
}
const join = (state, index, teamId) => change(state, '/api/teams/join', { teamId }, credential(state, index));
const leave = (state, index) => change(state, '/api/teams/leave', {}, credential(state, index));
const send = (state, from, to) => change(state, '/api/invitations/send', { targetId: player(state, to).id }, credential(state, from)).invitationId;
const respond = (state, index, invitationId, action) => change(state, '/api/invitations/respond', { invitationId, action }, credential(state, index));
const score = (state, teamId, values = [8, 9, 8, 9]) => change(state, '/api/score', { teamId, scores: values }, state.judges[0].token);
function rejected(state, route, payload, token = ADMIN) {
  const before = copy(state);
  assert.throws(() => change(state, route, payload, token));
  assert.deepEqual(state, before, 'a rejected change must preserve all records');
}
function backup(state) { return { schemaVersion: state.invitations ? 3 : 2, state: copy(state) }; }

test('phone judging opens with no teams, and live teams immediately appear to the judge', () => {
  const state = fixture();
  const credentials = state.voters.map(person => person.token);
  change(state, '/api/phase', { phase: 'open' });
  assert.equal(state.event.teamsOpen, true);
  assert.deepEqual(contextFor(state, 'judge', state.judges[0]).teams, []);
  const teamId = create(state, 1), invitationId = send(state, 1, 2);
  respond(state, 2, invitationId, 'accept');
  const judgeTeam = contextFor(state, 'judge', state.judges[0]).teams[0];
  assert.deepEqual([judgeTeam.id, judgeTeam.name, judgeTeam.members, judgeTeam.locked], [teamId, '虚构队伍1', 2, false]);
  score(state, teamId);
  const laterTeam = create(state, 3);
  const teams = contextFor(state, 'judge', state.judges[0]).teams;
  assert.deepEqual(teams.map(team => [team.id, team.locked]), [[teamId, true], [laterTeam, false]]);
  assert.equal(calculateResults(state).ready, false, 'a new team creates a new required score');
  assert.deepEqual(state.voters.map(person => person.token), credentials);
  assert.equal(state.teams.some(team => Object.hasOwn(team, 'locked')), false, 'locking is projected, not stored');
  assert.deepEqual(validateRestore(backup(state)), state);
});

test('scoring freezes team identity and membership while same-value retries remain valid', () => {
  const state = fixture(), teamId = create(state, 1);
  join(state, 2, teamId);
  const accepted = send(state, 1, 3); respond(state, 3, accepted, 'accept');
  const pending = send(state, 1, 4);
  change(state, '/api/phase', { phase: 'open' });
  score(state, teamId);
  assert.equal(state.invitations.find(invitation => invitation.id === pending).status, 'expired');
  rejected(state, '/api/teams/join', { teamId }, credential(state, 4));
  rejected(state, '/api/teams/leave', {}, credential(state, 1));
  rejected(state, '/api/teams/leave', {}, credential(state, 2));
  rejected(state, '/api/teams/update', { name: '改名', project: '虚构作品1' }, credential(state, 1));
  rejected(state, '/api/teams/update', { name: '虚构队伍1', project: '改作品' }, credential(state, 1));
  rejected(state, '/api/invitations/send', { targetId: player(state, 4).id }, credential(state, 1));
  rejected(state, '/api/invitations/respond', { invitationId: pending, action: 'accept' }, credential(state, 4));
  assert.equal(join(state, 2, teamId).teamId, teamId);
  assert.equal(create(state, 1), teamId);
  assert.equal(change(state, '/api/teams/update', { name: '虚构队伍1', project: '虚构作品1' }, credential(state, 1)).teamId, teamId);
  assert.equal(respond(state, 3, accepted, 'accept').teamId, teamId);
});

test('manual recusal and received positive votes also freeze teams, but zero votes do not', () => {
  const state = fixture(), recused = create(state, 1), voted = create(state, 2), untouched = create(state, 3);
  change(state, '/api/phase', { phase: 'open' });
  change(state, '/api/recuse', { teamId: recused, reason: '虚构利益关系' }, state.judges[0].token);
  change(state, '/api/vote', { allocations: { [voted]: 1, [untouched]: 0 } }, credential(state, 1));
  const teams = contextFor(state, 'player', player(state, 4)).teams;
  assert.deepEqual(teams.map(team => team.locked), [true, true, false]);
  rejected(state, '/api/teams/join', { teamId: recused }, credential(state, 4));
  rejected(state, '/api/teams/join', { teamId: voted }, credential(state, 4));
  assert.equal(join(state, 4, untouched).teamId, untouched);
  assert.deepEqual(validateRestore(backup(state)), state);
});

test('a linked judge player has automatic self-recusal without prematurely freezing their team', () => {
  const state = fixture();
  change(state, '/api/roster/import', { people: [{ name: player(state, 1).name, phone: player(state, 1).phone,
    role: 'player', profile: {}, linkedJudgeId: state.judges[0].id }] });
  const teamId = create(state, 1);
  change(state, '/api/phase', { phase: 'open' });
  const judge = contextFor(state, 'judge', state.judges[0]);
  assert.equal(judge.judge.recusals[0].automatic, true);
  assert.equal(judge.teams[0].locked, false);
  assert.equal(join(state, 2, teamId).teamId, teamId);
  assert.deepEqual(validateRestore(backup(state)), state);
});

test('a player who has voted cannot move teams even when their own team has no received results', () => {
  const state = fixture(), own = create(state, 1), other = create(state, 2);
  change(state, '/api/phase', { phase: 'open' });
  change(state, '/api/vote', { allocations: { [other]: 1 } }, credential(state, 1));
  assert.equal(contextFor(state, 'player', player(state, 1)).teams.find(team => team.id === own).locked, false);
  rejected(state, '/api/teams/leave', {}, credential(state, 1));
  rejected(state, '/api/teams/create', { name: '换队' }, credential(state, 1));
  rejected(state, '/api/teams/join', { teamId: other }, credential(state, 1));
  assert.equal(join(state, 1, own).teamId, own);
  assert.deepEqual(validateRestore(backup(state)), state);
});

test('defensive ballot checks reject creating, joining and accepting for an unteamed ballot holder', () => {
  const state = fixture(), teamId = create(state, 1), invitationId = send(state, 1, 2);
  change(state, '/api/phase', { phase: 'open' });
  // This cannot arise through live voting, but historical/inconsistent callers must not bypass the guard.
  state.ballots.push({ voterId: player(state, 2).id, allocations: {}, submittedAt: new Date().toISOString() });
  rejected(state, '/api/teams/create', { name: '不得建立的新队' }, credential(state, 2));
  rejected(state, '/api/teams/join', { teamId }, credential(state, 2));
  rejected(state, '/api/invitations/respond', { invitationId, action: 'accept' }, credential(state, 2));
  assert.equal(contextFor(state, 'player', player(state, 2)).invitations[0].status, 'expired');
});

test('pausing teaming preserves invitations and lets recipients decline and senders cancel', () => {
  const state = fixture(); create(state, 1);
  const acceptedLater = send(state, 1, 2), declined = send(state, 1, 3), cancelled = send(state, 1, 4);
  change(state, '/api/phase', { phase: 'open' });
  change(state, '/api/roster/settings', { teamsOpen: false, audienceEnabled: false });
  assert(state.invitations.every(invitation => invitation.status === 'pending'));
  assert.equal(contextFor(state, 'player', player(state, 2)).invitations[0].status, 'pending');
  rejected(state, '/api/invitations/respond', { invitationId: acceptedLater, action: 'accept' }, credential(state, 2));
  rejected(state, '/api/invitations/send', { targetId: player(state, 5).id }, credential(state, 1));
  rejected(state, '/api/teams/create', { name: '暂停期间的新队' }, credential(state, 5));
  respond(state, 3, declined, 'decline');
  change(state, '/api/invitations/cancel', { invitationId: cancelled }, credential(state, 1));
  change(state, '/api/roster/settings', { teamsOpen: true, audienceEnabled: true });
  respond(state, 2, acceptedLater, 'accept');
  assert.deepEqual(validateRestore(backup(state)), state);
});

test('closing disables teaming and expires pending invitations; reopening requires an explicit teaming switch', () => {
  const state = fixture(); create(state, 1);
  const pending = send(state, 1, 2);
  change(state, '/api/phase', { phase: 'open' });
  change(state, '/api/phase', { phase: 'closed' });
  assert.equal(state.event.teamsOpen, false);
  assert.equal(state.invitations.find(invitation => invitation.id === pending).status, 'expired');
  rejected(state, '/api/roster/settings', { teamsOpen: true });
  rejected(state, '/api/teams/create', { name: '关闭期间的新队' }, credential(state, 3));
  assert.deepEqual(validateRestore(backup(state)), state);
  change(state, '/api/phase', { phase: 'open' });
  assert.equal(state.event.teamsOpen, false);
  change(state, '/api/roster/settings', { teamsOpen: true });
  assert.equal(typeof create(state, 3), 'string');
});

test('phone restore supports zero-team open and closed states, but never closed/published open teaming', () => {
  const state = fixture();
  change(state, '/api/phase', { phase: 'open' });
  assert.deepEqual(validateRestore(backup(state)), state);
  change(state, '/api/phase', { phase: 'closed' });
  assert.deepEqual(validateRestore(backup(state)), state);
  rejected(state, '/api/phase', { phase: 'published' });
  for (const phase of ['closed', 'published']) {
    const invalid = backup(state); invalid.state.event.phase = phase; invalid.state.event.teamsOpen = true;
    assert.throws(() => validateRestore(invalid));
  }
  const withoutJudge = fixture({ judges: false });
  rejected(withoutJudge, '/api/phase', { phase: 'open' });
  withoutJudge.event.phase = 'open';
  assert.throws(() => validateRestore(backup(withoutJudge)));
});

test('live settings cannot edit the roster, and publishing still requires complete scoring', () => {
  const state = fixture(); change(state, '/api/phase', { phase: 'open' });
  rejected(state, '/api/roster/import', { people: [{ name: '不得补录', phone: '19900009999', role: 'player' }] });
  rejected(state, '/api/roster/judges', { judges: [{ name: '不得增加的评委' }] });
  const teamId = create(state, 1);
  change(state, '/api/phase', { phase: 'closed' });
  rejected(state, '/api/phase', { phase: 'published' });
  change(state, '/api/phase', { phase: 'open' }); score(state, teamId);
  change(state, '/api/phase', { phase: 'closed' });
  change(state, '/api/phase', { phase: 'published' });
  assert.equal(state.event.teamsOpen, false);
  assert.equal(calculateResults(state).ready, true);
  assert.deepEqual(validateRestore(backup(state)), state);
});

test('legacy setup and restore retain the existing two-team minimum and do not gain derived locks', () => {
  const state = buildSetup({ name: '虚构旧版比赛', teams: [{ name: '旧队甲', members: 1 }, { name: '旧队乙', members: 1 }],
    judges: [{ name: '旧版评委' }], audienceEnabled: false, allowRepeat: false, audienceCount: 0 });
  const invalid = copy(state); invalid.teams.pop(); invalid.voters.pop();
  rejected(invalid, '/api/phase', { phase: 'open' });
  assert.throws(() => validateRestore({ schemaVersion: 1, state: invalid }));
  change(state, '/api/phase', { phase: 'open' });
  assert.equal(Object.hasOwn(contextFor(state, 'judge', state.judges[0]).teams[0], 'locked'), false);
  assert.deepEqual(validateRestore({ schemaVersion: 1, state: copy(state) }), state);
});
