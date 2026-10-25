import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { freshState, updateState, calculateResults, validateRestore, contextFor, roleOf, effectiveRecusals, exportCsv, publicGuideFor, judgeEntryKey } from './business.mjs';
import { createServer } from './server.mjs';

// Fictional people, in-memory state and localhost only; no event data or cloud calls.
const ADMIN = 'TEST_ONLY_DUAL_ROLE_ADMIN_0123456789';
const ORIGIN = 'https://dual-role-tests.example.invalid';
const BASE = '/event';
const AUTO_REASON = '本人作为选手参赛，本队自动回避';
const clone = value => structuredClone(value);
const phone = i => `1990000${String(i).padStart(4, '0')}`;
const device = () => randomBytes(32).toString('hex');
const mutate = (state, route, payload, credential = ADMIN) => updateState(state, route, payload, credential, ADMIN);
const player = (state, i = 1) => state.voters.find(person => person.phone === phone(i));
const judge = state => state.judges[0];
const rosterRow = (i, extras = {}) => ({ name: i === 1 ? '虚构双身份评委' : `虚构选手${i}`, phone: phone(i), role: 'player', ...extras });
function fixture(linked = true) {
  const state = freshState();
  mutate(state, '/api/roster/judges', { judges: [{ name: '虚构双身份评委', bio: '既有评委简介' }, { name: '虚构评委乙', phone: phone(900) }] });
  mutate(state, '/api/roster/import', { people: Array.from({ length: 6 }, (_, i) => rosterRow(i + 1,
    i === 0 && linked ? { linkedJudgeId: judge(state).id } : {})) });
  return state;
}
function createTeam(state, i = 1) {
  return mutate(state, '/api/teams/create', { name: `虚构队伍${i}`, project: `虚构作品${i}` }, player(state, i).token).teamId;
}
function rejectUnchanged(state, route, payload, credential = ADMIN, pattern) {
  const before = clone(state);
  assert.throws(() => mutate(state, route, payload, credential), pattern);
  assert.deepEqual(state, before, 'rejection must not partly mutate state');
}
const automatic = teamId => ({ teamId, reason: AUTO_REASON, automatic: true });

test('linking preserves the complete existing judge and existing player identity while ordinary updates retain the link', () => {
  const state = fixture(false), judgeDevice = device(), playerDevice = device();
  mutate(state, '/api/judges/login', { name: judge(state).name, entryKey: judgeEntryKey(ADMIN), deviceKey: judgeDevice }, '');
  mutate(state, '/api/login', { phone: phone(1), deviceKey: playerDevice }, '');
  const ownTeam = createTeam(state), judgesBefore = clone(state.judges), playerBefore = clone(player(state));
  const first = mutate(state, '/api/roster/import', { people: [rosterRow(1, { linkedJudgeId: judge(state).id, profile: { skills: '虚构设计技能' } })] });
  assert.deepEqual(first, { added: 0, updated: 1 });
  assert.deepEqual(state.judges, judgesBefore);
  assert.deepEqual(player(state), { ...playerBefore, profile: { skills: '虚构设计技能' }, linkedJudgeId: judge(state).id });
  mutate(state, '/api/roster/import', { people: [rosterRow(1, { profile: { experience: '第一次参赛' } })] });
  mutate(state, '/api/roster/import', { people: [rosterRow(1, { linkedJudgeId: judge(state).id })] });
  assert.deepEqual(state.judges, judgesBefore);
  assert.equal(player(state).linkedJudgeId, judge(state).id);
  for (const key of ['id', 'token', 'deviceHash', 'enteredAt', 'teamId', 'voteLimit']) assert.equal(player(state)[key], playerBefore[key]);
  assert.deepEqual(effectiveRecusals(state, judge(state)), [automatic(ownTeam)]);
  assert.equal(contextFor(state, 'player', player(state)).playerCards.filter(card => card.id === playerBefore.id).length, 1);
});

