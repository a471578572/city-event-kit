import {SITE} from './site.js';
import {escape,icon} from './common.js';

const TEMPLATE_SIZE={width:1491,height:1055};
const FONT_FAMILY='"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC",sans-serif';
// Original generic layout; no external certificate artwork is bundled.
const fields=[
  {key:'personName',label:'姓名',x:300,y:405,w:1040,h:55,max:35,min:18,lines:2},
  {key:'teamName',label:'队伍',x:300,y:495,w:1040,h:55,max:33,min:18,lines:2},
  {key:'project',label:'作品',x:300,y:585,w:1040,h:65,max:33,min:18,lines:2},
  {key:'city',label:'城市',x:300,y:685,w:1040,h:45,max:30,min:18,lines:1},
  {key:'formattedDate',label:'颁发日期',x:300,y:825,w:450,h:32,max:23,min:16,lines:1},
  {key:'number',label:'证书编号',x:935,y:825,w:405,h:32,max:22,min:12,lines:1},
];
const TEMPLATES={participation:{label:'参赛证书',fields},top3:{label:'本地前三证书',fields:[...fields,{key:'rankText',label:'名次',x:300,y:745,w:1040,h:45,max:30,min:18,lines:1}]},popular:{label:'人气奖证书',fields}};
let disposeActiveBinding=null;
const text=value=>String(value??'').replace(/\s+/gu,' ').trim();
const certificateList=ctx=>Array.isArray(ctx?.certificates)?ctx.certificates:[];
const isDemo=ctx=>ctx?.deploymentMode==='demo';

