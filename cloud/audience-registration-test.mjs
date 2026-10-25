import { legacyFreshState } from './test-fixtures.mjs';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import {
  freshState, updateState, roleOf, contextFor, calculateResults, validateRestore, judgeEntryKey,
} from './business.mjs';
import { createServer } from './server.mjs';

// Fictional identities and an in-memory store only; no event files or cloud services are used.
const ADMIN = 'TEST_ONLY_AUDIENCE_ADMIN_0123456789';
const ORIGIN = 'https://audience-tests.example.invalid';
const BASE = '/event';
const REGISTER = '/api/audience/register';
const clone = value => structuredClone(value);
const device = () => randomBytes(32).toString('hex');
const phone = index => `1990100${String(index).padStart(4, '0')}`;
const mutate = (state, route, payload, token = ADMIN) => updateState(state, route, payload, token, ADMIN);
const voter = (state, index) => state.voters.find(item => item.phone === phone(index));
const registration = (index = 200, deviceKey = device()) => ({ name: `虚构观众${index}`, phone: phone(index), deviceKey });
const register = (state, payload = registration()) => mutate(state, REGISTER, payload, '');
const allocations = teams => Object.fromEntries(teams.map(team => [team.id, 1]));

function fixture() {
  const state = freshState();
  mutate(state, '/api/roster/import', { people: [
    ...Array.from({ length: 7 }, (_, i) => ({
      name: `虚构选手${i + 1}`, phone: phone(i + 1), role: 'player',
      profile: { background: '虚构背景', skills: '虚构技能', company: '虚构公司', note: '虚构私密备注' },
    })),
    { name: '预先登记的虚构观众', phone: phone(100), role: 'audience', profile: { note: '保留原始资料' } },
  ] });
  mutate(state, '/api/roster/judges', { judges: [{ name: '虚构评委', phone: phone(900) }] });
  mutate(state, '/api/roster/settings', { audienceEnabled: true });
  return state;
}

function openFixture() {
  const state = fixture();
  for (const index of [1, 3, 4, 5, 6]) {
    mutate(state, '/api/teams/create', { name: `虚构队伍${index}`, project: `虚构作品${index}` }, voter(state, index).token);
  }
  mutate(state, '/api/teams/join', { teamId: voter(state, 1).teamId }, voter(state, 2).token);
  mutate(state, '/api/phase', { phase: 'open' });
  return state;
}

function rejectUnchanged(state, route, payload, token = '') {
  const before = clone(state);
  assert.throws(() => mutate(state, route, payload, token));
  assert.deepEqual(state, before, 'rejection must not partially change event data');
}

test('a new audience registration persists a single identity with two votes and its first device record', () => {
  for (const phase of ['setup', 'open']) {
    const state = phase === 'open' ? openFixture() : fixture();
    const count = state.voters.length, payload = registration();
    const result = register(state, { ...payload, name: `  ${payload.name}  ` });
    const saved = voter(state, 200);
    assert.equal(state.voters.length, count + 1);
    assert.equal(saved.role, 'audience');
    assert.equal(saved.name, payload.name);
    assert.equal(saved.teamId, null);
    assert.equal(saved.voteLimit, 2);
    assert.deepEqual(saved.profile, {});
    assert.equal(result.token, saved.token);
    assert.equal(roleOf(state, result.token, ADMIN, true)[0], 'audience');
    assert.match(saved.deviceHash, /^[a-f0-9]{64}$/);
    assert(Number.isFinite(Date.parse(saved.enteredAt)));
    assert(!JSON.stringify(state).includes(payload.deviceKey));
  }
});

test('new registration requires phone entry, enabled audience voting, and setup or open phase', () => {
  for (const alter of [
    state => { delete state.event.entryMode; },
    state => { state.event.audienceEnabled = false; },
    state => { state.event.phase = 'closed'; },
    state => { state.event.phase = 'published'; },
  ]) {
    const state = fixture(); alter(state);
    rejectUnchanged(state, REGISTER, registration());
  }
});

