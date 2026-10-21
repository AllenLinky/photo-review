'use strict';

/**
 * /dp 冒烟测试：不联网，用一个假模型服务顶替 DeepSeek。
 * 覆盖：按 IP 限频、账号注册登录、档案按账号隔离、格式校验（严格 / 修复 / 重试 / 三次都不过留档）、
 *      老记录启动自动修复、一键重新点评。
 *
 * 跑法：node test-smoke.cjs
 * 它会把本项目复制到系统临时目录（dp-smoke）再跑，不碰 data/ 里的真实数据和图片。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const Module = require('node:module');

const SRC = __dirname;
const WORK = path.join(os.tmpdir(), 'dp-smoke');
const APP = path.join(WORK, 'app');
const DATA = path.join(APP, 'data');
const MEDIA = path.join(DATA, 'media');
const MOCK_PORT = 18080;
const APP_PORT = 18091;
const BASE = `http://127.0.0.1:${APP_PORT}/dp`;
const API_PER_SECOND = 4;

const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwcJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPDIzNP/AABEIAAEAAQMBIgACEQEDEQH/xAAfAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgv/xAC1EAACAQMDAgQDBQUEBAAAAX0BAgMABBEFEiExQQYTUWEHInEUMoGRoQgjQrHBFVLR8CQzYnKCCQoVFhcaGCRFVmZnaGk1NzhJc3R1dnd4eXqCg4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/aAAwDAQACEQMRAD8A/v4/9k=',
  'base64'
);

let passed = 0;
const failures = [];

function check(name, ok, extra) {
  if (ok) {
    passed += 1;
    console.log('  ✓ ' + name);
  } else {
    failures.push(name + (extra ? ' — ' + extra : ''));
    console.log('  ✗ ' + name + (extra ? ' — ' + extra : ''));
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function goodReview() {
  return JSON.stringify({
    genre: '街头纪实',
    total: 74,
    headline: '光比压得住，构图上边缘还是散了。',
    dimensions: [
      { name: '内容与瞬间', score: 7.5, comment: '有人走过，但动作还没到顶点。' },
      { name: '构图', score: 7, comment: '左侧留白偏多，主体压在中下。' },
      { name: '光影', score: 8, comment: '侧光把地面纹理挑起来了。' },
      { name: '色彩', score: 7.5, comment: '冷暖分层清楚。' },
      { name: '技术质量', score: 7, comment: '焦点落在人物肩膀，略前。' },
    ],
    strengths: ['侧光干净', '色调统一'],
    weaknesses: ['上边缘杂物多', '快门略慢'],
    suggestions: ['机位后退半步', '快门提到 1/500s', '裁掉上方杂物'],
    params: 'f/4、1/250s、ISO 400，白天街拍可用，但快门不够冻结走动的人。',
  });
}

/** 真实翻车样本：JSON 字符串内部又写了英文双引号，直接 JSON.parse 会失败 */
function innerQuotesJson() {
  return [
    '{',
    '  "genre": "婚礼纪实",',
    '  "total": 70,',
    '  "headline": "红纸满天、众人抢喜的瞬间抓到了。",',
    '  "dimensions": [',
    '    { "name": "内容与瞬间", "score": 8, "comment": "形成"记录者在被记录"的趣味层次。" },',
    '    { "name": "构图", "score": 7, "comment": "把视线从左上那个"新婚快乐"牌子带到右侧人群。" },',
    '    { "name": "光影", "score": 6.5, "comment": "整体偏"平"，缺少明暗收束。" },',
    '    { "name": "色彩", "score": 7, "comment": "正红纸片做点睛，喜庆感准确。" },',
    '    { "name": "技术质量", "score": 6.5, "comment": "主体清晰，边缘红纸失焦。" }',
    '  ],',
    '  "strengths": ["抓到了高潮瞬间", "色彩逻辑统一"],',
    '  "weaknesses": ["边缘畸变明显", "前景红纸压住主景"],',
    '  "suggestions": ["机位后退半步", "快门提到 1/500s"],',
    '  "params": "14mm 超广角，f/4，中午强光。"',
    '}',
  ].join('\n');
}

