'use strict';

/**
 * 照片点评 / dp
 * 零依赖 Node 服务：静态页 + 上传照片 → 调 DeepSeek 多模态接口 → 存点评档案
 * 挂在 /dp 子路径下，通常由 80 端口上的服务转发进来。
 */

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const DB_FILE = path.join(DATA_DIR, 'reviews.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const SECRETS_FILE = path.join(DATA_DIR, 'secrets.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SECRET_FILE = path.join(DATA_DIR, 'secret.key');
const ERROR_LOG_FILE = path.join(DATA_DIR, 'error.log');

/** 登录会话：cookie 名、有效期；以及格式校验的最多尝试次数 */
const SESSION_COOKIE = 'dp_session';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const MAX_FORMAT_ATTEMPTS = 3;

const DEFAULT_CONFIG = {
  basePath: '/dp',
  host: '127.0.0.1',
  port: 9091,
  ports: [],
  api: {
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    apiKey: '',
    timeoutMs: 240000,
  },
  limits: {
    perSecond: 4,
    staticPerSecond: 30,
    perHour: 40,
    perDay: 150,
    maxImageBytes: 8 * 1024 * 1024,
  },
};

function normalizeBasePath(value) {
  const raw = String(value || '').trim();
  if (!raw || raw === '/') return '';
  return '/' + raw.replace(/^\/+/, '').replace(/\/+$/, '');
}

function loadConfig(argv) {
  let fileConfig = {};
  try {
    fileConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    fileConfig = {};
  }
  const merged = {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    api: { ...DEFAULT_CONFIG.api, ...(fileConfig.api || {}) },
    limits: { ...DEFAULT_CONFIG.limits, ...(fileConfig.limits || {}) },
  };
  const argValue = (flag) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  if (argValue('--base') !== undefined) merged.basePath = argValue('--base');
  if (argValue('--host') !== undefined) merged.host = argValue('--host');
  if (argValue('--port') !== undefined) merged.port = Number(argValue('--port'));
  if (argValue('--model') !== undefined) merged.api.model = argValue('--model');
  if (argValue('--api-key') !== undefined) merged.api.apiKey = argValue('--api-key');
  if (argValue('--also-port') !== undefined) {
    merged.ports = String(argValue('--also-port'))
      .split(',')
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isFinite(value) && value > 0);
  }
  if (argv.includes('--public')) merged.host = '::';
  if (process.env.DP_BASE_PATH !== undefined) merged.basePath = process.env.DP_BASE_PATH;
  if (process.env.DP_HOST !== undefined) merged.host = process.env.DP_HOST;
  if (process.env.DP_PORT !== undefined) merged.port = Number(process.env.DP_PORT);
  if (process.env.DP_MODEL !== undefined) merged.api.model = process.env.DP_MODEL;
  if (process.env.DP_API_KEY !== undefined) merged.api.apiKey = process.env.DP_API_KEY;
  merged.basePath = normalizeBasePath(merged.basePath);
  if (!Number.isFinite(merged.port) || merged.port <= 0) merged.port = DEFAULT_CONFIG.port;
  if (!Array.isArray(merged.ports)) merged.ports = [];
  merged.api.baseUrl = String(merged.api.baseUrl || '').replace(/\/+$/, '');
  merged.api.apiKey = String(merged.api.apiKey || '').trim();
  return merged;
}

const config = loadConfig(process.argv.slice(2));

/** 各家模型服务商的预设：接口类型、地址、默认模型和视觉模型候选。模型名以各家文档为准，页面上可以手填。 */
const PROVIDERS = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    kind: 'openai-responses',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    keysUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'openai',
    label: 'OpenAI（GPT）',
    kind: 'openai-chat',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-6.1-sol',
    models: ['gpt-6.1-sol', 'gpt-6.1-sol-pro', 'gpt-6-luna'],
    keysUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'anthropic',
    label: 'Anthropic（Claude）',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-opus-5-5',
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
    keysUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'gemini',
    label: 'Google（Gemini）',
    kind: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-4-argon',
    models: ['gemini-4-argon', 'gemini-3-pro-preview', 'gemini-3-flash-preview'],
    keysUrl: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'glm',
    label: '智谱（GLM）',
    kind: 'openai-chat',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-5.3-flash',
    models: ['glm-5.3-flash', 'glm-5.3-flashx', 'glm-4.6v'],
    keysUrl: 'https://bigmodel.cn/usercenter/apikeys',
  },
  {
    id: 'qwen',
    label: '阿里云（通义千问）',
    kind: 'openai-chat',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3.8-max',
    models: ['qwen3.8-max', 'qwen3.8-flash', 'qwen3.8-omni-flash', 'qwen3-vl-plus'],
    keysUrl: 'https://bailian.console.aliyun.com/',
  },
  {
    id: 'kimi',
    label: '月之暗面（Kimi）',
    kind: 'openai-chat',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'kimi-k3',
    models: ['kimi-k3', 'kimi-k2.6'],
    keysUrl: 'https://platform.moonshot.cn/console/api-keys',
  },
  {
    id: 'custom',
    label: '自定义（OpenAI 兼容）',
    kind: 'openai-chat',
    baseUrl: '',
    model: '',
    models: [],
    keysUrl: '',
  },
];

function providerPresets() {
  return PROVIDERS.map(({ id, label, kind, baseUrl, model, models, keysUrl }) => ({
    id,
    label,
    kind,
    baseUrl,
    model,
    models,
    keysUrl,
  }));
}

function normalizeProviderId(value) {
  const id = String(value == null ? '' : value).trim().toLowerCase();
  return PROVIDERS.some((item) => item.id === id) ? id : '';
}

/** 当前生效的服务商：没配过就按 DeepSeek + config.json 里的默认地址和模型 */
function currentProvider() {
  const id = normalizeProviderId(secrets.provider) || 'deepseek';
  const preset = PROVIDERS.find((item) => item.id === id);
  const fallbackBase = id === 'deepseek' ? config.api.baseUrl : preset.baseUrl;
  const fallbackModel = id === 'deepseek' ? config.api.model : preset.model;
  return {
    ...preset,
    baseUrl: String(secrets.baseUrl || fallbackBase || '').replace(/\/+$/, ''),
    model: secrets.model || fallbackModel || '',
  };
}

/**
 * 运行时设置：服务商、API Key、模型、接口地址都存在 data/secrets.json 里，
 * 由网站「设置」页维护；config.json 只放端口、限频这类不敏感的参数。
 * 老版本把 key 写在 config.json，启动时会自动搬过来（见 migrateLegacyKey）。
 */
let secrets = { provider: '', apiKey: '', model: '', baseUrl: '', updatedAt: '' };

function emptySecrets() {
  return { provider: '', apiKey: '', model: '', baseUrl: '', updatedAt: '' };
}

async function loadSecrets() {
  try {
    const parsed = JSON.parse(await fsp.readFile(SECRETS_FILE, 'utf8'));
    secrets = {
      provider: typeof parsed.provider === 'string' ? parsed.provider.trim() : '',
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey.trim() : '',
      model: typeof parsed.model === 'string' ? parsed.model.trim() : '',
      baseUrl: typeof parsed.baseUrl === 'string' ? String(parsed.baseUrl).trim().replace(/\/+$/, '') : '',
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
    };
  } catch {
    secrets = emptySecrets();
  }
}

async function saveSecrets() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.writeFile(SECRETS_FILE, JSON.stringify(secrets, null, 2), 'utf8');
}

function apiKey() {
  return secrets.apiKey || config.api.apiKey;
}

function apiModel() {
  return currentProvider().model;
}

function apiBaseUrl() {
  return currentProvider().baseUrl;
}

function hasKey() {
  return Boolean(apiKey());
}

/** 只回显后四位，方便确认换没换，又不把 key 送到前端 */
function keyHint() {
  const key = apiKey();
  return key ? '••••' + key.slice(-4) : '';
}