test('equivalent phone and device encodings reuse one audience and preserve its initial name', () => {
  const state = fixture(), bytes = randomBytes(32);
  const payload = registration(200, bytes.toString('hex'));
  const first = register(state, payload), saved = clone(voter(state, 200));
  for (const normalizedPhone of ['+86 199 0100 0200', '8619901000200', phone(200)]) {
    const again = register(state, { ...payload, phone: normalizedPhone, name: '不能覆盖原名', deviceKey: bytes.toString('base64url') });
    assert.equal(again.token, first.token);
    assert.deepEqual(voter(state, 200), saved);
  }
  assert.equal(state.voters.filter(item => item.phone === phone(200)).length, 1);
});

test('existing audience and player records are reused across devices without changing role, name, profile, team or token', () => {
  for (const index of [1, 100]) {
    const state = openFixture(), original = clone(voter(state, index));
    const payload = { ...registration(index), name: '不能覆盖原资料' };
    const result = register(state, payload), saved = voter(state, index);
    assert.equal(result.token, original.token);
    for (const field of ['id', 'name', 'role', 'teamId', 'token', 'voteLimit', 'profile']) {
      assert.deepEqual(saved[field], original[field], field);
    }
    assert.equal(state.voters.length, 8);
    assert.equal(roleOf(state, result.token, ADMIN, true)[0], original.role);
    const entered = clone(state);
    for (const deviceKey of [payload.deviceKey, device(), device()]) {
      assert.equal(register(state, { ...payload, deviceKey }).token, original.token);
      assert.deepEqual(state, entered, 're-entry must preserve the first device record and all event data');
    }
  }
});

test('an existing voter can recover the same identity after registration closes or audience voting is disabled', () => {
  for (const phase of ['setup', 'open', 'closed', 'published']) {
    for (const index of [1, 100]) {
      const state = openFixture(), payload = registration(index);
      state.event.phase = phase; state.event.audienceEnabled = false;
      const original = clone(voter(state, index));
      state.ballots.push({ voterId: original.id, allocations: allocations(state.teams.slice(1, 2)), submittedAt: '2026-10-24T10:00:00.000Z' });
      const result = register(state, payload);
      assert.equal(result.token, original.token);
      const context = contextFor(state, original.role, voter(state, index));
      assert.deepEqual(context.ballot, state.ballots[0]);
      assert.equal(state.voters.length, 8);
      const entered = clone(state);
      assert.equal(register(state, { ...payload, deviceKey: device() }).token, original.token);
      assert.deepEqual(state, entered, 'cross-device recovery must preserve the existing ballot and identity');
    }
  }
});

test('audience registration never returns a judge identity or changes a judge record', () => {
  const state = fixture();
  rejectUnchanged(state, REGISTER, registration(900));
  assert.equal(state.judges[0].deviceHash, undefined);
});

test('registration rejects malformed required fields atomically', () => {
  const state = fixture(), good = registration();
  for (const name of [undefined, null, '', '   ', 123, [], {}, '字'.repeat(201), '无效\u0000名字']) {
    rejectUnchanged(state, REGISTER, { ...good, name });
  }
  for (const invalidPhone of [undefined, null, 19901000200, '', '123', '199010002001', 'not-a-phone', '12901000200']) {
    rejectUnchanged(state, REGISTER, { ...good, phone: invalidPhone });
  }
  for (const deviceKey of [undefined, null, '', 'tiny', 'g'.repeat(64), 123, {}, []]) {
    rejectUnchanged(state, REGISTER, { ...good, deviceKey });
  }
  for (const payload of [null, [], 'invalid']) rejectUnchanged(state, REGISTER, payload);
});

