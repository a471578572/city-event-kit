import { legacyFreshState } from './test-fixtures.mjs';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { freshState, updateState, calculateResults, validateRestore, contextFor, roleOf } from './business.mjs';
import { createServer } from './server.mjs';

// All identities are fictional. This suite never reads event files or contacts a cloud service.
const ADMIN = 'TEST_ONLY_ADMIN_0123456789abcdef';
const ORIGIN = 'https://phone-tests.example.invalid';
const BASE = '/event';
const copy = (value) => structuredClone(value);
const device = () => randomBytes(32).toString('hex');
const phone = (i) => `1990000${String(i).padStart(4, '0')}`;
const profile = {
  company: '虚构公司', position: '设计师', background: '文化创意', participation: '独立参加',
  directions: '自然教育', skills: '视觉设计', experience: '首次参赛', note: '测试备注',
};

function mutate(state, route, payload, token = ADMIN) {
  return updateState(state, route, payload, token, ADMIN);
}

function makeRoster(count = 7) {
  return [
    ...Array.from({ length: count }, (_, i) => ({ name: `虚构选手${i + 1}`, phone: phone(i + 1), role: 'player', profile: copy(profile) })),
    { name: '虚构观众', phone: phone(100), role: 'audience', profile: { note: '观众测试' } },
  ];
}

function fixture(count = 7) {
  const state = freshState();
  const people = makeRoster(count);
  mutate(state, '/api/roster/import', { people });
  mutate(state, '/api/roster/judges', { judges: [{ name: '虚构评委', phone: phone(900), bio: '仅供测试的评委简介' }] });
  mutate(state, '/api/roster/settings', { teamsOpen: true, audienceEnabled: true });
  return { state, people };
}

function person(state, i) { return state.voters.find((voter) => voter.phone === phone(i)); }
function login(state, i, key = device()) {
  const result = mutate(state, '/api/login', { phone: phone(i), deviceKey: key }, '');
  assert.equal(typeof result?.token, 'string');
  return { token: result.token, deviceKey: key };
}
function createTeam(state, index, name = `虚构队伍${index}`) {
  const identity = login(state, index);
  mutate(state, '/api/teams/create', { name, project: `虚构作品${index}` }, identity.token);
  return { ...identity, teamId: person(state, index).teamId };
}
function join(state, index, teamId) {
  const identity = login(state, index);
  mutate(state, '/api/teams/join', { teamId }, identity.token);
  return identity;
}
function members(state, teamId) { return state.voters.filter((voter) => voter.role === 'player' && voter.teamId === teamId); }
function rejectUnchanged(state, route, payload, token = ADMIN) {
  const before = copy(state);
  assert.throws(() => mutate(state, route, payload, token));
  assert.deepEqual(state, before, 'rejected operation must not partially alter state');
}

test('roster import creates phone identities with the correct role and voting limits', () => {
  const state = freshState();
  const people = makeRoster(2);
  const result = mutate(state, '/api/roster/import', { people });
  assert.equal(result.added, 3);
  assert.equal(result.updated, 0);
  assert.equal(state.event.entryMode, 'phone');
  assert.equal(state.teams.length, 0);
  assert.equal(person(state, 1).voteLimit, 3);
  assert.equal(person(state, 100).voteLimit, 2);
  assert.equal(person(state, 1).teamId, null);
  assert.deepEqual(person(state, 1).profile, profile);
  assert.equal(new Set(state.voters.map((voter) => voter.token)).size, 3);
});

test('incremental import preserves identity, token, device binding and team membership', () => {
  const { state } = fixture();
  createTeam(state, 1);
  const before = copy(person(state, 1));
  const result = mutate(state, '/api/roster/import', { people: [
    { name: '虚构选手更新名字', phone: phone(1), role: 'player', profile: { ...profile, position: '开发者' } },
    { name: '虚构补录选手', phone: phone(200), role: 'player', profile: {} },
  ] });
  assert.deepEqual([result.added, result.updated], [1, 1]);
  const after = person(state, 1);
  for (const key of ['id', 'token', 'deviceHash', 'teamId']) assert.equal(after[key], before[key], key);
  assert.equal(after.name, '虚构选手更新名字');
  assert.equal(after.profile.position, '开发者');
  assert.equal(state.voters.filter((voter) => voter.phone === phone(1)).length, 1);
});