test('a new linked player adds one card without changing any existing judge field', () => {
  const state = freshState();
  mutate(state, '/api/roster/judges', { judges: [{ name: '虚构双身份评委' }] });
  mutate(state, '/api/judges/login', { name: judge(state).name, entryKey: judgeEntryKey(ADMIN), deviceKey: device() }, '');
  const before = clone(state.judges);
  const result = mutate(state, '/api/roster/import', { people: [rosterRow(1, { linkedJudgeId: judge(state).id })] });
  assert.deepEqual(result, { added: 1, updated: 0 });
  assert.deepEqual(state.judges, before);
  assert.equal(state.voters.length, 1);
  assert.equal(contextFor(state, 'admin', null).playerCards.length, 1);
  assert.equal(player(state).voteLimit, 3);
  assert.deepEqual(effectiveRecusals(state, judge(state)), []);
});

test('imports atomically reject invalid, nonplayer, duplicate and changed judge links', () => {
  const state = fixture();
  for (const linkedJudgeId of [null, undefined, '', 'missing_judge', ADMIN, 123, {}, ` ${judge(state).id}`]) {
    rejectUnchanged(state, '/api/roster/import', { people: [rosterRow(7), rosterRow(1, { linkedJudgeId })] });
  }
  rejectUnchanged(state, '/api/roster/import', { people: [rosterRow(7), rosterRow(1, { linkedJudgeId: state.judges[1].id })] });
  rejectUnchanged(state, '/api/roster/import', { people: [rosterRow(2, { linkedJudgeId: judge(state).id })] });
  rejectUnchanged(state, '/api/roster/import', { people: [rosterRow(7, { role: 'audience', linkedJudgeId: state.judges[1].id })] });
  rejectUnchanged(state, '/api/roster/import', { people: [rosterRow(7, { role: 'judge', linkedJudgeId: state.judges[1].id })] });
  rejectUnchanged(state, '/api/roster/import', { people: [rosterRow(7, { phone: phone(900), linkedJudgeId: state.judges[1].id })] });
  const unlinked = fixture(false);
  rejectUnchanged(unlinked, '/api/roster/import', { people: [
    rosterRow(1, { linkedJudgeId: judge(unlinked).id }), rosterRow(2, { linkedJudgeId: judge(unlinked).id }),
  ] });
});

test('both logins retain separate permissions and client-supplied links cannot grant judging or administration', () => {
  const state = fixture(), key = device();
  const participant = mutate(state, '/api/login', { phone: phone(1), deviceKey: key, role: 'judge', linkedJudgeId: state.judges[1].id }, '');
  const official = mutate(state, '/api/judges/login', { name: judge(state).name, entryKey: judgeEntryKey(ADMIN), deviceKey: key }, '');
  assert.notEqual(participant.token, official.token);
  assert.equal(roleOf(state, participant.token, ADMIN)[0], 'player');
  assert.equal(roleOf(state, official.token, ADMIN)[0], 'judge');
  assert.equal(player(state).linkedJudgeId, judge(state).id);
  assert.equal(mutate(state, '/api/login', { phone: phone(1), deviceKey: key }, '').token, participant.token);
  assert.equal(mutate(state, '/api/judges/login', { name: judge(state).name, entryKey: judgeEntryKey(ADMIN), deviceKey: key }, '').token, official.token);
  rejectUnchanged(state, '/api/roster/import', { people: [rosterRow(2, { linkedJudgeId: state.judges[1].id })] }, participant.token);
  rejectUnchanged(state, '/api/roster/import', { people: [rosterRow(2, { linkedJudgeId: state.judges[1].id })] }, official.token);
  rejectUnchanged(state, '/api/teams/create', { name: '不允许评委建队' }, official.token);
  const own = createTeam(state), other = createTeam(state, 2);
  mutate(state, '/api/phase', { phase: 'open' });
  rejectUnchanged(state, '/api/score', { teamId: other, scores: [8, 8, 8, 8] }, participant.token);
  rejectUnchanged(state, '/api/vote', { allocations: { [other]: 1 } }, official.token);
  rejectUnchanged(state, '/api/score', { teamId: own, scores: [10, 10, 10, 10] }, official.token, /回避/);
  mutate(state, '/api/score', { teamId: other, scores: [8, 8, 8, 8] }, official.token);
  assert.equal(state.scores.length, 1);
});