test('untrusted extra fields cannot grant another role, extra votes or forged profile and credentials', () => {
  const state = fixture(), before = clone(state), payload = registration();
  try {
    register(state, { ...payload, role: 'admin', voteLimit: 999, teamId: 'forged_team', id: 'forged_id',
      token: 'FORGED_CREDENTIAL', deviceHash: 'forged_hash', profile: { note: 'forged_profile' }, audienceEnabled: true });
  } catch {
    assert.deepEqual(state, before);
    return;
  }
  const saved = voter(state, 200);
  assert.equal(saved.role, 'audience'); assert.equal(saved.voteLimit, 2); assert.equal(saved.teamId, null);
  assert.notEqual(saved.id, 'forged_id'); assert.notEqual(saved.token, 'FORGED_CREDENTIAL');
  assert.notEqual(saved.deviceHash, 'forged_hash'); assert.deepEqual(saved.profile, {});
  assert.equal(roleOf(state, saved.token, ADMIN, true)[0], 'audience');
});

test('a device already used by any player, audience or judge cannot create another audience', () => {
  for (const role of ['player', 'audience', 'judge']) {
    const state = fixture(), key = device();
    if (role === 'judge') {
      mutate(state, '/api/judges/login', { name: state.judges[0].name, entryKey: judgeEntryKey(ADMIN), deviceKey: key }, '');
    } else mutate(state, '/api/login', { phone: phone(role === 'player' ? 1 : 100), deviceKey: key }, '');
    rejectUnchanged(state, REGISTER, registration(200, key));
  }
});

test('existing players and audiences can re-enter from devices used by any identity without replacing their first device record', () => {
  for (const index of [1, 100, 200]) {
    const state = fixture(), ownKey = device(), playerKey = device(), audienceKey = device(), judgeKey = device();
    const first = register(state, registration(index, ownKey));
    mutate(state, '/api/login', { phone: phone(2), deviceKey: playerKey }, '');
    register(state, registration(201, audienceKey));
    mutate(state, '/api/judges/login', { name: state.judges[0].name, entryKey: judgeEntryKey(ADMIN), deviceKey: judgeKey }, '');
    const before = clone(state);
    for (const key of [playerKey, audienceKey, judgeKey, device(), ownKey]) {
      assert.equal(register(state, registration(index, key)).token, first.token);
      assert.deepEqual(state, before, 're-entry must not create, transfer or change an identity');
    }
  }
});

test('the 2000-voter event limit allows the final new identity and still permits existing recovery', () => {
  const state = fixture(), template = clone(state.voters[0]);
  state.voters = Array.from({ length: 1999 }, (_, i) => ({ ...clone(template),
    id: `voter_${String(i).padStart(12, '0')}`, name: `虚构名额${i}`, phone: phone(i + 1000),
    token: `FICTIONAL_LIMIT_TOKEN_${String(i).padStart(12, '0')}`,
  }));
  const payload = registration(9999), result = register(state, payload);
  assert.equal(state.voters.length, 2000);
  rejectUnchanged(state, REGISTER, registration(9998));
  assert.equal(register(state, payload).token, result.token);
  assert.equal(state.voters.length, 2000);
});

test('new and legacy audiences see a two-vote limit without mutating stored legacy limits', () => {
  const state = openFixture();
  voter(state, 100).voteLimit = 5;
  register(state, registration());
  const before = clone(state);
  for (const index of [100, 200]) {
    const context = contextFor(state, 'audience', voter(state, index));
    assert.equal(context.identity.voteLimit, 2);
    assert.equal(context.identity.role, 'audience');
  }
  assert.deepEqual(state, before);
  assert.equal(voter(state, 100).voteLimit, 5);
});

test('audiences can submit one or two distinct teams but cannot submit three or repeat the same team', () => {
  for (const oldLimit of [2, 5]) {
    for (const size of [1, 2]) {
      const state = openFixture(), person = voter(state, 100); person.voteLimit = oldLimit;
      mutate(state, '/api/vote', { allocations: allocations(state.teams.slice(0, size)) }, person.token);
      assert.equal(calculateResults(state).tally.totalVotes, size);
    }
    const state = openFixture(), person = voter(state, 100); person.voteLimit = oldLimit;
    rejectUnchanged(state, '/api/vote', { allocations: allocations(state.teams.slice(0, 3)) }, person.token);
    rejectUnchanged(state, '/api/vote', { allocations: { [state.teams[0].id]: 2 } }, person.token);
    for (const invalid of [-1, 1.5, '1', true, null]) {
      rejectUnchanged(state, '/api/vote', { allocations: { [state.teams[0].id]: invalid } }, person.token);
    }
  }
});

