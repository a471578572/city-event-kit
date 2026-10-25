import { legacyFreshState } from './test-fixtures.mjs';
import { SITE_CONFIG } from './site-config.mjs';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import { freshState, updateState, calculateResults, validateRestore, contextFor } from './business.mjs';
import { createServer } from './server.mjs';

// Synthetic records only. No event files, credentials, exports or remote services are read.
const ADMIN = 'TEST_ONLY_ADMIN_0123456789abcdef';
const ORIGIN = 'https://certificate-tests.example.invalid';
const BASE = '/event';
const copy = (value) => structuredClone(value);
const phone = (i) => `1990000${String(i).padStart(4, '0')}`;
const mutate = (state, route, payload, token = ADMIN) => updateState(state, route, payload, token, ADMIN);
const player = (state, i) => state.voters.find((person) => person.phone === phone(i));
const certificates = (state, person) => contextFor(state, 'player', person).certificates;
const kinds = (values) => values.map((item) => item.kind).sort();
const numbers = (values) => Object.fromEntries(values.map((item) => [item.kind, item.number]));

function fixture(schema = 2) {
  const state = schema === 1 ? legacyFreshState() : freshState();
  if (schema === 1) {
    mutate(state, '/api/setup', {
      name: '虚构证书验收活动',
      teams: Array.from({ length: 4 }, (_, i) => ({ name: `虚构队伍${i + 1}`, project: `虚构作品${i + 1}`, members: i === 0 ? 2 : 1 })),
      judges: [{ name: '虚构评委甲' }, { name: '虚构评委乙' }], audienceCount: 2, audienceEnabled: true, allowRepeat: false,
    });
    return state;
  }
  mutate(state, '/api/roster/import', { people: [
    ...Array.from({ length: 6 }, (_, i) => ({ name: `虚构选手${i + 1}`, phone: phone(i + 1), role: 'player', profile: { note: '不应出现在证书中的私密备注' } })),
    { name: '虚构观众甲', phone: phone(100), role: 'audience', profile: {} },
    { name: '虚构观众乙', phone: phone(101), role: 'audience', profile: {} },
  ] });
  mutate(state, '/api/roster/judges', { judges: [{ name: '虚构评委甲', phone: phone(900) }, { name: '虚构评委乙', phone: phone(901) }] });
  mutate(state, '/api/roster/settings', { teamsOpen: true, audienceEnabled: true });
  for (const person of state.voters) mutate(state, '/api/login', { phone: person.phone, deviceKey: randomBytes(32).toString('hex') }, '');
  for (let i = 1; i <= 4; i += 1) mutate(state, '/api/teams/create', { name: `虚构队伍${i}`, project: `虚构作品${i}` }, player(state, i).token);
  if (schema === 3) {
    const invite = mutate(state, '/api/invitations/send', { targetId: player(state, 5).id }, player(state, 1).token);
    mutate(state, '/api/invitations/respond', { invitationId: invite.invitationId, action: 'decline' }, player(state, 5).token);
  }
  mutate(state, '/api/teams/join', { teamId: player(state, 1).teamId }, player(state, 5).token);
  return state;
}

function openAndScore(state) {
  mutate(state, '/api/phase', { phase: 'open' });
  for (const judge of state.judges) {
    for (const [i, team] of state.teams.entries()) mutate(state, '/api/score', { teamId: team.id, scores: [10 - i, 10 - i, 10 - i, 10 - i] }, judge.token);
  }
}
function publish(state) {
  mutate(state, '/api/phase', { phase: 'closed' });
  mutate(state, '/api/phase', { phase: 'published' });
}
function teamPlayer(state, index) { return state.voters.find((person) => person.role === 'player' && person.teamId === state.teams[index].id); }
function publicFixture(schema = 2) { const state = fixture(schema); openAndScore(state); publish(state); return state; }

test('players always receive a certificates array but nothing is issued before publication', () => {
  const state = fixture();
  assert.deepEqual(certificates(state, player(state, 1)), []);
  openAndScore(state);
  assert.deepEqual(certificates(state, player(state, 1)), []);
  mutate(state, '/api/phase', { phase: 'closed' });
  assert.deepEqual(certificates(state, player(state, 1)), []);
});

