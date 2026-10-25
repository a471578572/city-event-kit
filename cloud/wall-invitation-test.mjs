import { legacyFreshState } from './test-fixtures.mjs';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { freshState, updateState, calculateResults, validateRestore, contextFor } from './business.mjs';
import { createServer } from './server.mjs';

// Only fictional records and temporary localhost services. No files, production data or cloud calls.
const ADMIN = 'TEST_ONLY_ADMIN_0123456789abcdef';
const ORIGIN = 'https://invitation-tests.example.invalid';
const BASE = '/event';
const copy = (value) => structuredClone(value);
const phone = (i) => `1990000${String(i).padStart(4, '0')}`;
const publicProfile = { background: '虚构背景', participation: '独立参加', directions: '自然教育', skills: '视觉设计', experience: '初次参赛' };
const fullProfile = { ...publicProfile, company: '不公开公司', position: '不公开职位', note: '不公开备注' };

function mutate(state, route, payload, token = ADMIN) { return updateState(state, route, payload, token, ADMIN); }
function person(state, i) { return state.voters.find((voter) => voter.phone === phone(i)); }
function token(state, i) { return person(state, i).token; }
function fixture() {
  const state = freshState();
  mutate(state, '/api/roster/import', { people: [
    ...Array.from({ length: 10 }, (_, i) => ({ name: `虚构选手${i + 1}`, phone: phone(i + 1), role: 'player', profile: copy(fullProfile) })),
    { name: '虚构观众', phone: phone(100), role: 'audience', profile: { note: '不公开观众资料' } },
  ] });
  mutate(state, '/api/roster/judges', { judges: [{ name: '虚构评委', phone: phone(900), bio: '不公开评委资料' }] });
  mutate(state, '/api/roster/settings', { teamsOpen: true, audienceEnabled: true });
  for (const item of [...state.voters, ...state.judges]) {
    mutate(state, '/api/login', { phone: item.phone, deviceKey: randomBytes(32).toString('hex') }, '');
  }
  return state;
}
function create(state, i) {
  mutate(state, '/api/teams/create', { name: `虚构队伍${i}`, project: `虚构作品${i}` }, token(state, i));
  return person(state, i).teamId;
}
function join(state, i, teamId) { return mutate(state, '/api/teams/join', { teamId }, token(state, i)); }
function leave(state, i) { return mutate(state, '/api/teams/leave', {}, token(state, i)); }
function send(state, from, to) {
  const result = mutate(state, '/api/invitations/send', { targetId: person(state, to).id }, token(state, from));
  assert.equal(typeof result?.invitationId, 'string');
  return result.invitationId;
}
function respond(state, i, invitationId, action) { return mutate(state, '/api/invitations/respond', { invitationId, action }, token(state, i)); }
function cancel(state, i, invitationId) { return mutate(state, '/api/invitations/cancel', { invitationId }, token(state, i)); }
function invitation(state, id) { return state.invitations.find((item) => item.id === id); }
function memberCount(state, teamId) { return state.voters.filter((item) => item.teamId === teamId).length; }
function rejectUnchanged(state, route, payload, credential = ADMIN) {
  const before = copy(state);
  assert.throws(() => mutate(state, route, payload, credential));
  assert.deepEqual(state, before, 'rejected operation must not partly change state');
}

test('player wall exposes only the five public profile fields to players and administrators', () => {
  const state = fixture(); create(state, 1);
  for (const [role, identity] of [['player', person(state, 2)], ['admin', null]]) {
    const cards = contextFor(state, role, identity).playerCards;
    assert.equal(cards.length, 10);
    for (const card of cards) {
      assert.deepEqual(Object.keys(card).sort(), ['id', 'name', 'profile', 'teamId']);
      assert.deepEqual(card.profile, publicProfile);
    }
    const json = JSON.stringify(cards);
    for (const forbidden of ['不公开公司', '不公开职位', '不公开备注', '虚构观众', '虚构评委']) assert.equal(json.includes(forbidden), false);
    for (const item of [...state.voters, ...state.judges]) {
      for (const secret of [item.phone, item.token, item.deviceHash]) if (secret) assert.equal(json.includes(secret), false);
    }
  }
  for (const [role, identity] of [['guest', null], ['audience', person(state, 100)], ['judge', state.judges[0]]]) {
    const context = contextFor(state, role, identity);
    assert.equal('playerCards' in context, false);
    assert.equal('invitations' in context, false);
  }
});

