import { legacyFreshState } from './test-fixtures.mjs';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import {
  freshState, updateState, calculateResults, validateRestore, contextFor, exportCsv,
} from './business.mjs';
import { createServer } from './server.mjs';

// Deliberately fictional credentials and an in-memory store used only by tests.
const ADMIN = 'TEST_ONLY_ADMIN_0123456789abcdef';
const PUBLIC_ORIGIN = 'https://awards.example.invalid';
const BASE_PATH = '/event';
const clone = (value) => structuredClone(value);

function setupPayload({ teamCount = 6, judgeCount = 2, audienceCount = 2 } = {}) {
  return {
    name: '虚构评分验收演练',
    teams: Array.from({ length: teamCount }, (_, i) => ({
      name: `队伍${i + 1}`, project: `作品${i + 1}`, members: 1,
    })),
    judges: Array.from({ length: judgeCount }, (_, i) => ({ name: `评委${i + 1}` })),
    audienceCount,
    audienceEnabled: audienceCount > 0,
    allowRepeat: false,
  };
}

function fixture(options = {}) {
  const state = legacyFreshState();
  const payload = setupPayload(options);
  updateState(state, '/api/setup', payload, ADMIN, ADMIN);
  updateState(state, '/api/phase', { phase: 'open' }, ADMIN, ADMIN);
  return {
    state, payload,
    teams: state.teams.map((team) => team.id),
    judges: state.judges,
    players: state.voters.filter((voter) => voter.role === 'player'),
    audience: state.voters.filter((voter) => voter.role === 'audience'),
  };
}

function mutate(f, route, payload, token = ADMIN) {
  updateState(f.state, route, payload, token, ADMIN);
}

function score(f, judge, team, values) {
  mutate(f, '/api/score', { teamId: f.teams[team], scores: values }, f.judges[judge].token);
}

function fillUnique(f) {
  for (let j = 0; j < f.judges.length; j += 1) {
    for (let t = 0; t < f.teams.length; t += 1) score(f, j, t, [10 - t, 10 - t, 10 - t, 10 - t]);
  }
}

function juryRow(f, team = 0) {
  return calculateResults(f.state).jury.find((row) => row.teamId === f.teams[team]);
}

function close(f) {
  mutate(f, '/api/phase', { phase: 'closed' });
}

function fraction(value) {
  const string = String(value);
  if (string.includes('/')) return string.split('/').map(BigInt);
  const [whole, decimal = ''] = string.split('.');
  return [BigInt(`${whole}${decimal}`), 10n ** BigInt(decimal.length)];
}

function assertFraction(value, numerator, denominator = 1n) {
  const [actualNumerator, actualDenominator] = fraction(value);
  assert.equal(actualNumerator * denominator, numerator * actualDenominator);
}

function rejectsWithoutChanging(f, route, payload, token = ADMIN, expected) {
  const before = clone(f.state);
  assert.throws(() => mutate(f, route, payload, token), expected);
  assert.deepEqual(f.state, before, 'a rejected action must not partially change the event');
}

test('weights are 30/25/25/20 and valid judges are averaged exactly', () => {
  const f = fixture();
  score(f, 0, 0, [8.1, 9.2, 7.3, 6.4]);
  score(f, 1, 0, [1.2, 3.4, 5.6, 7.8]);
  const row = juryRow(f);
  assertFraction(row.scoreExact, 2401n, 400n);
  assert.equal(row.score, 6.0025);
  assert.equal(row.complete, true);
  for (const [index, expected] of [3, 2.5, 2.5, 2].entries()) {
    const values = [0, 0, 0, 0];
    values[index] = 10;
    score(f, 0, 1, values);
    score(f, 1, 1, values);
    assert.equal(juryRow(f, 1).score, expected);
  }
});