test('a submitted audience ballot stays final across devices and exact retries never increase the total', () => {
  for (const index of [100, 200]) {
    const state = openFixture(), first = register(state, registration(index));
    const chosen = allocations(state.teams.slice(0, 2));
    mutate(state, '/api/vote', { allocations: chosen }, first.token);
    const before = clone(state);
    for (const deviceKey of [device(), device()]) {
      const recovered = register(state, registration(index, deviceKey));
      assert.equal(recovered.token, first.token);
      assert.deepEqual(contextFor(state, 'audience', voter(state, index)).ballot, before.ballots[0]);
      mutate(state, '/api/vote', { allocations: { ...chosen } }, recovered.token);
      assert.deepEqual(state, before);
      rejectUnchanged(state, '/api/vote', { allocations: allocations(state.teams.slice(1, 3)) }, recovered.token);
    }
    assert.equal(state.ballots.length, 1);
    assert.equal(calculateResults(state).tally.totalVotes, 2);
  }
});

test('legacy allowRepeat cannot give new or unvoted legacy audiences two votes for one team', () => {
  for (const storedLimit of [2, 5]) {
    const state = backupState(1, storedLimit, 0);
    state.event.allowRepeat = true;
    const person = state.voters.find(item => item.role === 'audience');
    rejectUnchanged(state, '/api/vote', { allocations: { [state.teams[0].id]: 2 } }, person.token);
    mutate(state, '/api/vote', { allocations: allocations(state.teams.slice(0, 2)) }, person.token);
    assert.equal(state.ballots.length, 1);
    assert.equal(calculateResults(state).tally.totalVotes, 2);
    assert(Object.values(state.ballots[0].allocations).every(count => count === 1));
  }
});

test('each teammate independently keeps three votes, cannot vote for their own team, and unteamed players cannot vote', () => {
  const state = openFixture(), first = voter(state, 1), second = voter(state, 2), outsider = voter(state, 7);
  assert.equal(first.teamId, second.teamId);
  const targets = state.teams.filter(team => team.id !== first.teamId);
  for (const person of [first, second]) {
    assert.equal(contextFor(state, 'player', person).identity.voteLimit, 3);
    rejectUnchanged(state, '/api/vote', { allocations: { [first.teamId]: 1 } }, person.token);
    rejectUnchanged(state, '/api/vote', { allocations: allocations(targets) }, person.token);
    mutate(state, '/api/vote', { allocations: allocations(targets.slice(0, 3)) }, person.token);
  }
  rejectUnchanged(state, '/api/vote', { allocations: allocations(targets.slice(0, 1)) }, outsider.token);
  assert.equal(state.ballots.length, 2);
  assert.equal(new Set(state.ballots.map(ballot => ballot.voterId)).size, 2);
  assert.equal(calculateResults(state).tally.totalVotes, 6);
});

test('audience voting still requires the open phase and enabled audience participation', () => {
  for (const phase of ['setup', 'closed', 'published']) {
    const state = openFixture(); state.event.phase = phase;
    rejectUnchanged(state, '/api/vote', { allocations: allocations(state.teams.slice(0, 1)) }, voter(state, 100).token);
  }
  const state = openFixture(); state.event.audienceEnabled = false;
  rejectUnchanged(state, '/api/vote', { allocations: allocations(state.teams.slice(0, 1)) }, voter(state, 100).token);
});