test('any teammate can invite and repeated team-target invitations return the original pending invitation', () => {
  const state = fixture(), teamId = create(state, 1);
  join(state, 2, teamId);
  const id = send(state, 2, 3);
  assert.equal(invitation(state, id).status, 'pending');
  assert.equal(invitation(state, id).fromId, person(state, 2).id);
  assert.equal(send(state, 2, 3), id);
  assert.equal(send(state, 1, 3), id);
  assert.equal(state.invitations.length, 1);
  assert.equal(person(state, 3).teamId, null);
});

test('sending rejects self, teamed targets, nonplayers, unteamed senders and full teams', () => {
  const state = fixture(), teamId = create(state, 1);
  join(state, 2, teamId);
  for (const [sender, target] of [[1, 1], [1, 2], [1, 100], [3, 4], [100, 4]]) {
    rejectUnchanged(state, '/api/invitations/send', { targetId: person(state, target).id }, token(state, sender));
  }
  rejectUnchanged(state, '/api/invitations/send', { targetId: 'missing-person' }, token(state, 1));
  rejectUnchanged(state, '/api/invitations/send', { targetId: person(state, 3).id }, ADMIN);
  rejectUnchanged(state, '/api/invitations/send', { targetId: person(state, 3).id }, state.judges[0].token);
  join(state, 3, teamId); join(state, 4, teamId);
  rejectUnchanged(state, '/api/invitations/send', { targetId: person(state, 5).id }, token(state, 1));
});

test('only the invited player can respond and declining never joins a team', () => {
  const state = fixture(); create(state, 1);
  const id = send(state, 1, 2);
  for (const sender of [1, 3, 100]) rejectUnchanged(state, '/api/invitations/respond', { invitationId: id, action: 'accept' }, token(state, sender));
  rejectUnchanged(state, '/api/invitations/respond', { invitationId: id, action: 'accept' }, ADMIN);
  rejectUnchanged(state, '/api/invitations/respond', { invitationId: id, action: 'other' }, token(state, 2));
  respond(state, 2, id, 'decline');
  respond(state, 2, id, 'decline');
  assert.equal(invitation(state, id).status, 'declined');
  assert.equal(person(state, 2).teamId, null);
  assert(invitation(state, id).respondedAt);
  rejectUnchanged(state, '/api/invitations/respond', { invitationId: id, action: 'accept' }, token(state, 2));
});

test('accept joins the invited team once and expires every competing invitation to the same player', () => {
  const state = fixture(), firstTeam = create(state, 1); create(state, 2);
  const accepted = send(state, 1, 3), other = send(state, 2, 3);
  const result = respond(state, 3, accepted, 'accept');
  assert.equal(result.invitationId, accepted);
  assert.equal(result.teamId, firstTeam);
  assert.equal(person(state, 3).teamId, firstTeam);
  assert.equal(invitation(state, accepted).status, 'accepted');
  assert.equal(invitation(state, other).status, 'expired');
  const repeated = respond(state, 3, accepted, 'accept');
  assert.equal(repeated.teamId, firstTeam);
  assert.equal(memberCount(state, firstTeam), 2);
  rejectUnchanged(state, '/api/invitations/respond', { invitationId: other, action: 'accept' }, token(state, 3));
});

test('only the sender or current captain can cancel; repeated cancellation is idempotent', () => {
  const state = fixture(), teamId = create(state, 1); join(state, 2, teamId); join(state, 3, teamId);
  const id = send(state, 3, 4);
  rejectUnchanged(state, '/api/invitations/cancel', { invitationId: id }, token(state, 2));
  rejectUnchanged(state, '/api/invitations/cancel', { invitationId: id }, token(state, 4));
  rejectUnchanged(state, '/api/invitations/cancel', { invitationId: id }, ADMIN);
  leave(state, 1);
  assert.equal(invitation(state, id).status, 'pending');
  rejectUnchanged(state, '/api/invitations/cancel', { invitationId: id }, token(state, 1));
  cancel(state, 2, id); cancel(state, 2, id);
  assert.equal(invitation(state, id).status, 'cancelled');
  assert.equal(person(state, 4).teamId, null);
  rejectUnchanged(state, '/api/invitations/respond', { invitationId: id, action: 'accept' }, token(state, 4));
  const own = send(state, 3, 5); cancel(state, 3, own);
  assert.equal(invitation(state, own).status, 'cancelled');
});

