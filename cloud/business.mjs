import { randomBytes, randomInt, timingSafeEqual, createHash, createHmac } from 'node:crypto';
import { SITE_CONFIG } from './site-config.mjs';

export const WEIGHTS = [30, 25, 25, 20];
export class Problem extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const now = () => new Date().toISOString();
const token = () => randomBytes(24).toString('base64url');
const identifier = prefix => `${prefix}_${randomBytes(6).toString('hex')}`;
export function freshState() {
  return {
    event: { name: SITE_CONFIG.name, phase: 'setup', audienceEnabled: false, allowRepeat: false, entryMode: 'phone', teamsOpen: true },
    teams: [], judges: [], voters: [], scores: [], ballots: [], decisions: [],
  };
}
function text(value, label, min = 1, max = 160) {
  if (typeof value !== 'string') throw new Problem(`${label}必须是文字`);
  value = value.trim();
  const length = Array.from(value).length;
  if (length < min || length > max) throw new Problem(`${label}须为 ${min}～${max} 个字`);
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) throw new Problem(`${label}包含无效字符`);
  return value;
}
function integer(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Problem(`${label}须为 ${min}～${max} 的整数`);
  return value;
}
function boolean(value, label) {
  if (typeof value !== 'boolean') throw new Problem(`${label}必须是开关值`);
  return value;
}
function equalSecret(a, b) {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export function roleOf(state, supplied, adminToken, required = false) {
  if (supplied && (typeof supplied !== 'string' || !/^[\x00-\x7f]*$/.test(supplied))) {
    throw new Problem('票证无效，请向工作人员领取本场活动的入口', 401);
  }
  if (supplied && equalSecret(supplied, adminToken)) return ['admin', null];
  if (supplied) {
    for (const judge of state.judges) if (equalSecret(supplied, judge.token)) return ['judge', judge];
    for (const voter of state.voters) if (equalSecret(supplied, voter.token)) return [voter.role, voter];
    throw new Problem('票证无效，请向工作人员领取本场活动的入口', 401);
  }
  if (required) throw new Problem('请使用专属入口进入', 401);
  return ['guest', null];
}
export function requireRole(role, allowed) {
  if (!allowed.includes(role)) throw new Problem('当前身份不能进行此操作', 403);
}
function requirePhase(state, ...phases) {
  if (!phases.includes(state.event.phase)) throw new Problem('当前阶段不能进行此操作，请刷新页面查看状态', 409);
}
function teamById(state, id) {
  const team = state.teams.find(item => item.id === id);
  if (!team) throw new Problem('队伍不存在');
  return team;
}
// Draws store stable IDs only. Team names remain current, deleted teams are
// omitted, and later registrations stay visibly pending until the next draw.
export function presentationOrderFor(state) {
  const draw = state.presentationOrder;
  const teams = new Map(state.teams.map(team => [team.id, team]));
  const drawnIds = new Set(draw?.teamIds ?? []);
  const ordered = (draw?.teamIds ?? []).map(id => teams.get(id)).filter(Boolean);
  const publicTeam = ({ id, name, project }) => ({ id, name, project });
  return {
    revision: draw?.revision ?? 0, drawnAt: draw?.drawnAt ?? null,
    teams: ordered.map((team, index) => ({ ...publicTeam(team), position: index + 1 })),
    pendingTeams: state.teams.filter(team => !drawnIds.has(team.id)).map(publicTeam),
  };
}
const validDrawRequest = value => typeof value === 'string' && /^[A-Za-z0-9_-]{16,100}$/.test(value);
function drawPresentationOrder(state, payload, role) {
  requireRole(role, ['admin']);
  if (!validDrawRequest(payload.requestId)) throw new Problem('抽签请求编号无效，请刷新后再试');
  if (payload.expectedRevision !== undefined) integer(payload.expectedRevision, '路演顺序版本', 0, Number.MAX_SAFE_INTEGER);
  // A retry acknowledges the same persisted draw even if registration or the
  // event phase changed while the first response was travelling to the caller.
  if (state.presentationOrder?.requestId === payload.requestId) return { presentationOrder: presentationOrderFor(state) };
  requirePhase(state, 'setup', 'open', 'closed');
  const revision = state.presentationOrder?.revision ?? 0;
  if (payload.expectedRevision !== undefined && payload.expectedRevision !== revision) {
    throw new Problem('路演顺序已被更新，请刷新后查看最新结果再操作', 409);
  }
  if (!state.teams.length) throw new Problem('还没有队伍，请先完成组队后再抽签', 409);
  if (revision >= Number.MAX_SAFE_INTEGER) throw new Problem('路演抽签次数已达到上限', 409);
  const teamIds = state.teams.map(team => team.id);
  for (let index = teamIds.length - 1; index > 0; index--) {
    const other = randomInt(index + 1);
    [teamIds[index], teamIds[other]] = [teamIds[other], teamIds[index]];
  }
  state.presentationOrder = { teamIds, drawnAt: now(), revision: revision + 1, requestId: payload.requestId };
  return { presentationOrder: presentationOrderFor(state) };
}
function scoreValues(values) {
  if (!Array.isArray(values) || values.length !== 4) throw new Problem('请填写全部 4 项评分');
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Problem('评分必须是 0～10 的数字');
    if (value < 0 || value > 10 || !/^\d+(?:\.\d)?$/.test(String(value))) {
      throw new Problem('评分须在 0～10 之间，最多保留一位小数');
    }
  }
  return [...values];
}
// A score has one decimal place; integer weighted units retain all precision.
const scoreUnits = values => values.reduce((sum, value, i) => sum + Math.round(value * 10) * WEIGHTS[i], 0);
function gcd(a, b) { while (b) [a, b] = [b, a % b]; return a < 0n ? -a : a; }
function fraction(n, d = 1n) {
  const divisor = gcd(n, d);
  return { n: n / divisor, d: d / divisor };
}
const exactString = f => f.d === 1n ? String(f.n) : `${f.n}/${f.d}`;
function parseFraction(value) {
  const [n, d = '1'] = value.split('/');
  return { n: BigInt(n), d: BigInt(d) };
}
function compareFraction(a, b) {
  const left = parseFraction(a), right = parseFraction(b);
  const delta = left.n * right.d - right.n * left.d;
  return delta < 0n ? -1 : delta > 0n ? 1 : 0;
}
const tieKey = (kind, ids, value) => `${kind}|${value}|${[...ids].sort().join(',')}`;
// A participant's current team is the source of truth. Never write this
// derived restriction into the judge's permanent manual recusal records.
export function effectiveRecusals(state, judge) {
  const recusals = new Map(judge.recusals.map(recusal => [recusal.teamId, { ...recusal }]));
  const participant = state.voters.find(voter => voter.role === 'player' && voter.linkedJudgeId === judge.id);
  if (participant?.teamId && state.teams.some(team => team.id === participant.teamId)) {
    recusals.set(participant.teamId, { teamId: participant.teamId, reason: '本人作为选手参赛，本队自动回避', automatic: true });
  }
  return [...recusals.values()];
}
export function calculateResults(state) {
  const scoreMap = new Map(state.scores.map(score => [`${score.judgeId}|${score.teamId}`, score]));
  const recusals = new Map(state.judges.map(judge => [judge.id, new Set(effectiveRecusals(state, judge).map(r => r.teamId))]));
  const decisions = new Map(state.decisions.map(decision => [decision.key, decision]));
  const missing = [], jury = [], unresolved = [];
  let expectedTotal = 0, receivedTotal = 0;
  for (const team of state.teams) {
    const eligible = state.judges.filter(judge => !recusals.get(judge.id).has(team.id));
    const units = [];
    for (const judge of eligible) {
      const item = scoreMap.get(`${judge.id}|${team.id}`);
      if (item) units.push(scoreUnits(item.scores));
      else missing.push({ judgeId: judge.id, judgeName: judge.name, teamId: team.id, teamName: team.name });
    }
    const mean = units.length ? fraction(BigInt(units.reduce((a, b) => a + b, 0)), BigInt(1000 * units.length)) : null;
    expectedTotal += eligible.length;
    receivedTotal += units.length;
    jury.push({
      teamId: team.id, name: team.name, project: team.project,
      score: mean ? Math.round(Number(mean.n) / Number(mean.d) * 10000) / 10000 : null,
      scoreExact: mean ? exactString(mean) : '', received: units.length, expected: eligible.length,
      recused: state.judges.length - eligible.length, complete: eligible.length > 0 && units.length === eligible.length,
      rank: null, tied: false, resolved: true,
    });
  }
  jury.sort((a, b) => Number(!a.complete) - Number(!b.complete)
    || (a.scoreExact && b.scoreExact ? -compareFraction(a.scoreExact, b.scoreExact)
      : Number(!a.scoreExact) - Number(!b.scoreExact)) || a.teamId.localeCompare(b.teamId));
  const completeRows = jury.filter(row => row.complete);
  for (let index = 0; index < completeRows.length;) {
    const value = completeRows[index].scoreExact;
    const group = [];
    while (index + group.length < completeRows.length && completeRows[index + group.length].scoreExact === value) {
      group.push(completeRows[index + group.length]);
    }
    const ids = group.map(row => row.teamId), decision = decisions.get(tieKey('jury', ids, value));
    if (group.length > 1 && !decision) unresolved.push({ kind: 'jury', teamIds: ids });
    if (decision) group.sort((a, b) => decision.teamIds.indexOf(a.teamId) - decision.teamIds.indexOf(b.teamId));
    group.forEach((row, offset) => Object.assign(row, {
      rank: index + 1 + (decision ? offset : 0), tied: group.length > 1, resolved: group.length === 1 || Boolean(decision),
    }));
    completeRows.splice(index, group.length, ...group);
    index += group.length;
  }
  const orderedJury = [...completeRows, ...jury.filter(row => !row.complete)];
  const counts = new Map(state.teams.map(team => [team.id, 0]));
  for (const ballot of state.ballots) for (const [tid, count] of Object.entries(ballot.allocations)) counts.set(tid, counts.get(tid) + count);
  const popular = state.teams.map(team => ({
    teamId: team.id, name: team.name, votes: counts.get(team.id), rank: null, tied: false, resolved: true,
  })).sort((a, b) => b.votes - a.votes || a.teamId.localeCompare(b.teamId));
  if (popular.length && popular[0].votes > 0) {
    for (let index = 0; index < popular.length;) {
      const value = popular[index].votes, group = [];
      while (index + group.length < popular.length && popular[index + group.length].votes === value) group.push(popular[index + group.length]);
      const ids = group.map(row => row.teamId), decision = index === 0 ? decisions.get(tieKey('popular', ids, value)) : null;
      if (index === 0 && group.length > 1 && !decision) unresolved.push({ kind: 'popular', teamIds: ids });
      if (decision) group.sort((a, b) => decision.teamIds.indexOf(a.teamId) - decision.teamIds.indexOf(b.teamId));
      group.forEach((row, offset) => Object.assign(row, {
        rank: index + 1 + (decision ? offset : 0), tied: group.length > 1, resolved: group.length === 1 || Boolean(decision),
      }));
      popular.splice(index, group.length, ...group);
      index += group.length;
    }
  }
  const judgesDone = state.judges.filter(judge => state.teams.every(team =>
    recusals.get(judge.id).has(team.id) || scoreMap.has(`${judge.id}|${team.id}`))).length;
  return {
    jury: orderedJury, popular, missing, unresolvedTies: unresolved,
    ready: orderedJury.length > 0 && orderedJury.every(row => row.complete) && !unresolved.some(g => g.kind === 'jury'),
    tally: {
      judgesDone, expectedScores: expectedTotal, receivedScores: receivedTotal,
      submittedBallots: state.ballots.length, totalVoters: state.voters.filter(v => (v.role === 'player' ? Boolean(v.teamId) : state.event.audienceEnabled)).length,
      registeredVoters: state.voters.length, unteamedPlayers: state.voters.filter(v => v.role === 'player' && !v.teamId).length,
      disabledAudience: state.event.audienceEnabled ? 0 : state.voters.filter(v => v.role === 'audience').length,
      totalVotes: [...counts.values()].reduce((a, b) => a + b, 0),
    },
  };
}
export function buildSetup(payload) {
  const state = freshState();
  state.event = {
    name: text(payload.name, '活动名称', 1, 100), phase: 'setup',
    audienceEnabled: boolean(payload.audienceEnabled, '观众投票'), allowRepeat: boolean(payload.allowRepeat, '同队可投多票'),
  };
  if (state.event.allowRepeat) throw new Problem('本场规则为每人每队最多1票');
  if (!Array.isArray(payload.teams) || payload.teams.length < 2 || payload.teams.length > 100) throw new Problem('请设置 2～100 支队伍');
  if (!Array.isArray(payload.judges) || payload.judges.length < 1 || payload.judges.length > 100) throw new Problem('请设置 1～100 位评委');
  const audienceCount = integer(payload.audienceCount, '观众人数', 0, 500);
  if (!state.event.audienceEnabled && audienceCount) throw new Problem('已关闭观众投票，请将观众人数设为 0');
  const names = new Set();
  for (const item of payload.teams) {
    if (!isRecord(item)) throw new Problem('队伍信息格式不正确');
    const name = text(item.name, '队伍名称', 1, 60);
    if (names.has(name)) throw new Problem('队伍名称不能重复');
    names.add(name);
    const team = { id: identifier('team'), name, project: text(item.project ?? '', '作品名称', 0, 120), members: integer(item.members, '队员人数', 1, 20) };
    state.teams.push(team);
    for (let i = 0; i < team.members; i++) state.voters.push({
      id: identifier('voter'), name: `${name} · 选手 ${i + 1}`, role: 'player', teamId: team.id, token: token(), voteLimit: 3,
    });
  }
  for (const item of payload.judges) {
    if (!isRecord(item)) throw new Problem('评委信息格式不正确');
    state.judges.push({ id: identifier('judge'), name: text(item.name, '评委姓名', 1, 60), token: token(), recusals: [] });
  }
  for (let i = 0; i < audienceCount; i++) state.voters.push({
    id: identifier('voter'), name: `观众 ${i + 1}`, role: 'audience', teamId: null, token: token(), voteLimit: 2,
  });
  return state;
}
const currentVoteLimit = voter => voter.role === 'audience' ? 2 : 3;
const validStoredVoteLimit = voter => voter.role === 'player' ? voter.voteLimit === 3 : [2, 5].includes(voter.voteLimit);
function normalizeBallot(state, voter, payload, limit = currentVoteLimit(voter), newSubmission = true) {
  if (voter.role === 'player' && !voter.teamId) throw new Problem('请先完成组队后再参与投票', 403);
  if (!isRecord(payload.allocations) || !Object.keys(payload.allocations).length) throw new Problem('请至少选择 1 票');
  const result = {};
  for (const tid of Object.keys(payload.allocations).sort()) {
    const value = payload.allocations[tid];
    teamById(state, tid);
    integer(value, '每队票数', 0, limit);
    if (!value) continue;
    if (tid === voter.teamId) throw new Problem('选手不能投给本队');
    if (value > 1 && (!state.event.allowRepeat || (newSubmission && voter.role === 'audience'))) throw new Problem('本场活动每人对同一队最多投 1 票');
    result[tid] = value;
  }
  const total = Object.values(result).reduce((a, b) => a + b, 0);
  if (total < 1 || total > limit) throw new Problem(`本次须投 1～${limit} 票`);
  if (voter.role === 'audience' && !state.event.audienceEnabled) throw new Problem('本场活动未开放观众投票', 403);
  return result;
}
// Mobile numbers identify a pre-imported record. They are not verified by SMS.
export function normalizePhone(value) {
  if (typeof value !== 'string' || value.length > 32) throw new Problem('请填写正确的 11 位大陆手机号');
  let normalized = value.replace(/\s/g, '');
  if (normalized.startsWith('+86')) normalized = normalized.slice(3);
  else if (/^86\d{11}$/.test(normalized)) normalized = normalized.slice(2);
  if (!/^1[3-9]\d{9}$/.test(normalized)) throw new Problem('请填写正确的 11 位大陆手机号');
  return normalized;
}
const maskedPhone = value => value ? `${value.slice(0, 3)}****${value.slice(-4)}` : '';
const PROFILE_FIELDS = ['company', 'position', 'background', 'participation', 'directions', 'skills', 'experience', 'note'];
function cleanProfile(value) {
  if (!isRecord(value)) throw new Problem('报名资料格式不正确');
  const profile = {};
  for (const field of PROFILE_FIELDS) if (Object.hasOwn(value, field)) profile[field] = text(value[field], '报名资料', 0, 2000);
  return profile;
}
function hashDevice(value) {
  if (typeof value !== 'string' || !/^(?:[a-fA-F0-9]{64}|[A-Za-z0-9_-]{43})$/.test(value)) throw new Problem('入场设备信息无效，请刷新后再试');
  const bytes = Buffer.from(value, value.length === 64 ? 'hex' : 'base64url');
  if (bytes.length !== 32 || (value.length === 43 && bytes.toString('base64url') !== value)) throw new Problem('入场设备信息无效，请刷新后再试');
  return createHash('sha256').update(bytes).digest('hex');
}
// One event-specific shared entry capability for the organizer's judge QR code.
// It is derived on demand, never stored in the event, backup, or public context.
export function judgeEntryKey(adminToken) {
  return createHmac('sha256', adminToken).update('city-event-kit:judge-entry:v1').digest('base64url');
}
function loginJudge(state, payload, adminToken) {
  if (typeof payload.entryKey !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(payload.entryKey)
      || !equalSecret(payload.entryKey, judgeEntryKey(adminToken))) {
    throw new Problem('评委入口无效，请从工作人员提供的评委二维码进入', 401);
  }
  const name = text(payload.name, '评委姓名', 1, 60), deviceHash = hashDevice(payload.deviceKey);
  const judges = state.judges.filter(judge => judge.name === name);
  if (judges.length !== 1) {
    throw new Problem('评委身份无效，请从工作人员提供的评委入口进入', 401);
  }
  // Keep the first device as historical registration metadata. It is no longer
  // an authorization condition: every device reuses the same judge identity.
  judges[0].deviceHash ??= deviceHash;
  judges[0].enteredAt ??= now();
  return { token: judges[0].token };
}
function loginPhone(state, payload) {
  const phone = normalizePhone(payload.phone), deviceHash = hashDevice(payload.deviceKey);
  if (state.event.entryMode !== 'phone') throw new Problem('手机号入场暂未开放，请联系工作人员', 409);
  const people = [...state.voters, ...state.judges].filter(person => person.phone === phone);
  if (people.length !== 1) {
    throw new Problem('该手机号暂不能入场，请核对手机号或联系工作人员', 401);
  }
  people[0].deviceHash ??= deviceHash;
  people[0].enteredAt ??= now();
  return { token: people[0].token };
}
function registerAudience(state, payload) {
  const name = text(payload.name, '姓名 / 称呼', 1, 100), phone = normalizePhone(payload.phone), deviceHash = hashDevice(payload.deviceKey);
  if (state.event.entryMode !== 'phone') throw new Problem('观众手机号入场暂未开放，请联系工作人员', 409);
  const matches = [...state.voters, ...state.judges].filter(person => person.phone === phone);
  const existing = matches[0];
  if (matches.length > 1 || (existing && !['player', 'audience'].includes(existing.role))) {
    throw new Problem('该手机号暂不能通过观众入口进入，请联系工作人员', 401);
  }
  // Re-entry never changes an existing role, name, profile, vote or credential.
  // It remains available after registration closes so a person can read their receipt.
  if (existing) {
    existing.deviceHash ??= deviceHash;
    existing.enteredAt ??= now();
    return { token: existing.token };
  }
  // Prevent one device from creating multiple new audience identities; this
  // registration guard must never block a previously registered person.
  if ([...state.voters, ...state.judges].some(person => person.deviceHash && equalSecret(person.deviceHash, deviceHash))) {
    throw new Problem('此设备已关联其他入场身份，请使用原身份或联系工作人员', 401);
  }
  if (!state.event.audienceEnabled) throw new Problem('观众登记暂未开放，请联系工作人员', 409);
  requirePhase(state, 'setup', 'open');
  if (state.voters.length >= 2000) throw new Problem('本场报名人数已达到上限，请联系工作人员', 409);
  const person = { id: identifier('voter'), name, phone, role: 'audience', teamId: null, profile: {}, token: token(), voteLimit: 2, deviceHash, enteredAt: now() };
  state.voters.push(person);
  return { token: person.token };
}
function synchronizeTeams(state) {
  for (const team of state.teams) {
    const members = state.voters.filter(v => v.role === 'player' && v.teamId === team.id);
    team.members = members.length;
    if (!members.some(v => v.id === team.captainVoterId)) team.captainVoterId = members[0]?.id ?? null;
  }
}
function enablePhone(state) {
  // Existing legacy identities remain valid; setup can never regenerate them after this migration.
  for (const team of state.teams) {
    const members = state.voters.filter(v => v.role === 'player' && v.teamId === team.id);
    if (members.length > 4 || (members.length < 1 && team.organizerCreated !== true)) throw new Problem('现有队伍须先调整为每队 1～4 人才能启用自助组队', 409);
  }
  if (state.event.entryMode !== 'phone') state.event.teamsOpen = true;
  state.event.entryMode = 'phone';
  synchronizeTeams(state);
}
function validateJudgeLink(state, voter, existingId) {
  if (!Object.hasOwn(voter, 'linkedJudgeId')) return;
  const id = text(voter.linkedJudgeId, '关联评委编号', 1, 80);
  if (id !== voter.linkedJudgeId || voter.role !== 'player') throw new Problem('只有选手可以关联有效的评委身份');
  if (!state.judges.some(judge => judge.id === id)) throw new Problem('关联的评委不存在，请选择已有评委');
  if (state.voters.some(person => person.id !== existingId && person.linkedJudgeId === id)) throw new Problem('该评委已经关联另一位选手，不能重复绑定', 409);
  return id;
}
function updateRoster(state, route, payload, role) {
  requireRole(role, ['admin']);
  if (route === '/api/roster/reset-device') {
    const id = text(payload.personId, '人员编号', 1, 80);
    const person = [...state.voters, ...state.judges].find(p => p.id === id);
    if (!person) throw new Problem('人员不存在');
    person.token = token();
    delete person.deviceHash;
    delete person.enteredAt;
    return;
  }
  requirePhase(state, ...(route === '/api/roster/settings' ? ['setup', 'open'] : ['setup']));
  // Prepare a copy so failed batches cannot partially mutate a caller's state.
  const candidate = structuredClone(state);
  let response;
  if (route === '/api/roster/import') {
    if (!Array.isArray(payload.people) || !payload.people.length || payload.people.length > 500) throw new Problem('每次请导入 1～500 位报名人员');
    const seenPhones = new Set();
    let added = 0, updated = 0;
    for (const item of payload.people) {
      if (!isRecord(item)) throw new Problem('报名人员格式不正确');
      const phone = normalizePhone(item.phone), name = text(item.name, '姓名', 1, 100);
      if (seenPhones.has(phone)) throw new Problem('本次名单中存在重复手机号，请先合并重复行');
      seenPhones.add(phone);
      if (!['player', 'audience'].includes(item.role)) throw new Problem('报名身份须为选手或观众');
      const profile = cleanProfile(item.profile ?? {});
      if (candidate.judges.some(j => j.phone === phone)) throw new Problem('该手机号已用于评委身份，不能重复建立选手或观众票权');
      const previous = candidate.voters.find(v => v.phone === phone);
      const linkedJudgeId = validateJudgeLink(candidate, item, previous?.id);
      if (previous?.linkedJudgeId && linkedJudgeId !== undefined && linkedJudgeId !== previous.linkedJudgeId) {
        throw new Problem('现有选手已关联评委，不能改绑其他评委', 409);
      }
      if (previous) {
        if (previous.role !== item.role) throw new Problem('手机号对应的身份发生冲突，请核对名单，不能重复建立票权');
        previous.name = name;
        previous.profile = { ...previous.profile, ...profile };
        if (linkedJudgeId !== undefined) previous.linkedJudgeId = linkedJudgeId;
        updated++;
      } else {
        candidate.voters.push({ id: identifier('voter'), name, phone, profile, role: item.role, teamId: null, token: token(), voteLimit: item.role === 'player' ? 3 : 2,
          ...(linkedJudgeId !== undefined ? { linkedJudgeId } : {}) });
        added++;
      }
    }
    if (candidate.voters.length > 2000) throw new Problem('本场报名人数不能超过 2000 人');
    response = { added, updated };
  } else if (route === '/api/roster/judges') {
    if (!Array.isArray(payload.judges) || !payload.judges.length || payload.judges.length > 100) throw new Problem('请填写 1～100 位评委');
    const seenIds = new Set();
    let added = 0, updated = 0;
    for (const item of payload.judges) {
      if (!isRecord(item)) throw new Problem('评委信息格式不正确');
      const name = text(item.name, '评委姓名', 1, 60);
      let judge;
      if (item.id !== undefined) {
        judge = candidate.judges.find(j => j.id === text(item.id, '评委编号', 1, 80));
        if (!judge) throw new Problem('待修改的评委不存在');
      } else {
        const matches = candidate.judges.filter(j => j.name === name);
        if (matches.length > 1) throw new Problem('有同名评委，请选择具体评委后修改');
        judge = matches[0];
      }
      if (judge && seenIds.has(judge.id)) throw new Problem('本次名单包含重复评委');
      const phone = item.phone === undefined ? (judge?.phone ?? '') : (item.phone === '' || item.phone === null ? '' : normalizePhone(item.phone));
      const bio = item.bio === undefined ? (judge?.bio ?? '') : text(item.bio, '评委介绍', 0, 2000);
      if (phone && [...candidate.voters, ...candidate.judges].some(p => p.phone === phone && p.id !== judge?.id)) throw new Problem('评委手机号已对应其他身份，请核对后再保存');
      if (judge) {
        if ((judge.phone ?? '') !== phone) { judge.token = token(); delete judge.deviceHash; delete judge.enteredAt; }
        Object.assign(judge, { name, phone, bio }); updated++;
      } else {
        judge = { id: identifier('judge'), name, phone, bio, token: token(), recusals: [] };
        candidate.judges.push(judge); added++;
      }
      seenIds.add(judge.id);
    }
    if (candidate.judges.length > 100) throw new Problem('本场评委人数不能超过 100 人');
    response = { added, updated };
  } else if (route === '/api/roster/settings') {
    if (payload.teamsOpen !== undefined) candidate.event.teamsOpen = boolean(payload.teamsOpen, '开放组队');
    if (payload.audienceEnabled !== undefined) candidate.event.audienceEnabled = boolean(payload.audienceEnabled, '观众投票');
    if (payload.teamsOpen === undefined && payload.audienceEnabled === undefined) throw new Problem('请指定需要修改的设置');
  } else throw new Problem('接口不存在', 404);
  const requestedTeamsOpen = route === '/api/roster/settings' ? payload.teamsOpen : undefined;
  enablePhone(candidate);
  if (requestedTeamsOpen !== undefined) candidate.event.teamsOpen = requestedTeamsOpen;
  Object.assign(state, candidate);
  return response;
}
const WALL_PROFILE_FIELDS = ['background', 'participation', 'directions', 'skills', 'experience'];
const INVITATION_STATUSES = ['pending', 'accepted', 'declined', 'cancelled', 'expired'];
const MAX_INVITATIONS = 10000;
// Once any result refers to a team, its identity and membership must stay stable.
// Derived self-recusal is deliberately excluded: joining a team is not a result.
function teamHasResults(state, teamId) {
  return state.scores.some(score => score.teamId === teamId)
    || state.judges.some(judge => judge.recusals.some(recusal => recusal.teamId === teamId))
    || state.ballots.some(ballot => (ballot.allocations[teamId] ?? 0) > 0);
}
function playerHasBallot(state, person) {
  return state.ballots.some(ballot => ballot.voterId === person.id);
}
function requireMutableTeam(state, team) {
  if (teamHasResults(state, team.id)) throw new Problem('该队已有评分、回避或得票，队名、作品和队员已锁定', 409);
}
function requireUnvotedPlayer(state, person) {
  if (playerHasBallot(state, person)) throw new Problem('你已完成投票，不能再创建、加入或退出队伍', 409);
}
function invitationUnavailableReason(state, invitation) {
  const team = state.teams.find(t => t.id === invitation.teamId);
  const sender = state.voters.find(v => v.id === invitation.fromId && v.role === 'player');
  const recipient = state.voters.find(v => v.id === invitation.toId && v.role === 'player');
  if (!['setup', 'open'].includes(state.event.phase)) return '组队阶段已结束';
  if (!team) return '队伍已解散';
  if (teamHasResults(state, team.id)) return '该队已有评分、回避或得票，队员已锁定';
  if (!sender || sender.teamId !== team.id) return '邀请人已离开该队';
  if (!recipient) return '邀请对象已不可用';
  if (recipient.teamId) return recipient.teamId === team.id ? '已加入该队' : '已加入其他队伍';
  if (playerHasBallot(state, recipient)) return '对方已完成投票，不能再加入队伍';
  if (state.voters.filter(v => v.role === 'player' && v.teamId === team.id).length >= 4) return '队伍已满员';
  return '';
}
function expireInvitations(state) {
  for (const invitation of state.invitations ?? []) {
    if (invitation.status !== 'pending') continue;
    const reason = invitationUnavailableReason(state, invitation);
    if (reason) Object.assign(invitation, { status: 'expired', reason, respondedAt: now() });
  }
}
function updateInvitation(state, route, payload, role, person) {
  requireRole(role, ['player']); requirePhase(state, 'setup', 'open');
  if (state.event.entryMode !== 'phone') throw new Problem('当前未开放组队，请联系工作人员', 409);
  if (route === '/api/invitations/send') {
    if (!state.event.teamsOpen) throw new Problem('当前未开放组队，请联系工作人员', 409);
    if (!person.teamId) throw new Problem('请先创建或加入队伍，再邀请队友', 409);
    const team = teamById(state, person.teamId);
    requireMutableTeam(state, team);
    const targetId = text(payload.targetId, '邀请对象', 1, 80);
    const target = state.voters.find(v => v.id === targetId && v.role === 'player');
    if (!target) throw new Problem('邀请对象不存在');
    if (target.id === person.id) throw new Problem('不能邀请自己');
    if (target.teamId) throw new Problem('对方已加入队伍，请选择其他队友', 409);
    requireUnvotedPlayer(state, target);
    if (state.voters.filter(v => v.role === 'player' && v.teamId === team.id).length >= 4) throw new Problem('本队已有 4 人，不能继续邀请', 409);
    const existing = (state.invitations ?? []).find(i => i.teamId === team.id && i.toId === target.id && i.status === 'pending');
    if (existing) return { invitationId: existing.id };
    if ((state.invitations?.length ?? 0) >= MAX_INVITATIONS) throw new Problem('本场邀请记录已达到上限，请联系工作人员', 409);
    const invitation = {
      id: identifier('invite'), fromId: person.id, toId: target.id, teamId: team.id, teamName: team.name,
      status: 'pending', createdAt: now(), respondedAt: null, reason: '',
    };
    state.invitations ??= [];
    state.invitations.push(invitation);
    return { invitationId: invitation.id };
  }
  const id = text(payload.invitationId, '邀请编号', 1, 80);
  const invitation = (state.invitations ?? []).find(i => i.id === id);
  if (!invitation) throw new Problem('邀请不存在');
  if (route === '/api/invitations/respond') {
    if (invitation.toId !== person.id) throw new Problem('只有收到邀请的本人可以处理', 403);
    if (!['accept', 'decline'].includes(payload.action)) throw new Problem('请选择接受或拒绝邀请');
    if (invitation.status === 'accepted' && payload.action === 'accept' && person.teamId === invitation.teamId) return { invitationId: invitation.id, teamId: invitation.teamId };
    if (invitation.status === 'declined' && payload.action === 'decline') return { invitationId: invitation.id };
    if (invitation.status !== 'pending') throw new Problem(invitation.reason || '这条邀请已处理，请刷新页面', 409);
    if (payload.action === 'decline') {
      Object.assign(invitation, { status: 'declined', reason: '已拒绝邀请', respondedAt: now() });
      return { invitationId: invitation.id };
    }
    if (!state.event.teamsOpen) throw new Problem('当前未开放组队，请联系工作人员', 409);
    const unavailable = invitationUnavailableReason(state, invitation);
    if (unavailable) throw new Problem(unavailable, 409);
    requireUnvotedPlayer(state, person);
    person.teamId = invitation.teamId;
    Object.assign(invitation, { status: 'accepted', reason: '', respondedAt: now() });
    synchronizeTeams(state);
    expireInvitations(state);
    return { invitationId: invitation.id, teamId: invitation.teamId };
  }
  if (route === '/api/invitations/cancel') {
    const team = state.teams.find(t => t.id === invitation.teamId);
    if (invitation.fromId !== person.id && team?.captainVoterId !== person.id) throw new Problem('只有邀请人或该队队长可以取消邀请', 403);
    if (invitation.status === 'cancelled') return { invitationId: invitation.id };
    if (invitation.status !== 'pending') throw new Problem(invitation.reason || '这条邀请已处理，请刷新页面', 409);
    Object.assign(invitation, { status: 'cancelled', reason: '邀请已取消', respondedAt: now() });
    return { invitationId: invitation.id };
  }
  throw new Problem('接口不存在', 404);
}
function playerCards(state) {
  return state.voters.filter(person => person.role === 'player').map(person => ({
    id: person.id, name: person.name, teamId: person.teamId,
    profile: Object.fromEntries(WALL_PROFILE_FIELDS.filter(field => Object.hasOwn(person.profile ?? {}, field)).map(field => [field, person.profile[field]])),
  }));
}
function invitationViews(state, role, person) {
  return (state.invitations ?? []).filter(invitation => role === 'admin' || invitation.toId === person.id
    || invitation.fromId === person.id || (person.teamId && invitation.teamId === person.teamId)).map(invitation => {
    const team = state.teams.find(t => t.id === invitation.teamId);
    let status = invitation.status, reason = invitation.reason ?? '';
    if (status === 'pending') {
      const unavailable = invitationUnavailableReason(state, invitation);
      if (unavailable) { status = 'expired'; reason = unavailable; }
      else if (!state.event.teamsOpen) reason = '当前暂未开放组队';
    }
    return {
      id: invitation.id, fromId: invitation.fromId, fromName: state.voters.find(v => v.id === invitation.fromId)?.name ?? '',
      toId: invitation.toId, toName: state.voters.find(v => v.id === invitation.toId)?.name ?? '',
      teamId: invitation.teamId, teamName: team?.name ?? invitation.teamName,
      status, createdAt: invitation.createdAt, respondedAt: invitation.respondedAt ?? null, reason,
    };
  });
}

