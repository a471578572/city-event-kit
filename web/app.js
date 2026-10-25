import {SITE,readPublicEvent} from './site.js';
import {$,escape,toast,icon,phaseLabels,appPath,appRoot,storageKey,connectionLabel} from './common.js';
import {renderAdmin,bindAdmin} from './admin.js';
import {renderParticipant,bindParticipant} from './participant.js';
import {renderAwards} from './results.js';
import {normalizePhone} from './roster-csv.js';
import {renderPartners} from './partners.js';

const entryParams=new URLSearchParams(location.search);
const publicView=entryParams.has('public');
const organizerView=entryParams.get('admin')==='1';
const audienceView=entryParams.get('audience')==='1';
const audienceEntryURL=new URL('?audience=1',appRoot).href;
const fragment=new URLSearchParams(location.hash.slice(1));
let judgeEntryKey=publicView||audienceView?'':(fragment.get('judges')||sessionStorage.getItem(storageKey('judge_entry_key'))||'');
let token=publicView?'':(fragment.get('token')||sessionStorage.getItem(storageKey('rating_token'))||'');
if(fragment.has('judges')&&!publicView&&!audienceView){
  sessionStorage.setItem(storageKey('judge_entry_key'),judgeEntryKey);
  token='';sessionStorage.removeItem(storageKey('rating_token'));
}else if(fragment.has('token')&&!publicView){
  sessionStorage.setItem(storageKey('rating_token'),token);
}
if(fragment.has('token')||fragment.has('judges'))history.replaceState(null,'',location.pathname+location.search);
// A second private entry can open in the same browser tab.
window.addEventListener('hashchange',()=>{
  const next=new URLSearchParams(location.hash.slice(1));
  if(next.has('token')||next.has('judges'))location.reload();
});
let ctx=null,admin=null,active='setup',polling=false,phoneLoginBusy=false;
export async function api(path,body){
  const res=await fetch(appPath(path),{method:body===undefined?'GET':'POST',headers:{
    ...(token?{Authorization:`Bearer ${token}`} :{}),
    ...(body===undefined?{}:{'Content-Type':'application/json'})
  },...(body===undefined?{}:{body:JSON.stringify(body)}),cache:'no-store'});
  if(!res.ok){
    const err=await res.json().catch(()=>({error:'连接失败，请检查网络后重试。'}));
    const error=new Error(err.error||'操作未完成，请刷新查看最新记录。');
    error.status=res.status;
    throw error;
  }
  return res;
}
export async function json(path,body){return (await api(path,body)).json();}
async function readContext(){
  const requestToken=token;
  try{return await json('/api/context');}
  catch(error){
    if(error.status!==401||!requestToken||token!==requestToken)throw error;
    // Recover only a rejected context read; scoring and voting writes are never retried.
    token='';sessionStorage.removeItem(storageKey('rating_token'));admin=null;
    // Keep the private judge entry and the device key so the correct entry remains available.
    const next=await json('/api/context');
    toast('登录已失效，请重新进入');
    return next;
  }
}
export async function refresh({quiet=false,render=true}={}){
  try{
    ctx=await readContext();
    if(ctx.role==='admin')admin=await json('/api/admin');
    if(render)draw();
    const status=$('#connection');if(status)status.textContent=connectionLabel(ctx);
    return {ctx,admin};
  }catch(e){if(!quiet)toast(e.message,true);const s=$('#connection');if(s)s.textContent='连接中断，请保留页面后重试';throw e;}
}
export function navigate(tab){active=tab;draw();}
export function current(){return {ctx,admin,active};}
function brand(){return `<div class="brand"><span class="mark"><i></i><i></i><i></i><i></i></span><div><b>${escape(SITE.name)}</b><span>${escape([SITE.city,SITE.subtitle].filter(Boolean).join(' · '))}</span></div></div>`;}
function eventIdentity(){return `<div class="event-identity"><strong>${escape(SITE.name)}</strong><span>${escape(SITE.city)}</span><span>${escape(SITE.date)}</span><a class="guide-link" href="${appPath('guide.html')}">活动指引 ↗</a><a class="guide-link" href="${appPath('judges.html')}">评委介绍 ↗</a><a class="guide-link" href="${appPath('order.html')}">路演顺序 ↗</a><a class="guide-link organizer-link" href="${appPath('admin.html')}">组织者后台 ↗</a></div>`;}
function logos(){return `<div class="event-logos">${SITE.logos.map(logo=>`<img src="${escape(logo.src)}" alt="${escape(logo.name)}">`).join('')}</div>`;}
let publicJudges=[];
try{publicJudges=(await readPublicEvent()).judges;}catch{}
function organizerForm(){
  return `<section class="panel login-panel organizer-login-panel"><span class="state-tag">仅供本场组织者使用</span><h1>组织者后台</h1><p class="muted">输入主持电脑中 <code>data/admin.key</code> 的完整管理密钥。选手或评委入场码不能用于后台登录。</p><form id="organizer-login"><label for="organizer-key">管理密钥</label><input id="organizer-key" name="adminKey" type="password" required maxlength="512" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="粘贴你的管理密钥"><p id="organizer-login-error" class="login-error" role="alert" hidden></p><button class="primary full" type="submit">进入组织者后台 ${icon('arrow')}</button></form><p class="entry-help">请保管好密钥，不要发到活动群。也可以在主持电脑直接打开私密文件 <code>data/admin-entry.html</code>。</p><a class="entry-back-link" href="${appRoot.href}">返回选手 / 观众入口 →</a></section>`;
}
function bindOrganizerLogin(){
  $('#organizer-login')?.addEventListener('submit',async event=>{
    event.preventDefault();if(phoneLoginBusy)return;
    const form=event.target,input=$('#organizer-key'),error=$('#organizer-login-error'),button=$('button[type=submit]',form),candidate=input.value.trim();
    if(!candidate){error.textContent='请填写主持电脑中保存的管理密钥。';error.hidden=false;return;}
    phoneLoginBusy=true;button.disabled=true;button.textContent='正在核对…';error.hidden=true;
    try{
      const response=await fetch(appPath('/api/context'),{headers:{Authorization:`Bearer ${candidate}`},cache:'no-store'});
      if(response.status===401||response.status===403)throw new Error('invalid-admin-key');
      if(!response.ok)throw new Error('connection-error');
      const next=await response.json();
      if(next.role!=='admin')throw new Error('not-admin-key');
      // Persist only after the server has positively identified the administrator.
      token=candidate;sessionStorage.setItem(storageKey('rating_token'),token);
      judgeEntryKey='';sessionStorage.removeItem(storageKey('judge_entry_key'));
      await refresh({quiet:true});
    }catch(err){
      error.textContent=err.message==='invalid-admin-key'?'管理密钥不正确或已失效，请重新复制完整内容。':err.message==='not-admin-key'?'这个入口不是组织者管理密钥。请使用主持电脑 data/admin.key 中的完整密钥。':'暂时无法连接后台，请检查服务是否启动后重试。';
      error.hidden=false;input.value='';button.disabled=false;button.innerHTML=`进入组织者后台 ${icon('arrow')}`;
    }finally{phoneLoginBusy=false;}
  });
}
function audienceForm(){
  const canRegister=ctx.event.audienceEnabled&&['setup','open'].includes(ctx.event.phase);
  return `<div class="panel login-panel phone-login-panel audience-login-panel"><span class="state-tag">观众入口 · 每人 2 票</span><h2>${canRegister?'来，为喜欢的作品投票':'进入我的观众页'}</h2><p class="muted">${canRegister?'填写姓名或称呼、手机号，即可现场登记。无需提前报名。':'当前暂停新增观众登记。已登记观众仍可填写原称呼和手机号，查看自己的页面与投票记录。'}</p><form id="audience-login"><label for="audience-name">姓名 / 称呼</label><input id="audience-name" name="name" required maxlength="100" autocomplete="name" placeholder="大家怎么称呼你"><label for="audience-phone">手机号</label><input id="audience-phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" required maxlength="20" placeholder="请输入 11 位手机号"><p id="audience-login-error" class="login-error" role="alert" hidden></p><button class="primary full" type="submit">${canRegister?'登记并进入':'进入我的页面'} ${icon('arrow')}</button></form><p class="audience-vote-rule">每人最多 2 票，每队最多 1 票。提交后不可修改。</p><p class="entry-help">手机号用于识别本人入口，不公开展示。已登记观众可换手机或浏览器，填写原称呼和手机号进入同一账号；原投票保留，不会增加票数。已登记为选手的手机号，会按原选手身份进入。</p><a class="entry-back-link" href="${appRoot.href}">返回选手入口 ↗</a></div>`;
}
function entryForm(){
  if(audienceView&&ctx.event.entryMode==='phone')return audienceForm();
  if(judgeEntryKey)return `<div class="panel login-panel judge-login-panel"><span class="state-tag">评委专用入口</span><h2>请选择你的姓名</h2><p class="muted">点击本人姓名，进入评分页面。</p><div class="judge-name-buttons">${publicJudges.map(({name})=>`<button type="button" class="primary" data-judge-name="${escape(name)}">${escape(name)} ${icon('arrow')}</button>`).join('')||'<p class="muted">暂无可读取的评委名单，请刷新或联系工作人员。</p>'}</div><p id="judge-login-error" class="login-error" role="alert" hidden></p><p class="entry-help">可换手机或浏览器重新扫描评委专用码，点选本人姓名进入同一评分账号。已有评分会保留。</p><button id="return-player-entry" type="button" class="text-button">返回选手 / 观众入口</button></div>`;
  if(ctx.event.entryMode!=='phone')return `<div class="panel login-panel"><h2>进入评分或投票</h2><p class="muted">请扫描组织者发给你的专属二维码，<br>或输入个人入场码。</p><form id="login"><label for="ticket">个人入场码</label><input id="ticket" name="ticket" autocomplete="off" spellcheck="false" required placeholder="输入入场码"><button class="primary full" type="submit">进入 ${icon('arrow')}</button></form></div>`;
  return `<div class="panel login-panel phone-login-panel"><span class="state-tag">选手入场入口</span><h2>你的手机号，就是入口</h2><p class="muted">填写报名时的手机号，进入你的参赛页面。</p><form id="phone-login"><label for="entry-phone">报名手机号</label><input id="entry-phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" required maxlength="20" placeholder="请输入 11 位手机号"><p id="phone-login-error" class="login-error" role="alert" hidden></p><button class="primary full" type="submit">进入我的页面 ${icon('arrow')}</button></form><a class="audience-entry-cta" href="${audienceEntryURL}"><strong>我是观众，现场登记</strong><span>姓名 + 手机号 · 每人 2 票 ${icon('arrow')}</span></a><p class="entry-help">可换手机或浏览器，用报名手机号进入同一账号。队伍和投票记录保留，不会增加票数。</p>${SITE.registrationUrl?`<p class="muted">参赛还没登记？<a href="${escape(SITE.registrationUrl)}" target="_blank" rel="noopener noreferrer">打开活动报名页 ↗</a></p>`:''}<p class="muted">已报名但无法进入，请找工作人员更新名单。</p></div><div class="judges-intro"><span>本场评委</span>${publicJudges.map(j=>`<strong>${escape(j.name)}</strong>`).join('')||'<span>待公布</span>'}</div>`;
}
let temporaryDeviceKey='';
function deviceKey(){
  const key=storageKey('rating_device_key');
  try{
    const value=localStorage.getItem(key);
    if(/^[a-f0-9]{64}$/.test(value||''))return value;
  }catch{}
  if(!temporaryDeviceKey){
    const bytes=new Uint8Array(32);crypto.getRandomValues(bytes);
    temporaryDeviceKey=Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('');
  }
  // Storage can be disabled in a browser; keep a temporary key for this page instead.
  try{localStorage.setItem(key,temporaryDeviceKey);}catch{}
  return temporaryDeviceKey;
}
function bindPhoneLogin(){
  $('#phone-login')?.addEventListener('submit',async event=>{
    event.preventDefault();if(phoneLoginBusy)return;
    const form=event.target,error=$('#phone-login-error'),button=$('button[type=submit]',form),phone=normalizePhone(new FormData(form).get('phone'));
    if(!/^1\d{10}$/.test(phone)){error.textContent='请填写报名时使用的 11 位手机号。';error.hidden=false;return;}
    phoneLoginBusy=true;button.disabled=true;button.textContent='正在进入…';error.hidden=true;
    try{
      const result=await json('/api/login',{phone,deviceKey:deviceKey()});
      if(!result.token)throw new Error('未收到入场确认，请联系工作人员。');
      token=result.token;sessionStorage.setItem(storageKey('rating_token'),token);
      await refresh({quiet:true});
    }catch(err){error.textContent=err.message;error.hidden=false;button.disabled=false;button.innerHTML=`进入我的页面 ${icon('arrow')}`;}
    finally{phoneLoginBusy=false;}
  });
}
function bindAudienceLogin(){
  $('#audience-login')?.addEventListener('submit',async event=>{
    event.preventDefault();if(phoneLoginBusy)return;
    const form=event.target,error=$('#audience-login-error'),button=$('button[type=submit]',form),data=new FormData(form);
    const name=String(data.get('name')||'').trim(),phone=normalizePhone(data.get('phone'));
    if(!name||name.length>100){error.textContent='请填写 1—100 字的姓名或称呼。';error.hidden=false;return;}
    if(!/^1\d{10}$/.test(phone)){error.textContent='请填写正确的 11 位手机号。';error.hidden=false;return;}
    const buttonText=button.innerHTML;
    phoneLoginBusy=true;button.disabled=true;button.textContent='正在进入…';error.hidden=true;
    try{
      const result=await json('/api/audience/register',{name,phone,deviceKey:deviceKey()});
      if(!result.token)throw new Error('未收到入场确认，请联系工作人员。');
      token=result.token;sessionStorage.setItem(storageKey('rating_token'),token);
      await refresh({quiet:true});
      if(ctx.role==='player')toast('你已按原选手身份进入，每位选手各有自己的 3 票。');
    }catch(err){error.textContent=err.message;error.hidden=false;button.disabled=false;button.innerHTML=buttonText;}
    finally{phoneLoginBusy=false;}
  });
}
function bindJudgeLogin(){
  const buttons=[...document.querySelectorAll('[data-judge-name]')],back=$('#return-player-entry');
  buttons.forEach(button=>button.addEventListener('click',async()=>{
    if(phoneLoginBusy)return;
    const error=$('#judge-login-error');phoneLoginBusy=true;error.hidden=true;
    buttons.forEach(b=>b.disabled=true);if(back)back.disabled=true;
    try{
      const result=await json('/api/judges/login',{name:button.dataset.judgeName,entryKey:judgeEntryKey,deviceKey:deviceKey()});
      if(!result.token)throw new Error('未收到入场确认，请联系工作人员。');
      token=result.token;sessionStorage.setItem(storageKey('rating_token'),token);
      await refresh({quiet:true});
    }catch(err){error.textContent=err.message;error.hidden=false;buttons.forEach(b=>b.disabled=false);if(back)back.disabled=false;}
    finally{phoneLoginBusy=false;}
  }));
  back?.addEventListener('click',()=>{judgeEntryKey='';sessionStorage.removeItem(storageKey('judge_entry_key'));token='';sessionStorage.removeItem(storageKey('rating_token'));draw();});
}
function welcomeContent(){
  const compact=ctx.event.entryMode==='phone'||judgeEntryKey;
  const guide=`<a class="guide-cta" href="${appPath('guide.html')}">查看活动指引与评比规则 ${icon('arrow')}</a>`;
  return `<section class="welcome${compact?' phone-welcome':''}"><div class="big-mark">${icon('check')}</div><h1>${escape(ctx.event.name||'现场评比')}</h1><p class="welcome-slogan">让每一份认真，得到回应。</p>${compact?entryForm()+guide:guide+entryForm()}<p class="muted">${judgeEntryKey?'专用入口只供本场已登记评委使用。':ctx.event.entryMode==='phone'?'评分与投票开放时，页面会自动更新。':'尚未公布结果。请等待主持人通知。'}</p></section>`;
}
function publishedGuestContent(){
  if(audienceView&&ctx.event.entryMode==='phone')return `${renderAwards(ctx)}<section class="published-certificate-login" aria-label="观众入口">${entryForm()}</section>`;
  return `${renderAwards(ctx)}<section class="published-certificate-login" id="certificate-login" aria-label="登录领取个人证书"><div class="certificate-login-heading"><span class="state-tag">${judgeEntryKey?'评委专属':'选手专属'}</span><h2>${judgeEntryKey?'评委入口':'登录领取我的证书'}</h2><p>${judgeEntryKey?'扫描评委专用码后，选择本人姓名。':'用参赛时的入口登录，查看属于自己的参赛证书与获奖证书。'}</p></div>${entryForm()}</section>`;
}
function audienceIdentityNotice(){
  if(!audienceView||ctx.role==='guest'||ctx.role==='audience')return '';
  return `<div class="notice audience-identity-notice"><strong>当前已按${ctx.role==='player'?'选手':ctx.role==='judge'?'评委':'管理员'}身份进入。</strong><p>${ctx.role==='player'?'请使用现有选手身份投票，不另外领取观众票。每位选手都有自己的票，队友分别投票。':'请继续使用当前身份；如需切换入口，可点击退出。'}</p></div>`;
}
function votingFooter(){return '<p>选手每位 3 票 · 观众每人 2 票 · 每人每队最多 1 票 · 选手不能投本队</p><p>每位选手都有自己的票，队友分别投票。</p>';}
function draw(){
  const root=$('#app');
  if(organizerView&&ctx.role!=='admin'){
    root.innerHTML=`<div class="participant-shell"><header>${brand()}<a class="text-button" href="${appRoot.href}">返回活动入口</a></header>${eventIdentity()}<main>${organizerForm()}</main></div>`;
    bindOrganizerLogin();return;
  }
  if(ctx.role==='admin'){
    const items=[['setup','比赛设置'],['tickets','入口发放'],['progress','评分进度'],['order','路演抽签'],['results','结果与导出']];
    root.innerHTML=`<div class="app-shell"><aside>${brand()}<div class="sidebar-event">${escape(SITE.name)}<br>${escape(SITE.city)}<br><small>${escape(SITE.date)}</small></div><nav>${items.map(([id,name])=>`<button class="${active===id?'active':''}" data-tab="${id}">${icon(id)}${name}</button>`).join('')}</nav><div class="sidebar-bottom">${logos()}<div>${icon('screen')}<span>${ctx.publicBaseUrl?'数据统一保存在线上':'数据保存在主持电脑'}</span></div><button class="text-button" id="logout">退出管理</button></div></aside><main class="admin-main">${eventIdentity()}${audienceIdentityNotice()}${renderAdmin(admin,active)}${renderPartners({compact:true})}</main></div>`;
    document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>navigate(b.dataset.tab));
    bindAdmin(admin,active);
  }else if(ctx.role==='guest'){
    root.innerHTML=`<div class="participant-shell${ctx.event.entryMode==='phone'||judgeEntryKey?' phone-entry-shell':''}"><header>${brand()}<span class="phase">${escape(phaseLabels[ctx.event.phase])}</span></header>${eventIdentity()}<main>${ctx.event.phase==='published'?publishedGuestContent():welcomeContent()}</main><footer>${renderPartners()}${votingFooter()}</footer></div>`;
    bindPhoneLogin();
    bindAudienceLogin();
    bindJudgeLogin();
    $('#login')?.addEventListener('submit',async e=>{e.preventDefault();const candidate=new FormData(e.target).get('ticket').trim();token=candidate;try{await refresh();if(token)sessionStorage.setItem(storageKey('rating_token'),token);}catch{token='';}});
  }else{
    root.innerHTML=`<div class="participant-shell"><header>${brand()}<button id="logout" class="text-button">${icon('logout')} 退出</button></header>${eventIdentity()}<main>${audienceIdentityNotice()}${renderParticipant(ctx)}</main><footer><p id="connection">${connectionLabel(ctx)}</p>${renderPartners()}${votingFooter()}</footer></div>`;
    bindParticipant(ctx);
  }
  $('#logout')?.addEventListener('click',()=>{const wasAdmin=ctx.role==='admin';token='';sessionStorage.removeItem(storageKey('rating_token'));if(wasAdmin){location.href=appRoot.href;return;}refresh();});
}
document.title=SITE.name+(organizerView?' · 组织者后台':' · 现场评比');
await refresh().catch(()=>{
  $('#app').innerHTML=`<div class="loading"><h1>暂时无法连接</h1><p>请检查网络后重试；若使用本地版，请确认主持电脑上的工具已启动。</p><button id="retry" class="primary">重新连接</button><button id="clear">重新进入活动</button></div>`;
  $('#retry').onclick=()=>location.reload();
  $('#clear').onclick=()=>{sessionStorage.removeItem(storageKey('rating_token'));location.href=audienceView?audienceEntryURL:appRoot.href;};
});
setInterval(async()=>{
  if(polling||phoneLoginBusy||document.hidden||$('#dialog').open)return;
  if(ctx?.role==='admin'&&!['progress','results'].includes(active))return;
  const focus=document.activeElement;
  if(focus&&['INPUT','SELECT','TEXTAREA'].includes(focus.tagName))return;
  polling=true;
  try{
    // Input focus pauses polling; drafts survive team, identity, and phase updates.
    if(ctx?.role!=='admin'){
      const next=await readContext();
      if(!ctx||next.role!==ctx.role||next.event.phase!==ctx.event.phase||next.event.entryMode!==ctx.event.entryMode||next.event.teamsOpen!==ctx.event.teamsOpen||next.event.audienceEnabled!==ctx.event.audienceEnabled||next.identity?.teamId!==ctx.identity?.teamId||next.identity?.voteLimit!==ctx.identity?.voteLimit||JSON.stringify(next.judge)!==JSON.stringify(ctx.judge)||JSON.stringify(next.scores)!==JSON.stringify(ctx.scores)||JSON.stringify(next.teams)!==JSON.stringify(ctx.teams)||JSON.stringify(next.playerCards)!==JSON.stringify(ctx.playerCards)||JSON.stringify(next.invitations)!==JSON.stringify(ctx.invitations)||JSON.stringify(next.certificates)!==JSON.stringify(ctx.certificates)||(!ctx.ballot&&next.ballot)||(next.event.phase==='published'&&JSON.stringify(next.results)!==JSON.stringify(ctx.results))){ctx=next;draw();}
      const status=$('#connection');if(status)status.textContent=connectionLabel(ctx);
    }else await refresh({quiet:true});
  }catch{const s=$('#connection');if(s)s.textContent='连接中断，请保留页面后重试';}
  finally{polling=false;}
},6000);
