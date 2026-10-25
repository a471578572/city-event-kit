import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ROOT } from './release-files.mjs';
import { createSqliteStore } from '../cloud/sqlite-store.mjs';
import { freshState, updateState } from '../cloud/business.mjs';
import { startLocal } from '../cloud/local.mjs';
import { prepareRosterCSV, prepareTeamCSV, prepareJudgeCSV } from '../web/roster-csv.js';

// Demo always uses its own fixed directory; inherited deployment settings cannot
// redirect its fictional data into a real event's database or cloud instance.
const directory=resolve(ROOT,'data-demo'),marker=resolve(directory,'DEMO-ONLY');
await mkdir(directory,{recursive:true,mode:0o700});
let initialized=false;
try {initialized=(await readFile(marker,'utf8')).trim()==='city-event-kit-fictional-demo-v1';}
catch(error){if(error.code!=='ENOENT')throw error;}
if(!initialized && (await readdir(directory)).length) throw new Error('演示目录非空且没有演示标记；为避免覆盖，已停止。请选用干净副本演示。');
if(!initialized){
  const admin=randomBytes(32).toString('base64url'),state=freshState();
  const read=async name=>readFile(resolve(ROOT,'examples',name),'utf8');
  updateState(state,'/api/roster/import',{people:prepareRosterCSV(await read('players.csv')).people},admin,admin);
  updateState(state,'/api/teams/import',{teams:prepareTeamCSV(await read('teams.csv')).teams},admin,admin);
  updateState(state,'/api/roster/judges',{judges:prepareJudgeCSV(await read('judges.csv')).judges},admin,admin);
  updateState(state,'/api/roster/settings',{teamsOpen:true,audienceEnabled:true},admin,admin);
  updateState(state,'/api/phase',{phase:'open'},admin,admin);
  const store=await createSqliteStore({dataDir:directory});
  try {
    const current=await store.read();
    if(current.state.voters.length||current.state.teams.length||current.state.scores.length)throw new Error('演示目录已有活动数据，停止初始化。');
    if(!await store.compareAndSwap(current.version,state))throw new Error('演示目录正在被其他进程使用。');
    await writeFile(resolve(directory,'admin.key'),admin+'\n',{flag:'wx',mode:0o600});
    await writeFile(marker,'city-event-kit-fictional-demo-v1\n',{flag:'wx',mode:0o600});
  }finally{await store.close();}
}
const port=Number(process.env.DEMO_PORT||3001);
const running=await startLocal({env:{HOST:'127.0.0.1',PORT:String(port),PUBLIC_ORIGIN:`http://127.0.0.1:${port}`,BASE_PATH:'/event',DATA_DIR:directory},deploymentMode:'demo'});
console.log(`虚构资料演示：${running.publicUrl}\n私密演示管理入口：${running.administratorEntry}\n演示数据保存在 data-demo/；正式活动使用 npm start。`);
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>running.server.close(async()=>{await running.store.close();process.exit(0);}));
