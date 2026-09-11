/* KeyDrive 前端逻辑 */
'use strict';

const $ = (sel) => document.querySelector(sel);

const KEY_RE = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{12}$/;

const state = {
  key: null,
  vault: null,   // {key, created, text, files}
  uploading: 0,
};

/* ---------------- 工具 ---------------- */

function normalizeKey(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function formatKey(key) {
  return key.replace(/(.{4})(?=.)/g, '$1-');
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function formatSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}

function formatTime(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

let toastTimer = null;
function toast(msg, isErr) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 2600);
}

async function api(path, options) {
  const res = await fetch(path, options);
  let data = {};
  try { data = await res.json(); } catch { /* 忽略非 JSON 响应 */ }
  if (!res.ok) {
    const err = new Error(data.error || `请求失败（${res.status}）`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function copyText(text, tip) {
  try {
    await navigator.clipboard.writeText(text);
    toast(tip || '已复制到剪贴板');
  } catch {
    // 兼容非 HTTPS / 旧浏览器
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      toast(tip || '已复制到剪贴板');
    } catch {
      toast('复制失败，请手动选择复制', true);
    }
    ta.remove();
  }
}

/* ---------------- 屏幕切换 ---------------- */

function showScreen(name) {
  for (const id of ['screen-home', 'screen-created', 'screen-vault']) {
    $('#' + id).classList.toggle('hidden', id !== name);
  }
  window.scrollTo(0, 0);
}

/* ---------------- 最近使用的密钥 ---------------- */

const LS_KEY = 'keydrive_recent_keys';

function getRecent() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || []; } catch { return []; }
}

function addRecent(key) {
  key = normalizeKey(key); // 统一存规范格式，展示时再加分隔符，避免匹配/去重失效
  const list = getRecent().filter((k) => k !== key);
  list.unshift(key);
  localStorage.setItem(LS_KEY, JSON.stringify(list.slice(0, 8)));
  renderRecent();
}

function removeRecent(key) {
  localStorage.setItem(LS_KEY, JSON.stringify(getRecent().filter((k) => k !== key)));
  renderRecent();
}

function renderRecent() {
  const box = $('#my-keys');
  // 兼容历史遗留的带连字符数据：展示与传参前统一规范化
  const list = [...new Set(getRecent().map(normalizeKey).filter((k) => KEY_RE.test(k)))];
  if (!list.length) { box.innerHTML = ''; return; }
  box.innerHTML = '<span class="label">最近使用：</span>' + list.map((k) =>
    `<span class="key-chip-item" data-key="${esc(k)}" title="点击进入">${esc(formatKey(k))}<button class="rm" data-rm="${esc(k)}" title="从列表移除">✕</button></span>`
  ).join('');
  box.querySelectorAll('.key-chip-item').forEach((el) => {
    el.addEventListener('click', (e) => {
      if (e.target.dataset.rm) return;
      enterVault(el.dataset.key);
    });
  });
  box.querySelectorAll('.rm').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      removeRecent(el.dataset.rm);
    });
  });
}

/* ---------------- 进入 / 创建 ---------------- */

async function createKey() {
  const btn = $('#btn-create');
  btn.disabled = true;
  try {
    const data = await api('/api/create', { method: 'POST' });
    $('#new-key').textContent = data.key;
    addRecent(data.key);
    showScreen('screen-created');
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
}

async function enterVault(rawKey, opts) {
  const key = normalizeKey(rawKey);
  if (!KEY_RE.test(key)) {
    toast('密钥格式不正确：应为 12 位字母数字，例如 K7M2-9QX4-BT8F', true);
    return false;
  }
  if (!opts || !opts.silent) $('#btn-enter').disabled = true;
  try {
    const vault = await api(`/api/vault/${encodeURIComponent(key)}`);
    state.key = key;
    state.vault = vault;
    $('#vault-key').textContent = formatKey(key);
    $('#text-area').value = vault.text || '';
    $('#text-status').textContent = '';
    renderFiles();
    renderVaultMeta();
    addRecent(key);
    if (location.hash.slice(1).toUpperCase().replace(/[^A-Z0-9]/g, '') !== key) {
      location.hash = key;
    }
    showScreen('screen-vault');
    return true;
  } catch (err) {
    toast(err.message, true);
    return false;
  } finally {
    if (!opts || !opts.silent) $('#btn-enter').disabled = false;
  }
}

function exitVault() {
  state.key = null;
  state.vault = null;
  location.hash = '';
  showScreen('screen-home');
  $('#input-key').value = '';
}

function renderVaultMeta() {
  const v = state.vault;
  const total = (v.files || []).reduce((s, f) => s + f.size, 0);
  $('#vault-meta').textContent =
    `创建于 ${formatTime(v.created)} · ${v.files.length} 个文件 · 合计 ${formatSize(total)}`;
}

/* ---------------- 文件列表 ---------------- */

function fileIcon(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) return 'img';
  if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext)) return '🎬';
  if (['mp3', 'wav', 'flac', 'm4a', 'aac'].includes(ext)) return '🎵';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return '🗜️';
  if (['doc', 'docx'].includes(ext)) return '📄';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return '📊';
  if (['ppt', 'pptx'].includes(ext)) return '📽️';
  if (['pdf'].includes(ext)) return '📕';
  if (['txt', 'md', 'json', 'log'].includes(ext)) return '📃';
  return '📎';
}

