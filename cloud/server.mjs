import http from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomInt, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  Problem, isRecord, roleOf, requireRole, contextFor, publicGuideFor, publicEventFor, presentationOrderFor, calculateResults, updateState, exportCsv, normalizePhone, judgeEntryKey,
} from './business.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 262144;
const MUTATIONS = new Set(['/api/setup', '/api/phase', '/api/score', '/api/recuse', '/api/vote', '/api/tie',
  '/api/login', '/api/judges/login', '/api/audience/register', '/api/roster/import', '/api/roster/judges', '/api/roster/settings', '/api/roster/reset-device',
  '/api/teams/create', '/api/teams/admin-create', '/api/teams/import', '/api/teams/join', '/api/teams/leave', '/api/teams/update',
  '/api/invitations/send', '/api/invitations/respond', '/api/invitations/cancel', '/api/presentation-order']);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
};
export function normalizeConfig({ adminToken, publicOrigin, basePath = '/event' }) {
  if (typeof adminToken !== 'string' || !/^[A-Za-z0-9_-]{24,128}$/.test(adminToken)) throw new Error('AWARDS_ADMIN_CONFIG_MISSING');
  let origin;
  try {
    origin = new URL(publicOrigin);
    if (!['https:', 'http:'].includes(origin.protocol) || origin.username || origin.password
        || origin.pathname !== '/' || origin.search || origin.hash) throw new Error();
    if (origin.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) throw new Error();
  } catch { throw new Error('AWARDS_PUBLIC_ORIGIN_INVALID'); }
  if (typeof basePath !== 'string' || !/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(basePath)) throw new Error('AWARDS_BASE_PATH_INVALID');
  return { adminToken, publicOrigin: origin.origin, basePath };
}
function bearer(request) {
  const header = request.headers.authorization;
  if (header === undefined) return '';
  if (typeof header !== 'string' || !header.startsWith('Bearer ') || header.length > 256 || !header.slice(7).trim()) {
    throw new Problem('身份票证格式不正确', 401);
  }
  return header.slice(7).trim();
}
async function body(request) {
  if ((request.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw new Problem('请求须使用 JSON 格式', 415);
  }
  const declared = request.headers['content-length'];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY)) throw new Problem('请求内容为空或过大', 413);
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Problem('请求内容为空或过大', 413);
    chunks.push(chunk);
  }
  if (!size) throw new Problem('请求内容为空或过大', 413);
  let payload;
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new Problem('请求内容不是有效 JSON'); }
  if (!isRecord(payload)) throw new Problem('请求内容格式不正确');
  return payload;
}
// Per-process protection only: serverless instances do not share these counters.
// Both maps are bounded; a full map rejects new keys until its window expires.
function createLoginLimiter() {
  const phones = new Map(), sources = new Map();
  function consume(map, key, maximum, windowMs, capacity) {
    const timestamp = Date.now();
    for (const [entryKey, entry] of map) if (entry.expires <= timestamp) map.delete(entryKey);
    let entry = map.get(key);
    if (!entry) {
      if (map.size >= capacity) throw new Problem('入场请求较多，请稍后再试或联系工作人员', 429);
      entry = { count: 0, expires: timestamp + windowMs }; map.set(key, entry);
    }
    if (++entry.count > maximum) throw new Problem('入场尝试过于频繁，请稍后再试或联系工作人员', 429);
  }
  return (kind, value, source) => {
    consume(sources, source, 240, 5 * 60 * 1000, 512);
    let normalized;
    if (kind === 'judge') normalized = typeof value === 'string' ? value.trim().slice(0, 120) : 'invalid';
    else { try { normalized = normalizePhone(value); } catch { normalized = 'invalid'; } }
    const key = kind + ':' + createHash('sha256').update(normalized).digest('hex');
    consume(phones, key, 12, 15 * 60 * 1000, 3000);
  };
}
export function createServer({
  store, adminToken, publicOrigin = 'http://localhost', basePath = '/event',
  publicDir = resolve(HERE, 'public'), deploymentMode = 'cloud',
} = {}) {
  const config = normalizeConfig({ adminToken, publicOrigin, basePath });
  if (!store || typeof store.read !== 'function' || typeof store.compareAndSwap !== 'function') {
    throw new Error('AWARDS_PERSISTENT_STORE_REQUIRED');
  }
  const publicBaseUrl = `${config.publicOrigin}${config.basePath}/`;
  if (!['cloud', 'demo'].includes(deploymentMode)) throw new Error('AWARDS_DEPLOYMENT_MODE_INVALID');
  const metadata = { deploymentMode, publicBaseUrl, networkUrls: [publicBaseUrl] };
  const staticRoot = resolve(publicDir);
  const limitLogin = createLoginLimiter();
  const server = http.createServer(async (request, response) => {
    const send = (value, status = 200, type = 'application/json; charset=utf-8', filename) => {
      if (response.destroyed || response.writableEnded) return;
      const encoded = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
      response.writeHead(status, {
        'Content-Type': type, 'Content-Length': encoded.length, 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
        ...(filename ? { 'Content-Disposition': `attachment; filename="${filename}"` } : {}),
      });
      response.end(request.method === 'HEAD' ? undefined : encoded);
    };
    try {
      if (typeof request.url !== 'string' || !request.url.startsWith('/') || request.url.startsWith('//')) throw new Problem('页面不存在', 404);
      const url = new URL(request.url, 'http://internal.invalid');
      let route = url.pathname;
      if (route === config.basePath) {
        if (!['GET', 'HEAD'].includes(request.method)) throw new Problem('页面不存在', 404);
        response.writeHead(301, { Location: config.basePath + '/' + url.search, 'Cache-Control': 'no-store' });
        return response.end();
      }
      if (route.startsWith(config.basePath + '/')) route = route.slice(config.basePath.length);
      else if (route.startsWith(config.basePath)) throw new Problem('页面不存在', 404);
      if (request.method === 'GET' || request.method === 'HEAD') {
        // Chat/Markdown copies can retain closing punctuation after this public
        // guide/library URLs. Redirect only known pages, never API paths.
        let copiedGuidePath;
        try { copiedGuidePath = decodeURIComponent(route); } catch { /* handled below */ }
        const copiedPublicPage = copiedGuidePath?.match(/^\/(guide|knowledge)\.html[\\/\)\]\}>）】》。，、, \u00a0]{1,24}$/u);
        if (copiedPublicPage) {
          response.writeHead(302, {
            Location: config.basePath + '/' + copiedPublicPage[1] + '.html' + url.search,
            'Cache-Control': 'no-store',
          });
          return response.end();
        }
        if (route === '/api/health') {
          await store.read();
          return send({ ok: true });
        }
        if (route.startsWith('/api/')) {
          const { state } = await store.read();
          // Public guide always uses this same narrow projection, even when a
          // caller supplies an administrator, expired or malformed credential.
          if (route === '/api/public-guide') return send(publicGuideFor(state));
          if (route === '/api/public-event') return send(publicEventFor(state));
          if (route === '/api/presentation-order') return send(presentationOrderFor(state));
          const [role, person] = roleOf(state, bearer(request), config.adminToken);
          if (route === '/api/context') return send({ ...contextFor(state, role, person), ...metadata });
          requireRole(role, ['admin']);
          if (route === '/api/admin') {
            const adminContext = contextFor(state, 'admin', null);
            return send({ ...state, results: calculateResults(state), ...metadata, judgeEntryKey: judgeEntryKey(config.adminToken),
              effectiveRecusals: adminContext.effectiveRecusals,
              ...(state.event.entryMode === 'phone' ? { playerCards: adminContext.playerCards } : {}) });
          }
          if (route === '/api/export') {
            if ((url.searchParams.get('format') ?? 'csv') !== 'csv' || url.searchParams.getAll('format').length > 1) throw new Problem('仅支持 CSV 导出');
            return send(exportCsv(state), 200, 'text/csv; charset=utf-8', 'awards-results.csv');
          }
          if (route === '/api/backup') return send({
            schemaVersion: Array.isArray(state.invitations) ? 3 : state.event.entryMode === 'phone' ? 2 : 1, exportedAt: new Date().toISOString(), private: '包含手机号、报名资料和专属票证，请仅交给可信工作人员', state,
          }, 200, 'application/json; charset=utf-8', 'awards-private-backup.json');
          throw new Problem('接口不存在', 404);
        }
        let relative;
        try { relative = decodeURIComponent(route).replace(/^\/+/, '') || 'index.html'; }
        catch { throw new Problem('页面不存在', 404); }
        if (relative.includes('\\') || relative.split('/').some(part => !part || part.startsWith('.')) || !MIME[extname(relative).toLowerCase()]) throw new Problem('页面不存在', 404);
        const file = resolve(staticRoot, relative);
        if (!file.startsWith(staticRoot + sep)) throw new Problem('页面不存在', 404);
        try {
          const [resolvedRoot, resolvedFile, information] = await Promise.all([realpath(staticRoot), realpath(file), stat(file)]);
          if (!resolvedFile.startsWith(resolvedRoot + sep) || !information.isFile()) throw new Error();
          return send(await readFile(file), 200, MIME[extname(file).toLowerCase()]);
        } catch { throw new Problem('页面不存在', 404); }
      }
      if (request.method !== 'POST') throw new Problem('请求方法不支持', 405);
      if (!MUTATIONS.has(route)) throw new Problem('接口不存在', 404);
      const origin = request.headers.origin;
      if (origin !== undefined && origin !== config.publicOrigin) throw new Problem('请从本工具页面提交操作', 403);
      if (request.headers['sec-fetch-site'] === 'cross-site') throw new Problem('请从本工具页面提交操作', 403);
      const payload = await body(request), suppliedToken = bearer(request);
      if (route === '/api/login' || route === '/api/audience/register') limitLogin('phone', payload.phone, request.socket.remoteAddress ?? 'unknown');
      if (route === '/api/judges/login') limitLogin('judge', payload.name, request.socket.remoteAddress ?? 'unknown');
      // Read/validate/write is retried only for an explicit version conflict.
      // A network or database error is never assumed to be a successful write.
      for (let attempt = 0; attempt < 6; attempt++) {
        const { state: original, version } = await store.read();
        const state = structuredClone(original);
        const result = updateState(state, route, payload, suppliedToken, config.adminToken);
        if (await store.compareAndSwap(version, state)) return send({ ok: true, ...result });
        if (attempt < 5) await delay(randomInt(5, 31) * (attempt + 1));
      }
      throw new Problem('同时提交的人较多，本次提交未确认成功。请刷新检查后再操作', 409);
    } catch (error) {
      if (error instanceof Problem) return send({ error: error.message }, error.status);
      return send({ error: request.method === 'POST'
        ? '提交未能确认，请刷新页面检查结果后再操作'
        : '服务暂时无法读取数据，请稍后重试' }, 503);
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 64;
  return server;
}
