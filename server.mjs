#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOST = process.env.HYFCEPH_HOST || '127.0.0.1';
const PORT = Number(process.env.HYFCEPH_PORT || '3077');
const COOKIE_NAME = 'hyfceph_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const SESSION_SECRET = process.env.HYFCEPH_SESSION_SECRET || `hyfceph:${process.env.HYFCEPH_ADMIN_PASSWORD || '85301298'}:${process.env.HYFCEPH_BARK_KEY || 'bark'}`;
const DEFAULT_API_KEY_DAYS = Number(process.env.HYFCEPH_API_KEY_DAYS || '90');
const DEFAULT_BRIDGE_TTL_MINUTES = Number(process.env.HYFCEPH_BRIDGE_TTL_MINUTES || '30');
const DEFAULT_OPERATOR_SESSION_TTL_MINUTES = Number(process.env.HYFCEPH_OPERATOR_SESSION_TTL_MINUTES || '240');
const ADMIN_USERNAME = process.env.HYFCEPH_ADMIN_USERNAME || 'huyuanfeng45';
const ADMIN_PASSWORD = process.env.HYFCEPH_ADMIN_PASSWORD || '85301298';
const BARK_DEVICE_KEY = process.env.HYFCEPH_BARK_KEY || '7ffBf7F85e3WbFyKrJTEcH';
const BARK_BASE_URL = (process.env.HYFCEPH_BARK_BASE_URL || 'https://api.day.app').replace(/\/+$/, '');
const STORE_BACKEND = process.env.HYFCEPH_STORE_BACKEND || (process.env.BLOB_READ_WRITE_TOKEN ? 'blob' : 'file');
const STORE_BLOB_PATH = process.env.HYFCEPH_STORE_BLOB_PATH || 'hyfceph/users.json';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const MEASUREMENTS_DIR = path.join(DATA_DIR, 'measurements');
const MEASUREMENT_BLOB_PREFIX = process.env.HYFCEPH_MEASUREMENT_BLOB_PREFIX || 'hyfceph/measurements';
const SERVICE_RUNNER = path.join(__dirname, 'scripts', 'hyfceph-remote-runner.mjs');
const LOCAL_CEPH_AUTOPOINT_RUNNER = process.env.HYFCEPH_LOCAL_IMAGE_RUNNER
  || path.join(__dirname, 'engines', 'ceph-autopoint', 'scripts', 'run-ceph-autopoint.cjs');
const MAX_MEASURE_BUFFER_BYTES = 24 * 1024 * 1024;
const MAX_IMAGE_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_MEASUREMENT_HISTORY = Number(process.env.HYFCEPH_MAX_MEASUREMENT_HISTORY || '80');

let blobSdkPromise = null;
let resvgPromise = null;
const execFileAsync = promisify(execFile);

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