test('import rejects invalid phones, duplicate conflicts and participant/judge phone collisions', () => {
  const { state } = fixture();
  for (const invalid of ['', '123', '199000000001', 'not-a-phone', null, true, 19900000001]) {
    rejectUnchanged(state, '/api/roster/import', { people: [{ name: '无效测试', phone: invalid, role: 'player' }] });
  }
  rejectUnchanged(state, '/api/roster/import', { people: [
    { name: '新选手甲', phone: phone(201), role: 'player' },
    { name: '新选手乙', phone: phone(201), role: 'audience' },
  ] });
  rejectUnchanged(state, '/api/roster/import', { people: [{ name: '冲突评委手机', phone: phone(900), role: 'player' }] });
  rejectUnchanged(state, '/api/roster/judges', { judges: [{ name: '手机冲突评委', phone: phone(1) }] });
  rejectUnchanged(state, '/api/roster/import', { people: [{ name: '身份冲突', phone: phone(1), role: 'audience' }] });
});

test('only allowlisted profile fields are retained and roster administration cannot be impersonated', () => {
  const { state } = fixture();
  const before = copy(state);
  try {
    mutate(state, '/api/roster/import', { people: [{ name: '虚构选手1', phone: phone(1), role: 'player', profile: {
      ...profile, token: 'ATTACKER_TOKEN', deviceHash: 'ATTACKER_DEVICE', admin: true,
    } }] });
  } catch {
    assert.deepEqual(state, before);
  }
  const savedProfile = person(state, 1).profile;
  for (const key of ['token', 'deviceHash', 'admin']) assert.equal(key in savedProfile, false);
  const identity = login(state, 1);
  rejectUnchanged(state, '/api/roster/import', { people: makeRoster(1) }, identity.token);
  rejectUnchanged(state, '/api/roster/judges', { judges: [{ name: '冒充评委' }] }, identity.token);
  rejectUnchanged(state, '/api/roster/settings', { teamsOpen: false, audienceEnabled: false }, identity.token);
});

test('judge roster is idempotent by name and only changes credentials when its phone changes', () => {
  const state = freshState();
  mutate(state, '/api/roster/import', { people: makeRoster(2) });
  mutate(state, '/api/roster/judges', { judges: [{ name: '无手机评委', bio: '虚构简介' }] });
  const original = copy(state.judges[0]);
  mutate(state, '/api/roster/judges', { judges: [{ name: '无手机评委', bio: '更新简介' }] });
  assert.equal(state.judges.length, 1);
  assert.equal(state.judges[0].id, original.id);
  assert.equal(state.judges[0].token, original.token);
  assert.equal(state.judges[0].bio, '更新简介');
  mutate(state, '/api/roster/judges', { judges: [{ id: original.id, name: '改名评委', phone: phone(901), bio: '新简介' }] });
  assert.equal(state.judges[0].id, original.id);
  assert.notEqual(state.judges[0].token, original.token);
  assert.equal(state.judges[0].phone, phone(901));
  const withPhone = copy(state.judges[0]);
  mutate(state, '/api/roster/judges', { judges: [{ id: original.id, name: '再次改名评委', phone: phone(901), bio: '仅更新介绍' }] });
  assert.equal(state.judges[0].token, withPhone.token);
});

test('first login records a device hash and every device re-enters the same identity', () => {
  const { state } = fixture();
  const identity = login(state, 1);
  const voter = person(state, 1);
  assert.equal(identity.token, voter.token);
  assert.equal(typeof voter.deviceHash, 'string');
  assert(voter.deviceHash.length >= 32);
  assert.notEqual(voter.deviceHash, identity.deviceKey);
  assert.equal(JSON.stringify(state).includes(identity.deviceKey), false, 'raw device keys must never be stored');
  const again = login(state, 1, identity.deviceKey);
  assert.equal(again.token, identity.token);
  const before = copy(voter);
  assert.equal(login(state, 1).token, identity.token);
  assert.deepEqual(voter, before, 'another device retains the first registration metadata and credential');
  const base64Key = randomBytes(32).toString('base64url');
  assert.equal(typeof login(state, 2, base64Key).token, 'string');
});