test('automatic recusal follows create, leave, join, switch and accepted invitation without writing manual records', () => {
  const state = fixture(), originalJudge = clone(judge(state));
  const own = createTeam(state), other = createTeam(state, 2);
  assert.deepEqual(effectiveRecusals(state, judge(state)), [automatic(own)]);
  mutate(state, '/api/teams/leave', {}, player(state).token);
  assert(!state.teams.some(team => team.id === own));
  assert.deepEqual(effectiveRecusals(state, judge(state)), []);
  mutate(state, '/api/teams/join', { teamId: other }, player(state).token);
  assert.deepEqual(effectiveRecusals(state, judge(state)), [automatic(other)]);
  mutate(state, '/api/teams/leave', {}, player(state).token);
  const invitation = mutate(state, '/api/invitations/send', { targetId: player(state).id }, player(state, 2).token);
  mutate(state, '/api/invitations/respond', { invitationId: invitation.invitationId, action: 'accept' }, player(state).token);
  assert.deepEqual(effectiveRecusals(state, judge(state)), [automatic(other)]);
  assert.deepEqual(contextFor(state, 'judge', judge(state)).judge.recusals, [automatic(other)]);
  assert.deepEqual(contextFor(state, 'admin', null).effectiveRecusals[judge(state).id], [automatic(other)]);
  assert.deepEqual(judge(state), originalJudge);
});

test('effective recusal deduplicates overlapping manual entries and never mutates the stored judge', () => {
  const state = fixture(), own = createTeam(state), other = createTeam(state, 2);
  judge(state).recusals = [{ teamId: own, reason: '历史手动原因' }, { teamId: other, reason: '另一个手动原因' }];
  const before = clone(judge(state));
  assert.deepEqual(effectiveRecusals(state, judge(state)), [automatic(own), { teamId: other, reason: '另一个手动原因' }]);
  rejectUnchanged(state, '/api/teams/leave', {}, player(state).token, /锁定/);
  assert.deepEqual(judge(state), before);
  // A pure-function input can still exercise an unteamed identity without
  // permitting live membership changes after a manual recusal.
  const unteamed = clone(state); player(unteamed).teamId = null;
  assert.deepEqual(effectiveRecusals(unteamed, judge(unteamed)), before.recusals);
  assert.deepEqual(judge(unteamed), before);
});

test('own team is excluded from means and missing scores, while manual recusal and all-recused publication protection remain active', () => {
  const state = fixture(), own = createTeam(state), other = createTeam(state, 2);
  mutate(state, '/api/phase', { phase: 'open' });
  assert.equal(calculateResults(state).tally.expectedScores, 3);
  assert.equal(calculateResults(state).missing.some(item => item.judgeId === judge(state).id && item.teamId === own), false);
  rejectUnchanged(state, '/api/recuse', { teamId: own, reason: '试图手动重复' }, judge(state).token, /回避/);
  mutate(state, '/api/score', { teamId: other, scores: [7, 7, 7, 7] }, judge(state).token);
  mutate(state, '/api/score', { teamId: own, scores: [9, 9, 9, 9] }, state.judges[1].token);
  mutate(state, '/api/score', { teamId: other, scores: [9, 9, 9, 9] }, state.judges[1].token);
  let result = calculateResults(state);
  assert.equal(result.jury.find(row => row.teamId === own).score, 9);
  assert.equal(result.jury.find(row => row.teamId === other).score, 8);
  assert.deepEqual([result.tally.expectedScores, result.tally.receivedScores, result.tally.judgesDone, result.missing.length, result.ready], [3, 3, 2, 0, true]);
  const staleScore = clone(state);
  staleScore.scores.push({ judgeId: judge(state).id, teamId: own, scores: [0, 0, 0, 0], weightedScore: 0, updatedAt: new Date().toISOString() });
  assert.deepEqual(calculateResults(staleScore), result);
  mutate(state, '/api/recuse', { teamId: own, reason: '另一位评委存在关联' }, state.judges[1].token);
  result = calculateResults(state);
  const excluded = result.jury.find(row => row.teamId === own);
  assert.deepEqual([excluded.expected, excluded.received, excluded.score, excluded.complete, result.ready], [0, 0, null, false, false]);
  mutate(state, '/api/phase', { phase: 'closed' });
  rejectUnchanged(state, '/api/phase', { phase: 'published' }, ADMIN, /全部评委/);
  assert(exportCsv(state).includes(AUTO_REASON));
  assert.deepEqual(judge(state).recusals, []);
});