const TEAM_TRACKS = ['dining', 'detective', 'office', 'short-drama', 'opc', 'game'];
function teamTrackFields(value) {
  if (!Object.hasOwn(value, 'track')) return {};
  if (typeof value.track !== 'string' || !TEAM_TRACKS.includes(value.track)) throw new Problem('请选择有效的六大赛道');
  return { track: value.track };
}
function importTeams(state, payload, role) {
  requireRole(role, ['admin']); requirePhase(state, 'setup');
  if (state.event.entryMode !== 'phone') throw new Problem('请先导入选手名单，再导入队伍', 409);
  if (!Array.isArray(payload.teams) || payload.teams.length < 1 || payload.teams.length > 100) throw new Problem('每次请导入 1～100 支队伍');
  const candidate = structuredClone(state), names = new Set(), assigned = new Set();
  const fields = ['name', 'project', 'track', 'captainPhone', 'memberPhones'];
  const plans = payload.teams.map(item => {
    if (!isRecord(item) || Object.keys(item).some(field => !fields.includes(field))) throw new Problem('队伍导入包含未知字段或格式不正确');
    const name = text(item.name, '队伍名称', 1, 60), project = text(item.project ?? '', '作品名称', 0, 120);
    if (names.has(name)) throw new Problem('本次导入中队伍名称重复，请先合并');
    names.add(name);
    if (!Array.isArray(item.memberPhones) || item.memberPhones.length > 4) throw new Problem('每支队伍须提供 0～4 位已登记选手的手机号');
    const phones = item.memberPhones.map(normalizePhone);
    if (new Set(phones).size !== phones.length) throw new Problem('同一队伍内的队员手机号不能重复');
    const captainPhone = item.captainPhone === undefined || item.captainPhone === '' ? null : normalizePhone(item.captainPhone);
    // CSVs commonly list the captain in a separate column. Count that person
    // once even if also repeated in the member column, and never invent them.
    if (captainPhone && !phones.includes(captainPhone)) phones.unshift(captainPhone);
    if (phones.length > 4) throw new Problem('包含队长在内，每支队伍最多 4 位已登记选手');
    const existing = candidate.teams.find(team => team.name === name);
    const id = existing?.id ?? identifier('team');
    const trackFields = Object.hasOwn(item, 'track') ? teamTrackFields(item) : existing && Object.hasOwn(existing, 'track') ? { track: existing.track } : {};
    const members = phones.map(phone => {
      const person = candidate.voters.find(voter => voter.phone === phone && voter.role === 'player');
      if (!person) throw new Problem('队伍中有尚未登记的选手或非选手身份，请先核对选手名单');
      if (assigned.has(person.id)) throw new Problem('同一位选手不能同时出现在多个导入队伍中');
      assigned.add(person.id);
      if (person.teamId && person.teamId !== id) throw new Problem('有选手已属于其他队伍，不能通过导入直接换队', 409);
      return person;
    });
    const captain = captainPhone ? members.find(person => person.phone === captainPhone)
      : members.find(person => person.id === existing?.captainVoterId) ?? members[0];
    const captainVoterId = captain?.id ?? null;
    const previousMembers = existing ? candidate.voters.filter(voter => voter.role === 'player' && voter.teamId === id) : [];
    const changed = !existing || project !== existing.project || trackFields.track !== existing.track
      || captainVoterId !== existing.captainVoterId || members.length !== previousMembers.length
      || previousMembers.some(person => !members.some(member => member.id === person.id));
    if (changed && existing) requireMutableTeam(candidate, existing);
    if (changed) {
      for (const person of [...members, ...previousMembers]) {
        if (person.teamId !== id || !members.some(member => member.id === person.id)) requireUnvotedPlayer(candidate, person);
      }
    }
    return { existing, id, name, project, trackFields, members, previousMembers, captainVoterId };
  });
  const added = plans.filter(plan => !plan.existing).length;
  if (candidate.teams.length + added > 100) throw new Problem('本场队伍数量已达到上限', 409);
  for (const plan of plans) {
    for (const person of plan.previousMembers) if (!plan.members.some(member => member.id === person.id)) person.teamId = null;
    for (const person of plan.members) person.teamId = plan.id;
    if (plan.existing) Object.assign(plan.existing, { project: plan.project, captainVoterId: plan.captainVoterId, ...plan.trackFields,
      ...(plan.members.length === 0 ? { organizerCreated: true } : {}) });
    else candidate.teams.push({ id: plan.id, name: plan.name, project: plan.project, members: plan.members.length,
      captainVoterId: plan.captainVoterId, organizerCreated: true, ...plan.trackFields });
  }
  synchronizeTeams(candidate); expireInvitations(candidate);
  Object.assign(state, candidate);
  return { added, updated: plans.length - added };
}
function updateTeam(state, route, payload, role, person) {
  if (route === '/api/teams/import') return importTeams(state, payload, role);
  if (route === '/api/teams/admin-create') {
    requireRole(role, ['admin']); requirePhase(state, 'setup', 'open');
    if (state.event.entryMode !== 'phone') throw new Problem('请先启用手机号入场后再补录队伍', 409);
    const name = text(payload.name, '队伍名称', 1, 60), project = text(payload.project ?? '', '作品名称', 0, 120);
    const trackFields = teamTrackFields(payload);
    const existing = state.teams.find(team => team.name === name);
    if (existing) {
      if (existing.project === project && existing.track === trackFields.track) return { teamId: existing.id };
      throw new Problem('这个队名已被使用，现有作品或赛道不同，请核对后再补录', 409);
    }
    if (state.teams.length >= 100) throw new Problem('本场队伍数量已达到上限', 409);
    const team = { id: identifier('team'), name, project, members: 0, captainVoterId: null, organizerCreated: true, ...trackFields };
    state.teams.push(team);
    return { teamId: team.id };
  }
  requireRole(role, ['player']); requirePhase(state, 'setup', 'open');
  if (state.event.entryMode !== 'phone' || !state.event.teamsOpen) throw new Problem('当前未开放组队，请联系工作人员', 409);
  const current = person.teamId ? teamById(state, person.teamId) : null;
  if (route === '/api/teams/create') {
    const name = text(payload.name, '队伍名称', 1, 60), project = text(payload.project ?? '', '作品名称', 0, 120);
    if (current) {
      if (current.captainVoterId === person.id && current.name === name && current.project === project) return { teamId: current.id };
      throw new Problem('你已加入队伍，请先退出当前队伍', 409);
    }
    requireUnvotedPlayer(state, person);
    if (state.teams.some(t => t.name === name)) throw new Problem('这个队名已被使用，请换一个队名', 409);
    if (state.teams.length >= 100) throw new Problem('本场队伍数量已达到上限', 409);
    const team = { id: identifier('team'), name, project, members: 1, captainVoterId: person.id };
    state.teams.push(team); person.teamId = team.id;
    expireInvitations(state);
    return { teamId: team.id };
  }
  if (route === '/api/teams/join') {
    const team = teamById(state, payload.teamId);
    if (current) {
      if (current.id === team.id) return { teamId: team.id };
      throw new Problem('你已加入队伍，请先退出当前队伍', 409);
    }
    requireUnvotedPlayer(state, person);
    requireMutableTeam(state, team);
    if (state.voters.filter(v => v.role === 'player' && v.teamId === team.id).length >= 4) throw new Problem('该队已有 4 人，请选择其他队伍', 409);
    person.teamId = team.id; synchronizeTeams(state);
    expireInvitations(state);
    return { teamId: team.id };
  }
  if (route === '/api/teams/leave') {
    if (!current) return;
    requireUnvotedPlayer(state, person);
    requireMutableTeam(state, current);
    person.teamId = null; synchronizeTeams(state);
    state.teams = state.teams.filter(t => t.members > 0 || t.organizerCreated === true);
    expireInvitations(state);
    return;
  }
  if (route === '/api/teams/update') {
    if (!current || current.captainVoterId !== person.id) throw new Problem('只有队长可以修改队名和作品名称', 403);
    const name = text(payload.name, '队伍名称', 1, 60), project = text(payload.project ?? '', '作品名称', 0, 120);
    if (current.name === name && current.project === project) return { teamId: current.id };
    requireMutableTeam(state, current);
    if (state.teams.some(t => t.id !== current.id && t.name === name)) throw new Problem('这个队名已被使用，请换一个队名', 409);
    Object.assign(current, { name, project });
    return { teamId: current.id };
  }
  throw new Problem('接口不存在', 404);
}