function addMinutesIso(minutes) {
  const value = new Date();
  value.setMinutes(value.getMinutes() + minutes);
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

function coerceOptionalNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function sanitizeFileStem(value) {
  const cleaned = String(value || '').trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'ceph-image';
}

function extensionFromUpload({ fileName, mimeType }) {
  const explicitExt = path.extname(String(fileName || '').trim()).toLowerCase();
  if (explicitExt) {
    return explicitExt;
  }

  const mime = String(mimeType || '').toLowerCase();
  if (mime === 'image/png') return '.png';
  if (mime === 'image/jpeg' || mime === 'image/jpg') return '.jpg';
  if (mime === 'image/webp') return '.webp';
  if (mime === 'image/bmp') return '.bmp';
  if (mime === 'image/tiff') return '.tif';
  return '.png';
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

function isBridgeStateActive(bridgeState) {
  if (!bridgeState?.expiresAt) {
    return false;
  }
  return new Date(bridgeState.expiresAt).getTime() > Date.now();
}

function normalizeMeasurementSummary(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const metricValues = entry.metricValues && typeof entry.metricValues === 'object'
    ? Object.fromEntries(
        Object.entries(entry.metricValues)
          .filter(([, value]) => Number.isFinite(Number(value)))
          .map(([key, value]) => [key, Number(value)]),
      )
    : {};

  return {
    id: String(entry.id || randomBytes(10).toString('hex')),
    imageName: String(entry.imageName || 'ceph-image').trim(),
    mode: typeof entry.mode === 'string' && entry.mode.trim() ? entry.mode.trim() : 'image',
    createdAt: isIsoDate(entry.createdAt) ? new Date(entry.createdAt).toISOString() : nowIso(),
    updatedAt: isIsoDate(entry.updatedAt) ? new Date(entry.updatedAt).toISOString() : nowIso(),
    riskLabel: typeof entry.riskLabel === 'string' && entry.riskLabel.trim() ? entry.riskLabel.trim() : null,
    insightPreview: typeof entry.insightPreview === 'string' && entry.insightPreview.trim() ? entry.insightPreview.trim() : null,
    metricValues,
  };
}

function publicMeasurementSummary(entry) {
  if (!entry) {
    return null;
  }
  return {
    id: entry.id,
    imageName: entry.imageName,
    mode: entry.mode,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    riskLabel: entry.riskLabel,
    insightPreview: entry.insightPreview,
    metricValues: entry.metricValues,
  };
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
    measurementCount: Array.isArray(user.measurementHistory) ? user.measurementHistory.length : 0,
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
    currentCaseBridge: normalizeBridgeState(user?.currentCaseBridge),
    measurementHistory: Array.isArray(user?.measurementHistory)
      ? user.measurementHistory.map(normalizeMeasurementSummary).filter(Boolean)
        .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
        .slice(0, MAX_MEASUREMENT_HISTORY)
      : [],
  };
}

function normalizeBridgeState(bridgeState) {
  if (!bridgeState || typeof bridgeState !== 'object') {
    return null;
  }

  const syncedAt = isIsoDate(bridgeState.syncedAt) ? new Date(bridgeState.syncedAt).toISOString() : nowIso();
  const expiresAt = isIsoDate(bridgeState.expiresAt)
    ? new Date(bridgeState.expiresAt).toISOString()
    : addMinutesIso(DEFAULT_BRIDGE_TTL_MINUTES);

  return {
    source: typeof bridgeState.source === 'string' && bridgeState.source.trim()
      ? bridgeState.source.trim()
      : 'portal-bridge',
    syncedAt,
    expiresAt,
    href: typeof bridgeState.href === 'string' && bridgeState.href.trim() ? bridgeState.href.trim() : null,
    title: typeof bridgeState.title === 'string' && bridgeState.title.trim() ? bridgeState.title.trim() : null,
    pageUrl: typeof bridgeState.pageUrl === 'string' && bridgeState.pageUrl.trim() ? bridgeState.pageUrl.trim() : null,
    shareUrl: typeof bridgeState.shareUrl === 'string' && bridgeState.shareUrl.trim() ? bridgeState.shareUrl.trim() : null,
    token: typeof bridgeState.token === 'string' ? bridgeState.token.trim() : '',
    ptId: coerceOptionalNumber(bridgeState.ptId),
    ptVersion: coerceOptionalNumber(bridgeState.ptVersion ?? bridgeState.version),
    accountType: typeof bridgeState.accountType === 'string' && bridgeState.accountType.trim()
      ? bridgeState.accountType.trim()
      : null,
    lang: typeof bridgeState.lang === 'string' && bridgeState.lang.trim()
      ? bridgeState.lang.trim()
      : null,
    userName: typeof bridgeState.userName === 'string' && bridgeState.userName.trim()
      ? bridgeState.userName.trim()
      : null,
    userAgent: typeof bridgeState.userAgent === 'string' && bridgeState.userAgent.trim()
      ? bridgeState.userAgent.trim()
      : null,
  };
}

function normalizeOperatorSession(operatorSession) {
  if (!operatorSession || typeof operatorSession !== 'object') {
    return null;
  }

  const href = typeof operatorSession.href === 'string' && operatorSession.href.trim()
    ? operatorSession.href.trim()
    : null;
  const pageUrl = typeof operatorSession.pageUrl === 'string' && operatorSession.pageUrl.trim()
    ? operatorSession.pageUrl.trim()
    : (href ? new URL('./', href).toString() : 'https://pd.aiyayi.com/latera/');

  const syncedAt = isIsoDate(operatorSession.syncedAt) ? new Date(operatorSession.syncedAt).toISOString() : nowIso();
  const expiresAt = isIsoDate(operatorSession.expiresAt)
    ? new Date(operatorSession.expiresAt).toISOString()
    : addMinutesIso(DEFAULT_OPERATOR_SESSION_TTL_MINUTES);

  return {
    source: typeof operatorSession.source === 'string' && operatorSession.source.trim()
      ? operatorSession.source.trim()
      : 'chrome-extension',
    syncedAt,
    expiresAt,
    href,
    title: typeof operatorSession.title === 'string' && operatorSession.title.trim() ? operatorSession.title.trim() : null,
    pageUrl,
    token: typeof operatorSession.token === 'string' ? operatorSession.token.trim() : '',
    accountType: typeof operatorSession.accountType === 'string' && operatorSession.accountType.trim()
      ? operatorSession.accountType.trim()
      : null,
    lang: typeof operatorSession.lang === 'string' && operatorSession.lang.trim()
      ? operatorSession.lang.trim()
      : null,
    userName: typeof operatorSession.userName === 'string' && operatorSession.userName.trim()
      ? operatorSession.userName.trim()
      : null,
    userAgent: typeof operatorSession.userAgent === 'string' && operatorSession.userAgent.trim()
      ? operatorSession.userAgent.trim()
      : null,
  };
}

function isOperatorSessionActive(operatorSession) {
  if (!operatorSession?.token || !operatorSession?.pageUrl || !operatorSession?.expiresAt) {
    return false;
  }
  return new Date(operatorSession.expiresAt).getTime() > Date.now();
}

function publicOperatorSession(operatorSession) {
  if (!operatorSession) {
    return null;
  }
  return {
    source: operatorSession.source,
    syncedAt: operatorSession.syncedAt,
    expiresAt: operatorSession.expiresAt,
    href: operatorSession.href,
    title: operatorSession.title,
    pageUrl: operatorSession.pageUrl,
    userName: operatorSession.userName,
    accountType: operatorSession.accountType,
    lang: operatorSession.lang,
    hasToken: Boolean(operatorSession.token),
    active: isOperatorSessionActive(operatorSession),
  };
}

function normalizeStoreRecord(store) {
  const source = store && typeof store === 'object' ? store : {};
  return {
    users: Array.isArray(source.users) ? source.users.map(normalizeUserRecord) : [],
    operatorSession: normalizeOperatorSession(source.operatorSession),
  };
}

function base64UrlEncode(value) {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function base64UrlDecode(value) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function signSessionPayload(encodedPayload) {
  return createHmac('sha256', SESSION_SECRET).update(encodedPayload).digest('base64url');
}

function createSessionToken(userId) {
  const encodedPayload = base64UrlEncode(JSON.stringify({
    userId,
    expiresAt: Date.now() + SESSION_TTL_MS,
  }));
  const signature = signSessionPayload(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

function parseSessionToken(token) {
  const [encodedPayload, signature] = String(token || '').split('.');
  if (!encodedPayload || !signature) {
    return null;
  }
  const expectedSignature = signSessionPayload(encodedPayload);
  const expectedBuffer = Buffer.from(expectedSignature);
  const actualBuffer = Buffer.from(signature);
  if (expectedBuffer.length !== actualBuffer.length || !timingSafeEqual(expectedBuffer, actualBuffer)) {
    return null;
  }
  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload));
    if (!payload?.userId || typeof payload.expiresAt !== 'number' || payload.expiresAt <= Date.now()) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function buildSessionCookieValue(token, expired = false) {
  const secureFlag = process.env.VERCEL || process.env.NODE_ENV === 'production' ? '; Secure' : '';
  const maxAge = expired ? 0 : Math.floor(SESSION_TTL_MS / 1000);
  const value = expired ? '' : encodeURIComponent(token);
  return `${COOKIE_NAME}=${value}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${secureFlag}`;
}

function setSessionCookie(response, token) {
  response.setHeader('Set-Cookie', buildSessionCookieValue(token, false));
}

function clearSessionCookie(response) {
  response.setHeader('Set-Cookie', buildSessionCookieValue('', true));
}

function shouldUseBlobStore() {
  return STORE_BACKEND === 'blob';
}

async function loadBlobSdk() {
  if (!blobSdkPromise) {
    blobSdkPromise = import('@vercel/blob');
  }
  return blobSdkPromise;
}

async function ensureDataFile() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(USERS_FILE);
  } catch {
    await fs.writeFile(USERS_FILE, JSON.stringify({ users: [] }, null, 2));
  }
}

async function readStoreFromFile() {
  await ensureDataFile();
  const raw = await fs.readFile(USERS_FILE, 'utf8');
  try {
    return JSON.parse(raw);
  } catch {
    return { users: [] };
  }
}

async function writeStoreToFile(store) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tempPath = `${USERS_FILE}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(store, null, 2));
  await fs.rename(tempPath, USERS_FILE);
}

async function readStoreFromBlob() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error('BLOB_READ_WRITE_TOKEN 未配置，无法使用 Blob 存储。');
  }

  const { get, BlobNotFoundError } = await loadBlobSdk();
  try {
    const result = await get(STORE_BLOB_PATH, {
      access: 'private',
      useCache: false,
    });
    if (!result || result.statusCode !== 200 || !result.stream) {
      return { users: [] };
    }
    const raw = await new Response(result.stream).text();
    return raw.trim() ? JSON.parse(raw) : { users: [] };
  } catch (error) {
    if (error instanceof BlobNotFoundError || error?.name === 'BlobNotFoundError') {
      return { users: [] };
    }
    throw error;
  }
}

async function writeStoreToBlob(store) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error('BLOB_READ_WRITE_TOKEN 未配置，无法写入 Blob 存储。');
  }

  const { put } = await loadBlobSdk();
  await put(STORE_BLOB_PATH, JSON.stringify(store, null, 2), {
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
  });
}

async function writeStore(store) {
  if (shouldUseBlobStore()) {
    return writeStoreToBlob(store);
  }
  return writeStoreToFile(store);
}

function measurementBlobPath(measurementId) {
  return `${MEASUREMENT_BLOB_PREFIX}/${measurementId}.json`;
}

function measurementFilePath(measurementId) {
  return path.join(MEASUREMENTS_DIR, `${measurementId}.json`);
}

async function writeMeasurementRecord(record) {
  const measurementId = String(record?.id || '').trim();
  if (!measurementId) {
    throw new Error('缺少测量记录 ID。');
  }
  const serialized = JSON.stringify(record, null, 2);
  if (shouldUseBlobStore()) {
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      throw new Error('BLOB_READ_WRITE_TOKEN 未配置，无法写入测量记录。');
    }
    const { put } = await loadBlobSdk();
    await put(measurementBlobPath(measurementId), serialized, {
      access: 'private',
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: 'application/json',
    });
    return;
  }

  await fs.mkdir(MEASUREMENTS_DIR, { recursive: true });
  await fs.writeFile(measurementFilePath(measurementId), serialized, 'utf8');
}

async function readMeasurementRecord(measurementId) {
  const id = String(measurementId || '').trim();
  if (!id) {
    return null;
  }

  if (shouldUseBlobStore()) {
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      return null;
    }
    const { get, BlobNotFoundError } = await loadBlobSdk();
    try {
      const result = await get(measurementBlobPath(id), {
        access: 'private',
        useCache: false,
      });
      if (!result || result.statusCode !== 200 || !result.stream) {
        return null;
      }
      const raw = await new Response(result.stream).text();
      return raw.trim() ? JSON.parse(raw) : null;
    } catch (error) {
      if (error instanceof BlobNotFoundError || error?.name === 'BlobNotFoundError') {
        return null;
      }
      throw error;
    }
  }

  try {
    const raw = await fs.readFile(measurementFilePath(id), 'utf8');
    return raw.trim() ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function ensureAdminUser(store) {
  let changed = false;
  const normalizedStore = normalizeStoreRecord(store);
  const users = normalizedStore.users;
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
  return { store: { ...normalizedStore, users }, changed };
}

async function readStore() {
  const parsed = shouldUseBlobStore() ? await readStoreFromBlob() : await readStoreFromFile();
  const normalized = normalizeStoreRecord(parsed);
  const { store, changed } = ensureAdminUser(normalized);
  if (changed || JSON.stringify(normalized) !== JSON.stringify(store)) {
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

function decodeUploadedImagePayload(payload) {
  const imageBase64 = String(payload?.imageBase64 || '').trim();
  const fileName = String(payload?.fileName || payload?.imageName || '').trim();
  const mimeType = String(payload?.mimeType || '').trim();

  if (!imageBase64) {
    throw new Error('缺少图片数据。');
  }

  let imageBuffer;
  try {
    imageBuffer = Buffer.from(imageBase64, 'base64');
  } catch {
    throw new Error('图片编码无效。');
  }

  if (!imageBuffer.length) {
    throw new Error('图片数据为空。');
  }
  if (imageBuffer.length > MAX_IMAGE_UPLOAD_BYTES) {
    throw new Error(`图片过大，请控制在 ${Math.floor(MAX_IMAGE_UPLOAD_BYTES / (1024 * 1024))}MB 以内。`);
  }

  return {
    fileName: sanitizeFileStem(path.basename(fileName || 'ceph-image')),
    mimeType,
    imageBuffer,
  };
}

async function getSessionUser(request) {
  const cookies = parseCookies(request);
  const sessionToken = cookies[COOKIE_NAME];
  const session = parseSessionToken(sessionToken);
  if (!session) {
    return null;
  }
  const store = await readStore();
  return store.users.find((item) => item.id === session.userId) || null;
}

async function requirePortalUser(request, response) {
  const sessionUser = await getSessionUser(request);
  if (sessionUser) {
    const store = await readStore();
    const user = store.users.find((item) => item.id === sessionUser.id) || null;
    if (!user) {
      sendJson(response, 404, { error: '用户不存在。' });
      return null;
    }
    return { store, user, authSource: 'session' };
  }

  const apiKey = String(request.headers['x-api-key'] || '').trim();
  if (!apiKey) {
    sendJson(response, 401, { error: '请先登录。' });
    return null;
  }

  const { store, user } = await requireActiveApiKeyUser(apiKey);
  if (!user) {
    sendJson(response, 401, { error: 'API Key 无效或已过期。' });
    return null;
  }
  return { store, user, authSource: 'api-key' };
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

function findUserByApiKey(store, apiKey) {
  return store.users.find((item) => item.apiKey === apiKey) || null;
}

function getRequestOrigin(request) {
  const forwardedProto = String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = forwardedProto || (process.env.VERCEL || process.env.NODE_ENV === 'production' ? 'https' : 'http');
  const forwardedHost = String(request.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const host = forwardedHost || request.headers.host || `${HOST}:${PORT}`;
  return `${proto}://${host}/`;
}

