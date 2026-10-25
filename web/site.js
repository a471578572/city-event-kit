// Public presentation settings only. Never put login tokens or private data here.
const defaults={name:'城市活动评比',city:'你的城市',date:'',subtitle:'一起把想法变成作品',logos:[{name:'活动标识',src:'./assets/event-mark.svg'}],registrationUrl:'',handbookUrl:'',publicPlayerWall:false,certificateIssuer:'活动组委会'};
const string=value=>typeof value==='string'?value.trim():'';
export function safePublicURL(value){
  try{const url=new URL(string(value),import.meta.url);return string(value)&&['http:','https:'].includes(url.protocol)&&!url.username&&!url.password?url.href:'';}catch{return '';}
}
export function safeLogoURL(value){
  const url=safePublicURL(value);
  return url&&new URL(url).origin===new URL(import.meta.url).origin?url:'';
}
let loaded={};
export let SITE_CONFIG_ERROR=false;
try{const response=await fetch(new URL('./site-config.json',import.meta.url),{cache:'no-store'});if(!response.ok)throw 0;loaded=await response.json();if(!loaded||typeof loaded!=='object'||Array.isArray(loaded))throw 0;}catch{SITE_CONFIG_ERROR=true;}
export const SITE=Object.freeze({
  name:string(loaded.name)||defaults.name,city:string(loaded.city)||defaults.city,date:string(loaded.date),subtitle:string(loaded.subtitle)||defaults.subtitle,
  logos:(Array.isArray(loaded.logos)?loaded.logos:defaults.logos).map(item=>({name:string(item?.name)||'活动伙伴',src:safeLogoURL(item?.src)})).filter(item=>item.src),
  registrationUrl:safePublicURL(loaded.registrationUrl),handbookUrl:safePublicURL(loaded.handbookUrl),
  publicPlayerWall:loaded.publicPlayerWall===true,certificateIssuer:string(loaded.certificateIssuer)||defaults.certificateIssuer,
});
export const siteFileStem=()=>[SITE.name,SITE.city].filter(Boolean).join('_').replace(/[\\/:*?"<>|\u0000-\u001f]/g,'_');
export async function readPublicEvent(){
  const response=await fetch(new URL('./api/public-event',import.meta.url),{cache:'no-store',credentials:'omit'});
  if(!response.ok)throw new Error('暂时无法读取公开活动信息。');
  const data=await response.json();
  return {event:data.event||SITE,judges:Array.isArray(data.judges)?data.judges.filter(j=>j&&typeof j.name==='string'&&j.name.trim()).map(j=>({name:j.name,bio:string(j.bio)})):[]};
}