test('the linked participant keeps three votes, cannot vote for own team and cannot use the judge credential to vote', () => {
  const state = fixture(), teams = Array.from({ length: 5 }, (_, i) => createTeam(state, i + 1));
  mutate(state, '/api/phase', { phase: 'open' });
  rejectUnchanged(state, '/api/vote', { allocations: { [teams[0]]: 1 } }, player(state).token, /本队/);
  rejectUnchanged(state, '/api/vote', { allocations: Object.fromEntries(teams.slice(1).map(id => [id, 1])) }, player(state).token);
  rejectUnchanged(state, '/api/vote', { allocations: { [teams[1]]: 2 } }, player(state).token);
  const allocations = Object.fromEntries(teams.slice(1, 4).map(id => [id, 1]));
  mutate(state, '/api/vote', { allocations }, player(state).token);
  mutate(state, '/api/vote', { allocations }, player(state).token);
  assert.equal(state.ballots.length, 1);
  assert.equal(calculateResults(state).tally.totalVotes, 3);
  assert.equal(contextFor(state, 'player', player(state)).identity.voteLimit, 3);
  rejectUnchanged(state, '/api/vote', { allocations }, judge(state).token);
});

test('public wall and guide omit private identity links and credentials', () => {
  const state = fixture(); createTeam(state);
  for (const role of ['player', 'admin']) {
    const cards = contextFor(state, role, role === 'player' ? player(state) : null).playerCards;
    assert.equal(cards.filter(card => card.name === judge(state).name).length, 1);
    for (const card of cards) assert.deepEqual(Object.keys(card).sort(), ['id', 'name', 'profile', 'teamId']);
    assert(!JSON.stringify(cards).includes('linkedJudgeId'));
    assert(!JSON.stringify(cards).includes(judge(state).id));
  }
  for (const context of [contextFor(state, 'guest', null), publicGuideFor(state), contextFor(state, 'player', player(state))]) {
    const json = JSON.stringify(context);
    for (const secret of ['linkedJudgeId', judge(state).id, judge(state).token, player(state).token, player(state).phone]) assert(!json.includes(secret));
  }
});

test('v2 and v3 backups roundtrip automatic recusals across setup, open, closed and published phases', () => {
  for (const schemaVersion of [2, 3]) {
    const state = fixture();
    const assertRestored = () => {
      const restored = validateRestore({ schemaVersion, state: clone(state) });
      assert.deepEqual(restored, state);
      assert.deepEqual(calculateResults(restored), calculateResults(state));
      assert.deepEqual(effectiveRecusals(restored, judge(restored)), effectiveRecusals(state, judge(state)));
      assert(!JSON.stringify(state).includes(AUTO_REASON));
    };
    if (schemaVersion === 3) state.invitations = [];
    assertRestored();
    createTeam(state); assertRestored();
    const others = [2, 3, 4].map(i => createTeam(state, i));
    if (schemaVersion === 3) {
      const invitation = mutate(state, '/api/invitations/send', { targetId: player(state, 5).id }, player(state).token);
      mutate(state, '/api/invitations/respond', { invitationId: invitation.invitationId, action: 'accept' }, player(state, 5).token);
    }
    assertRestored();
    mutate(state, '/api/phase', { phase: 'open' });
    mutate(state, '/api/recuse', { teamId: others[2], reason: '真实手动回避测试' }, judge(state).token);
    state.teams.forEach((team, index) => state.judges.forEach(person => {
      if (!effectiveRecusals(state, person).some(recusal => recusal.teamId === team.id)) {
        mutate(state, '/api/score', { teamId: team.id, scores: Array(4).fill(9 - index) }, person.token);
      }
    }));
    mutate(state, '/api/vote', { allocations: Object.fromEntries(others.map(id => [id, 1])) }, player(state).token);
    assertRestored();
    mutate(state, '/api/phase', { phase: 'closed' }); assertRestored();
    mutate(state, '/api/phase', { phase: 'published' }); assertRestored();
    assert.deepEqual(judge(state).recusals, [{ teamId: others[2], reason: '真实手动回避测试' }]);
  }
});