function isLikelyShareUrl(value) {
  return typeof value === 'string'
    && /\/latera\/\?a=/.test(value)
    && /#\/case-process/.test(value);
}

async function requireActiveApiKeyUser(apiKey) {
  const store = await readStore();
  const user = findUserByApiKey(store, apiKey);
  if (!user || !isApiKeyActive(user)) {
    return { store, user: null };
  }
  return { store, user };
}

async function requireActiveAdminApiKey(apiKey) {
  const { store, user } = await requireActiveApiKeyUser(apiKey);
  if (!user || user.role !== 'admin') {
    return { store, user: null };
  }
  return { store, user };
}

function isLikelyUpstreamAuthError(message) {
  const text = String(message || '');
  return /Authentication failed|unable to access system resources|getAccessToken failed|algorithm token/i.test(text);
}

async function loadResvg() {
  if (!resvgPromise) {
    resvgPromise = import('@resvg/resvg-js');
  }
  return resvgPromise;
}

async function readFileIfExists(filePath, encoding = null) {
  try {
    return await fs.readFile(filePath, encoding || undefined);
  } catch {
    return null;
  }
}

async function convertSvgTextToPngBuffer(svgText) {
  const { Resvg } = await loadResvg();
  const resvg = new Resvg(svgText, {
    fitTo: {
      mode: 'original',
    },
  });
  return Buffer.from(resvg.render().asPng());
}