/* ------------------------------ 假模型服务 ------------------------------ */

let queue = [];
/** 记录假模型服务最后一次收到的请求，用来断言各家的协议差异 */
let lastRequest = null;

function nextOutput(prompt) {
  const kind = queue.length ? queue.shift() : 'ok';
  if (kind === 'innerquotes') return innerQuotesJson();
  if (kind === 'garbage') return '这张照片拍得还行，我觉得挺好看的。';
  if (kind === 'repair') return /整理成一个合法的 JSON/.test(prompt) ? goodReview() : '还是不行，我就这么说吧。';
  return goodReview();
}

function promptOf(url, payload) {
  let content;
  if (url.includes('/responses')) {
    content = (payload.input && payload.input[0] && payload.input[0].content) || [];
    return content.map((part) => part.text || '').join('');
  }
  if (url.includes('/chat/completions') || url.includes('/messages')) {
    content = payload.messages && payload.messages[0] && payload.messages[0].content;
    return Array.isArray(content) ? content.map((part) => part.text || '').join('') : String(content || '');
  }
  if (url.includes(':generateContent')) {
    const parts = (payload.contents && payload.contents[0] && payload.contents[0].parts) || [];
    return parts.map((part) => part.text || '').join('');
  }
  return '';
}

const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    const url = req.url || '';
    if (req.method === 'GET' && url.includes('/models')) {
      lastRequest = { url, headers: req.headers, payload: {} };
      let listed;
      if (url.includes('pageSize=')) {
        listed = { models: [{ name: 'models/gemini-test-1' }, { name: 'models/gemini-test-2' }] };
      } else if (url.includes('limit=')) {
        listed = { data: [{ id: 'claude-test-1' }, { id: 'claude-test-2' }] };
      } else {
        listed = { data: [{ id: 'gpt-test-1' }, { id: 'gpt-test-2' }] };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(listed));
      return;
    }
    let payload = {};
    try {
      payload = JSON.parse(body || '{}');
    } catch {
      payload = {};
    }
    lastRequest = { url, headers: req.headers, payload };
    const text = nextOutput(promptOf(url, payload));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (url.includes('/responses')) {
      res.end(JSON.stringify({ output_text: text }));
    } else if (url.includes('/chat/completions')) {
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }));
    } else if (url.includes('/messages')) {
      res.end(JSON.stringify({ content: [{ type: 'text', text }], stop_reason: 'end_turn' }));
    } else if (url.includes(':generateContent')) {
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }));
    } else {
      res.end('{}');
    }
  });
});

/* ------------------------------ 工具 ------------------------------ */

/** 默认每次接口调用间隔 320ms，避免被自己的限频挡住；测限频时传 rapid: true */
async function call(method, url, { body, rapid, cookie } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  const result = {
    status: response.status,
    json,
    retryAfter: response.headers.get('retry-after'),
    text,
    cookie:
      typeof response.headers.getSetCookie === 'function'
        ? response.headers
            .getSetCookie()
            .map((item) => item.split(';')[0])
            .join('; ')
        : '',
  };
  if (!rapid && url.includes('/api/')) await sleep(320);
  return result;
}

function uploadBody(title) {
  return {
    image: 'data:image/jpeg;base64,' + JPEG.toString('base64'),
    exifText: '机身：Nikon Z 6II · 焦距：35mm · 光圈：f/4 · 快门：1/250s · ISO：400',
    exif: { make: 'NIKON CORPORATION', model: 'Z 6II', focal: 35, fnumber: 4, exposure: 0.004, iso: 400 },
    width: 6000,
    height: 4000,
    title,
    note: '',
  };
}

function readDb() {
  return JSON.parse(fs.readFileSync(path.join(DATA, 'reviews.json'), 'utf8'));
}

function loadApp() {
  const file = path.join(APP, 'server.js');
  const mod = new Module(file, null);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(APP);
  const originalArgv = process.argv;
  process.argv = [process.execPath, file];
  try {
    mod._compile(fs.readFileSync(file, 'utf8'), file);
  } finally {
    process.argv = originalArgv;
  }
}

