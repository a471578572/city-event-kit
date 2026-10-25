import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { releaseFiles } from './release-files.mjs';
test('release allowlist excludes private state even if it exists beside source',async()=>{
 const root=await mkdtemp(join(tmpdir(),'city-package-'));try{
  await mkdir(join(root,'web'));await mkdir(join(root,'data'));await mkdir(join(root,'dist'));
  await writeFile(join(root,'README.md'),'public');await writeFile(join(root,'web/index.html'),'public');
  await writeFile(join(root,'data/admin.key'),'fictional-private');await writeFile(join(root,'.env'),'fictional-private');await writeFile(join(root,'dist/old.zip'),'private');
  assert.deepEqual(await releaseFiles(root),['README.md','web/index.html']);
  await symlink(join(root,'data/admin.key'),join(root,'web/leak.txt'));
  await assert.rejects(releaseFiles(root),/符号链接/);
 }finally{await rm(root,{recursive:true,force:true});}
});
