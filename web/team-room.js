import {$,$$,escape,toast,modal,storageKey,icon} from './common.js';
import {json,refresh} from './app.js';
import {renderOwnPlayerCard} from './player-wall.js';

const drafts=new Map();
const profileLabels={company:'公司 / 组织',position:'职位',note:'提前告诉组织者的话'};
function draftKey(id){return storageKey(`rating_team_draft:${id}`);}
function getDraft(id,team){
  const key=`${id}:${team?.id||'new'}`;
  if(!drafts.has(key)){
    let saved=null;try{saved=JSON.parse(sessionStorage.getItem(draftKey(key))||'null');}catch{}
    drafts.set(key,saved&&typeof saved.name==='string'&&typeof saved.project==='string'?saved:{name:team?.name||'',project:team?.project||''});
  }
  return drafts.get(key);
}
function saveDraft(id,team,value){const key=`${id}:${team?.id||'new'}`;drafts.set(key,value);try{sessionStorage.setItem(draftKey(key),JSON.stringify(value));}catch{}}
function clearDraft(id,team){const key=`${id}:${team?.id||'new'}`;drafts.delete(key);try{sessionStorage.removeItem(draftKey(key));}catch{}}
function count(team){return Array.isArray(team.members)?team.members.length:Number(team.members)||team.memberNames?.length||0;}
function members(team){return (team.memberNames||[]).map(name=>`<span class="member-chip">${escape(typeof name==='string'?name:name.name)}</span>`).join('')||'<span class="muted">成员信息更新中</span>';}
function teamFields(d){return `<label>队伍名称<input name="teamName" required maxlength="60" value="${escape(d.name)}" placeholder="给队伍起个名字" autocomplete="off"></label><label>作品名称 <span class="muted">选填，之后可补充</span><input name="project" maxlength="120" value="${escape(d.project)}" placeholder="准备做什么作品" autocomplete="off"></label>`;}
export function renderTeamRoom(ctx){
  const person=ctx.identity,team=ctx.teams.find(t=>t.id===person.teamId),teamsOpen=['setup','open'].includes(ctx.event.phase)&&ctx.event.teamsOpen===true,canEdit=teamsOpen&&!team?.locked&&!ctx.ballot;
  const profile=Object.entries(profileLabels).filter(([key])=>person.profile?.[key]);
  const intro=`<div class="participant-heading"><span class="state-tag">选手 · ${team?.locked?'本队评审中':ctx.ballot?'队伍已锁定':canEdit?'组队开放中':'组队已暂停'}</span><h1>我的参赛页</h1><p>${escape(person.name)} <span class="phone-masked">${escape(person.phoneMasked||'')}</span></p><p class="muted">先找到队友，再一起把作品做出来。每队 1—4 人。</p></div>`;
  const info=profile.length?`<details class="panel personal-profile"><summary>其他报名资料 <span class="muted">仅本人和工作人员可见</span></summary><dl>${profile.map(([key,label])=>`<div><dt>${label}</dt><dd>${escape(person.profile[key])}</dd></div>`).join('')}</dl></details>`:'';
  if(team){
    const captain=team.captainVoterId===person.id;
    return `${intro}${renderOwnPlayerCard(ctx)}<section class="panel my-team"><div class="panel-title"><div><span class="state-tag">${captain?'我是队长':'我已加入'}</span><h2>${escape(team.name)}</h2></div><strong class="team-capacity">${count(team)} / ${team.maxMembers||4} 人</strong></div><p>${escape(team.project||'作品名称待补充')}</p><div class="member-chips">${members(team)}</div>${canEdit&&captain?`<details class="team-edit"><summary>修改队名与作品名称</summary><form id="team-update-form">${teamFields(getDraft(person.id,team))}<button type="submit" class="primary">保存队伍信息 ${icon('check')}</button></form></details>`:''}${canEdit?'<div class="team-leave"><p class="muted">想换队时，请先退出当前队伍。队长退出后，由队内下一位成员接任。</p><button id="team-leave" class="secondary">退出当前队伍</button></div>':`<div class="notice">${team.locked?'本队已有评审记录或人气票，成员、队名与作品名称已锁定。':ctx.ballot?'你已提交人气票，不能再调整队伍。':'组队暂未开放，当前成员已保留。'}</div>`}</section>${info}${ctx.event.phase==='open'?'<button type="button" class="primary full" data-player-view="vote">去投人气票 →</button>':ctx.event.phase==='setup'?'<div class="notice">评分与投票尚未开始，开放后会在这里显示你的投票页面。</div>':'<div class="notice">评分与投票已截止，队伍信息已保留。</div>'}`;
  }
  const teams=ctx.teams;
  return `${intro}${renderOwnPlayerCard(ctx)}${canEdit?`<section class="panel"><span class="state-tag">方式一</span><h2>自己创建一支队伍</h2><p class="muted">起好队名，再让队友用自己的手机号进入，选择加入。</p><form id="team-create-form" class="team-form">${teamFields(getDraft(person.id))}<button class="primary full" type="submit">创建队伍 ${icon('plus')}</button></form></section>`:'<div class="notice">你还未加入队伍。组队暂未开放，请联系现场工作人员。</div>'}<section class="panel"><div class="panel-title"><div><span class="state-tag">方式二</span><h2>选择队伍加入</h2></div><span class="muted">${teams.length} 支队伍</span></div><div class="join-team-list">${teams.map(t=>`<article class="join-team-card"><div><h3>${escape(t.name)}</h3><span class="state-tag">${count(t)} / ${t.maxMembers||4} 人</span></div>${t.project?`<p class="muted">${escape(t.project)}</p>`:''}<div class="member-chips">${members(t)}</div><button type="button" data-join-team="${escape(t.id)}" class="${canEdit&&!t.locked&&count(t)<(t.maxMembers||4)?'primary':'secondary'}" ${!canEdit||t.locked||count(t)>=(t.maxMembers||4)?'disabled':''}>${t.locked?'该队评审中，成员已锁定':count(t)>=(t.maxMembers||4)?'人数已满':canEdit?'加入这支队伍':'暂未开放'}</button></article>`).join('')||'<div class="empty">还没有队伍。你可以先创建第一支。</div>'}</div></section>${info}`;
}
export function bindTeamRoom(ctx){
  const person=ctx.identity,team=ctx.teams.find(t=>t.id===person.teamId);
  for(const [selector,path] of [['#team-create-form','/api/teams/create'],['#team-update-form','/api/teams/update']]){
    const form=$(selector);if(!form)continue;
    const read=()=>({name:form.elements.teamName.value.trim(),project:form.elements.project.value.trim()});
    form.addEventListener('input',()=>saveDraft(person.id,team,read()));
    form.addEventListener('submit',async event=>{
      event.preventDefault();if(!form.reportValidity())return;
      const button=$('button[type=submit]',form);if(button.disabled)return;button.disabled=true;
      try{await json(path,read());clearDraft(person.id,team);await refresh();toast(path.endsWith('create')?'队伍已创建，让队友选择加入吧。':'队伍信息已保存。');}
      catch(error){toast(error.message,true);button.disabled=false;}
    });
  }
  $$('[data-join-team]').forEach(button=>button.addEventListener('click',()=>{
    const chosen=ctx.teams.find(t=>t.id===button.dataset.joinTeam);if(!chosen)return;
    modal(`<h2>加入「${escape(chosen.name)}」</h2><p>请和队友确认队名。加入后，你的人气票不能投给本队；本队已有评分、回避记录或人气票后，成员将锁定；提交人气票后也不能换队。</p><form><div class="dialog-actions"><button type="button" data-cancel>返回</button><button type="submit" class="primary">确认加入</button></div></form>`,async()=>{await json('/api/teams/join',{teamId:chosen.id});await refresh();toast('已加入队伍。');});
  }));
  $('#team-leave')?.addEventListener('click',()=>modal(`<h2>退出当前队伍</h2><p>退出「${escape(team?.name)}」后可以重新选队。${team?.captainVoterId===person.id?'如果队内还有成员，队长将顺延交给下一位成员；如果只剩你，空队伍会被移除。':''}</p><form><div class="dialog-actions"><button type="button" data-cancel>继续留队</button><button type="submit" class="danger">确认退出</button></div></form>`,async()=>{await json('/api/teams/leave',{});clearDraft(person.id,team);await refresh();toast('已退出，可以选择新的队伍。');}));
}