function backupState(version, historicalLimit, ballotSize) {
  let state;
  if (version === 1) {
    state = legacyFreshState();
    mutate(state, '/api/setup', { name: '虚构旧活动',
      teams: Array.from({ length: 5 }, (_, i) => ({ name: `虚构旧队${i}`, project: `作品${i}`, members: 1 })),
      judges: [{ name: '虚构旧评委' }], audienceEnabled: true, audienceCount: 1, allowRepeat: false,
    });
    mutate(state, '/api/phase', { phase: 'open' });
  } else state = openFixture();
  const person = state.voters.find(item => item.role === 'audience');
  person.voteLimit = historicalLimit;
  if (ballotSize) state.ballots.push({ voterId: person.id, allocations: allocations(state.teams.slice(0, ballotSize)), submittedAt: '2026-10-24T10:00:00.000Z' });
  if (version === 3) state.invitations = [];
  return state;
}

test('v1, v2 and v3 backups preserve old three-to-five-vote ballots without granting new five-vote ballots', () => {
  for (const version of [1, 2, 3]) {
    for (const size of [3, 5]) {
      const state = backupState(version, 5, size);
      const restored = validateRestore({ schemaVersion: version, state: clone(state) });
      assert.deepEqual(restored, state);
      const person = restored.voters.find(item => item.role === 'audience');
      assert.equal(contextFor(restored, 'audience', person).identity.voteLimit, 2);
      mutate(restored, '/api/vote', { allocations: clone(restored.ballots[0].allocations) }, person.token);
      assert.deepEqual(restored, state, 'an exact historical retry must not rewrite its ballot');
      rejectUnchanged(restored, '/api/vote', { allocations: allocations(restored.teams.slice(0, 2)) }, person.token);
    }
    const state = backupState(version, 5, 0);
    const restored = validateRestore({ schemaVersion: version, state });
    rejectUnchanged(restored, '/api/vote', { allocations: allocations(restored.teams.slice(0, 3)) }, restored.voters.find(item => item.role === 'audience').token);
  }
});

test('all backup versions accept two-vote audiences but reject forged three-vote history for them', () => {
  for (const version of [1, 2, 3]) {
    const valid = backupState(version, 2, 2);
    assert.deepEqual(validateRestore({ schemaVersion: version, state: clone(valid) }), valid);
    const invalid = backupState(version, 2, 3);
    assert.throws(() => validateRestore({ schemaVersion: version, state: invalid }));
  }
});

test('public and audience context expose neither private identities nor raw device credentials', () => {
  const state = openFixture(), payload = registration(), result = register(state, payload);
  for (const context of [contextFor(state, 'guest', null), contextFor(state, 'audience', voter(state, 200))]) {
    const serialized = JSON.stringify(context);
    for (const person of [...state.voters, ...state.judges]) {
      for (const value of [person.phone, person.token, person.deviceHash]) if (value) assert(!serialized.includes(value));
    }
    for (const key of ['voters', 'judges', 'playerCards', 'invitations']) assert.equal(key in context, false);
    assert(!serialized.includes(payload.deviceKey));
    assert(!serialized.includes('虚构私密备注'));
  }
  const context = contextFor(state, 'audience', voter(state, 200));
  assert(context.identity.phoneMasked.includes('*'));
  assert.equal(context.identity.name, payload.name);
  rejectUnchanged(state, '/api/score', { teamId: state.teams[0].id, scores: [10, 10, 10, 10] }, result.token);
  rejectUnchanged(state, '/api/teams/create', { name: '观众不能创建的队伍' }, result.token);
});

function memoryStore(initial, raceSize = 0) {
  let state = clone(initial), version = 0, writes = 0, conflicts = 0, reads = 0, release;
  const barrier = raceSize ? new Promise(resolve => { release = resolve; }) : null;
  return {
    async read() {
      const result = { state: clone(state), version };
      if (++reads <= raceSize) { if (reads === raceSize) release(); await barrier; }
      return result;
    },
    async compareAndSwap(expected, replacement) {
      writes += 1;
      if (expected !== version) { conflicts += 1; return false; }
      state = clone(replacement); version += 1; return true;
    },
    snapshot: () => ({ state: clone(state), version, writes, conflicts }),
  };
}

