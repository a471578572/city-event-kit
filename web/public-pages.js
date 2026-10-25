import {SITE,SITE_CONFIG_ERROR,readPublicEvent} from './site.js';
const make=(tag,text)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;return el;};
export function applySite(){
  document.querySelectorAll('[data-site-name]').forEach(el=>el.textContent=SITE.name);
  document.querySelectorAll('[data-site-date]').forEach(el=>el.textContent=[SITE.city,SITE.date].filter(Boolean).join(' · '));
  document.querySelectorAll('[data-site-subtitle]').forEach(el=>el.textContent=SITE.subtitle);
  document.querySelectorAll('[data-site-footer]').forEach(el=>el.textContent=[SITE.name,SITE.city,SITE.date].filter(Boolean).join(' · '));
  document.querySelectorAll('[data-site-brand]').forEach(el=>{el.replaceChildren();if(SITE.logos[0]){const image=make('img');image.src=SITE.logos[0].src;image.alt=SITE.logos[0].name;el.append(image);}const text=make('span',SITE.name);text.append(make('small',SITE.city));el.append(text);});
  const partners=document.getElementById('public-partners');
  if(partners)partners.replaceChildren(...SITE.logos.map(logo=>{const card=make('figure');card.className='guide-partner';const box=make('div'),image=make('img');image.src=logo.src;image.alt=logo.name;image.loading='lazy';box.append(image);card.append(box,make('figcaption',logo.name));return card;}));
  const handbook=document.getElementById('handbook-link');if(handbook&&SITE.handbookUrl){handbook.href=SITE.handbookUrl;handbook.hidden=false;}
  const registration=document.getElementById('registration-link');if(registration&&SITE.registrationUrl){registration.href=SITE.registrationUrl;registration.hidden=false;}
  if(SITE_CONFIG_ERROR){const notice=make('p','暂时无法读取本场公开配置，当前显示通用页面。请联系工作人员检查活动配置。');notice.className='public-notice';document.querySelector('main')?.prepend(notice);}
}
applySite();
if(document.body.dataset.page==='guide'){
  document.title=SITE.name+' · 活动指引';
  // Public profiles are never fetched merely because this page has been opened.
  if(SITE.publicPlayerWall){
    document.getElementById('public-wall-note').textContent='本场允许公开展示下方选手墙；邀请队友请用已登记手机号进入选手页面。';
    document.getElementById('public-player-wall').hidden=false;
    const status=document.getElementById('public-player-status');status.textContent='正在读取公开选手资料…';
    try{
      const response=await fetch(new URL('./api/public-guide',import.meta.url),{cache:'no-store',credentials:'omit'});if(!response.ok)throw 0;
      const data=await response.json();if(!Array.isArray(data.players))throw 0;
      const fields=[['background','背景'],['participation','参与方式'],['directions','创作方向'],['skills','擅长'],['experience','AI 经验']];
      document.getElementById('public-player-cards').replaceChildren(...data.players.map(person=>{const card=make('article');card.className='public-panel';card.append(make('h2',person.name),make('p',person.teamName||'待组队'));for(const [key,label] of fields){if(person.profile?.[key])card.append(make('h3',label),make('p',person.profile[key]));}return card;}));
      status.textContent=`公开资料 ${data.players.length} 位，不显示联系方式。`;
    }catch{status.textContent='暂时无法读取选手墙，请刷新重试。';}
  }
}
if(document.body.dataset.page==='judges'){
  document.title=SITE.name+' · 评委介绍';
  const status=document.getElementById('judge-status'),list=document.getElementById('public-judges');
  try{const {judges}=await readPublicEvent();status.textContent=judges.length?`本场共 ${judges.length} 位评委`:'评委名单尚未公布。';list.replaceChildren(...judges.map((judge,index)=>{const card=make('article');card.className='judge-public-card';card.append(make('span',`JUDGE / ${String(index+1).padStart(2,'0')}`),make('h2',judge.name),make('p',judge.bio||'介绍待补充'));return card;}));}
  catch{status.textContent='暂时无法读取评委名单，请刷新页面重试。';}
}