async function waitForHealth(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await call('GET', BASE + '/api/health', { rapid: true });
      if (res.status === 200) {
        await sleep(1100);
        return true;
      }
    } catch {
      /* 还没起来 */
    }
    await sleep(200);
  }
  return false;
}

/* ------------------------------ 准备 ------------------------------ */

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(MEDIA, { recursive: true });
fs.copyFileSync(path.join(SRC, 'server.js'), path.join(APP, 'server.js'));
fs.cpSync(path.join(SRC, 'public'), path.join(APP, 'public'), { recursive: true });
fs.writeFileSync(
  path.join(DATA, 'config.json'),
  JSON.stringify(
    {
      basePath: '/dp',
      host: '127.0.0.1',
      port: APP_PORT,
      ports: [],
      api: { baseUrl: 'http://127.0.0.1:' + MOCK_PORT, model: 'mock-model', apiKey: 'sk-test-1234', timeoutMs: 20000 },
      limits: {
        perSecond: API_PER_SECOND,
        staticPerSecond: 30,
        perHour: 40,
        perDay: 150,
        maxImageBytes: 8 * 1024 * 1024,
      },
    },
    null,
    2
  ),
  'utf8'
);
fs.writeFileSync(path.join(MEDIA, 'legacy.jpg'), JPEG);

/** 一条「格式损坏 + 没有归属」的老记录：用来测启动自动修复，以及它不会漏给别人看 */
const LEGACY_ID = 'rev_legacy_test_1';
fs.writeFileSync(
  path.join(DATA, 'reviews.json'),
  JSON.stringify(
    {
      version: 1,
      reviews: [
        {
          id: LEGACY_ID,
          createdAt: '2026-09-16T07:00:00.000Z',
          title: '老记录',
          note: '',
          image: '/media/legacy.jpg',
          bytes: JPEG.length,
          width: 6000,
          height: 4000,
          exifText: '',
          exif: null,
          model: 'mock-model',
          result: {
            genre: '',
            total: null,
            headline: '模型这次没有按格式返回，下面是原文。',
            dimensions: [],
            strengths: [],
            weaknesses: [],
            suggestions: [],
            params: '',
            raw: innerQuotesJson(),
            degraded: true,
          },
        },
      ],
    },
    null,
    2
  ),
  'utf8'
);

/* ------------------------------ 跑 ------------------------------ */

