// RFC-style CSV parsing. The file stays in memory; only the allowlisted fields leave this module.
export function parseCSV(text){
  const rows=[];let row=[],field='',quoted=false;
  text=String(text).replace(/^\uFEFF/,'');
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(quoted){if(c==='"'){if(text[i+1]==='"'){field+='"';i++;}else quoted=false;}else field+=c;}
    else if(c==='"'){if(field)throw new Error('CSV 引号位置不正确，请重新导出文件。');quoted=true;}
    else if(c===','){row.push(field);field='';}
    else if(c==='\r'||c==='\n'){if(c==='\r'&&text[i+1]==='\n')i++;row.push(field);if(row.some(v=>v.trim()))rows.push(row);row=[];field='';}
    else field+=c;
  }
  if(quoted)throw new Error('CSV 有未闭合的引号，请重新导出文件。');
  row.push(field);if(row.some(v=>v.trim()))rows.push(row);
  return rows;
}
export function normalizePhone(value){return String(value||'').trim().replace(/[\s()-]/g,'').replace(/^\+?86(?=1\d{10}$)/,'');}
const plain=value=>String(value||'').trim().replace(/[\s：:?？!！]/g,'');
function fieldIndex(headers,keywords){return headers.findIndex(h=>keywords.some(k=>plain(h)===plain(k)||plain(h).endsWith(plain(k))));}
export function prepareRosterCSV(text){
  const rows=parseCSV(text);if(rows.length<2)throw new Error('CSV 没有可导入的报名记录。');
  if(rows.length>2001)throw new Error('一次最多预览 2000 条报名记录，请分批导入。');
  const headers=rows.shift(),nameIndex=fieldIndex(headers,['称呼','姓名']),phoneIndex=fieldIndex(headers,['手机号','手机号码','联系电话']),statusIndex=fieldIndex(headers,['状态','审核状态','报名状态']);
  if(nameIndex<0||phoneIndex<0)throw new Error('没有找到“称呼 / 姓名”和“手机号”列，请使用含姓名与手机号的 CSV 文件。');
  const indices={company:fieldIndex(headers,['公司']),position:fieldIndex(headers,['职位']),background:fieldIndex(headers,['背景']),participation:fieldIndex(headers,['你准备怎样参与','参与方式']),directions:fieldIndex(headers,['你最感兴趣的创作方向是','创作方向','兴趣方向']),skills:fieldIndex(headers,['你在团队更加擅长什么','擅长','技能']),experience:fieldIndex(headers,['你目前使用AI的经验是','AI经验']),note:fieldIndex(headers,['有什么想提前告诉我们'])};
  const people=[],invalid=[],duplicates=[],conflicts=[],seen=new Map();let excluded=0;
  rows.forEach((row,index)=>{
    const rowNumber=index+2,status=String(row[statusIndex]||'').trim();
    if(statusIndex>=0&&status!=='已通过'){excluded++;return;}
    const name=String(row[nameIndex]||'').trim(),phone=normalizePhone(row[phoneIndex]);
    if(!name||name.length>100||!/^1\d{10}$/.test(phone)){invalid.push({row:rowNumber,reason:!name?'缺少姓名':'手机号或姓名格式不正确'});return;}
    const profile={};for(const [key,column] of Object.entries(indices)){if(column>=0&&row[column]?.trim())profile[key]=row[column].trim().slice(0,2000);}
    const person={name,phone,role:'player',profile};
    if(seen.has(phone)){
      const item={row:rowNumber,name,phoneMasked:phone.slice(0,3)+'****'+phone.slice(-4)};
      (JSON.stringify(seen.get(phone))===JSON.stringify(person)?duplicates:conflicts).push(item);return;
    }
    seen.set(phone,person);people.push(person);
  });
  if(people.length>500)throw new Error('一次最多导入 500 位有效报名人员，请拆分文件后分别导入。');
  return {people,total:rows.length,excluded,invalid,duplicates,conflicts};
}

const trackAliases={dining:'dining','用餐':'dining','用餐赛道':'dining',detective:'detective','侦探':'detective','侦探赛道':'detective',office:'office','办公':'office','办公赛道':'office','short-drama':'short-drama','短剧':'short-drama','短剧赛道':'short-drama',opc:'opc','OPC':'opc','OPC赛道':'opc','OPC 赛道':'opc',game:'game','游戏':'game','游戏赛道':'game'};
function importRows(text,label){
  const rows=parseCSV(text);if(rows.length<2)throw new Error(`CSV 没有可导入的${label}。`);
  if(rows.length>501)throw new Error('一次最多预览 500 条，请分批导入。');
  return {headers:rows.shift(),rows};
}
export function prepareTeamCSV(text){
  const {headers,rows}=importRows(text,'队伍记录');
  const nameIndex=fieldIndex(headers,['队伍名称','队名']),projectIndex=fieldIndex(headers,['作品名称','作品']),trackIndex=fieldIndex(headers,['赛道']),captainIndex=fieldIndex(headers,['队长手机号']),membersIndex=fieldIndex(headers,['队员手机号','成员手机号']);
  if(nameIndex<0||projectIndex<0||membersIndex<0)throw new Error('请提供“队伍名称”“作品名称”和“队员手机号”列。');
  const teams=[],invalid=[],duplicates=[],conflicts=[],seen=new Map();
  rows.forEach((row,index)=>{
    const name=String(row[nameIndex]||'').trim(),project=String(row[projectIndex]||'').trim(),rawTrack=String(row[trackIndex]||'').trim(),captainPhone=normalizePhone(row[captainIndex]);
    const memberPhones=String(row[membersIndex]||'').split('|').map(normalizePhone).filter(Boolean);
    const reason=!name||name.length>60?'队名应为 1—60 字':project.length>120?'作品名超过 120 字':rawTrack&&!Object.hasOwn(trackAliases,rawTrack)?'赛道名称不支持':captainPhone&&!/^1\d{10}$/.test(captainPhone)?'队长手机号无效':memberPhones.some(phone=>!/^1\d{10}$/.test(phone))?'队员手机号无效':new Set(memberPhones).size!==memberPhones.length?'队员手机号重复':'';
    if(reason){invalid.push({row:index+2,reason});return;}
    const team={name,project,memberPhones,...(rawTrack?{track:trackAliases[rawTrack]}:{}),...(captainPhone?{captainPhone}:{})};
    if(seen.has(name)){(JSON.stringify(seen.get(name))===JSON.stringify(team)?duplicates:conflicts).push({row:index+2,name});return;}
    seen.set(name,team);teams.push(team);
  });
  return {teams,total:rows.length,invalid,duplicates,conflicts};
}
export function prepareJudgeCSV(text){
  const {headers,rows}=importRows(text,'评委记录');
  const nameIndex=fieldIndex(headers,['姓名','评委姓名']),bioIndex=fieldIndex(headers,['介绍','简介','评委介绍']);
  if(nameIndex<0)throw new Error('请提供“姓名”列，可选“介绍”列。');
  const judges=[],invalid=[],duplicates=[],conflicts=[],seen=new Map();
  rows.forEach((row,index)=>{
    const name=String(row[nameIndex]||'').trim(),bio=String(row[bioIndex]||'').trim();
    if(!name||name.length>100||bio.length>500){invalid.push({row:index+2,reason:'姓名应为 1—100 字，介绍不超过 500 字'});return;}
    const judge={name,bio};
    if(seen.has(name)){(seen.get(name).bio===bio?duplicates:conflicts).push({row:index+2,name});return;}
    seen.set(name,judge);judges.push(judge);
  });
  return {judges,total:rows.length,invalid,duplicates,conflicts};
}
