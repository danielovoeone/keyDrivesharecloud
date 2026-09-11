/**
 * KeyDrive —— 免登录密钥共享空间
 *
 * 零依赖，仅需 Node.js（建议 16+）。运行：node server.js
 * 环境变量：PORT（默认 3000）、HOST（默认 0.0.0.0）、MAX_FILE_MB（单文件上限，默认 200）
 *
 * 数据全部保存在 ./data/vaults/<sha256(密钥)>/ 目录下：
 *   meta.json    —— 文字资料 + 文件列表
 *   files/<id>   —— 上传的文件内容
 * 服务器只保存密钥的哈希，不保存明文密钥。
 */
'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_FILE = (parseInt(process.env.MAX_FILE_MB, 10) || 200) * 1024 * 1024;
const MAX_TEXT = 200 * 1024; // 文字资料上限 200KB
const MAX_JSON = 256 * 1024;

const DATA_DIR = path.join(__dirname, 'data', 'vaults');
const PUBLIC_DIR = path.join(__dirname, 'public');

// 密钥字符表：去掉了 0/O、1/I/L 等易混淆字符
const KEY_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const KEY_LENGTH = 12;
const KEY_RE = new RegExp(`^[${KEY_ALPHABET}]{${KEY_LENGTH}}$`);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

/* ---------------- 密钥与存储 ---------------- */

function generateKey() {
  const bytes = crypto.randomBytes(KEY_LENGTH);
  const chars = Array.from(bytes, (b) => KEY_ALPHABET[b % KEY_ALPHABET.length]);
  return chars.join('').replace(/(.{4})(?=.)/g, '$1-'); // XXXX-XXXX-XXXX
}

function normalizeKey(raw) {
  const key = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!KEY_RE.test(key)) return null;
  return key;
}

// 统一按“去分隔符后的规范密钥”取哈希，保证带连字符与不带连字符指向同一目录
const keyHash = (key) => crypto.createHash('sha256').update(normalizeKey(key) || String(key), 'utf8').digest('hex');
const vaultDir = (key) => path.join(DATA_DIR, keyHash(key));

async function readMeta(dir) {
  const raw = await fsp.readFile(path.join(dir, 'meta.json'), 'utf8');
  return JSON.parse(raw);
}

async function writeMeta(dir, meta) {
  const tmp = path.join(dir, `meta.${process.pid}.${Date.now()}.tmp`);
  await fsp.writeFile(tmp, JSON.stringify(meta, null, 2), 'utf8');
  await fsp.rename(tmp, path.join(dir, 'meta.json'));
}

// 同一空间的元数据写操作串行化，避免并发互相覆盖
const locks = new Map();
function withLock(hash, fn) {
  const run = (locks.get(hash) || Promise.resolve()).then(fn, fn);
  locks.set(hash, run.catch(() => {}));
  return run;
}

async function vaultExists(key) {
  try {
    await fsp.access(path.join(vaultDir(key), 'meta.json'));
    return true;
  } catch {
    return false;
  }
}