test('published players get participation and correctly ranked top-three certificates with exact safe descriptors', () => {
  const state = publicFixture();
  const fields = ['kind', 'title', 'personName', 'teamName', 'project', 'city', 'rank', 'date', 'number', 'issuer', 'eventName'].sort();
  const titles = { participation: '参赛证书', top3: '城市前三获奖证书', popular: '人气奖获奖证书' };
  for (let i = 0; i < 4; i += 1) {
    const person = teamPlayer(state, i), result = certificates(state, person);
    assert.deepEqual(kinds(result), i < 3 ? ['participation', 'top3'] : ['participation']);
    for (const item of result) {
      assert.deepEqual(Object.keys(item).sort(), fields);
      assert.equal(item.title, titles[item.kind]);
      assert.equal(item.personName, person.name);
      assert.equal(item.teamName, state.teams[i].name);
      assert.equal(item.project, state.teams[i].project);
      assert.equal(item.city, SITE_CONFIG.city);
      assert.equal(item.issuer, SITE_CONFIG.certificateIssuer);
      assert.equal(item.eventName, SITE_CONFIG.name);
      assert.equal(item.rank, item.kind === 'top3' ? i + 1 : null);
      assert.match(item.date, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(typeof item.number, 'string');
      assert(item.number.length > 0);
    }
  }
});

test('unassigned players and teams with blank projects receive no certificate', () => {
  const state = publicFixture();
  assert.deepEqual(certificates(state, player(state, 6)), []);
  state.teams[0].project = ' \t\n ';
  assert.deepEqual(certificates(state, player(state, 1)), []);
  assert.deepEqual(certificates(state, player(state, 5)), []);
});

test('incomplete or unresolved jury rankings never create top-three certificates', () => {
  const incomplete = publicFixture();
  incomplete.scores = incomplete.scores.filter((score) => !(score.teamId === incomplete.teams[0].id && score.judgeId === incomplete.judges[0].id));
  assert.deepEqual(kinds(certificates(incomplete, teamPlayer(incomplete, 0))), ['participation']);
  const tied = fixture(); openAndScore(tied);
  for (const judge of tied.judges) mutate(tied, '/api/score', { teamId: tied.teams[1].id, scores: [10, 10, 10, 10] }, judge.token);
  tied.event.phase = 'published'; // Deliberately inconsistent state to verify conservative certificate eligibility.
  assert.equal(calculateResults(tied).jury[0].resolved, false);
  assert.deepEqual(kinds(certificates(tied, teamPlayer(tied, 0))), ['participation']);
  assert.deepEqual(kinds(certificates(tied, teamPlayer(tied, 1))), ['participation']);
});

test('no votes issue no popularity certificate and a unique audience winner may also be outside the jury top three', () => {
  const empty = publicFixture();
  for (const person of empty.voters.filter((item) => item.role === 'player')) assert.equal(kinds(certificates(empty, person)).includes('popular'), false);
  const state = fixture(); openAndScore(state);
  mutate(state, '/api/vote', { allocations: { [state.teams[3].id]: 1 } }, player(state, 100).token);
  publish(state);
  const result = certificates(state, player(state, 4));
  assert.deepEqual(kinds(result), ['participation', 'popular']);
  const popular = result.find((item) => item.kind === 'popular');
  assert.equal(popular.rank, null, 'only the city top-three certificate prints a numeric award place');
  assert.equal(popular.title, '人气奖获奖证书');
});

test('unresolved top-vote ties issue no popularity certificate, and post-publication deliberation awards only its winner', () => {
  const state = fixture(); openAndScore(state);
  for (let i = 0; i < 2; i += 1) mutate(state, '/api/vote', { allocations: { [state.teams[i].id]: 1 } }, player(state, 100 + i).token);
  publish(state);
  const before = numbers(certificates(state, player(state, 2)));
  assert.equal(kinds(certificates(state, player(state, 1))).includes('popular'), false);
  assert.equal(kinds(certificates(state, player(state, 2))).includes('popular'), false);
  mutate(state, '/api/tie', { kind: 'popular', teamIds: [state.teams[1].id, state.teams[0].id], reason: '虚构现场同票决定' });
  const winner = certificates(state, player(state, 2));
  assert.deepEqual(kinds(winner), ['participation', 'popular', 'top3']);
  assert.equal(kinds(certificates(state, player(state, 1))).includes('popular'), false);
  for (const [kind, value] of Object.entries(before)) assert.equal(numbers(winner)[kind], value);
});

test('guest, audience, judge and administrator contexts never expose personal certificates', () => {
  const state = publicFixture();
  for (const [role, person] of [['guest', null], ['audience', player(state, 100)], ['judge', state.judges[0]], ['admin', null]]) {
    assert.equal('certificates' in contextFor(state, role, person), false, role);
  }
  const json = JSON.stringify(certificates(state, player(state, 1)));
  for (const item of [...state.voters, ...state.judges]) {
    for (const value of [item.phone, item.token, item.deviceHash]) if (value) assert.equal(json.includes(value), false);
  }
  assert.equal(json.includes('不应出现在证书中的私密备注'), false);
  assert.equal(json.includes(ADMIN), false);
});

test('certificate numbers distinguish people and kinds, stay stable across credential reset and exclude phone/token contents', () => {
  const state = publicFixture();
  const first = certificates(state, player(state, 1)), teammate = certificates(state, player(state, 5));
  assert.equal(new Set([...first, ...teammate].map((item) => item.number)).size, first.length + teammate.length);
  const before = numbers(first), id = player(state, 1).id;
  mutate(state, '/api/roster/reset-device', { personId: id });
  assert.deepEqual(numbers(certificates(state, player(state, 1))), before);
  const person = player(state, 1);
  person.phone = phone(800); person.token = randomBytes(24).toString('base64url');
  assert.deepEqual(numbers(certificates(state, person)), before);
  for (const item of certificates(state, person)) {
    assert.equal(item.number.includes(person.phone), false);
    assert.equal(item.number.includes(person.token), false);
  }
});

test('certificate dates use Beijing time across UTC day and year boundaries', () => {
  const state = publicFixture();
  for (const [publishedAt, date] of [
    ['2026-10-23T15:59:59.000Z', '2026-10-23'],
    ['2026-10-23T16:00:00.000Z', '2026-10-24'],
    ['2026-12-31T16:00:00.000Z', '2027-01-01'],
  ]) {
    state.event.publishedAt = publishedAt;
    assert(certificates(state, player(state, 1)).every((item) => item.date === date));
  }
});

test('first publication records a stable timestamp that context reads and later popularity decisions cannot change', () => {
  const state = fixture(); openAndScore(state);
  for (let i = 0; i < 2; i += 1) mutate(state, '/api/vote', { allocations: { [state.teams[i].id]: 1 } }, player(state, 100 + i).token);
  assert.equal('publishedAt' in state.event, false);
  mutate(state, '/api/phase', { phase: 'closed' });
  assert.equal('publishedAt' in state.event, false);
  const lower = Date.now();
  mutate(state, '/api/phase', { phase: 'published' });
  const upper = Date.now(), publishedAt = state.event.publishedAt;
  assert.equal(typeof publishedAt, 'string');
  assert(Date.parse(publishedAt) >= lower - 1000 && Date.parse(publishedAt) <= upper);
  const snapshot = copy(state);
  certificates(state, player(state, 1)); certificates(state, player(state, 2));
  assert.deepEqual(state, snapshot);
  mutate(state, '/api/tie', { kind: 'popular', teamIds: [state.teams[0].id, state.teams[1].id], reason: '虚构同票决定' });
  assert.equal(state.event.publishedAt, publishedAt);
  assert.throws(() => mutate(state, '/api/phase', { phase: 'published' }));
  assert.equal(state.event.publishedAt, publishedAt);
});

test('schema 1, 2 and 3 restores preserve publication timestamp and exact certificate numbers', () => {
  for (const schemaVersion of [1, 2, 3]) {
    const state = publicFixture(schemaVersion);
    state.event.publishedAt = '2026-10-23T16:10:00.000Z';
    const original = teamPlayer(state, 0), expected = certificates(state, original);
    const restored = validateRestore({ schemaVersion, state: copy(state) });
    assert.deepEqual(restored, state);
    assert.deepEqual(certificates(restored, restored.voters.find((person) => person.id === original.id)), expected);
  }
});

test('older published backups without a timestamp restore unchanged and use the fixed activity date', () => {
  for (const schemaVersion of [1, 2, 3]) {
    const state = publicFixture(schemaVersion);
    delete state.event.publishedAt;
    const snapshot = copy(state), original = teamPlayer(state, 0);
    assert(certificates(state, original).every((item) => item.date === SITE_CONFIG.date));
    const restored = validateRestore({ schemaVersion, state: copy(state) });
    assert.deepEqual(restored, snapshot);
    assert.equal('publishedAt' in restored.event, false);
    assert.deepEqual(certificates(restored, restored.voters.find((person) => person.id === original.id)), certificates(state, original));
    assert.deepEqual(state, snapshot, 'reading legacy certificates must not create a timestamp');
  }
});

test('all backup versions reject malformed or malicious publication timestamps', () => {
  for (const schemaVersion of [1, 2, 3]) {
    const state = publicFixture(schemaVersion);
    for (const value of ['', 'not-a-date', null, 123, '2026-10-24', '2026-02-30T00:00:00.000Z', '2026-10-24T00:00:00.000Z<script>']) {
      const damaged = copy(state); damaged.event.publishedAt = value;
      assert.throws(() => validateRestore({ schemaVersion, state: damaged }), `schema ${schemaVersion} accepted ${JSON.stringify(value)}`);
    }
  }
});

function memoryStore(initial) {
  let state = copy(initial), version = 0;
  return {
    writes: 0,
    async read() { return { state: copy(state), version }; },
    async compareAndSwap(expected, replacement) { this.writes += 1; if (expected !== version) return false; state = copy(replacement); version += 1; return true; },
  };
}
async function withHttp(t, store) {
  const server = createServer({ store, adminToken: ADMIN, publicOrigin: ORIGIN, basePath: BASE });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections?.(); await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); });
  const root = `http://127.0.0.1:${server.address().port}${BASE}`;
  return async (path, credential) => {
    const response = await fetch(root + path, { headers: credential === undefined ? {} : { Authorization: `Bearer ${credential}` } });
    return { status: response.status, body: await response.json() };
  };
}

