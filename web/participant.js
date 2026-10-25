import {json,refresh} from './app.js';
import {$,$$,escape,toast,labels,weights,phaseLabels,rulesBlock,modal,formatScore,icon} from './common.js';
import {renderAwards} from './results.js';
import {renderCertificates,bindCertificates} from './certificates.js';
import {renderTeamRoom,bindTeamRoom} from './team-room.js';
import {playerView,renderPlayerNav,renderPlayerWall,renderInvitations,renderOwnPlayerCard,bindPlayerViews} from './player-wall.js';

const trackNames={dining:'用餐赛道',detective:'侦探赛道',office:'办公赛道','short-drama':'短剧赛道',opc:'OPC赛道',game:'游戏赛道'};
const selectedTeams = new Map();
const scoreKey = (judgeId,teamId) => `rating_score_draft:${judgeId}:${teamId}`;
const voteKey = id => `rating_vote_draft:${id}`;
function readDraft(key) {
  try { return JSON.parse(sessionStorage.getItem(key)||'null'); } catch { return null; }
}
function writeDraft(key,value) {
  try { sessionStorage.setItem(key,JSON.stringify(value)); } catch { /* An unavailable browser store must not block the form. */ }
}
function clearDraft(key) {
  try { sessionStorage.removeItem(key); } catch { /* The server remains authoritative. */ }
}
function scoreFor(ctx,teamId) { return (ctx.scores||[]).find(s=>s.teamId===teamId); }
function recusalFor(ctx,teamId) { return (ctx.judge.recusals||[]).find(r=>r.teamId===teamId); }
function selectedTeam(ctx) {
  const remembered=ctx.teams.find(t=>t.id===selectedTeams.get(ctx.judge.id));
  const team=remembered||ctx.teams.find(t=>!recusalFor(ctx,t.id)&&!scoreFor(ctx,t.id))||ctx.teams[0];
  if(team)selectedTeams.set(ctx.judge.id,team.id);
  return team;
}
function redraw(ctx) {
  const main=$('#app main');
  if(!main)return;
  main.innerHTML=renderParticipant(ctx);
  bindParticipant(ctx);
}
function weighted(values) {
  if(values.length!==4||values.some(v=>String(v).trim()===''||!Number.isFinite(Number(v))||Number(v)<0||Number(v)>10))return null;
  return values.reduce((sum,v,i)=>sum+Number(v)*weights[i]/100,0);
}
function heading(ctx,title,person,description='') {
  return `<div class="participant-heading"><span class="state-tag">${escape(phaseLabels[ctx.event.phase]||ctx.event.phase)}</span><h1>${title}</h1><p>${escape(person)}</p>${description?`<p class="muted">${escape(description)}</p>`:''}</div>`;
}
function phaseNotice(ctx) {
  if(ctx.event.phase==='setup')return ctx.role==='audience'?'<div class="notice">观众登记已完成。请等待主持人开放人气投票，页面会自动更新。</div>':'<div class="notice">名单已就绪，请等待主持人开放评分与投票。</div>';
  if(ctx.event.phase==='closed')return '<div class="notice">评分与投票已截止，主持人正在核对结果。</div>';
  return '';
}
function scoreValues(ctx,team) {
  const saved=scoreFor(ctx,team.id);
  const draft=ctx.event.phase==='open'?readDraft(scoreKey(ctx.judge.id,team.id)):null;
  if(Array.isArray(draft)&&draft.length===4&&draft.every(v=>typeof v==='string'||typeof v==='number'))return draft.map(String);
  return saved?saved.scores.map(String):['','','',''];
}
function renderJudge(ctx) {
  const introduction=heading(ctx,'评委评分',ctx.judge.name,'每项 0—10 分，可填一位小数。各队加权得分取评委平均分，同分合议。');
  if(ctx.event.phase==='published')return renderAwards(ctx);
  const rules=`<section class="panel judge-rules"><h2>评分标准</h2>${rulesBlock()}<p class="muted">本人参赛的队伍会自动回避；与其他队存在利益关系时，请主动回避。回避队伍不计入你的评审。</p></section>`;
  if(ctx.event.phase==='setup')return introduction+phaseNotice(ctx)+rules;
  const team=selectedTeam(ctx);
  if(!team)return introduction+phaseNotice(ctx)+rules+'<div class="empty">选手正在组队。创建队伍后会自动出现在这里，可选择队伍填写分数。</div>';
  const isOpen=ctx.event.phase==='open',recusal=recusalFor(ctx,team.id),saved=scoreFor(ctx,team.id),values=scoreValues(ctx,team);
  const choices=`<section class="panel judge-choices-panel"><h2>选择队伍</h2><div class="judge-team-picker"><label for="score-team-picker">当前评分队伍</label><select id="score-team-picker">${ctx.teams.map(t=>`<option value="${escape(t.id)}"${t.id===team.id?' selected':''}>${escape(t.name)} · ${recusalFor(ctx,t.id)?(recusalFor(ctx,t.id).automatic?'本队自动回避':'回避'):scoreFor(ctx,t.id)?'已交':'待评'}</option>`).join('')}</select></div><div class="team-list judge-team-cards">${ctx.teams.map(t=>{
    const score=scoreFor(ctx,t.id),excluded=recusalFor(ctx,t.id);
    return `<button type="button" class="team-choice${t.id===team.id?' selected':''}" data-score-team="${escape(t.id)}" aria-pressed="${t.id===team.id}"><strong>${escape(t.name)}</strong><span class="muted">${trackNames[t.track]?escape(trackNames[t.track])+' · ':''}${escape(t.project||'')}</span><span class="state-tag">${excluded?(excluded.automatic?'本队自动回避':'已回避'):score?`已提交 · ${formatScore(score.weightedScore)} 分`:'待评分'}</span></button>`;
  }).join('')}</div></section>`;
  const content=recusal?`<div class="notice"><strong>${recusal.automatic?'本队自动回避':'你已回避此队'}</strong><p>${escape(recusal.reason)}</p><p class="muted">${recusal.automatic?'你同时以选手身份参加这支队伍，本队由其他未回避评委评分。':'不参与此队评分，回避声明不可撤销。'}</p></div>`:`<form id="score-form" data-team-id="${escape(team.id)}"><div class="score-grid">${labels.map((label,i)=>`<label class="score-field" for="score-${i}"><span>${label} <small>${weights[i]}%</small></span><input id="score-${i}" name="score${i}" data-score-input type="number" min="0" max="10" step="0.1" inputmode="decimal" required placeholder="0—10" value="${escape(values[i])}"${isOpen?'':' readonly'}></label>`).join('')}</div><div class="score-summary"><span>${isOpen?'本次加权分':'已提交加权分'}</span><strong id="weighted-score">${weighted(values)===null?'待填写完整':`${formatScore(weighted(values))} / 10`}</strong></div><p class="muted" id="score-draft-note">${isOpen?'填写时自动保留本机草稿；点击提交后才计入结果。':'这里只显示已提交的评分，未提交草稿不计入结果。'}</p>${isOpen?`<div class="button-row"><button class="primary" type="submit">${saved?'保存修改':'提交评分'} ${icon('check')}</button><button class="secondary" type="button" id="recuse-team">利益相关，回避此队</button></div>`:''}</form>`;
  return `${introduction}${phaseNotice(ctx)}${rules}${choices}<section class="panel"><h2 id="selected-team-heading" tabindex="-1">${escape(team.name)}</h2><p class="muted">${trackNames[team.track]?escape(trackNames[team.track])+' · ':''}${escape(team.project||'')}</p>${saved&&!recusal?'<p class="success">评分已提交'+(isOpen?'，截止前可以修改。':'。')+'</p>':''}${content}</section>`;
}
function receipt(ctx) {
  if(!ctx.ballot)return '';
  const selected=Object.entries(ctx.ballot.allocations||{}).filter(([,count])=>count>0);
  const date=ctx.ballot.submittedAt?new Date(ctx.ballot.submittedAt):null;
  const time=date&&!Number.isNaN(date.getTime())?date.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):null;
  return `<section class="panel receipt"><span class="state-tag">已提交</span><h2>${icon('check')} 你的投票已保存</h2><p class="success">已收到保存确认，请勿重复投票。</p>${time?`<p class="muted">提交时间：${escape(time)}（北京时间）</p>`:'<p class="muted">提交时间将在重新连接后显示。</p>'}<ul>${selected.map(([id,count])=>`<li>${escape(ctx.teams.find(t=>t.id===id)?.name||'已记录队伍')} <strong>${escape(count)} 票</strong></li>`).join('')}</ul><p class="muted">此次共投 ${selected.reduce((sum,[,count])=>sum+Number(count),0)} 票，提交后不可修改。</p></section>`;
}
function ballotChoices(ctx) {
  const allowed=new Set(ctx.teams.filter(t=>ctx.role!=='player'||t.id!==ctx.identity.teamId).map(t=>t.id));
  const stored=readDraft(voteKey(ctx.identity.id));
  return new Set((Array.isArray(stored)?stored:[]).filter(id=>typeof id==='string'&&allowed.has(id)).slice(0,ctx.identity.voteLimit));
}
function renderVoter(ctx) {
  const team=ctx.teams.find(t=>t.id===ctx.identity.teamId);
  const person=`${ctx.identity.name}${ctx.role==='player'?(team?` · 本队：${team.name}`:' · 尚未组队'):' · 观众'}`;
  const introduction=heading(ctx,'投出你的人气票',person,`最多 ${ctx.identity.voteLimit} 票，每队最多 1 票${ctx.role==='player'?'，不能投本队':''}。允许少投，提交后不可修改。${ctx.role==='player'?'每位选手都有自己的票，队友分别投票。':''}`);
  if(ctx.event.phase==='published')return renderAwards(ctx);
  if(ctx.ballot)return `${heading(ctx,'我的投票记录',person,'已提交的投票记录保留，不能重复投票。')}${phaseNotice(ctx)}${receipt(ctx)}`;
  if(ctx.event.entryMode==='phone'&&ctx.role==='audience'&&!ctx.event.audienceEnabled)return heading(ctx,'我的观众页',ctx.identity.name)+'<div class="notice">本场暂未开放观众投票。你可以观看展示，开放后页面会自动更新。</div>';
  if(ctx.event.phase==='setup')return introduction+phaseNotice(ctx);
  if(ctx.event.phase!=='open')return `${introduction}${phaseNotice(ctx)}<section class="panel empty">你尚未提交人气票，本轮投票已截止。</section>`;
  if(!ctx.teams.length)return `${introduction}<div class="notice">投票已开放。等待选手登记队伍，队伍创建后会自动出现在这里。</div>`;
  const selected=ballotChoices(ctx),limit=ctx.identity.voteLimit;
  return `${introduction}<section class="panel"><h2>把票投给让你心动的作品</h2><p class="muted">每选一队消耗 1 票。${ctx.event.audienceEnabled?'选手和观众票数统一计入人气奖。':'本场由选手互投。'}人气票与评委分数分别统计。</p><form id="vote-form"><div class="team-list">${ctx.teams.map(t=>{
    const own=ctx.role==='player'&&t.id===ctx.identity.teamId,checked=selected.has(t.id);
    return `<label class="team-choice${own?' disabled':''}${checked?' selected':''}"><input type="checkbox" name="team" value="${escape(t.id)}" data-vote-team${own?' data-own-team="true"':''}${checked?' checked':''}${own||(!checked&&selected.size>=limit)?' disabled':''}><span><strong>${escape(t.name)}</strong><span class="muted">${trackNames[t.track]?escape(trackNames[t.track])+' · ':''}${escape(t.project||'')}</span></span>${own?'<span class="state-tag">本队 · 不可投</span>':''}</label>`;
  }).join('')}</div><div class="score-summary" aria-live="polite"><span id="vote-count">已选 ${selected.size} 队</span><strong id="vote-remaining">还可选 ${Math.max(0,limit-selected.size)} 队</strong></div><p class="muted">不必用完所有票；至少选择 1 队。未提交前可以调整。</p><button class="primary full" type="submit" id="submit-vote"${selected.size?'':' disabled'}>确认我的选择 ${icon('arrow')}</button></form></section>`;
}
export function renderParticipant(ctx) {
  if(ctx.event.phase==='published'){
    const certificateSection=ctx.role==='player'?renderCertificates(ctx):'';
    const personalReceipt=ctx.ballot?`<details class="published-vote-receipt"><summary>我的投票记录</summary>${receipt(ctx)}</details>`:'';
    return renderAwards(ctx)+certificateSection+personalReceipt;
  }
  if(ctx.event.entryMode==='phone'&&ctx.role==='player'){
    const nav=renderPlayerNav(ctx),view=playerView(ctx);
    if(view==='wall')return nav+renderPlayerWall(ctx);
    if(view==='invitations')return nav+renderInvitations(ctx);
    if(view==='room')return nav+renderTeamRoom(ctx);
    if(!ctx.identity.teamId&&ctx.event.phase!=='published')return nav+heading(ctx,'先登记你的队伍',ctx.identity.name)+'<div class="notice">创建或加入队伍后，每位选手都可投人气票。</div><button type="button" class="primary" data-player-view="room">填写队名 / 加入队伍</button>'+renderOwnPlayerCard(ctx);
    return nav+renderVoter(ctx)+renderOwnPlayerCard(ctx);
  }
  return ctx.role==='judge'?renderJudge(ctx):renderVoter(ctx);
}