async function buildMeasurementResponseArtifacts({ output, annotatedSvgPath, annotatedPngPath }) {
  const svgText = annotatedSvgPath ? await readFileIfExists(annotatedSvgPath, 'utf8') : null;
  let pngBuffer = annotatedPngPath ? await readFileIfExists(annotatedPngPath) : null;

  if (!pngBuffer && svgText) {
    try {
      pngBuffer = await convertSvgTextToPngBuffer(svgText);
    } catch {
      pngBuffer = null;
    }
  }

  return {
    analysis: output.analysis || null,
    analysisError: output.analysisError || null,
    annotationError: pngBuffer ? null : (output.annotationError || null),
    summary: output.summary || null,
    metrics: output.analysis?.metrics || [],
    taskId: output.taskId || null,
    resultUrl: output.resultUrl || null,
    artifacts: {
      annotatedPngBase64: pngBuffer ? pngBuffer.toString('base64') : null,
      annotatedPngMimeType: pngBuffer ? 'image/png' : null,
      annotatedSvgBase64: svgText ? Buffer.from(svgText, 'utf8').toString('base64') : null,
      annotatedSvgMimeType: svgText ? 'image/svg+xml' : null,
    },
  };
}

function buildMeasurementSummaryFromResult({ measurementId, imageName, mode, result }) {
  const metrics = Array.isArray(result?.metrics) ? result.metrics : [];
  const metricValues = Object.fromEntries(
    metrics
      .filter((item) => item?.code && Number.isFinite(Number(item.value)))
      .map((item) => [item.code, Number(item.value)]),
  );

  return normalizeMeasurementSummary({
    id: measurementId,
    imageName,
    mode,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    riskLabel: result?.analysis?.riskLabel || result?.summary?.riskLabel || null,
    insightPreview: typeof result?.analysis?.insight === 'string'
      ? result.analysis.insight.slice(0, 120)
      : null,
    metricValues,
  });
}