/** 接口地址只接受 http(s)，去掉尾部斜杠；不合法就当没填 */
function normalizeApiBaseUrl(value) {
  const raw = String(value == null ? '' : value).trim().replace(/\/+$/, '');
  if (!raw) return '';
  if (!/^https?:\/\//i.test(raw)) return '';
  try {
    const url = new URL(raw);
    if (!url.hostname) return '';
    return (url.origin + url.pathname).replace(/\/+$/, '');
  } catch {
    return '';
  }
}

/**
 * 把老部署写在 config.json 里的 key 搬到 secrets.json，并把 config.json 里的抹掉。
 * 只认文件里的 key，不认 --api-key / 环境变量（那两个每次启动都会重新给）。
 */
async function migrateLegacyKey() {
  let fileConfig = null;
  try {
    fileConfig = JSON.parse(await fsp.readFile(CONFIG_FILE, 'utf8'));
  } catch {
    return false;
  }
  const legacy = fileConfig && fileConfig.api && String(fileConfig.api.apiKey || '').trim();
  if (!legacy) return false;
  if (!secrets.apiKey) {
    secrets.apiKey = legacy;
    secrets.updatedAt = new Date().toISOString();
    await saveSecrets();
  }
  fileConfig.api.apiKey = '';
  await fsp.writeFile(CONFIG_FILE, JSON.stringify(fileConfig, null, 4), 'utf8');
  // 内存里的 config 也清掉，否则在设置页点「清除」会又退回这个旧值
  if (config.api.apiKey === legacy) config.api.apiKey = '';
  console.log('[setup] 已把 API Key 从 data/config.json 移到 data/secrets.json');
  return true;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

let db = null;
let writeChain = Promise.resolve();

function newId(prefix) {
  return prefix + '_' + crypto.randomBytes(8).toString('hex');
}

async function loadDb() {
  await fsp.mkdir(MEDIA_DIR, { recursive: true });
  try {
    const parsed = JSON.parse(await fsp.readFile(DB_FILE, 'utf8'));
    db = { version: 1, reviews: [], ...parsed };
    if (!Array.isArray(db.reviews)) db.reviews = [];
  } catch {
    db = { version: 1, reviews: [] };
  }
}

function saveDb() {
  writeChain = writeChain
    .then(() => fsp.writeFile(DB_FILE, JSON.stringify(db, null, 2), 'utf8'))
    .catch((err) => console.error('[db] 写入失败', err));
  return writeChain;
}

/** 把一条格式异常的历史点评重新解析一遍（原文还留着，这是「预留报错」的用处） */
function reparseStoredResult(record) {
  const raw = record && record.result && record.result.raw;
  if (!raw) return false;
  const parsed = parseModelJson(raw);
  const checked = validateResult(parsed.value);
  if (!checked.ok) return false;
  record.result = normalizeResult({
    parsed: parsed.value,
    rawText: raw,
    mode: parsed.mode,
    warnings: checked.warnings,
    attempts: 1,
    log: [],
  });
  record.result.format.reparsed = true;
  return true;
}

async function repairStoredResults() {
  let fixed = 0;
  for (const record of db.reviews) {
    if (!record.result || !record.result.degraded) continue;
    try {
      if (reparseStoredResult(record)) fixed += 1;
    } catch (err) {
      console.warn('[db] 历史点评重新解析失败：' + (err && err.message));
    }
  }
  if (fixed) {
    await saveDb();
    console.log(`[db] 已修复 ${fixed} 条格式异常的历史点评`);
  }
  return fixed;
}

function withBase(url) {
  return config.basePath + url;
}

/* ------------------------------ HTTP 工具 ------------------------------ */

function send(res, status, body, headers) {
  res.writeHead(status, headers || { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function clientIp(req) {
  const remote = req.socket.remoteAddress || '';
  const forwarded = req.headers['x-forwarded-for'];
  const fromLocalProxy =
    remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1' || remote === 'localhost';
  /**
   * 外网请求都是经 80 端口的服务转发进来的：它会把真实地址追加到 x-forwarded-for 的最后一段，
   * 所以只有「来自本机转发」时我们才信这个头，并且取最后一段（取第一段会被客户端自己伪造的头骗过）。
   * 直接连本服务的请求一律用 socket 地址，头里写什么都不算。
   */
  if (fromLocalProxy && typeof forwarded === 'string' && forwarded.length) {
    const parts = forwarded.split(',').map((item) => item.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return remote || 'unknown';
}

const buckets = new Map();

function bucketFor(ip) {
  let bucket = buckets.get(ip);
  if (!bucket) {
    bucket = { api: [], static: [], hour: [], day: [] };
    buckets.set(ip, bucket);
  }
  if (buckets.size > 2000) {
    const now = Date.now();
    for (const [key, item] of buckets) {
      const idle =
        (item.api[item.api.length - 1] || 0) < now - 60 * 1000 &&
        (item.static[item.static.length - 1] || 0) < now - 60 * 1000 &&
        (item.day[item.day.length - 1] || 0) < now - 60 * 1000;
      if (idle) buckets.delete(key);
    }
  }
  return bucket;
}

/**
 * 每秒限频：按 IP 分「接口」和「静态资源」两档滑动窗口。
 * 接口默认 4 次/秒（低于 1 秒 5 次），静态资源放宽到 30 次/秒，
 * 否则同一个页面连着加载 HTML/CSS/JS/缩略图就会被自己的限频挡住。
 */
function rateLimit(ip, kind) {
  const now = Date.now();
  const bucket = bucketFor(ip);
  const key = kind === 'static' ? 'static' : 'api';
  const cap = key === 'static' ? config.limits.staticPerSecond : config.limits.perSecond;
  const windowMs = 1000;
  const list = bucket[key].filter((t) => t > now - windowMs);
  bucket[key] = list;
  if (list.length >= cap) {
    const retryAfter = Math.max(1, Math.ceil((list[0] + windowMs - now) / 1000));
    return {
      ok: false,
      retryAfter,
      message: `请求太快了（每 IP 每秒最多 ${cap} 次），${retryAfter} 秒后再试`,
    };
  }
  list.push(now);
  return { ok: true };
}

/** 点评额度：模型调用贵，除了每秒限频，另外按 IP 限制每小时 / 每天的总数 */
function reviewQuota(ip) {
  const now = Date.now();
  const dayAgo = now - 24 * 3600 * 1000;
  const hourAgo = now - 3600 * 1000;
  const bucket = bucketFor(ip);
  bucket.hour = bucket.hour.filter((t) => t > hourAgo);
  bucket.day = bucket.day.filter((t) => t > dayAgo);
  if (bucket.hour.length >= config.limits.perHour) {
    return { ok: false, retryAfter: 60, message: `每小时最多点评 ${config.limits.perHour} 张，休息一下再来` };
  }
  if (bucket.day.length >= config.limits.perDay) {
    return { ok: false, retryAfter: 600, message: `今天已经点评 ${config.limits.perDay} 张了，明天继续` };
  }
  bucket.hour.push(now);
  bucket.day.push(now);
  return { ok: true };
}

async function readJsonBody(req, limit = 16 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(Object.assign(new Error('JSON 解析失败'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

async function serveStatic(req, res, pathname, rootDir) {
  const rootResolved = path.resolve(rootDir);
  const decoded = decodeURIComponent(pathname);
  const target = path.resolve(rootResolved, '.' + decoded);
  if (target !== rootResolved && !target.startsWith(rootResolved + path.sep)) {
    send(res, 403, 'forbidden');
    return;
  }
  let stat;
  try {
    stat = await fsp.stat(target);
  } catch {
    send(res, 404, 'not found');
    return;
  }
  if (stat.isDirectory()) {
    send(res, 404, 'not found');
    return;
  }
  const ext = path.extname(target).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(target).pipe(res);
}

/* ------------------------------ 用户与会话 ------------------------------ */

let users = { version: 1, users: [] };
let sessionSecret = '';
/** 退出登录后把这张 cookie 作废（内存里记一份，重启后自然清空） */
const revokedSessions = new Map();

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), String(salt), 64).toString('hex');
}

function safeEqualHex(a, b) {
  const bufA = Buffer.from(String(a), 'hex');
  const bufB = Buffer.from(String(b), 'hex');
  if (!bufA.length || bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function findUserByName(name) {
  const key = String(name || '').trim().toLowerCase();
  return users.users.find((item) => item.name.toLowerCase() === key) || null;
}

function findUserById(id) {
  return users.users.find((item) => item.id === id) || null;
}

/** 一个账号都没有 = 全新安装，先让用户建管理者账号 */
function needsSetup() {
  return users.users.length === 0;
}

function isAdmin(user) {
  return Boolean(user && user.role === 'admin');
}

/** 老版本没有角色字段：把最早建的账号补成管理员，免得升级后没人能改设置 */
function ensureAdmin() {
  if (!users.users.length) return false;
  if (users.users.some((item) => item.role === 'admin')) return false;
  const oldest = users.users
    .slice()
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))[0];
  oldest.role = 'admin';
  return true;
}

async function loadUsers() {
  try {
    const parsed = JSON.parse(await fsp.readFile(USERS_FILE, 'utf8'));
    users = { version: 1, users: Array.isArray(parsed.users) ? parsed.users : [] };
  } catch {
    users = { version: 1, users: [] };
  }
  try {
    sessionSecret = (await fsp.readFile(SECRET_FILE, 'utf8')).trim();
  } catch {
    sessionSecret = '';
  }
  if (sessionSecret.length < 32) {
    sessionSecret = crypto.randomBytes(32).toString('hex');
    await fsp.writeFile(SECRET_FILE, sessionSecret, 'utf8').catch(() => {});
  }
}

function saveUsers() {
  writeChain = writeChain
    .then(() => fsp.writeFile(USERS_FILE, JSON.stringify(users, null, 2), 'utf8'))
    .catch((err) => console.error('[users] 写入失败', err));
  return writeChain;
}

/** 会话是自签名的：cookie 里只有 userId 和过期时间，重启服务也不会掉登录 */
function signSession(userId) {
  const body = Buffer.from(JSON.stringify({ u: userId, exp: Date.now() + SESSION_TTL_MS })).toString('base64url');
  const mac = crypto.createHmac('sha256', sessionSecret).update(body).digest('base64url');
  return body + '.' + mac;
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

function userFromRequest(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  if (revokedSessions.has(token)) {
    if (revokedSessions.get(token) < Date.now()) revokedSessions.delete(token);
    else return null;
  }
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expect = crypto.createHmac('sha256', sessionSecret).update(body).digest('base64url');
  if (mac.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  let payload = null;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || !payload.u || !Number.isFinite(payload.exp) || payload.exp < Date.now()) return null;
  return findUserById(payload.u);
}

function sessionCookie(token) {
  const path = config.basePath || '/';
  return `${SESSION_COOKIE}=${token}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(
    SESSION_TTL_MS / 1000
  )}`;
}

function clearCookie() {
  return `${SESSION_COOKIE}=; Path=${config.basePath || '/'}; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function publicUser(user) {
  if (!user) return null;
  return { id: user.id, name: user.name, role: user.role === 'admin' ? 'admin' : 'user' };
}

function validateCredentials(name, password) {
  const cleanName = String(name == null ? '' : name).trim();
  const cleanPass = String(password == null ? '' : password);
  if (cleanName.length < 2 || cleanName.length > 20) return { error: '用户名请用 2-20 个字' };
  if (!/^[\w\u4e00-\u9fa5.@-]+$/.test(cleanName)) return { error: '用户名只能用中文、字母、数字、_ . @ -' };
  if (cleanPass.length < 4 || cleanPass.length > 64) return { error: '密码请用 4-64 位' };
  return { name: cleanName, password: cleanPass };
}

const loginFails = new Map();

function loginAllowed(ip) {
  const now = Date.now();
  const list = (loginFails.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  loginFails.set(ip, list);
  return list.length < 12;
}

function noteLoginFail(ip) {
  const list = loginFails.get(ip) || [];
  list.push(Date.now());
  loginFails.set(ip, list);
}

/* ------------------------------ 模型调用 ------------------------------ */

const SYSTEM_PROMPT = `你是一位资深的中文摄影评论者，给中文读者写照片点评。风格：直接、具体、不说客套话，像一个懂行的朋友当面讲。

工作要求：
1. 先判断题材（人像 / 风光 / 街拍纪实 / 静物 / 建筑 / 漫展Cosplay 等），按题材挑选最相关的 5 个维度评分。
   人像常用：用光、构图取景、色彩、人物表现、技术质量；
   风光常用：用光、构图、色彩、氛围与内容、技术质量；
   街拍常用：内容与瞬间、构图、光影、色彩、技术质量。
2. 每个维度 0-10 分，允许半档。给分要有依据，必须引用画面里真实存在的具体元素（位置、颜色、形状、人物动作），不许写"整体不错"这类空话。
3. 总分 0-100 的整数，尺度要严：60 分以下是明显缺陷，60-69 是能看但有硬伤，70-79 是完成度不错，80-89 是有想法且执行到位，90 以上是接近发表水准。不要普遍给高分，也不要为了显得严格而故意压低。
4. "suggestions" 必须是可执行的：具体到机位、光线、焦段、参数、后期动作，每条一句话，不要写"多练习""多思考"。
5. 如果提供了拍摄参数（EXIF），必须在技术质量这一项或 "params" 里讨论：快门/光圈/ISO 是否浪费、是否与场景匹配、曝光补偿是否合理。
6. 绝不臆造画面里没有的东西；看不清就说看不清。不要识别或猜测真人的身份、姓名。
7. 全部用简体中文，不要用英文单词（相机参数除外）。

输出格式：只输出一个 JSON 对象，不要任何解释、不要 markdown 代码块，结构如下：
{
  "genre": "题材，2-4 个字",
  "total": 76,
  "headline": "一句话总评，不超过 40 字",
  "dimensions": [{"name": "维度名", "score": 7.5, "comment": "1-2 句具体依据"}],
  "strengths": ["优点，2-3 条，每条一句话"],
  "weaknesses": ["问题，2-3 条，每条一句话"],
  "suggestions": ["可执行的改进，3 条，每条一句话"],
  "params": "对拍摄参数的点评，1-3 句；没有参数就填空字符串"
}
dimensions 必须正好 5 条。`;

/** 追加在提示词末尾的格式硬要求：模型最爱在字符串里塞英文双引号，这会让 JSON 直接废掉 */
const FORMAT_RULES = `格式硬要求（违反会导致整份点评作废）：
1. 只输出一个 JSON 对象，前后不要有任何解释文字，不要 markdown 代码块，不要注释，不要尾随逗号。
2. JSON 字符串内部绝对不要再出现英文双引号 "（它只能用来包裹键和值）。需要强调某个词时，用中文引号「」或者直接不加引号。
3. 字符串里不要换行；要断句就用中文标点。
4. 所有键必须齐全：genre、total、headline、dimensions（正好 5 条）、strengths、weaknesses、suggestions、params。
5. 数值不要带单位、不要写成字符串。`;

function buildUserText({ exifText, note, title, width, height }) {
  const lines = ['请点评这张照片。'];
  if (title) lines.push('拍摄者给它的标题：' + title);
  if (note) lines.push('拍摄者的补充说明：' + note);
  if (width && height) lines.push(`图片尺寸：${width} × ${height}`);
  if (exifText) lines.push('拍摄参数（EXIF）：' + exifText);
  else lines.push('这张照片没有可用的 EXIF 参数，params 留空字符串。');
  lines.push('记住：只输出 JSON 对象。');
  return lines.join('\n');
}

function extractText(data) {
  if (typeof data.output_text === 'string' && data.output_text.trim()) return data.output_text.trim();
  const parts = [];
  for (const item of Array.isArray(data.output) ? data.output : []) {
    if (item && item.type === 'message') {
      for (const chunk of Array.isArray(item.content) ? item.content : []) {
        if (chunk && chunk.type === 'output_text' && typeof chunk.text === 'string') parts.push(chunk.text);
        else if (chunk && typeof chunk.text === 'string' && chunk.type !== 'reasoning_text') parts.push(chunk.text);
      }
    } else if (item && item.type === 'text' && typeof item.text === 'string') {
      parts.push(item.text);
    }
  }
  return parts.join('\n').trim();
}

/** 取下一个有意义的字符，用来判断一个引号到底是「字符串结束」还是「文本里的引号」 */
function nextMeaningful(text, from) {
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') continue;
    return ch;
  }
  return '';
}

/** 从模型输出里抠出可能的 JSON 片段（含 ``` 代码块、前后带解释文字的情况） */
function jsonCandidates(text) {
  const raw = String(text == null ? '' : text).trim();
  const out = [];
  if (!raw) return out;
  const blocks = [raw, ...raw.split('```')];
  for (const block of blocks) {
    const trimmed = block.trim().replace(/^json\s*/i, '');
    const start = trimmed.indexOf('{');
    if (start < 0) continue;
    const end = trimmed.lastIndexOf('}');
    if (end > start) out.push(trimmed.slice(start, end + 1));
    out.push(trimmed.slice(start));
  }
  return out;
}

/**
 * 语法修复：模型最常见的两种破坏是
 *   1) 在字符串内部又写了英文双引号（"形成"记录者"的层次"）—— 把内层引号转义掉；
 *   2) 尾随逗号、字符串里带换行 / 控制字符、括号没闭合。
 * 只修语法，不动内容。
 */
function repairJsonText(input) {
  const text = String(input == null ? '' : input).replace(/^[\uFEFF]+/, '');
  const stack = [];
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        out += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        const next = nextMeaningful(text, i + 1);
        if (next === '' || next === ',' || next === '}' || next === ']' || next === ':') {
          out += '"';
          inString = false;
        } else {
          out += '\\"';
        }
        continue;
      }
      if (ch === '\n') {
        out += '\\n';
        continue;
      }
      if (ch === '\r' || ch === '\t') continue;
      if (ch.charCodeAt(0) < 0x20) continue;
      out += ch;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '{' || ch === '[') {
      stack.push(ch);
      out += ch;
      continue;
    }
    if (ch === '}' || ch === ']') {
      out = out.replace(/,\s*$/, '');
      stack.pop();
      out += ch;
      continue;
    }
    out += ch;
  }
  if (inString) out += '"';
  while (stack.length) {
    const open = stack.pop();
    out = out.replace(/,\s*$/, '');
    out += open === '{' ? '}' : ']';
  }
  return out.replace(/,\s*([}\]])/g, '$1');
}

/** 先严格解析，失败再走语法修复；返回解析结果和用了哪种方式 */
function parseModelJson(text) {
  const errors = [];
  for (const candidate of jsonCandidates(text)) {
    try {
      return { value: JSON.parse(candidate), mode: 'strict', errors };
    } catch (err) {
      errors.push('严格解析：' + err.message);
    }
    try {
      return { value: JSON.parse(repairJsonText(candidate)), mode: 'repaired', errors };
    } catch (err) {
      errors.push('修复解析：' + err.message);
    }
  }
  return { value: null, mode: 'failed', errors };
}

/**
 * 格式校验：点评能不能正常显示，全看这一步。
 * fatal  = 缺内容，前端没法排版，必须重试或标记格式异常；
 * warnings = 能显示，但不符合约定的细节（比如维度不是 5 条）。
 */
function validateResult(parsed) {
  const fatal = [];
  const warnings = [];
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, fatal: ['模型返回的不是一个 JSON 对象'], warnings };
  }
  const total = Number(parsed.total);
  if (!Number.isFinite(total) || total < 0 || total > 100) fatal.push('total 不是 0-100 的数字');
  if (!textOf(parsed.headline, 140)) fatal.push('缺少 headline 总评');
  const dims = Array.isArray(parsed.dimensions) ? parsed.dimensions : null;
  if (!dims) {
    fatal.push('缺少 dimensions 数组');
  } else {
    if (!dims.length) fatal.push('dimensions 是空的');
    else if (dims.length !== 5) warnings.push(`dimensions 是 ${dims.length} 条，约定是 5 条`);
    dims.forEach((item, index) => {
      if (!item || typeof item !== 'object') {
        fatal.push(`第 ${index + 1} 个维度不是对象`);
        return;
      }
      if (!textOf(item.name, 14)) fatal.push(`第 ${index + 1} 个维度缺少名称`);
      const score = Number(item.score);
      if (!Number.isFinite(score) || score < 0 || score > 10) {
        fatal.push(`第 ${index + 1} 个维度的分数不是 0-10`);
      }
      if (!textOf(item.comment, 400)) warnings.push(`第 ${index + 1} 个维度没有评语`);
    });
  }
  for (const key of ['strengths', 'weaknesses', 'suggestions']) {
    const list = Array.isArray(parsed[key]) ? parsed[key].map((item) => textOf(item, 300)).filter(Boolean) : [];
    if (!list.length) fatal.push(`${key} 是空的`);
  }
  return { ok: fatal.length === 0, fatal, warnings };
}

function clampScore(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.round(Math.max(0, Math.min(10, num)) * 2) / 2;
}

function textOf(value, max = 600) {
  return String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function listOf(value, max, limit) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => textOf(item, max))
    .filter(Boolean)
    .slice(0, limit);
}

function normalizeResult({ parsed, rawText, mode = 'strict', fatal = [], warnings = [], attempts = 1, log = [] }) {
  const issues = [...fatal, ...warnings].map((item) => textOf(item, 120)).filter(Boolean);
  const format = {
    ok: Boolean(parsed) && fatal.length === 0,
    mode,
    attempts,
    issues: issues.slice(0, 8),
    log: log.slice(0, MAX_FORMAT_ATTEMPTS),
    checkedAt: new Date().toISOString(),
  };
  const raw = String(rawText == null ? '' : rawText).slice(0, 4000);
  if (!format.ok || !parsed) {
    return {
      genre: '',
      total: null,
      headline: '模型这次没有按格式返回，下面是原始输出（已完整保存在服务端便于排查）。',
      dimensions: [],
      strengths: [],
      weaknesses: [],
      suggestions: [],
      params: '',
      raw,
      degraded: true,
      format,
    };
  }
  const dimensions = (Array.isArray(parsed.dimensions) ? parsed.dimensions : [])
    .map((item) => ({
      name: textOf(item && item.name, 14),
      score: clampScore(item && item.score),
      comment: textOf(item && item.comment, 400),
    }))
    .filter((item) => item.name || item.comment)
    .slice(0, 6);
  const totalRaw = Number(parsed.total);
  const total = Number.isFinite(totalRaw) ? Math.max(0, Math.min(100, Math.round(totalRaw))) : null;
  return {
    genre: textOf(parsed.genre, 14),
    total,
    headline: textOf(parsed.headline, 140),
    dimensions,
    strengths: listOf(parsed.strengths, 300, 4),
    weaknesses: listOf(parsed.weaknesses, 300, 4),
    suggestions: listOf(parsed.suggestions, 300, 5),
    params: textOf(parsed.params, 800),
    raw: mode === 'repaired' ? raw : '',
    degraded: false,
    format,
  };
}

/** 把格式失败的原样输出落到 data/error.log，方便事后排查（预留报错） */
function logFormatError({ firstRawText, lastRawText, fatal, warnings, attempts, model }) {
  const entry = {
    at: new Date().toISOString(),
    model: model || apiModel(),
    attempts,
    fatal,
    warnings,
    raw: String(firstRawText || lastRawText || '').slice(0, 20000),
  };
  fsp
    .appendFile(ERROR_LOG_FILE, JSON.stringify(entry) + '\n', 'utf8')
    .catch((err) => console.error('[log] 写 error.log 失败', err && err.message));
}

/* ------------------------------ 各家接口的差异 ------------------------------ */

function joinUrl(base, suffix) {
  return String(base || '').replace(/\/+$/, '') + suffix;
}

function chatUrl(base) {
  const clean = String(base || '').replace(/\/+$/, '');
  return /\/chat\/completions$/.test(clean) ? clean : clean + '/chat/completions';
}

function anthropicUrl(base) {
  const clean = String(base || '').replace(/\/+$/, '');
  if (/\/messages$/.test(clean)) return clean;
  return (clean.endsWith('/v1') ? clean : clean + '/v1') + '/messages';
}

function geminiUrl(base, model) {
  const clean = String(base || '').replace(/\/+$/, '');
  if (/:generateContent$/.test(clean)) return clean;
  return clean + '/models/' + encodeURIComponent(model) + ':generateContent';
}

/** data:image/jpeg;base64,xxxx → { mediaType, data }，Anthropic / Gemini 要分开传 */
function splitDataUrl(dataUrl) {
  const match = /^data:([^;]+);base64,(.+)$/.exec(String(dataUrl || ''));
  return match ? { mediaType: match[1], data: match[2] } : null;
}

/** 各家返回体的取文方式 */
function extractProviderText(kind, data) {
  if (kind === 'openai-responses') return extractText(data);
  if (kind === 'openai-chat') {
    const message = data && data.choices && data.choices[0] && data.choices[0].message;
    if (!message) return '';
    if (typeof message.content === 'string') return message.content.trim();
    if (Array.isArray(message.content)) {
      return message.content
        .map((part) => (typeof part === 'string' ? part : part && typeof part.text === 'string' ? part.text : ''))
        .join('\n')
        .trim();
    }
    return '';
  }
  if (kind === 'anthropic') {
    const blocks = (data && data.content) || [];
    return blocks
      .filter((block) => block && block.type === 'text')
      .map((block) => block.text || '')
      .join('\n')
      .trim();
  }
  if (kind === 'gemini') {
    const candidate = data && data.candidates && data.candidates[0];
    const parts = (candidate && candidate.content && candidate.content.parts) || [];
    return parts
      .filter((part) => part && typeof part.text === 'string' && !part.thought)
      .map((part) => part.text)
      .join('\n')
      .trim();
  }
  return '';
}

function providerError(kind, data) {
  if (!data) return '';
  const error = data.error;
  if (error) return typeof error === 'string' ? error : error.message || JSON.stringify(error).slice(0, 200);
  if (kind === 'gemini' && data.promptFeedback && data.promptFeedback.blockReason) {
    return '请求被拦下了：' + data.promptFeedback.blockReason;
  }
  return '';
}

/**
 * 按服务商类型发一次请求，返回纯文本。
 * kind: openai-responses（DeepSeek）/ openai-chat（GPT、GLM、Qwen、Kimi、自定义）/ anthropic（Claude）/ gemini
 */
async function requestProvider({ provider, prompt, image, maxTokens, timeoutMs, key }) {
  const token = key || apiKey();
  if (!token) {
    throw Object.assign(new Error('站点还没有配置 API Key，请让管理员在「设置」里填写'), { status: 500 });
  }
  const parts = splitDataUrl(image);
  let url = '';
  const headers = { 'Content-Type': 'application/json' };
  let body = null;

  if (provider.kind === 'openai-responses') {
    const content = [{ type: 'input_text', text: prompt }];
    if (image) content.push({ type: 'input_image', image_url: image });
    url = joinUrl(provider.baseUrl, '/responses');
    headers.Authorization = 'Bearer ' + token;
    body = { model: provider.model, input: [{ role: 'user', content }], max_output_tokens: maxTokens };
  } else if (provider.kind === 'anthropic') {
    const content = [];
    if (parts) content.push({ type: 'image', source: { type: 'base64', media_type: parts.mediaType, data: parts.data } });
    content.push({ type: 'text', text: prompt });
    url = anthropicUrl(provider.baseUrl);
    headers['x-api-key'] = token;
    headers['anthropic-version'] = '2023-06-01';
    body = { model: provider.model, max_tokens: maxTokens, messages: [{ role: 'user', content }] };
  } else if (provider.kind === 'gemini') {
    const geminiParts = [];
    if (parts) geminiParts.push({ inline_data: { mime_type: parts.mediaType, data: parts.data } });
    geminiParts.push({ text: prompt });
    url = geminiUrl(provider.baseUrl, provider.model);
    headers['x-goog-api-key'] = token;
    body = {
      contents: [{ role: 'user', parts: geminiParts }],
      generationConfig: { maxOutputTokens: maxTokens },
    };
  } else {
    const content = [{ type: 'text', text: prompt }];
    if (image) content.push({ type: 'image_url', image_url: { url: image } });
    url = chatUrl(provider.baseUrl);
    headers.Authorization = 'Bearer ' + token;
    body = { model: provider.model, messages: [{ role: 'user', content }], max_tokens: maxTokens };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || config.api.timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      const hint = response.status === 404 ? '（模型名可能已经更新，去「设置」点「拉取列表」看看当前可用的）' : '';
      throw Object.assign(new Error(`${provider.label} 接口返回 ${response.status}${hint}：${text.slice(0, 300)}`), {
        status: 502,
      });
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw Object.assign(new Error(`${provider.label} 接口返回了非 JSON 内容`), { status: 502 });
    }
    const message = providerError(provider.kind, data);
    if (message) throw Object.assign(new Error(`${provider.label} 报错：${message}`), { status: 502 });
    const output = extractProviderText(provider.kind, data);
    if (!output) throw Object.assign(new Error(`${provider.label} 没有返回内容`), { status: 502 });
    return output;
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw Object.assign(new Error(`${provider.label} 接口超时`), { status: 504 });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function callModel({ dataUrl, prompt }) {
  const provider = currentProvider();
  const maxTokens = provider.kind === 'gemini' ? 16000 : 8000;
  return requestProvider({ provider, prompt, image: dataUrl, maxTokens });
}

/**
 * 点评主流程：出图 → 拿 JSON → 校验格式 → 不合格就重试 → 再不合格就做一次语法修复 → 都不行则保留原文并记录报错。
 * 返回的对象里 format 字段记录了每次尝试的结果，前端据此显示「格式已修复 / 格式异常」。
 */
async function reviewImage({ dataUrl, userText }) {
  const basePrompt = SYSTEM_PROMPT + '\n\n---\n\n' + FORMAT_RULES + '\n\n---\n\n' + userText;
  const attemptLog = [];
  let firstRawText = '';
  let last = { rawText: '', fatal: ['模型没有返回内容'], warnings: [] };

  for (let round = 1; round <= MAX_FORMAT_ATTEMPTS; round += 1) {
    let rawText = '';
    if (round === 1) {
      rawText = await callModel({ dataUrl, prompt: basePrompt });
      firstRawText = rawText;
    } else if (round === 2) {
      const reason = last.fatal.length ? last.fatal.join('；') : '不是合法 JSON';
      rawText = await callModel({
        dataUrl,
        prompt: basePrompt + `\n\n---\n\n上一次输出没有通过格式校验（${reason}）。请重新点评一次，并严格按要求输出 JSON。`,
      });
    } else {
      const source = firstRawText || last.rawText;
      if (!source) break;
      rawText = await callModel({
        dataUrl: null,
        prompt:
          `下面是一段模型输出，内容和结构应当保留，但 JSON 语法有问题（${(last.fatal || []).join('；') || '语法错误'}）。\n` +
          `请只把它整理成一个合法的 JSON 对象：措辞、分数、条目都不要改，只修语法。不要输出解释，不要 markdown 代码块。\n\n---\n\n` +
          source.slice(0, 8000),
      });
    }

    const parsed = parseModelJson(rawText);
    const checked = validateResult(parsed.value);
    last = { rawText, fatal: checked.fatal, warnings: checked.warnings };
    attemptLog.push({
      round,
      mode: parsed.mode,
      ok: checked.ok,
      issues: [...checked.fatal, ...checked.warnings].slice(0, 5),
      parseErrors: parsed.mode === 'failed' ? parsed.errors.slice(0, 2) : [],
    });
    if (checked.ok) {
      console.log(`[dp] 格式校验通过（第 ${round} 次，${parsed.mode}）`);
      return normalizeResult({
        parsed: parsed.value,
        rawText,
        mode: parsed.mode,
        warnings: checked.warnings,
        attempts: round,
        log: attemptLog,
      });
    }
    console.warn(`[dp] 第 ${round} 次输出未通过格式校验：${[...checked.fatal, ...checked.warnings].join('；').slice(0, 200)}`);
  }

  logFormatError({
    firstRawText,
    lastRawText: last.rawText,
    fatal: last.fatal,
    warnings: last.warnings,
    attempts: attemptLog.length,
  });
  return normalizeResult({
    parsed: null,
    rawText: firstRawText || last.rawText,
    mode: 'failed',
    fatal: last.fatal.length ? last.fatal : ['模型没有返回可用的 JSON'],
    warnings: last.warnings,
    attempts: attemptLog.length,
    log: attemptLog,
  });
}

/* 服务商的「模型列表」接口：设置页用它拉当前账号真正可用的模型名，避免预设过时 */
function modelsUrl(provider) {
  const base = String(provider.baseUrl || '').replace(/\/+$/, '');
  if (provider.kind === 'anthropic') return (base.endsWith('/v1') ? base : base + '/v1') + '/models?limit=100';
  if (provider.kind === 'gemini') return base + '/models?pageSize=200';
  return base.replace(/\/chat\/completions$/, '') + '/models';
}

function listAuthHeaders(provider, token) {
  if (provider.kind === 'anthropic') return { 'x-api-key': token, 'anthropic-version': '2023-06-01' };
  if (provider.kind === 'gemini') return { 'x-goog-api-key': token };
  return { Authorization: 'Bearer ' + token };
}

function extractModelIds(kind, data) {
  if (!data) return [];
  if (kind === 'gemini') {
    return (data.models || [])
      .map((item) => String((item && item.name) || '').replace(/^models\//, ''))
      .filter(Boolean);
  }
  const list = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
  return list.map((item) => String((item && (item.id || item.name)) || '')).filter(Boolean);
}

async function fetchProviderModels(provider, key) {
  const token = key || apiKey();
  if (!token) throw Object.assign(new Error('还没有填 API Key'), { status: 400 });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(modelsUrl(provider), {
      headers: listAuthHeaders(provider, token),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw Object.assign(new Error(`${provider.label} 返回 ${response.status}：${text.slice(0, 200)}`), {
        status: 502,
      });
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw Object.assign(new Error(`${provider.label} 返回了非 JSON 内容`), { status: 502 });
    }
    const message = providerError(provider.kind, data);
    if (message) throw Object.assign(new Error(`${provider.label} 报错：${message}`), { status: 502 });
    const ids = [...new Set(extractModelIds(provider.kind, data))].sort((a, b) => a.localeCompare(b));
    if (!ids.length) throw Object.assign(new Error(`${provider.label} 没有返回模型列表`), { status: 502 });
    return ids.slice(0, 300);
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw Object.assign(new Error(`${provider.label} 拉取模型列表超时`), { status: 504 });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** 设置页里「表单上还没保存的值」→ 一个可用的服务商对象，测试连接和拉取列表都用它 */
function resolveProviderTarget(body) {
  const current = currentProvider();
  const id = normalizeProviderId(body.provider) || current.id;
  const preset = PROVIDERS.find((item) => item.id === id);
  const baseRaw = String(body.baseUrl || '').trim();
  const baseUrl = baseRaw ? normalizeApiBaseUrl(baseRaw) : id === current.id ? current.baseUrl : preset.baseUrl;
  if (baseRaw && !baseUrl) return { error: '接口地址要写成 https://api.openai.com/v1 这种形式' };
  return {
    provider: {
      ...preset,
      id,
      model: textOf(body.model, 80) || (id === current.id ? current.model : preset.model),
      baseUrl,
    },
    key: body.apiKey ? String(body.apiKey).trim() : '',
  };
}

/**
 * 设置页的「测试连接」：用最短的请求确认服务商 / key / 模型 / 地址配得对不对。
 * target 可以带页面上还没保存的值；keyOverride 用于刚粘贴、还没保存的 key。
 */
async function testModelKey(target, keyOverride) {
  const provider = target || currentProvider();
  const sample = await requestProvider({
    provider,
    prompt: '只回复两个字：可用',
    image: null,
    maxTokens: provider.kind === 'gemini' ? 4096 : 256,
    timeoutMs: 25000,
    key: keyOverride || '',
  });
  return sample.slice(0, 60);
}

/* ------------------------------ API ------------------------------ */

function publicRecord(record) {
  return {
    ...record,
    image: record.image ? withBase(record.image) : '',
  };
}

function myReviews(user) {
  // 只看自己的档案；没有归属的老记录不显示给任何账号（会被 /api/health 的 orphan 计数报出来）
  return db.reviews.filter((item) => item.ownerId && item.ownerId === user.id);
}

function extMime(file) {
  const ext = path.extname(String(file || '')).toLowerCase();
  return ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
}

async function api(req, res, { pathname, user }) {
  const ip = clientIp(req);

  if (pathname === '/api/health' && req.method === 'GET') {
    sendJson(res, 200, {
      ok: true,
      model: apiModel(),
      hasKey: hasKey(),
      basePath: config.basePath,
      count: db.reviews.length,
      users: users.users.length,
      initialized: !needsSetup(),
      orphan: db.reviews.filter((item) => !item.ownerId).length,
      limits: {
        perSecond: config.limits.perSecond,
        staticPerSecond: config.limits.staticPerSecond,
        perHour: config.limits.perHour,
        perDay: config.limits.perDay,
      },
    });
    return;
  }

  if (pathname === '/api/me' && req.method === 'GET') {
    sendJson(res, 200, { user: publicUser(user) });
    return;
  }

  /** 前端启动时先问这个：要不要进「首次设置」，以及 key 配好了没有 */
  if (pathname === '/api/setup' && req.method === 'GET') {
    const setup = needsSetup();
    sendJson(res, 200, {
      needsSetup: setup,
      hasKey: hasKey(),
      model: setup ? apiModel() : '',
      baseUrl: setup ? apiBaseUrl() : '',
      provider: setup ? currentProvider().id : '',
      providers: setup ? providerPresets() : [],
    });
    return;
  }

  /** 首次设置：建管理者账号 + 可选地直接填 API Key，成功后自动登录 */
  if (pathname === '/api/setup' && req.method === 'POST') {
    if (!needsSetup()) {
      sendJson(res, 409, { error: '站点已经初始化过了，直接登录就行' });
      return;
    }
    if (!loginAllowed(ip)) {
      sendJson(res, 429, { error: '尝试太频繁，过几分钟再试' });
      return;
    }
    const body = await readJsonBody(req, 256 * 1024);
    const checked = validateCredentials(body.name, body.password);
    if (checked.error) {
      sendJson(res, 400, { error: checked.error });
      return;
    }
    if (findUserByName(checked.name)) {
      sendJson(res, 409, { error: '这个用户名已经有人用了，换一个' });
      return;
    }
    const keyInput = textOf(body.apiKey, 400);
    const modelInput = textOf(body.model, 80);
    const baseUrlInput = normalizeApiBaseUrl(body.baseUrl);
    const providerInput = normalizeProviderId(body.provider);
    if (body.provider && !providerInput) {
      sendJson(res, 400, { error: '不认识这个模型服务商' });
      return;
    }
    if (body.baseUrl && String(body.baseUrl).trim() && !baseUrlInput) {
      sendJson(res, 400, { error: '接口地址要写成 https://api.openai.com/v1 这种形式' });
      return;
    }

    const salt = crypto.randomBytes(16).toString('hex');
    const record = {
      id: newId('usr'),
      name: checked.name,
      role: 'admin',
      salt,
      hash: hashPassword(checked.password, salt),
      createdAt: new Date().toISOString(),
      lastLoginAt: new Date().toISOString(),
    };
    users.users.push(record);
    await saveUsers();

    if (keyInput) secrets.apiKey = keyInput;
    if (providerInput) secrets.provider = providerInput;
    if (modelInput) secrets.model = modelInput;
    if (baseUrlInput) secrets.baseUrl = baseUrlInput;
    if (keyInput || modelInput || baseUrlInput || providerInput) {
      secrets.updatedAt = new Date().toISOString();
      await saveSecrets();
    }

    res.setHeader('Set-Cookie', sessionCookie(signSession(record.id)));
    sendJson(res, 200, { user: publicUser(record), hasKey: hasKey() });
    return;
  }

  if (pathname === '/api/register' && req.method === 'POST') {
    if (needsSetup()) {
      sendJson(res, 409, { error: '站点还没有初始化，请先创建管理者账号', setupRequired: true });
      return;
    }
    if (!loginAllowed(ip)) {
      sendJson(res, 429, { error: '尝试太频繁，过几分钟再试' });
      return;
    }
    const body = await readJsonBody(req, 64 * 1024);
    const checked = validateCredentials(body.name, body.password);
    if (checked.error) {
      sendJson(res, 400, { error: checked.error });
      return;
    }
    if (findUserByName(checked.name)) {
      noteLoginFail(ip);
      sendJson(res, 409, { error: '这个用户名已经有人用了，换一个' });
      return;
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const record = {
      id: newId('usr'),
      name: checked.name,
      salt,
      hash: hashPassword(checked.password, salt),
      createdAt: new Date().toISOString(),
      lastLoginAt: new Date().toISOString(),
    };
    users.users.push(record);
    await saveUsers();
    res.setHeader('Set-Cookie', sessionCookie(signSession(record.id)));
    sendJson(res, 200, { user: publicUser(record) });
    return;
  }

  if (pathname === '/api/login' && req.method === 'POST') {
    if (!loginAllowed(ip)) {
      sendJson(res, 429, { error: '尝试太频繁，过几分钟再试' });
      return;
    }
    const body = await readJsonBody(req, 64 * 1024);
    const name = String(body.name == null ? '' : body.name).trim();
    const password = String(body.password == null ? '' : body.password);
    const found = findUserByName(name);
    if (!found || !safeEqualHex(hashPassword(password, found.salt), found.hash)) {
      noteLoginFail(ip);
      sendJson(res, 401, { error: '用户名或密码不对' });
      return;
    }
    found.lastLoginAt = new Date().toISOString();
    await saveUsers();
    res.setHeader('Set-Cookie', sessionCookie(signSession(found.id)));
    sendJson(res, 200, { user: publicUser(found) });
    return;
  }

  if (pathname === '/api/logout' && req.method === 'POST') {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (token) {
      if (revokedSessions.size > 500) {
        const now = Date.now();
        for (const [key, exp] of revokedSessions) if (exp < now) revokedSessions.delete(key);
      }
      revokedSessions.set(token, Date.now() + SESSION_TTL_MS);
    }
    res.setHeader('Set-Cookie', clearCookie());
    sendJson(res, 200, { ok: true });
    return;
  }

  if (!user) {
    sendJson(res, 401, { error: '请先登录（或注册一个档案）' });
    return;
  }

  /** 管理者的站点设置：服务商 / API Key / 模型 / 接口地址。key 只回显后四位。 */
  if (pathname === '/api/settings' && req.method === 'GET') {
    if (!isAdmin(user)) {
      sendJson(res, 403, { error: '只有管理者能改这些设置' });
      return;
    }
    const provider = currentProvider();
    sendJson(res, 200, {
      provider: provider.id,
      providerLabel: provider.label,
      model: provider.model,
      baseUrl: provider.baseUrl,
      models: provider.models || [],
      providers: providerPresets(),
      hasKey: hasKey(),
      keyHint: keyHint(),
      updatedAt: secrets.updatedAt || '',
    });
    return;
  }

  if (pathname === '/api/settings' && req.method === 'POST') {
    if (!isAdmin(user)) {
      sendJson(res, 403, { error: '只有管理者能改这些设置' });
      return;
    }
    const body = await readJsonBody(req, 64 * 1024);
    const wantsClear = body.clearKey === true;
    const keyInput = body.apiKey === undefined ? '' : String(body.apiKey).trim();
    const modelInput = body.model === undefined ? null : textOf(body.model, 80);
    const baseUrlInput = body.baseUrl === undefined ? null : normalizeApiBaseUrl(body.baseUrl);
    const providerInput = body.provider === undefined ? null : normalizeProviderId(body.provider);
    if (keyInput && (keyInput.length < 8 || keyInput.length > 400)) {
      sendJson(res, 400, { error: '这个 API Key 看起来不对（长度 8-400）' });
      return;
    }
    if (body.provider !== undefined && !providerInput) {
      sendJson(res, 400, { error: '不认识这个模型服务商' });
      return;
    }
    if (baseUrlInput === null && String(body.baseUrl || '').trim()) {
      sendJson(res, 400, { error: '接口地址要写成 https://api.openai.com/v1 这种形式' });
      return;
    }
    if (wantsClear) secrets.apiKey = '';
    else if (keyInput) secrets.apiKey = keyInput;
    if (providerInput !== null && providerInput !== currentProvider().id) {
      // 换服务商时清掉旧的模型和地址，避免把上一家的配置带过去
      secrets.provider = providerInput;
      secrets.model = '';
      secrets.baseUrl = '';
    } else if (providerInput !== null) {
      secrets.provider = providerInput;
    }
    if (modelInput !== null) secrets.model = modelInput;
    if (baseUrlInput !== null) secrets.baseUrl = baseUrlInput;
    secrets.updatedAt = new Date().toISOString();
    await saveSecrets();
    const provider = currentProvider();
    sendJson(res, 200, {
      provider: provider.id,
      providerLabel: provider.label,
      model: provider.model,
      baseUrl: provider.baseUrl,
      models: provider.models || [],
      hasKey: hasKey(),
      keyHint: keyHint(),
      updatedAt: secrets.updatedAt,
    });
    return;
  }

  if ((pathname === '/api/settings/test' || pathname === '/api/settings/models') && req.method === 'POST') {
    const wantModels = pathname === '/api/settings/models';
    if (!isAdmin(user)) {
      sendJson(res, 403, { error: wantModels ? '只有管理者能拉取模型列表' : '只有管理者能测试接口' });
      return;
    }
    const body = await readJsonBody(req, 64 * 1024);
    const resolved = resolveProviderTarget(body);
    if (resolved.error) {
      sendJson(res, 400, { error: resolved.error });
      return;
    }
    const target = resolved.provider;
    const keyOverride = resolved.key;
    if (!keyOverride && !hasKey()) {
      sendJson(res, 400, { error: '还没有填 API Key' });
      return;
    }
    if (wantModels) {
      try {
        const models = await fetchProviderModels(target, keyOverride);
        sendJson(res, 200, { ok: true, models, count: models.length, provider: target.label, model: target.model });
      } catch (err) {
        sendJson(res, 502, { ok: false, error: (err && err.message) || '拉取失败' });
      }
      return;
    }
    const started = Date.now();
    try {
      const sample = await testModelKey(target, keyOverride);
      sendJson(res, 200, { ok: true, ms: Date.now() - started, sample, provider: target.label, model: target.model });
    } catch (err) {
      sendJson(res, 502, { ok: false, error: (err && err.message) || '测试失败' });
    }
    return;
  }

  if (pathname === '/api/data' && req.method === 'GET') {
    const mine = myReviews(user);
    const provider = currentProvider();
    sendJson(res, 200, {
      reviews: mine.slice().reverse().map(publicRecord),
      model: provider.model,
      provider: provider.id,
      providerLabel: provider.label,
      limits: {
        perSecond: config.limits.perSecond,
        staticPerSecond: config.limits.staticPerSecond,
        perHour: config.limits.perHour,
        perDay: config.limits.perDay,
      },
      hasKey: hasKey(),
      isAdmin: isAdmin(user),
      user: publicUser(user),
      total: mine.length,
    });
    return;
  }

  if (pathname === '/api/review' && req.method === 'POST') {
    if (!hasKey()) {
      sendJson(res, 500, { error: '站点还没有配置 API Key，请让管理员在「设置」里填写' });
      return;
    }
    const quota = reviewQuota(ip);
    if (!quota.ok) {
      if (quota.retryAfter) res.setHeader('Retry-After', String(quota.retryAfter));
      sendJson(res, 429, { error: quota.message });
      return;
    }
    const body = await readJsonBody(req);
    const dataUrl = String(body.image || '');
    const match = dataUrl.match(/^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
    if (!match) {
      sendJson(res, 400, { error: '图片格式不支持，请用 JPEG / PNG / WebP' });
      return;
    }
    const buffer = Buffer.from(match[2], 'base64');
    if (buffer.length > config.limits.maxImageBytes) {
      const mb = (buffer.length / 1048576).toFixed(1);
      const cap = (config.limits.maxImageBytes / 1048576).toFixed(1);
      sendJson(res, 413, { error: `图片太大了（${mb}MB），上限 ${cap}MB` });
      return;
    }
    const ext = match[1] === 'png' ? '.png' : match[1] === 'webp' ? '.webp' : '.jpg';
    const id = newId('rev');
    const fileName = id + ext;
    const filePath = path.join(MEDIA_DIR, fileName);
    await fsp.writeFile(filePath, buffer);

    let result;
    try {
      result = await reviewImage({
        dataUrl,
        userText: buildUserText({
          exifText: textOf(body.exifText, 400),
          note: textOf(body.note, 300),
          title: textOf(body.title, 80),
          width: Number(body.width) || null,
          height: Number(body.height) || null,
        }),
      });
    } catch (err) {
      await fsp.unlink(filePath).catch(() => {});
      throw err;
    }

    const record = {
      id,
      createdAt: new Date().toISOString(),
      ownerId: user.id,
      ownerName: user.name,
      title: textOf(body.title, 80),
      note: textOf(body.note, 300),
      image: '/media/' + fileName,
      bytes: buffer.length,
      width: Number(body.width) || null,
      height: Number(body.height) || null,
      exifText: textOf(body.exifText, 400),
      exif: body.exif && typeof body.exif === 'object' ? body.exif : null,
      provider: currentProvider().id,
      model: apiModel(),
      result,
    };
    db.reviews.push(record);
    await saveDb();
    sendJson(res, 200, { review: publicRecord(record) });
    return;
  }

  /** 格式异常时的一键重来：图片还在，直接重新走一遍「点评 + 格式校验」 */
  if (pathname.startsWith('/api/review/') && pathname.endsWith('/retry') && req.method === 'POST') {
    const id = decodeURIComponent(pathname.slice('/api/review/'.length, -'/retry'.length));
    const record = db.reviews.find((item) => item.id === id);
    if (!record) {
      sendJson(res, 404, { error: '没有这条点评' });
      return;
    }
    if (record.ownerId && record.ownerId !== user.id) {
      sendJson(res, 403, { error: '只能重新点评自己档案里的照片' });
      return;
    }
    if (!hasKey()) {
      sendJson(res, 500, { error: '站点还没有配置 API Key，请让管理员在「设置」里填写' });
      return;
    }
    const quota = reviewQuota(ip);
    if (!quota.ok) {
      if (quota.retryAfter) res.setHeader('Retry-After', String(quota.retryAfter));
      sendJson(res, 429, { error: quota.message });
      return;
    }
    const filePath = path.join(MEDIA_DIR, path.basename(String(record.image || '')));
    let buffer;
    try {
      buffer = await fsp.readFile(filePath);
    } catch {
      sendJson(res, 404, { error: '这条点评的图片已经不在了，没法重新点评' });
      return;
    }
    const dataUrl = `data:${extMime(filePath)};base64,${buffer.toString('base64')}`;
    record.result = await reviewImage({
      dataUrl,
      userText: buildUserText({
        exifText: record.exifText,
        note: record.note,
        title: record.title,
        width: record.width,
        height: record.height,
      }),
    });
    record.provider = currentProvider().id;
    record.model = apiModel();
    record.retriedAt = new Date().toISOString();
    await saveDb();
    sendJson(res, 200, { review: publicRecord(record) });
    return;
  }

  if (pathname.startsWith('/api/review/') && req.method === 'DELETE') {
    const id = decodeURIComponent(pathname.slice('/api/review/'.length));
    const index = db.reviews.findIndex((item) => item.id === id);
    if (index < 0) {
      sendJson(res, 404, { error: '没有这条点评' });
      return;
    }
    if (db.reviews[index].ownerId && db.reviews[index].ownerId !== user.id) {
      sendJson(res, 403, { error: '只能删除自己档案里的照片' });
      return;
    }
    const [removed] = db.reviews.splice(index, 1);
    if (removed.image) {
      await fsp.unlink(path.join(MEDIA_DIR, path.basename(removed.image))).catch(() => {});
    }
    await saveDb();
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}

/* ------------------------------ 入口 ------------------------------ */

const requestHandler = async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    let pathname = url.pathname;
    if (config.basePath) {
      if (pathname === config.basePath) {
        res.writeHead(302, { Location: config.basePath + '/' });
        res.end();
        return;
      }
      if (!pathname.startsWith(config.basePath + '/')) {
        send(res, 404, 'not found', { 'Content-Type': 'text/plain; charset=utf-8' });
        return;
      }
      pathname = pathname.slice(config.basePath.length);
    }

    if (pathname.startsWith('/api/')) {
      const gate = rateLimit(clientIp(req), 'api');
      if (!gate.ok) {
        res.setHeader('Retry-After', String(gate.retryAfter));
        sendJson(res, 429, { error: gate.message });
        return;
      }
      await api(req, res, { pathname, user: userFromRequest(req) });
      return;
    }

    const gate = rateLimit(clientIp(req), 'static');
    if (!gate.ok) {
      res.setHeader('Retry-After', String(gate.retryAfter));
      send(res, 429, '请求太快了', { 'Content-Type': 'text/plain; charset=utf-8' });
      return;
    }
    if (pathname.startsWith('/media/')) {
      await serveStatic(req, res, '/' + pathname.replace(/^\/media\//, ''), MEDIA_DIR);
      return;
    }
    await serveStatic(req, res, pathname === '/' ? '/index.html' : pathname, PUBLIC_DIR);
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    if (status >= 500) console.error('[error]', req.method, url.pathname, err && err.message);
    if (!res.headersSent) sendJson(res, status, { error: (err && err.message) || 'server error' });
    else res.destroy();
  }
};

loadSecrets()
  .then(() => migrateLegacyKey())
  .then(() => loadDb())
  .then(() => loadUsers())
  .then(async () => {
    if (ensureAdmin()) {
      await saveUsers();
      console.log('[setup] 已把最早创建的账号设为管理者');
    }
  })
  .then(() => repairStoredResults())
  .then(() => {
  const displayHost = config.host === '::' || config.host === '0.0.0.0' ? 'localhost' : config.host;
  const ports = [...new Set([config.port, ...config.ports])];
  const urlFor = (port) => `http://${displayHost}${port === 80 ? '' : ':' + port}${config.basePath}/`;
  console.log('照片点评 dp');
  console.log('路径前缀：' + (config.basePath || '(根路径)'));
  console.log('模型：' + currentProvider().label + ' · ' + apiModel() + (hasKey() ? '（已配置 key）' : '（还没填 key，打开网页按引导填）'));
  if (needsSetup()) {
    console.log('首次运行：打开网页会引导创建管理者账号并填 API Key');
  } else {
    console.log('档案账号：' + users.users.length + ' 个（用户名 + 密码，登录后只看得到自己档案里的点评）');
  }
  console.log('访问控制：站点口令已关闭，限频按 IP —— 接口 ' + config.limits.perSecond + ' 次/秒、静态资源 ' + config.limits.staticPerSecond + ' 次/秒');
  console.log('点评额度：每 IP 每小时 ' + config.limits.perHour + ' 张、每天 ' + config.limits.perDay + ' 张');
  console.log('格式校验：最多 ' + MAX_FORMAT_ATTEMPTS + ' 次尝试，失败留档在 data/error.log');
  const orphan = db.reviews.filter((item) => !item.ownerId).length;
  if (orphan) console.log('[db] 有 ' + orphan + ' 条没有归属的老点评，不会出现在任何账号的档案里');
  for (const port of ports) {
    const instance = http.createServer(requestHandler);
    instance.on('error', (err) => console.error(`端口 ${port} 启动失败：${err.message}`));
    instance.listen(port, config.host, () => {
      console.log('监听：' + urlFor(port));
      if (config.host === '::' || config.host === '0.0.0.0') {
        for (const items of Object.values(os.networkInterfaces())) {
          for (const item of items || []) {
            if (item.family === 'IPv6' && !item.internal && !item.address.startsWith('fe80')) {
              const shown = port === 80 ? '' : ':' + port;
              console.log('  外网：' + `http://[${item.address}]${shown}${config.basePath}/`);
            }
          }
        }
      }
    });
  }
  console.log('本地：' + urlFor(config.port));
  console.log('等待请求…');
});