test('equal displayed averages do not create a false exact tie', () => {
  const f = fixture({ teamCount: 2, judgeCount: 100 });
  mutate(f, '/api/recuse', { teamId: f.teams[1], reason: '利益相关' }, f.judges[99].token);
  for (let j = 0; j < 100; j += 1) {
    score(f, j, 0, [j === 0 ? 8.1 : 8, 8, 8, 8]);
    if (j < 99) score(f, j, 1, [j === 0 ? 8.1 : 8, 8, 8, 8]);
  }
  const result = calculateResults(f.state);
  assert.deepEqual(result.jury.map((row) => row.score), [8.0003, 8.0003]);
  assert.deepEqual(result.jury.map((row) => row.teamId), [f.teams[1], f.teams[0]]);
  assert.deepEqual(result.jury.map((row) => row.rank), [1, 2]);
  assert.deepEqual(result.unresolvedTies, []);
});

test('a missing score is not zero and an incomplete team has no rank', () => {
  const f = fixture();
  score(f, 0, 0, [10, 10, 10, 10]);
  const row = juryRow(f);
  assert.equal(row.score, 10);
  assert.equal(row.received, 1);
  assert.equal(row.expected, 2);
  assert.equal(row.complete, false);
  assert.equal(row.rank, null);
  assert.equal(calculateResults(f.state).ready, false);
  close(f);
  rejectsWithoutChanging(f, '/api/phase', { phase: 'published' });
});

test('recusal removes an earlier score and removes that judge from the denominator', () => {
  const f = fixture();
  score(f, 0, 0, [2, 2, 2, 2]);
  score(f, 1, 0, [9, 9, 9, 9]);
  mutate(f, '/api/recuse', { teamId: f.teams[0], reason: '同事关系' }, f.judges[0].token);
  const row = juryRow(f);
  assert.equal(row.score, 9);
  assert.deepEqual([row.expected, row.received, row.recused], [1, 1, 1]);
  rejectsWithoutChanging(f, '/api/score', { teamId: f.teams[0], scores: [8, 8, 8, 8] }, f.judges[0].token);
  rejectsWithoutChanging(f, '/api/recuse', { teamId: f.teams[0], reason: '重复' }, f.judges[0].token);
});

test('a team with all judges recused cannot be published', () => {
  const f = fixture();
  fillUnique(f);
  for (const judge of f.judges) {
    mutate(f, '/api/recuse', { teamId: f.teams[0], reason: '利益相关' }, judge.token);
  }
  close(f);
  assert.equal(juryRow(f).score, null);
  rejectsWithoutChanging(f, '/api/phase', { phase: 'published' });
});

test('invalid scores are rejected before any score changes', () => {
  const f = fixture();
  for (const value of [true, false, null, '8', -1, 10.1, 8.11, NaN, Infinity]) {
    rejectsWithoutChanging(f, '/api/score', { teamId: f.teams[0], scores: [value, 8, 8, 8] }, f.judges[0].token);
  }
  for (const scores of [[], [8, 8, 8], [8, 8, 8, 8, 8], null, {}]) {
    rejectsWithoutChanging(f, '/api/score', { teamId: f.teams[0], scores }, f.judges[0].token);
  }
});

test('scores may be updated while open and are frozen when closed', () => {
  const f = fixture();
  score(f, 0, 0, [3, 3, 3, 3]);
  score(f, 0, 0, [9, 9, 9, 9]);
  assert.equal(f.state.scores.length, 1);
  assert.equal(f.state.scores[0].weightedScore, 9);
  close(f);
  rejectsWithoutChanging(f, '/api/score', { teamId: f.teams[0], scores: [1, 1, 1, 1] }, f.judges[0].token);
});

test('an exact jury tie requires a complete group and recorded deliberation', () => {
  const f = fixture({ teamCount: 4 });
  fillUnique(f);
  score(f, 0, 1, [10, 10, 10, 10]);
  score(f, 1, 1, [10, 10, 10, 10]);
  close(f);
  assert.equal(calculateResults(f.state).ready, false);
  rejectsWithoutChanging(f, '/api/phase', { phase: 'published' });
  for (const [teamIds, reason] of [
    [f.teams.slice(0, 1), '合议'], [f.teams.slice(0, 3), '合议'],
    [f.teams.slice(0, 2), ''], [[f.teams[0], f.teams[0]], '合议'],
  ]) rejectsWithoutChanging(f, '/api/tie', { kind: 'jury', teamIds, reason });
  mutate(f, '/api/tie', { kind: 'jury', teamIds: f.teams.slice(0, 2).reverse(), reason: '评委现场合议' });
  const result = calculateResults(f.state);
  assert.deepEqual(result.jury.map((row) => row.teamId), [f.teams[1], f.teams[0], ...f.teams.slice(2)]);
  assert.deepEqual(result.jury.map((row) => row.rank), [1, 2, 3, 4]);
  assert.equal(result.ready, true);
  mutate(f, '/api/phase', { phase: 'open' });
  assert.deepEqual(f.state.decisions, []);
  assert.equal(calculateResults(f.state).ready, false);
});