async function persistUserMeasurement({ store, user, imageName, mode, result }) {
  const measurementId = randomBytes(12).toString('hex');
  const summary = buildMeasurementSummaryFromResult({
    measurementId,
    imageName,
    mode,
    result,
  });

  const record = {
    id: measurementId,
    userId: user.id,
    imageName: summary.imageName,
    mode: summary.mode,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    analysis: result.analysis || null,
    analysisError: result.analysisError || null,
    annotationError: result.annotationError || null,
    summary: result.summary || null,
    metrics: Array.isArray(result.metrics) ? result.metrics : [],
    taskId: result.taskId || null,
    resultUrl: result.resultUrl || null,
    artifacts: result.artifacts || null,
  };

  await writeMeasurementRecord(record);
  user.measurementHistory = [
    summary,
    ...(Array.isArray(user.measurementHistory) ? user.measurementHistory : []),
  ].slice(0, MAX_MEASUREMENT_HISTORY);
  user.updatedAt = nowIso();
  await writeStore(store);
  return {
    measurement: publicMeasurementSummary(summary),
    record,
  };
}

async function buildLocalImageMeasurementArtifacts(localOutput) {
  const annotatedImagePath = localOutput?.annotatedImagePath || '';
  const annotatedPng = annotatedImagePath ? await readFileIfExists(annotatedImagePath) : null;
  const metrics = Array.isArray(localOutput?.metrics) ? localOutput.metrics : [];
  const unsupportedMetricCodes = Array.isArray(localOutput?.unsupportedMetricCodes)
    ? localOutput.unsupportedMetricCodes
    : [];
  const supportedMetricCodes = Array.isArray(localOutput?.supportedMetricCodes)
    ? localOutput.supportedMetricCodes
    : metrics.map((item) => item.code).filter(Boolean);
  const metricValues = Object.fromEntries(
    metrics
      .filter((item) => item?.code && Number.isFinite(Number(item.value)))
      .map((item) => [item.code, Number(item.value)]),
  );

  return {
    analysis: {
      riskLabel: localOutput?.riskLabel || null,
      insight: localOutput?.insight || localOutput?.note || null,
      metrics,
      unsupportedMetricCodes,
      reviewTargets: Array.isArray(localOutput?.reviewTargets) ? localOutput.reviewTargets : [],
      landmarks: Array.isArray(localOutput?.landmarks) ? localOutput.landmarks : [],
      recognition: localOutput?.recognition || null,
      engine: localOutput?.engine || null,
    },
    analysisError: null,
    annotationError: annotatedPng ? null : '未生成 PNG 标注图。',
    summary: {
      headPoints: Array.isArray(localOutput?.landmarks) ? localOutput.landmarks.length : 0,
      rulerPoints: 0,
      spineSections: 0,
      hasRuler: false,
      supportedMetrics: supportedMetricCodes,
      unsupportedMetrics: unsupportedMetricCodes,
      metricValues,
      riskLabel: localOutput?.riskLabel || null,
    },
    metrics,
    taskId: null,
    resultUrl: null,
    artifacts: {
      annotatedPngBase64: annotatedPng ? annotatedPng.toString('base64') : null,
      annotatedPngMimeType: annotatedPng ? 'image/png' : null,
      annotatedSvgBase64: null,
      annotatedSvgMimeType: null,
    },
  };
}

