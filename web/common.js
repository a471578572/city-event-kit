export const $ = (q, root=document) => root.querySelector(q);
export const $$ = (q, root=document) => [...root.querySelectorAll(q)];
export const appRoot = new URL('./', import.meta.url);
export const appPath = path => new URL(path.replace(/^\//,''), appRoot).href;
export const storageKey = name => appRoot.pathname === '/' ? name : `${name}:${appRoot.pathname}`;
export const connectionLabel = ctx => ctx?.deploymentMode==='demo' ? '本地演示 · 不计入正式比赛' : ctx?.publicBaseUrl ? '已连接线上评比' : '已连接主持电脑';
export const escape = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const labels = ['完成度与可用性','创意','场景价值','展示'];
export const weights = [30,25,25,20];
export const phaseLabels = {setup:'准备中',open:'评分与投票进行中',closed:'已截止 · 核对中',published:'结果已公布'};
export const icons = {
  setup:'<path d="m9 3-1 3-3 1v4l3 1 1 3h4l1-3 3-1V7l-3-1-1-3Z"/><circle cx="11" cy="9" r="2"/>',
  tickets:'<path d="m3 9 15-6-6 15-3-6Z"/><path d="m9 12 9-9"/>',
  progress:'<path d="M7 5h12M7 11h12M7 17h12"/><circle cx="3" cy="5" r=".5"/><circle cx="3" cy="11" r=".5"/><circle cx="3" cy="17" r=".5"/>',
  results:'<path d="M4 18V12M10 18V7M16 18V2"/>',
  plus:'<path d="M10 3v14M3 10h14"/>',
  trash:'<path d="M3 5h14M8 2h4M5 5l1 13h8l1-13M8 8v7M12 8v7"/>',
  arrow:'<path d="M3 10h14m-5-5 5 5-5 5"/>',
  check:'<path d="m4 10 4 4 9-9"/>',
  screen:'<rect x="2" y="3" width="16" height="11" rx="1"/><path d="M7 18h6m-3-4v4"/>',
  download:'<path d="M10 2v11m-5-5 5 5 5-5M3 14v4h14v-4"/>',
  logout:'<path d="M8 3H3v14h5m3-12 5 5-5 5m-4-5h9"/>',
};
export const icon = name => `<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]||icons.check}</svg>`;
let timer;
export function toast(message, error=false) {
  const el=$('#toast'); el.textContent=message; el.className=error?'show error':'show';
  clearTimeout(timer);timer=setTimeout(()=>el.className='',error?8000:4000);
}
export function formatScore(value){return value===null||value===undefined?'—':Number(value).toFixed(4);}
export function rulesBlock() {
  return `<div class="weight-grid">${labels.map((x,i)=>`<div><span>${x.replace('与','与<wbr>')}</span><strong>${weights[i]}<small>%</small></strong></div>`).join('')}</div>`;
}
export function modal(html, onSubmit) {
  const d=$('#dialog');$('#dialog-body').innerHTML=html;
  if(!d.open)d.showModal();
  $('[data-cancel]',d)?.addEventListener('click',()=>d.close());
  $('form',d)?.addEventListener('submit',async e=>{
    e.preventDefault();const b=$('button[type=submit]',d);if(b)b.disabled=true;
    try {await onSubmit(new FormData(e.target));d.close();}
    catch(err){toast(err.message,true);if(b)b.disabled=false;}
  });
}
export async function copyText(value){
  try{await navigator.clipboard.writeText(value);toast('已复制');}
  catch{
    modal(`<h2>复制入口</h2><p>长按或选中下方文字复制。</p><textarea readonly rows="4">${escape(value)}</textarea><div class="dialog-actions"><button data-cancel>关闭</button></div>`);
    $('#dialog textarea').select();
  }
}
export function downloadBlob(blob,name){
  const u=URL.createObjectURL(blob);const a=document.createElement('a');a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),5000);
}