test('players have three distinct votes and cannot vote for their own team', () => {
  const f = fixture();
  const voter = f.players[0];
  assert.equal(voter.voteLimit, 3);
  for (const allocations of [
    { [f.teams[0]]: 1 }, { [f.teams[1]]: 2 }, {},
    { [f.teams[1]]: -1 }, { [f.teams[1]]: 0 }, { [f.teams[1]]: true },
    { [f.teams[1]]: '1' }, { unknown_team: 1 },
    Object.fromEntries(f.teams.slice(1, 5).map((id) => [id, 1])),
  ]) rejectsWithoutChanging(f, '/api/vote', { allocations }, voter.token);
  mutate(f, '/api/vote', { allocations: Object.fromEntries(f.teams.slice(1, 4).map((id) => [id, 1])) }, voter.token);
  assert.equal(calculateResults(f.state).tally.totalVotes, 3);
});

test('audience may vote for two distinct teams, never three or twice for one team', () => {
  const f = fixture();
  const voter = f.audience[0];
  assert.equal(voter.voteLimit, 2);
  rejectsWithoutChanging(f, '/api/vote', { allocations: Object.fromEntries(f.teams.slice(0, 3).map((id) => [id, 1])) }, voter.token);
  rejectsWithoutChanging(f, '/api/vote', { allocations: { [f.teams[0]]: 2 } }, voter.token);
  mutate(f, '/api/vote', { allocations: Object.fromEntries(f.teams.slice(0, 2).map((id) => [id, 1])) }, voter.token);
  assert.equal(calculateResults(f.state).tally.totalVotes, 2);
});

test('the per-team limit cannot be turned off and no-audience events permit player voting', () => {
  const fresh = { state: legacyFreshState() };
  rejectsWithoutChanging(fresh, '/api/setup', { ...setupPayload(), allowRepeat: true });
  const f = fixture({ audienceCount: 0 });
  assert.equal(f.audience.length, 0);
  mutate(f, '/api/vote', { allocations: { [f.teams[1]]: 1 } }, f.players[0].token);
  assert.equal(calculateResults(f.state).tally.totalVotes, 1);
  const withAudience = fixture();
  withAudience.state.event.audienceEnabled = false;
  rejectsWithoutChanging(withAudience, '/api/vote', { allocations: { [withAudience.teams[0]]: 1 } }, withAudience.audience[0].token);
});

test('identical ballot retries are idempotent and changed retries are refused', () => {
  const f = fixture();
  const voter = f.audience[0];
  mutate(f, '/api/vote', { allocations: { [f.teams[0]]: 1, [f.teams[1]]: 1 } }, voter.token);
  mutate(f, '/api/vote', { allocations: { [f.teams[1]]: 1, [f.teams[0]]: 1 } }, voter.token);
  assert.equal(f.state.ballots.length, 1);
  assert.equal(calculateResults(f.state).tally.totalVotes, 2);
  rejectsWithoutChanging(f, '/api/vote', { allocations: { [f.teams[0]]: 1 } }, voter.token);
});

