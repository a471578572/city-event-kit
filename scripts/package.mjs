import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT, releaseFiles } from './release-files.mjs';
import { checkPrivacy } from './check-privacy.mjs';

// ZIP STORE records keep packaging dependency-free on Windows/macOS/Linux.
const crcTable = Array.from({length:256},(_,n)=>{let c=n;for(let k=0;k<8;k++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
function crc32(bytes){let c=0xffffffff;for(const b of bytes)c=crcTable[(c^b)&255]^(c>>>8);return (c^0xffffffff)>>>0;}
const hash = value => createHash('sha256').update(value).digest('hex');
await checkPrivacy();
const {version} = JSON.parse(await readFile(resolve(ROOT,'package.json'),'utf8'));
if(!/^\d+\.\d+\.\d+$/.test(version))throw new Error('Invalid release version');
const prefix=`city-event-kit-${version}`, records=[];
for(const name of await releaseFiles()) records.push({name,bytes:await readFile(resolve(ROOT,name))});
records.push({name:'SHA256SUMS',bytes:Buffer.from(records.map(r=>`${hash(r.bytes)}  ${r.name}`).join('\n')+'\n')});
const local=[],central=[];let offset=0;
for(const record of records){
  const name=Buffer.from(`${prefix}/${record.name}`), data=record.bytes, crc=crc32(data);
  const h=Buffer.alloc(30);h.writeUInt32LE(0x04034b50,0);h.writeUInt16LE(20,4);h.writeUInt16LE(0x800,6);h.writeUInt16LE(33,12);h.writeUInt32LE(crc,14);h.writeUInt32LE(data.length,18);h.writeUInt32LE(data.length,22);h.writeUInt16LE(name.length,26);
  local.push(h,name,data);
  const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50,0);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt16LE(0x800,8);c.writeUInt16LE(33,14);c.writeUInt32LE(crc,16);c.writeUInt32LE(data.length,20);c.writeUInt32LE(data.length,24);c.writeUInt16LE(name.length,28);c.writeUInt32LE(offset,42);central.push(c,name);offset+=h.length+name.length+data.length;
}
const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(records.length,8);end.writeUInt16LE(records.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
const zip=Buffer.concat([...local,directory,end]),folder=resolve(ROOT,'dist');await mkdir(folder,{recursive:true});
await writeFile(resolve(folder,`${prefix}.zip`),zip);
await writeFile(resolve(folder,`${prefix}.zip.sha256`),`${hash(zip)}  ${prefix}.zip\n`);
console.log(JSON.stringify({file:`dist/${prefix}.zip`,files:records.length,bytes:zip.length,sha256:hash(zip)},null,2));