export function updateState(state, route, payload, suppliedToken, adminToken) {
  if (!isRecord(payload)) throw new Problem('请求内容格式不正确');
  if (route === '/api/login') return loginPhone(state, payload);
  if (route === '/api/judges/login') return loginJudge(state, payload, adminToken);
  if (route === '/api/audience/register') return registerAudience(state, payload);
  const [role, person] = roleOf(state, suppliedToken, adminToken, true);
  if (route.startsWith('/api/roster/')) return updateRoster(state, route, payload, role);
  if (route.startsWith('/api/teams/')) return updateTeam(state, route, payload, role, person);
  if (route.startsWith('/api/invitations/')) return updateInvitation(state, route, payload, role, person);
  if (route === '/api/presentation-order') return drawPresentationOrder(state, payload, role);
  if (route === '/api/setup') {
    requireRole(role, ['admin']); requirePhase(state, 'setup');
    if (state.event.entryMode === 'phone') throw new Problem('手机号入场已启用，请在名单管理中增量导入或修改，不能重新生成票证', 409);
    const replacement = buildSetup(payload);
    for (const key of Object.keys(state)) delete state[key];
    Object.assign(state, replacement);
  } else if (route === '/api/phase') {
    requireRole(role, ['admin']);
    const old = state.event.phase, next = payload.phase;
    if (!['setup|open', 'open|closed', 'closed|open', 'closed|published'].includes(`${old}|${next}`)) throw new Problem('阶段切换不被允许', 409);
    if (old === 'setup' && (state.event.entryMode === 'phone' ? !state.judges.length : state.teams.length < 2 || !state.judges.length)) {
      throw new Problem(state.event.entryMode === 'phone' ? '请先保存至少 1 位评委' : '请先保存至少 2 支队伍和 1 位评委');
    }
    if (next === 'published') {
      const results = calculateResults(state);
      if (results.jury.some(row => row.expected === 0)) throw new Problem('有队伍的全部评委均已回避，不能发布，请保留数据并联系工作人员', 409);
      if (results.missing.length) throw new Problem('仍有应评成绩未提交，暂不能发布', 409);
      if (results.unresolvedTies.some(group => group.kind === 'jury')) throw new Problem('存在尚未合议的评委同分，请先完成同分处理', 409);
      if (!results.ready) throw new Problem('请先完成至少 1 支队伍的全部评分，暂不能发布', 409);
    }
    if (old === 'closed' && next === 'open') state.decisions = [];
    if (next === 'published' && state.event.publishedAt === undefined) state.event.publishedAt = now();
    state.event.phase = next;
    if (state.event.entryMode === 'phone' && ['closed', 'published'].includes(next)) state.event.teamsOpen = false;
    expireInvitations(state);
  } else if (route === '/api/score') {
    requireRole(role, ['judge']); requirePhase(state, 'open');
    const tid = payload.teamId; teamById(state, tid);
    if (effectiveRecusals(state, person).some(r => r.teamId === tid)) throw new Problem('你已对该队回避，不能评分', 409);
    const values = scoreValues(payload.scores);
    state.scores = state.scores.filter(score => score.judgeId !== person.id || score.teamId !== tid);
    state.scores.push({ judgeId: person.id, teamId: tid, scores: values, weightedScore: scoreUnits(values) / 1000, updatedAt: now() });
    expireInvitations(state);
  } else if (route === '/api/recuse') {
    requireRole(role, ['judge']); requirePhase(state, 'open');
    const tid = payload.teamId; teamById(state, tid);
    const reason = text(payload.reason, '回避原因', 1, 500);
    if (effectiveRecusals(state, person).some(r => r.teamId === tid)) throw new Problem('你已对该队回避', 409);
    person.recusals.push({ teamId: tid, reason });
    state.scores = state.scores.filter(score => score.judgeId !== person.id || score.teamId !== tid);
    expireInvitations(state);
  } else if (route === '/api/vote') {
    requireRole(role, ['player', 'audience']); requirePhase(state, 'open');
    const existing = state.ballots.find(ballot => ballot.voterId === person.id);
    // A historical five-vote receipt may be acknowledged again, but never changed.
    // Every first submission follows the current two-vote audience rule.
    const allocations = normalizeBallot(state, person, payload, existing ? person.voteLimit : currentVoteLimit(person), !existing);
    if (existing) {
      if (JSON.stringify(existing.allocations) !== JSON.stringify(allocations)) throw new Problem('你已完成最终投票，不能修改或重复投票', 409);
    } else state.ballots.push({ voterId: person.id, allocations, submittedAt: now() });
    expireInvitations(state);
  } else if (route === '/api/tie') {
    requireRole(role, ['admin']);
    const kind = payload.kind, ids = payload.teamIds;
    requirePhase(state, ...(kind === 'popular' ? ['closed', 'published'] : ['closed']));
    if (!['jury', 'popular'].includes(kind) || !Array.isArray(ids) || ids.length < 2) throw new Problem('同分处理格式不正确');
    if (ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new Problem('合议名单中每支队伍只能出现一次');
    const results = calculateResults(state);
    const group = results.unresolvedTies.find(g => g.kind === kind && g.teamIds.length === ids.length && g.teamIds.every(id => ids.includes(id)));
    if (!group) throw new Problem('此名单不是当前需要处理的完整同分组，请刷新后重试', 409);
    const row = results[kind === 'jury' ? 'jury' : 'popular'].find(row => row.teamId === ids[0]);
    state.decisions.push({
      kind, teamIds: [...ids], reason: text(payload.reason, '合议记录', 1, 1000),
      key: tieKey(kind, ids, row[kind === 'jury' ? 'scoreExact' : 'votes']), decidedAt: now(),
    });
  } else throw new Problem('接口不存在', 404);
}
function validPublishedAt(value) {
  if (typeof value !== 'string') throw new Problem('备份公布时间格式不正确');
  const parts = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts) throw new Problem('备份公布时间格式不正确');
  const wall = `${parts[1]}.${(parts[2] ?? '').padEnd(3, '0')}Z`;
  if (!Number.isFinite(Date.parse(wall)) || new Date(wall).toISOString() !== wall || !Number.isFinite(Date.parse(value))) throw new Problem('备份公布时间格式不正确');
  return value;
}
function publicationFields(event) {
  if (!Object.hasOwn(event, 'publishedAt')) return {};
  if (event.phase !== 'published') throw new Problem('尚未公布的备份不能带有公布时间');
  return { publishedAt: validPublishedAt(event.publishedAt) };
}
function certificateDate(event) {
  // Existing published backups are intentionally not rewritten just to add a clock value.
  if (event.publishedAt === undefined) return SITE_CONFIG.date;
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(validPublishedAt(event.publishedAt)));
  const value = type => parts.find(part => part.type === type).value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}