test('login rejects unregistered phones and malformed device keys without binding a person', () => {
  const { state } = fixture();
  rejectUnchanged(state, '/api/login', { phone: phone(899), deviceKey: device() }, '');
  for (const key of ['', 'tiny', 'g'.repeat(64), null, 123, []]) {
    rejectUnchanged(state, '/api/login', { phone: phone(1), deviceKey: key }, '');
  }
  assert(!person(state, 1).deviceHash);
});

test('identity reset is admin-only, revokes the old token, and every device can recover the new token', () => {
  const { state } = fixture();
  const old = login(state, 1);
  const voterId = person(state, 1).id;
  rejectUnchanged(state, '/api/roster/reset-device', { personId: voterId }, old.token);
  mutate(state, '/api/roster/reset-device', { personId: voterId });
  assert(!person(state, 1).deviceHash);
  assert.notEqual(person(state, 1).token, old.token);
  assert.throws(() => roleOf(state, old.token, ADMIN, true));
  const replacement = login(state, 1);
  assert.notEqual(replacement.token, old.token);
  assert.equal(login(state, 1, old.deviceKey).token, replacement.token);
});

test('team creation and joining are idempotent and one team cannot exceed four members', () => {
  const { state } = fixture();
  const captain = createTeam(state, 1, '四人上限测试队');
  mutate(state, '/api/teams/create', { name: '四人上限测试队', project: '虚构作品1' }, captain.token);
  assert.equal(state.teams.length, 1);
  const second = join(state, 2, captain.teamId);
  mutate(state, '/api/teams/join', { teamId: captain.teamId }, second.token);
  join(state, 3, captain.teamId);
  join(state, 4, captain.teamId);
  assert.equal(members(state, captain.teamId).length, 4);
  const fifth = login(state, 5);
  rejectUnchanged(state, '/api/teams/join', { teamId: captain.teamId }, fifth.token);
  assert.equal(person(state, 5).teamId, null);
  assert.equal(state.teams[0].members, 4);
  rejectUnchanged(state, '/api/teams/create', { name: '第二支队', project: '' }, captain.token);
});

test('only the captain edits a team, captaincy passes when leaving, and an empty team is removed', () => {
  const { state } = fixture();
  const captain = createTeam(state, 1);
  const second = join(state, 2, captain.teamId);
  rejectUnchanged(state, '/api/teams/update', { name: '越权改名', project: '越权作品' }, second.token);
  mutate(state, '/api/teams/update', { name: '已改名测试队', project: '已更新作品' }, captain.token);
  assert.equal(state.teams[0].name, '已改名测试队');
  mutate(state, '/api/teams/leave', {}, captain.token);
  assert.equal(state.teams[0].captainVoterId, person(state, 2).id);
  assert.equal(state.teams[0].members, 1);
  mutate(state, '/api/teams/update', { name: '新队长改名', project: '新作品' }, second.token);
  assert.equal(state.teams[0].name, '新队长改名');
  mutate(state, '/api/teams/leave', {}, second.token);
  mutate(state, '/api/teams/leave', {}, second.token);
  assert.equal(state.teams.length, 0);
  assert.equal(person(state, 1).teamId, null);
  assert.equal(person(state, 2).teamId, null);
});

test('team switching requires leaving first and audience cannot create or join teams', () => {
  const { state } = fixture();
  const first = createTeam(state, 1);
  const second = createTeam(state, 2);
  rejectUnchanged(state, '/api/teams/join', { teamId: second.teamId }, first.token);
  const audience = login(state, 100);
  rejectUnchanged(state, '/api/teams/create', { name: '观众队', project: '' }, audience.token);
  rejectUnchanged(state, '/api/teams/join', { teamId: first.teamId }, audience.token);
});