test('player invitation context includes only own received, own sent or current team sent records', () => {
  const state = fixture(), first = create(state, 1), second = create(state, 2);
  join(state, 3, first); join(state, 4, second);
  const a = send(state, 1, 5), b = send(state, 3, 6), c = send(state, 2, 5), d = send(state, 4, 7);
  const contextIds = (i) => contextFor(state, 'player', person(state, i)).invitations.map((item) => item.id).sort();
  assert.deepEqual(contextIds(1), [a, b].sort());
  assert.deepEqual(contextIds(3), [a, b].sort());
  assert.deepEqual(contextIds(5), [a, c].sort());
  assert.deepEqual(contextIds(7), [d]);
  assert.deepEqual(contextIds(8), []);
  for (const item of contextFor(state, 'player', person(state, 5)).invitations) {
    assert.deepEqual(Object.keys(item).sort(), ['id', 'fromId', 'fromName', 'toId', 'toName', 'teamId', 'teamName', 'status', 'createdAt', 'respondedAt', 'reason'].sort());
    assert.equal(typeof item.reason, 'string');
  }
  leave(state, 3);
  assert.deepEqual(contextIds(3), [b], 'former teammate may retain own sent history only');
});

test('invites expire when their sender leaves the original team, including deleted teams', () => {
  const state = fixture(), teamId = create(state, 1); join(state, 2, teamId);
  const first = send(state, 2, 3); leave(state, 2);
  assert.equal(invitation(state, first).status, 'expired');
  const second = send(state, 1, 4); leave(state, 1);
  assert.equal(state.teams.length, 0);
  assert.equal(invitation(state, second).status, 'expired');
  assert.deepEqual(validateRestore({ schemaVersion: 3, state: copy(state) }), state, 'deleted teams must not make historical backups unrestorable');
});

test('direct joining or creating a team expires incoming pending invitations', () => {
  const state = fixture(), first = create(state, 1), second = create(state, 2);
  const a = send(state, 1, 3), b = send(state, 2, 3), c = send(state, 1, 4);
  join(state, 3, second); create(state, 4);
  for (const id of [a, b, c]) assert.equal(invitation(state, id).status, 'expired');
  assert.equal(memberCount(state, first), 1);
});

test('filling the fourth slot expires remaining pending invitations for that team', () => {
  const state = fixture(), teamId = create(state, 1); join(state, 2, teamId); join(state, 3, teamId);
  const accepted = send(state, 1, 4), other = send(state, 2, 5);
  respond(state, 4, accepted, 'accept');
  assert.equal(memberCount(state, teamId), 4);
  assert.equal(invitation(state, accepted).status, 'accepted');
  assert.equal(invitation(state, other).status, 'expired');
  rejectUnchanged(state, '/api/invitations/respond', { invitationId: other, action: 'accept' }, token(state, 5));
});

test('temporarily closing team registration preserves invitations but blocks operations until reopened', () => {
  const state = fixture(); create(state, 1);
  const id = send(state, 1, 2);
  const cancelled = send(state, 1, 3);
  mutate(state, '/api/roster/settings', { teamsOpen: false });
  assert.equal(invitation(state, id).status, 'pending');
  rejectUnchanged(state, '/api/invitations/send', { targetId: person(state, 3).id }, token(state, 1));
  rejectUnchanged(state, '/api/invitations/respond', { invitationId: id, action: 'accept' }, token(state, 2));
  cancel(state, 1, cancelled);
  assert.equal(invitation(state, cancelled).status, 'cancelled');
  mutate(state, '/api/roster/settings', { teamsOpen: true });
  respond(state, 2, id, 'accept');
  assert.equal(invitation(state, id).status, 'accepted');
});

test('opening judging preserves pending invitations and invited members cannot vote for their own team', () => {
  const state = fixture(), first = create(state, 1), second = create(state, 2);
  const accepted = send(state, 1, 3), pending = send(state, 2, 4);
  respond(state, 3, accepted, 'accept');
  mutate(state, '/api/phase', { phase: 'open' });
  assert.equal(invitation(state, pending).status, 'pending');
  assert.equal(invitation(state, accepted).status, 'accepted');
  send(state, 1, 5);
  respond(state, 4, pending, 'accept');
  assert.equal(person(state, 4).teamId,second);
  rejectUnchanged(state, '/api/vote', { allocations: { [first]: 1 } }, token(state, 3));
  mutate(state, '/api/vote', { allocations: { [second]: 1 } }, token(state, 3));
  assert.equal(calculateResults(state).tally.totalVotes, 1);
});

test('schema 3 backups preserve pending, accepted, declined, cancelled and expired history', () => {
  const state = fixture(); create(state, 1); create(state, 2);
  const accepted = send(state, 1, 3); respond(state, 3, accepted, 'accept');
  const declined = send(state, 2, 4); respond(state, 4, declined, 'decline');
  const cancelled = send(state, 2, 5); cancel(state, 2, cancelled);
  send(state, 1, 6);
  const expired = send(state, 2, 7); create(state, 7);
  assert.equal(invitation(state, expired).status, 'expired');
  assert.deepEqual(new Set(state.invitations.map((item) => item.status)), new Set(['pending', 'accepted', 'declined', 'cancelled', 'expired']));
  assert.deepEqual(validateRestore({ schemaVersion: 3, state: copy(state) }), state);
});