async function withHttp(t, store) {
  const server = createServer({ store, adminToken: ADMIN, publicOrigin: ORIGIN, basePath: BASE });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const root = `http://127.0.0.1:${server.address().port}${BASE}`;
  return async (path, data, token, headers = {}) => {
    const response = await fetch(root + path, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json', Origin: ORIGIN }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const raw = await response.text();
    return { status: response.status, body: JSON.parse(raw), raw };
  };
}

test('HTTP registration needs no old token and releases its credential only after persistence', async t => {
  const store = memoryStore(fixture()), request = await withHttp(t, store);
  const payload = registration(), response = await request(REGISTER, payload);
  assert.equal(response.status, 200, response.raw);
  assert.deepEqual(Object.keys(response.body).sort(), ['ok', 'token']);
  assert.equal(response.body.ok, true);
  const saved = voter(store.snapshot().state, 200);
  assert.equal(response.body.token, saved.token);
  assert(saved.deviceHash);
  const context = await request('/api/context', undefined, response.body.token);
  assert.equal(context.status, 200); assert.equal(context.body.role, 'audience');
  assert.equal(context.body.identity.voteLimit, 2);
  assert.equal((await request('/api/admin', undefined, response.body.token)).status, 403);
  for (const secret of [payload.phone, payload.deviceKey, saved.token, saved.deviceHash]) assert(!context.raw.includes(secret));
});

test('concurrent repeated registration for the same phone and device yields one shared identity', async t => {
  const initial = fixture(), store = memoryStore(initial, 2), request = await withHttp(t, store);
  const payload = registration();
  const replies = await Promise.all([1, 2].map(() => request(REGISTER, payload)));
  assert(replies.every(reply => reply.status === 200));
  assert.equal(replies[0].body.token, replies[1].body.token);
  const snapshot = store.snapshot();
  assert.equal(snapshot.state.voters.length, initial.voters.length + 1);
  assert.equal(snapshot.state.voters.filter(person => person.phone === payload.phone).length, 1);
  assert(snapshot.conflicts >= 1, 'the test must exercise a real version conflict');
});

test('concurrent registration of one phone from different devices shares one audience identity and token', async t => {
  const initial = fixture(), store = memoryStore(initial, 2), request = await withHttp(t, store);
  const replies = await Promise.all([registration(), registration()].map(payload => request(REGISTER, payload)));
  assert(replies.every(reply => reply.status === 200));
  assert.equal(replies[0].body.token, replies[1].body.token);
  const snapshot = store.snapshot(), saved = voter(snapshot.state, 200);
  assert.equal(snapshot.state.voters.length, initial.voters.length + 1);
  assert.equal(snapshot.state.voters.filter(person => person.phone === phone(200)).length, 1);
  assert.equal(saved.token, replies[0].body.token);
  assert.equal(saved.role, 'audience');
  assert.equal(saved.voteLimit, 2);
  assert.equal(saved.teamId, null);
  assert.equal(snapshot.state.ballots.length, 0);
  assert.deepEqual(snapshot.state.voters.filter(person => person.id !== saved.id), initial.voters);
  assert(snapshot.conflicts >= 1, 'the test must exercise a real version conflict');
});

test('concurrent different phones on the same device cannot acquire two audience identities', async t => {
  const initial = fixture(), store = memoryStore(initial, 2), request = await withHttp(t, store), key = device();
  const replies = await Promise.all([200, 201].map(index => request(REGISTER, registration(index, key))));
  assert.equal(replies.filter(reply => reply.status === 200).length, 1);
  assert.equal(replies.filter(reply => [400, 401, 403, 409].includes(reply.status)).length, 1);
  const saved = store.snapshot().state;
  assert.equal(saved.voters.length, initial.voters.length + 1);
  assert.equal(saved.voters.filter(person => [phone(200), phone(201)].includes(person.phone)).length, 1);
});

test('an unknown committed registration outcome is never retried and never returns a token', async t => {
  let state = fixture(), writes = 0;
  const request = await withHttp(t, {
    async read() { return { state: clone(state), version: 0 }; },
    async compareAndSwap(_version, replacement) {
      state = clone(replacement); writes += 1; throw new Error('FICTIONAL_UNKNOWN_COMMIT');
    },
  });
  const response = await request(REGISTER, registration());
  assert.equal(response.status, 503);
  assert.equal(writes, 1);
  assert.notEqual(response.body.ok, true); assert(!('token' in response.body));
  assert(voter(state, 200)?.deviceHash, 'the write must actually have committed before the simulated error');
  assert(!response.raw.includes(voter(state, 200).token));
  assert(!response.raw.includes('FICTIONAL_UNKNOWN_COMMIT'));
});

test('exhausted explicit version conflicts do not claim a successful registration', async t => {
  const state = fixture(); let writes = 0;
  const request = await withHttp(t, {
    async read() { return { state: clone(state), version: 0 }; },
    async compareAndSwap() { writes += 1; return false; },
  });
  const response = await request(REGISTER, registration());
  assert.equal(response.status, 409); assert.equal(writes, 6);
  assert.notEqual(response.body.ok, true); assert(!('token' in response.body));
  assert.equal(voter(state, 200), undefined);
});

test('phone login and audience registration share the same twelve-attempt normalized-phone limit', async t => {
  const store = memoryStore(fixture()), request = await withHttp(t, store), payload = registration();
  for (let index = 0; index < 12; index++) {
    const path = index % 2 ? '/api/login' : REGISTER;
    const response = await request(path, { ...payload, phone: index % 3 ? phone(200) : '+86 199 0100 0200' });
    assert.equal(response.status, 200, `attempt ${index + 1}`);
  }
  const before = store.snapshot();
  assert.equal((await request(REGISTER, payload)).status, 429);
  assert.equal((await request('/api/login', payload)).status, 429);
  assert.deepEqual(store.snapshot(), before, 'limited requests must not reach the store');
  assert.equal((await request(REGISTER, registration(201))).status, 200, 'another phone has its own phone counter');
});

test('the shared 240-attempt source limit cannot be bypassed by alternating endpoints or spoofing forwarding headers', async t => {
  const state = fixture(); state.event.audienceEnabled = false;
  const store = memoryStore(state), request = await withHttp(t, store);
  for (let index = 0; index < 240; index++) {
    const response = await request(index % 2 ? '/api/login' : REGISTER, registration(index + 1000), undefined,
      { 'X-Forwarded-For': `203.0.113.${index % 250 + 1}` });
    assert([400, 401, 403, 409].includes(response.status), `unexpected response at attempt ${index + 1}: ${response.status}`);
    assert(!('token' in response.body));
  }
  assert.equal((await request(REGISTER, registration(5000), undefined, { 'X-Forwarded-For': '198.51.100.1' })).status, 429);
  assert.equal((await request('/api/login', registration(5001), undefined, { 'X-Forwarded-For': '198.51.100.2' })).status, 429);
  assert.deepEqual(store.snapshot().state, state);
  assert.equal(store.snapshot().writes, 0);
});

test('HTTP registration rejects cross-site requests and malformed payloads without creating anyone', async t => {
  const state = fixture(), store = memoryStore(state), request = await withHttp(t, store);
  assert.equal((await request(REGISTER, registration(), undefined, { Origin: 'https://elsewhere.example.invalid' })).status, 403);
  assert.equal((await request(REGISTER, registration(), undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  for (const payload of [[], null, {}, { phone: phone(200) }]) {
    const response = await request(REGISTER, payload);
    assert(response.status >= 400 && response.status < 500);
    assert(!('token' in response.body));
  }
  assert.deepEqual(store.snapshot().state, state);
  assert.equal(store.snapshot().writes, 0);
});