function certificatesFor(state, person, results) {
  if (state.event.phase !== 'published' || person.role !== 'player' || !person.teamId) return [];
  const team = state.teams.find(item => item.id === person.teamId);
  if (!team || typeof team.project !== 'string' || !team.project.trim()) return [];
  const date = certificateDate(state.event);
  const descriptor = (kind, title, rank = null) => {
    // Stable identity IDs survive device resets and all supported backup versions.
    // Domain and event scope avoid using a phone, token, display name, or the current clock.
    const eventScope = [SITE_CONFIG.name, SITE_CONFIG.city, SITE_CONFIG.date];
    const digest = createHash('sha256').update(JSON.stringify(['city-event-kit:certificate:v1', eventScope, person.id, team.id, kind])).digest('hex').slice(0, 16).toUpperCase();
    return { kind, title, personName: person.name, teamName: team.name, project: team.project, city: SITE_CONFIG.city, rank, date,
      issuer: SITE_CONFIG.certificateIssuer, eventName: SITE_CONFIG.name,
      number: `CE-${{ participation: 'P', top3: 'T', popular: 'R' }[kind]}-${digest}` };
  };
  const certificates = [descriptor('participation', '参赛证书')];
  const jury = results.jury.find(row => row.teamId === team.id);
  if (jury?.complete && jury.resolved && Number.isInteger(jury.rank) && jury.rank >= 1 && jury.rank <= 3
      && !results.unresolvedTies.some(group => group.kind === 'jury')) {
    certificates.push(descriptor('top3', '城市前三获奖证书', jury.rank));
  }
  const popular = results.popular.find(row => row.teamId === team.id);
  if (popular?.rank === 1 && popular.votes > 0 && popular.resolved
      && !results.unresolvedTies.some(group => group.kind === 'popular')) {
    certificates.push(descriptor('popular', '人气奖获奖证书'));
  }
  return certificates;
}

