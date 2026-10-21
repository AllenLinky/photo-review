'use strict';

/* ============================ 状态 ============================ */

const state = {
  reviews: [],
  model: '',
  hasKey: true,
  busy: false,
  user: null,
  authMode: 'login', // 'login' | 'register'
  setup: null, // { needsSetup, hasKey, model, baseUrl }
  setupStep: 1, // 1 = 管理者账号，2 = API Key
  setupDraft: { name: '', password: '', provider: '', apiKey: '', model: '', baseUrl: '' },
  settings: null,
  picked: null, // { file, dataUrl, width, height, outW, outH, exifText, exif }
  startedAt: 0,
};

const $ = (sel, root = document) => root.querySelector(sel);

/* ============================ 小工具 ============================ */

function esc(text) {
  return String(text == null ? '' : text).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function fmtDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function bandColor(total) {
  if (total == null) return 'var(--dim)';
  if (total >= 85) return 'var(--ok)';
  if (total >= 75) return 'var(--accent)';
  if (total >= 65) return 'var(--warn)';
  return 'var(--danger)';
}

function toast(message, kind) {
  const box = $('#toasts');
  const node = document.createElement('div');
  node.className = 'toast' + (kind === 'err' ? ' err' : '');
  node.textContent = message;
  box.appendChild(node);
  setTimeout(() => {
    node.style.transition = 'opacity .3s';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 320);
  }, kind === 'err' ? 5200 : 2800);
}

/* ============================ EXIF ============================ */

function readAscii(view, offset, length) {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    const code = view.getUint8(offset + i);
    if (code === 0) break;
    out += String.fromCharCode(code);
  }
  return out.trim();
}

function parseTiff(view, base) {
  const little = view.getUint16(base, false) === 0x4949;
  const u16 = (o) => view.getUint16(o, little);
  const u32 = (o) => view.getUint32(o, little);
  if (u16(base + 2) !== 0x002a) return null;

  const tags = {};
  let subIfd = 0;

  const readEntry = (entryOffset) => {
    const tag = u16(entryOffset);
    const type = u16(entryOffset + 2);
    const count = u32(entryOffset + 4);
    const unit = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 }[type] || 1;
    const size = unit * count;
    const valueOffset = size <= 4 ? entryOffset + 8 : base + u32(entryOffset + 8);
    return { tag, type, count, unit, size, valueOffset };
  };

  const readValue = (entry) => {
    const { type, count, unit, size, valueOffset } = entry;
    if (valueOffset < 0 || valueOffset + size > view.byteLength) return null;
    if (type === 2) return readAscii(view, valueOffset, count);
    if (type === 3) {
      const out = [];
      for (let i = 0; i < count; i += 1) out.push(u16(valueOffset + i * unit));
      return out.length === 1 ? out[0] : out;
    }
    if (type === 4) {
      const out = [];
      for (let i = 0; i < count; i += 1) out.push(u32(valueOffset + i * unit));
      return out.length === 1 ? out[0] : out;
    }
    if (type === 5 || type === 10) {
      const out = [];
      for (let i = 0; i < count; i += 1) {
        const offset = valueOffset + i * 8;
        const numerator = type === 5 ? u32(offset) : view.getInt32(offset, little);
        const denominator = type === 5 ? u32(offset + 4) : view.getInt32(offset + 4, little);
        out.push(denominator ? numerator / denominator : 0);
      }
      return out.length === 1 ? out[0] : out;
    }
    return null;
  };

  const walk = (ifdOffset, depth) => {
    if (depth > 3 || ifdOffset <= 0 || base + ifdOffset + 2 > view.byteLength) return;
    const count = u16(base + ifdOffset);
    for (let i = 0; i < count; i += 1) {
      const entryOffset = base + ifdOffset + 2 + i * 12;
      if (entryOffset + 12 > view.byteLength) break;
      const entry = readEntry(entryOffset);
      const value = readValue(entry);
      if (value !== null && value !== '' && tags[entry.tag] === undefined) tags[entry.tag] = value;
      if (entry.tag === 0x8769 && typeof value === 'number') subIfd = value;
    }
  };

  walk(u16(base + 4), 0);
  if (subIfd) walk(subIfd, 1);

  return {
    make: tags[0x010f] || '',
    model: tags[0x0110] || '',
    lens: tags[0xa434] || '',
    dateTime: tags[0x9003] || tags[0x0132] || '',
    exposure: tags[0x829a],
    fnumber: tags[0x829d],
    iso: tags[0x8827] || tags[0x8828] || '',
    focal: tags[0x920a],
    focal35: tags[0xa405],
    bias: tags[0x9204],
  };
}

