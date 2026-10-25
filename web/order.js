import {SITE} from './site.js';
import './public-pages.js';
document.title=SITE.name+' · 路演顺序';

const elements = Object.fromEntries([
  'order-refresh', 'order-fullscreen', 'order-print', 'order-summary', 'order-updated',
  'order-status', 'presentation-list', 'order-empty', 'order-pending', 'pending-count',
  'pending-list', 'order-partners',
].map(id => [id, document.getElementById(id)]));

let lastOrder = null;
let lastChecked = null;
let loading = false;

function node(tag, className, text) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}

function formatTime(value) {
  const date = new Date(value);
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(date);
}

function normalizeOrder(data) {
  if (!data || !Number.isSafeInteger(data.revision) || data.revision < 0 ||
      !Array.isArray(data.teams) || !Array.isArray(data.pendingTeams) ||
      (data.drawnAt !== null && (typeof data.drawnAt !== 'string' || !Number.isFinite(Date.parse(data.drawnAt))))) {
    throw new Error('invalid-order');
  }
  const allIds = new Set();
  function team(item, position) {
    if (!item || typeof item.id !== 'string' || !item.id || allIds.has(item.id) ||
        typeof item.name !== 'string' || !item.name.trim() ||
        (item.project !== undefined && typeof item.project !== 'string') ||
        (position !== undefined && item.position !== position)) throw new Error('invalid-team');
    allIds.add(item.id);
    return { id: item.id, name: item.name, project: item.project || '', position };
  }
  const teams = data.teams.map((item, index) => team(item, index + 1));
  const pendingTeams = data.pendingTeams.map(item => team(item));
  if ((data.revision === 0 && (data.drawnAt !== null || teams.length)) ||
      (data.revision > 0 && data.drawnAt === null)) throw new Error('invalid-draw');
  return { revision: data.revision, drawnAt: data.drawnAt, teams, pendingTeams };
}

function renderOrder(data) {
  const total = data.teams.length + data.pendingTeams.length;
  elements['order-summary'].textContent = data.drawnAt
    ? `已安排 ${data.teams.length} 支队伍 · 第 ${data.revision} 次公布`
    : `已登记 ${total} 支队伍 · 等待工作人员抽签`;
  elements['order-updated'].textContent = data.drawnAt
    ? `公布于 ${formatTime(data.drawnAt)} · 每 30 秒自动刷新`
    : '每 30 秒自动刷新';
  const rows = data.teams.map(team => {
    const item = node('li', 'presentation-row');
    const position = node('span', 'presentation-position', String(team.position).padStart(2, '0'));
    position.setAttribute('aria-label', `第 ${team.position} 队`);
    const body = node('div', 'presentation-detail');
    body.append(node('h3', 'presentation-name', team.name));
    const project = node('p', 'presentation-project');
    project.append(node('span', 'presentation-project-label', '作品'), document.createTextNode(team.project || '暂未填写作品名'));
    body.append(project);
    item.append(position, body);
    return item;
  });
  elements['presentation-list'].replaceChildren(...rows);
  elements['order-empty'].hidden = data.teams.length > 0;
  elements['order-empty'].replaceChildren();
  if (!data.teams.length) {
    const title = !total ? '还没有登记的队伍' : data.drawnAt ? '本次暂未安排路演队伍' : '路演顺序还未抽签';
    const description = !total ? '请先登记队名，再由工作人员统一安排路演顺序。' : '请等待工作人员公布，刷新即可查看。';
    elements['order-empty'].append(node('strong', '', title), document.createTextNode(description));
  }
  elements['order-pending'].hidden = data.pendingTeams.length === 0;
  elements['pending-count'].textContent = `${data.pendingTeams.length} 支队伍待安排`;
  elements['pending-list'].replaceChildren(...data.pendingTeams.map(team => {
    const item = node('li', 'pending-item');
    item.append(node('strong', '', team.name), node('p', '', team.project || '暂未填写作品名'));
    return item;
  }));
}

async function refresh() {
  if (loading) return;
  loading = true;
  elements['order-refresh'].disabled = true;
  elements['order-refresh'].textContent = '正在刷新…';
  elements['presentation-list'].setAttribute('aria-busy', 'true');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch('./api/presentation-order', {
      method: 'GET', credentials: 'omit', cache: 'no-store', signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error('request-failed');
    const data = normalizeOrder(await response.json());
    renderOrder(data);
    lastOrder = data;
    lastChecked = Date.now();
    elements['order-status'].classList.remove('error');
    elements['order-status'].textContent = `已于 ${formatTime(lastChecked)} 核对名单${data.drawnAt ? '，请按以上顺序准备。' : '，尚未公布路演顺序。'}`;
  } catch {
    elements['order-status'].classList.add('error');
    elements['order-status'].textContent = lastOrder
      ? `暂时无法更新。当前保留的是 ${formatTime(lastChecked)} 最后核对的名单，可能有变化，请稍后刷新或联系工作人员。`
      : '暂时无法读取路演名单，请点击“刷新顺序”重试，或向现场工作人员查询。';
    if (!lastOrder) {
      elements['order-summary'].textContent = '暂未读取到名单';
      elements['order-updated'].textContent = '恢复连接后将自动更新';
    }
  } finally {
    clearTimeout(timeout);
    loading = false;
    elements['order-refresh'].disabled = false;
    elements['order-refresh'].textContent = '刷新顺序';
    elements['presentation-list'].setAttribute('aria-busy', 'false');
  }
}

function renderPartners() {
  elements['order-partners'].replaceChildren(...SITE.logos.map(partner => {
    const figure = node('figure', 'guide-partner');
    const box = node('div');
    const image = node('img');
    image.src = partner.src;
    image.alt = partner.name;
    image.loading = 'lazy';
    image.decoding = 'async';
    box.append(image);
    figure.append(box, node('figcaption', '', partner.name));
    return figure;
  }));
}

elements['order-refresh'].addEventListener('click', refresh);
elements['order-print'].addEventListener('click', () => window.print());
elements['order-fullscreen'].addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.querySelector('.order-shell').requestFullscreen();
  } catch {
    elements['order-status'].textContent = '此浏览器暂不支持全屏展示，可以使用浏览器自身的全屏功能。';
  }
});
document.addEventListener('fullscreenchange', () => {
  elements['order-fullscreen'].textContent = document.fullscreenElement ? '退出全屏' : '全屏展示';
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh();
});
renderPartners();
refresh();
setInterval(() => { if (!document.hidden) refresh(); }, 30000);
