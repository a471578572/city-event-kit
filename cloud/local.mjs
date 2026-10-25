import { randomBytes } from 'node:crypto';
import { readFile, writeFile, link, unlink, rename, chmod, lstat, realpath } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer, normalizeConfig } from './server.mjs';
import { assertSqliteRuntime, preparePrivateDirectory, createSqliteStore } from './sqlite-store.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const validToken = value => typeof value === 'string' && /^[A-Za-z0-9_-]{24,128}$/.test(value);
const escapeHtml = value => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

async function administratorToken(directory, initialToken) {
  const keyPath = resolve(directory, 'admin.key');
  const readKey = async () => {
    const information = await lstat(keyPath);
    if (!information.isFile() || information.isSymbolicLink()) throw new Error('AWARDS_ADMIN_KEY_INVALID');
    await chmod(keyPath, 0o600);
    const saved = (await readFile(keyPath, 'utf8')).trim();
    if (!validToken(saved)) throw new Error('AWARDS_ADMIN_KEY_INVALID');
    return saved;
  };
  try { return await readKey(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (initialToken !== undefined && !validToken(initialToken)) throw new Error('AWARDS_ADMIN_CONFIG_INVALID');
  const candidate = initialToken ?? randomBytes(32).toString('base64url');
  const temporary = resolve(directory, `.admin-key-${randomBytes(12).toString('hex')}.tmp`);
  try {
    await writeFile(temporary, candidate + '\n', { flag: 'wx', mode: 0o600 });
    // Link a fully written file atomically: concurrent starts never see half a key.
    try { await link(temporary, keyPath); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  return readKey();
}

async function writeAdministratorEntry(directory, publicUrl, token) {
  const destination = resolve(directory, 'admin-entry.html');
  const temporary = resolve(directory, `.admin-entry-${randomBytes(12).toString('hex')}.tmp`);
  const url = `${publicUrl}#token=${encodeURIComponent(token)}`;
  const document = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><title>本场活动管理员入口</title><body><h1>本场活动管理员入口</h1><p>此文件包含管理权限，请勿转发或放入网站目录。</p><p><a href="${escapeHtml(url)}">打开管理界面</a></p></body></html>\n`;
  try {
    await writeFile(temporary, document, { flag: 'wx', mode: 0o600 });
    await rename(temporary, destination);
    await chmod(destination, 0o600);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  return destination;
}

export function validateLocalDeployment({ deploymentMode = 'cloud', host, dataDir }) {
  if (!['cloud', 'demo'].includes(deploymentMode)) throw new Error('AWARDS_DEPLOYMENT_MODE_INVALID');
  const directory = resolve(dataDir);
  if (deploymentMode === 'demo') {
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) throw new Error('AWARDS_DEMO_LOOPBACK_REQUIRED');
    if (directory !== resolve(ROOT, 'data-demo')) throw new Error('AWARDS_DEMO_DATA_DIRECTORY_REQUIRED');
  }
  return { deploymentMode, host: host === '[::1]' ? '::1' : host, dataDir: directory };
}

export async function startLocal({ env = process.env, deploymentMode = 'cloud' } = {}) {
  assertSqliteRuntime();
  const port = Number(env.PORT || '3000'), host = env.HOST || '127.0.0.1';
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('AWARDS_PORT_INVALID');
  if (typeof host !== 'string' || !host.trim() || /[\r\n]/.test(host)) throw new Error('AWARDS_HOST_INVALID');
  const validated = validateLocalDeployment({ deploymentMode, host,
    dataDir: env.DATA_DIR || resolve(ROOT, deploymentMode === 'demo' ? 'data-demo' : 'data') });
  const dataDir = validated.dataDir, publicDir = resolve(ROOT, 'web');
  if (dataDir === publicDir || dataDir.startsWith(publicDir + sep)) throw new Error('AWARDS_DATA_DIRECTORY_MUST_BE_PRIVATE');
  const directory = await preparePrivateDirectory(dataDir);
  const [realDirectory, realPublicDir, realRoot] = await Promise.all([
    realpath(directory), realpath(publicDir), realpath(ROOT),
  ]);
  if (realDirectory === realPublicDir || realDirectory.startsWith(realPublicDir + sep)) {
    throw new Error('AWARDS_DATA_DIRECTORY_MUST_BE_PRIVATE');
  }
  if (validated.deploymentMode === 'demo' && realDirectory !== resolve(realRoot, 'data-demo')) {
    throw new Error('AWARDS_DEMO_DATA_DIRECTORY_REQUIRED');
  }
  const token = await administratorToken(directory, env.AWARDS_ADMIN_TOKEN);
  const config = normalizeConfig({ adminToken: token,
    publicOrigin: env.PUBLIC_ORIGIN || `http://localhost:${port}`,
    basePath: env.BASE_PATH || '/event' });
  const store = await createSqliteStore({ dataDir: directory });
  let server;
  try {
    server = createServer({ store, ...config, publicDir, deploymentMode: validated.deploymentMode });
    await new Promise((accept, reject) => {
      const onError = error => reject(error);
      server.once('error', onError);
      server.listen(port, validated.host, () => { server.removeListener('error', onError); accept(); });
    });
    const publicUrl = `${config.publicOrigin}${config.basePath}/`;
    const administratorEntry = await writeAdministratorEntry(directory, publicUrl, token);
    return { server, store, publicUrl, administratorEntry };
  } catch (error) {
    if (server?.listening) await new Promise(accept => server.close(accept));
    await store.close();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const running = await startLocal();
    console.log(`活动入口：${running.publicUrl}`);
    console.log(`管理员私有入口文件：${running.administratorEntry}`);
    running.server.on('error', () => { console.error('AWARDS_HTTP_FAILED'); process.exitCode = 1; });
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      running.server.closeIdleConnections();
      running.server.close(async () => { await running.store.close(); process.exit(0); });
    };
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, stop);
  } catch (error) {
    console.error(error.message === 'AWARDS_NODE_22_13_OR_NEWER_REQUIRED'
      ? '需要 Node.js 22.13 或更新版本（推荐 Node.js 24）。' : 'AWARDS_START_FAILED');
    process.exitCode = 1;
  }
}