async function parseExif(file) {
  try {
    const buffer = await file.slice(0, 256 * 1024).arrayBuffer();
    const view = new DataView(buffer);
    if (view.byteLength < 24 || view.getUint16(0, false) !== 0xffd8) return null;
    let offset = 2;
    while (offset + 4 <= view.byteLength) {
      if (view.getUint8(offset) !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = view.getUint8(offset + 1);
      if (marker === 0xff) {
        offset += 1;
        continue;
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
        offset += 2;
        continue;
      }
      const size = view.getUint16(offset + 2, false);
      if (marker === 0xe1 && size >= 8 && offset + 10 <= view.byteLength) {
        const isExif =
          view.getUint32(offset + 4, false) === 0x45786966 && view.getUint16(offset + 8, false) === 0x0000;
        if (isExif) return parseTiff(view, offset + 10);
      }
      if (marker === 0xda) break;
      offset += 2 + size;
    }
    return null;
  } catch {
    return null;
  }
}

function fmtShutter(seconds) {
  if (!seconds) return '';
  if (seconds >= 1) return String(Math.round(seconds * 10) / 10) + 's';
  return '1/' + Math.round(1 / seconds) + 's';
}

function fmtExif(exif) {
  if (!exif) return '';
  const parts = [];
  const make = String(exif.make || '').replace(/CORPORATION|CO\.,? ?LTD\.?/gi, '').trim();
  const body = [make, exif.model].filter(Boolean).join(' ').trim();
  if (body) parts.push('机身：' + body);
  if (exif.lens) parts.push('镜头：' + String(exif.lens).trim());
  if (exif.focal) {
    const eq = exif.focal35 ? `（等效 ${Math.round(exif.focal35)}mm）` : '';
    parts.push(`焦距：${Math.round(exif.focal)}mm${eq}`);
  }
  if (exif.fnumber) parts.push('光圈：f/' + Number(exif.fnumber).toFixed(1));
  if (exif.exposure) parts.push('快门：' + fmtShutter(exif.exposure));
  if (exif.iso) parts.push('ISO：' + exif.iso);
  if (typeof exif.bias === 'number' && exif.bias !== 0) {
    parts.push('曝光补偿：' + (exif.bias > 0 ? '+' : '') + exif.bias.toFixed(1) + 'EV');
  }
  if (exif.dateTime) parts.push('拍摄时间：' + String(exif.dateTime).replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3'));
  return parts.join(' · ');
}

/* ============================ 图片处理 ============================ */

async function loadBitmap(file) {
  if (window.createImageBitmap) {
    try {
      const bitmap = await createImageBitmap(file);
      return { source: bitmap, width: bitmap.width, height: bitmap.height };
    } catch {
      /* 换 <img> 兜底 */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise((resolve, reject) => {
      const node = new Image();
      node.onload = () => resolve(node);
      node.onerror = () => reject(new Error('浏览器读不了这个图片格式，先转成 JPEG 再传'));
      node.src = url;
    });
    return { source: image, width: image.naturalWidth, height: image.naturalHeight };
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  }
}

async function prepareImage(file) {
  const bitmap = await loadBitmap(file);
  const maxEdge = 1600;
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap.source, 0, 0, width, height);
  let quality = 0.9;
  let dataUrl = canvas.toDataURL('image/jpeg', quality);
  while (dataUrl.length > 6_500_000 && quality > 0.6) {
    quality -= 0.1;
    dataUrl = canvas.toDataURL('image/jpeg', quality);
  }
  return { dataUrl, width: bitmap.width, height: bitmap.height, outW: width, outH: height };
}

/* ============================ 接口 ============================ */

async function api(path, options) {
  const response = await fetch(path, options);
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error('服务端返回了非 JSON 内容');
  }
  if (!response.ok) {
    if (response.status === 401 && !/api\/(login|register|me)$/.test(path)) {
      state.user = null;
      render();
    }
    throw new Error(data.error || `请求失败（${response.status}）`);
  }
  return data;
}

async function loadData() {
  const data = await api('api/data', { method: 'GET' });
  state.reviews = Array.isArray(data.reviews) ? data.reviews : [];
  state.model = data.model || '';
  state.hasKey = data.hasKey !== false;
  if (data.user) state.user = data.user;
}

/* ============================ 渲染 ============================ */

const HINTS = ['正在读图…', '正在看光线和构图…', '正在挑毛病…', '正在写改进建议…', '快好了，再等一下…'];

function render() {
  const route = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  const authed = Boolean(state.user);
  const admin = Boolean(state.user && state.user.role === 'admin');
  const setupMode = Boolean(state.setup && state.setup.needsSetup);
  const nav = $('#nav');
  if (nav) nav.style.display = authed && !setupMode ? '' : 'none';
  const settingsLink = document.querySelector('#nav a[data-nav="settings"]');
  if (settingsLink) settingsLink.style.display = admin ? '' : 'none';
  const meta = $('#meta');
  if (meta) {
    if (authed && !setupMode) {
      const count = state.model ? `${state.model} · ${state.reviews.length} 张` : `${state.reviews.length} 张`;
      meta.innerHTML =
        `<span class="who">${esc(state.user.name)}</span>` +
        (admin ? '<span class="chip mini">管理者</span>' : '') +
        `<span class="sep">·</span>` +
        `<span class="mcount">${esc(count)}</span><button class="btn sm ghost" id="logout">退出</button>`;
      const logout = $('#logout');
      if (logout) logout.addEventListener('click', doLogout);
    } else {
      meta.innerHTML = '';
    }
  }
  if (setupMode) {
    renderSetup();
    window.scrollTo(0, 0);
    return;
  }
  if (!authed) {
    renderAuth();
    window.scrollTo(0, 0);
    return;
  }
  document.querySelectorAll('#nav a').forEach((link) => {
    const key = link.dataset.nav;
    const on =
      key === 'archive'
        ? route.startsWith('archive')
        : key === 'settings'
        ? route.startsWith('settings')
        : route === '' || route.startsWith('r/');
    link.classList.toggle('active', on);
  });
  if (route.startsWith('r/')) renderDetail(route.slice(2));
  else if (route.startsWith('archive')) renderArchive();
  else if (route.startsWith('settings')) renderSettings();
  else renderHome();
  window.scrollTo(0, 0);
}

/* ============================ 登录 / 注册 ============================ */

function renderAuth(message) {
  const app = $('#app');
  const mode = state.authMode === 'register' ? 'register' : 'login';
  app.innerHTML = `
    <div class="auth-wrap">
      <section class="auth-side">
        <p class="eyebrow"><i class="dot"></i>本地私有 · 零依赖</p>
        <h1>照片点评</h1>
        <p class="lede">上传一张照片，AI 读图后按五个维度打分，指出具体是哪一处拖了后腿，再给出下次能照着做的改法。</p>
        <ul class="auth-points">
          <li><b>五维打分</b><span>构图、光影、色彩、技术质量，按题材调整</span></li>
          <li><b>挑毛病</b><span>具体到画面哪一处、为什么拖后腿</span></li>
          <li><b>给改法</b><span>下次怎么挪机位、怎么补光、用什么参数</span></li>
        </ul>
        <p class="auth-note">图片和点评都只写在这台电脑的 data/ 里，账号只用来分开各自的档案。</p>
      </section>
      <section class="card auth-card">
        <div class="tabs" role="tablist" aria-label="登录或注册">
          <button class="tab ${mode === 'login' ? 'on' : ''}" data-mode="login" role="tab" aria-selected="${mode === 'login'}">登录</button>
          <button class="tab ${mode === 'register' ? 'on' : ''}" data-mode="register" role="tab" aria-selected="${mode === 'register'}">注册新档案</button>
        </div>
        <div class="card-body authbox">
          <div>
            <label for="uname">用户名</label>
            <input type="text" id="uname" autocomplete="username" maxlength="20" placeholder="2-20 个字" />
          </div>
          <div>
            <label for="upass">密码</label>
            <input type="password" id="upass" maxlength="64"
              autocomplete="${mode === 'register' ? 'new-password' : 'current-password'}"
              placeholder="${mode === 'register' ? '4-64 位，记牢它' : '输入密码'}" />
          </div>
          <button class="btn primary block" id="dosubmit">${mode === 'register' ? '建立档案并进入' : '登录'}</button>
          <div class="hint err" id="authmsg">${esc(message || '')}</div>
          <div class="hint">${
            mode === 'register'
              ? '用户名只用来区分档案，不需要邮箱或手机号。'
              : '没有档案？切到「注册新档案」，用户名 + 密码就行。'
          }</div>
        </div>
      </section>
    </div>`;
  app.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const name = $('#uname') ? $('#uname').value : '';
      const pass = $('#upass') ? $('#upass').value : '';
      state.authMode = tab.dataset.mode === 'register' ? 'register' : 'login';
      renderAuth();
      if ($('#uname')) $('#uname').value = name;
      if ($('#upass')) $('#upass').value = pass;
      const next = state.authMode === 'register' ? $('#upass') : $('#uname');
      if (next) next.focus();
    });
  });
  const submit = $('#dosubmit');
  if (submit) submit.addEventListener('click', () => doAuth(state.authMode));
  ['#uname', '#upass'].forEach((sel) => {
    const input = $(sel);
    if (input) {
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') doAuth(state.authMode);
      });
    }
  });
}

