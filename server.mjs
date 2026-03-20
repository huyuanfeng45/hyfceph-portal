#!/usr/bin/env node

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOST = process.env.HYFCEPH_HOST || '127.0.0.1';
const PORT = Number(process.env.HYFCEPH_PORT || '3077');
const COOKIE_NAME = 'hyfceph_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const DEFAULT_API_KEY_DAYS = Number(process.env.HYFCEPH_API_KEY_DAYS || '90');
const ADMIN_USERNAME = process.env.HYFCEPH_ADMIN_USERNAME || 'huyuanfeng45';
const ADMIN_PASSWORD = process.env.HYFCEPH_ADMIN_PASSWORD || '85301298';
const BARK_DEVICE_KEY = process.env.HYFCEPH_BARK_KEY || '7ffBf7F85e3WbFyKrJTEcH';
const BARK_BASE_URL = (process.env.HYFCEPH_BARK_BASE_URL || 'https://api.day.app').replace(/\/+$/, '');
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const sessions = new Map();

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
]);

function nowIso() {
  return new Date().toISOString();
}

function addDaysIso(days) {
  const value = new Date();
  value.setDate(value.getDate() + days);
  return value.toISOString();
}

function normalizePhone(value) {
  return String(value || '').replace(/[^\d+]/g, '');
}

function normalizeUsername(value) {
  return String(value || '').trim();
}

function normalizeIdentifier(value) {
  return String(value || '').trim();
}

function validatePhone(value) {
  const normalized = normalizePhone(value);
  return normalized.length >= 6 && normalized.length <= 20;
}

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  const [salt, hashHex] = String(storedHash || '').split(':');
  if (!salt || !hashHex) {
    return false;
  }
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function generateApiKey() {
  return `hyf_${randomBytes(24).toString('hex')}`;
}

function parseCookies(request) {
  const raw = request.headers.cookie || '';
  return Object.fromEntries(
    raw
      .split(';')
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const separator = item.indexOf('=');
        if (separator === -1) return [item, ''];
        return [item.slice(0, separator), decodeURIComponent(item.slice(separator + 1))];
      }),
  );
}

function sendJson(response, statusCode, payload, extraHeaders = {}) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  response.end(JSON.stringify(payload));
}

function sendText(response, statusCode, body, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(statusCode, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

function isIsoDate(value) {
  return typeof value === 'string' && !Number.isNaN(new Date(value).getTime());
}

function isApiKeyActive(user) {
  if (!user?.apiKey || !user?.apiKeyExpiresAt) {
    return false;
  }
  return new Date(user.apiKeyExpiresAt).getTime() > Date.now();
}

function publicUser(user) {
  return {
    id: user.id,
    role: user.role,
    username: user.username || null,
    name: user.name,
    organization: user.organization,
    phone: user.phone,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt || null,
    apiKey: user.apiKey || null,
    apiKeyExpiresAt: user.apiKeyExpiresAt || null,
    apiKeyActive: isApiKeyActive(user),
  };
}

function normalizeUserRecord(user) {
  return {
    id: String(user?.id || randomBytes(12).toString('hex')),
    role: user?.role === 'admin' ? 'admin' : 'user',
    username: user?.username ? normalizeUsername(user.username) : null,
    name: String(user?.name || '').trim(),
    organization: String(user?.organization || '').trim(),
    phone: normalizePhone(user?.phone || ''),
    passwordHash: String(user?.passwordHash || ''),
    apiKey: typeof user?.apiKey === 'string' && user.apiKey.trim() ? user.apiKey.trim() : null,
    apiKeyExpiresAt: isIsoDate(user?.apiKeyExpiresAt) ? new Date(user.apiKeyExpiresAt).toISOString() : null,
    createdAt: isIsoDate(user?.createdAt) ? new Date(user.createdAt).toISOString() : nowIso(),
    updatedAt: isIsoDate(user?.updatedAt) ? new Date(user.updatedAt).toISOString() : nowIso(),
    lastLoginAt: isIsoDate(user?.lastLoginAt) ? new Date(user.lastLoginAt).toISOString() : null,
  };
}

async function ensureDataFile() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(USERS_FILE);
  } catch {
    await fs.writeFile(USERS_FILE, JSON.stringify({ users: [] }, null, 2));
  }
}