function sanitizeName(raw) {
  let name = String(raw || '').slice(0, 200).replace(/[\u0000-\u001f\u007f"\\/]/g, '').trim();
  return name || '未命名文件';
}

function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

/* ---------------- HTTP 基础工具 ---------------- */

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function readJsonBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        chunks.length = 0;
        req.removeAllListeners('data');
        req.resume(); // 排空剩余数据，让 413 响应能正常送达
        reject(Object.assign(new Error('内容过大'), { status: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('JSON 格式错误'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

// 把请求体（原始文件内容）流式写入磁盘，超过上限立即中止
function streamToFile(req, dest, limit) {
  return new Promise((resolve, reject) => {
    let received = 0;
    let done = false;
    const ws = fs.createWriteStream(dest);
    const fail = (err) => {
      if (done) return;
      done = true;
      ws.end(() => fsp.unlink(dest).catch(() => {}));
      reject(err);
    };
    req.on('data', (chunk) => {
      if (done) return;
      received += chunk.length;
      if (received > limit) {
        req.removeAllListeners('data');
        req.removeAllListeners('end');
        req.destroy();
        fail(Object.assign(new Error('文件过大'), { status: 413 }));
        return;
      }
      ws.write(chunk);
    });
    req.on('end', () => {
      if (done) return;
      ws.end(() => {
        done = true;
        resolve(received);
      });
    });
    req.on('error', () => fail(Object.assign(new Error('上传中断'), { status: 400 })));
    ws.on('error', () => fail(Object.assign(new Error('写入失败'), { status: 500 })));
  });
}

/* ---------------- API 处理 ---------------- */

async function handleApi(req, res, pathname, url) {
  const parts = pathname.split('/').filter(Boolean); // ['api', ...]

  // POST /api/create —— 创建新密钥
  if (req.method === 'POST' && pathname === '/api/create') {
    for (let i = 0; i < 5; i++) {
      const key = generateKey();
      if (await vaultExists(key)) continue;
      const dir = vaultDir(key);
      await fsp.mkdir(path.join(dir, 'files'), { recursive: true });
      await writeMeta(dir, { created: Date.now(), updatedAt: Date.now(), text: '', files: [] });
      return sendJson(res, 200, { key });
    }
    return sendJson(res, 500, { error: '创建失败，请重试' });
  }

  // 以下接口的路径形如 /api/<资源>/<密钥>[/<文件ID>]
  if (parts[0] !== 'api' || parts.length < 3) return sendJson(res, 404, { error: '接口不存在' });

  const key = normalizeKey(parts[2]);
  if (!key) {
    req.resume(); // 把未读取的请求体排空，避免提前响应导致客户端连接被重置
    return sendJson(res, 400, { error: '密钥格式不正确（应为 12 位字母数字，例如 K7M2-9QX4-BT8F）' });
  }
  const dir = vaultDir(key);
  const hash = keyHash(key);

  // GET /api/vault/:key —— 空间内容
  if (req.method === 'GET' && parts[1] === 'vault' && parts.length === 3) {
    let meta;
    try {
      meta = await readMeta(dir);
    } catch {
      return sendJson(res, 404, { error: '该密钥不存在，请检查是否输入正确' });
    }
    return sendJson(res, 200, {
      key,
      created: meta.created,
      text: meta.text || '',
      files: meta.files || [],
    });
  }

  // POST /api/text/:key —— 保存文字资料
  if (req.method === 'POST' && parts[1] === 'text' && parts.length === 3) {
    if (!(await vaultExists(key))) return sendJson(res, 404, { error: '该密钥不存在' });
    const body = await readJsonBody(req, MAX_JSON);
    const text = String(body.text ?? '');
    if (Buffer.byteLength(text, 'utf8') > MAX_TEXT) {
      return sendJson(res, 413, { error: '文字资料过长（上限约 20 万字符）' });
    }
    await withLock(hash, async () => {
      const meta = await readMeta(dir);
      meta.text = text;
      meta.updatedAt = Date.now();
      await writeMeta(dir, meta);
    });
    return sendJson(res, 200, { ok: true });
  }

  // POST /api/upload/:key?name=xxx —— 上传文件（请求体为原始文件内容）
  if (req.method === 'POST' && parts[1] === 'upload' && parts.length === 3) {
    if (!(await vaultExists(key))) return sendJson(res, 404, { error: '该密钥不存在' });
    const name = sanitizeName(url.searchParams.get('name'));
    const contentLength = parseInt(req.headers['content-length'], 10);
    if (Number.isFinite(contentLength) && contentLength > MAX_FILE) {
      req.resume();
      return sendJson(res, 413, { error: `文件过大，单个文件上限 ${formatBytes(MAX_FILE)}` });
    }
    const id = crypto.randomBytes(8).toString('hex');
    const dest = path.join(dir, 'files', id);
    await streamToFile(req, dest, MAX_FILE);
    const size = (await fsp.stat(dest)).size;
    const entry = { id, name, size, time: Date.now() };
    await withLock(hash, async () => {
      const meta = await readMeta(dir);
      meta.files = meta.files || [];
      meta.files.unshift(entry);
      meta.updatedAt = Date.now();
      await writeMeta(dir, meta);
    });
    return sendJson(res, 200, entry);
  }

  // GET /api/file/:key/:id —— 下载/预览文件
  if (req.method === 'GET' && parts[1] === 'file' && parts.length === 4) {
    let meta;
    try {
      meta = await readMeta(dir);
    } catch {
      return sendJson(res, 404, { error: '该密钥不存在' });
    }
    const id = parts[3];
    if (!/^[a-f0-9]{16}$/.test(id)) return sendJson(res, 400, { error: '文件 ID 不合法' });
    const entry = (meta.files || []).find((f) => f.id === id);
    if (!entry) return sendJson(res, 404, { error: '文件不存在或已被删除' });
    const filePath = path.join(dir, 'files', id);
    let stat;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      return sendJson(res, 404, { error: '文件不存在或已被删除' });
    }
    const asciiName = entry.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': stat.size,
      'Content-Disposition': `${url.searchParams.get('dis') === 'inline' ? 'inline' : 'attachment'}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(entry.name)}`,
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  // DELETE /api/file/:key/:id —— 删除文件
  if (req.method === 'DELETE' && parts[1] === 'file' && parts.length === 4) {
    if (!(await vaultExists(key))) return sendJson(res, 404, { error: '该密钥不存在' });
    const id = parts[3];
    if (!/^[a-f0-9]{16}$/.test(id)) return sendJson(res, 400, { error: '文件 ID 不合法' });
    await withLock(hash, async () => {
      const meta = await readMeta(dir);
      const before = (meta.files || []).length;
      meta.files = (meta.files || []).filter((f) => f.id !== id);
      meta.updatedAt = Date.now();
      await writeMeta(dir, meta);
      if (meta.files.length !== before) await fsp.unlink(path.join(dir, 'files', id)).catch(() => {});
    });
    return sendJson(res, 200, { ok: true });
  }

  // DELETE /api/vault/:key —— 删除整个空间
  if (req.method === 'DELETE' && parts[1] === 'vault' && parts.length === 3) {
    if (!(await vaultExists(key))) return sendJson(res, 404, { error: '该密钥不存在' });
    await fsp.rm(dir, { recursive: true, force: true });
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: '接口不存在' });
}

/* ---------------- 静态文件 ---------------- */

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

/* ---------------- 服务器 ---------------- */

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return sendJson(res, 400, { error: '请求不合法' });
  }
  const pathname = decodeURIComponent(url.pathname);

  try {
    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname, url);
    } else if (req.method === 'GET' || req.method === 'HEAD') {
      serveStatic(res, pathname);
    } else {
      sendJson(res, 405, { error: '方法不允许' });
    }
  } catch (err) {
    req.resume();
    if (!res.headersSent) {
      sendJson(res, err.status || 500, { error: err.status ? err.message : '服务器内部错误' });
    } else {
      res.end();
    }
    if (!err.status) console.error(err);
  }
});

fsp.mkdir(path.join(DATA_DIR), { recursive: true }).then(() => {
  server.listen(PORT, HOST, () => {
    console.log('');
    console.log('  ✅ KeyDrive 密钥共享空间已启动');
    console.log(`  本机访问:   http://localhost:${PORT}`);
    console.log(`  局域网访问: http://<你的IP>:${PORT}  （把 IP 告诉同一网络里的朋友）`);
    console.log(`  数据目录:   ${DATA_DIR}`);
    console.log(`  单文件上限: ${formatBytes(MAX_FILE)}（可用环境变量 MAX_FILE_MB 调整）`);
    console.log('');
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用，请换一个端口启动，例如：PORT=3001 node server.js`);
    process.exit(1);
  }
  throw err;
});