async function doAuth(mode) {
  const name = $('#uname') ? $('#uname').value.trim() : '';
  const password = $('#upass') ? $('#upass').value : '';
  const msg = $('#authmsg');
  const button = $('#dosubmit');
  const label = mode === 'register' ? '建立档案并进入' : '登录';
  if (!name || !password) {
    if (msg) msg.textContent = '用户名和密码都要填';
    return;
  }
  if (button) {
    button.disabled = true;
    button.textContent = mode === 'register' ? '正在建立档案…' : '正在登录…';
  }
  if (msg) msg.textContent = '';
  try {
    const data = await api('api/' + mode, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, password }),
    });
    state.user = data.user || null;
    state.authMode = 'login';
    await loadData();
    render();
    toast(mode === 'login' ? '登录成功' : '档案已建立，可以开始点评了');
  } catch (err) {
    if (button) {
      button.disabled = false;
      button.textContent = label;
    }
    if (msg) msg.textContent = err.message || '操作失败';
  }
}

async function doLogout() {
  try {
    await api('api/logout', { method: 'POST' });
  } catch {
    /* 退出失败也当退出处理 */
  }
  state.user = null;
  state.reviews = [];
  location.hash = '#/';
  render();
}

function reviewTotal(review) {
  const result = review.result || {};
  if (result.degraded) return null;
  return typeof result.total === 'number' ? result.total : null;
}