async function runServerSideMeasurement({
  shareUrl,
  bridgeState,
  imagePath,
  operatorSession,
}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyfceph-portal-'));
  const outputPath = path.join(tempDir, 'result.json');
  const annotatedSvgPath = path.join(tempDir, 'annotated.svg');
  const annotatedPngPath = path.join(tempDir, 'annotated.png');
  const downloadedImagePath = path.join(tempDir, 'input');
  const bridgeFilePath = path.join(tempDir, 'bridge-state.json');
  const args = [
    SERVICE_RUNNER,
    '--skip-portal-validation',
    '--no-session-cache',
    '--output',
    outputPath,
    '--annotated-output',
    annotatedSvgPath,
    '--annotated-png-output',
    annotatedPngPath,
    '--downloaded-image-output',
    downloadedImagePath,
  ];

  if (shareUrl) {
    args.push('--share-url', shareUrl);
  } else if (bridgeState) {
    await fs.writeFile(bridgeFilePath, JSON.stringify(bridgeState, null, 2), 'utf8');
    args.push('--current-case', '--bridge-file', bridgeFilePath);
  } else if (imagePath) {
    args.push('--image', imagePath);
    if (operatorSession?.token) {
      args.push('--token', operatorSession.token);
    }
    if (operatorSession?.pageUrl) {
      args.push('--page-url', operatorSession.pageUrl);
    }
  } else {
    throw new Error('缺少可用病例上下文。');
  }

  try {
    await execFileAsync(process.execPath, args, {
      cwd: __dirname,
      env: {
        ...process.env,
      },
      maxBuffer: MAX_MEASURE_BUFFER_BYTES,
    });
    const rawOutput = await fs.readFile(outputPath, 'utf8');
    const output = JSON.parse(rawOutput);
    return await buildMeasurementResponseArtifacts({
      output,
      annotatedSvgPath: output.annotatedSvgPath || annotatedSvgPath,
      annotatedPngPath: output.annotatedPngPath || annotatedPngPath,
    });
  } catch (error) {
    const stderr = String(error?.stderr || '').trim();
    const stdout = String(error?.stdout || '').trim();
    const reason = stderr || stdout || (error instanceof Error ? error.message : String(error));
    throw new Error(reason || '服务端测量失败。');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function runLocalImageMeasurement({
  imagePath,
}) {
  if (!imagePath) {
    throw new Error('缺少本地图片路径。');
  }
  const runnerPath = LOCAL_CEPH_AUTOPOINT_RUNNER;
  try {
    await fs.access(runnerPath);
  } catch {
    throw new Error('本地图片测量引擎不存在。请在可运行本地 Ceph 模型的服务器上部署，或改用当前病例同步模式。');
  }

  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [runnerPath, '--image', imagePath], {
      cwd: __dirname,
      env: {
        ...process.env,
      },
      maxBuffer: MAX_MEASURE_BUFFER_BYTES,
    });
    const rawOutput = String(stdout || '').trim();
    if (!rawOutput) {
      throw new Error(String(stderr || '').trim() || '本地图片测量没有返回结果。');
    }
    const parsedOutput = JSON.parse(rawOutput);
    return await buildLocalImageMeasurementArtifacts(parsedOutput);
  } catch (error) {
    const stderr = String(error?.stderr || '').trim();
    const stdout = String(error?.stdout || '').trim();
    const reason = stderr || stdout || (error instanceof Error ? error.message : String(error));
    throw new Error(reason || '本地图片测量失败。');
  }
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

  const sessionToken = createSessionToken(user.id);
  setSessionCookie(response, sessionToken);
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

  const sessionToken = createSessionToken(user.id);
  setSessionCookie(response, sessionToken);
  return sendJson(response, 200, {
    message: '登录成功。',
    user: publicUser(user),
  });
}