test('team registration can remain open during judging and closes at the deadline', () => {
  const { state } = fixture();
  const captain = createTeam(state, 1);
  const second = createTeam(state, 2);
  const outsider = login(state, 3);
  mutate(state, '/api/roster/settings', { teamsOpen: false, audienceEnabled: true });
  rejectUnchanged(state, '/api/teams/join', { teamId: captain.teamId }, outsider.token);
  rejectUnchanged(state, '/api/teams/leave', {}, captain.token);
  rejectUnchanged(state, '/api/teams/update', { name: '关闭时改名', project: '' }, captain.token);
  rejectUnchanged(state, '/api/teams/create', { name: '关闭时建队', project: '' }, outsider.token);
  mutate(state, '/api/roster/settings', { teamsOpen: true, audienceEnabled: true });
  mutate(state, '/api/phase', { phase: 'open' });
  assert.equal(state.event.teamsOpen, true);
  mutate(state, '/api/teams/join', { teamId: second.teamId }, outsider.token);
  assert.equal(state.voters.find(v=>v.token===outsider.token).teamId,second.teamId);
  mutate(state, '/api/roster/settings', { teamsOpen: false });
  rejectUnchanged(state, '/api/teams/leave', {}, captain.token);
  mutate(state, '/api/roster/settings', { teamsOpen: true });
  mutate(state, '/api/phase', { phase: 'closed' });
  assert.equal(state.event.teamsOpen, false);
  rejectUnchanged(state, '/api/roster/settings', { teamsOpen: true });
  rejectUnchanged(state, '/api/teams/join', { teamId: second.teamId }, outsider.token);
  rejectUnchanged(state, '/api/teams/leave', {}, captain.token);
});

test('players without a team cannot vote after judging opens', () => {
  const { state } = fixture();
  const first = createTeam(state, 1);
  createTeam(state, 2);
  const unteamed = login(state, 3);
  mutate(state, '/api/phase', { phase: 'open' });
  rejectUnchanged(state, '/api/vote', { allocations: { [first.teamId]: 1 } }, unteamed.token);
  const audience = login(state, 100);
  mutate(state, '/api/vote', { allocations: { [first.teamId]: 1 } }, audience.token);
  assert.equal(calculateResults(state).tally.totalVotes, 1);
});

test('guest context omits identities and logged-in context shows only safe team and own profile details', () => {
  const { state } = fixture();
  const captain = createTeam(state, 1);
  join(state, 2, captain.teamId);
  const guest = contextFor(state, 'guest', null);
  const serializedGuest = JSON.stringify(guest);
  for (const item of [...state.voters, ...state.judges]) {
    for (const value of [item.phone, item.token, item.deviceHash]) if (value) assert.equal(serializedGuest.includes(value), false);
  }
  assert.equal('memberNames' in guest.teams[0], false);
  assert.equal('captainVoterId' in guest.teams[0], false);
  assert.equal('identity' in guest, false);
  const own = contextFor(state, 'player', person(state, 1));
  assert.deepEqual(own.identity.profile, profile);
  assert.equal(typeof own.identity.phoneMasked, 'string');
  assert.notEqual(own.identity.phoneMasked, phone(1));
  assert(own.identity.phoneMasked.includes('*'));
  assert.equal(own.teams[0].members, 2);
  assert.equal(own.teams[0].maxMembers, 4);
  assert.equal(own.teams[0].captainVoterId, person(state, 1).id);
  assert.deepEqual(own.teams[0].memberNames, [person(state, 1).name, person(state, 2).name]);
  const serializedOwn = JSON.stringify(own);
  for (const item of [...state.voters, ...state.judges]) {
    for (const value of [item.phone, item.token, item.deviceHash]) if (value) assert.equal(serializedOwn.includes(value), false);
  }
});

test('phone backup schema 2 roundtrips setup with zero and one team', () => {
  const { state } = fixture();
  login(state, 1);
  assert.deepEqual(validateRestore({ schemaVersion: 2, state: copy(state) }), state);
  createTeam(state, 2);
  assert.equal(state.teams.length, 1);
  assert.deepEqual(validateRestore({ schemaVersion: 2, state: copy(state) }), state);
});