test('popularity ties stay pending without blocking jury publication and can be resolved afterward', () => {
  const f = fixture();
  fillUnique(f);
  for (let i = 0; i < 2; i += 1) mutate(f, '/api/vote', { allocations: { [f.teams[i]]: 1 } }, f.audience[i].token);
  close(f);
  assert.equal(calculateResults(f.state).ready, true);
  mutate(f, '/api/phase', { phase: 'published' });
  const frozenScores = clone(f.state.scores);
  const frozenBallots = clone(f.state.ballots);
  assert.equal(calculateResults(f.state).popular[0].resolved, false);
  mutate(f, '/api/tie', { kind: 'popular', teamIds: [f.teams[1], f.teams[0]], reason: '现场同票处理结果' });
  assert.deepEqual(calculateResults(f.state).popular.slice(0, 2).map((row) => row.teamId), [f.teams[1], f.teams[0]]);
  assert.equal(calculateResults(f.state).popular[0].resolved, true);
  rejectsWithoutChanging(f, '/api/tie', { kind: 'jury', teamIds: f.teams.slice(0, 2), reason: '禁止变动' });
  rejectsWithoutChanging(f, '/api/score', { teamId: f.teams[0], scores: [1, 1, 1, 1] }, f.judges[0].token);
  rejectsWithoutChanging(f, '/api/vote', { allocations: { [f.teams[1]]: 1 } }, f.players[0].token);
  assert.deepEqual(f.state.scores, frozenScores);
  assert.deepEqual(f.state.ballots, frozenBallots);
});

test('no popularity votes means no popularity ranking', () => {
  const f = fixture();
  fillUnique(f);
  assert(calculateResults(f.state).popular.every((row) => row.rank === null));
  assert.deepEqual(calculateResults(f.state).unresolvedTies, []);
  close(f);
  mutate(f, '/api/phase', { phase: 'published' });
});

test('roles cannot be escalated and the roster is frozen after opening', () => {
  const f = fixture();
  rejectsWithoutChanging(f, '/api/phase', { phase: 'closed' }, f.judges[0].token);
  rejectsWithoutChanging(f, '/api/score', { teamId: f.teams[0], scores: [9, 9, 9, 9] }, f.players[0].token);
  rejectsWithoutChanging(f, '/api/setup', f.payload);
  rejectsWithoutChanging(f, '/api/phase', { phase: 'closed' }, 'INVALID_TEST_TOKEN');
});

test('context exposes only personal data and publishes no credentials or judge identities', () => {
  const f = fixture();
  score(f, 0, 0, [9, 9, 9, 9]);
  const judgeContext = contextFor(f.state, 'judge', f.judges[1]);
  assert.deepEqual(judgeContext.scores, []);
  assert.equal('token' in judgeContext.judge, false);
  assert.equal('results' in contextFor(f.state, 'guest', null), false);
  const playerContext = contextFor(f.state, 'player', f.players[0]);
  assert.equal('token' in playerContext.identity, false);
  fillUnique(f);
  close(f);
  mutate(f, '/api/phase', { phase: 'published' });
  const publicContext = contextFor(f.state, 'guest', null);
  assert.deepEqual(publicContext.results.missing, []);
  const serialized = JSON.stringify(publicContext);
  for (const person of [...f.judges, ...f.state.voters]) {
    assert.equal(serialized.includes(person.token), false);
    assert.equal(serialized.includes(person.id), false);
  }
  assert.equal(serialized.includes(ADMIN), false);
});

test('validated backup preserves scores, ballots, recusals and tie decisions', () => {
  const f = fixture();
  fillUnique(f);
  for (let j = 0; j < f.judges.length; j += 1) score(f, j, 1, [10, 10, 10, 10]);
  mutate(f, '/api/recuse', { teamId: f.teams[3], reason: '利益相关' }, f.judges[0].token);
  mutate(f, '/api/vote', { allocations: { [f.teams[0]]: 1 } }, f.audience[0].token);
  close(f);
  mutate(f, '/api/tie', { kind: 'jury', teamIds: f.teams.slice(0, 2), reason: '现场合议记录' });
  mutate(f, '/api/phase', { phase: 'published' });
  assert.deepEqual(validateRestore({ schemaVersion: 1, state: clone(f.state) }), f.state);
});