async function handleLogout(_request, response) {
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

async function handleMeasurementList(request, response) {
  const portalAuth = await requirePortalUser(request, response);
  if (!portalAuth) {
    return;
  }
  const { user } = portalAuth;
  return sendJson(response, 200, {
    measurements: (Array.isArray(user.measurementHistory) ? user.measurementHistory : []).map(publicMeasurementSummary),
  });
}

async function handleMeasurementDetail(request, response, measurementId) {
  const portalAuth = await requirePortalUser(request, response);
  if (!portalAuth) {
    return;
  }
  const { user } = portalAuth;
  const summary = (Array.isArray(user.measurementHistory) ? user.measurementHistory : []).find((item) => item.id === measurementId);
  if (!summary) {
    return sendJson(response, 404, { error: '测量记录不存在。' });
  }
  const record = await readMeasurementRecord(measurementId);
  if (!record || record.userId !== user.id) {
    return sendJson(response, 404, { error: '测量记录不存在。' });
  }
  return sendJson(response, 200, {
    measurement: publicMeasurementSummary(summary),
    result: {
      analysis: record.analysis || null,
      analysisError: record.analysisError || null,
      annotationError: record.annotationError || null,
      summary: record.summary || null,
      metrics: Array.isArray(record.metrics) ? record.metrics : [],
      taskId: record.taskId || null,
      resultUrl: record.resultUrl || null,
      artifacts: record.artifacts || null,
    },
  });
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
  const user = findUserByApiKey(store, apiKey);
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

async function handleBridgeCurrentCaseGet(request, response) {
  const apiKey = String(request.headers['x-api-key'] || '').trim();
  if (!apiKey) {
    return sendJson(response, 400, { error: '缺少 API Key。' });
  }

  const store = await readStore();
  const user = findUserByApiKey(store, apiKey);
  if (!user || !isApiKeyActive(user)) {
    return sendJson(response, 401, { error: 'API Key 无效或已过期。' });
  }

  if (!isBridgeStateActive(user.currentCaseBridge)) {
    if (user.currentCaseBridge) {
      user.currentCaseBridge = null;
      user.updatedAt = nowIso();
      await writeStore(store);
    }
    return sendJson(response, 404, {
      ok: false,
      error: '当前病例桥接数据不存在或已过期，请先在浏览器中打开病例页面完成同步。',
    });
  }

  return sendJson(response, 200, {
    ok: true,
    currentCase: user.currentCaseBridge,
  });
}

async function handleBridgeCurrentCasePost(request, response) {
  const payload = await readRequestJson(request);
  const apiKey = String(payload.apiKey || request.headers['x-api-key'] || '').trim();
  if (!apiKey) {
    return sendJson(response, 400, { error: '缺少 API Key。' });
  }

  const store = await readStore();
  const user = findUserByApiKey(store, apiKey);
  if (!user || !isApiKeyActive(user)) {
    return sendJson(response, 401, { error: 'API Key 无效或已过期。' });
  }

  const currentCase = normalizeBridgeState({
    ...payload,
    source: payload?.source || 'portal-bridge',
    syncedAt: nowIso(),
    expiresAt: addMinutesIso(DEFAULT_BRIDGE_TTL_MINUTES),
  });

  if (!currentCase?.shareUrl && !currentCase?.token && !currentCase?.ptId) {
    return sendJson(response, 400, {
      error: '桥接数据不完整，至少需要 shareUrl、token 或 ptId 中的一项。',
    });
  }

  user.currentCaseBridge = currentCase;
  user.updatedAt = nowIso();
  await writeStore(store);

  return sendJson(response, 200, {
    ok: true,
    currentCase: {
      syncedAt: currentCase.syncedAt,
      expiresAt: currentCase.expiresAt,
      href: currentCase.href,
      ptId: currentCase.ptId,
      ptVersion: currentCase.ptVersion,
      hasShareUrl: Boolean(currentCase.shareUrl),
      hasToken: Boolean(currentCase.token),
    },
  });
}

async function resolveAdminOperatorAccess(request) {
  const sessionUser = await getSessionUser(request);
  if (sessionUser?.role === 'admin') {
    return { store: await readStore(), user: sessionUser, mode: 'session' };
  }

  const apiKey = String(request.headers['x-api-key'] || '').trim();
  if (!apiKey) {
    return { store: null, user: null, mode: null };
  }
  const { store, user } = await requireActiveAdminApiKey(apiKey);
  if (!user) {
    return { store, user: null, mode: null };
  }
  return { store, user, mode: 'api-key' };
}

async function handleAdminOperatorSessionGet(request, response) {
  const { store, user } = await resolveAdminOperatorAccess(request);
  if (!user) {
    return sendJson(response, 401, { error: '管理员认证已失效。' });
  }

  const operatorSession = normalizeOperatorSession(store.operatorSession);
  if (operatorSession && !isOperatorSessionActive(operatorSession)) {
    store.operatorSession = null;
    await writeStore(store);
  }

  return sendJson(response, 200, {
    ok: true,
    operatorSession: publicOperatorSession(operatorSession && isOperatorSessionActive(operatorSession) ? operatorSession : null),
  });
}

async function handleAdminOperatorSessionPost(request, response) {
  const { store, user } = await resolveAdminOperatorAccess(request);
  if (!user) {
    return sendJson(response, 401, { error: '管理员认证已失效。' });
  }

  const payload = await readRequestJson(request);
  const operatorSession = normalizeOperatorSession({
    ...payload,
    source: payload?.source || 'chrome-extension',
    syncedAt: nowIso(),
    expiresAt: addMinutesIso(DEFAULT_OPERATOR_SESSION_TTL_MINUTES),
  });

  if (!operatorSession?.token || !operatorSession?.pageUrl) {
    return sendJson(response, 400, { error: '会话同步不完整，至少需要 token 和 pageUrl。' });
  }

  store.operatorSession = operatorSession;
  await writeStore(store);

  return sendJson(response, 200, {
    ok: true,
    operatorSession: publicOperatorSession(operatorSession),
  });
}

async function handleAdminOperatorSessionDelete(request, response) {
  const { store, user } = await resolveAdminOperatorAccess(request);
  if (!user) {
    return sendJson(response, 401, { error: '管理员认证已失效。' });
  }

  store.operatorSession = null;
  await writeStore(store);
  return sendJson(response, 200, { ok: true });
}

async function handleMeasureShareUrl(request, response) {
  const payload = await readRequestJson(request);
  const apiKey = String(payload.apiKey || request.headers['x-api-key'] || '').trim();
  const shareUrl = String(payload.shareUrl || '').trim();

  if (!apiKey) {
    return sendJson(response, 400, { error: '缺少 API Key。' });
  }
  if (!shareUrl) {
    return sendJson(response, 400, { error: '缺少分享链接。' });
  }
  if (!isLikelyShareUrl(shareUrl)) {
    return sendJson(response, 400, { error: '分享链接格式不正确。' });
  }

  const { store, user } = await requireActiveApiKeyUser(apiKey);
  if (!user) {
    return sendJson(response, 401, { error: 'API Key 无效或已过期。' });
  }

  try {
    const result = await runServerSideMeasurement({
      shareUrl,
    });

    await sendBarkPush('HYFCeph 服务端测量', `用户：${user.name}\n单位：${user.organization || '-'}\n来源：share-url`);

    user.currentCaseBridge = normalizeBridgeState({
      source: 'portal-service',
      shareUrl,
      href: shareUrl,
      pageUrl: 'https://pd.aiyayi.com/latera/',
      syncedAt: nowIso(),
      expiresAt: addMinutesIso(DEFAULT_BRIDGE_TTL_MINUTES),
    });
    user.updatedAt = nowIso();
    await writeStore(store);

    return sendJson(response, 200, {
      ok: true,
      mode: 'share-url',
      result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return sendJson(response, 502, { error: message || '服务端测量失败。' });
  }
}

async function handleMeasureCurrentCase(request, response) {
  const payload = await readRequestJson(request);
  const apiKey = String(payload.apiKey || request.headers['x-api-key'] || '').trim();
  if (!apiKey) {
    return sendJson(response, 400, { error: '缺少 API Key。' });
  }

  const { user } = await requireActiveApiKeyUser(apiKey);
  if (!user) {
    return sendJson(response, 401, { error: 'API Key 无效或已过期。' });
  }

  if (!isBridgeStateActive(user.currentCaseBridge)) {
    return sendJson(response, 404, { error: '当前病例还没有同步，请先安装浏览器同步插件并打开病例页面一次。' });
  }

  const bridgeState = normalizeBridgeState(user.currentCaseBridge);
  if (!bridgeState?.shareUrl && !bridgeState?.token && !bridgeState?.ptId) {
    return sendJson(response, 404, { error: '当前病例同步数据不完整，请重新打开病例页面完成同步。' });
  }

  try {
    const result = await runServerSideMeasurement({
      shareUrl: bridgeState?.shareUrl && isLikelyShareUrl(bridgeState.shareUrl) ? bridgeState.shareUrl : '',
      bridgeState,
    });
    await sendBarkPush('HYFCeph 服务端测量', `用户：${user.name}\n单位：${user.organization || '-'}\n来源：current-case`);
    return sendJson(response, 200, {
      ok: true,
      mode: 'current-case',
      result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return sendJson(response, 502, { error: message || '服务端测量失败。' });
  }
}

async function handleMeasureImage(request, response) {
  const payload = await readRequestJson(request);
  const portalAuth = await requirePortalUser(request, response);
  if (!portalAuth) {
    return;
  }
  const { store, user } = portalAuth;

  let upload;
  try {
    upload = decodeUploadedImagePayload(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return sendJson(response, 400, { error: message || '图片上传无效。' });
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyfceph-upload-'));
  const uploadExt = extensionFromUpload({
    fileName: upload.fileName,
    mimeType: upload.mimeType,
  });
  const resolvedImagePath = path.join(tempDir, `${sanitizeFileStem(path.basename(upload.fileName, path.extname(upload.fileName)))}${uploadExt}`);

  try {
    const operatorSession = normalizeOperatorSession(store.operatorSession);
    if (!isOperatorSessionActive(operatorSession)) {
      if (store.operatorSession) {
        store.operatorSession = null;
        await writeStore(store);
      }
      return sendJson(response, 503, { error: '服务端远程会话暂不可用，请稍后重试。' });
    }

    await fs.writeFile(resolvedImagePath, upload.imageBuffer);
    const result = await runServerSideMeasurement({
      imagePath: resolvedImagePath,
      operatorSession,
    });
    const persisted = await persistUserMeasurement({
      store,
      user,
      imageName: upload.fileName,
      mode: 'image',
      result,
    });
    await sendBarkPush('HYFCeph 图片测量', `用户：${user.name}\n单位：${user.organization || '-'}\n图片：${path.basename(resolvedImagePath)}`);
    return sendJson(response, 200, {
      ok: true,
      mode: 'image',
      result,
      measurement: persisted.measurement,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isLikelyUpstreamAuthError(message)) {
      store.operatorSession = null;
      await writeStore(store);
      return sendJson(response, 503, { error: '服务端远程会话暂不可用，请稍后重试。' });
    }
    return sendJson(response, 502, { error: message || '图片测量失败。' });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
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
  const user = findUserByApiKey(store, apiKey);
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

export async function handleNodeRequest(request, response) {
  try {
    const url = new URL(request.url || '/', `http://${request.headers.host || `${HOST}:${PORT}`}`);

    if (request.method === 'GET' && url.pathname === '/api/health') {
      const store = await readStore();
      return sendJson(response, 200, {
        ok: true,
        service: 'HYFCeph Portal',
        barkConfigured: Boolean(BARK_DEVICE_KEY),
        storeBackend: STORE_BACKEND,
        operatorSessionActive: isOperatorSessionActive(store.operatorSession),
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
    if (request.method === 'GET' && url.pathname === '/api/measurements') {
      return await handleMeasurementList(request, response);
    }
    if (request.method === 'GET' && url.pathname.startsWith('/api/measurements/')) {
      const measurementId = decodeURIComponent(url.pathname.split('/').slice(3).join('/'));
      return await handleMeasurementDetail(request, response, measurementId);
    }
    if (request.method === 'POST' && url.pathname === '/api/api-key/generate') {
      return await handleGenerateApiKey(request, response);
    }
    if (request.method === 'POST' && url.pathname === '/api/validate-key') {
      return await handleValidateApiKey(request, response);
    }
    if (request.method === 'GET' && url.pathname === '/api/bridge/current-case') {
      return await handleBridgeCurrentCaseGet(request, response);
    }
    if (request.method === 'POST' && url.pathname === '/api/bridge/current-case') {
      return await handleBridgeCurrentCasePost(request, response);
    }
    if (request.method === 'GET' && url.pathname === '/api/admin/operator-session') {
      return await handleAdminOperatorSessionGet(request, response);
    }
    if (request.method === 'POST' && url.pathname === '/api/admin/operator-session') {
      return await handleAdminOperatorSessionPost(request, response);
    }
    if (request.method === 'DELETE' && url.pathname === '/api/admin/operator-session') {
      return await handleAdminOperatorSessionDelete(request, response);
    }
    if (request.method === 'POST' && url.pathname === '/api/measure/share-url') {
      return await handleMeasureShareUrl(request, response);
    }
    if (request.method === 'POST' && url.pathname === '/api/measure/image') {
      return await handleMeasureImage(request, response);
    }
    if (request.method === 'POST' && url.pathname === '/api/measure/current-case') {
      return await handleMeasureCurrentCase(request, response);
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
}

export default handleNodeRequest;

export async function startServer() {
  await readStore();
  const server = http.createServer(handleNodeRequest);
  await new Promise((resolve) => {
    server.listen(PORT, HOST, () => {
      console.log(`HYFCeph portal running at http://${HOST}:${PORT}`);
      resolve();
    });
  });
  return server;
}

const isDirectRun = Boolean(process.argv[1] && path.resolve(process.argv[1]) === __filename);
if (isDirectRun) {
  await startServer();
}
