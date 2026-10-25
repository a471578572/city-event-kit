import {$,$$,escape,icon,toast} from './common.js';
import {json,refresh} from './app.js';

const views=new Map(),searches=new Map(),filters=new Map(),busy=new Set();
const fields=[['background','背景'],['participation','参与方式'],['directions','兴趣方向'],['skills','我擅长'],['experience','AI 经验']];
const statusLabels={pending:'等待回应',accepted:'已接受',declined:'已拒绝',cancelled:'已取消',expired:'已失效'};
function profileFor(person){const source=person.profile||person;return Object.fromEntries(fields.map(([key])=>[key,String(source[key]??'').trim()]));}
function open(ctx){return ['setup','open'].includes(ctx.event.phase)&&ctx.event.teamsOpen===true;}
function ownTeam(ctx){return ctx.teams.find(t=>t.id===ctx.identity.teamId);}
function count(team){return Array.isArray(team?.members)?team.members.length:Number(team?.members)||team?.memberNames?.length||0;}
export function playerView(ctx){return views.get(ctx.identity.id)||((ctx.event.phase==='open'||ctx.event.phase==='closed')&&ctx.identity.teamId?'vote':'room');}
function setView(ctx,view){views.set(ctx.identity.id,['room','wall','invitations','vote'].includes(view)?view:'room');}
function avatar(person){
  let seed=2166136261;for(const char of String(person.id||person.name))seed=Math.imul(seed^char.codePointAt(0),16777619)>>>0;
  const pixels=[];for(let y=0;y<5;y++)for(let x=0;x<3;x++){if((seed>>>((y*3+x)%30))&1){pixels.push(`<rect x="${x*7}" y="${y*7}" width="7" height="7"/>`);if(x<2)pixels.push(`<rect x="${(4-x)*7}" y="${y*7}" width="7" height="7"/>`);}}
  return `<span class="player-pixel-avatar" aria-hidden="true"><svg width="35" height="35" viewBox="0 0 35 35" fill="currentColor" shape-rendering="crispEdges">${pixels.join('')}</svg></span>`;
}
export function renderPlayerCard(person,ctx,{own=false,action=''}={}){
  const profile=profileFor(person),team=ctx.teams.find(t=>t.id===person.teamId);
  return `<article class="player-profile-card${own?' personal-player-card':''}"><div class="player-card-bar"><span>${own?'我的像素个人卡':'选手个人卡'}</span><i aria-hidden="true"></i><i aria-hidden="true"></i><i aria-hidden="true"></i></div><div class="player-card-body"><div class="player-card-identity">${avatar(person)}<div><h2>${escape(person.name)}</h2><span class="player-team-tag${team?' joined':''}">${team?escape(team.name):'待组队'}${own?' · 我':''}</span></div></div><dl class="player-card-profile">${fields.map(([key,label])=>`<div><dt>${label}</dt><dd${profile[key]?'':' class="muted"'}>${profile[key]?escape(profile[key]):'暂未填写'}</dd></div>`).join('')}</dl>${action?`<div class="player-card-action">${action}</div>`:''}</div></article>`;
}
export function renderOwnPlayerCard(ctx){return renderPlayerCard(ctx.identity,ctx,{own:true});}
export function renderPlayerNav(ctx){
  const current=playerView(ctx),pending=(ctx.invitations||[]).filter(i=>i.toId===ctx.identity.id&&i.status==='pending').length;
  return `<nav class="player-navigation" aria-label="选手功能">${[['room','我的队伍'],['wall','找队友'],['invitations','组队邀请'],...(ctx.event.phase==='setup'?[]:[['vote','人气投票']])].map(([id,label])=>`<button type="button" data-player-view="${id}" class="${current===id?'active':''}" aria-pressed="${current===id}">${label}${id==='invitations'&&pending?`<span class="invite-count" aria-label="${pending}个待回应邀请">${pending}</span>`:''}</button>`).join('')}</nav>`;
}
function filteredCards(ctx){
  const query=(searches.get(ctx.identity.id)||'').trim().toLocaleLowerCase(),filter=filters.get(ctx.identity.id)||'all';
  return (ctx.playerCards||[]).filter(person=>(filter!=='free'||!person.teamId)&&(!query||[person.name,...Object.values(profileFor(person))].some(value=>String(value).toLocaleLowerCase().includes(query))));
}
function wallCards(ctx){
  const team=ownTeam(ctx),cards=filteredCards(ctx);
  return cards.map(person=>{
    const self=person.id===ctx.identity.id,pending=team&&(ctx.invitations||[]).some(i=>i.teamId===team.id&&i.toId===person.id&&i.status==='pending');
    let action='';
    if(self)action='<span class="muted">这是我的个人卡</span>';
    else if(person.teamId)action='<span class="muted">已加入队伍，先聊聊彼此的作品吧</span>';
    else if(!open(ctx))action='<button type="button" disabled>组队暂未开放</button>';
    else if(team?.locked)action='<button type="button" disabled>本队已进入评审，成员已锁定</button>';
    else if(ctx.ballot)action='<button type="button" disabled>已投票，不能调整队伍</button>';
    else if(pending)action='<button type="button" disabled>已邀请，等待回应</button>';
    else if(team&&count(team)>=(team.maxMembers||4))action='<button type="button" disabled>我的队伍已满</button>';
    else action=`<button type="button" class="primary" data-invite-player="${escape(person.id)}">邀请一起组队 ${icon('plus')}</button>`;
    return renderPlayerCard(person,ctx,{own:self,action});
  }).join('')||'<div class="empty wall-empty">没有找到匹配的选手，换个关键词或查看全部试试。</div>';
}
export function renderPlayerWall(ctx){
  const filter=filters.get(ctx.identity.id)||'all',query=searches.get(ctx.identity.id)||'',team=ownTeam(ctx);
  return `<div class="participant-heading"><span class="state-tag">寻找你的拼图队友</span><h1>选手墙</h1><p class="muted">从兴趣、技能和经历里，找到可以一起开工的人。</p></div><section class="wall-toolbar"><label for="player-wall-search">搜称呼、技能或兴趣方向<input id="player-wall-search" type="search" value="${escape(query)}" placeholder="试试：设计、短剧、编程…" autocomplete="off"></label><div class="wall-filters" aria-label="组队状态筛选"><button type="button" data-wall-filter="all" class="${filter==='all'?'active':''}" aria-pressed="${filter==='all'}">全部选手</button><button type="button" data-wall-filter="free" class="${filter==='free'?'active':''}" aria-pressed="${filter==='free'}">尚未组队</button></div><p id="player-wall-count" class="muted">找到 ${filteredCards(ctx).length} 位选手</p></section><div class="wall-team-hint">${team?`正在为 <strong>${escape(team.name)}</strong> 寻找队友 · ${count(team)} / ${team.maxMembers||4} 人`:'先创建或加入一支队伍，就能向其他选手发出邀请。'}<button type="button" class="text-button" data-player-view="room">查看我的队伍 ${icon('arrow')}</button></div><div id="player-wall-grid" class="player-wall-grid">${wallCards(ctx)}</div><p class="wall-privacy muted">选手墙仅向已入场选手展示，不显示手机号、公司、职位或私人备注。</p>`;
}
function outgoing(ctx){const team=ownTeam(ctx);return (ctx.invitations||[]).filter(i=>i.fromId===ctx.identity.id||(team?.captainVoterId===ctx.identity.id&&i.teamId===team.id));}
function invitationCard(invitation,ctx,received){
  const pending=invitation.status==='pending',canAct=pending&&open(ctx),team=ownTeam(ctx),canCancel=invitation.fromId===ctx.identity.id||team?.captainVoterId===ctx.identity.id&&invitation.teamId===team.id;
  const title=received?`${invitation.fromName} 邀请你加入`:`邀请 ${invitation.toName}`;
  return `<article class="invitation-card ${pending?'pending':''}"><div class="invitation-title"><h3>${escape(title)}</h3><span class="state-tag">${escape(statusLabels[invitation.status]||'已记录')}</span></div><p class="invitation-team">${escape(invitation.teamName)}</p>${!received&&invitation.fromId!==ctx.identity.id?`<p class="muted">由队友 ${escape(invitation.fromName)} 发出</p>`:''}${invitation.reason?`<p class="muted">${escape(invitation.reason)}</p>`:''}${canAct?`<div class="invitation-actions">${received&&!ctx.identity.teamId?`<button type="button" class="primary" data-invitation-action="accept" data-invitation-id="${escape(invitation.id)}">接受并加入队伍 ${icon('check')}</button><button type="button" data-invitation-action="decline" data-invitation-id="${escape(invitation.id)}">婉拒邀请</button>`:!received&&canCancel?`<button type="button" data-invitation-action="cancel" data-invitation-id="${escape(invitation.id)}">取消邀请</button>`:''}</div>`:pending?'<p class="muted">组队暂停中，邀请已保留，恢复开放后可回应。</p>':''}</article>`;
}
export function renderInvitations(ctx){
  const incoming=(ctx.invitations||[]).filter(i=>i.toId===ctx.identity.id),sent=outgoing(ctx);
  const sort=list=>[...list].sort((a,b)=>Number(b.status==='pending')-Number(a.status==='pending')||String(b.createdAt).localeCompare(String(a.createdAt)));
  return `<div class="participant-heading"><span class="state-tag">一起做，比一个人想更有意思</span><h1>组队邀请</h1><p class="muted">收到邀请后由你决定。接受才会加入，拒绝不会改变队伍。</p></div><section class="invitations-section"><div class="panel-title"><h2>收到的邀请</h2><span class="state-tag">${incoming.filter(i=>i.status==='pending').length} 个待回应</span></div><div class="invitation-list">${sort(incoming).map(i=>invitationCard(i,ctx,true)).join('')||'<div class="empty">还没有收到邀请。先在选手墙看看大家吧。</div>'}</div></section><section class="invitations-section"><div class="panel-title"><h2>已发出的邀请</h2><button class="text-button" data-player-view="wall">去选手墙找队友 ${icon('arrow')}</button></div><div class="invitation-list">${sort(sent).map(i=>invitationCard(i,ctx,false)).join('')||'<div class="empty">还没有发出邀请。队内任一成员都可以邀请新队友。</div>'}</div></section>`;
}
async function saveAction(key,button,task,message){
  if(busy.has(key))return;busy.add(key);button.disabled=true;
  try{await task();await refresh();toast(message);}catch(error){toast(error.message,true);button.disabled=false;}finally{busy.delete(key);}
}
function bindInviteButtons(ctx,redraw){
  $$('[data-invite-player]').forEach(button=>button.addEventListener('click',()=>{
    if(!ownTeam(ctx)){toast('请先创建或加入一支队伍，再邀请队友。');setView(ctx,'room');redraw();return;}
    saveAction(`send:${button.dataset.invitePlayer}`,button,()=>json('/api/invitations/send',{targetId:button.dataset.invitePlayer}),'邀请已发出，等待对方回应。');
  }));
}
export function bindPlayerViews(ctx,redraw){
  $$('[data-player-view]').forEach(button=>button.addEventListener('click',()=>{setView(ctx,button.dataset.playerView);redraw();}));
  const search=$('#player-wall-search');
  function updateWall(){
    $('#player-wall-grid').innerHTML=wallCards(ctx);$('#player-wall-count').textContent=`找到 ${filteredCards(ctx).length} 位选手`;
    $$('[data-wall-filter]').forEach(button=>{const active=button.dataset.wallFilter===(filters.get(ctx.identity.id)||'all');button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));});
    bindInviteButtons(ctx,redraw);
  }
  search?.addEventListener('input',()=>{searches.set(ctx.identity.id,search.value);updateWall();});
  $$('[data-wall-filter]').forEach(button=>button.addEventListener('click',()=>{filters.set(ctx.identity.id,button.dataset.wallFilter);updateWall();}));
  bindInviteButtons(ctx,redraw);
  $$('[data-invitation-action]').forEach(button=>button.addEventListener('click',()=>{
    const action=button.dataset.invitationAction,id=button.dataset.invitationId;
    saveAction(`respond:${id}`,button,async()=>{
      if(action==='cancel')await json('/api/invitations/cancel',{invitationId:id});
      else await json('/api/invitations/respond',{invitationId:id,action});
      if(action==='accept')setView(ctx,'room');
    },action==='accept'?'已加入队伍，和新队友打个招呼吧。':action==='decline'?'已拒绝邀请，队伍状态没有改变。':'邀请已取消。');
  }));
}