test('legacy schema 1 and phone schema 2 backups remain supported before invitations exist', () => {
  const phoneState = fixture(); create(phoneState, 1);
  assert.equal('invitations' in phoneState, false);
  assert.deepEqual(validateRestore({ schemaVersion: 2, state: copy(phoneState) }), phoneState);
  const state = legacyFreshState();
  mutate(state, '/api/setup', { name: '虚构旧版比赛', teams: [{ name: '旧甲队', project: '', members: 1 }, { name: '旧乙队', project: '', members: 1 }],
    judges: [{ name: '旧版评委' }], audienceCount: 0, audienceEnabled: false, allowRepeat: false });
  assert.deepEqual(validateRestore({ schemaVersion: 1, state: copy(state) }), state);
});

test('schema 3 restore rejects invalid references, unknown statuses and duplicate invitation records', () => {
  const state = fixture(); create(state, 1); send(state, 1, 2);
  for (const damage of [
    (s) => { s.invitations[0].fromId = 'missing_person'; },
    (s) => { s.invitations[0].toId = 'missing_person'; },
    (s) => { s.invitations[0].teamId = 'missing_team'; },
    (s) => { s.invitations[0].toId = person(s, 100).id; },
    (s) => { s.invitations[0].status = 'unknown'; },
    (s) => { s.invitations.push(copy(s.invitations[0])); },
  ]) {
    const damaged = copy(state); damage(damaged);
    assert.throws(() => validateRestore({ schemaVersion: 3, state: damaged }));
  }
});