test('phone backups preserve completed scoring and reset judge tokens without changing results', () => {
  const { state } = fixture();
  const first = createTeam(state, 1);
  const second = createTeam(state, 2);
  const judgeLogin = login(state, 900);
  mutate(state, '/api/phase', { phase: 'open' });
  mutate(state, '/api/score', { teamId: first.teamId, scores: [9, 9, 9, 9] }, judgeLogin.token);
  mutate(state, '/api/score', { teamId: second.teamId, scores: [8, 8, 8, 8] }, judgeLogin.token);
  const before = copy(state.scores);
  const results = copy(calculateResults(state));
  mutate(state, '/api/roster/reset-device', { personId: state.judges[0].id });
  assert.deepEqual(state.scores, before);
  assert.deepEqual(calculateResults(state), results);
  assert.notEqual(state.judges[0].token, judgeLogin.token);
  assert.throws(() => roleOf(state, judgeLogin.token, ADMIN, true));
  mutate(state, '/api/phase', { phase: 'closed' });
  mutate(state, '/api/phase', { phase: 'published' });
  assert.deepEqual(validateRestore({ schemaVersion: 2, state: copy(state) }), state);
});

test('legacy schema 1 backups remain compatible', () => {
  const state = legacyFreshState();
  mutate(state, '/api/setup', {
    name: '旧版虚构活动', teams: [{ name: '旧甲队', project: '', members: 1 }, { name: '旧乙队', project: '', members: 1 }],
    judges: [{ name: '旧版评委' }], audienceCount: 0, audienceEnabled: false, allowRepeat: false,
  });
  mutate(state, '/api/phase', { phase: 'open' });
  mutate(state, '/api/score', { teamId: state.teams[0].id, scores: [9, 9, 9, 9] }, state.judges[0].token);
  assert.deepEqual(validateRestore({ schemaVersion: 1, state: copy(state) }), state);
});

test('phone backup validation rejects duplicate phones, invalid membership, forged captain and invalid device hashes', () => {
  const { state } = fixture();
  const captain = createTeam(state, 1);
  join(state, 2, captain.teamId);
  for (const damage of [
    (s) => { s.voters[1].phone = s.voters[0].phone; },
    (s) => { s.voters[0].teamId = 'missing_team'; },
    (s) => { s.teams[0].captainVoterId = person(s, 3).id; },
    (s) => { s.voters[0].deviceHash = 'not-a-valid-hash'; },
  ]) {
    const damaged = copy(state);
    damage(damaged);
    assert.throws(() => validateRestore({ schemaVersion: 2, state: damaged }));
  }
});

function memoryStore(initial) {
  let state = copy(initial), version = 0;
  return {
    async read() { const result = { state: copy(state), version }; await nextTurn(); return result; },
    async compareAndSwap(expected, replacement) {
      if (expected !== version) return false;
      state = copy(replacement); version += 1; return true;
    },
  };
}

async function withHttp(t, store) {
  const server = createServer({ store, adminToken: ADMIN, publicOrigin: ORIGIN, basePath: BASE });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const root = `http://127.0.0.1:${server.address().port}${BASE}`;
  return async (path, data, token) => {
    const response = await fetch(root + path, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json', Origin: ORIGIN }),
        ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const raw = await response.text();
    let body; try { body = JSON.parse(raw); } catch { body = raw; }
    return { status: response.status, body, raw };
  };
}

test('HTTP login needs no old token and each device receives the same persisted credential', async (t) => {
  const { state } = fixture();
  const store = memoryStore(state);
  const request = await withHttp(t, store);
  const key = device();
  const response = await request('/api/login', { phone: phone(1), deviceKey: key });
  assert.equal(response.status, 200, response.raw);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.token, person((await store.read()).state, 1).token);
  assert(person((await store.read()).state, 1).deviceHash);
  const same = await request('/api/login', { phone: phone(1), deviceKey: key });
  assert.equal(same.status, 200);
  assert.equal(same.body.token, response.body.token);
  const other = await request('/api/login', { phone: phone(1), deviceKey: device() });
  assert.equal(other.status, 200);
  assert.equal(other.body.token, response.body.token);
  const context = await request('/api/context', undefined, response.body.token);
  assert.equal(context.body.role, 'player');
  assert.equal(context.body.identity.name, person(state, 1).name);
  const backup = await request('/api/backup', undefined, ADMIN);
  assert.equal(backup.status, 200);
  assert.equal(backup.body.schemaVersion, 2);
});

