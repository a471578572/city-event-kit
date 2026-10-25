import { SITE_CONFIG } from './site-config.mjs';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { freshState, updateState, contextFor, publicGuideFor } from './business.mjs';
import { createServer } from './server.mjs';

const ADMIN = 'TEST_ONLY_PUBLIC_GUIDE_ADMIN_0123456789';
const ORIGIN = 'https://public-guide.example.invalid';
const BASE = '/event';
const FIELDS = ['background', 'participation', 'directions', 'skills', 'experience'];
const clone = value => structuredClone(value);
const openGuide = state => publicGuideFor(state, {...SITE_CONFIG, publicPlayerWall: true});
// All phone/contact strings below are synthetic masking fixtures.

function fixture() {
  const state = freshState();
  const mutate = (route, body, token = ADMIN) => updateState(state, route, body, token, ADMIN);
  mutate('/api/roster/import', { people: [
    { name: '虚构选手甲', phone: '19900009601', role: 'player', profile: {
      background: '大学老师，擅长 AI 教学。', participation: '想和伙伴完成一个能用的作品。',
      directions: '自然教育', skills: 'Python 与 WeChat miniapp 开发', experience: '参加过 3 次活动，已有 10 年教学经验。',
      company: '不公开的单位', position: '不公开的职位', note: '不公开的备注',
    } },
    { name: '虚构选手乙', phone: '19900009602', role: 'player' },
    { name: '不公开的观众姓名', phone: '19900009603', role: 'audience', profile: { background: '不公开的观众背景' } },
  ] });
  mutate('/api/roster/judges', { judges: [{ name: '不公开的评委姓名', phone: '19900009604', bio: '不公开的评委介绍' }] });
  mutate('/api/teams/create', { name: '虚构合作队', project: '不在公开导览展示的作品' }, state.voters[0].token);
  state.voters[0].deviceHash = 'd'.repeat(64);
  state.voters[0].email = 'private-field@example.invalid';
  state.voters[0].wechat = 'private_wechat_field';
  state.voters[0].profile.unknown = '不公开的额外资料';
  state.scores = [{ judgeId: state.judges[0].id, teamId: state.teams[0].id, scores: [9, 9, 9, 9], weightedScore: 9 }];
  state.ballots = [{ voterId: state.voters[2].id, allocations: { [state.teams[0].id]: 1 } }];
  state.invitations = [{ id: 'invite_private_test', fromId: state.voters[0].id, toId: state.voters[1].id, status: 'pending' }];
  state.decisions = [{ key: 'private_decision', reason: '不公开的合议记录' }];
  return state;
}

test('public guide returns only the exact event and player field whitelist', () => {
  const state = fixture(), guide = openGuide(state);
  assert.deepEqual(Object.keys(guide).sort(), ['event', 'players']);
  assert.deepEqual(guide.event, { name: state.event.name, date: SITE_CONFIG.date });
  assert.equal(guide.players.length, 2);
  for (const person of guide.players) {
    assert.deepEqual(Object.keys(person).sort(), ['name', 'profile', 'teamName']);
    assert.deepEqual(Object.keys(person.profile).sort(), [...FIELDS].sort());
    assert(Object.values(person.profile).every(value => typeof value === 'string'));
  }
  assert.equal(guide.players[0].teamName, '虚构合作队');
  assert.equal(guide.players[1].teamName, '');
  assert.deepEqual(guide.players[1].profile, Object.fromEntries(FIELDS.map(field => [field, ''])));
  assert.deepEqual(guide.players[0].profile, Object.fromEntries(FIELDS.map(field => [field, state.voters[0].profile[field]])));
});

test('private records, identifiers, contacts, scores and nonplayer profiles never enter the public projection', () => {
  const state = fixture(), encoded = JSON.stringify(openGuide(state));
  const hidden = [ADMIN, '不公开的单位', '不公开的职位', '不公开的备注', '不公开的额外资料',
    'private-field@example.invalid', 'private_wechat_field', '不在公开导览展示的作品',
    '不公开的观众姓名', '不公开的观众背景', '不公开的评委姓名', '不公开的评委介绍',
    'invite_private_test', 'private_decision', '不公开的合议记录'];
  for (const person of [...state.voters, ...state.judges]) hidden.push(person.id, person.phone, person.token, person.deviceHash);
  for (const team of state.teams) hidden.push(team.id, team.captainVoterId);
  for (const value of hidden.filter(Boolean)) assert(!encoded.includes(value));
});

test('obvious mobile numbers, emails and labelled WeChat handles are masked in every display field', () => {
  const state = fixture();
  state.event.name = '公开活动 联系 19900009001';
  state.voters[0].name = '称呼 person@example.com';
  state.teams[0].name = '队名 微信号: Team_12345';
  state.voters[0].profile = {
    background: '做教育，联系 +86 199-0000-9002；仍保留这段背景。',
    participation: '邮箱 first.last+test@example.com，备用 ＦＯＯ＠ｅｘａｍｐｌｅ．ｃｏｍ',
    directions: '微信：forest_123；微信号是 Maker_456；WeChat ID: Maker_789；继续做自然教育。',
    skills: 'VX: skill_123 / WX=other_456 / 加V hello_789 / wxid_secrethandle',
    experience: '电话 010-12345678；手机１９９００００９００１；weixin://dl/chat?wxid=secretlink；有 10 年经验。',
  };
  const guide = openGuide(state), encoded = JSON.stringify(guide);
  for (const hidden of ['19900009001', '199-0000-9002', 'person@example.com', 'first.last+test@example.com', 'FOO@example.com',
    'Team_12345', 'forest_123', 'Maker_456', 'Maker_789', 'skill_123', 'other_456', 'hello_789', 'wxid_secrethandle', '010-12345678', 'secretlink']) {
    assert(!encoded.includes(hidden), `contact was not masked: ${hidden}`);
  }
  assert(guide.players[0].profile.background.includes('仍保留这段背景'));
  assert(guide.players[0].profile.directions.includes('继续做自然教育'));
  assert(guide.players[0].profile.experience.includes('有 10 年经验'));
});

