import {SITE} from './site.js';
import {escape} from './common.js';
export function renderPartners({compact=false}={}){
  if(!SITE.logos.length)return '';
  const grid=`<div class="activity-partners-grid">${SITE.logos.map(p=>`<figure class="activity-partner"><div class="partner-image"><img src="${escape(p.src)}" alt="${escape(p.name)}" loading="lazy" decoding="async" width="160" height="72"></div><figcaption>${escape(p.name)}</figcaption></figure>`).join('')}</div>`;
  return compact?`<details class="activity-partners admin-partners"><summary>活动伙伴</summary>${grid}</details>`:`<section class="activity-partners" aria-label="活动伙伴"><div class="partners-heading"><h2>活动伙伴</h2><span>${escape(SITE.subtitle)}</span></div>${grid}</section>`;
}