function memoryStore(initial) {
  let state = copy(initial), version = 0;
  return {
    async read() { const value = { state: copy(state), version }; await nextTurn(); return value; },
    async compareAndSwap(expected, replacement) { if (expected !== version) return false; state = copy(replacement); version += 1; return true; },
  };
}
async function withHttp(t, store, options = {}) {
  const server = createServer({ store, adminToken: ADMIN, publicOrigin: ORIGIN, basePath: BASE, ...options });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections?.(); await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); });
  const root = `http://127.0.0.1:${server.address().port}${BASE}`;
  return async (path, data, credential) => {
    const response = await fetch(root + path, { method: data === undefined ? 'GET' : 'POST',
      headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json', Origin: ORIGIN }), ...(credential === undefined ? {} : { Authorization: `Bearer ${credential}` }) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const raw = await response.text(); let body; try { body = JSON.parse(raw); } catch { body = raw; }
    return { status: response.status, body, raw };
  };
}

test('concurrent invitation acceptances for the last team slot retain exactly one member', async (t) => {
  const state = fixture(), teamId = create(state, 1); join(state, 2, teamId); join(state, 3, teamId);
  const invitations = [send(state, 1, 4), send(state, 2, 5)];
  const store = memoryStore(state), request = await withHttp(t, store);
  const responses = await Promise.all(invitations.map((invitationId, i) => request('/api/invitations/respond', { invitationId, action: 'accept' }, token(state, i + 4))));
  assert.equal(responses.filter((response) => response.status === 200).length, 1);
  assert.equal(responses.filter((response) => [400, 409].includes(response.status)).length, 1);
  const saved = (await store.read()).state;
  assert.equal(memberCount(saved, teamId), 4);
  assert.equal(saved.invitations.filter((item) => item.status === 'accepted').length, 1);
  assert.equal(saved.invitations.filter((item) => item.status === 'expired').length, 1);
});

test('concurrent duplicate acceptance adds one member and returns the same accepted invitation', async (t) => {
  const state = fixture(), teamId = create(state, 1), id = send(state, 1, 2);
  const store = memoryStore(state), request = await withHttp(t, store);
  const responses = await Promise.all(Array.from({ length: 6 }, () => request('/api/invitations/respond', { invitationId: id, action: 'accept' }, token(state, 2))));
  assert(responses.every((response) => response.status === 200 && response.body.invitationId === id && response.body.teamId === teamId));
  const saved = (await store.read()).state;
  assert.equal(memberCount(saved, teamId), 2);
  assert.equal(saved.invitations.length, 1);
});

test('HTTP wall remains private and invitation backups advertise schema 3', async (t) => {
  const state = fixture(); create(state, 1); send(state, 1, 2);
  const request = await withHttp(t, memoryStore(state));
  for (const credential of [undefined, token(state, 100), state.judges[0].token]) {
    const response = await request('/api/context', undefined, credential);
    assert.equal(response.status, 200);
    assert.equal('playerCards' in response.body, false);
    assert.equal('invitations' in response.body, false);
  }
  const player = await request('/api/context', undefined, token(state, 2));
  assert.equal(player.body.playerCards.length, 10);
  assert.equal(player.body.invitations.length, 1);
  const backup = await request('/api/backup', undefined, ADMIN);
  assert.equal(backup.status, 200);
  assert.equal(backup.body.schemaVersion, 3);
  assert.deepEqual(validateRestore(backup.body), state);
});

test('an unknown invite acceptance write outcome is not automatically retried or reported successful', async (t) => {
  const state = fixture(), teamId = create(state, 1), id = send(state, 1, 2);
  let saved = copy(state), writes = 0;
  const store = {
    async read() { return { state: copy(saved), version: 0 }; },
    async compareAndSwap(_version, replacement) { writes += 1; saved = copy(replacement); throw new Error('SIMULATED_UNKNOWN_INVITE_WRITE'); },
  };
  const request = await withHttp(t, store);
  const response = await request('/api/invitations/respond', { invitationId: id, action: 'accept' }, token(state, 2));
  assert.equal(response.status, 503, response.raw);
  assert.equal(writes, 1);
  assert.notEqual(response.body.ok, true);
  for (const key of ['invitationId', 'teamId', 'token']) assert.equal(key in response.body, false);
  assert.equal(response.raw.includes('SIMULATED_UNKNOWN_INVITE_WRITE'), false);
  assert.equal(person(saved, 2).teamId, teamId, 'test must simulate a potentially committed operation');
});

test('accepting competing team invitations concurrently assigns one player to exactly one team', async t => {
  const state = fixture(); create(state, 1); create(state, 2);
  const ids = [send(state, 1, 3), send(state, 2, 3)];
  const store = memoryStore(state), request = await withHttp(t, store);
  const replies = await Promise.all(ids.map(invitationId => request('/api/invitations/respond', { invitationId, action: 'accept' }, token(state, 3))));
  assert.equal(replies.filter(r => r.status === 200).length, 1);
  assert.equal(replies.filter(r => r.status === 409).length, 1);
  const saved = (await store.read()).state;
  assert.equal(saved.invitations.filter(i => i.status === 'accepted').length, 1);
  assert.equal(saved.invitations.filter(i => i.status === 'expired').length, 1);
  assert.equal(person(saved, 3).teamId, saved.invitations.find(i => i.status === 'accepted').teamId);
  assert.equal(saved.teams.reduce((sum, team) => sum + team.members, 0), 3);
});

test('v3 restore rejects duplicated pending pairs and hidden extra invitation fields', () => {
  const state = fixture(); create(state, 1); send(state, 1, 2);
  for (const change of [
    s => s.invitations.push({ ...s.invitations[0], id: 'invite_distinct_but_duplicate_pair' }),
    s => { s.invitations[0].token = 'MUST_NOT_SURVIVE_RESTORE'; },
    s => { s.invitations[0].respondedAt = new Date().toISOString(); },
    s => { s.invitations[0].createdAt = 'not-a-date'; },
  ]) {
    const damaged = copy(state); change(damaged);
    assert.throws(() => validateRestore({ schemaVersion: 3, state: damaged }));
  }
  mutate(state, '/api/roster/settings', { teamsOpen: false });
  assert.deepEqual(validateRestore({ schemaVersion: 3, state: copy(state) }), state);
});

test('demo is an explicit server startup label and cannot bypass permissions or change through HTTP', async t => {
  const state = fixture(), store = memoryStore(state);
  assert.throws(() => createServer({ store, adminToken: ADMIN, publicOrigin: ORIGIN, basePath: BASE, deploymentMode: 'unsafe' }));
  const demo = await withHttp(t, store, { deploymentMode: 'demo' });
  assert.equal((await demo('/api/context')).body.deploymentMode, 'demo');
  assert.equal((await demo('/api/admin')).status, 403);
  assert.equal((await demo('/api/deployment-mode', { deploymentMode: 'cloud' }, ADMIN)).status, 404);
  assert.equal((await demo('/api/context?deploymentMode=cloud')).body.deploymentMode, 'demo');
  const productionDefault = await withHttp(t, memoryStore(state));
  assert.equal((await productionDefault('/api/context?deploymentMode=demo')).body.deploymentMode, 'cloud');
});