test('two concurrent applicants for the final team slot cannot overfill the team', async (t) => {
  const { state } = fixture();
  const captain = createTeam(state, 1);
  join(state, 2, captain.teamId); join(state, 3, captain.teamId);
  const candidates = [login(state, 4), login(state, 5)];
  const store = memoryStore(state);
  const request = await withHttp(t, store);
  const responses = await Promise.all(candidates.map((candidate) => request('/api/teams/join', { teamId: captain.teamId }, candidate.token)));
  assert.equal(responses.filter((response) => response.status === 200).length, 1);
  assert.equal(responses.filter((response) => [400, 409].includes(response.status)).length, 1);
  const saved = (await store.read()).state;
  assert.equal(members(saved, captain.teamId).length, 4);
  assert.equal(saved.teams[0].members, 4);
  assert.equal([person(saved, 4), person(saved, 5)].filter((voter) => voter.teamId === captain.teamId).length, 1);
});

test('concurrent first login from different devices returns one shared identity to both', async (t) => {
  const { state } = fixture();
  const store = memoryStore(state);
  const request = await withHttp(t, store);
  const keys = [device(), device()];
  const responses = await Promise.all(keys.map((deviceKey) => request('/api/login', { phone: phone(1), deviceKey })));
  assert.equal(responses.filter((response) => response.status === 200).length, 2);
  assert.equal(new Set(responses.map(response => response.body.token)).size, 1);
  assert.equal(responses[0].body.token, person(state, 1).token);
  const saved = (await store.read()).state;
  assert.equal(saved.voters.filter(voter => voter.phone === phone(1)).length, 1);
  assert.equal(saved.voters.length, state.voters.length);
});

test('unknown database outcome is never retried and does not reveal a token or claim login success', async (t) => {
  const { state } = fixture();
  let saved = copy(state), writes = 0;
  const store = {
    async read() { return { state: copy(saved), version: 0 }; },
    async compareAndSwap(_version, replacement) {
      writes += 1;
      saved = copy(replacement); // Simulate a committed write followed by an indeterminate transport error.
      throw new Error('SIMULATED_WRITE_OUTCOME_UNKNOWN');
    },
  };
  const request = await withHttp(t, store);
  const response = await request('/api/login', { phone: phone(1), deviceKey: device() });
  assert.equal(response.status, 503, response.raw);
  assert.equal(writes, 1);
  assert.notEqual(response.body.ok, true);
  assert.equal('token' in response.body, false);
  assert.equal(response.raw.includes(person(saved, 1).token), false);
  assert.equal(response.raw.includes('SIMULATED_WRITE_OUTCOME_UNKNOWN'), false);
  assert(person(saved, 1).deviceHash, 'test must actually exercise an unknown committed outcome');
});

test('repeated failed login attempts are rate limited without leaking registered identities', async (t) => {
  const { state } = fixture();
  const request = await withHttp(t, memoryStore(state));
  let limited = false;
  for (let i = 0; i < 24; i += 1) {
    const response = await request('/api/login', { phone: phone(898), deviceKey: device() });
    assert.notEqual(response.body.ok, true);
    assert.equal('token' in response.body, false);
    if (response.status === 429) { limited = true; break; }
  }
  assert(limited, 'repeated failed attempts must meet a bounded process-level limit');
});

test('phone normalization merges equivalent +86 numbers and a spoofed login role grants no privileges', () => {
  const { state } = fixture();
  const before = copy(person(state, 1));
  mutate(state, '/api/roster/import', { people: [{ name: '规范化测试', phone: '+86 199 0000 0001', role: 'player' }] });
  assert.equal(person(state, 1).id, before.id);
  assert.equal(person(state, 1).token, before.token);
  const result = mutate(state, '/api/login', { phone: '8619900000001', deviceKey: device(), role: 'judge', admin: true }, '');
  assert.equal(roleOf(state, result.token, ADMIN, true)[0], 'player');
  assert.throws(() => roleOf(state, phone(1), ADMIN, true));
  createTeam(state, 2); createTeam(state, 3);
  mutate(state, '/api/phase', { phase: 'open' });
  rejectUnchanged(state, '/api/score', { teamId: state.teams[0].id, scores: [10, 10, 10, 10], role: 'judge' }, result.token);
});