export function publicResults(results) { return { ...results, missing: [] }; }
function publicGuideText(value) {
  if (typeof value !== 'string') return '';
  // Keep descriptions as plain text. Normalize common full-width contact
  // characters and invisible separators before masking recognizable contacts.
  return value
    .replace(/[０-９Ａ-Ｚａ-ｚ＠＋－＿．]/g, character => character.normalize('NFKC'))
    .replace(/[\u200b-\u200f\u2060\ufeff]/g, '')
    .replace(/[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]+@(?:[\p{L}\p{N}-]+\.)+[\p{L}]{2,63}/gu, '[邮箱已隐藏]')
    .replace(/(?<!\d)(?:(?:\+?86|0086)[\s().-]*)?1[3-9](?:[\s().-]*\d){9}(?!\d)/g, '[手机号已隐藏]')
    .replace(/((?:联系电话|电话号码|手机号|手机|电话|\btelephone\b|\bphone\b|\btel\b)\s*(?:[:：=]|是|为)?\s*)\+?\d[\d\s()（）.-]{5,24}\d/gi, '$1[电话已隐藏]')
    .replace(/((?:微\s*信(?:号|\s*ID)?\s*(?:[:：=]|是|为)?\s*|(?:加|添加|联系)\s*[vV]\s*[:：=]?\s*|\b(?:WeChat|WeiXin)(?:\s*ID)?\s*[:：=]\s*|\b(?:VX|WX)\s*[:：=]\s*))[A-Za-z][A-Za-z0-9_-]{5,31}/gi, '$1[微信已隐藏]')
    .replace(/\bwxid_[A-Za-z0-9_-]{3,}\b/gi, '[微信已隐藏]')
    .replace(/weixin:\/\/[^\s<>"'，。；、）)]+/gi, '[微信联系方式已隐藏]');
}
export function publicEventFor(state) {
  return { event: structuredClone(SITE_CONFIG), judges: state.judges.map(judge => ({
    name: publicGuideText(judge.name), bio: publicGuideText(judge.bio ?? ''),
  })) };
}
export function publicGuideFor(state, siteConfig = SITE_CONFIG) {
  const teams = new Map(state.teams.map(team => [team.id, team.name]));
  return {
    event: { name: publicGuideText(state.event.name), date: siteConfig.date },
    players: siteConfig.publicPlayerWall ? state.voters.filter(person => person.role === 'player').map(person => ({
      name: publicGuideText(person.name), teamName: publicGuideText(teams.get(person.teamId) ?? ''),
      profile: Object.fromEntries(WALL_PROFILE_FIELDS.map(field => [field,
        publicGuideText(isRecord(person.profile) && Object.hasOwn(person.profile, field) ? person.profile[field] : ''),
      ])),
    })) : [],
  };
}
// Backup validation preserves already cast historical ballots under the stored
// two- or five-vote allowance. This internal path cannot create a new live vote.
function restoreBallot(state, ballot) {
  const voter = state.voters.find(person => person.id === ballot.voterId);
  if (!voter) throw new Problem('备份投票者不存在');
  const allocations = normalizeBallot(state, voter, ballot, voter.voteLimit, false);
  state.ballots.push({ voterId: voter.id, allocations, submittedAt: text(ballot.submittedAt, '投票时间', 1, 80) });
}
export function contextFor(state, role, person) {
  const result = { role, event: state.event, presentationOrder: presentationOrderFor(state), teams: state.teams.map(({ id, name, project, members, captainVoterId, track }) => ({
    id, name, project, ...(track !== undefined ? { track } : {}), ...(state.event.entryMode === 'phone' ? { locked: teamHasResults(state, id) } : {}),
    ...(role === 'guest' ? {} : { members, maxMembers: 4, captainVoterId: captainVoterId ?? null,
      memberNames: state.voters.filter(v => v.role === 'player' && v.teamId === id).map(v => v.name) }),
  })) };
  if (role === 'judge') {
    result.judge = { id: person.id, name: person.name, recusals: effectiveRecusals(state, person), phoneMasked: maskedPhone(person.phone), bio: person.bio ?? '' };
    result.scores = state.scores.filter(score => score.judgeId === person.id);
  } else if (role === 'player' || role === 'audience') {
    const { id, name, role: voterRole, teamId } = person;
    result.identity = { id, name, role: voterRole, teamId, voteLimit: currentVoteLimit(person), phoneMasked: maskedPhone(person.phone), profile: person.profile ?? {} };
    result.ballot = state.ballots.find(ballot => ballot.voterId === person.id) ?? null;
  }
  if (state.event.entryMode === 'phone' && ['player', 'admin'].includes(role)) {
    result.playerCards = playerCards(state);
    result.invitations = invitationViews(state, role, person);
  }
  if (role === 'admin') result.effectiveRecusals = Object.fromEntries(state.judges.map(judge => [judge.id, effectiveRecusals(state, judge)]));
  const publishedResults = state.event.phase === 'published' ? calculateResults(state) : null;
  if (publishedResults) result.results = publicResults(publishedResults);
  if (role === 'player') result.certificates = publishedResults ? certificatesFor(state, person, publishedResults) : [];
  return result;
}
function validRestoreTables(original, extra = []) {
  return Object.keys(original).filter(key => key !== 'presentationOrder').sort().join('|')
    === [...Object.keys(freshState()), ...extra].sort().join('|');
}
function restoredPresentationFields(original) {
  if (!Object.hasOwn(original, 'presentationOrder')) return {};
  const draw = original.presentationOrder;
  if (!isRecord(draw) || Object.keys(draw).sort().join('|') !== ['teamIds', 'drawnAt', 'revision', 'requestId'].sort().join('|')) {
    throw new Problem('备份路演顺序包含未知或缺失的字段');
  }
  // Historical IDs may refer to teams that subsequently emptied and vanished.
  // Keep the draw intact; the public projection never manufactures those teams.
  if (!Array.isArray(draw.teamIds) || draw.teamIds.length < 1 || draw.teamIds.length > 100
      || draw.teamIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(id))
      || new Set(draw.teamIds).size !== draw.teamIds.length) throw new Problem('备份路演队伍编号重复或格式不正确');
  integer(draw.revision, '备份路演顺序版本', 1, Number.MAX_SAFE_INTEGER);
  if (!validDrawRequest(draw.requestId)) throw new Problem('备份抽签请求编号格式不正确');
  try { validPublishedAt(draw.drawnAt); } catch { throw new Problem('备份抽签时间格式不正确'); }
  return { presentationOrder: { teamIds: [...draw.teamIds], drawnAt: draw.drawnAt, revision: draw.revision, requestId: draw.requestId } };
}
export function validateRestore(document) {
  if (isRecord(document) && document.schemaVersion === 3) return validateInvitationRestore(document);
  if (isRecord(document) && document.schemaVersion === 2) return validatePhoneRestore(document);
  if (!isRecord(document) || document.schemaVersion !== 1) throw new Problem('备份版本不受支持');
  const original = document.state;
  if (!isRecord(original)) throw new Problem('备份缺少数据');
  if (original.event?.entryMode === 'phone') throw new Problem('手机号入场数据必须使用版本 2 备份');
  try {
    if (!validRestoreTables(original)) throw new Problem('备份包含未知或缺失的数据表');
    const presentationFields = restoredPresentationFields(original);
    const event = original.event;
    if (!['setup', 'open', 'closed', 'published'].includes(event.phase)) throw new Problem('备份阶段不正确');
    const publishedFields = publicationFields(event);
    if (boolean(event.allowRepeat, '同队可投多票')) throw new Problem('本场规则为每人每队最多1票');
    boolean(event.audienceEnabled, '观众投票');
    for (const name of ['teams', 'judges', 'voters', 'scores', 'ballots', 'decisions']) if (!Array.isArray(original[name])) throw new Problem('备份数据缺失或格式损坏');
    if (original.voters.some(voter => isRecord(voter) && Object.hasOwn(voter, 'linkedJudgeId'))) throw new Problem('关联评委身份必须使用手机号模式备份，不能降级为旧版备份');
    if (!original.teams.length && !original.judges.length && event.phase === 'setup') {
      if (['voters', 'scores', 'ballots', 'decisions'].some(name => original[name].length)) throw new Problem('空白备份包含无效数据');
      const result = freshState();
      result.event = { name: text(event.name, '活动名称', 1, 100), phase: 'setup', audienceEnabled: event.audienceEnabled, allowRepeat: false };
      return Object.assign(result, presentationFields);
    }
    const rebuilt = buildSetup({
      name: event.name, teams: original.teams, judges: original.judges, audienceEnabled: event.audienceEnabled,
      allowRepeat: event.allowRepeat, audienceCount: original.voters.filter(voter => voter.role === 'audience').length,
    });
    if (rebuilt.voters.length !== original.voters.length) throw new Problem('备份票证人数与名单不一致');
    const seenIds = new Set(), seenTokens = new Set();
    for (const collection of ['teams', 'judges', 'voters']) for (const item of original[collection]) {
      const id = text(item.id, '记录编号', 1, 80);
      if (!/^[A-Za-z0-9_-]+$/.test(id) || seenIds.has(id)) throw new Problem('备份编号重复或无效');
      seenIds.add(id);
      if (collection !== 'teams') {
        const value = text(item.token, '票证', 24, 128);
        if (!/^[A-Za-z0-9_-]+$/.test(value) || seenTokens.has(value)) throw new Problem('备份票证重复或无效');
        seenTokens.add(value);
      }
    }
    const result = freshState();
    result.event = { ...rebuilt.event, ...publishedFields, phase: 'open' };
    result.teams = original.teams.map(t => ({ id: t.id, name: t.name.trim(), project: (t.project ?? '').trim(), members: t.members }));
    result.judges = original.judges.map(j => ({ id: j.id, name: j.name.trim(), token: j.token, recusals: [] }));
    const teamMembers = new Map(result.teams.map(team => [team.id, 0]));
    for (const voter of original.voters) {
      if (!['player', 'audience'].includes(voter.role)) throw new Problem('备份投票身份不正确');
      if (voter.role === 'player') { teamById(result, voter.teamId); teamMembers.set(voter.teamId, teamMembers.get(voter.teamId) + 1); }
      else if (voter.teamId !== null) throw new Problem('观众不能绑定队伍');
      if (!validStoredVoteLimit(voter)) throw new Problem('备份票数上限不正确');
      result.voters.push({ id: voter.id, name: text(voter.name, '投票者姓名', 1, 100), role: voter.role, teamId: voter.teamId, token: voter.token, voteLimit: voter.voteLimit });
    }
    if (result.teams.some(team => teamMembers.get(team.id) !== team.members)) throw new Problem('备份选手人数与队伍不一致');
    const fakeAdmin = token(), judgeTokens = new Map(result.judges.map(j => [j.id, j.token]));
    for (const judge of original.judges) for (const recusal of judge.recusals) updateState(result, '/api/recuse', recusal, judgeTokens.get(judge.id), fakeAdmin);
    const pairs = new Set();
    for (const score of original.scores) {
      const pair = `${score.judgeId}|${score.teamId}`;
      if (pairs.has(pair)) throw new Problem('备份包含重复评分');
      pairs.add(pair); updateState(result, '/api/score', score, judgeTokens.get(score.judgeId), fakeAdmin);
      result.scores.at(-1).updatedAt = text(score.updatedAt, '评分时间', 1, 80);
    }
    const voted = new Set();
    for (const ballot of original.ballots) {
      if (voted.has(ballot.voterId)) throw new Problem('备份包含重复投票');
      voted.add(ballot.voterId); restoreBallot(result, ballot);
    }
    if (event.phase === 'setup' && (result.scores.length || result.ballots.length)) throw new Problem('准备阶段不应存在评分或投票');
    result.event.phase = 'closed';
    for (const decision of original.decisions) {
      updateState(result, '/api/tie', decision, fakeAdmin, fakeAdmin);
      result.decisions.at(-1).decidedAt = text(decision.decidedAt, '合议时间', 1, 80);
    }
    if (['setup', 'open'].includes(event.phase) && original.decisions.length) throw new Problem('开放阶段不应存在合议结果');
    if (event.phase === 'published') updateState(result, '/api/phase', { phase: 'published' }, fakeAdmin, fakeAdmin);
    else result.event.phase = event.phase;
    if (!Object.hasOwn(event, 'publishedAt')) delete result.event.publishedAt;
    return Object.assign(result, presentationFields);
  } catch (error) {
    if (error instanceof Problem) throw error;
    throw new Problem('备份数据缺失或格式损坏');
  }
}
function validatePhoneRestore(document) {
  const original = document.state;
  try {
    if (!isRecord(original) || !validRestoreTables(original)) throw new Problem('备份包含未知或缺失的数据表');
    const presentationFields = restoredPresentationFields(original);
    const event = original.event;
    if (isRecord(event) && Object.keys(event).some(key => !['name', 'phase', 'audienceEnabled', 'allowRepeat', 'entryMode', 'teamsOpen', 'publishedAt'].includes(key))) throw new Problem('备份活动设置包含未知字段');
    if (!isRecord(event) || event.entryMode !== 'phone' || !['setup', 'open', 'closed', 'published'].includes(event.phase)) throw new Problem('手机号备份的活动设置不正确');
    const publishedFields = publicationFields(event);
    if (boolean(event.allowRepeat, '同队可投多票')) throw new Problem('本场规则为每人每队最多1票');
    boolean(event.teamsOpen, '开放组队'); boolean(event.audienceEnabled, '观众投票');
    if (['closed', 'published'].includes(event.phase) && event.teamsOpen) throw new Problem('评分关闭或公布后不能开放组队');
    const limits = { teams: 100, judges: 100, voters: 2000, scores: 10000, ballots: 2000, decisions: 100 };
    for (const [field, max] of Object.entries(limits)) {
      if (!Array.isArray(original[field]) || original[field].length > max || original[field].some(item => !isRecord(item))) throw new Problem('备份数据缺失或格式损坏');
    }
    if (event.phase !== 'setup' && !original.judges.length) throw new Problem('已开放评分的备份须有至少 1 位评委');
    const seenIds = new Set(), seenTokens = new Set(), seenPhones = new Set(), seenNames = new Set();
    const result = freshState();
    result.event = { name: text(event.name, '活动名称', 1, 100), phase: 'open', audienceEnabled: event.audienceEnabled, allowRepeat: false, entryMode: 'phone', teamsOpen: false, ...publishedFields };
    const allowedRecordFields = {
      teams: ['id', 'name', 'project', 'members', 'captainVoterId', 'track', 'organizerCreated'],
      judges: ['id', 'name', 'token', 'recusals', 'phone', 'bio', 'deviceHash', 'enteredAt'],
      voters: ['id', 'name', 'token', 'role', 'teamId', 'voteLimit', 'phone', 'profile', 'deviceHash', 'enteredAt', 'linkedJudgeId'],
    };
    for (const collection of ['teams', 'judges', 'voters']) for (const item of original[collection]) {
      if (Object.keys(item).some(key => !allowedRecordFields[collection].includes(key))) throw new Problem('备份人员或队伍包含未知字段');
      const id = text(item.id, '记录编号', 1, 80);
      if (!/^[A-Za-z0-9_-]+$/.test(id) || seenIds.has(id)) throw new Problem('备份编号重复或无效');
      seenIds.add(id);
      if (collection !== 'teams') {
        const credential = text(item.token, '票证', 24, 128);
        if (!/^[A-Za-z0-9_-]+$/.test(credential) || seenTokens.has(credential)) throw new Problem('备份票证重复或无效');
        seenTokens.add(credential);
        if (item.phone) {
          const phone = normalizePhone(item.phone);
          if (phone !== item.phone || seenPhones.has(phone)) throw new Problem('备份手机号重复或格式不正确');
          seenPhones.add(phone);
        } else if (item.phone !== undefined && item.phone !== '') throw new Problem('备份手机号格式不正确');
        if (item.deviceHash !== undefined && ((collection === 'voters' && !item.phone) || typeof item.deviceHash !== 'string' || !/^[a-f0-9]{64}$/.test(item.deviceHash))) throw new Problem('备份设备信息不正确');
        if (item.enteredAt !== undefined && !item.deviceHash) throw new Problem('备份入场记录缺少设备信息');
      }
    }
    const privateFields = item => ({
      ...(item.phone !== undefined ? { phone: item.phone } : {}),
      ...(item.deviceHash !== undefined ? { deviceHash: item.deviceHash } : {}),
      ...(item.enteredAt !== undefined ? { enteredAt: text(item.enteredAt, '入场时间', 1, 80) } : {}),
    });
    result.teams = original.teams.map(team => {
      const name = text(team.name, '队伍名称', 1, 60);
      if (seenNames.has(name)) throw new Problem('备份队名重复');
      seenNames.add(name);
      if (Object.hasOwn(team, 'organizerCreated') && team.organizerCreated !== true) throw new Problem('备份补录队伍标记不正确');
      const organizerFields = team.organizerCreated === true ? { organizerCreated: true } : {};
      const members = integer(team.members, '队员人数', team.organizerCreated === true ? 0 : 1, 4);
      if (members === 0 && team.captainVoterId !== null) throw new Problem('备份空队伍不能指定队长');
      const captainVoterId = members === 0 && team.organizerCreated === true
        ? null
        : text(team.captainVoterId, '队长编号', 1, 80);
      return { id: team.id, name, project: text(team.project, '作品名称', 0, 120), members, captainVoterId, ...organizerFields, ...teamTrackFields(team) };
    });
    result.judges = original.judges.map(judge => {
      if (!Array.isArray(judge.recusals) || judge.recusals.length > original.teams.length) throw new Problem('备份回避记录不正确');
      return { id: judge.id, name: text(judge.name, '评委姓名', 1, 60), token: judge.token, recusals: [], ...privateFields(judge),
        ...(judge.bio !== undefined ? { bio: text(judge.bio, '评委介绍', 0, 2000) } : {}) };
    });
    result.voters = original.voters.map(voter => {
      if (!['player', 'audience'].includes(voter.role)) throw new Problem('备份投票身份不正确');
      if (voter.role === 'player') { if (voter.teamId !== null) teamById(result, voter.teamId); }
      else if (voter.teamId !== null) throw new Problem('观众不能绑定队伍');
      if (!validStoredVoteLimit(voter)) throw new Problem('备份票数上限不正确');
      if (voter.profile !== undefined && (!isRecord(voter.profile) || Object.keys(voter.profile).some(key => !PROFILE_FIELDS.includes(key)))) throw new Problem('备份报名资料包含未知字段');
      return { id: voter.id, name: text(voter.name, '投票者姓名', 1, 100), role: voter.role, teamId: voter.teamId, token: voter.token, voteLimit: voter.voteLimit,
        ...privateFields(voter), ...(voter.profile !== undefined ? { profile: cleanProfile(voter.profile) } : {}),
        ...(Object.hasOwn(voter, 'linkedJudgeId') ? { linkedJudgeId: voter.linkedJudgeId } : {}) };
    });
    for (const voter of result.voters) validateJudgeLink(result, voter, voter.id);
    for (const team of result.teams) {
      const members = result.voters.filter(v => v.role === 'player' && v.teamId === team.id);
      const validEmptyTeam = team.organizerCreated === true && members.length === 0 && team.captainVoterId === null;
      if (members.length !== team.members || (!validEmptyTeam && !members.some(v => v.id === team.captainVoterId))) throw new Problem('备份队员人数或队长与报名名单不一致');
    }
    const fakeAdmin = token(), judgeTokens = new Map(result.judges.map(j => [j.id, j.token]));
    for (const judge of original.judges) for (const recusal of judge.recusals) updateState(result, '/api/recuse', recusal, judgeTokens.get(judge.id), fakeAdmin);
    const pairs = new Set();
    for (const score of original.scores) {
      const pair = `${score.judgeId}|${score.teamId}`;
      if (pairs.has(pair)) throw new Problem('备份包含重复评分');
      pairs.add(pair); updateState(result, '/api/score', score, judgeTokens.get(score.judgeId), fakeAdmin);
      result.scores.at(-1).updatedAt = text(score.updatedAt, '评分时间', 1, 80);
    }
    const voted = new Set();
    for (const ballot of original.ballots) {
      if (voted.has(ballot.voterId)) throw new Problem('备份包含重复投票');
      voted.add(ballot.voterId); restoreBallot(result, ballot);
    }
    if (event.phase === 'setup' && (result.scores.length || result.ballots.length || result.judges.some(j => j.recusals.length))) throw new Problem('准备阶段不应存在评分、回避或投票');
    result.event.phase = 'closed';
    for (const decision of original.decisions) {
      updateState(result, '/api/tie', decision, fakeAdmin, fakeAdmin);
      result.decisions.at(-1).decidedAt = text(decision.decidedAt, '合议时间', 1, 80);
    }
    if (['setup', 'open'].includes(event.phase) && original.decisions.length) throw new Problem('开放阶段不应存在合议结果');
    if (event.phase === 'published') updateState(result, '/api/phase', { phase: 'published' }, fakeAdmin, fakeAdmin);
    else result.event.phase = event.phase;
    result.event.teamsOpen = event.teamsOpen;
    if (!Object.hasOwn(event, 'publishedAt')) delete result.event.publishedAt;
    return Object.assign(result, presentationFields);
  } catch (error) {
    if (error instanceof Problem) throw error;
    throw new Problem('备份数据缺失或格式损坏');
  }
}

function validateInvitationRestore(document) {
  const original = document.state;
  try {
    if (!isRecord(original) || !validRestoreTables(original, ['invitations'])) throw new Problem('邀请备份包含未知或缺失的数据表');
    if (!Array.isArray(original.invitations) || original.invitations.length > MAX_INVITATIONS) throw new Problem('邀请备份记录格式不正确');
    const base = { ...original }; delete base.invitations;
    const result = validatePhoneRestore({ schemaVersion: 2, state: base });
    const usedIds = new Set([...result.teams, ...result.voters, ...result.judges].map(person => person.id));
    const pendingPairs = new Set();
    const allowed = ['id', 'fromId', 'toId', 'teamId', 'teamName', 'status', 'createdAt', 'respondedAt', 'reason'];
    const validId = value => {
      const id = text(value, '邀请记录编号', 1, 80);
      if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Problem('邀请备份编号格式不正确');
      return id;
    };
    const validTimestamp = value => {
      const stamp = text(value, '邀请时间', 1, 80);
      if (!Number.isFinite(Date.parse(stamp))) throw new Problem('邀请备份时间格式不正确');
      return stamp;
    };
    result.invitations = original.invitations.map(item => {
      if (!isRecord(item) || Object.keys(item).sort().join('|') !== [...allowed].sort().join('|')) throw new Problem('邀请备份包含未知或缺失的字段');
      const id = validId(item.id), fromId = validId(item.fromId), toId = validId(item.toId), teamId = validId(item.teamId);
      if (usedIds.has(id)) throw new Problem('邀请备份编号重复');
      usedIds.add(id);
      if (fromId === toId || !result.voters.some(v => v.id === fromId && v.role === 'player') || !result.voters.some(v => v.id === toId && v.role === 'player')) throw new Problem('邀请备份发送人或收件人不存在');
      if (!INVITATION_STATUSES.includes(item.status)) throw new Problem('邀请备份状态不正确');
      const invitation = { id, fromId, toId, teamId, teamName: text(item.teamName, '邀请队伍名称', 1, 60), status: item.status,
        createdAt: validTimestamp(item.createdAt), respondedAt: item.respondedAt === null ? null : validTimestamp(item.respondedAt), reason: text(item.reason, '邀请状态说明', 0, 500) };
      if (invitation.status === 'pending') {
        if (invitation.respondedAt !== null || invitation.reason !== '' || invitationUnavailableReason(result, invitation)) throw new Problem('邀请备份含有已不可接受的待处理邀请');
        const pair = `${teamId}|${toId}`;
        if (pendingPairs.has(pair)) throw new Problem('邀请备份存在重复待处理邀请');
        pendingPairs.add(pair);
      } else {
        if (!invitation.respondedAt) throw new Problem('已处理邀请缺少处理时间');
        if (invitation.status !== 'accepted' && !invitation.reason) throw new Problem('已结束邀请缺少状态说明');
      }
      // Historical teams may have been emptied and deleted after an invitation ended.
      // Their stored teamName preserves the history without manufacturing a live team.
      return invitation;
    });
    return result;
  } catch (error) {
    if (error instanceof Problem) throw error;
    throw new Problem('邀请备份数据缺失或格式损坏');
  }
}

function safeCell(value) {
  let valueText = value === null || value === undefined ? '' : String(value);
  if (/^[\s]*[=+\-@]/.test(valueText) || /^[\t\r\n]/.test(valueText)) valueText = "'" + valueText;
  return '"' + valueText.replaceAll('"', '""') + '"';
}
export function exportCsv(state) {
  const results = calculateResults(state), lines = [];
  const row = (...values) => lines.push(values.map(safeCell).join(','));
  row('活动', state.event.name, '阶段', state.event.phase, '导出时间', now());
  row('本地前三规则', '完成度与可用性30%、创意25%、场景价值25%、展示20%；有效评委加权分的平均分；精确同分合议');
  row('投票规则', '每位选手最多3票、不投本队；观众最多2票', '每人每队最多1票'); row();
  row('评委汇总', '队伍', '作品', '平均分', '精确分数', '已评', '应评', '回避', '完整', '名次', '同分', '已合议');
  for (const r of results.jury) row('评委汇总', r.name, r.project, r.score, r.scoreExact, r.received, r.expected, r.recused, r.complete, r.rank, r.tied, r.resolved);
  row(); row('人气汇总', '队伍', '票数', '名次', '同票', '已合议');
  for (const r of results.popular) row('人气汇总', r.name, r.votes, r.rank, r.tied, r.resolved);
  const teams = new Map(state.teams.map(t => [t.id, t.name])), judges = new Map(state.judges.map(j => [j.id, j.name])), voters = new Map(state.voters.map(v => [v.id, v.name]));
  row(); row('原始评分', '评委', '队伍', '完成度与可用性', '创意', '场景价值', '展示', '加权分', '时间');
  for (const s of state.scores) row('原始评分', judges.get(s.judgeId), teams.get(s.teamId), ...s.scores, s.weightedScore, s.updatedAt);
  row(); row('回避记录', '评委', '队伍', '原因');
  for (const judge of state.judges) for (const r of effectiveRecusals(state, judge)) row('回避记录', judge.name, teams.get(r.teamId), r.reason);
  row(); row('投票记录', '投票者', '队伍', '票数', '时间');
  for (const ballot of state.ballots) for (const [tid, count] of Object.entries(ballot.allocations)) row('投票记录', voters.get(ballot.voterId), teams.get(tid), count, ballot.submittedAt);
  row(); row('合议记录', '奖项', '决定顺序', '理由', '时间');
  for (const decision of state.decisions) row('合议记录', decision.kind === 'jury' ? '本地前三' : '人气奖', decision.teamIds.map(id => teams.get(id)).join(' > '), decision.reason, decision.decidedAt);
  return '\ufeff' + lines.join('\r\n') + '\r\n';
}