test('missing, nonstring and injected profile properties cannot introduce extra public fields', () => {
  const state = fixture();
  state.voters[0].profile = JSON.parse('{"background":{"phone":"19900009601","token":"nested-secret"},"participation":["array-secret"],"directions":null,"skills":42,"experience":"正常经验","__proto__":{"token":"prototype-secret"},"email":"hidden@example.invalid"}');
  const guide = openGuide(state);
  assert.deepEqual(guide.players[0].profile, { background: '', participation: '', directions: '', skills: '', experience: '正常经验' });
  assert.equal({}.token, undefined);
  state.voters[0].profile = undefined;
  assert.deepEqual(openGuide(state).players[0].profile, Object.fromEntries(FIELDS.map(field => [field, ''])));
});

test('building or changing a returned guide cannot mutate stored event, identities or profiles', () => {
  const state = fixture(), before = clone(state), guide = openGuide(state);
  assert.deepEqual(state, before);
  guide.event.name = '修改只读副本'; guide.players[0].name = '修改只读姓名';
  guide.players[0].profile.background = '修改只读背景'; guide.players.push({ name: '伪造选手' });
  assert.deepEqual(state, before);
  const guest = contextFor(state, 'guest', null);
  assert.equal('playerCards' in guest, false); assert.equal('invitations' in guest, false);
});

async function withHttp(t, state, readFailure = false) {
  let reads = 0, writes = 0;
  const server = createServer({ adminToken: ADMIN, publicOrigin: ORIGIN, basePath: BASE, store: {
    async read() { reads++; if (readFailure) throw new Error('PRIVATE_STORE_ERROR_WITH_SECRET'); return { state, version: 1 }; },
    async compareAndSwap() { writes++; throw new Error('public guide must never write'); },
  } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}${BASE}`;
  return { counts: () => ({ reads, writes }), async request(path = '/api/public-guide', authorization, method = 'GET') {
    const response = await fetch(base + path, { method, headers: {
      ...(authorization ? { Authorization: authorization } : {}),
      ...(method === 'POST' ? { 'Content-Type': 'application/json', Origin: ORIGIN } : {}),
    }, ...(method === 'POST' ? { body: '{}' } : {}) });
    const raw = await response.text();
    return { status: response.status, raw, body: raw ? JSON.parse(raw) : null, headers: response.headers };
  } };
}

test('guest, player, audience, judge, admin and invalid credentials all receive the identical safe guide without writes', async t => {
  const state = fixture(), before = clone(state), http = await withHttp(t, state), expected = publicGuideFor(state);
  const auth = [undefined, ...[state.voters[0].token, state.voters[2].token, state.judges[0].token, ADMIN, 'expired_private_token'].map(value => `Bearer ${value}`), 'Not-A-Bearer-Identity'];
  for (const value of auth) {
    const response = await http.request('/api/public-guide?role=admin&include=phone,token,score', value);
    assert.equal(response.status, 200); assert.deepEqual(response.body, expected);
    assert.match(response.headers.get('Content-Type'), /^application\/json/);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  }
  assert.deepEqual(state, before); assert.equal(http.counts().writes, 0);
  const guest = await http.request('/api/context');
  assert.equal(guest.body.role, 'guest'); assert.equal('playerCards' in guest.body, false);
  assert.equal((await http.request('/api/admin')).status, 403);
});

test('injected markup remains JSON text and cannot replace the response structure', async t => {
  const state = fixture();
  const text = '</script><img src=x onerror="alert(1)"> {"token":"FORGED_FIELD"}';
  state.voters[0].profile.background = text;
  const http = await withHttp(t, state), response = await http.request();
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type'), /^application\/json/);
  assert.deepEqual(response.body.players, []);
  assert.equal(openGuide(state).players[0].profile.background, text);
  assert.deepEqual(Object.keys(response.body).sort(), ['event', 'players']);
  assert.equal('token' in response.body, false);
  assert.equal(http.counts().writes, 0);
});

test('HEAD stays read-only and POST cannot turn the public guide into a mutation endpoint', async t => {
  const state = fixture(), before = clone(state), http = await withHttp(t, state);
  const head = await http.request('/api/public-guide', `Bearer ${ADMIN}`, 'HEAD');
  assert.equal(head.status, 200); assert.equal(head.raw, '');
  const post = await http.request('/api/public-guide', `Bearer ${ADMIN}`, 'POST');
  assert.equal(post.status, 404); assert.equal(http.counts().writes, 0); assert.deepEqual(state, before);
  assert.equal((await http.request('/api/teams/create', undefined, 'POST')).status, 401);
});

test('an unavailable store returns a generic error without leaking internal details or writing', async t => {
  const http = await withHttp(t, fixture(), true), response = await http.request();
  assert.equal(response.status, 503); assert(!response.raw.includes('PRIVATE_STORE_ERROR_WITH_SECRET'));
  assert.equal(http.counts().writes, 0);
});