function isImage(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(ext);
}

function fileUrl(key, id, inline) {
  return `/api/file/${encodeURIComponent(key)}/${id}${inline ? '?dis=inline' : ''}`;
}

function renderFiles() {
  const list = $('#file-list');
  const files = state.vault.files || [];
  $('#file-empty').style.display = files.length ? 'none' : '';
  list.innerHTML = files.map((f) => {
    const thumb = isImage(f.name)
      ? `<img class="file-thumb" loading="lazy" src="${fileUrl(state.key, f.id, true)}" alt="" onerror="this.outerHTML='<div class=file-icon>🖼️</div>'">`
      : `<div class="file-icon">${fileIcon(f.name)}</div>`;
    return `<li class="file-row" data-id="${f.id}">
      ${thumb}
      <div class="file-info">
        <div class="file-name" title="${esc(f.name)}">${esc(f.name)}</div>
        <div class="file-sub">${formatSize(f.size)} · ${formatTime(f.time)}</div>
      </div>
      <div class="file-actions">
        <a class="btn ghost small" href="${fileUrl(state.key, f.id)}" download="${esc(f.name)}">⬇️ 下载</a>
        <button class="btn ghost small" data-del="${f.id}">🗑️ 删除</button>
      </div>
    </li>`;
  }).join('');

  list.querySelectorAll('[data-del]').forEach((btn) => {
    btn.addEventListener('click', () => deleteFile(btn.dataset.del));
  });
  list.querySelectorAll('.file-thumb').forEach((img) => {
    img.addEventListener('click', () => window.open(img.src, '_blank'));
  });
}

function renderVaultMetaSafe() {
  renderVaultMeta();
}

async function deleteFile(id) {
  const f = (state.vault.files || []).find((x) => x.id === id);
  if (!f) return;
  if (!confirm(`确定删除文件「${f.name}」吗？此操作不可恢复。`)) return;
  try {
    await api(`/api/file/${encodeURIComponent(state.key)}/${id}`, { method: 'DELETE' });
    state.vault.files = state.vault.files.filter((x) => x.id !== id);
    renderFiles();
    renderVaultMetaSafe();
    toast('文件已删除');
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------------- 上传 ---------------- */

function uploadOne(file) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/upload/${encodeURIComponent(state.key)}?name=${encodeURIComponent(file.name)}`);
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) updateProgress(file, e.loaded, e.total);
    });
    xhr.addEventListener('load', () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      if (xhr.status === 200) resolve(data);
      else reject(new Error(data.error || `上传失败（${xhr.status}）`));
    });
    xhr.addEventListener('error', () => reject(new Error('网络错误，上传失败')));
    xhr.addEventListener('abort', () => reject(new Error('上传已取消')));
    xhr.send(file);
  });
}

function updateProgress(file, loaded, total) {
  const row = document.querySelector(`.upload-row[data-upload="${CSS.escape(file.name + file.size)}"]`);
  if (!row) return;
  row.querySelector('.progress > div').style.width = Math.round((loaded / total) * 100) + '%';
  row.querySelector('.file-sub').textContent =
    `${formatSize(loaded)} / ${formatSize(total)}（${Math.round((loaded / total) * 100)}%）`;
}

async function handleFiles(fileArr) {
  if (!fileArr.length || !state.key) return;
  const list = $('#upload-list');

  for (const file of fileArr) {
    const token = file.name + file.size;
    const row = document.createElement('div');
    row.className = 'file-row upload-row';
    row.dataset.upload = token;
    row.innerHTML = `
      <div class="file-icon">${fileIcon(file.name)}</div>
      <div class="file-info">
        <div class="file-name">${esc(file.name)}</div>
        <div class="file-sub">准备上传…</div>
        <div class="progress"><div></div></div>
      </div>`;
    list.prepend(row);
  }

  for (const file of fileArr) {
    try {
      const entry = await uploadOne(file);
      state.vault.files.unshift(entry);
    } catch (err) {
      toast(`「${file.name}」${err.message}`, true);
    }
    const row = document.querySelector(`.upload-row[data-upload="${CSS.escape(file.name + file.size)}"]`);
    if (row) row.remove();
  }
  renderFiles();
  renderVaultMetaSafe();
}

/* ---------------- 保存文字 ---------------- */

let textSaveTimer = null;
async function saveText() {
  const btn = $('#btn-save-text');
  btn.disabled = true;
  $('#text-status').textContent = '保存中…';
  try {
    await api(`/api/text/${encodeURIComponent(state.key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: $('#text-area').value }),
    });
    state.vault.text = $('#text-area').value;
    $('#text-status').textContent = `已保存 ${formatTime(Date.now()).slice(11)}`;
    toast('文字资料已保存');
  } catch (err) {
    $('#text-status').textContent = '';
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
}