test('restore rejects forged links, duplicated judge associations, wrong roles, unknown permissions and own-team scores', () => {
  const state = fixture(), own = createTeam(state); createTeam(state, 2);
  mutate(state, '/api/phase', { phase: 'open' });
  const damages = [
    data => { player(data).linkedJudgeId = 'missing_judge'; },
    data => { player(data).linkedJudgeId = player(data, 2).id; },
    data => { player(data).linkedJudgeId = null; },
    data => { player(data, 2).linkedJudgeId = judge(data).id; },
    data => { player(data, 3).role = 'audience'; player(data, 3).voteLimit = 2; player(data, 3).linkedJudgeId = data.judges[1].id; },
    data => { player(data).permissions = ['admin']; },
    data => { player(data).role = 'judge'; },
    data => { judge(data).phone = player(data).phone; },
    data => { data.scores.push({ judgeId: judge(data).id, teamId: own, scores: [9, 9, 9, 9], weightedScore: 9, updatedAt: new Date().toISOString() }); },
  ];
  for (const schemaVersion of [2, 3]) for (const damage of damages) {
    const damaged = clone(state);
    if (schemaVersion === 3) damaged.invitations = [];
    damage(damaged);
    assert.throws(() => validateRestore({ schemaVersion, state: damaged }));
  }
  const downgraded = clone(state); delete downgraded.event.entryMode; delete downgraded.event.teamsOpen;
  assert.throws(() => validateRestore({ schemaVersion: 1, state: downgraded }), /降级/);
});

function memoryStore(initial) {
  let state = clone(initial), version = 0;
  return {
    async read() { const result = { state: clone(state), version }; await nextTurn(); return result; },
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
  const root = `http://127.0.0.1:${server.address().port}${BASE}`;
  return async (path, data, credential) => {
    const response = await fetch(root + path, { method: data === undefined ? 'GET' : 'POST',
      headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json', Origin: ORIGIN }), ...(credential ? { Authorization: `Bearer ${credential}` } : {}) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const raw = await response.text();
    let body; try { body = JSON.parse(raw); } catch { body = raw; }
    return { status: response.status, body };
  };
}

test('HTTP provides derived admin/judge views, raw private backup, both logins and enforced own-team exclusion', async t => {
  const initial = fixture(), own = createTeam(initial), other = createTeam(initial, 2), store = memoryStore(initial);
  const request = await withHttp(t, store), key = device();
  const participant = await request('/api/login', { phone: phone(1), deviceKey: key });
  const official = await request('/api/judges/login', { name: judge(initial).name, entryKey: judgeEntryKey(ADMIN), deviceKey: key });
  assert.equal(participant.status, 200); assert.equal(official.status, 200);
  const admin = await request('/api/admin', undefined, ADMIN), context = await request('/api/context', undefined, official.body.token);
  assert.deepEqual(admin.body.effectiveRecusals[judge(initial).id], [automatic(own)]);
  assert.deepEqual(admin.body.judges[0].recusals, []);
  assert.deepEqual(context.body.judge.recusals, [automatic(own)]);
  assert.equal(admin.body.playerCards.filter(card => card.id === player(initial).id).length, 1);
  const backup = await request('/api/backup', undefined, ADMIN);
  assert.equal(backup.body.state.voters[0].linkedJudgeId, judge(initial).id);
  assert.equal(backup.body.schemaVersion, 2);
  assert(!JSON.stringify(backup.body).includes(AUTO_REASON));
  assert.equal((await request('/api/admin', undefined, participant.body.token)).status, 403);
  assert.equal((await request('/api/phase', { phase: 'open' }, ADMIN)).status, 200);
  assert.equal((await request('/api/score', { teamId: own, scores: [10, 10, 10, 10] }, official.body.token)).status, 409);
  assert.equal((await request('/api/score', { teamId: other, scores: [8, 8, 8, 8] }, official.body.token)).status, 200);
  assert.equal((await request('/api/score', { teamId: other, scores: [8, 8, 8, 8] }, participant.body.token)).status, 403);
  const stored = (await store.read()).state;
  assert.equal(stored.scores.length, 1);
  assert.equal(stored.scores[0].teamId, other);
});

test('concurrent admin imports can link a judge to only one player', async t => {
  const initial = fixture(false), store = memoryStore(initial), request = await withHttp(t, store);
  const replies = await Promise.all([1, 2].map(i => request('/api/roster/import', { people: [rosterRow(i, { linkedJudgeId: judge(initial).id })] }, ADMIN)));
  assert.deepEqual(replies.map(reply => reply.status).sort(), [200, 409]);
  const stored = (await store.read()).state;
  assert.equal(stored.voters.filter(person => person.linkedJudgeId === judge(initial).id).length, 1);
  assert.deepEqual(stored.judges, initial.judges);
});