test('HTTP query parameters cannot forge certificates or another participant identity and GET never writes', async (t) => {
  const state = publicFixture(), person = player(state, 4), store = memoryStore(state);
  const request = await withHttp(t, store);
  const query = new URLSearchParams({ rank: '1', kind: 'top3', personName: '伪造得奖人', teamName: '伪造队伍', teamId: state.teams[0].id, personId: player(state, 1).id });
  const response = await request(`/api/context?${query}`, person.token);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.certificates, certificates(state, person));
  assert.deepEqual(kinds(response.body.certificates), ['participation']);
  assert.equal(response.body.identity.id, person.id);
  const guest = await request(`/api/context?${query}&token=${encodeURIComponent(person.token)}`);
  assert.equal(guest.body.role, 'guest');
  assert.equal('certificates' in guest.body, false);
  for (const credential of [player(state, 100).token, state.judges[0].token, ADMIN]) {
    assert.equal('certificates' in (await request(`/api/context?${query}`, credential)).body, false);
  }
  const backup = await request('/api/backup', ADMIN);
  assert.equal(backup.status, 200);
  assert.equal(backup.body.state.event.publishedAt, state.event.publishedAt);
  assert.equal(store.writes, 0);
  assert.deepEqual((await store.read()).state, state);
});

test('legacy certificate HTTP reads use the fallback date without inserting publication data', async (t) => {
  const state = publicFixture(3); delete state.event.publishedAt;
  const store = memoryStore(state), request = await withHttp(t, store);
  const response = await request('/api/context', player(state, 1).token);
  assert.equal(response.status, 200);
  assert(response.body.certificates.every((item) => item.date === SITE_CONFIG.date));
  assert.equal(store.writes, 0);
  assert.deepEqual((await store.read()).state, state);
});