test('disabled audience and unteamed players are counted separately from eligible voters', () => {
  const { state } = fixture(4);
  createTeam(state, 1); createTeam(state, 2);
  mutate(state, '/api/roster/settings', { audienceEnabled: false });
  const tally = calculateResults(state).tally;
  assert.equal(tally.registeredVoters, 5);
  assert.equal(tally.totalVoters, 2);
  assert.equal(tally.unteamedPlayers, 2);
  assert.equal(tally.disabledAudience, 1);
  mutate(state, '/api/phase', { phase: 'open' });
  const audience = login(state, 100);
  rejectUnchanged(state, '/api/vote', { allocations: { [state.teams[0].id]: 1 } }, audience.token);
});

test('phone mode prevents legacy setup reset and rejects profile overflow without partial import', () => {
  const { state } = fixture();
  rejectUnchanged(state, '/api/setup', {
    name: '不能覆盖', teams: [{ name: '甲', project: '', members: 1 }, { name: '乙', project: '', members: 1 }],
    judges: [{ name: '甲评委' }], audienceCount: 0, audienceEnabled: false, allowRepeat: false,
  });
  rejectUnchanged(state, '/api/roster/import', { people: [
    { name: '前行有效', phone: phone(300), role: 'player', profile: {} },
    { name: '后行无效', phone: phone(301), role: 'player', profile: { note: '字'.repeat(2001) } },
  ] });
  assert.equal(state.voters.some(v => v.phone === phone(300)), false);
});

test('legacy identity tokens survive phone-mode migration and v2 validates all of them', () => {
  const state = legacyFreshState();
  mutate(state, '/api/setup', {
    name: '兼容测试', teams: [{ name: '甲', project: '', members: 2 }, { name: '乙', project: '', members: 1 }],
    judges: [{ name: '甲评委' }], audienceCount: 0, audienceEnabled: false, allowRepeat: false,
  });
  const old = copy(state);
  mutate(state, '/api/roster/import', { people: [{ name: '新选手', phone: phone(300), role: 'player', profile: {} }] });
  for (const original of old.voters) {
    assert.equal(state.voters.find(v => v.id === original.id).token, original.token);
    assert.equal(roleOf(state, original.token, ADMIN, true)[0], 'player');
  }
  assert.equal(state.judges[0].token, old.judges[0].token);
  assert.deepEqual(validateRestore({ schemaVersion: 2, state: copy(state) }), state);
  assert.throws(() => validateRestore({ schemaVersion: 1, state: copy(state) }));
});

test('resetting a voter device preserves its final vote and cannot grant a second ballot', () => {
  const { state } = fixture();
  const first = createTeam(state, 1); const second = createTeam(state, 2);
  mutate(state, '/api/phase', { phase: 'open' });
  mutate(state, '/api/vote', { allocations: { [second.teamId]: 1 } }, first.token);
  const before = copy(state.ballots);
  mutate(state, '/api/roster/reset-device', { personId: person(state, 1).id });
  const renewed = login(state, 1);
  mutate(state, '/api/vote', { allocations: { [second.teamId]: 1 } }, renewed.token);
  assert.deepEqual(state.ballots, before);
  assert.throws(() => roleOf(state, first.token, ADMIN, true));
});

test('concurrent duplicate team creation returns one shared team and preserves unique membership', async (t) => {
  const { state } = fixture();
  const identity = login(state, 1);
  const store = memoryStore(state); const request = await withHttp(t, store);
  const responses = await Promise.all([1, 2].map(() => request('/api/teams/create', { name: '并发重复建队', project: '' }, identity.token)));
  assert(responses.every(response => response.status === 200));
  assert.equal(responses[0].body.teamId, responses[1].body.teamId);
  const saved = (await store.read()).state;
  assert.equal(saved.teams.length, 1);
  assert.equal(saved.teams[0].members, 1);
});