(async function run() {
  await new Promise((resolve) => mock.listen(MOCK_PORT, '127.0.0.1', resolve));
  loadApp();
  const alive = await waitForHealth();
  if (!alive) {
    console.log('服务没起来，直接退出');
    process.exit(1);
  }

  console.log('\n[0] 首次运行：初始化引导');
  const setupState = await call('GET', BASE + '/api/setup');
  check('新装站点报告需要初始化', setupState.status === 200 && setupState.json.needsSetup === true, JSON.stringify(setupState.json));
  const blockedReg = await call('POST', BASE + '/api/register', { body: { name: 'early', password: 'pass1234' } });
  check('初始化前注册被挡（409）', blockedReg.status === 409 && Boolean(blockedReg.json && blockedReg.json.setupRequired), 'status=' + blockedReg.status);
  const secretsFile = JSON.parse(fs.readFileSync(path.join(DATA, 'secrets.json'), 'utf8'));
  check('启动时把 config.json 里的 key 搬进 secrets.json', secretsFile.apiKey === 'sk-test-1234');
  const cfgAfterMigrate = JSON.parse(fs.readFileSync(path.join(DATA, 'config.json'), 'utf8'));
  check('config.json 里已经不含 key', !cfgAfterMigrate.api.apiKey);
  const setupTooShort = await call('POST', BASE + '/api/setup', { body: { name: 'a', password: '123' } });
  check('初始化也校验用户名密码', setupTooShort.status === 400, 'status=' + setupTooShort.status);
  const setupA = await call('POST', BASE + '/api/setup', { body: { name: '测试甲', password: 'pass-a-1234' } });
  check(
    '创建管理者账号并直接登录',
    setupA.status === 200 && setupA.json.user.name === '测试甲' && setupA.json.user.role === 'admin' && setupA.cookie.includes('dp_session'),
    'status=' + setupA.status
  );
  check('初始化后 hasKey 报 true（沿用原来的 key）', setupA.json.hasKey === true);
  const setupAgain = await call('POST', BASE + '/api/setup', { body: { name: '再来一次', password: 'pass-b-1234' } });
  check('重复初始化被拒（409）', setupAgain.status === 409, 'status=' + setupAgain.status);
  const setupState2 = await call('GET', BASE + '/api/setup');
  check('初始化后不再要求设置', setupState2.json.needsSetup === false);

  console.log('\n[1] 未登录边界 + 首页免口令');
  const health = await call('GET', BASE + '/api/health');
  check('健康检查返回 200', health.status === 200, 'status=' + health.status);
  check('健康检查里报出限频额度', Boolean(health.json && health.json.limits && health.json.limits.perSecond === API_PER_SECOND));
  check('健康检查不再提 auth', Boolean(health.json && health.json.auth === undefined));
  const anonData = await call('GET', BASE + '/api/data');
  check('未登录读档案返回 401', anonData.status === 401, 'status=' + anonData.status);
  const anonPost = await call('POST', BASE + '/api/review', { body: uploadBody('匿名') });
  check('未登录点评返回 401', anonPost.status === 401, 'status=' + anonPost.status);
  const me0 = await call('GET', BASE + '/api/me');
  check('未登录 /api/me 返回 user=null', me0.status === 200 && me0.json.user === null);
  const page = await fetch(BASE + '/');
  check('首页本身不需要口令就能打开（登录页由页面自己渲染）', page.status === 200);

  console.log('\n[1b] 注册 / 登录 / 档案隔离');
  const cookieA = setupA.cookie;
  const badReg = await call('POST', BASE + '/api/register', { body: { name: 'a', password: '123' } });
  check('用户名太短会被拒', badReg.status === 400, 'status=' + badReg.status);
  const dupA = await call('POST', BASE + '/api/register', { body: { name: '测试甲', password: 'other12345' } });
  check('同名不能重复注册', dupA.status === 409, 'status=' + dupA.status);
  const regB = await call('POST', BASE + '/api/register', { body: { name: '测试乙', password: 'pass-b-1234' } });
  check('初始化后其他人可以注册', regB.status === 200 && regB.json.user.name === '测试乙' && regB.json.user.role === 'user');
  const cookieB = regB.cookie;
  const wrongPass = await call('POST', BASE + '/api/login', { body: { name: '测试乙', password: 'nope-nope' } });
  check('密码错误被拒', wrongPass.status === 401, 'status=' + wrongPass.status);
  const loginA = await call('POST', BASE + '/api/login', { body: { name: '测试甲', password: 'pass-a-1234' } });
  check('A 能正常登录', loginA.status === 200 && Boolean(loginA.cookie));
  const usersFile = JSON.parse(fs.readFileSync(path.join(DATA, 'users.json'), 'utf8'));
  check('users.json 存的是摘要不是明文', usersFile.users.length === 2 && !JSON.stringify(usersFile).includes('pass-a-1234'));
  check('只有第一个账号是管理者', usersFile.users.filter((item) => item.role === 'admin').length === 1);
  const dataEmptyB = await call('GET', BASE + '/api/data', { cookie: cookieB });
  check('新账号的档案是空的', dataEmptyB.status === 200 && dataEmptyB.json.reviews.length === 0, 'status=' + dataEmptyB.status);

  console.log('\n[2] 按 IP 限频：接口低于 5 次/秒');
  await sleep(1100); // 先把上一段的滑动窗口清空，再压测
  const burst = [];
  for (let i = 0; i < API_PER_SECOND + 3; i += 1) {
    burst.push(await call('GET', BASE + '/api/health', { rapid: true }));
  }
  const okCount = burst.filter((item) => item.status === 200).length;
  const blocked = burst.filter((item) => item.status === 429);
  check(`同一秒内前 ${API_PER_SECOND} 次放行`, okCount === API_PER_SECOND, '放行 ' + okCount + ' 次');
  check('超出的请求被 429 挡住', blocked.length === burst.length - API_PER_SECOND, '被挡 ' + blocked.length + ' 次');
  check('429 会告诉客户端几秒后重试', Boolean(blocked[0] && blocked[0].retryAfter), 'Retry-After=' + (blocked[0] && blocked[0].retryAfter));
  check('429 带可读的错误说明', Boolean(blocked[0] && blocked[0].json && blocked[0].json.error), JSON.stringify(blocked[0] && blocked[0].json));
  await sleep(1100);
  const recovered = await call('GET', BASE + '/api/health');
  check('过一秒自动恢复', recovered.status === 200, 'status=' + recovered.status);
  const staticBurst = [];
  for (let i = 0; i < 8; i += 1) staticBurst.push(await fetch(BASE + '/'));
  check('静态资源是另一档额度，不会被接口限频连坐', staticBurst.every((item) => item.status === 200));
  await sleep(1100);

  console.log('\n[3] 没有归属的老记录：启动自动修复，但不漏给任何账号');
  check('老记录已经被自动重新解析并落盘', readDb().reviews[0].result.degraded === false);
  check('解析出的总分正确（70）', readDb().reviews[0].result.total === 70);
  const orphanHealth = await call('GET', BASE + '/api/health');
  check('健康检查报出无主记录条数', orphanHealth.json.orphan === 1, 'orphan=' + orphanHealth.json.orphan);
  const dataA0 = await call('GET', BASE + '/api/data', { cookie: cookieA });
  check('A 的档案里看不到无主的老记录', !dataA0.json.reviews.some((item) => item.id === LEGACY_ID));
  const dataB0 = await call('GET', BASE + '/api/data', { cookie: cookieB });
  check('B 的档案里同样看不到', !dataB0.json.reviews.some((item) => item.id === LEGACY_ID));

  console.log('\n[4] 格式校验：正常 / 可修复 / 自动重试');
  queue = ['ok'];
  const okReview = await call('POST', BASE + '/api/review', { cookie: cookieA, body: uploadBody('正常一张') });
  const okResult = okReview.json && okReview.json.review.result;
  check('正常输出直接通过', okReview.status === 200 && okResult.degraded === false && okResult.total === 74);
  check('记录里带 format 校验信息', Boolean(okResult.format && okResult.format.mode === 'strict' && okResult.format.attempts === 1));
  check('点评记在 A 名下', okReview.json.review.ownerId === setupA.json.user.id && okReview.json.review.ownerName === '测试甲');

  queue = ['innerquotes'];
  const fixedReview = await call('POST', BASE + '/api/review', { cookie: cookieA, body: uploadBody('内层引号那张') });
  const fixedResult = fixedReview.json && fixedReview.json.review.result;
  check('字符串内层英文引号能被修复解析', fixedResult.degraded === false, JSON.stringify(fixedResult.format));
  check('修复后总分正确（70）', fixedResult.total === 70);
  check('标记为 repaired 且保留原文备查', fixedResult.format.mode === 'repaired' && fixedResult.raw.length > 100);

  queue = ['garbage', 'ok'];
  const retryResult2 = await call('POST', BASE + '/api/review', { cookie: cookieA, body: uploadBody('第一次翻车') });
  const retryResult = retryResult2.json && retryResult2.json.review.result;
  check('第一次不合格会自动重试并成功', retryResult.degraded === false && retryResult.format.attempts === 2, JSON.stringify(retryResult.format));
  check('attempts 日志记下了两次尝试', Array.isArray(retryResult.format.log) && retryResult.format.log.length === 2);

  queue = ['garbage', 'garbage', 'repair'];
  const repairedReview = await call('POST', BASE + '/api/review', { cookie: cookieA, body: uploadBody('靠语法修复救回') });
  const repairedResult = repairedReview.json && repairedReview.json.review.result;
  check('第三次走「只做语法修复」能救回来', repairedResult.degraded === false && repairedResult.format.attempts === 3, JSON.stringify(repairedResult.format));

  console.log('\n[5] 三次都不过：原文 + 报错都留下');
  queue = ['garbage', 'garbage', 'garbage'];
  const badReview = await call('POST', BASE + '/api/review', { cookie: cookieA, body: uploadBody('彻底翻车') });
  const badResult = badReview.json && badReview.json.review.result;
  check('接口仍然返回 200，记录被保存', badReview.status === 200 && Boolean(badResult));
  check('标记为 degraded', badResult.degraded === true);
  check('原文被完整保留', typeof badResult.raw === 'string' && badResult.raw.includes('这张照片拍得还行'));
  check('报了失败原因', Array.isArray(badResult.format.issues) && badResult.format.issues.length > 0, JSON.stringify(badResult.format.issues));
  check('尝试次数记录为 3', badResult.format.attempts === 3);
  const errLog = fs.readFileSync(path.join(DATA, 'error.log'), 'utf8').trim().split('\n').filter(Boolean);
  check('data/error.log 里留了一条报错', errLog.length >= 1);
  check('error.log 里存的是原始输出', errLog[errLog.length - 1].includes('这张照片拍得还行'));

  console.log('\n[6] 重新点评 + 只能动自己的');
  queue = ['ok'];
  const retried = await call('POST', BASE + '/api/review/' + badReview.json.review.id + '/retry', { cookie: cookieA });
  check('重新点评成功', retried.status === 200 && retried.json.review.result.degraded === false, 'status=' + retried.status);
  check('重新点评后总分回来了', retried.json.review.result.total === 74);
  check('记录里留下重试时间', Boolean(retried.json.review.retriedAt));
  const missing = await call('POST', BASE + '/api/review/rev_not_exist/retry', { cookie: cookieA });
  check('没有这条点评时返回 404', missing.status === 404, 'status=' + missing.status);
  const retryByB = await call('POST', BASE + '/api/review/' + okReview.json.review.id + '/retry', { cookie: cookieB });
  check('B 不能重新点评 A 的照片', retryByB.status === 403, 'status=' + retryByB.status);

  console.log('\n[7] 档案隔离 + 删除权限');
  const dataA = await call('GET', BASE + '/api/data', { cookie: cookieA });
  const dataB = await call('GET', BASE + '/api/data', { cookie: cookieB });
  const idsA = dataA.json.reviews.map((item) => item.id);
  const idsB = dataB.json.reviews.map((item) => item.id);
  check('A 能看到自己点评的几张', idsA.includes(okReview.json.review.id) && idsA.includes(badReview.json.review.id));
  check('B 看不到 A 的点评', !idsB.includes(okReview.json.review.id) && !idsB.includes(badReview.json.review.id));
  check('B 的档案仍然是空的', idsB.length === 0, 'B 有 ' + idsB.length + ' 条');
  const delByB = await call('DELETE', BASE + '/api/review/' + okReview.json.review.id, { cookie: cookieB });
  check('B 不能删除 A 的点评', delByB.status === 403, 'status=' + delByB.status);
  const del = await call('DELETE', BASE + '/api/review/' + okReview.json.review.id, { cookie: cookieA });
  check('删除返回 ok', del.status === 200 && del.json.ok === true, 'status=' + del.status);
  const afterDel = await call('GET', BASE + '/api/data', { cookie: cookieA });
  check('档案里已经没有这条了', !afterDel.json.reviews.some((item) => item.id === okReview.json.review.id));
  check('图片文件也一起删掉了', !fs.existsSync(path.join(MEDIA, okReview.json.review.id + '.jpg')));
  const logout = await call('POST', BASE + '/api/logout', { cookie: cookieA });
  check('退出返回 ok', logout.status === 200 && logout.json.ok === true);
  const afterLogout = await call('GET', BASE + '/api/me', { cookie: cookieA });
  check('退出后旧 cookie 立即失效', afterLogout.json.user === null);
  const dataAfterLogout = await call('GET', BASE + '/api/data', { cookie: cookieA });
  check('退出后读档案被挡', dataAfterLogout.status === 401, 'status=' + dataAfterLogout.status);

  console.log('\n[8] 机器可跑的配置自检');
  const cfg = JSON.parse(fs.readFileSync(path.join(DATA, 'config.json'), 'utf8'));
  check('站点口令（Basic）仍然关闭', cfg.auth === undefined);
  check('接口限频低于 5 次/秒', cfg.limits.perSecond < 5, 'perSecond=' + cfg.limits.perSecond);
  check('点评总量仍按 IP 限住', cfg.limits.perHour > 0 && cfg.limits.perDay > 0);

  console.log('\n[9] 管理者设置：Key 只在服务端，别人进不来');
  const settingsByB = await call('GET', BASE + '/api/settings', { cookie: cookieB });
  check('普通账号读设置被拒（403）', settingsByB.status === 403, 'status=' + settingsByB.status);
  const settingsByA = await call('GET', BASE + '/api/settings', { cookie: loginA.cookie });
  check('管理员能读设置', settingsByA.status === 200 && settingsByA.json.hasKey === true, 'status=' + settingsByA.status);
  check(
    '设置里只回显 key 后四位',
    settingsByA.json.keyHint === '••••1234' && !JSON.stringify(settingsByA.json).includes('sk-test-1234'),
    JSON.stringify(settingsByA.json)
  );
  const setKey = await call('POST', BASE + '/api/settings', {
    cookie: loginA.cookie,
    body: { apiKey: 'sk-new-5678', model: 'mock-model-2', baseUrl: 'http://127.0.0.1:' + MOCK_PORT },
  });
  check(
    '管理员能换 key 和模型',
    setKey.status === 200 && setKey.json.keyHint === '••••5678' && setKey.json.model === 'mock-model-2',
    JSON.stringify(setKey.json)
  );
  check(
    '设置里带上了可选的服务商列表',
    Array.isArray(settingsByA.json.providers) &&
      ['deepseek', 'openai', 'anthropic', 'gemini', 'glm', 'qwen', 'kimi', 'custom'].every((id) =>
        settingsByA.json.providers.some((item) => item.id === id)
      ),
    JSON.stringify((settingsByA.json.providers || []).map((item) => item.id))
  );
  const testConn = await call('POST', BASE + '/api/settings/test', { cookie: loginA.cookie });
  check('测试连接能打到模型接口', testConn.status === 200 && testConn.json.ok === true, JSON.stringify(testConn.json));

  console.log('\n[10] 多家服务商：协议、鉴权头和图片都能对上');
  const protocolCases = [
    { provider: 'openai', url: '/chat/completions', header: 'authorization', image: 'image_url' },
    { provider: 'anthropic', url: '/v1/messages', header: 'x-api-key', image: '"type":"image"' },
    { provider: 'gemini', url: ':generateContent', header: 'x-goog-api-key', image: 'inline_data' },
    { provider: 'glm', url: '/chat/completions', header: 'authorization', image: 'image_url' },
    { provider: 'qwen', url: '/chat/completions', header: 'authorization', image: 'image_url' },
    { provider: 'kimi', url: '/chat/completions', header: 'authorization', image: 'image_url' },
  ];
  const jpegHead = JPEG.toString('base64').slice(0, 32);
  for (const item of protocolCases) {
    const saved = await call('POST', BASE + '/api/settings', {
      cookie: loginA.cookie,
      body: {
        provider: item.provider,
        apiKey: 'sk-test-1234',
        model: 'mock-model',
        baseUrl: 'http://127.0.0.1:' + MOCK_PORT,
      },
    });
    queue = ['ok'];
    const reviewed = await call('POST', BASE + '/api/review', { cookie: loginA.cookie, body: uploadBody('协议 ' + item.provider) });
    const sentBody = lastRequest ? JSON.stringify(lastRequest.payload) : '';
    check(
      `${item.provider} 切过去能点评成功`,
      saved.status === 200 && reviewed.status === 200 && reviewed.json.review.result.total === 74,
      'status=' + reviewed.status
    );
    check(
      `${item.provider} 打到 ${item.url} 并带 ${item.header} 头`,
      Boolean(lastRequest) && lastRequest.url.includes(item.url) && Boolean(lastRequest.headers[item.header]),
      lastRequest ? lastRequest.url : 'no request'
    );
    check(
      `${item.provider} 按自己的格式把图片发出去了`,
      sentBody.includes(item.image) && sentBody.includes(jpegHead),
      lastRequest ? lastRequest.url : ''
    );
  }
  const backToDeepSeek = await call('POST', BASE + '/api/settings', {
    cookie: loginA.cookie,
    body: {
      provider: 'deepseek',
      apiKey: 'sk-test-1234',
      model: 'mock-model',
      baseUrl: 'http://127.0.0.1:' + MOCK_PORT,
    },
  });
  check('切回 DeepSeek 后走回 /responses', backToDeepSeek.status === 200 && backToDeepSeek.json.provider === 'deepseek');
  queue = ['ok'];
  const deepseekAgain = await call('POST', BASE + '/api/review', { cookie: loginA.cookie, body: uploadBody('切回来') });
  check(
    'DeepSeek 仍然用 Responses 接口',
    deepseekAgain.status === 200 && Boolean(lastRequest) && lastRequest.url.includes('/responses') && Boolean(lastRequest.headers.authorization),
    lastRequest ? lastRequest.url : ''
  );
  const badProvider = await call('POST', BASE + '/api/settings', {
    cookie: loginA.cookie,
    body: { provider: '不存在的服务商', model: 'x', baseUrl: 'http://127.0.0.1:' + MOCK_PORT },
  });
  check('不认识的服务商会被拒（400）', badProvider.status === 400, 'status=' + badProvider.status);

  console.log('\n[11] 拉取各家的模型列表');
  const modelCases = [
    { provider: 'openai', header: 'authorization', expect: 'gpt-test-1' },
    { provider: 'anthropic', header: 'x-api-key', expect: 'claude-test-1' },
    { provider: 'gemini', header: 'x-goog-api-key', expect: 'gemini-test-1' },
    { provider: 'deepseek', header: 'authorization', expect: 'gpt-test-1' },
  ];
  for (const item of modelCases) {
    const listed = await call('POST', BASE + '/api/settings/models', {
      cookie: loginA.cookie,
      body: {
        provider: item.provider,
        apiKey: 'sk-test-1234',
        model: 'mock-model',
        baseUrl: 'http://127.0.0.1:' + MOCK_PORT,
      },
    });
    check(
      `${item.provider} 能拉到模型列表`,
      listed.status === 200 && Array.isArray(listed.json.models) && listed.json.models.includes(item.expect),
      listed.text ? listed.text.slice(0, 160) : ''
    );
    check(
      `${item.provider} 拉列表时带了正确的鉴权头`,
      Boolean(lastRequest) && Boolean(lastRequest.headers[item.header]) && lastRequest.url.includes('/models'),
      lastRequest ? lastRequest.url : ''
    );
  }

  const cleared = await call('POST', BASE + '/api/settings', { cookie: loginA.cookie, body: { clearKey: true } });
  check('可以清除 key', cleared.status === 200 && cleared.json.hasKey === false, JSON.stringify(cleared.json));
  const noKeyReview = await call('POST', BASE + '/api/review', { cookie: loginA.cookie, body: uploadBody('没有 key') });
  check('没有 key 时点评给明确提示', noKeyReview.status === 500 && /API Key/.test(noKeyReview.json.error), 'status=' + noKeyReview.status);
  const restored = await call('POST', BASE + '/api/settings', {
    cookie: loginA.cookie,
    body: { apiKey: 'sk-test-1234', model: 'mock-model', baseUrl: 'http://127.0.0.1:' + MOCK_PORT },
  });
  check('可以再把 key 填回来', restored.status === 200 && restored.json.hasKey === true);

  console.log('\n通过 ' + passed + ' 项，失败 ' + failures.length + ' 项');
  if (failures.length) {
    console.log('失败项：');
    for (const item of failures) console.log('  - ' + item);
  }
  process.exit(failures.length ? 1 : 0);
})().catch((err) => {
  console.error('测试崩了：', err);
  process.exit(1);
});
