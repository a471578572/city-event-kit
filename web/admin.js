import {SITE} from './site.js';
import {$,$$,escape,icon,toast,modal,copyText,downloadBlob,formatScore,rulesBlock,phaseLabels,appRoot,appPath,storageKey,connectionLabel} from './common.js';
import {json,api,refresh,navigate} from './app.js';
import {resultTables} from './results.js';
import {qrSVG} from './qr.js';
import {renderPresentationOrder,bindPresentationOrder} from './presentation-order.js';
import {renderPhoneSetup,bindPhoneSetup,renderPublicEntry,bindPublicEntry} from './phone-roster.js';

const tabNames={setup:'比赛设置',tickets:'入口发放',progress:'评分进度',order:'路演抽签',results:'结果与导出'};
let setupDraft=null,ticketFilter='judge',ticketTeam='all';
function steps(phase){
  const order=['setup','open','closed','published'],current=order.indexOf(phase);
  return `<div class="steps">${['设置名单','开放评分与投票','截止核对','公布结果'].map((s,i)=>`<div class="${i<=current?'done':''}"><b>${i+1}</b><span>${s}</span></div>`).join('')}</div>`;
}
function header(a,tab){
  const phase=a.event.phase;
  let action='';
  if(tab==='setup'&&phase==='setup'&&a.event.entryMode!=='phone')action='<button class="primary" type="submit" form="setup-form">保存设置</button>';
  if(phase==='open'&&tab!=='setup')action='<button class="primary" data-phase="closed">截止评分与投票</button>';
  if(phase==='closed')action=`<button data-phase="open">重新开放</button><button class="primary" data-phase="published" ${a.results.ready?'':'disabled'}>公布结果</button>`;
  if(phase==='published')action='<button id="public-view">打开公布页面</button>';
  return `<div class="topbar"><h1>${tabNames[tab]}</h1><div class="button-row">${action}</div></div>${steps(phase)}`;
}
function getDraft(a){
  if(setupDraft)return setupDraft;
  setupDraft={name:a.event.name||SITE.name,teams:a.teams.length?a.teams.map(t=>({...t})):[{name:'',project:'',members:1},{name:'',project:'',members:1},{name:'',project:'',members:1}],judges:a.judges.length?a.judges.map(j=>({name:j.name})):[{name:''},{name:''},{name:''}],audienceEnabled:a.event.audienceEnabled,audienceCount:a.voters.filter(v=>v.role==='audience').length};
  return setupDraft;
}
function setup(a){
  if(a.event.entryMode==='phone')return renderPhoneSetup(a);
  const locked=a.event.phase!=='setup',d=locked?{...a.event,teams:a.teams,judges:a.judges,audienceCount:a.voters.filter(v=>v.role==='audience').length}:getDraft(a);
  return `<div class="page-intro"><h2>${locked?'名单已锁定，比赛进行有据':'把舞台交给好作品'}</h2><p>${locked?'名单与个人入口保持一致。可在评分进度中检查提交情况。':'填好队伍和评委，就可以开始现场评比。'}</p></div>
  <form id="setup-form"><fieldset ${locked?'disabled':''}><label class="event-label">活动名称<input name="name" maxlength="100" required value="${escape(d.name)}"></label><div class="setup-columns"><section class="panel roster"><div class="panel-title"><h2>参赛队伍</h2>${locked?'':'<button type="button" id="add-team">'+icon('plus')+' 添加队伍</button>'}</div><div class="table-wrap"><table><thead><tr><th>#</th><th>队伍名称</th><th>作品名称</th><th>选手人数</th>${locked?'':'<th>操作</th>'}</tr></thead><tbody id="team-rows">${d.teams.map((t,i)=>`<tr data-team-row><td>${String(i+1).padStart(2,'0')}</td><td><input aria-label="第${i+1}队名称" name="teamName" value="${escape(t.name)}" placeholder="填写队伍名" maxlength="100" required></td><td><input aria-label="第${i+1}队作品" name="project" value="${escape(t.project)}" placeholder="填写作品名" maxlength="160"></td><td><input aria-label="第${i+1}队人数" name="members" type="number" min="1" max="20" value="${t.members}" required></td>${locked?'':`<td><button type="button" class="icon-button" data-delete-team="${i}" aria-label="删除第${i+1}队">${icon('trash')}</button></td>`}</tr>`).join('')}</tbody></table></div></section><section class="panel roster"><div class="panel-title"><h2>评委</h2>${locked?'':'<button type="button" id="add-judge">'+icon('plus')+' 添加评委</button>'}</div><div class="judge-rows">${d.judges.map((j,i)=>`<div data-judge-row><span>${String(i+1).padStart(2,'0')}</span><input name="judgeName" aria-label="评委${i+1}姓名" placeholder="填写评委姓名" value="${escape(j.name)}" maxlength="100" required>${locked?'':`<button type="button" class="icon-button" data-delete-judge="${i}" aria-label="删除评委${i+1}">${icon('trash')}</button>`}</div>`).join('')}</div></section></div>
  <section class="panel rule-panel"><h2>评比规则</h2>${rulesBlock()}<div class="rule-options"><label class="check-label"><input type="checkbox" name="audienceEnabled" ${d.audienceEnabled?'checked':''}> 开启观众投票</label><label class="inline-label">观众人数 <input name="audienceCount" type="number" min="0" max="500" value="${d.audienceCount||0}" ${d.audienceEnabled?'':'disabled'}> 人</label><span class="rule-fixed">${icon('check')} 每人每队最多 1 票</span></div><p class="muted">选手每人最多 3 票，不能投本队；观众每人最多 2 票。每位选手都有自己的票，队友分别投票。无观众则选手互投，可少投。</p><p class="muted">本地前三同分合议，利益相关评委回避。人气第一同票时保留待定，按现场确认的规则记录处理。</p></section></fieldset>
  ${locked?`<div class="notice">当前状态：${phaseLabels[a.event.phase]}。比赛开始后不再修改名单和票权。</div>`:`<div class="bottom-action"><p class="muted">保存后可核对名单；开放后名单锁定，再发放个人入口。</p><button class="primary" id="start-event" type="button">保存并开放评比 ${icon('arrow')}</button></div>`}
  </form>`;
}
function readSetup(){
  const f=$('#setup-form');
  setupDraft={name:$('[name=name]',f).value.trim(),teams:$$('[data-team-row]',f).map(row=>({name:$('[name=teamName]',row).value.trim(),project:$('[name=project]',row).value.trim(),members:Number($('[name=members]',row).value)})),judges:$$('[data-judge-row]',f).map(row=>({name:$('[name=judgeName]',row).value.trim()})),audienceEnabled:$('[name=audienceEnabled]',f).checked,audienceCount:Number($('[name=audienceCount]',f).value)||0,allowRepeat:false};
  if(!setupDraft.audienceEnabled)setupDraft.audienceCount=0;
  return setupDraft;
}
function baseURL(a){
  const stored=sessionStorage.getItem(storageKey('rating_base_url'));
  const candidate=a.publicBaseUrl||stored||a.networkUrls.find(u=>!u.includes('127.0.0.1')&&!u.includes('localhost'))||appRoot.href;
  try {const u=new URL(candidate);if(!['http:','https:'].includes(u.protocol))throw 0;return u.origin+u.pathname.replace(/\/$/,'');}catch{return appRoot.href.replace(/\/$/,'');}
}
function ticketCard(a,p){
  const url=`${baseURL(a)}/#token=${encodeURIComponent(p.token)}`;
  const role=p.role==='player'?'选手 · 3票':p.role==='audience'?'观众 · 2票':'评委 · 四项评分';
  return `<article class="ticket-card"><div class="ticket-identity"><span class="state-tag">${role}</span><h3>${escape(p.name)}</h3></div><div class="qr">${qrSVG(url,152)}</div><p class="ticket-event">${escape(a.event.name)}</p><p class="muted">${a.publicBaseUrl?'手机联网后即可扫码':'连接现场同一 Wi-Fi 后扫码'}</p><code>${escape(p.token)}</code><p class="ticket-rule">${p.role==='player'?'每队最多1票，不投本队':p.role==='audience'?'每队最多1票':'利益相关请主动回避'}</p><button class="copy-ticket" data-copy-token="${escape(p.token)}">复制专属链接</button></article>`;
}
function tickets(a){
  if(a.event.entryMode==='phone')return renderPublicEntry(a);
  if(a.event.phase==='setup')return `<div class="page-intro"><h2>一人一份，专属入场</h2><p>先完成名单设置并开放评比，再发放入口，避免名单修改使旧入口失效。</p></div><button class="primary" data-go="setup">前往比赛设置</button>`;
  const all=[...a.judges.map(j=>({...j,role:'judge'})),...a.voters];
  const list=all.filter(p=>p.role===ticketFilter&&(ticketTeam==='all'||p.teamId===ticketTeam));
  return `<div class="page-intro"><h2>一人一份，专属入场</h2><p>按实际身份发放，每人只能领一份人气票。个人链接不要发进公共群。</p></div><section class="panel network-panel"><div><label for="base-url">手机访问地址</label><input id="base-url" ${a.publicBaseUrl?'readonly':''} value="${escape(baseURL(a))}" list="network-list"><datalist id="network-list">${a.networkUrls.map(u=>`<option value="${escape(u)}">`).join('')}</datalist></div><button id="apply-base" ${a.publicBaseUrl?'hidden':''}>更新二维码</button><div><p class="muted">${a.publicBaseUrl?'手机使用流量或 Wi-Fi 均可参加，评分和投票统一保存在线上。<br>请将个人入口发给本人；主持电脑关闭后，线上评比仍可使用。':'主持电脑与手机须连接同一局域网。电脑保持运行，关闭睡眠。<br>若扫码打不开，检查 Wi-Fi 是否隔离设备；也可换用个人热点。'}</p></div></section>
  <div class="ticket-toolbar"><div class="tabs">${[['judge','评委'],['player','选手'],['audience','观众']].map(([r,label])=>`<button class="${ticketFilter===r?'active':''}" data-filter="${r}">${label} <small>${all.filter(p=>p.role===r).length}</small></button>`).join('')}</div>${ticketFilter==='player'?`<select id="ticket-team" aria-label="按队伍筛选"><option value="all">所有队伍</option>${a.teams.map(t=>`<option value="${escape(t.id)}" ${ticketTeam===t.id?'selected':''}>${escape(t.name)}</option>`).join('')}</select>`:''}<button id="print-tickets">${icon('download')} 打印当前入口卡</button></div>
  <div id="ticket-cards" class="ticket-grid">${list.map(p=>ticketCard(a,p)).join('')||'<p class="empty">本场未登记此类人员。</p>'}</div><p class="muted">打印后按姓名／队伍发给本人；每个入口只代表一个身份。票证防止重复提交，工作人员仍需核对领票人员。</p>`;
}
function progress(a){
  const r=a.results,t=r.tally;
  const submitted=new Set(a.ballots.map(b=>b.voterId));
  return `<div class="page-intro"><h2>让每一份评分都到场</h2><p>页面自动更新。缺分不会记作零分，回避不会拉低均分。</p></div><div class="summary-strip"><div><span>有效评分</span><strong>${t.receivedScores}<small> / ${t.expectedScores}</small></strong></div><div><span>人气票已提交</span><strong>${t.submittedBallots}<small> / ${t.totalVoters} 人</small></strong></div><div><span>人气有效票</span><strong>${t.totalVotes}<small> 票</small></strong></div><div><span>当前阶段</span><strong class="small-status">${phaseLabels[a.event.phase]}</strong></div></div>
  <section class="panel"><div class="panel-title"><h2>逐队评审记录</h2><span id="connection" class="muted">${connectionLabel(a)}</span></div><div class="table-wrap"><table><thead><tr><th>队伍</th>${a.judges.map(j=>`<th>${escape(j.name)}</th>`).join('')}<th>已交 / 应交</th></tr></thead><tbody>${a.teams.map(team=>`<tr><td><strong>${escape(team.name)}</strong><span class="subline">${escape(team.project)}</span></td>${a.judges.map(j=>{const rec=(a.effectiveRecusals?.[j.id]||j.recusals).find(v=>v.teamId===team.id),s=a.scores.find(s=>s.teamId===team.id&&s.judgeId===j.id);return `<td>${rec?`<span class="state-tag">${rec.automatic?'本队自动回避':'已回避'}</span><span class="subline">${escape(rec.reason)}</span>`:s?`<strong class="success-text">${formatScore(s.weightedScore)}</strong><span class="subline">${s.scores.join(' / ')}</span>`:'<span class="warning-text">待提交</span>'}</td>`;}).join('')}<td>${r.jury.find(x=>x.teamId===team.id)?.received||0} / ${r.jury.find(x=>x.teamId===team.id)?.expected||0}</td></tr>`).join('')||'<tr><td class="empty">请先建立名单</td></tr>'}</tbody></table></div></section>
  <details class="panel"><summary>人气票提交状态（${t.submittedBallots} / ${t.totalVoters} 人）</summary><div class="status-list">${a.voters.map(v=>`<div><span>${escape(v.name)}</span><span class="${submitted.has(v.id)?'success-text':'muted'}">${submitted.has(v.id)?'已提交':'未提交'}</span></div>`).join('')||'<p class="muted">暂无选手或观众</p>'}</div></details>`;
}
function results(a){
  const r=a.results,closed=a.event.phase==='closed';
  const missing=r.missing||[],zero=r.jury.filter(x=>!x.expected);
  return `<div class="page-intro"><h2>${a.event.phase==='published'?'好作品，值得被看见':'公布之前，再核对一次'}</h2><p>分数、回避和合议均有记录。导出成绩可留作活动归档。</p></div>
  <div class="export-row"><button id="export-csv">${icon('download')} 导出成绩表</button><button id="backup">${icon('download')} 保存完整备份</button><span class="muted">完整备份含私密资料，请仅交给工作人员。</span></div>
  ${missing.length||zero.length?`<div class="notice warning"><strong>暂不能公布：${missing.length} 份评分未交${zero.length?`，${zero.length} 队全部回避`:''}</strong><p>${missing.map(x=>`${escape(x.judgeName)} → ${escape(x.teamName)}`).join('；')}${zero.length?`<br>全部回避：${zero.map(x=>escape(x.name)).join('、')}。需要补充无利益关系的评委后再组织本场。`:''}</p></div>`:''}
  ${(r.unresolvedTies||[]).map((tie,i)=>`<div class="notice ${tie.kind==='jury'?'warning':''}"><div><strong>${tie.kind==='jury'?'评委同分 · 需要合议':'人气同票 · 奖项待定'}</strong><p>${tie.teamIds.map(id=>escape(a.teams.find(t=>t.id===id)?.name)).join('、')}</p></div>${closed||(a.event.phase==='published'&&tie.kind==='popular')?`<button data-tie="${i}">${tie.kind==='jury'?'记录合议顺序':'记录现场处理结果'}</button>`:'<span class="muted">截止后可记录处理结果</span>'}</div>`).join('')}
  ${closed&&r.ready?'<div class="success">评委评分已齐全，影响名次的合议已完成。核对无误后，可点击上方“公布结果”。</div>':''}
  ${resultTables(r,a.event.phase==='published')}
  ${a.decisions?.length?`<section class="panel"><h2>合议记录</h2>${a.decisions.map(d=>`<p>${escape(d.kind==='jury'?'评委同分':'人气同票')}：${escape(d.reason)}</p>`).join('')}</section>`:''}`;
}
export function renderAdmin(a,tab){
  return header(a,tab)+({setup,tickets,progress,order:renderPresentationOrder,results}[tab])(a);
}
async function saveSetup(){
  const form=$('#setup-form');if(!form.reportValidity())throw new Error('请先填写完整名单。');
  await json('/api/setup',readSetup());setupDraft=null;
}
function confirmPhase(a,phase){
  const messages={
    open:a.event.phase==='setup'?(a.event.entryMode==='phone'?`当前有 ${a.teams.length} 支队伍、${a.judges.length} 位评委，${a.voters.filter(v=>v.role==='player'&&!v.teamId).length} 位选手尚未组队。开放后仍可继续自助组队，创建的队伍会自动出现在评委名单里。已有评审记录或人气票的队伍会锁定；选手投票后不能换队。未组队选手需先登记队伍再投票。若已开启观众登记，评分期间观众仍可现场登记。请核对队伍后继续。`:'开放后名单、观众资格和票权将锁定。之后即可发放个人入口。'):'重新开放后评委可以修改评分，尚未投票的人可以提交。已投票的人不能重投，之前的同分合议将清除。',
    closed:'截止后所有手机将停止接受评分与投票。随后请核对缺分、回避及同分。',
    published:'公布后不再修改评分或投票。评委结果和人气结果会出现在公开展示页。人气同票尚未处理时将标注“待定”。'
  };
  modal(`<h2>${phase==='open'?'开放评比':phase==='closed'?'截止评分与投票':'公布现场结果'}</h2><p>${messages[phase]}</p><form><div class="dialog-actions"><button type="button" data-cancel>返回核对</button><button type="submit" class="primary">确认${phase==='open'?'开放':phase==='closed'?'截止':'公布'}</button></div></form>`,async()=>{
    if(a.event.phase==='setup'&&a.event.entryMode!=='phone')await saveSetup();
    await json('/api/phase',{phase});await refresh();navigate(phase==='open'?'tickets':'results');toast('比赛阶段已更新');
  });
}
function tieDialog(a,index){
  const tie=a.results.unresolvedTies[index],names=tie.teamIds.map(id=>a.teams.find(t=>t.id===id));
  modal(`<h2>${tie.kind==='jury'?'记录同分合议':'记录人气同票处理'}</h2><p>${tie.kind==='jury'?'只决定同分队伍的先后，原始分数保持不变。':'请依照现场已经确认的处理方式填写，系统不会自行指定赢家。不确定时可返回，保持“待定”。'}</p><form>${names.map((t,i)=>`<label>第 ${i+1} 顺位<select name="place${i}">${names.map(n=>`<option value="${escape(n.id)}" ${n.id===t.id?'selected':''}>${escape(n.name)}</option>`).join('')}</select></label>`).join('')}<label>处理依据与参与确认人员<textarea name="reason" required maxlength="1000" rows="3" placeholder="填写合议结论、依据和参与确认人员"></textarea></label><div class="dialog-actions"><button type="button" data-cancel>返回</button><button type="submit" class="primary">保存处理结果</button></div></form>`,async form=>{
    const teamIds=names.map((_,i)=>form.get(`place${i}`));if(new Set(teamIds).size!==teamIds.length)throw new Error('每个队伍只能出现一次，请检查顺位。');
    await json('/api/tie',{kind:tie.kind,teamIds,reason:form.get('reason')});await refresh();toast('同分处理已记录');
  });
}
export function bindAdmin(a,tab){
  if(tab==='order')bindPresentationOrder(a);
  $$('[data-go]').forEach(b=>b.onclick=()=>navigate(b.dataset.go));
  $$('[data-phase]').forEach(b=>b.onclick=()=>confirmPhase(a,b.dataset.phase));
  $('#public-view')?.addEventListener('click',()=>window.open(appPath('?public=1'),'_blank','noopener'));
  if(tab==='setup'&&a.event.entryMode==='phone')bindPhoneSetup(a);
  if(tab==='tickets'&&a.event.entryMode==='phone')bindPublicEntry(a);
  if(tab==='setup'&&a.event.phase==='setup'&&a.event.entryMode!=='phone'){
    $('#setup-form').onsubmit=async e=>{e.preventDefault();const b=$('button[form=setup-form]');b.disabled=true;try{await saveSetup();await refresh();toast('名单已保存，开放后再发放入口');}catch(e){toast(e.message,true);b.disabled=false;}};
    $('#add-team').onclick=()=>{const d=readSetup();d.teams.push({name:'',project:'',members:1});navigate('setup');};
    $('#add-judge').onclick=()=>{const d=readSetup();d.judges.push({name:''});navigate('setup');};
    $$('[data-delete-team]').forEach(b=>b.onclick=()=>{const d=readSetup();if(d.teams.length<=2)return toast('至少保留两支队伍',true);d.teams.splice(Number(b.dataset.deleteTeam),1);navigate('setup');});
    $$('[data-delete-judge]').forEach(b=>b.onclick=()=>{const d=readSetup();if(d.judges.length<=1)return toast('至少保留一位评委',true);d.judges.splice(Number(b.dataset.deleteJudge),1);navigate('setup');});
    $('[name=audienceEnabled]').onchange=e=>{$('[name=audienceCount]').disabled=!e.target.checked;};
    $('#start-event').onclick=()=>{if($('#setup-form').reportValidity())confirmPhase(a,'open');};
    $('#setup-form').addEventListener('input',readSetup);
  }
  if(tab==='tickets'&&a.event.phase!=='setup'&&a.event.entryMode!=='phone'){
    $('#apply-base').onclick=()=>{try{const u=new URL($('#base-url').value.trim());if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw 0;sessionStorage.setItem(storageKey('rating_base_url'),u.origin+u.pathname.replace(/\/$/,''));navigate('tickets');toast('二维码已更新，请先用一台手机确认能打开');}catch{toast('请填写完整的 http:// 或 https:// 访问地址',true);}};
    $$('[data-filter]').forEach(b=>b.onclick=()=>{ticketFilter=b.dataset.filter;ticketTeam='all';navigate('tickets');});
    $('#ticket-team')?.addEventListener('change',e=>{ticketTeam=e.target.value;navigate('tickets');});
    $$('[data-copy-token]').forEach(b=>b.onclick=()=>copyText(`${baseURL(a)}/#token=${encodeURIComponent(b.dataset.copyToken)}`));
    $('#print-tickets').onclick=()=>{
      if(!$('#ticket-cards article'))return toast('当前没有入口卡',true);
      document.body.classList.add('printing-tickets');window.print();setTimeout(()=>document.body.classList.remove('printing-tickets'),1000);
    };
  }
  if(tab==='results'){
    $$('[data-tie]').forEach(b=>b.onclick=()=>tieDialog(a,Number(b.dataset.tie)));
    $('#export-csv').onclick=async()=>{try{downloadBlob(await (await api('/api/export?format=csv')).blob(),'现场评比_成绩表.csv');}catch(e){toast(e.message,true);}};
    $('#backup').onclick=async()=>{try{downloadBlob(await (await api('/api/backup')).blob(),`现场评比_私密备份_${new Date().toISOString().slice(0,10)}.json`);toast('备份已下载，请妥善保存');}catch(e){toast(e.message,true);}};
  }
}