/* ---------------- 事件绑定 ---------------- */

$('#btn-create').addEventListener('click', createKey);

$('#btn-enter').addEventListener('click', () => enterVault($('#input-key').value));

$('#input-key').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') enterVault($('#input-key').value);
});

// 输入时自动大写、自动补全分隔线的视觉体验交给 CSS text-transform
$('#input-key').addEventListener('input', () => {
  const pos = $('#input-key').value.length;
  if (pos === 12 && KEY_RE.test(normalizeKey($('#input-key').value))) {
    enterVault($('#input-key').value);
  }
});

$('#btn-copy-new').addEventListener('click', () => copyText($('#new-key').textContent, '密钥已复制，请妥善保存！'));
$('#btn-copy-link').addEventListener('click', () =>
  copyText(location.origin + '/#' + $('#new-key').textContent, '访问链接已复制'));
$('#btn-go-vault').addEventListener('click', () => enterVault($('#new-key').textContent));
$('#btn-back-home').addEventListener('click', () => showScreen('screen-home'));

$('#btn-copy-key').addEventListener('click', () => copyText(formatKey(state.key), '密钥已复制'));
$('#vault-key').addEventListener('click', () => copyText(formatKey(state.key), '密钥已复制'));
$('#btn-exit').addEventListener('click', exitVault);

$('#btn-save-text').addEventListener('click', saveText);
$('#text-area').addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); saveText(); }
});

const dz = $('#dropzone');
const fi = $('#file-input');
dz.addEventListener('click', () => fi.click());
fi.addEventListener('change', () => {
  handleFiles(Array.from(fi.files));
  fi.value = '';
});
['dragenter', 'dragover'].forEach((ev) =>
  dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('dragover'); }));
['dragleave', 'drop'].forEach((ev) =>
  dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('dragover'); }));
dz.addEventListener('drop', (e) => handleFiles(Array.from(e.dataTransfer.files)));

$('#btn-del-vault').addEventListener('click', async () => {
  if (!confirm(`确定要删除整个空间吗？\n\n密钥 ${state.key} 下的所有文字资料和文件都会被永久删除，此操作不可恢复！`)) return;
  if (!confirm('再次确认：真的要删除吗？')) return;
  try {
    await api(`/api/vault/${encodeURIComponent(state.key)}`, { method: 'DELETE' });
    removeRecent(state.key);
    toast('空间已删除');
    exitVault();
  } catch (err) {
    toast(err.message, true);
  }
});

window.addEventListener('hashchange', () => {
  const key = normalizeKey(location.hash.slice(1));
  if (KEY_RE.test(key) && key !== state.key) {
    enterVault(key);
  } else if (!key && state.key) {
    exitVault();
  }
});

/* ---------------- 启动 ---------------- */

renderRecent();

// 支持 #K7M2-9QX4-BT8F 这样的直达链接
const hashKey = normalizeKey(location.hash.slice(1));
if (KEY_RE.test(hashKey)) {
  enterVault(hashKey);
} else {
  showScreen('screen-home');
}