function computeStats(reviews) {
  const totals = reviews.map(reviewTotal).filter((value) => value != null);
  const bands = [0, 0, 0, 0, 0]; // <60 / 60-69 / 70-79 / 80-89 / 90+
  totals.forEach((total) => {
    if (total >= 90) bands[4] += 1;
    else if (total >= 80) bands[3] += 1;
    else if (total >= 70) bands[2] += 1;
    else if (total >= 60) bands[1] += 1;
    else bands[0] += 1;
  });
  const genreCount = new Map();
  reviews.forEach((review) => {
    const genre = (review.result && review.result.genre) || '';
    if (genre) genreCount.set(genre, (genreCount.get(genre) || 0) + 1);
  });
  return {
    count: reviews.length,
    scored: totals.length,
    avg: totals.length ? totals.reduce((a, b) => a + b, 0) / totals.length : null,
    max: totals.length ? Math.max(...totals) : null,
    bands,
    genres: [...genreCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
    degraded: reviews.filter((review) => review.result && review.result.degraded).length,
    latest: reviews.reduce((acc, review) => {
      const at = review.createdAt || '';
      return at > acc ? at : acc;
    }, ''),
  };
}

function overviewHtml(stats) {
  if (!stats.count) return '';
  const labels = ['< 60', '60-69', '70-79', '80-89', '90+'];
  const colors = ['var(--danger)', 'var(--danger)', 'var(--warn)', 'var(--accent)', 'var(--ok)'];
  const scored = stats.bands.reduce((a, b) => a + b, 0) || 1;
  const dial =
    stats.avg == null
      ? ''
      : `<div class="ov-dial" style="--p:${stats.avg.toFixed(1)};--band:${bandColor(stats.avg)}">
           <span class="num">${stats.avg.toFixed(1)}<small>/100</small></span>
         </div>`;
  return `
    <section class="card overview">
      <div class="ov-block ov-total">
        ${dial}
        <div class="ov-stats">
          <div class="ov-stat"><b>${stats.count}</b><span>已点评</span></div>
          <div class="ov-stat"><b>${stats.max == null ? '—' : stats.max}</b><span>最高分</span></div>
          <div class="ov-stat"><b>${stats.degraded}</b><span>待重新点评</span></div>
        </div>
      </div>
      <div class="ov-block ov-dist">
        <p class="ov-title">分数分布</p>
        ${stats.bands
          .map(
            (n, i) =>
              `<div class="dist-row"><span class="lab">${labels[i]}</span><span class="bar"><i style="width:${
                Math.round((n / scored) * 100) || 0
              }%;background:${colors[i]}"></i></span><span class="num">${n}</span></div>`
          )
          .join('')}
      </div>
      <div class="ov-block ov-genres">
        <p class="ov-title">常拍题材</p>
        <div class="chips">
          ${
            stats.genres.length
              ? stats.genres
                  .map(([genre, n]) => `<span class="chip accent">${esc(genre)}<b>${n}</b></span>`)
                  .join('')
              : '<span class="chip">还没有题材标记</span>'
          }
        </div>
        <p class="ov-note">题材由模型按画面判断，同一类攒多了就能看出自己的套路。</p>
      </div>
    </section>`;
}

/* ============================ 首次设置 ============================ */

function setupMsg(text) {
  const box = $('#setupmsg');
  if (box) box.textContent = text || '';
}

function setupDraftFromForm(step) {
  const draft = state.setupDraft;
  if (step === 1) {
    if ($('#su-name')) draft.name = $('#su-name').value.trim();
    if ($('#su-pass')) draft.password = $('#su-pass').value;
  } else {
    if ($('#su-provider')) draft.provider = $('#su-provider').value;
    if ($('#su-key')) draft.apiKey = $('#su-key').value.trim();
    if ($('#su-model')) draft.model = $('#su-model').value.trim();
    if ($('#su-base')) draft.baseUrl = $('#su-base').value.trim();
  }
  return draft;
}

function modelOptionList(preset) {
  return ((preset && preset.models) || []).map((item) => `<option value="${esc(item)}"></option>`).join('');
}

function presetOf(providers, id) {
  const list = Array.isArray(providers) ? providers : [];
  return list.find((item) => item.id === id) || list[0] || null;
}

function providerOptionsHtml(providers, currentId) {
  return (Array.isArray(providers) ? providers : [])
    .map(
      (item) =>
        `<option value="${esc(item.id)}"${item.id === currentId ? ' selected' : ''}>${esc(item.label)}</option>`
    )
    .join('');
}

function bindProviderPicker(prefix, providers) {
  const select = $(prefix + '-provider');
  if (!select) return;
  select.addEventListener('change', () => {
    const preset = presetOf(providers, select.value);
    if (!preset) return;
    const model = $(prefix + '-model');
    const base = $(prefix + '-base');
    const list = $(prefix + '-models');
    const hint = $(prefix + '-key-hint');
    if (model) model.value = preset.model || '';
    if (base) base.value = preset.baseUrl || '';
    if (list) list.innerHTML = modelOptionList(preset);
    if (hint) hint.textContent = preset.keysUrl ? `在 ${preset.keysUrl} 申请` : '填服务商给的 Key';
  });
}

function renderSetup(message) {
  const app = $('#app');
  const step = state.setupStep === 2 ? 2 : 1;
  const draft = state.setupDraft;
  const providers = (state.setup && state.setup.providers) || [];
  const providerId = draft.provider || (state.setup && state.setup.provider) || 'deepseek';
  const preset = presetOf(providers, providerId) || {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    keysUrl: 'https://platform.deepseek.com/api_keys',
  };
  const modelDefault = draft.model || preset.model || '';
  const baseDefault = draft.baseUrl || preset.baseUrl || '';
  const keyHelp = preset.keysUrl ? `在 ${preset.keysUrl} 申请` : '填服务商给的 Key';
  app.innerHTML = `
    <div class="auth-wrap setup-wrap">
      <section class="auth-side">
        <p class="eyebrow"><i class="dot"></i>第一次运行 · 两步就能用</p>
        <h1>先把这里变成你自己的站点</h1>
        <p class="lede">建一个管理者账号，再选模型服务商、填上 API Key。之后打开站点的人可以各自注册档案，点评只记在各自名下；只有管理者能改这些设置。</p>
        <ol class="steps">
          <li class="${step === 1 ? 'on' : 'done'}"><b>1</b><span>管理者账号</span></li>
          <li class="${step === 2 ? 'on' : ''}"><b>2</b><span>模型与 Key</span></li>
        </ol>
        <p class="auth-note">账号只存加盐摘要，API Key 只写在 data/secrets.json，都不会出现在网页源码里。</p>
      </section>
      <section class="card auth-card">
        <div class="card-head">${step === 1 ? '创建管理者账号' : '选择模型服务商'}</div>
        <div class="card-body authbox">
          ${
            step === 1
              ? `
            <div class="hint">这个账号是管理者：能改 API Key、模型和接口地址，也能删自己的点评。</div>
            <div>
              <label for="su-name">用户名</label>
              <input type="text" id="su-name" maxlength="20" autocomplete="username" placeholder="2-20 个字" value="${esc(draft.name)}" />
            </div>
            <div>
              <label for="su-pass">密码</label>
              <input type="password" id="su-pass" maxlength="64" autocomplete="new-password" placeholder="至少 4 位" value="${esc(draft.password)}" />
            </div>
            <div>
              <label for="su-pass2">再输一次密码</label>
              <input type="password" id="su-pass2" maxlength="64" autocomplete="new-password" placeholder="确认密码" value="${esc(draft.password)}" />
            </div>
            <button class="btn primary block" id="su-next">下一步：选模型、填 Key</button>`
              : `
            <div class="hint">支持 DeepSeek、GPT、Claude、Gemini、GLM、通义千问、Kimi，也可以填任何 OpenAI 兼容接口。Key 只保存在这台机器的 data/secrets.json。</div>
            <div>
              <label for="su-provider">模型服务商</label>
              <select id="su-provider">${providerOptionsHtml(providers, preset.id)}</select>
            </div>
            <div>
              <label for="su-key">API Key</label>
              <input type="text" id="su-key" class="mono" autocomplete="off" spellcheck="false" placeholder="sk-..." value="${esc(draft.apiKey)}" />
              <div class="hint" id="su-key-hint">${esc(keyHelp)}</div>
            </div>
            <div class="row2">
              <div>
                <label for="su-model">模型</label>
                <input type="text" id="su-model" list="su-models" value="${esc(modelDefault)}" />
                <datalist id="su-models">${modelOptionList(preset)}</datalist>
              </div>
              <div>
                <label for="su-base">接口地址</label>
                <input type="text" id="su-base" value="${esc(baseDefault)}" />
              </div>
            </div>
            <div class="hint">先跳过也行：之后在「设置」里补 Key，没填之前点评会提示。</div>
            <div class="actions">
              <button class="btn ghost" id="su-back">上一步</button>
              <button class="btn primary" id="su-done">完成初始化</button>
            </div>`
          }
          <div class="hint err" id="setupmsg">${esc(message || '')}</div>
        </div>
      </section>
    </div>`;

  if (step === 1) {
    const next = $('#su-next');
    if (next) {
      next.addEventListener('click', () => {
        setupDraftFromForm(1);
        const d = state.setupDraft;
        if (d.name.length < 2 || d.name.length > 20) {
          setupMsg('用户名请用 2-20 个字');
          return;
        }
        if (d.password.length < 4) {
          setupMsg('密码至少 4 位');
          return;
        }
        if ($('#su-pass').value !== $('#su-pass2').value) {
          setupMsg('两次输入的密码不一样');
          return;
        }
        state.setupStep = 2;
        renderSetup();
        if ($('#su-key')) $('#su-key').focus();
      });
    }
    ['#su-name', '#su-pass', '#su-pass2'].forEach((sel) => {
      const input = $(sel);
      if (input) {
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') $('#su-next').click();
        });
      }
    });
    if ($('#su-name')) $('#su-name').focus();
    return;
  }

  bindProviderPicker('#su', providers);

  const back = $('#su-back');
  if (back) {
    back.addEventListener('click', () => {
      setupDraftFromForm(2);
      state.setupStep = 1;
      renderSetup();
    });
  }
  const done = $('#su-done');
  if (done) done.addEventListener('click', finishSetup);
  const key = $('#su-key');
  if (key) {
    key.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') finishSetup();
    });
    key.focus();
  }
}

async function finishSetup() {
  setupDraftFromForm(2);
  const draft = state.setupDraft;
  const button = $('#su-done');
  if (button) {
    button.disabled = true;
    button.textContent = '正在初始化…';
  }
  try {
    const data = await api('api/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: draft.name,
        password: draft.password,
        provider: draft.provider,
        apiKey: draft.apiKey,
        model: draft.model,
        baseUrl: draft.baseUrl,
      }),
    });
    if (state.setup) state.setup.needsSetup = false;
    state.setupStep = 1;
    state.setupDraft = { name: '', password: '', provider: '', apiKey: '', model: '', baseUrl: '' };
    state.user = data.user || null;
    state.hasKey = data.hasKey !== false;
    await loadData();
    render();
    toast('初始化完成，可以开始点评了');
  } catch (err) {
    if (err.message && /已经初始化过/.test(err.message)) {
      if (state.setup) state.setup.needsSetup = false;
      render();
      toast(err.message, 'err');
      return;
    }
    if (button) {
      button.disabled = false;
      button.textContent = '完成初始化';
    }
    setupMsg(err.message || '初始化失败');
  }
}

/* ============================ 设置（管理者） ============================ */

async function renderSettings() {
  const app = $('#app');
  if (!state.user || state.user.role !== 'admin') {
    app.innerHTML = `
      <div class="page-title"><h1>设置</h1></div>
      <div class="empty">只有管理者能打开这个页面。<a href="#/" style="color:var(--accent)">回首页 →</a></div>`;
    return;
  }
  app.innerHTML = `
    <div class="page-title"><h1>设置</h1><span>API Key、模型和接口地址</span></div>
    <div class="card"><div class="card-body"><span class="spinner"></span> 正在读取…</div></div>`;
  let s;
  try {
    s = await api('api/settings', { method: 'GET' });
  } catch (err) {
    app.innerHTML = `
      <div class="page-title"><h1>设置</h1></div>
      <div class="card"><div class="card-body" style="color:var(--danger)">${esc(err.message || '读取失败')}</div></div>`;
    return;
  }
  const route = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  if (!route.startsWith('settings')) return;
  state.settings = s;
  const providers = s.providers || [];
  const preset = presetOf(providers, s.provider) || {
    id: 'deepseek',
    label: 'DeepSeek',
    model: s.model,
    baseUrl: s.baseUrl,
    models: [],
    keysUrl: '',
  };
  app.innerHTML = `
    <div class="page-title"><h1>设置</h1><span>模型服务商、API Key 和参数</span></div>
    <div class="card">
      <div class="card-head">模型接口</div>
      <div class="card-body settings-body">
        <div class="status-row">
          <span class="hint">当前生效</span>
          <span class="chip ${s.hasKey ? 'ok' : 'bad'}">${
            s.hasKey ? 'API Key 已配置 ' + esc(s.keyHint) : '还没有 API Key'
          }</span>
          <span class="chip accent">${esc(s.providerLabel || preset.label)}</span>
          <span class="chip">${esc(s.model)}</span>
          ${s.updatedAt ? `<span class="hint">更新于 ${esc(fmtDate(s.updatedAt))}</span>` : ''}
        </div>
        <div class="row2">
          <div>
            <label for="st-provider">模型服务商</label>
            <select id="st-provider">${providerOptionsHtml(providers, s.provider)}</select>
          </div>
          <div>
            <label for="st-key">API Key</label>
            <input type="text" id="st-key" class="mono" autocomplete="off" spellcheck="false"
              placeholder="${s.hasKey ? '留空表示不修改' : 'sk-...'}" />
            <div class="hint" id="st-key-hint">${
              preset.keysUrl ? `在 ${esc(preset.keysUrl)} 申请；` : ''
            }只存在 data/secrets.json，页面上永远只显示后四位。</div>
          </div>
        </div>
        <div class="row2">
          <div>
            <label for="st-model">模型</label>
            <div class="field-row">
              <input type="text" id="st-model" list="st-models" value="${esc(s.model)}" />
              <button class="btn sm" id="st-models-btn" type="button">拉取列表</button>
            </div>
            <datalist id="st-models">${modelOptionList(preset)}</datalist>
            <select id="st-model-pick" hidden aria-label="服务商返回的可用模型"></select>
          </div>
          <div>
            <label for="st-base">接口地址</label>
            <input type="text" id="st-base" value="${esc(s.baseUrl)}" />
          </div>
        </div>
        <div class="hint">换服务商后，模型和地址会先填成那家的默认值，可以直接改；模型名更新很快，用「拉取列表」现查你账号能用的模型。「自定义」用于任何 OpenAI 兼容接口。</div>
        <div class="actions">
          <button class="btn primary" id="st-save">保存</button>
          <button class="btn" id="st-test">测试连接</button>
          ${s.hasKey ? '<button class="btn danger" id="st-clear">清除 Key</button>' : ''}
        </div>
        <div class="hint" id="st-msg"></div>
      </div>
    </div>
    <div class="card">
      <div class="card-body hint settings-note">
        这些设置对整站生效：所有账号的点评都用这个服务商、Key 和模型，改完不用重启服务。<br />
        <b>分享这个项目时别把 data/ 一起打包</b>——账号、照片和 Key 都在里面。
      </div>
    </div>`;
  bindSettings(providers);
}

function bindSettings(providers) {
  const msg = $('#st-msg');
  const setMsg = (text, kind) => {
    if (!msg) return;
    msg.textContent = text;
    msg.style.color = kind === 'err' ? 'var(--danger)' : kind === 'ok' ? 'var(--ok)' : '';
  };

  bindProviderPicker('#st', providers);

  const save = $('#st-save');
  if (save) {
    save.addEventListener('click', async () => {
      const provider = $('#st-provider') ? $('#st-provider').value : '';
      const key = $('#st-key') ? $('#st-key').value.trim() : '';
      const model = $('#st-model') ? $('#st-model').value.trim() : '';
      const baseUrl = $('#st-base') ? $('#st-base').value.trim() : '';
      save.disabled = true;
      setMsg('正在保存…');
      try {
        const next = await api('api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(key ? { provider, apiKey: key, model, baseUrl } : { provider, model, baseUrl }),
        });
        state.hasKey = next.hasKey !== false;
        state.model = next.model || state.model;
        toast('已保存');
        render();
      } catch (err) {
        save.disabled = false;
        setMsg(err.message || '保存失败', 'err');
      }
    });
  }

  const test = $('#st-test');
  if (test) {
    test.addEventListener('click', async () => {
      const provider = $('#st-provider') ? $('#st-provider').value : '';
      const key = $('#st-key') ? $('#st-key').value.trim() : '';
      const model = $('#st-model') ? $('#st-model').value.trim() : '';
      const baseUrl = $('#st-base') ? $('#st-base').value.trim() : '';
      test.disabled = true;
      setMsg('正在连模型接口…');
      try {
        const out = await api('api/settings/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider, apiKey: key, model, baseUrl }),
        });
        setMsg(`连接正常（${out.ms}ms，${out.provider} / ${out.model}）：${out.sample || '可用'}`, 'ok');
      } catch (err) {
        setMsg('连接失败：' + (err.message || '未知错误'), 'err');
      } finally {
        test.disabled = false;
      }
    });
  }

  const modelsBtn = $('#st-models-btn');
  if (modelsBtn) {
    modelsBtn.addEventListener('click', async () => {
      const provider = $('#st-provider') ? $('#st-provider').value : '';
      const key = $('#st-key') ? $('#st-key').value.trim() : '';
      const model = $('#st-model') ? $('#st-model').value.trim() : '';
      const baseUrl = $('#st-base') ? $('#st-base').value.trim() : '';
      modelsBtn.disabled = true;
      setMsg('正在向服务商查询模型列表…');
      try {
        const out = await api('api/settings/models', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider, apiKey: key, model, baseUrl }),
        });
        const list = Array.isArray(out.models) ? out.models : [];
        const datalist = $('#st-models');
        if (datalist) datalist.innerHTML = list.map((item) => `<option value="${esc(item)}"></option>`).join('');
        const pick = $('#st-model-pick');
        const input = $('#st-model');
        if (pick) {
          pick.innerHTML =
            `<option value="">共 ${list.length} 个模型，点这里选…</option>` +
            list.map((item) => `<option value="${esc(item)}">${esc(item)}</option>`).join('');
          pick.hidden = false;
          if (input && list.includes(input.value)) pick.value = input.value;
          pick.onchange = () => {
            if ($('#st-model') && pick.value) $('#st-model').value = pick.value;
          };
        }
        setMsg(`拿到 ${list.length} 个模型，可以直接在下面的下拉里选。`, 'ok');
      } catch (err) {
        setMsg('拉取失败：' + (err.message || '未知错误'), 'err');
      } finally {
        modelsBtn.disabled = false;
      }
    });
  }

  const clear = $('#st-clear');
  if (clear) {
    clear.addEventListener('click', async () => {
      if (!window.confirm('清除 API Key？清除后整站都不能点评，直到重新填上。')) return;
      clear.disabled = true;
      try {
        await api('api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clearKey: true }),
        });
        state.hasKey = false;
        toast('已清除 API Key');
        render();
      } catch (err) {
        clear.disabled = false;
        setMsg(err.message || '清除失败', 'err');
      }
    });
  }
}

function renderHome() {
  const app = $('#app');
  const stats = computeStats(state.reviews);
  const admin = Boolean(state.user && state.user.role === 'admin');
  const warn = state.hasKey
    ? ''
    : `<div class="notice">
         <div class="notice-main">
           <b>还没有配置 API Key，暂时不能点评</b>
           <span>${
             admin ? '填上就能用了，Key 只保存在本机的 data/secrets.json。' : '等管理员在「设置」里填上后就能点评。'
           }</span>
         </div>
         ${admin ? '<a class="btn sm primary" href="#/settings">去设置</a>' : ''}
       </div>`;
  const facts = stats.count
    ? [
        `已点评 <b>${stats.count}</b> 张`,
        stats.avg == null ? '' : `平均 <b>${stats.avg.toFixed(1)}</b> 分`,
        stats.max == null ? '' : `最高 <b>${stats.max}</b> 分`,
        stats.latest ? `最近 ${esc(fmtDate(stats.latest))}` : '',
      ]
        .filter(Boolean)
        .map((item) => `<span>${item}</span>`)
        .join('<i>·</i>')
    : '<span>还没有记录，第一张就从这里开始。</span>';
  app.innerHTML = `
    ${warn}
    <section class="hero">
      <p class="eyebrow"><i class="dot"></i>本地私有 · 每张都留档</p>
      <h1>照片拍完，<br class="br-m" />先听听它说哪儿不对</h1>
      <p class="lede">上传一张，AI 读图后按五个维度打分，指出具体是哪一处拖了后腿，再给出下次能照着做的改法。</p>
      <div class="hero-actions">
        <button class="btn primary lg" id="pickBtn">选一张照片</button>
        <a class="btn ghost lg" href="#/archive">打开档案${stats.count ? ` · ${stats.count} 张` : ''}</a>
      </div>
      <p class="hero-facts">${facts}</p>
    </section>
    <div class="card upload" id="upload">
      <div class="card-body" id="stage"></div>
    </div>
    ${overviewHtml(stats)}
    <div class="section-head">
      <h2>最近点评</h2>
      <span class="sub">${stats.count ? `共 ${stats.count} 张` : '还没有记录'}</span>
      ${stats.count > 6 ? '<a class="link" href="#/archive">查看全部 →</a>' : ''}
    </div>
    <div class="grid recent" id="recent"></div>`;
  renderStage();
  renderRecent();
  const pickBtn = $('#pickBtn');
  if (pickBtn) pickBtn.addEventListener('click', openPicker);
}

function openPicker() {
  if (state.busy) return;
  state.picked = null;
  renderStage();
  const input = $('#file');
  const upload = $('#upload');
  if (upload && upload.scrollIntoView) upload.scrollIntoView({ behavior: 'smooth', block: 'center' });
  if (input) input.click();
}

function renderStage() {
  const stage = $('#stage');
  if (!stage) return;
  if (state.busy) {
    const shot = state.picked ? `<img class="busy-shot" src="${state.picked.dataUrl}" alt="" />` : '';
    stage.innerHTML = `
      <div class="busy">
        ${shot}
        <div class="busy-main">
          <div class="progress">
            <span class="spinner"></span>
            <span id="hint">${HINTS[0]}</span>
            <span class="spacer"></span>
            <span class="sub" id="elapsed"></span>
          </div>
          <span class="track"><i></i></span>
        </div>
      </div>`;
    return;
  }
  if (!state.picked) {
    stage.innerHTML = `
      <div class="upload-grid">
        <label class="drop" id="drop">
          <input class="sr-only" type="file" id="file" accept="image/*" />
          <svg class="drop-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"
               stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="3" y="4.5" width="18" height="15" rx="3" />
            <circle cx="8.8" cy="10" r="1.5" />
            <path d="m4 16.6 4.8-4.2 3.6 3 2.6-2.3 5 4.4" />
          </svg>
          <span class="big">把照片拖进来，或点这里选一张</span>
          <span class="hint">支持 JPEG / PNG / WebP</span>
          <span class="hint">也可以直接 Ctrl+V 粘贴</span>
        </label>
        <div class="promise">
          <p class="promise-title">点评会给什么</p>
          <ul>
            <li><b>五维打分</b>按题材给出构图、光影、色彩、技术质量等 0-10 分</li>
            <li><b>挑毛病</b>具体到画面哪一处、为什么拖了后腿</li>
            <li><b>给改法</b>下次怎么挪机位、怎么补光、用什么参数</li>
          </ul>
          <p class="promise-note">图片只留在你自己的服务器，点评时才转给模型一次。</p>
        </div>
      </div>`;
    bindDrop();
    return;
  }
  const picked = state.picked;
  stage.innerHTML = `
    <div class="preview">
      <div class="shot"><img src="${picked.dataUrl}" alt="预览" /></div>
      <div class="fields">
        <div class="exif">${picked.exifText ? esc(picked.exifText) : '没有读到 EXIF 参数（截图或经过处理的图通常没有）'}</div>
        <div>
          <label for="title">标题（可选）</label>
          <input type="text" id="title" maxlength="60" placeholder="例如：雨后的老街" />
        </div>
        <div>
          <label for="note">补充说明（可选）</label>
          <textarea id="note" rows="3" maxlength="300" placeholder="想重点听哪方面的意见？拍摄时的想法？"></textarea>
        </div>
        <div class="hint filemeta">
          ${picked.file ? esc(picked.file.name) + ' · ' : ''}原图 ${picked.width}×${picked.height}<br />
          压缩后上传 ${picked.outW}×${picked.outH} · 约 ${Math.round(picked.dataUrl.length / 1365)}KB
        </div>
        <div class="actions">
          <button class="btn primary" id="go">开始点评</button>
          <button class="btn ghost" id="reset">换一张</button>
        </div>
      </div>
    </div>`;
  $('#go').addEventListener('click', submit);
  $('#reset').addEventListener('click', () => {
    state.picked = null;
    renderStage();
  });
}

function bindDrop() {
  const drop = $('#drop');
  const input = $('#file');
  if (!drop || !input) return;
  input.addEventListener('change', () => {
    if (input.files && input.files[0]) pick(input.files[0]);
  });
  ['dragenter', 'dragover'].forEach((type) =>
    drop.addEventListener(type, (event) => {
      event.preventDefault();
      drop.classList.add('drag');
    })
  );
  ['dragleave', 'drop'].forEach((type) =>
    drop.addEventListener(type, (event) => {
      event.preventDefault();
      drop.classList.remove('drag');
    })
  );
  drop.addEventListener('drop', (event) => {
    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    if (file) pick(file);
  });
}

function renderRecent() {
  const box = $('#recent');
  if (!box) return;
  if (!state.reviews.length) {
    box.outerHTML = `
      <div class="empty-state">
        <span class="empty-mark" aria-hidden="true">◎</span>
        <p class="big">档案还是空的</p>
        <p class="hint">传第一张照片，点评会连原图、拍摄参数一起存下来，之后随时回看。</p>
      </div>`;
    return;
  }
  box.innerHTML = state.reviews.slice(0, 6).map(tileHtml).join('');
}

function tileHtml(review) {
  const result = review.result || {};
  const total = reviewTotal(review);
  const degraded = Boolean(result.degraded);
  const headline = result.headline || review.title || '（没有标题）';
  const genre = result.genre || '';
  const band = degraded ? 'var(--danger)' : total == null ? 'rgba(0,0,0,.55)' : bandColor(total);
  return `
    <a class="tile" href="#/r/${esc(review.id)}" title="${esc(headline)}">
      <div class="thumb">
        <img src="${esc(review.image)}" alt="${esc(headline)}" loading="lazy" decoding="async" />
        <span class="badge" ${degraded ? '' : `style="--band:${band}"`}>
          <i style="background:${band}"></i>${degraded ? '格式异常' : total == null ? '—' : total}
        </span>
        ${genre ? `<span class="genre">${esc(genre)}</span>` : ''}
      </div>
      <div class="body">
        <div class="line">${esc(degraded ? '这条点评输出格式异常，点开可以重新点评' : headline)}</div>
        <div class="sub">${esc(fmtDate(review.createdAt))}</div>
      </div>
    </a>`;
}

function renderArchive() {
  const app = $('#app');
  if (!state.reviews.length) {
    app.innerHTML = `
      <div class="page-title"><h1>点评档案</h1><span>0 张</span></div>
      <div class="empty">还没有记录。<a href="#/" style="color:var(--accent)">去传一张 →</a></div>`;
    return;
  }
  app.innerHTML = `
    <div class="page-title"><h1>点评档案</h1><span>${state.reviews.length} 张</span></div>
    <div class="grid" id="archive"></div>`;
  $('#archive').innerHTML = state.reviews.map(tileHtml).join('');
}

function resultHtml(review) {
  const result = review.result || {};
  const total = result.total;
  const dims = Array.isArray(result.dimensions) ? result.dimensions : [];
  const listOf = (items, cls, title) => {
    if (!Array.isArray(items) || !items.length) return '';
    return `<div class="col ${cls}"><h3>${title}</h3><ul>${items.map((item) => `<li>${esc(item)}</li>`).join('')}</ul></div>`;
  };
  if (result.degraded) {
    const format = result.format || {};
    const issues = Array.isArray(format.issues) ? format.issues : [];
    return `
      <div class="card">
        <div class="verdict">
          <div class="headline">
            <p>${esc(result.headline || '模型这次没有按格式返回')}</p>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <span class="chip bad">格式校验未通过</span>
              <span class="chip">尝试 ${Number(format.attempts) || 1} 次</span>
              ${review.model ? `<span class="chip">${esc(review.model)}</span>` : ''}
            </div>
          </div>
        </div>
        ${
          issues.length
            ? `<div class="card-body"><b>校验没过的原因</b><ul class="issues">${issues
                .map((item) => `<li>${esc(item)}</li>`)
                .join('')}</ul></div>`
            : ''
        }
        <div class="card-body">
          <div class="rawhead">
            <b>模型的原始输出</b>
            <span class="hint">（同样的一份已写进服务端 data/error.log）</span>
            <span class="spacer"></span>
            <button class="btn sm primary" id="retry">重新点评这张</button>
          </div>
          <pre class="rawbox">${esc(result.raw || '（没有留下原文）')}</pre>
        </div>
      </div>`;
  }
  const format = result.format || {};
  const formatIssues = Array.isArray(format.issues) ? format.issues : [];
  const formatChips = [];
  if (format.mode === 'repaired') formatChips.push('<span class="chip warn">格式已自动修复</span>');
  if (Number(format.attempts) > 1) formatChips.push(`<span class="chip warn">第 ${format.attempts} 次输出才通过校验</span>`);
  if (format.reparsed) formatChips.push('<span class="chip warn">历史记录已重新解析</span>');
  if (!formatChips.length && formatIssues.length) formatChips.push('<span class="chip warn">格式有告警</span>');
  return `
    <div class="card">
      <div class="verdict">
        <div class="dial" style="--p:${total == null ? 0 : total};--band:${bandColor(total)}">
          <span class="num">${total == null ? '—' : total}<small>${total == null ? '' : '/100'}</small></span>
        </div>
        <div class="headline">
          <p>${esc(result.headline || '')}</p>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            ${result.genre ? `<span class="chip accent">${esc(result.genre)}</span>` : ''}
            <span class="chip">${esc(review.model || state.model)}</span>
            <span class="chip">${esc(fmtDate(review.createdAt))}</span>
            ${formatChips.join('')}
          </div>
        </div>
      </div>
      ${dims.length ? `<div class="dims">${dims.map(dimRow).join('')}</div>` : ''}
      <div class="cols">
        ${listOf(result.strengths, 'good', '优点')}
        ${listOf(result.weaknesses, 'bad', '问题')}
        ${listOf(result.suggestions, 'todo', '怎么改')}
      </div>
      ${result.params ? `<div class="params"><b>参数</b>${esc(result.params)}</div>` : ''}
      ${
        formatIssues.length
          ? `<div class="params"><b>格式校验备注</b>${esc(formatIssues.join('；'))}</div>`
          : ''
      }
    </div>`;
}

function dimRow(dim) {
  const score = dim.score == null ? '' : dim.score;
  const percent = dim.score == null ? 0 : Math.max(0, Math.min(10, dim.score)) * 10;
  return `
    <div class="dim">
      <div class="name">${esc(dim.name)}</div>
      <div class="bar"><i style="width:${percent}%"></i></div>
      <div class="score">${score}</div>
      <div class="comment">${esc(dim.comment)}</div>
    </div>`;
}

function renderDetail(id) {
  const review = state.reviews.find((item) => item.id === id);
  const app = $('#app');
  if (!review) {
    app.innerHTML = '<div class="empty">找不到这条点评。<a href="#/archive" style="color:var(--accent)">回档案 →</a></div>';
    return;
  }
  app.innerHTML = `
    <div class="page-title"><h1>${esc(review.title || '点评详情')}</h1>
      ${review.ownerName ? `<span class="chip">${esc(review.ownerName)} 的档案</span>` : ''}
      <a href="#/archive" class="chip">← 回档案</a></div>
    <div class="card">
      <div class="card-body" style="display:grid;place-items:center;background:var(--surface)">
        <img src="${esc(review.image)}" alt="" style="max-height:70vh;border-radius:8px" />
      </div>
      ${review.exifText ? `<div class="params"><b>拍摄参数</b>${esc(review.exifText)}</div>` : ''}
      ${review.note ? `<div class="params"><b>拍摄者说明</b>${esc(review.note)}</div>` : ''}
    </div>
    ${resultHtml(review)}
    <div class="card">
      <div class="foot">
        <span>${esc(fmtDate(review.createdAt))}${review.retriedAt ? ' · 重新点评于 ' + esc(fmtDate(review.retriedAt)) : ''}</span>
        <span class="spacer"></span>
        <button class="btn sm danger" id="del">删除这条</button>
      </div>
    </div>`;
  $('#del').addEventListener('click', () => removeReview(review.id));
  const retry = $('#retry');
  if (retry) retry.addEventListener('click', () => retryReview(review.id));
}

async function retryReview(id) {
  const button = $('#retry');
  if (button) {
    button.disabled = true;
    button.textContent = '正在重新点评…';
  }
  try {
    const data = await api('api/review/' + encodeURIComponent(id) + '/retry', { method: 'POST' });
    const index = state.reviews.findIndex((item) => item.id === id);
    if (index >= 0) state.reviews[index] = data.review;
    else state.reviews.unshift(data.review);
    render();
    if (data.review.result && data.review.result.degraded) toast('这次输出还是没通过格式校验，原文已留存', 'err');
    else toast('重新点评完成');
  } catch (err) {
    if (button) {
      button.disabled = false;
      button.textContent = '重新点评这张';
    }
    toast(err.message || '重新点评失败', 'err');
  }
}

/* ============================ 行为 ============================ */

async function pick(file) {
  if (!file.type.startsWith('image/') && !/\.(jpe?g|png|webp|heic|heif)$/i.test(file.name)) {
    toast('这不是图片文件', 'err');
    return;
  }
  try {
    const [prepared, exif] = await Promise.all([prepareImage(file), parseExif(file)]);
    state.picked = {
      file,
      dataUrl: prepared.dataUrl,
      width: prepared.width,
      height: prepared.height,
      outW: prepared.outW,
      outH: prepared.outH,
      exif,
      exifText: fmtExif(exif),
    };
    renderStage();
  } catch (err) {
    toast(err.message || '读取图片失败', 'err');
  }
}

async function submit() {
  const picked = state.picked;
  if (!picked || state.busy) return;
  const title = $('#title') ? $('#title').value.trim() : '';
  const note = $('#note') ? $('#note').value.trim() : '';
  state.busy = true;
  state.startedAt = Date.now();
  renderStage();

  const tick = setInterval(() => {
    const seconds = Math.round((Date.now() - state.startedAt) / 1000);
    const hint = $('#hint');
    const elapsed = $('#elapsed');
    if (hint) hint.textContent = HINTS[Math.min(HINTS.length - 1, Math.floor(seconds / 8))];
    if (elapsed) elapsed.textContent = seconds + 's';
  }, 1000);

  try {
    const data = await api('api/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image: picked.dataUrl,
        exifText: picked.exifText,
        exif: picked.exif || null,
        width: picked.width,
        height: picked.height,
        title,
        note,
      }),
    });
    state.reviews.unshift(data.review);
    state.picked = null;
    state.busy = false;
    clearInterval(tick);
    location.hash = '#/r/' + data.review.id;
    if (location.hash === '#/r/' + data.review.id) render();
    if (data.review.result && data.review.result.degraded) {
      toast('点评完成，但模型输出没通过格式校验，原文已保留', 'err');
    } else {
      toast('点评完成');
    }
  } catch (err) {
    state.busy = false;
    clearInterval(tick);
    renderStage();
    toast(err.message || '点评失败', 'err');
  }
}

async function removeReview(id) {
  const review = state.reviews.find((item) => item.id === id);
  if (!review) return;
  if (!window.confirm('删除这条点评？图片也会一起删掉，不能恢复。')) return;
  try {
    await api('api/review/' + encodeURIComponent(id), { method: 'DELETE' });
    state.reviews = state.reviews.filter((item) => item.id !== id);
    toast('已删除');
    location.hash = '#/archive';
    render();
  } catch (err) {
    toast(err.message || '删除失败', 'err');
  }
}

/* ============================ 启动 ============================ */

document.addEventListener('paste', (event) => {
  const items = event.clipboardData && event.clipboardData.items;
  if (!items) return;
  for (const item of items) {
    if (item.type && item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) {
        state.picked = null;
        location.hash = '#/';
        pick(file);
        toast('已从剪贴板读取图片');
      }
      break;
    }
  }
});

window.addEventListener('hashchange', render);

(async function boot() {
  try {
    const [setup, me] = await Promise.all([api('api/setup', { method: 'GET' }), api('api/me', { method: 'GET' })]);
    state.setup = setup;
    state.hasKey = setup.hasKey !== false;
    if (!setup.needsSetup) {
      state.user = me.user || null;
      if (state.user) await loadData();
    }
  } catch (err) {
    toast('读取数据失败：' + (err.message || ''), 'err');
  }
  render();
})();