async function writeStore(store) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tempPath = `${USERS_FILE}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(store, null, 2));
  await fs.rename(tempPath, USERS_FILE);
}

function ensureAdminUser(store) {
  let changed = false;
  const users = Array.isArray(store.users) ? store.users.map(normalizeUserRecord) : [];
  const existingAdmin = users.find((item) => item.role === 'admin' || item.username === ADMIN_USERNAME);
  if (!existingAdmin) {
    users.push({
      id: randomBytes(12).toString('hex'),
      role: 'admin',
      username: ADMIN_USERNAME,
      name: 'HYFCeph 管理员',
      organization: 'HYFCeph',
      phone: '',
      passwordHash: hashPassword(ADMIN_PASSWORD),
      apiKey: null,
      apiKeyExpiresAt: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      lastLoginAt: null,
    });
    changed = true;
  }
  return { store: { users }, changed };
}

async function readStore() {
  await ensureDataFile();
  const raw = await fs.readFile(USERS_FILE, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = { users: [] };
  }
  const { store, changed } = ensureAdminUser(parsed && typeof parsed === 'object' ? parsed : { users: [] });
  if (changed || JSON.stringify(parsed) !== JSON.stringify(store)) {
    await writeStore(store);
  }
  return store;
}

async function readRequestJson(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('请求体不是合法的 JSON');
  }
}

function createSession(userId) {
  const sessionId = randomBytes(24).toString('hex');
  sessions.set(sessionId, {
    userId,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  return sessionId;
}

function setSessionCookie(response, sessionId) {
  response.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(sessionId)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
}

function clearSessionCookie(response) {
  response.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}

function cleanupExpiredSessions() {
  const current = Date.now();
  for (const [sessionId, session] of sessions.entries()) {
    if (!session || session.expiresAt <= current) {
      sessions.delete(sessionId);
    }
  }
}

async function getSessionUser(request) {
  cleanupExpiredSessions();
  const cookies = parseCookies(request);
  const sessionId = cookies[COOKIE_NAME];
  if (!sessionId) {
    return null;
  }
  const session = sessions.get(sessionId);
  if (!session) {
    return null;
  }
  const store = await readStore();
  const user = store.users.find((item) => item.id === session.userId);
  if (!user) {
    sessions.delete(sessionId);
    return null;
  }
  return user;
}

async function requireAdmin(request, response) {
  const currentUser = await getSessionUser(request);
  if (!currentUser) {
    sendJson(response, 401, { error: '请先登录。' });
    return null;
  }
  if (currentUser.role !== 'admin') {
    sendJson(response, 403, { error: '仅管理员可操作。' });
    return null;
  }
  return currentUser;
}

function findUserByIdentifier(store, identifier) {
  const normalizedIdentifier = normalizeIdentifier(identifier);
  const normalizedPhone = normalizePhone(identifier);
  return store.users.find((item) => {
    if (item.phone && item.phone === normalizedPhone) {
      return true;
    }
    if (item.username && item.username.toLowerCase() === normalizedIdentifier.toLowerCase()) {
      return true;
    }
    return false;
  });
}

async function sendBarkPush(title, body) {
  if (!BARK_DEVICE_KEY) {
    return;
  }
  const url = new URL(`${BARK_BASE_URL}/${encodeURIComponent(BARK_DEVICE_KEY)}/${encodeURIComponent(title)}/${encodeURIComponent(body)}`);
  url.searchParams.set('group', 'HYFCeph');
  url.searchParams.set('isArchive', '1');
  try {
    await fetch(url, { method: 'GET' });
  } catch (error) {
    console.warn('Bark push failed:', error instanceof Error ? error.message : String(error));
  }
}

async function handleRegister(request, response) {
  const payload = await readRequestJson(request);
  const name = String(payload.name || '').trim();
  const organization = String(payload.organization || '').trim();
  const phone = normalizePhone(payload.phone);
  const password = String(payload.password || '');

  if (!name || !organization || !phone || !password) {
    return sendJson(response, 400, { error: '请完整填写名字、单位、手机号和密码。' });
  }
  if (!validatePhone(phone)) {
    return sendJson(response, 400, { error: '手机号格式不正确。' });
  }
  if (password.length < 6) {
    return sendJson(response, 400, { error: '密码至少需要 6 位。' });
  }

  const store = await readStore();
  if (store.users.some((item) => item.phone === phone)) {
    return sendJson(response, 409, { error: '该手机号已注册，请直接登录。' });
  }

  const user = {
    id: randomBytes(12).toString('hex'),
    role: 'user',
    username: null,
    name,
    organization,
    phone,
    passwordHash: hashPassword(password),
    apiKey: null,
    apiKeyExpiresAt: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    lastLoginAt: nowIso(),
  };
  store.users.push(user);
  await writeStore(store);

  const sessionId = createSession(user.id);
  setSessionCookie(response, sessionId);
  await sendBarkPush('HYFCeph 新注册', `名字：${name}\n单位：${organization}\n手机号：${phone}`);

  return sendJson(response, 201, {
    message: '注册成功，已进入控制台。',
    user: publicUser(user),
  });
}

async function handleLogin(request, response) {
  const payload = await readRequestJson(request);
  const identifier = normalizeIdentifier(payload.identifier || payload.phone || payload.username);
  const password = String(payload.password || '');

  if (!identifier || !password) {
    return sendJson(response, 400, { error: '请输入账号或手机号，以及密码。' });
  }

  const store = await readStore();
  const user = findUserByIdentifier(store, identifier);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return sendJson(response, 401, { error: '账号或密码错误。' });
  }

  user.lastLoginAt = nowIso();
  user.updatedAt = nowIso();
  await writeStore(store);

  const sessionId = createSession(user.id);
  setSessionCookie(response, sessionId);
  return sendJson(response, 200, {
    message: '登录成功。',
    user: publicUser(user),
  });
}

async function handleLogout(request, response) {
  const cookies = parseCookies(request);
  if (cookies[COOKIE_NAME]) {
    sessions.delete(cookies[COOKIE_NAME]);
  }
  clearSessionCookie(response);
  return sendJson(response, 200, { ok: true });
}

async function handleCurrentUser(request, response) {
  const user = await getSessionUser(request);
  if (!user) {
    return sendJson(response, 401, { error: '未登录。' });
  }
  return sendJson(response, 200, { user: publicUser(user) });
}

async function handleGenerateApiKey(request, response) {
  const currentUser = await getSessionUser(request);
  if (!currentUser) {
    return sendJson(response, 401, { error: '请先登录。' });
  }

  const store = await readStore();
  const user = store.users.find((item) => item.id === currentUser.id);
  if (!user) {
    return sendJson(response, 404, { error: '用户不存在。' });
  }

  user.apiKey = generateApiKey();
  user.apiKeyExpiresAt = addDaysIso(DEFAULT_API_KEY_DAYS);
  user.updatedAt = nowIso();
  await writeStore(store);

  return sendJson(response, 200, {
    message: 'API Key 已生成。',
    apiKey: user.apiKey,
    user: publicUser(user),
  });
}

async function handleValidateApiKey(request, response) {
  const payload = await readRequestJson(request);
  const apiKey = String(payload.apiKey || request.headers['x-api-key'] || '').trim();
  if (!apiKey) {
    return sendJson(response, 400, { error: '缺少 API Key。' });
  }

  const store = await readStore();
  const user = store.users.find((item) => item.apiKey === apiKey);
  if (!user) {
    return sendJson(response, 401, { valid: false, error: 'API Key 无效。' });
  }
  if (!isApiKeyActive(user)) {
    return sendJson(response, 403, {
      valid: false,
      error: 'API Key 已过期，请联系管理员或重新生成。',
      expiresAt: user.apiKeyExpiresAt,
    });
  }

  return sendJson(response, 200, {
    valid: true,
    owner: {
      id: user.id,
      name: user.name,
      organization: user.organization,
      phone: user.phone,
    },
    expiresAt: user.apiKeyExpiresAt,
  });
}

async function handleSkillEvent(request, response) {
  const payload = await readRequestJson(request);
  const apiKey = String(payload.apiKey || '').trim();
  const eventType = String(payload.eventType || '').trim();
  const imageName = String(payload.imageName || '').trim();
  const imageSource = String(payload.imageSource || '').trim();

  if (!apiKey) {
    return sendJson(response, 400, { error: '缺少 API Key。' });
  }
  if (!eventType) {
    return sendJson(response, 400, { error: '缺少事件类型。' });
  }

  const store = await readStore();
  const user = store.users.find((item) => item.apiKey === apiKey);
  if (!user || !isApiKeyActive(user)) {
    return sendJson(response, 401, { error: 'API Key 无效或已过期。' });
  }

  if (eventType === 'image_submission') {
    const body = [
      `用户：${user.name}`,
      `单位：${user.organization || '-'}`,
      `手机号：${user.phone || '-'}`,
      `图片：${imageName || '未命名图片'}`,
      `来源：${imageSource || 'unknown'}`,
    ].join('\n');
    await sendBarkPush('HYFCeph 技能提交侧位片', body);
  }

  return sendJson(response, 200, { ok: true });
}

async function handleAdminUsers(request, response) {
  const adminUser = await requireAdmin(request, response);
  if (!adminUser) return;

  const store = await readStore();
  const users = [...store.users]
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
    .map(publicUser);

  return sendJson(response, 200, {
    currentAdmin: publicUser(adminUser),
    users,
  });
}

async function handleAdminUpdateApiKey(request, response, userId) {
  const adminUser = await requireAdmin(request, response);
  if (!adminUser) return;

  const payload = await readRequestJson(request);
  const expiresAt = String(payload.expiresAt || '').trim();
  if (!isIsoDate(expiresAt)) {
    return sendJson(response, 400, { error: '请提供合法的过期时间。' });
  }

  const store = await readStore();
  const user = store.users.find((item) => item.id === userId);
  if (!user) {
    return sendJson(response, 404, { error: '用户不存在。' });
  }
  if (!user.apiKey) {
    return sendJson(response, 400, { error: '该用户还没有 API Key。' });
  }

  user.apiKeyExpiresAt = new Date(expiresAt).toISOString();
  user.updatedAt = nowIso();
  await writeStore(store);

  return sendJson(response, 200, {
    message: 'API Key 有效期已更新。',
    user: publicUser(user),
  });
}

async function handleAdminDeleteApiKey(request, response, userId) {
  const adminUser = await requireAdmin(request, response);
  if (!adminUser) return;

  const store = await readStore();
  const user = store.users.find((item) => item.id === userId);
  if (!user) {
    return sendJson(response, 404, { error: '用户不存在。' });
  }

  user.apiKey = null;
  user.apiKeyExpiresAt = null;
  user.updatedAt = nowIso();
  await writeStore(store);

  return sendJson(response, 200, {
    message: 'API Key 已删除。',
    user: publicUser(user),
  });
}

async function serveStaticFile(requestPath, response) {
  let filePath = path.join(PUBLIC_DIR, requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    return sendText(response, 403, 'Forbidden');
  }

  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
    const content = await fs.readFile(filePath);
    const contentType = MIME_TYPES.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream';
    response.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': filePath.endsWith('index.html') ? 'no-store' : 'public, max-age=3600',
    });
    response.end(content);
  } catch {
    sendText(response, 404, 'Not Found');
  }
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://${request.headers.host || `${HOST}:${PORT}`}`);

    if (request.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(response, 200, {
        ok: true,
        service: 'HYFCeph Portal',
        barkConfigured: Boolean(BARK_DEVICE_KEY),
      });
    }
    if (request.method === 'POST' && url.pathname === '/api/register') {
      return await handleRegister(request, response);
    }
    if (request.method === 'POST' && url.pathname === '/api/login') {
      return await handleLogin(request, response);
    }
    if (request.method === 'POST' && url.pathname === '/api/logout') {
      return await handleLogout(request, response);
    }
    if (request.method === 'GET' && url.pathname === '/api/me') {
      return await handleCurrentUser(request, response);
    }
    if (request.method === 'POST' && url.pathname === '/api/api-key/generate') {
      return await handleGenerateApiKey(request, response);
    }
    if (request.method === 'POST' && url.pathname === '/api/validate-key') {
      return await handleValidateApiKey(request, response);
    }
    if (request.method === 'POST' && url.pathname === '/api/skill-events') {
      return await handleSkillEvent(request, response);
    }
    if (request.method === 'GET' && url.pathname === '/api/admin/users') {
      return await handleAdminUsers(request, response);
    }
    if (request.method === 'PATCH' && url.pathname.startsWith('/api/admin/users/') && url.pathname.endsWith('/api-key')) {
      const userId = url.pathname.split('/')[4];
      return await handleAdminUpdateApiKey(request, response, userId);
    }
    if (request.method === 'DELETE' && url.pathname.startsWith('/api/admin/users/') && url.pathname.endsWith('/api-key')) {
      const userId = url.pathname.split('/')[4];
      return await handleAdminDeleteApiKey(request, response, userId);
    }
    if (request.method === 'GET') {
      return await serveStaticFile(url.pathname, response);
    }

    return sendText(response, 405, 'Method Not Allowed');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return sendJson(response, 500, { error: message || '服务器异常。' });
  }
});

await readStore();
server.listen(PORT, HOST, () => {
  console.log(`HYFCeph portal running at http://${HOST}:${PORT}`);
});