async function updateAfterSave(ctx,message) {
  try { await refresh({quiet:true}); toast(message); }
  catch { redraw(ctx); toast(`${message} 暂时无法读取最新页面，请保留当前页面。`); }
}
function bindJudge(ctx) {
  $('#score-team-picker')?.addEventListener('change',event=>{
    selectedTeams.set(ctx.judge.id,event.target.value);
    redraw(ctx);$('#selected-team-heading')?.focus();
  });
  $$('[data-score-team]').forEach(button=>button.addEventListener('click',()=>{
    selectedTeams.set(ctx.judge.id,button.dataset.scoreTeam);
    redraw(ctx);$('#selected-team-heading')?.focus();
  }));
  const form=$('#score-form');
  if(!form||ctx.event.phase!=='open')return;
  const teamId=form.dataset.teamId,team=ctx.teams.find(t=>t.id===teamId),draftKey=scoreKey(ctx.judge.id,teamId);
  const inputs=$$('[data-score-input]',form);
  const saveDraft=()=>{
    const values=inputs.map(input=>input.value);
    writeDraft(draftKey,values);
    const total=weighted(values);
    $('#weighted-score').textContent=total===null?'待填写完整':`${formatScore(total)} / 10`;
    $('#score-draft-note').textContent='本机草稿已保留；点击提交后才计入结果。';
  };
  inputs.forEach(input=>input.addEventListener('input',saveDraft));
  form.addEventListener('submit',async event=>{
    event.preventDefault();
    if(!form.reportValidity())return;
    const values=inputs.map(input=>input.value);
    if(weighted(values)===null){toast('请填写四项 0—10 分的评分。',true);return;}
    const scores=values.map(Number),button=$('button[type="submit"]',form);
    if(button.disabled)return;
    button.disabled=true;
    try {
      await json('/api/score',{teamId,scores});
      clearDraft(draftKey);
      ctx.scores=(ctx.scores||[]).filter(s=>s.teamId!==teamId);
      ctx.scores.push({judgeId:ctx.judge.id,teamId,scores,weightedScore:weighted(scores)});
      await updateAfterSave(ctx,'评分已保存。');
    } catch(error) { toast(error.message,true);button.disabled=false; }
  });
  $('#recuse-team')?.addEventListener('click',()=>{
    modal(`<h2>回避「${escape(team.name)}」</h2><p>请说明你与该队的利益关系。回避后不会参与此队的平均分计算。</p><div class="notice">此操作不可撤销；如果已经给此队评分，已有评分将被删除。</div><form><label for="recusal-reason">回避原因</label><textarea id="recusal-reason" name="reason" required maxlength="500" rows="3" placeholder="请简要说明利益关系"></textarea><div class="dialog-actions"><button type="button" data-cancel>暂不回避</button><button class="danger" type="submit">确认回避并删除已有评分</button></div></form>`,async data=>{
      const reason=String(data.get('reason')||'').trim();
      if(!reason)throw new Error('请填写回避原因。');
      await json('/api/recuse',{teamId,reason});
      clearDraft(draftKey);
      ctx.scores=(ctx.scores||[]).filter(s=>s.teamId!==teamId);
      ctx.judge.recusals=[...(ctx.judge.recusals||[]).filter(r=>r.teamId!==teamId),{teamId,reason}];
      await updateAfterSave(ctx,'回避已记录。');
    });
  });
}
function bindVoter(ctx) {
  const form=$('#vote-form');
  if(!form||ctx.event.phase!=='open'||ctx.ballot)return;
  const inputs=$$('[data-vote-team]',form),limit=ctx.identity.voteLimit,key=voteKey(ctx.identity.id);
  function synchronize() {
    const chosen=inputs.filter(input=>input.checked&&!input.dataset.ownTeam);
    inputs.forEach(input=>{
      input.disabled=!!input.dataset.ownTeam||(!input.checked&&chosen.length>=limit);
      input.closest('.team-choice')?.classList.toggle('selected',input.checked);
    });
    $('#vote-count').textContent=`已选 ${chosen.length} 队`;
    $('#vote-remaining').textContent=`还可选 ${Math.max(0,limit-chosen.length)} 队`;
    $('#submit-vote').disabled=chosen.length===0||chosen.length>limit;
    writeDraft(key,chosen.map(input=>input.value));
    return chosen.map(input=>input.value);
  }
  inputs.forEach(input=>input.addEventListener('change',()=>{
    if(inputs.filter(i=>i.checked&&!i.dataset.ownTeam).length>limit){input.checked=false;toast(`最多选择 ${limit} 队。`,true);}
    synchronize();
  }));
  form.addEventListener('submit',event=>{
    event.preventDefault();
    const selected=synchronize();
    if(!selected.length||selected.length>limit)return;
    const allocations=Object.fromEntries(selected.map(id=>[id,1])),remaining=limit-selected.length;
    modal(`<h2>确认提交人气票</h2><p>你将向以下 ${selected.length} 队各投 1 票：</p><ul>${selected.map(id=>`<li>${escape(ctx.teams.find(t=>t.id===id)?.name||'')}</li>`).join('')}</ul><div class="notice">${remaining?`剩余 ${remaining} 票将作废。`:'本次将用完全部票。'}每人只能提交一次，提交后不可修改。</div><form><div class="dialog-actions"><button type="button" data-cancel>返回调整</button><button class="primary" type="submit">确认提交 ${selected.length} 票</button></div></form>`,async()=>{
      await json('/api/vote',{allocations});
      clearDraft(key);
      // A positive server response is enough to prevent a duplicate submission,
      // even if the follow-up read fails. The true receipt time arrives on refresh.
      ctx.ballot={voterId:ctx.identity.id,allocations,submittedAt:null};
      await updateAfterSave(ctx,'人气票已保存。');
    });
  });
}
export function bindParticipant(ctx) {
  if(ctx.event.phase==='published'){if(ctx.role==='player')bindCertificates(ctx);return;}
  if(ctx.event.entryMode==='phone'&&ctx.role==='player'){
    bindPlayerViews(ctx,()=>redraw(ctx));
    if(playerView(ctx)==='room'){bindTeamRoom(ctx);return;}
    if(playerView(ctx)!=='vote')return;
  }
  if(ctx.role==='judge')bindJudge(ctx);else bindVoter(ctx);
}
