import {$,escape,toast,copyText,appPath,storageKey} from './common.js';
import {json,refresh} from './app.js';

const pendingKey=storageKey('presentation_draw_request');
let submitting=false;
function savedRequest(){try{return JSON.parse(sessionStorage.getItem(pendingKey)||'null');}catch{return null;}}
function view(a){
  const saved=a.presentationOrder||{},byId=new Map(a.teams.map(t=>[t.id,t]));
  const ids=Array.isArray(saved.teamIds)?saved.teamIds:(saved.teams||[]).map(t=>t.id);
  const teams=ids.map(id=>byId.get(id)).filter(Boolean),included=new Set(ids);
  return {revision:saved.revision||0,drawnAt:saved.drawnAt,teams,pending:a.teams.filter(t=>!included.has(t.id))};
}
function rows(teams){return teams.map((t,i)=>`<tr><td><strong class="order-position">${String(i+1).padStart(2,'0')}</strong></td><td><strong>${escape(t.name)}</strong><span class="subline">${escape(t.project||'作品名称待填写')}</span></td></tr>`).join('');}
export function renderPresentationOrder(a){
  const v=view(a),retry=savedRequest(),locked=a.event.phase==='published';
  const date=v.drawnAt?new Date(v.drawnAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'';
  return `<div class="page-intro"><h2>一键抽签，按顺序上台</h2><p>随机排列所有当前队伍，保存后大家可直接查看。路演顺序独立于比赛成绩和人气排名。</p></div>
  <section class="panel order-controls"><div><span class="state-tag">${v.revision?`第 ${v.revision} 次抽签`:'尚未抽签'}</span><h2>当前 ${a.teams.length} 支队伍</h2><p class="muted">${v.revision?`${escape(date)} 已保存 · 刷新不会改变顺序`:'请在队伍登记齐全后点击抽签。'}</p></div><div class="button-row"><button class="primary" id="draw-presentation-order" ${submitting||!a.teams.length||locked?'disabled':''}>${submitting?'正在保存…':retry?'重试上次抽签请求':v.revision?'重新随机排序（替换现有顺序）':'随机生成路演顺序'}</button><a class="button" href="${appPath('order.html')}" target="_blank" rel="noopener">打开公开顺序 / 投屏 ↗</a><button id="copy-presentation-order">复制公开链接</button></div></section>
  ${locked?'<p class="notice">结果已公布，路演顺序保持不变。</p>':''}
  ${retry?'<p class="notice warning">上次请求尚未确认。重试会核对同一次抽签，不会重复抽签；也可先刷新核对已保存结果。</p>':''}
  ${v.pending.length&&v.revision?`<section class="notice warning"><strong>${v.pending.length} 支队伍待加入抽签</strong><p>${v.pending.map(t=>escape(t.name)).join('、')}。重新随机排序会包含所有当前队伍，并替换整份顺序。</p></section>`:''}
  <section class="panel"><div class="panel-title"><h2>已保存的路演顺序</h2><span class="muted">${v.teams.length} 支队伍</span></div>${v.teams.length?`<div class="table-wrap"><table><thead><tr><th>上台顺序</th><th>队伍 / 作品</th></tr></thead><tbody>${rows(v.teams)}</tbody></table></div>`:`<p class="empty">${a.teams.length?'尚未抽签，点击上方按钮生成。':'暂时没有队伍，选手创建队伍后即可抽签。'}</p>`}</section>`;
}
export function bindPresentationOrder(a){
  $('#copy-presentation-order')?.addEventListener('click',()=>copyText(appPath('order.html')));
  $('#draw-presentation-order')?.addEventListener('click',async()=>{
    if(submitting)return;
    const button=$('#draw-presentation-order');submitting=true;button.disabled=true;button.textContent='正在保存…';
    let request=savedRequest();
    if(!request){request={requestId:crypto.randomUUID(),expectedRevision:view(a).revision};sessionStorage.setItem(pendingKey,JSON.stringify(request));}
    try{
      await json('/api/presentation-order',request);sessionStorage.removeItem(pendingKey);toast('路演顺序已保存，公开页面已同步');
    }catch(err){
      // A revision conflict is a known failure; discard it so the next explicit draw uses fresh state.
      if(/顺序.*更新|版本|刷新后重试|已被更新/.test(err.message)){sessionStorage.removeItem(pendingKey);}
      toast(err.message,true);
    }finally{submitting=false;await refresh().catch(()=>{button.disabled=false;button.textContent='重试上次抽签请求';});}
  });
}
