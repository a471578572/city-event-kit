import { readdir, lstat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const roots = new Set(['README.md','LICENSE','NOTICE','SECURITY.md','CONTRIBUTING.md','package.json','Dockerfile','.dockerignore','.gitignore','.env.example']);
const directories = new Set(['cloud','web','docs','examples','scripts','licenses','.github']);
const types = /\.(?:mjs|js|html|css|json|md|txt|csv|svg|png|jpg|jpeg|webp|yml|yaml)$/i;
export async function releaseFiles(root = ROOT) {
  const files = [];
  async function walk(relative) {
    const info = await lstat(resolve(root, relative));
    if (info.isSymbolicLink()) throw new Error(`发布目录不接受符号链接：${relative}`);
    if (info.isDirectory()) {
      for (const name of (await readdir(resolve(root, relative))).sort()) await walk(`${relative}/${name}`);
    } else {
      if (!types.test(relative) || relative.split('/').slice(0,-1).some(part=>/^(?:node_modules|data(?:-.*)?|backups|private|dist)$/.test(part))
          || /(?:admin-entry|admin\.key|\.sqlite|\.log$|\.env(?:\.|$))/.test(relative)) throw new Error(`发布白名单中出现不允许的文件：${relative}`);
      files.push(relative);
    }
  }
  for (const name of (await readdir(root)).sort()) {
    if (roots.has(name)) {
      if (!(await lstat(resolve(root,name))).isFile()) throw new Error(`根文件必须是普通文件：${name}`);
      files.push(name);
    } else if (directories.has(name)) await walk(name);
  }
  return files.sort();
}