test('backup validation rejects forged scores, identities, duplicate credentials and premature publication', () => {
  const f = fixture();
  score(f, 0, 0, [9, 9, 9, 9]);
  for (const damage of [
    (s) => { s.scores[0].scores[0] = true; },
    (s) => { s.voters[0].teamId = 'wrong'; },
    (s) => { s.voters[0].token = s.judges[0].token; },
    (s) => { s.event.phase = 'published'; },
    (s) => { s.event.allowRepeat = true; },
    (s) => { s.scores.push(clone(s.scores[0])); },
  ]) {
    const state = clone(f.state);
    damage(state);
    assert.throws(() => validateRestore({ schemaVersion: 1, state }));
  }
});

test('CSV has a UTF-8 BOM, raw scores, and safely escaped spreadsheet formulas', () => {
  const f = fixture();
  fillUnique(f);
  f.state.teams[0].name = '=HYPERLINK("bad")';
  const bytes = Buffer.from(exportCsv(f.state));
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const text = bytes.toString('utf8');
  assert(text.includes("'=HYPERLINK"));
  assert.equal(text.split(/\r?\n/).filter((line) => /^(?:"原始评分"|原始评分),/.test(line)).length, f.state.scores.length + 1);
});

function memoryStore(initialState) {
  let state = clone(initialState);
  let version = 0;
  return {
    conflicts: 0,
    casCalls: 0,
    async read() {
      const snapshot = { state: clone(state), version };
      await nextTurn();
      return snapshot;
    },
    async compareAndSwap(expected, replacement) {
      this.casCalls += 1;
      if (version !== expected) {
        this.conflicts += 1;
        return false;
      }
      state = clone(replacement);
      version += 1;
      return true;
    },
  };
}

