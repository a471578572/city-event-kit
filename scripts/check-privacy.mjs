import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, releaseFiles } from './release-files.mjs';

export async function checkPrivacy(root = ROOT) {
  const files = await releaseFiles(root), findings = [];
  // Do not print matched contents: the scanner's output must not leak secrets.
  const credential = /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKID[A-Za-z0-9]{24,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/;
  for (const name of files) {
    const bytes = await readFile(resolve(root,name));
    if (bytes.length > 3_000_000) findings.push([name,'文件过大，请人工核验素材']);
    if (/\.(?:png|jpg|jpeg|webp)$/i.test(name)) continue;
    const content = bytes.toString('utf8');
    if (credential.test(content)) findings.push([name,'疑似访问凭证']);
    if (/(?:\/Users\/[^\s"']+|\/var\/folders\/|\/home\/[^\s"']+\/)/.test(content)) findings.push([name,'含个人电脑绝对路径']);
    if (/"schemaVersion"\s*:\s*[123][\s\S]{0,200}"exportedAt"/.test(content)) findings.push([name,'疑似真实导出备份']);
    if (/\b(?:AWARDS_ADMIN_TOKEN|CLOUDBASE_API_KEY)\s*=\s*["']?[A-Za-z0-9_-]{24,}/.test(content) && name === '.env.example') findings.push([name,'示例环境文件中有实际凭证']);
  }
  const site = JSON.parse(await readFile(resolve(root,'web/site-config.json'),'utf8'));
  if (site.publicPlayerWall !== false) findings.push(['web/site-config.json','公共模板应默认关闭公开选手墙']);
  if (findings.length) throw new Error(JSON.stringify(findings));
  return {checkedFiles:files.length, knownSecretPatternsFound:0, privateRuntimeFilesIncluded:0,
    note:'自动检查不能替代发布前对自定义素材、截图和表格的人工审核'};
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await checkPrivacy(),null,2)); }
  catch(error) {console.error(error.message); process.exitCode=1;}
}