if(typeof window!=='undefined')window.addEventListener('pagehide',event=>{if(!event.persisted)disposeActiveBinding?.();});
function normalizeCertificate(raw){
  if(!raw||!Object.prototype.hasOwnProperty.call(TEMPLATES,raw.kind))throw new Error('暂不支持这类证书，请联系主持人核对。');
  const value={kind:raw.kind};
  for(const [key,label] of [['personName','姓名'],['teamName','队名'],['project','作品'],['city','城市'],['date','颁发日期'],['number','证书编号']]){
    value[key]=text(raw[key]);
    if(!value[key])throw new Error(`证书缺少${label}，请联系主持人核对后再下载。`);
  }
  const parts=/^(\d{4})-(\d{2})-(\d{2})$/.exec(value.date);
  if(!parts)throw new Error('证书日期格式有误，请联系主持人核对。');
  const date=new Date(`${value.date}T00:00:00Z`);
  if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==value.date)throw new Error('证书日期无效，请联系主持人核对。');
  value.formattedDate=`${parts[1]}年${Number(parts[2])}月${Number(parts[3])}日`;
  value.title=text(raw.title)||TEMPLATES[value.kind].label;
  value.recipient=`${value.personName} · ${value.teamName}`;
  value.teamProject=`${value.teamName} / ${value.project}`;
  if(value.kind==='top3'){
    if(!Number.isInteger(raw.rank)||raw.rank<1||raw.rank>3)throw new Error('前三证书的名次尚未确认，请联系主持人核对。');
    value.rankText=`第 ${raw.rank} 名`;
  }
  return value;
}
async function loadEventLogo(){
  if(!SITE.logos[0])return null;
  return new Promise(resolve=>{const image=new Image();const timer=setTimeout(()=>resolve(null),4000);image.onload=()=>{clearTimeout(timer);resolve(image);};image.onerror=()=>{clearTimeout(timer);resolve(null);};image.src=SITE.logos[0].src;});
}
async function waitForFonts(sample){
  if(document.fonts?.load){
    await document.fonts.load(`600 30px ${FONT_FAMILY}`,sample);
    await document.fonts.ready;
  }
}
function graphemes(value){
  if(typeof Intl.Segmenter==='function')return [...new Intl.Segmenter('zh-CN',{granularity:'grapheme'}).segment(value)].map(item=>item.segment);
  return Array.from(value);
}
function wrapText(context,value,width){
  const result=[];let line='';
  for(const char of graphemes(value)){
    if(line&&context.measureText(line+char).width>width){result.push(line.trimEnd());line=char.trimStart();}
    else line+=char;
  }
  if(line)result.push(line.trimEnd());
  return result;
}
function drawField(context,value,field){
  context.fillStyle='#182139';context.textAlign='left';context.textBaseline='middle';
  for(let size=field.max;size>=field.min;size--){
    context.font=`600 ${size}px ${FONT_FAMILY}`;
    const lines=wrapText(context,value,field.w),lineHeight=size*1.13;
    if(lines.length>field.lines||lines.length*lineHeight>field.h)continue;
    if(lines.some(line=>context.measureText(line).width>field.w))continue;
    const first=field.y+field.h-lines.length*lineHeight+lineHeight/2;
    lines.forEach((line,index)=>context.fillText(line,field.x,first+index*lineHeight));
    return;
  }
  throw new Error(`“${field.label}”内容过长，当前模板放不下完整文字。请联系主持人核对后再下载；系统不会截断。`);
}
function drawDemoWatermark(context){
  const {width,height}=TEMPLATE_SIZE;
  context.save();
  context.translate(width/2,height/2);context.rotate(-Math.PI/10);
  context.font=`800 73px ${FONT_FAMILY}`;context.textAlign='center';context.textBaseline='middle';
  context.fillStyle='rgba(175,37,23,0.28)';context.fillText('演示样张 · 非正式证书',0,0);
  context.restore();
  context.save();context.fillStyle='#a92318';context.fillRect(429,20,633,51);
  context.font=`700 29px ${FONT_FAMILY}`;context.textAlign='center';context.textBaseline='middle';context.fillStyle='#ffffff';
  context.fillText('演示样张 · 非正式证书',745.5,45.5);context.restore();
}
async function createCertificateCanvas(raw,demo){
  const descriptor=normalizeCertificate(raw);
  const eventName=text(raw.eventName)||SITE.name,issuer=text(raw.issuer)||SITE.certificateIssuer;
  await waitForFonts(Object.values(descriptor).join('')+eventName+issuer);
  const canvas=document.createElement('canvas');
  canvas.width=TEMPLATE_SIZE.width*2;canvas.height=TEMPLATE_SIZE.height*2;
  const context=canvas.getContext('2d');
  if(!context)throw new Error('当前浏览器无法生成证书，请换用系统浏览器打开。');
  context.scale(2,2);context.fillStyle='#f8faff';context.fillRect(0,0,1491,1055);
  context.fillStyle='#e4ebf7';for(let x=70;x<1430;x+=24)for(let y=70;y<990;y+=24)context.fillRect(x,y,1,1);
  context.strokeStyle='#172038';context.lineWidth=5;context.strokeRect(48,48,1395,959);
  context.fillStyle='#0755ff';context.fillRect(72,72,1347,14);context.fillRect(72,969,1347,14);
  context.fillStyle='#ff870b';for(const [x,y] of [[33,33],[1428,33],[33,992],[1428,992]]){context.fillRect(x,y,30,30);context.fillRect(x+15,y+15,30,30);}
  const logo=await loadEventLogo();
  if(logo){const ratio=Math.min(150/logo.naturalWidth,70/logo.naturalHeight);context.drawImage(logo,100,110,logo.naturalWidth*ratio,logo.naturalHeight*ratio);}
  drawField(context,eventName,{label:'活动名称',x:logo?280:100,y:110,w:logo?1110:1290,h:65,max:31,min:17,lines:2});
  context.fillStyle='#0755ff';context.font=`700 17px ${FONT_FAMILY}`;context.textAlign='left';context.fillText('CERTIFICATE / 活动荣誉',100,225);
  drawField(context,descriptor.title,{label:'证书标题',x:100,y:250,w:1290,h:100,max:68,min:32,lines:1});
  context.fillStyle='#ff870b';context.fillRect(100,365,75,8);context.fillStyle='#172038';context.font=`500 24px ${FONT_FAMILY}`;context.fillText('兹授予',100,403);
  for(const field of TEMPLATES[descriptor.kind].fields){
    context.fillStyle='#62718a';context.font=`500 22px ${FONT_FAMILY}`;context.textAlign='left';context.textBaseline='middle';context.fillText(field.label,field.key==='number'?795:100,field.y+field.h/2);
    context.strokeStyle='#c0cce0';context.lineWidth=1;context.beginPath();context.moveTo(field.x,field.y+field.h+7);context.lineTo(field.x+field.w,field.y+field.h+7);context.stroke();
    drawField(context,descriptor[field.key],field);
  }
  drawField(context,issuer,{label:'颁发单位',x:100,y:900,w:1290,h:47,max:28,min:16,lines:2});
  if(demo)drawDemoWatermark(context);
  return {canvas,descriptor,demo};
}
function canvasBlob(canvas,type='image/png',quality){
  return new Promise((resolve,reject)=>{
    try{canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('证书图片生成失败，请重试。')),type,quality);}
    catch{reject(new Error('浏览器未能导出证书图片，请换用系统浏览器重试。'));}
  });
}
async function makePDF(canvas){
  const jpeg=await canvasBlob(canvas,'image/jpeg',0.96);
  const data=new Uint8Array(await jpeg.arrayBuffer());
  const encoder=new TextEncoder();
  const chunks=[];let length=0;
  const add=value=>{const bytes=typeof value==='string'?encoder.encode(value):value;chunks.push(bytes);length+=bytes.byteLength;};
  const offsets=[0];
  const pageW=841.89,pageH=595.28,scale=Math.min(pageW/canvas.width,pageH/canvas.height);
  const width=canvas.width*scale,height=canvas.height*scale,x=(pageW-width)/2,y=(pageH-height)/2;
  const content=`q\n${width.toFixed(4)} 0 0 ${height.toFixed(4)} ${x.toFixed(4)} ${y.toFixed(4)} cm\n/Im0 Do\nQ\n`;
  const object=(id,body)=>{offsets[id]=length;add(`${id} 0 obj\n${body}\nendobj\n`);};
  add('%PDF-1.4\n% Local certificate image\n');
  object(1,'<< /Type /Catalog /Pages 2 0 R >>');
  object(2,'<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  object(3,`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
  offsets[4]=length;add(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${data.byteLength} >>\nstream\n`);add(data);add('\nendstream\nendobj\n');
  object(5,`<< /Length ${encoder.encode(content).byteLength} >>\nstream\n${content}endstream`);
  const start=length;add('xref\n0 6\n0000000000 65535 f \n');
  for(let index=1;index<=5;index++)add(`${String(offsets[index]).padStart(10,'0')} 00000 n \n`);
  add(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`);
  return new Blob(chunks,{type:'application/pdf'});
}
function fileName(descriptor,demo,extension){
  const stem=`${demo?'演示样张_':''}${descriptor.title}_${descriptor.personName}_${descriptor.number}`.replace(/[\\/:*?"<>|\u0000-\u001f]/g,'_');
  return `${stem}.${extension}`;
}
function triggerDownload(blob,name){
  if(!blob?.size)throw new Error('下载文件为空，请重试。');
  const url=URL.createObjectURL(blob),anchor=document.createElement('a');
  anchor.href=url;anchor.download=name;anchor.rel='noopener';document.body.append(anchor);
  try{anchor.click();}finally{anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),120000);}
}
export function renderCertificates(ctx){
  const certificates=certificateList(ctx),demo=isDemo(ctx);
  return `<section id="my-certificates" class="certificates-section" aria-labelledby="certificates-heading"><div class="certificates-heading"><div><span class="certificates-eyebrow">个人荣誉</span><h2 id="certificates-heading">我的证书</h2></div><span class="certificates-count">${certificates.length} 张</span></div>${demo?'<p class="certificates-demo-notice">演示样张 · 非正式证书：此页预览及下载文件均含演示水印。</p>':''}${certificates.length?`<p class="certificates-intro">下方展示本场活动为你生成的证书。点击证书可放大查看、保存图片或下载 A4 横向打印版。</p><div class="certificate-card-list">${certificates.map((item,index)=>`<article class="certificate-card" data-certificate-card="${index}"><div class="certificate-thumbnail"><button class="certificate-thumbnail-open" type="button" data-certificate-index="${index}" aria-label="放大查看${escape(text(item.title)||TEMPLATES[item.kind]?.label||'个人证书')}" aria-busy="true"><img class="certificate-thumbnail-image" data-certificate-thumbnail-image alt="${escape(text(item.personName))}的${escape(text(item.title)||TEMPLATES[item.kind]?.label||'个人证书')}${demo?'（演示样张，非正式证书）':''}" hidden><span class="certificate-thumbnail-placeholder" data-certificate-thumbnail-status role="status">正在生成证书预览…</span></button><button type="button" class="secondary certificate-thumbnail-retry" data-certificate-thumbnail-retry="${index}" hidden>重新生成预览</button></div><div class="certificate-card-copy"><h3>${escape(text(item.title)||TEMPLATES[item.kind]?.label||'个人证书')}</h3><p>${escape(item.personName)} · ${escape(item.teamName)}</p><small>${escape(item.project)}</small></div><button class="primary certificate-open" type="button" data-certificate-index="${index}">放大查看与下载 ${icon('arrow')}</button></article>`).join('')}</div><div class="certificate-preview" data-certificate-preview hidden><div class="certificate-preview-heading"><h3 data-certificate-title>证书预览</h3><button type="button" class="secondary" data-certificate-close>收起</button></div><p class="certificate-status" data-certificate-status role="status" aria-live="polite"></p><button type="button" class="secondary certificate-preview-retry" data-certificate-preview-retry hidden>重新生成这张证书</button><div class="certificate-preview-image-wrap"><img class="certificate-preview-image" data-certificate-image alt="个人证书预览" hidden></div><div class="certificate-download-actions"><button type="button" class="primary" data-certificate-png disabled>${icon('download')} 保存 PNG 图片</button><button type="button" class="secondary" data-certificate-pdf disabled>${icon('download')} 下载 A4 横向 PDF</button></div><p class="certificate-save-help">手机可长按上方证书图片保存；若微信内下载未启动，请在系统浏览器打开后重试。打印 PDF 时选择 A4 横向、实际大小。</p></div>`:'<div class="certificate-empty"><p>当前没有可领取的证书。</p><span>这里仅展示系统已为你生成的证书。如与你的参赛记录不符，请联系主持人核对。</span></div>'}</section>`;
}
export function bindCertificates(ctx){
  disposeActiveBinding?.();
  const root=document.querySelector('#my-certificates');if(!root)return;
  const list=certificateList(ctx),demo=isDemo(ctx),preview=root.querySelector('[data-certificate-preview]');
  if(!preview)return;
  const status=root.querySelector('[data-certificate-status]'),image=root.querySelector('[data-certificate-image]');
  const pngButton=root.querySelector('[data-certificate-png]'),pdfButton=root.querySelector('[data-certificate-pdf]');
  const previewRetry=root.querySelector('[data-certificate-preview-retry]');
  const listeners=new AbortController(),urls=new Set();
  const entries=list.map((raw,index)=>({raw,index,pending:null,ready:false,error:null}));
  let disposed=false,version=0,current=null,selectedIndex=null,previewURL=null;
  const active=()=>!disposed&&root.isConnected;
  const registerURL=blob=>{const url=URL.createObjectURL(blob);urls.add(url);return url;};
  const releaseURL=url=>{if(url){URL.revokeObjectURL(url);urls.delete(url);}};
  const clearPreview=()=>{
    image.hidden=true;image.removeAttribute('src');releaseURL(previewURL);previewURL=null;
    if(current){current.canvas.width=0;current.canvas.height=0;current=null;}
  };
  const observer=new MutationObserver(()=>{if(!root.isConnected)dispose();});
  const dispose=()=>{
    if(disposed)return;
    disposed=true;version++;clearPreview();listeners.abort();observer.disconnect();
    for(const url of urls)URL.revokeObjectURL(url);urls.clear();
    if(disposeActiveBinding===dispose)disposeActiveBinding=null;
  };
  disposeActiveBinding=dispose;
  observer.observe(document.body,{childList:true,subtree:true});
  const on=(element,event,handler)=>element.addEventListener(event,handler,{signal:listeners.signal});
  const showError=error=>{status.textContent=error?.message||'证书操作未完成，请稍后重试。';status.classList.add('is-error');};
  const ensureEntry=entry=>{
    if(entry.ready)return Promise.resolve(entry);
    if(entry.pending)return entry.pending;
    const card=root.querySelector(`[data-certificate-card="${entry.index}"]`);
    const thumbnail=card.querySelector('[data-certificate-thumbnail-image]');
    const placeholder=card.querySelector('[data-certificate-thumbnail-status]');
    const thumbnailButton=card.querySelector('.certificate-thumbnail-open');
    const retry=card.querySelector('[data-certificate-thumbnail-retry]');
    entry.error=null;placeholder.hidden=false;placeholder.classList.remove('is-error');
    placeholder.textContent='正在生成证书预览…';retry.hidden=true;thumbnailButton.setAttribute('aria-busy','true');
    entry.pending=(async()=>{
      let generated,smallCanvas;
      try{
        generated=await createCertificateCanvas(entry.raw,demo);
        smallCanvas=document.createElement('canvas');smallCanvas.width=720;
        smallCanvas.height=Math.round(720*TEMPLATE_SIZE.height/TEMPLATE_SIZE.width);
        const smallContext=smallCanvas.getContext('2d');
        if(!smallContext)throw new Error('当前浏览器无法显示证书预览，请换用系统浏览器打开。');
        smallContext.drawImage(generated.canvas,0,0,smallCanvas.width,smallCanvas.height);
        const png=await canvasBlob(smallCanvas);
        if(!active())return null;
        thumbnail.src=registerURL(png);thumbnail.hidden=false;placeholder.hidden=true;
        entry.ready=true;
        return entry;
      }catch(error){
        if(active()){
          entry.error=error;placeholder.textContent=error?.message||'证书预览生成失败，请重试。';
          placeholder.classList.add('is-error');retry.hidden=false;
        }
        return null;
      }finally{
        // List images retain only a 720px PNG; full canvases are always released.
        if(generated){generated.canvas.width=0;generated.canvas.height=0;}
        if(smallCanvas){smallCanvas.width=0;smallCanvas.height=0;}
        entry.pending=null;
        if(active())thumbnailButton.removeAttribute('aria-busy');
      }
    })();
    return entry.pending;
  };
  const openCertificate=async index=>{
    if(!Number.isInteger(index)||!entries[index]||!active())return;
    const entry=entries[index],thisVersion=++version;
    selectedIndex=index;preview.hidden=false;clearPreview();pngButton.disabled=true;pdfButton.disabled=true;previewRetry.hidden=true;
    status.classList.remove('is-error');status.textContent='正在生成你的证书…';
    root.querySelector('[data-certificate-title]').textContent=text(entry.raw.title)||TEMPLATES[entry.raw.kind]?.label||'证书预览';
    let generated;
    try{
      generated=await createCertificateCanvas(entry.raw,demo);
      const png=await canvasBlob(generated.canvas);
      if(thisVersion!==version||!active())return;
      // Enlarged images own separate URLs; closing one never revokes thumbnails.
      previewURL=registerURL(png);image.src=previewURL;
      image.alt=`${generated.descriptor.personName}的${generated.descriptor.title}${demo?'（演示样张，非正式证书）':''}`;image.hidden=false;
      current={...generated,png};generated=null;pngButton.disabled=false;pdfButton.disabled=false;
      status.textContent=demo?'演示样张已生成，预览与下载均带有“非正式证书”水印。':'证书已生成，请核对姓名、队名和作品后保存。';
      preview.scrollIntoView({behavior:'smooth',block:'start'});
    }catch(error){if(active()&&thisVersion===version){showError(error);previewRetry.hidden=false;}}
    finally{if(generated){generated.canvas.width=0;generated.canvas.height=0;}}
  };
  root.querySelectorAll('[data-certificate-index]').forEach(button=>on(button,'click',()=>openCertificate(Number(button.dataset.certificateIndex))));
  root.querySelectorAll('[data-certificate-thumbnail-retry]').forEach(button=>on(button,'click',()=>{
    const index=Number(button.dataset.certificateThumbnailRetry);
    ensureEntry(entries[index]);
    if(!preview.hidden&&selectedIndex===index)openCertificate(index);
  }));
  on(previewRetry,'click',()=>openCertificate(selectedIndex));
  on(root.querySelector('[data-certificate-close]'),'click',()=>{version++;selectedIndex=null;preview.hidden=true;clearPreview();});
  on(pngButton,'click',()=>{
    if(!current||!active())return;
    try{triggerDownload(current.png,fileName(current.descriptor,demo,'png'));status.classList.remove('is-error');status.textContent='已请求保存图片。如手机未开始下载，可长按预览图片保存。';}
    catch(error){showError(error);}
  });
  on(pdfButton,'click',async()=>{
    if(!current||!active())return;
    const entry=current,thisVersion=version;
    pdfButton.disabled=true;status.classList.remove('is-error');status.textContent='正在生成 A4 横向打印版…';
    try{
      const pdf=await makePDF(entry.canvas);
      if(!active()||thisVersion!==version||current!==entry)return;
      triggerDownload(pdf,fileName(entry.descriptor,demo,'pdf'));
      status.textContent='已请求下载 A4 横向 PDF。如未开始下载，请在系统浏览器打开后重试。';
    }catch(error){if(active()&&thisVersion===version)showError(error);}
    finally{
      if(active()&&thisVersion===version)pdfButton.disabled=!current;
    }
  });
  // Render every supplied certificate as soon as this section is mounted.
  entries.forEach(ensureEntry);
}