async function withHttp(t, store) {
  const server = createServer({ store, adminToken: ADMIN, publicOrigin: PUBLIC_ORIGIN, basePath: BASE_PATH });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const root = `http://127.0.0.1:${server.address().port}`;
  async function request(path, { data, token, origin, headers = {} } = {}) {
    const response = await fetch(root + BASE_PATH + path, {
      method: data === undefined ? 'GET' : 'POST',
      headers: {
        ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
        ...(origin === undefined ? {} : { Origin: origin }),
        ...headers,
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const raw = await response.text();
    let body;
    try { body = JSON.parse(raw); } catch { body = raw; }
    return { status: response.status, headers: response.headers, body, raw };
  }
  return { request, root };
}

test('HTTP identities, private routes and cache headers are protected', async (t) => {
  const f = fixture();
  const { request } = await withHttp(t, memoryStore(f.state));
  assert.equal((await request('/api/health')).status, 200);
  assert.equal((await request('/api/context')).body.role, 'guest');
  assert.equal((await request('/api/context', { token: 'invalid' })).status, 401);
  assert.equal((await request('/api/context', { token: '' })).status, 401);
  assert.equal((await request('/api/admin')).status, 403);
  const admin = await request('/api/admin', { token: ADMIN });
  assert.equal(admin.status, 200);
  assert.equal(admin.headers.get('cache-control'), 'no-store');
  assert.equal(admin.headers.get('access-control-allow-origin'), null);
  for (const path of ['/data/admin.key', '/server.mjs', '/business.mjs', '/cloud/test.mjs', '/docs/API.md']) {
    assert.equal((await request(path)).status, 404, path);
  }
});

test('HTTP accepts its configured public origin and rejects cross-origin writes', async (t) => {
  const f = fixture();
  const store = memoryStore(f.state);
  const { request } = await withHttp(t, store);
  const wrong = await request('/api/phase', { data: { phase: 'closed' }, token: ADMIN, origin: 'https://evil.invalid' });
  assert.equal(wrong.status, 403);
  assert.equal((await store.read()).state.event.phase, 'open');
  const good = await request('/api/phase', { data: { phase: 'closed' }, token: ADMIN, origin: PUBLIC_ORIGIN });
  assert.equal(good.status, 200, good.raw);
  assert.equal((await store.read()).state.event.phase, 'closed');
});

test('HTTP backup and CSV require administrator credentials and preserve real event structure', async (t) => {
  const f = fixture();
  fillUnique(f);
  mutate(f, '/api/vote', { allocations: { [f.teams[0]]: 1 } }, f.audience[0].token);
  const { request } = await withHttp(t, memoryStore(f.state));
  for (const path of ['/api/backup', '/api/export?format=csv']) {
    assert.equal((await request(path)).status, 403);
    assert.equal((await request(path, { token: f.judges[0].token })).status, 403);
  }
  const backup = await request('/api/backup', { token: ADMIN });
  assert.equal(backup.status, 200);
  assert.equal(backup.raw.includes(ADMIN), false);
  assert.deepEqual(validateRestore(backup.body), f.state);
  const csv = await request('/api/export?format=csv', { token: ADMIN });
  assert.equal(csv.status, 200);
  assert(csv.raw.includes('原始评分'));
});

test('CAS conflict is retried against fresh state without overwriting a competing vote', async (t) => {
  const f = fixture();
  const base = memoryStore(f.state);
  let injected = false;
  const store = {
    read: () => base.read(),
    async compareAndSwap(version, replacement) {
      if (!injected) {
        injected = true;
        const snapshot = await base.read();
        updateState(snapshot.state, '/api/vote', { allocations: { [f.teams[1]]: 1 } }, f.audience[1].token, ADMIN);
        assert.equal(await base.compareAndSwap(snapshot.version, snapshot.state), true);
        return false;
      }
      return base.compareAndSwap(version, replacement);
    },
  };
  const { request } = await withHttp(t, store);
  const response = await request('/api/vote', { data: { allocations: { [f.teams[0]]: 1 } }, token: f.audience[0].token });
  assert.equal(response.status, 200, response.raw);
  const saved = (await base.read()).state;
  assert.equal(saved.ballots.length, 2);
  assert.equal(calculateResults(saved).tally.totalVotes, 2);
  assert.deepEqual(new Set(saved.ballots.map((ballot) => ballot.voterId)), new Set(f.audience.map((voter) => voter.id)));
});

test('concurrent different voters are all retained and simultaneous identical retries count once', async (t) => {
  const f = fixture({ audienceCount: 12 });
  const store = memoryStore(f.state);
  const { request } = await withHttp(t, store);
  const responses = await Promise.all(f.audience.map((voter, i) => request('/api/vote', {
    data: { allocations: { [f.teams[i % f.teams.length]]: 1 } }, token: voter.token,
  })));
  assert.deepEqual(responses.map((response) => response.status), Array(12).fill(200));
  const retries = await Promise.all(Array.from({ length: 12 }, () => request('/api/vote', {
    data: { allocations: { [f.teams[0]]: 1 } }, token: f.audience[0].token,
  })));
  assert.deepEqual(retries.map((response) => response.status), Array(12).fill(200));
  const saved = (await store.read()).state;
  assert.equal(saved.ballots.length, 12);
  assert.equal(calculateResults(saved).tally.totalVotes, 12);
  const changed = await request('/api/vote', { data: { allocations: { [f.teams[1]]: 1 } }, token: f.audience[0].token });
  assert.equal(changed.status, 409);
});

test('concurrent different ballots from the same person accept exactly one final ballot', async (t) => {
  const f = fixture();
  const store = memoryStore(f.state);
  const { request } = await withHttp(t, store);
  const responses = await Promise.all(f.teams.slice(0, 2).map((teamId) => request('/api/vote', {
    data: { allocations: { [teamId]: 1 } }, token: f.audience[0].token,
  })));
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  const saved = (await store.read()).state;
  assert.equal(saved.ballots.length, 1);
  assert.equal(calculateResults(saved).tally.totalVotes, 1);
});

test('exhausted CAS conflicts produce a failure response and never claim the vote was saved', { timeout: 10000 }, async (t) => {
  const f = fixture();
  let writes = 0;
  const store = {
    async read() { return { state: clone(f.state), version: 0 }; },
    async compareAndSwap() { writes += 1; return false; },
  };
  const { request } = await withHttp(t, store);
  const response = await request('/api/vote', { data: { allocations: { [f.teams[0]]: 1 } }, token: f.audience[0].token });
  assert([409, 503].includes(response.status), `unexpected response ${response.status}: ${response.raw}`);
  assert(writes > 1 && writes < 100, 'retry budget must be finite and must allow retries');
  assert.equal(f.state.ballots.length, 0);
});
