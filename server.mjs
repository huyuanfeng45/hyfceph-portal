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
import { gunzipSync, inflateSync } from 'node:zlib';
import OSS from 'ali-oss';
import { buildOverlapRender, listSupportedAlignModes } from './scripts/hyfceph-overlap-renderer.mjs';
import { generateHyfcephHtmlReport, generateHyfcephPdfReport } from './scripts/hyfceph-report-pdf.mjs';
import { qrcode as createQrCode } from './scripts/vendor/qrcode.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOST = process.env.HYFCEPH_HOST || '127.0.0.1';
const PORT = Number(process.env.HYFCEPH_PORT || '3077');
const COOKIE_NAME = 'hyfceph_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const SESSION_SECRET = process.env.HYFCEPH_SESSION_SECRET || `hyfceph:${process.env.HYFCEPH_ADMIN_PASSWORD || '85301298'}:${process.env.HYFCEPH_BARK_KEY || 'bark'}`;
const DEFAULT_API_KEY_DAYS = Number(process.env.HYFCEPH_API_KEY_DAYS || '90');
const DEFAULT_INVITE_CODE_LIMIT = Number(process.env.HYFCEPH_INVITE_CODE_LIMIT || '3');
const DEFAULT_BRIDGE_TTL_MINUTES = Number(process.env.HYFCEPH_BRIDGE_TTL_MINUTES || '30');
const DEFAULT_OPERATOR_SESSION_TTL_MINUTES = Number(process.env.HYFCEPH_OPERATOR_SESSION_TTL_MINUTES || '240');
const ADMIN_USERNAME = process.env.HYFCEPH_ADMIN_USERNAME || 'huyuanfeng45';
const ADMIN_PASSWORD = process.env.HYFCEPH_ADMIN_PASSWORD || '85301298';
const BARK_DEVICE_KEY = process.env.HYFCEPH_BARK_KEY || '7ffBf7F85e3WbFyKrJTEcH';
const BARK_BASE_URL = (process.env.HYFCEPH_BARK_BASE_URL || 'https://api.day.app').replace(/\/+$/, '');
const STORE_BACKEND = process.env.HYFCEPH_STORE_BACKEND || (process.env.BLOB_READ_WRITE_TOKEN ? 'blob' : 'file');
const STORE_BLOB_PATH = process.env.HYFCEPH_STORE_BLOB_PATH || 'hyfceph/users.json';
const FEISHU_APP_ID = process.env.HYFCEPH_FEISHU_APP_ID || '';
const FEISHU_APP_SECRET = process.env.HYFCEPH_FEISHU_APP_SECRET || '';
const FEISHU_BITABLE_APP_TOKEN = process.env.HYFCEPH_FEISHU_BITABLE_APP_TOKEN || '';
const FEISHU_BITABLE_TABLE_ID = process.env.HYFCEPH_FEISHU_BITABLE_TABLE_ID || '';
const FEISHU_STORE_KEY = process.env.HYFCEPH_FEISHU_STORE_KEY || 'hyfceph-store';
const FEISHU_API_BASE = (process.env.HYFCEPH_FEISHU_API_BASE || 'https://open.feishu.cn/open-apis').replace(/\/+$/, '');
const FEISHU_WEB_BASE = (() => {
  const configured = String(process.env.HYFCEPH_FEISHU_WEB_BASE || '').trim();
  if (configured) {
    return configured.replace(/\/+$/, '');
  }
  return 'https://my.feishu.cn';
})();
const FEISHU_STORE_PAYLOAD_FIELD = process.env.HYFCEPH_FEISHU_STORE_PAYLOAD_FIELD || 'payload';
const FEISHU_STORE_UPDATED_AT_FIELD = process.env.HYFCEPH_FEISHU_STORE_UPDATED_AT_FIELD || 'updated_at';
const FEISHU_STORE_KIND_FIELD = process.env.HYFCEPH_FEISHU_STORE_KIND_FIELD || 'kind';
const FEISHU_STORE_KIND_LABEL_FIELD = process.env.HYFCEPH_FEISHU_STORE_KIND_LABEL_FIELD || 'kind_label';
const FEISHU_STORE_SUMMARY_FIELD = process.env.HYFCEPH_FEISHU_STORE_SUMMARY_FIELD || 'summary';
const FEISHU_STORE_MAX_RECORDS = Math.max(100, Number(process.env.HYFCEPH_FEISHU_MAX_RECORDS || 1500) || 1500);
const FEISHU_METRICS_TABLE_NAME = process.env.HYFCEPH_FEISHU_METRICS_TABLE_NAME || '📊 运营指标';
const FEISHU_METRICS_PRIMARY_FIELD = process.env.HYFCEPH_FEISHU_METRICS_PRIMARY_FIELD || '指标';
const FEISHU_METRICS_KEY_FIELD = process.env.HYFCEPH_FEISHU_METRICS_KEY_FIELD || 'metric_key';
const FEISHU_METRICS_VALUE_FIELD = process.env.HYFCEPH_FEISHU_METRICS_VALUE_FIELD || '数值';
const FEISHU_METRICS_UNIT_FIELD = process.env.HYFCEPH_FEISHU_METRICS_UNIT_FIELD || '单位';
const FEISHU_METRICS_DESCRIPTION_FIELD = process.env.HYFCEPH_FEISHU_METRICS_DESCRIPTION_FIELD || '说明';
const FEISHU_METRICS_UPDATED_AT_FIELD = process.env.HYFCEPH_FEISHU_METRICS_UPDATED_AT_FIELD || 'updated_at';
const FEISHU_METRICS_VIEW_NAMES = ['📌 当前指标', '📈 用户与报告'];
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SERVICE_RUNNER = path.join(__dirname, 'scripts', 'hyfceph-remote-runner.mjs');
const LOCAL_CEPH_AUTOPOINT_RUNNER = process.env.HYFCEPH_LOCAL_IMAGE_RUNNER
  || path.join(__dirname, 'engines', 'ceph-autopoint', 'scripts', 'run-ceph-autopoint.cjs');
const MAX_MEASURE_BUFFER_BYTES = 24 * 1024 * 1024;
const MAX_IMAGE_UPLOAD_BYTES = 20 * 1024 * 1024;
const PDF_OSS_ACCESS_KEY_ID = process.env.HYFCEPH_PDF_OSS_ACCESS_KEY_ID || '';
const PDF_OSS_ACCESS_KEY_SECRET = process.env.HYFCEPH_PDF_OSS_ACCESS_KEY_SECRET || '';
const PDF_OSS_REGION = process.env.HYFCEPH_PDF_OSS_REGION || '';
const PDF_OSS_BUCKET = process.env.HYFCEPH_PDF_OSS_BUCKET || '';
const PDF_OSS_CUSTOM_DOMAIN = (process.env.HYFCEPH_PDF_OSS_CUSTOM_DOMAIN || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '');
const PDF_OSS_PREFIX = process.env.HYFCEPH_PDF_OSS_PREFIX || 'hyfceph-pdf';
const REPORT_OSS_PREFIX = process.env.HYFCEPH_REPORT_OSS_PREFIX || 'hyfceph-report';
const REPORT_PAYLOAD_OSS_PREFIX = process.env.HYFCEPH_REPORT_PAYLOAD_OSS_PREFIX || 'hyfceph-report-payload';
const PDF_OSS_UPLOAD_EXPIRES_SECONDS = Number(process.env.HYFCEPH_PDF_OSS_UPLOAD_EXPIRES_SECONDS || '900');
const PDF_OSS_DOWNLOAD_EXPIRES_SECONDS = Number(process.env.HYFCEPH_PDF_OSS_DOWNLOAD_EXPIRES_SECONDS || String(60 * 60 * 24 * 7));
const PDF_OSS_PUBLIC_READ = /^(1|true|yes)$/i.test(String(process.env.HYFCEPH_PDF_OSS_PUBLIC_READ || 'false'));
const OSS_V4_MAX_EXPIRES_SECONDS = 60 * 60 * 24 * 7;
const PDF_SHORT_LINK_TTL_DAYS = Number(process.env.HYFCEPH_PDF_SHORT_LINK_TTL_DAYS || '365');
const REPORT_SHORT_LINK_TTL_DAYS = Number(process.env.HYFCEPH_REPORT_SHORT_LINK_TTL_DAYS || '365');
const WEIXIN_FIXED_BASE_URL = (process.env.HYFCEPH_WEIXIN_API_BASE_URL || 'https://ilinkai.weixin.qq.com').replace(/\/+$/, '');
const WEIXIN_BOT_TYPE = String(process.env.HYFCEPH_WEIXIN_BOT_TYPE || '3').trim() || '3';
const WEIXIN_BINDING_TTL_MINUTES = Number(process.env.HYFCEPH_WEIXIN_BINDING_TTL_MINUTES || '10');
const WEIXIN_QR_TIMEOUT_MS = Number(process.env.HYFCEPH_WEIXIN_QR_TIMEOUT_MS || '5000');
const WEIXIN_QR_POLL_TIMEOUT_MS = Number(process.env.HYFCEPH_WEIXIN_QR_POLL_TIMEOUT_MS || '35000');
const WEIXIN_BOT_SECRET = process.env.HYFCEPH_WEIXIN_BOT_SECRET
  || createHmac('sha256', SESSION_SECRET).update('hyfceph-weixin-bot').digest('hex');

let blobSdkPromise = null;
let resvgPromise = null;
let pdfOssClientPromise = null;
let pdfOssDownloadClientPromise = null;
let feishuAppTokenCache = null;
let feishuSchemaCache = null;
let feishuMetricsSchemaCache = null;
const execFileAsync = promisify(execFile);
const FEISHU_ROW_KIND_USER = 'user';
const FEISHU_ROW_KIND_OPERATOR_SESSION = 'operator_session';
const FEISHU_ROW_KIND_PDF_LINK = 'pdf_link';
const FEISHU_ROW_KIND_REPORT_LINK = 'report_link';
const FEISHU_ROW_KIND_WEIXIN_BOT = 'weixin_bot';
const FEISHU_ROW_KIND_WEIXIN_BINDING_SESSION = 'weixin_binding_session';
const FEISHU_ROW_KIND_INVITE_CODE = 'invite_code';
const FEISHU_MANAGED_ROW_PREFIXES = [
  `${FEISHU_ROW_KIND_USER}:`,
  `${FEISHU_ROW_KIND_OPERATOR_SESSION}:`,
  `${FEISHU_ROW_KIND_PDF_LINK}:`,
  `${FEISHU_ROW_KIND_REPORT_LINK}:`,
  `${FEISHU_ROW_KIND_WEIXIN_BOT}:`,
  `${FEISHU_ROW_KIND_WEIXIN_BINDING_SESSION}:`,
  `${FEISHU_ROW_KIND_INVITE_CODE}:`,
];
const FEISHU_METRIC_DEFINITIONS = [
  {
    key: 'user_total',
    label: '用户总数',
    unit: '人',
    description: '当前注册用户总数（不含管理员）。',
  },
  {
    key: 'users_today',
    label: '今日新增用户',
    unit: '人',
    description: '今天新注册的用户数量（按 Asia/Shanghai 统计）。',
  },
  {
    key: 'reports_today',
    label: '今日报告数',
    unit: '份',
    description: '今天新增的标准在线报告数量（按 Asia/Shanghai 统计）。',
  },
  {
    key: 'weixin_bindings_success',
    label: '微信绑定成功数',
    unit: '人',
    description: '已成功绑定微信 Clawbot 的用户数量（不含管理员）。',
  },
  {
    key: 'report_shortlinks_total',
    label: '报告短链总数',
    unit: '条',
    description: '当前已保存的在线报告短链总数（标准版和美化版均计入）。',
  },
];

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

function getDateKeyInTimeZone(value = new Date(), timeZone = 'Asia/Shanghai') {
  const date = value instanceof Date ? value : new Date(value);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(date);
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

function isPdfOssConfigured() {
  return Boolean(PDF_OSS_ACCESS_KEY_ID && PDF_OSS_ACCESS_KEY_SECRET && PDF_OSS_REGION && PDF_OSS_BUCKET);
}

function safePositiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
}

function buildPdfOssObjectKey({ user, fileName, patientName, reportType }) {
  const now = new Date();
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const stem = sanitizeFileStem(path.basename(fileName || 'hyfceph-report.pdf', path.extname(fileName || 'hyfceph-report.pdf')));
  const patientStem = sanitizeFileStem(patientName || 'patient');
  const typeStem = sanitizeFileStem(reportType || 'report');
  const userStem = sanitizeFileStem(user?.id || user?.username || user?.phone || 'user');
  const timestamp = nowIso().replace(/[:.]/g, '-');
  return `${PDF_OSS_PREFIX}/${year}/${month}/${userStem}/${timestamp}-${patientStem}-${typeStem}-${stem}.pdf`;
}

function buildHtmlReportObjectKey({ user, fileName, patientName, reportType, variant = 'standard' }) {
  const now = new Date();
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const stem = sanitizeFileStem(path.basename(fileName || 'hyfceph-report.html', path.extname(fileName || 'hyfceph-report.html')));
  const patientStem = sanitizeFileStem(patientName || 'patient');
  const typeStem = sanitizeFileStem(reportType || 'report');
  const userStem = sanitizeFileStem(user?.id || user?.username || user?.phone || 'user');
  const timestamp = nowIso().replace(/[:.]/g, '-');
  const variantStem = sanitizeFileStem(variant || 'standard');
  return `${REPORT_OSS_PREFIX}/${variantStem}/${year}/${month}/${userStem}/${timestamp}-${patientStem}-${typeStem}-${stem}.html`;
}

function buildOssPublicUrl(objectKey) {
  const encodedPath = String(objectKey || '')
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  const host = PDF_OSS_CUSTOM_DOMAIN || `${PDF_OSS_BUCKET}.${PDF_OSS_REGION}.aliyuncs.com`;
  return `https://${host}/${encodedPath}`;
}

function normalizeOssSignedUrl(url) {
  return String(url || '').replace(/^http:\/\//i, 'https://');
}

async function getPdfOssClient() {
  if (!isPdfOssConfigured()) {
    throw new Error('PDF OSS 上传服务未配置。');
  }
  if (!pdfOssClientPromise) {
    pdfOssClientPromise = Promise.resolve(new OSS({
      region: PDF_OSS_REGION,
      bucket: PDF_OSS_BUCKET,
      endpoint: PDF_OSS_CUSTOM_DOMAIN ? `https://${PDF_OSS_CUSTOM_DOMAIN}` : undefined,
      cname: Boolean(PDF_OSS_CUSTOM_DOMAIN),
      accessKeyId: PDF_OSS_ACCESS_KEY_ID,
      accessKeySecret: PDF_OSS_ACCESS_KEY_SECRET,
      authorizationV4: true,
    }));
  }
  return pdfOssClientPromise;
}

async function getPdfOssDownloadClient() {
  if (!isPdfOssConfigured()) {
    throw new Error('PDF OSS 上传服务未配置。');
  }
  if (!PDF_OSS_CUSTOM_DOMAIN) {
    return getPdfOssClient();
  }
  if (!pdfOssDownloadClientPromise) {
    pdfOssDownloadClientPromise = Promise.resolve(new OSS({
      region: PDF_OSS_REGION,
      bucket: PDF_OSS_BUCKET,
      endpoint: `https://${PDF_OSS_CUSTOM_DOMAIN}`,
      cname: true,
      accessKeyId: PDF_OSS_ACCESS_KEY_ID,
      accessKeySecret: PDF_OSS_ACCESS_KEY_SECRET,
      authorizationV4: true,
    }));
  }
  return pdfOssDownloadClientPromise;
}

async function createPdfUploadTicket({ user, fileName, mimeType, patientName, reportType, request = null }) {
  const client = await getPdfOssClient();
  const downloadClient = await getPdfOssDownloadClient();
  const objectKey = buildPdfOssObjectKey({
    user,
    fileName,
    patientName,
    reportType,
  });
  const contentType = String(mimeType || 'application/pdf').trim() || 'application/pdf';
  const uploadExpiresIn = safePositiveInteger(PDF_OSS_UPLOAD_EXPIRES_SECONDS, 900);
  const downloadExpiresIn = Math.min(
    safePositiveInteger(PDF_OSS_DOWNLOAD_EXPIRES_SECONDS, 60 * 60 * 24 * 7),
    OSS_V4_MAX_EXPIRES_SECONDS,
  );
  const uploadHeaders = {
    'Content-Type': contentType,
  };
  const additionalHeaders = [];
  if (PDF_OSS_PUBLIC_READ) {
    uploadHeaders['x-oss-object-acl'] = 'public-read';
    additionalHeaders.push('x-oss-object-acl');
  }

  const uploadUrl = normalizeOssSignedUrl(await client.signatureUrlV4(
    'PUT',
    uploadExpiresIn,
    {
      headers: uploadHeaders,
    },
    objectKey,
    additionalHeaders,
  ));

  const publicUrl = buildOssPublicUrl(objectKey);
  const signedDownloadUrl = PDF_OSS_PUBLIC_READ
    ? publicUrl
    : normalizeOssSignedUrl(await downloadClient.signatureUrlV4('GET', downloadExpiresIn, undefined, objectKey));
  const shortLink = await issuePdfShortLink({
    user,
    objectKey,
    patientName,
    reportType,
    request,
  });

  return {
    objectKey,
    bucket: PDF_OSS_BUCKET,
    region: PDF_OSS_REGION,
    accessMode: PDF_OSS_PUBLIC_READ ? 'public-read' : 'signed-get',
    uploadUrl,
    uploadHeaders,
    uploadExpiresAt: new Date(Date.now() + uploadExpiresIn * 1000).toISOString(),
    publicUrl,
    downloadUrl: shortLink.shortUrl,
    signedDownloadUrl,
    shortCode: shortLink.code,
    downloadExpiresAt: PDF_OSS_PUBLIC_READ ? null : new Date(Date.now() + downloadExpiresIn * 1000).toISOString(),
  };
}

async function uploadPdfFileToOss({ user, pdfPath, patientName, reportType, request = null }) {
  if (!isPdfOssConfigured()) {
    return {
      ok: false,
      skipped: true,
      reason: 'pdf-oss-not-configured',
    };
  }

  const client = await getPdfOssClient();
  const downloadClient = await getPdfOssDownloadClient();
  const fileName = path.basename(String(pdfPath || '').trim() || 'hyfceph-report.pdf');
  const objectKey = buildPdfOssObjectKey({
    user,
    fileName,
    patientName,
    reportType,
  });
  const downloadExpiresIn = Math.min(
    safePositiveInteger(PDF_OSS_DOWNLOAD_EXPIRES_SECONDS, 60 * 60 * 24 * 7),
    OSS_V4_MAX_EXPIRES_SECONDS,
  );
  const headers = {
    'Content-Type': 'application/pdf',
  };
  if (PDF_OSS_PUBLIC_READ) {
    headers['x-oss-object-acl'] = 'public-read';
  }

  await client.put(objectKey, pdfPath, { headers });
  const publicUrl = buildOssPublicUrl(objectKey);
  const signedDownloadUrl = PDF_OSS_PUBLIC_READ
    ? publicUrl
    : normalizeOssSignedUrl(await downloadClient.signatureUrlV4('GET', downloadExpiresIn, undefined, objectKey));
  const shortLink = await issuePdfShortLink({
    user,
    objectKey,
    patientName,
    reportType,
    request,
  });

  return {
    ok: true,
    objectKey,
    bucket: PDF_OSS_BUCKET,
    region: PDF_OSS_REGION,
    accessMode: PDF_OSS_PUBLIC_READ ? 'public-read' : 'signed-get',
    pdfShareUrl: shortLink.shortUrl,
    pdfSignedUrl: signedDownloadUrl,
    pdfPublicUrl: publicUrl,
    pdfShortCode: shortLink.code,
    pdfShareExpiresAt: PDF_OSS_PUBLIC_READ ? null : new Date(Date.now() + downloadExpiresIn * 1000).toISOString(),
  };
}

async function uploadHtmlReportToOss({ user, htmlPath, patientName, reportType, request = null, variant = 'standard' }) {
  if (!isPdfOssConfigured()) {
    return {
      ok: false,
      skipped: true,
      reason: 'pdf-oss-not-configured',
    };
  }

  const client = await getPdfOssClient();
  const fileName = path.basename(String(htmlPath || '').trim() || 'hyfceph-report.html');
  const objectKey = buildHtmlReportObjectKey({
    user,
    fileName,
    patientName,
    reportType,
    variant,
  });
  const headers = {
    'Content-Type': 'text/html; charset=utf-8',
  };
  if (PDF_OSS_PUBLIC_READ) {
    headers['x-oss-object-acl'] = 'public-read';
  }

  await client.put(objectKey, htmlPath, { headers });
  const publicUrl = buildOssPublicUrl(objectKey);
  const shortLink = await issueReportShortLink({
    user,
    objectKey,
    patientName,
    reportType,
    request,
    variant,
  });

  return {
    ok: true,
    objectKey,
    bucket: PDF_OSS_BUCKET,
    region: PDF_OSS_REGION,
    accessMode: PDF_OSS_PUBLIC_READ ? 'public-read' : 'signed-get',
    reportShareUrl: shortLink.shortUrl,
    reportPublicUrl: publicUrl,
    reportShortCode: shortLink.code,
    variant,
  };
}

function buildReportPayloadObjectKey({ user, reportType = 'image' }) {
  const createdAt = new Date();
  const yyyy = String(createdAt.getUTCFullYear());
  const mm = String(createdAt.getUTCMonth() + 1).padStart(2, '0');
  const userSegment = sanitizeFileStem(user?.id || 'anonymous');
  const stamp = createdAt.toISOString().replace(/[:.]/g, '-');
  const reportSegment = sanitizeFileStem(reportType || 'image');
  return `${sanitizeFileStem(REPORT_PAYLOAD_OSS_PREFIX)}/${yyyy}/${mm}/${userSegment}/${stamp}-${reportSegment}-result.json`;
}

async function uploadReportPayloadToOss({ user, resultPayload, reportType = 'image' }) {
  if (!isPdfOssConfigured()) {
    return null;
  }

  const client = await getPdfOssClient();
  const objectKey = buildReportPayloadObjectKey({ user, reportType });
  const body = Buffer.from(JSON.stringify(resultPayload), 'utf8');
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
  };
  if (PDF_OSS_PUBLIC_READ) {
    headers['x-oss-object-acl'] = 'public-read';
  }

  await client.put(objectKey, body, { headers });
  return {
    objectKey,
    bucket: PDF_OSS_BUCKET,
    region: PDF_OSS_REGION,
  };
}

async function loadReportPayloadFromOss(objectKey) {
  if (!isPdfOssConfigured()) {
    throw new Error('报告存储未配置。');
  }

  const client = await getPdfOssClient();
  const response = await client.get(objectKey);
  const content = response?.content;
  if (!content) {
    throw new Error('报告结果不存在。');
  }
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return JSON.parse(buffer.toString('utf8'));
}

async function loadTextObjectFromOss(objectKey) {
  if (!isPdfOssConfigured()) {
    throw new Error('报告存储未配置。');
  }

  const client = await getPdfOssClient();
  const response = await client.get(objectKey);
  const content = response?.content;
  if (!content) {
    throw new Error('报告内容不存在。');
  }
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return buffer.toString('utf8');
}

function buildFeishuDocUrl(documentId) {
  return `${FEISHU_WEB_BASE}/docx/${encodeURIComponent(documentId)}`;
}

async function makeFeishuDocPublic(documentId) {
  await callFeishuBitableApi(
    'PATCH',
    `/drive/v2/permissions/${encodeURIComponent(documentId)}/public?type=docx`,
    {
      link_share_entity: 'anyone_readable',
      external_access: true,
      security_entity: 'anyone_can_view',
      comment_entity: 'anyone_can_view',
    },
  );
}

function formatMetricValueText(metric) {
  if (!metric) {
    return '-';
  }
  return metric.valueText || (Number.isFinite(metric.value) ? String(metric.value) : '-');
}

function pickMetricByCodes(metrics, codes) {
  const map = new Map((Array.isArray(metrics) ? metrics : []).map((metric) => [String(metric?.code || '').toUpperCase(), metric]));
  for (const code of Array.isArray(codes) ? codes : []) {
    const hit = map.get(String(code).toUpperCase());
    if (hit) {
      return hit;
    }
  }
  return null;
}

function buildFeishuDocParagraphs({
  resultPayload,
  patientName = '',
  reportType = 'image',
  prettyReportUrl = '',
  standardReportUrl = '',
}) {
  const mode = String(resultPayload?.mode || resultPayload?.analysis?.type || reportType || 'image').trim();
  const summary = resultPayload?.summary || {};
  const analysis = resultPayload?.analysis || {};
  const metrics = Array.isArray(resultPayload?.metrics) ? resultPayload.metrics : [];
  const metricCodes = [
    ['SNA'],
    ['SNB'],
    ['ANB'],
    ['WITS', 'AO-BO', 'AO-BO(MM)'],
    ['GOGN-SN'],
    ['FMA'],
    ['U1-SN'],
    ['IMPA'],
  ];
  const keyMetricLine = metricCodes
    .map((codes) => {
      const metric = pickMetricByCodes(metrics, codes);
      if (!metric) {
        return null;
      }
      return `${metric.code} ${formatMetricValueText(metric)}`;
    })
    .filter(Boolean)
    .join('；');

  const frameworkChoices = Array.isArray(analysis?.frameworkChoices)
    ? analysis.frameworkChoices
    : Array.isArray(summary?.frameworkChoices)
      ? summary.frameworkChoices
      : [];

  const lines = [
    'HYFCeph 备用在线文档',
    patientName ? `患者姓名：${patientName}` : '患者姓名：未提供',
    `报告类型：${mode === 'overlap' ? '治疗前后重叠对比' : '单张侧位片测量'}`,
    analysis?.riskLabel || summary?.riskLabel ? `综合标签：${analysis?.riskLabel || summary?.riskLabel}` : null,
    analysis?.insight || summary?.insight ? `自动解读：${analysis?.insight || summary?.insight}` : null,
    keyMetricLine ? `关键指标：${keyMetricLine}` : null,
    frameworkChoices.length ? `支持分析法：${frameworkChoices.join('、')}` : null,
    prettyReportUrl ? `主链接（门户美化报告）：${prettyReportUrl}` : null,
    standardReportUrl ? `标准门户报告：${standardReportUrl}` : null,
    '说明：这是备用的飞书文档版报告，用于在部分客户端中更稳定地打开和转发。若样式展示需要更完整，请优先查看门户美化报告。',
  ].filter(Boolean);

  return lines;
}

async function createFeishuDocReport({
  resultPayload,
  patientName = '',
  reportType = 'image',
  prettyReportUrl = '',
  standardReportUrl = '',
}) {
  if (!isFeishuBitableConfigured()) {
    return {
      ok: false,
      skipped: true,
      reason: 'feishu-not-configured',
    };
  }
  try {
    const titlePrefix = reportType === 'overlap' ? 'HYFCeph 重叠对比备用文档' : 'HYFCeph 测量备用文档';
    const title = patientName
      ? `${titlePrefix} - ${patientName}`
      : `${titlePrefix} - ${new Date().toLocaleDateString('zh-CN')}`;
    const createData = await callFeishuBitableApi('POST', '/docx/v1/documents', {
      title,
    });
    const documentId = String(createData?.document?.document_id || '').trim();
    if (!documentId) {
      throw new Error('飞书文档创建失败。');
    }
    await makeFeishuDocPublic(documentId);

    const paragraphs = buildFeishuDocParagraphs({
      resultPayload,
      patientName,
      reportType,
      prettyReportUrl,
      standardReportUrl,
    });
    const children = paragraphs.map((content) => ({
      block_type: 2,
      text: {
        elements: [
          {
            text_run: {
              content,
            },
          },
        ],
      },
    }));

    if (children.length) {
      await callFeishuBitableApi(
        'POST',
        `/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(documentId)}/children`,
        { children },
      );
    }

    return {
      ok: true,
      documentId,
      docUrl: buildFeishuDocUrl(documentId),
      title,
    };
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function generateAndUploadPdfReport({ user, resultPayload, patientName, reportType, request = null }) {
  if (!isPdfOssConfigured()) {
    return {
      ok: false,
      skipped: true,
      reason: 'pdf-oss-not-configured',
    };
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyfceph-server-pdf-'));
  const resultJsonPath = path.join(tempDir, 'result.json');
  const pdfOutputPath = path.join(tempDir, 'report.pdf');

  try {
    await fs.writeFile(resultJsonPath, JSON.stringify(resultPayload, null, 2), 'utf8');
    await generateHyfcephPdfReport({
      inputPath: resultJsonPath,
      outputPath: pdfOutputPath,
      patientName: patientName || undefined,
    });
    return await uploadPdfFileToOss({
      user,
      pdfPath: pdfOutputPath,
      patientName,
      reportType,
      request,
    });
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function generateAndUploadHtmlReport({ user, resultPayload, patientName, reportType, request = null, variant = 'standard' }) {
  if (!isPdfOssConfigured()) {
    return {
      ok: false,
      skipped: true,
      reason: 'pdf-oss-not-configured',
    };
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyfceph-server-report-'));
  const resultJsonPath = path.join(tempDir, 'result.json');
  const htmlOutputPath = path.join(tempDir, `report-${sanitizeFileStem(variant)}.html`);

  try {
    await fs.writeFile(resultJsonPath, JSON.stringify(resultPayload, null, 2), 'utf8');
    await generateHyfcephHtmlReport({
      inputPath: resultJsonPath,
      outputPath: htmlOutputPath,
      patientName: patientName || undefined,
      variant,
    });
    return await uploadHtmlReportToOss({
      user,
      htmlPath: htmlOutputPath,
      patientName,
      reportType,
      request,
      variant,
    });
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function extensionFromUpload({ fileName, mimeType }) {
  const explicitExt = path.extname(String(fileName || '').trim()).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff', '.gif'].includes(explicitExt)) {
    return explicitExt;
  }

  const mime = String(mimeType || '').toLowerCase();
  if (mime === 'image/png') return '.png';
  if (mime === 'image/jpeg' || mime === 'image/jpg') return '.jpg';
  if (mime === 'image/webp') return '.webp';
  if (mime === 'image/bmp') return '.bmp';
  if (mime === 'image/tiff') return '.tif';
  if (mime === 'image/gif') return '.gif';
  return '.png';
}

function sniffImageMimeType(imageBuffer) {
  if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length < 12) {
    return '';
  }
  if (
    imageBuffer[0] === 0x89
    && imageBuffer[1] === 0x50
    && imageBuffer[2] === 0x4e
    && imageBuffer[3] === 0x47
  ) {
    return 'image/png';
  }
  if (imageBuffer[0] === 0xff && imageBuffer[1] === 0xd8 && imageBuffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (imageBuffer.toString('ascii', 0, 6) === 'GIF87a' || imageBuffer.toString('ascii', 0, 6) === 'GIF89a') {
    return 'image/gif';
  }
  if (imageBuffer.toString('ascii', 0, 2) === 'BM') {
    return 'image/bmp';
  }
  if (imageBuffer.toString('ascii', 0, 4) === 'RIFF' && imageBuffer.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (
    (imageBuffer[0] === 0x49 && imageBuffer[1] === 0x49 && imageBuffer[2] === 0x2a && imageBuffer[3] === 0x00)
    || (imageBuffer[0] === 0x4d && imageBuffer[1] === 0x4d && imageBuffer[2] === 0x00 && imageBuffer[3] === 0x2a)
  ) {
    return 'image/tiff';
  }
  return '';
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

function normalizeAccountId(raw) {
  return String(raw || '').trim().toLowerCase().replace(/[@.]/g, '-');
}

function maskWeixinUserId(value) {
  const source = String(value || '').trim();
  if (!source) {
    return null;
  }
  if (source.length <= 6) {
    return source;
  }
  return `${source.slice(0, 3)}***${source.slice(-3)}`;
}

function publicWeixinBinding(binding) {
  if (!binding) {
    return null;
  }
  return {
    source: binding.source,
    boundAt: binding.boundAt,
    updatedAt: binding.updatedAt,
    botAccountId: binding.botAccountId || null,
    botType: binding.botType || null,
    displayUserId: maskWeixinUserId(binding.weixinUserId),
    active: true,
  };
}

function buildWeixinBindingReadiness(store, user) {
  const binding = normalizeWeixinBindingRecord(user?.weixinBinding);
  if (!binding) {
    return {
      code: 'unbound',
      label: '未绑定',
      ready: false,
      refreshSeconds: 10,
      detail: '先生成二维码，再用微信扫码完成绑定。',
      botAccountId: null,
      updatedAt: null,
    };
  }

  const normalizedBindingAccountId = normalizeAccountId(binding.botAccountId || '');
  const matchedConfig = collectWeixinBotConfigs(store).find((config) => {
    if (config.userId && config.userId === user?.id) {
      return true;
    }
    if (binding.weixinUserId && config.weixinUserId === binding.weixinUserId) {
      return true;
    }
    if (normalizedBindingAccountId && normalizeAccountId(config.accountId) === normalizedBindingAccountId) {
      return true;
    }
    return false;
  }) || null;

  if (matchedConfig) {
    return {
      code: 'ready',
      label: '已就绪',
      ready: true,
      refreshSeconds: 10,
      detail: '机器人已接管，可以直接去新的微信 Clawbot 会话里发送侧位片。',
      botAccountId: matchedConfig.accountId,
      updatedAt: matchedConfig.updatedAt || binding.updatedAt || null,
    };
  }

  return {
    code: 'pending',
    label: '等待接管',
    ready: false,
    refreshSeconds: 10,
    detail: '微信已绑定，机器人通常会在 10 秒内接管。请稍等后在新的微信 Clawbot 会话里发送消息。',
    botAccountId: binding.botAccountId || null,
    updatedAt: binding.updatedAt || null,
  };
}

function publicUser(user, store = null) {
  const readiness = store ? buildWeixinBindingReadiness(store, user) : null;
  const inviteQuota = store ? buildInviteQuota(user, store) : null;
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
    invitedByUserId: user.invitedByUserId || null,
    invitedByName: user.invitedByName || null,
    inviteCodeUsed: user.inviteCodeUsed || null,
    apiKey: user.apiKey || null,
    apiKeyExpiresAt: user.apiKeyExpiresAt || null,
    apiKeyActive: isApiKeyActive(user),
    inviteQuota,
    weixinBinding: user.weixinBinding
      ? {
          ...publicWeixinBinding(user.weixinBinding),
          readiness,
        }
      : null,
  };
}

function normalizeWeixinBindingRecord(binding) {
  if (!binding || typeof binding !== 'object') {
    return null;
  }
  const weixinUserId = typeof binding.weixinUserId === 'string' ? binding.weixinUserId.trim() : '';
  if (!weixinUserId) {
    return null;
  }
  return {
    source: typeof binding.source === 'string' && binding.source.trim()
      ? binding.source.trim()
      : 'weixin-clawbot',
    weixinUserId,
    botAccountId: typeof binding.botAccountId === 'string' && binding.botAccountId.trim()
      ? binding.botAccountId.trim()
      : null,
    botToken: typeof binding.botToken === 'string' && binding.botToken.trim()
      ? binding.botToken.trim()
      : null,
    botBaseUrl: typeof binding.botBaseUrl === 'string' && binding.botBaseUrl.trim()
      ? binding.botBaseUrl.trim().replace(/\/+$/, '')
      : WEIXIN_FIXED_BASE_URL,
    botType: typeof binding.botType === 'string' && binding.botType.trim()
      ? binding.botType.trim()
      : WEIXIN_BOT_TYPE,
    boundAt: isIsoDate(binding.boundAt) ? new Date(binding.boundAt).toISOString() : nowIso(),
    updatedAt: isIsoDate(binding.updatedAt) ? new Date(binding.updatedAt).toISOString() : nowIso(),
  };
}

function buildWeixinBotConfigFromBinding(user, binding, fallbackBot = null) {
  if (!user || !binding?.weixinUserId) {
    return null;
  }
  const accountId = String(binding.botAccountId || '').trim();
  const fallbackAccountId = String(fallbackBot?.accountId || '').trim();
  const token = String(
    binding.botToken
    || ((accountId && accountId === fallbackAccountId) ? (fallbackBot?.token || '') : '')
    || '',
  ).trim();
  if (!accountId || !token) {
    return null;
  }
  const normalizedBot = normalizeWeixinBotRecord({
    accountId,
    token,
    baseUrl: binding.botBaseUrl || fallbackBot?.baseUrl || WEIXIN_FIXED_BASE_URL,
    botType: binding.botType || fallbackBot?.botType || WEIXIN_BOT_TYPE,
    configuredAt: binding.boundAt || fallbackBot?.configuredAt || nowIso(),
    updatedAt: binding.updatedAt || fallbackBot?.updatedAt || nowIso(),
    lastLinkedUserId: binding.weixinUserId,
  });
  if (!normalizedBot) {
    return null;
  }
  return {
    ...normalizedBot,
    userId: user.id,
    userName: user.name,
    organization: user.organization,
    weixinUserId: binding.weixinUserId,
    apiKeyActive: isApiKeyActive(user),
  };
}

function collectWeixinBotConfigs(store) {
  const fallbackBot = normalizeWeixinBotRecord(store?.weixinBot);
  const deduped = new Map();

  for (const user of store?.users || []) {
    const binding = normalizeWeixinBindingRecord(user?.weixinBinding);
    const config = buildWeixinBotConfigFromBinding(user, binding, fallbackBot);
    if (!config) {
      continue;
    }
    const existing = deduped.get(config.accountId);
    if (!existing || new Date(config.updatedAt).getTime() >= new Date(existing.updatedAt).getTime()) {
      deduped.set(config.accountId, config);
    }
  }

  return [...deduped.values()].sort((left, right) => {
    return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
  });
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
    invitedByUserId: typeof user?.invitedByUserId === 'string' && user.invitedByUserId.trim() ? user.invitedByUserId.trim() : null,
    invitedByName: typeof user?.invitedByName === 'string' && user.invitedByName.trim() ? user.invitedByName.trim() : null,
    inviteCodeUsed: typeof user?.inviteCodeUsed === 'string' && user.inviteCodeUsed.trim() ? user.inviteCodeUsed.trim().toUpperCase() : null,
    currentCaseBridge: normalizeBridgeState(user?.currentCaseBridge),
    weixinBinding: normalizeWeixinBindingRecord(user?.weixinBinding),
  };
}

function normalizeInviteCodeRecord(code, record) {
  if (!record || typeof record !== 'object') {
    return null;
  }
  const normalizedCode = String(code || record.code || '').trim().toUpperCase();
  if (!normalizedCode) {
    return null;
  }
  const createdByUserId = typeof record.createdByUserId === 'string' && record.createdByUserId.trim()
    ? record.createdByUserId.trim()
    : null;
  const createdByName = typeof record.createdByName === 'string' && record.createdByName.trim()
    ? record.createdByName.trim()
    : null;
  const createdByRole = record.createdByRole === 'admin' ? 'admin' : 'user';
  const status = record.status === 'used' ? 'used' : 'unused';
  const usedByUserId = typeof record.usedByUserId === 'string' && record.usedByUserId.trim()
    ? record.usedByUserId.trim()
    : null;
  const usedByName = typeof record.usedByName === 'string' && record.usedByName.trim()
    ? record.usedByName.trim()
    : null;
  const usedByPhone = typeof record.usedByPhone === 'string' && record.usedByPhone.trim()
    ? record.usedByPhone.trim()
    : null;
  return {
    code: normalizedCode,
    createdByUserId,
    createdByName,
    createdByRole,
    status,
    usedByUserId,
    usedByName,
    usedByPhone,
    createdAt: isIsoDate(record.createdAt) ? new Date(record.createdAt).toISOString() : nowIso(),
    updatedAt: isIsoDate(record.updatedAt) ? new Date(record.updatedAt).toISOString() : nowIso(),
    usedAt: isIsoDate(record.usedAt) ? new Date(record.usedAt).toISOString() : null,
  };
}

function normalizeInviteCodeMap(value) {
  const source = value && typeof value === 'object' ? value : {};
  const out = {};
  for (const [code, record] of Object.entries(source)) {
    const normalized = normalizeInviteCodeRecord(code, record);
    if (normalized) {
      out[normalized.code] = normalized;
    }
  }
  return out;
}

function countInviteCodesByCreator(store, userId) {
  const normalizedUserId = String(userId || '').trim();
  if (!normalizedUserId) {
    return 0;
  }
  return Object.values(store?.inviteCodes || {}).filter((item) => item.createdByUserId === normalizedUserId).length;
}

function buildInviteQuota(user, store) {
  if (!user) {
    return null;
  }
  if (user.role === 'admin') {
    return {
      isUnlimited: true,
      limit: null,
      created: countInviteCodesByCreator(store, user.id),
      remaining: null,
      canGenerate: true,
    };
  }
  const created = countInviteCodesByCreator(store, user.id);
  const remaining = Math.max(0, DEFAULT_INVITE_CODE_LIMIT - created);
  return {
    isUnlimited: false,
    limit: DEFAULT_INVITE_CODE_LIMIT,
    created,
    remaining,
    canGenerate: remaining > 0,
  };
}

function generateInviteCodeCandidate() {
  return `HYF-${randomBytes(4).toString('hex').toUpperCase()}`;
}

function createUniqueInviteCode(store) {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const code = generateInviteCodeCandidate();
    if (!store?.inviteCodes?.[code]) {
      return code;
    }
  }
  throw new Error('邀请码生成失败，请稍后重试。');
}

function publicInviteCode(record) {
  const normalized = normalizeInviteCodeRecord(record?.code, record);
  if (!normalized) {
    return null;
  }
  return {
    code: normalized.code,
    createdByUserId: normalized.createdByUserId,
    createdByName: normalized.createdByName,
    createdByRole: normalized.createdByRole,
    status: normalized.status,
    usedByUserId: normalized.usedByUserId,
    usedByName: normalized.usedByName,
    usedByPhone: normalized.usedByPhone,
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
    usedAt: normalized.usedAt,
  };
}

function listInviteCodesByCreator(store, userId) {
  const normalizedUserId = String(userId || '').trim();
  return Object.values(store?.inviteCodes || {})
    .map((record) => publicInviteCode(record))
    .filter((record) => record && record.createdByUserId === normalizedUserId)
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
}

function listInviteCodesForAdmin(store) {
  return Object.values(store?.inviteCodes || {})
    .map((record) => publicInviteCode(record))
    .filter(Boolean)
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
}

function toIsoTimestampOrZero(value) {
  return isIsoDate(value) ? new Date(value).getTime() : 0;
}

function getUserDeduplicationKey(user) {
  const normalized = normalizeUserRecord(user);
  if (normalized.role === 'admin' || normalized.username) {
    return `username:${String(normalized.username || ADMIN_USERNAME).trim().toLowerCase()}`;
  }
  if (normalized.phone) {
    return `phone:${normalized.phone}`;
  }
  return `id:${normalized.id}`;
}

function scoreUserForDedup(user) {
  const normalized = normalizeUserRecord(user);
  let score = 0;
  if (normalized.role === 'admin') {
    score += 1_000_000;
  }
  if (normalized.weixinBinding?.weixinUserId) {
    score += 100_000;
  }
  if (normalized.apiKey) {
    score += 50_000;
  }
  if (normalized.currentCaseBridge) {
    score += 10_000;
  }
  if (normalized.lastLoginAt) {
    score += 5_000;
  }
  if (normalized.passwordHash) {
    score += 1_000;
  }
  score += Math.floor(toIsoTimestampOrZero(normalized.updatedAt) / 1_000_000);
  score += Math.floor(toIsoTimestampOrZero(normalized.createdAt) / 10_000_000);
  return score;
}

function pickPreferredUserRecord(left, right) {
  const normalizedLeft = normalizeUserRecord(left);
  const normalizedRight = normalizeUserRecord(right);
  const leftScore = scoreUserForDedup(normalizedLeft);
  const rightScore = scoreUserForDedup(normalizedRight);
  if (leftScore !== rightScore) {
    return leftScore >= rightScore ? normalizedLeft : normalizedRight;
  }
  return toIsoTimestampOrZero(normalizedLeft.updatedAt) >= toIsoTimestampOrZero(normalizedRight.updatedAt)
    ? normalizedLeft
    : normalizedRight;
}

function mergeDuplicateUserRecords(primaryUser, secondaryUser) {
  const primary = normalizeUserRecord(primaryUser);
  const secondary = normalizeUserRecord(secondaryUser);
  const preferred = pickPreferredUserRecord(primary, secondary);
  const fallback = preferred.id === primary.id ? secondary : primary;
  const mergedBinding = (() => {
    if (preferred.weixinBinding?.weixinUserId && fallback.weixinBinding?.weixinUserId) {
      return toIsoTimestampOrZero(preferred.weixinBinding.updatedAt) >= toIsoTimestampOrZero(fallback.weixinBinding.updatedAt)
        ? preferred.weixinBinding
        : fallback.weixinBinding;
    }
    return preferred.weixinBinding || fallback.weixinBinding || null;
  })();
  const mergedBridge = preferred.currentCaseBridge || fallback.currentCaseBridge || null;
  const lastLoginAt = [preferred.lastLoginAt, fallback.lastLoginAt]
    .filter(Boolean)
    .sort((left, right) => toIsoTimestampOrZero(right) - toIsoTimestampOrZero(left))[0] || null;
  const updatedAt = [preferred.updatedAt, fallback.updatedAt]
    .filter(Boolean)
    .sort((left, right) => toIsoTimestampOrZero(right) - toIsoTimestampOrZero(left))[0] || nowIso();
  const createdAt = [preferred.createdAt, fallback.createdAt]
    .filter(Boolean)
    .sort((left, right) => toIsoTimestampOrZero(left) - toIsoTimestampOrZero(right))[0] || nowIso();
  return normalizeUserRecord({
    ...preferred,
    role: preferred.role === 'admin' || fallback.role === 'admin' ? 'admin' : preferred.role,
    username: preferred.username || fallback.username || null,
    name: preferred.name || fallback.name || '',
    organization: preferred.organization || fallback.organization || '',
    phone: preferred.phone || fallback.phone || '',
    passwordHash: preferred.passwordHash || fallback.passwordHash || '',
    apiKey: preferred.apiKey || fallback.apiKey || null,
    apiKeyExpiresAt: preferred.apiKeyExpiresAt || fallback.apiKeyExpiresAt || null,
    currentCaseBridge: mergedBridge,
    weixinBinding: mergedBinding,
    lastLoginAt,
    updatedAt,
    createdAt,
  });
}

function dedupeUsersByIdentity(users) {
  const source = Array.isArray(users) ? users : [];
  const deduped = new Map();
  let changed = false;
  for (const item of source) {
    const normalized = normalizeUserRecord(item);
    const key = getUserDeduplicationKey(normalized);
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, normalized);
      continue;
    }
    changed = true;
    deduped.set(key, mergeDuplicateUserRecords(existing, normalized));
  }
  return {
    users: [...deduped.values()],
    changed,
  };
}

function findUserForSessionContext(store, sessionUser) {
  if (!store || !sessionUser) {
    return null;
  }
  const directMatch = store.users.find((item) => item.id === sessionUser.id);
  if (directMatch) {
    return directMatch;
  }
  const normalizedPhone = normalizePhone(sessionUser.phone || '');
  if (normalizedPhone) {
    const phoneMatches = store.users.filter((item) => item.phone === normalizedPhone);
    if (phoneMatches.length > 0) {
      return phoneMatches.reduce((best, candidate) => pickPreferredUserRecord(best, candidate));
    }
  }
  const normalizedUsername = String(sessionUser.username || '').trim().toLowerCase();
  if (normalizedUsername) {
    const usernameMatch = store.users.find((item) => String(item.username || '').trim().toLowerCase() === normalizedUsername);
    if (usernameMatch) {
      return usernameMatch;
    }
  }
  return null;
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

function normalizeWeixinBotRecord(record) {
  if (!record || typeof record !== 'object') {
    return null;
  }
  const accountId = typeof record.accountId === 'string' ? record.accountId.trim() : '';
  const token = typeof record.token === 'string' ? record.token.trim() : '';
  if (!accountId || !token) {
    return null;
  }
  return {
    accountId,
    token,
    baseUrl: typeof record.baseUrl === 'string' && record.baseUrl.trim()
      ? record.baseUrl.trim().replace(/\/+$/, '')
      : WEIXIN_FIXED_BASE_URL,
    botType: typeof record.botType === 'string' && record.botType.trim()
      ? record.botType.trim()
      : WEIXIN_BOT_TYPE,
    configuredAt: isIsoDate(record.configuredAt) ? new Date(record.configuredAt).toISOString() : nowIso(),
    updatedAt: isIsoDate(record.updatedAt) ? new Date(record.updatedAt).toISOString() : nowIso(),
    lastLinkedUserId: typeof record.lastLinkedUserId === 'string' && record.lastLinkedUserId.trim()
      ? record.lastLinkedUserId.trim()
      : null,
  };
}

function publicWeixinBotRecord(record) {
  if (!record) {
    return {
      configured: false,
    };
  }
  return {
    configured: true,
    accountId: record.accountId,
    baseUrl: record.baseUrl,
    botType: record.botType,
    configuredAt: record.configuredAt,
    updatedAt: record.updatedAt,
    lastLinkedUserId: maskWeixinUserId(record.lastLinkedUserId),
    token: record.token,
  };
}

function isWeixinBindingSessionActive(session) {
  if (!session?.expiresAt) {
    return false;
  }
  return new Date(session.expiresAt).getTime() > Date.now();
}

function normalizeWeixinBindingSessionRecord(sessionKey, session) {
  if (!session || typeof session !== 'object') {
    return null;
  }
  const normalizedSessionKey = String(sessionKey || session.sessionKey || '').trim();
  const qrcode = typeof session.qrcode === 'string' ? session.qrcode.trim() : '';
  const qrcodeUrl = typeof session.qrcodeUrl === 'string' ? session.qrcodeUrl.trim() : '';
  const userId = typeof session.userId === 'string' ? session.userId.trim() : '';
  if (!normalizedSessionKey || !qrcode || !qrcodeUrl || !userId) {
    return null;
  }
  return {
    sessionKey: normalizedSessionKey,
    userId,
    qrcode,
    qrcodeUrl,
    botType: typeof session.botType === 'string' && session.botType.trim()
      ? session.botType.trim()
      : WEIXIN_BOT_TYPE,
    status: typeof session.status === 'string' && session.status.trim()
      ? session.status.trim()
      : 'wait',
    message: typeof session.message === 'string' && session.message.trim()
      ? session.message.trim()
      : '',
    currentApiBaseUrl: typeof session.currentApiBaseUrl === 'string' && session.currentApiBaseUrl.trim()
      ? session.currentApiBaseUrl.trim().replace(/\/+$/, '')
      : WEIXIN_FIXED_BASE_URL,
    redirectHost: typeof session.redirectHost === 'string' && session.redirectHost.trim()
      ? session.redirectHost.trim()
      : null,
    startedAt: isIsoDate(session.startedAt) ? new Date(session.startedAt).toISOString() : nowIso(),
    updatedAt: isIsoDate(session.updatedAt) ? new Date(session.updatedAt).toISOString() : nowIso(),
    expiresAt: isIsoDate(session.expiresAt)
      ? new Date(session.expiresAt).toISOString()
      : addMinutesIso(WEIXIN_BINDING_TTL_MINUTES),
  };
}

function normalizeWeixinBindingSessionMap(value) {
  const source = value && typeof value === 'object' ? value : {};
  const out = {};
  for (const [sessionKey, session] of Object.entries(source)) {
    const normalized = normalizeWeixinBindingSessionRecord(sessionKey, session);
    if (normalized && isWeixinBindingSessionActive(normalized)) {
      out[normalized.sessionKey] = normalized;
    }
  }
  return out;
}

function publicWeixinBindingSession(session) {
  if (!session) {
    return null;
  }
  return {
    sessionKey: session.sessionKey,
    qrcodeUrl: session.qrcodeUrl,
    qrcodeDataUrl: buildWeixinQrDataUrl(session.qrcodeUrl),
    botType: session.botType,
    status: session.status,
    message: session.message || '',
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    expiresAt: session.expiresAt,
    active: isWeixinBindingSessionActive(session),
  };
}

function buildWeixinQrDataUrl(value) {
  const source = String(value || '').trim();
  if (!source) {
    return null;
  }
  try {
    const qr = createQrCode(0, 'M');
    qr.addData(source);
    qr.make();
    const svgText = qr.createSvgTag(8, 8, 'HYFCeph WeChat binding QR', 'HYFCeph WeChat binding QR');
    return `data:image/svg+xml;base64,${Buffer.from(svgText, 'utf8').toString('base64')}`;
  } catch {
    return null;
  }
}

function normalizeStoreRecord(store) {
  const source = store && typeof store === 'object' ? store : {};
  return {
    users: Array.isArray(source.users) ? source.users.map(normalizeUserRecord) : [],
    inviteCodes: normalizeInviteCodeMap(source.inviteCodes),
    operatorSession: normalizeOperatorSession(source.operatorSession),
    pdfLinks: normalizePdfLinkMap(source.pdfLinks),
    reportLinks: normalizeReportLinkMap(source.reportLinks),
    weixinBot: normalizeWeixinBotRecord(source.weixinBot),
    weixinBindingSessions: normalizeWeixinBindingSessionMap(source.weixinBindingSessions),
  };
}

function normalizePdfLinkRecord(code, record) {
  if (!record || typeof record !== 'object') {
    return null;
  }
  const normalizedCode = String(code || '').trim();
  const objectKey = String(record.objectKey || '').trim();
  if (!normalizedCode || !objectKey) {
    return null;
  }
  return {
    code: normalizedCode,
    objectKey,
    userId: typeof record.userId === 'string' && record.userId.trim() ? record.userId.trim() : null,
    patientName: typeof record.patientName === 'string' && record.patientName.trim() ? record.patientName.trim() : null,
    reportType: typeof record.reportType === 'string' && record.reportType.trim() ? record.reportType.trim() : 'report',
    variant: typeof record.variant === 'string' && record.variant.trim() ? record.variant.trim() : 'standard',
    createdAt: isIsoDate(record.createdAt) ? new Date(record.createdAt).toISOString() : nowIso(),
    updatedAt: isIsoDate(record.updatedAt) ? new Date(record.updatedAt).toISOString() : nowIso(),
    expiresAt: isIsoDate(record.expiresAt) ? new Date(record.expiresAt).toISOString() : addDaysIso(PDF_SHORT_LINK_TTL_DAYS),
    lastAccessedAt: isIsoDate(record.lastAccessedAt) ? new Date(record.lastAccessedAt).toISOString() : null,
  };
}

function normalizePdfLinkMap(value) {
  const source = value && typeof value === 'object' ? value : {};
  const out = {};
  for (const [code, record] of Object.entries(source)) {
    const normalized = normalizePdfLinkRecord(code, record);
    if (normalized) {
      out[normalized.code] = normalized;
    }
  }
  return out;
}

function normalizeReportLinkRecord(code, record) {
  if (!record || typeof record !== 'object') {
    return null;
  }
  const normalizedCode = String(code || '').trim();
  const objectKey = String(record.objectKey || '').trim();
  const payloadObjectKey = String(record.payloadObjectKey || '').trim();
  const inlinePayload = record.inlinePayload && typeof record.inlinePayload === 'object'
    ? record.inlinePayload
    : null;
  if (!normalizedCode || (!objectKey && !payloadObjectKey && !inlinePayload)) {
    return null;
  }
  return {
    code: normalizedCode,
    objectKey: objectKey || null,
    payloadObjectKey: payloadObjectKey || null,
    inlinePayload,
    userId: typeof record.userId === 'string' && record.userId.trim() ? record.userId.trim() : null,
    patientName: typeof record.patientName === 'string' && record.patientName.trim() ? record.patientName.trim() : null,
    reportType: typeof record.reportType === 'string' && record.reportType.trim() ? record.reportType.trim() : 'report',
    variant: typeof record.variant === 'string' && record.variant.trim() ? record.variant.trim() : 'standard',
    createdAt: isIsoDate(record.createdAt) ? new Date(record.createdAt).toISOString() : nowIso(),
    updatedAt: isIsoDate(record.updatedAt) ? new Date(record.updatedAt).toISOString() : nowIso(),
    expiresAt: isIsoDate(record.expiresAt) ? new Date(record.expiresAt).toISOString() : addDaysIso(REPORT_SHORT_LINK_TTL_DAYS),
    lastAccessedAt: isIsoDate(record.lastAccessedAt) ? new Date(record.lastAccessedAt).toISOString() : null,
  };
}

function normalizeReportLinkMap(value) {
  const source = value && typeof value === 'object' ? value : {};
  const out = {};
  for (const [code, record] of Object.entries(source)) {
    const normalized = normalizeReportLinkRecord(code, record);
    if (normalized) {
      out[normalized.code] = normalized;
    }
  }
  return out;
}

function getSortableIsoTimestamp(record) {
  const createdAt = String(record?.createdAt || '').trim();
  if (isIsoDate(createdAt)) {
    return new Date(createdAt).toISOString();
  }
  const updatedAt = String(record?.updatedAt || '').trim();
  if (isIsoDate(updatedAt)) {
    return new Date(updatedAt).toISOString();
  }
  const expiresAt = String(record?.expiresAt || '').trim();
  if (isIsoDate(expiresAt)) {
    return new Date(expiresAt).toISOString();
  }
  return nowIso();
}

function pruneStoreForFeishuRecordLimit(store, maxRecords = FEISHU_STORE_MAX_RECORDS) {
  const normalizedStore = normalizeStoreRecord(store);
  if (!Number.isFinite(maxRecords) || maxRecords < 1) {
    return {
      store: normalizedStore,
      prunedCount: 0,
    };
  }

  const currentRows = buildFeishuStoreRows(normalizedStore);
  if (currentRows.length < maxRecords) {
    return {
      store: normalizedStore,
      prunedCount: 0,
    };
  }

  const targetRows = Math.max(1, maxRecords - 1);
  const pruneCount = currentRows.length - targetRows;
  if (pruneCount <= 0) {
    return {
      store: normalizedStore,
      prunedCount: 0,
    };
  }

  const reportEntries = Object.entries(normalizedStore.reportLinks || {})
    .map(([code, record]) => [code, normalizeReportLinkRecord(code, record)])
    .filter(([, record]) => Boolean(record))
    .sort((left, right) => {
      const leftTime = new Date(getSortableIsoTimestamp(left[1])).getTime();
      const rightTime = new Date(getSortableIsoTimestamp(right[1])).getTime();
      if (leftTime !== rightTime) {
        return leftTime - rightTime;
      }
      return String(left[0]).localeCompare(String(right[0]));
    });

  if (!reportEntries.length) {
    return {
      store: normalizedStore,
      prunedCount: 0,
    };
  }

  const deleteCodes = new Set(reportEntries.slice(0, pruneCount).map(([code]) => code));
  if (!deleteCodes.size) {
    return {
      store: normalizedStore,
      prunedCount: 0,
    };
  }

  const nextReportLinks = {};
  for (const [code, record] of Object.entries(normalizedStore.reportLinks || {})) {
    if (!deleteCodes.has(code)) {
      nextReportLinks[code] = record;
    }
  }

  return {
    store: {
      ...normalizedStore,
      reportLinks: nextReportLinks,
    },
    prunedCount: deleteCodes.size,
  };
}

function createPdfShortCode() {
  return randomBytes(6).toString('base64url').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 8);
}

function buildPortalOrigin(request = null) {
  if (process.env.HYFCEPH_PUBLIC_BASE_URL) {
    return String(process.env.HYFCEPH_PUBLIC_BASE_URL).trim().replace(/\/+$/, '');
  }
  if (request?.headers?.host) {
    const host = String(request.headers.host).trim();
    const forwardedProto = String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const proto = forwardedProto || (process.env.VERCEL || process.env.NODE_ENV === 'production' ? 'https' : 'http');
    return `${proto}://${host}`.replace(/\/+$/, '');
  }
  return `http://${HOST}:${PORT}`;
}

function buildPdfShortUrl(code, request = null) {
  return `${buildPortalOrigin(request)}/pdf/${encodeURIComponent(code)}`;
}

function buildReportShortUrl(code, request = null, variant = 'standard') {
  const prefix = variant === 'pretty' ? 'report-pretty' : 'report';
  return `${buildPortalOrigin(request)}/${prefix}/${encodeURIComponent(code)}`;
}

function isPdfLinkExpired(record) {
  if (!record?.expiresAt) return false;
  return new Date(record.expiresAt).getTime() <= Date.now();
}

function isReportLinkExpired(record) {
  if (!record?.expiresAt) return false;
  return new Date(record.expiresAt).getTime() <= Date.now();
}

async function createPdfShortLinkRecord({ store, user, objectKey, patientName, reportType }) {
  const normalizedStore = normalizeStoreRecord(store);
  const pdfLinks = { ...(normalizedStore.pdfLinks || {}) };
  let code = '';
  do {
    code = createPdfShortCode();
  } while (pdfLinks[code]);

  pdfLinks[code] = {
    code,
    objectKey,
    userId: user?.id || null,
    patientName: patientName || null,
    reportType: reportType || 'report',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    expiresAt: addDaysIso(PDF_SHORT_LINK_TTL_DAYS),
    lastAccessedAt: null,
  };

  const nextStore = {
    ...normalizedStore,
    pdfLinks,
  };
  await writeStore(nextStore);
  return {
    store: nextStore,
    code,
    shortUrl: buildPdfShortUrl(code),
  };
}

async function issuePdfShortLink({ user, objectKey, patientName, reportType, request = null }) {
  const store = await readStore();
  const created = await createPdfShortLinkRecord({
    store,
    user,
    objectKey,
    patientName,
    reportType,
  });
  return {
    code: created.code,
    shortUrl: buildPdfShortUrl(created.code, request),
  };
}

async function createReportShortLinkRecord({ store, user, objectKey = '', payloadObjectKey = '', inlinePayload = null, patientName, reportType, variant = 'standard' }) {
  const normalizedStore = normalizeStoreRecord(store);
  const reportLinks = { ...(normalizedStore.reportLinks || {}) };
  const normalizedObjectKey = String(objectKey || '').trim();
  const normalizedPayloadObjectKey = String(payloadObjectKey || '').trim();
  const normalizedInlinePayload = inlinePayload && typeof inlinePayload === 'object' ? inlinePayload : null;
  if (!normalizedObjectKey && !normalizedPayloadObjectKey && !normalizedInlinePayload) {
    throw new Error('缺少报告内容来源。');
  }
  let code = '';
  do {
    code = createPdfShortCode();
  } while (reportLinks[code]);

  reportLinks[code] = {
    code,
    objectKey: normalizedObjectKey || null,
    payloadObjectKey: normalizedPayloadObjectKey || null,
    inlinePayload: normalizedInlinePayload,
    userId: user?.id || null,
    patientName: patientName || null,
    reportType: reportType || 'report',
    variant,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    expiresAt: addDaysIso(REPORT_SHORT_LINK_TTL_DAYS),
    lastAccessedAt: null,
  };

  const nextStore = {
    ...normalizedStore,
    reportLinks,
  };
  await writeStore(nextStore);
  return {
    store: nextStore,
    code,
    shortUrl: buildReportShortUrl(code, null, variant),
  };
}

async function issueReportShortLink({ user, objectKey = '', payloadObjectKey = '', inlinePayload = null, patientName, reportType, request = null, variant = 'standard' }) {
  const store = await readStore();
  const created = await createReportShortLinkRecord({
    store,
    user,
    objectKey,
    payloadObjectKey,
    inlinePayload,
    patientName,
    reportType,
    variant,
  });
  return {
    code: created.code,
    shortUrl: buildReportShortUrl(created.code, request, variant),
  };
}

async function handleIssueReportLinks(request, response) {
  const payload = await readRequestJson(request);
  const apiKey = String(payload.apiKey || request.headers['x-api-key'] || '').trim();
  const patientName = String(payload.patientName || '').trim();
  const reportType = String(payload.reportType || payload.mode || 'image').trim() || 'image';
  const resultPayloadKey = String(payload.resultPayloadKey || '').trim();
  const inlinePayload = payload.resultPayload && typeof payload.resultPayload === 'object'
    ? payload.resultPayload
    : null;

  if (!apiKey) {
    return sendJson(response, 400, { error: '缺少 API Key。' });
  }
  if (!resultPayloadKey && !inlinePayload) {
    return sendJson(response, 400, { error: '缺少 resultPayloadKey 或 resultPayload。' });
  }

  const { user } = await requireActiveApiKeyUser(apiKey);
  if (!user) {
    return sendJson(response, 401, { error: 'API Key 无效或已过期。' });
  }

  try {
    const report = await issueReportShortLink({
      user,
      payloadObjectKey: resultPayloadKey,
      inlinePayload,
      patientName,
      reportType,
      request,
      variant: 'standard',
    });
    const prettyReport = await issueReportShortLink({
      user,
      payloadObjectKey: resultPayloadKey,
      inlinePayload,
      patientName,
      reportType,
      request,
      variant: 'pretty',
    });
    return sendJson(response, 200, {
      ok: true,
      report: {
        ok: true,
        shortCode: report.code,
        shortUrl: report.shortUrl,
        reportShareUrl: report.shortUrl,
      },
      prettyReport: {
        ok: true,
        shortCode: prettyReport.code,
        shortUrl: prettyReport.shortUrl,
        reportShareUrl: prettyReport.shortUrl,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return sendJson(response, 502, { error: message || '报告短链接生成失败。' });
  }
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

function shouldUseFeishuBitableStore() {
  return STORE_BACKEND === 'feishu-bitable' || STORE_BACKEND === 'feishu';
}

function isFeishuBitableConfigured() {
  return Boolean(FEISHU_APP_ID && FEISHU_APP_SECRET && FEISHU_BITABLE_APP_TOKEN && FEISHU_BITABLE_TABLE_ID);
}

async function loadBlobSdk() {
  if (!blobSdkPromise) {
    blobSdkPromise = import('@vercel/blob');
  }
  return blobSdkPromise;
}

async function getFeishuAppAccessToken() {
  if (!isFeishuBitableConfigured()) {
    throw new Error('飞书多维表格存储未配置完整。');
  }
  if (feishuAppTokenCache && feishuAppTokenCache.expiresAt > Date.now() + 60_000) {
    return feishuAppTokenCache.token;
  }

  const response = await fetch(`${FEISHU_API_BASE}/auth/v3/app_access_token/internal`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      app_id: FEISHU_APP_ID,
      app_secret: FEISHU_APP_SECRET,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || Number(payload.code || 0) !== 0 || !payload.app_access_token) {
    throw new Error(payload.msg || '获取飞书 app_access_token 失败。');
  }

  const expireSeconds = Number(payload.expire || payload.expire_in || 7200);
  feishuAppTokenCache = {
    token: String(payload.app_access_token),
    expiresAt: Date.now() + Math.max(300, expireSeconds) * 1000,
  };
  return feishuAppTokenCache.token;
}

async function callFeishuBitableApi(method, apiPath, body = null) {
  const accessToken = await getFeishuAppAccessToken();
  const response = await fetch(`${FEISHU_API_BASE}${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || Number(payload.code || 0) !== 0) {
    throw new Error(payload.msg || `飞书多维表格请求失败（${response.status}）。`);
  }
  return payload.data || {};
}

async function listFeishuTables() {
  const result = await callFeishuBitableApi(
    'GET',
    `/bitable/v1/apps/${encodeURIComponent(FEISHU_BITABLE_APP_TOKEN)}/tables?page_size=100`,
  );
  return Array.isArray(result.items) ? result.items : [];
}

async function listFeishuTableViews(tableId) {
  const result = await callFeishuBitableApi(
    'GET',
    `/bitable/v1/apps/${encodeURIComponent(FEISHU_BITABLE_APP_TOKEN)}/tables/${encodeURIComponent(tableId)}/views?page_size=100`,
  );
  return Array.isArray(result.items) ? result.items : [];
}

async function ensureFeishuTableViews(tableId, viewNames = []) {
  const desiredNames = Array.from(new Set(
    (Array.isArray(viewNames) ? viewNames : [])
      .map((item) => String(item || '').trim())
      .filter(Boolean),
  ));
  if (!desiredNames.length) {
    return;
  }

  const existingViews = await listFeishuTableViews(tableId);
  const existingNames = new Set(
    existingViews.map((item) => String(item?.view_name || '').trim()).filter(Boolean),
  );

  for (const viewName of desiredNames) {
    if (existingNames.has(viewName)) {
      continue;
    }
    await callFeishuBitableApi(
      'POST',
      `/bitable/v1/apps/${encodeURIComponent(FEISHU_BITABLE_APP_TOKEN)}/tables/${encodeURIComponent(tableId)}/views`,
      {
        view_name: viewName,
        view_type: 'grid',
      },
    );
    existingNames.add(viewName);
  }
}

function readFeishuCellText(value) {
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === 'string') {
        return item;
      }
      if (item && typeof item.text === 'string') {
        return item.text;
      }
      return '';
    }).join('');
  }
  if (typeof value === 'string') {
    return value;
  }
  return '';
}

async function ensureFeishuBitableStoreSchema() {
  if (feishuSchemaCache) {
    return feishuSchemaCache;
  }
  if (!isFeishuBitableConfigured()) {
    throw new Error('飞书多维表格存储未配置完整。');
  }

  const basePath = `/bitable/v1/apps/${encodeURIComponent(FEISHU_BITABLE_APP_TOKEN)}/tables/${encodeURIComponent(FEISHU_BITABLE_TABLE_ID)}`;
  const fieldsData = await callFeishuBitableApi('GET', `${basePath}/fields?page_size=100`);
  const items = Array.isArray(fieldsData.items) ? fieldsData.items : [];
  const primaryField = items.find((field) => field?.is_primary) || null;
  if (!primaryField?.field_name) {
    throw new Error('飞书多维表格缺少主字段，无法初始化存储。');
  }

  const fieldNames = new Set(items.map((field) => String(field?.field_name || '').trim()).filter(Boolean));
  for (const fieldName of [FEISHU_STORE_PAYLOAD_FIELD, FEISHU_STORE_UPDATED_AT_FIELD, FEISHU_STORE_KIND_FIELD, FEISHU_STORE_KIND_LABEL_FIELD, FEISHU_STORE_SUMMARY_FIELD]) {
    if (!fieldNames.has(fieldName)) {
      await callFeishuBitableApi('POST', `${basePath}/fields`, {
        field_name: fieldName,
        type: 1,
      });
      fieldNames.add(fieldName);
    }
  }

  feishuSchemaCache = {
    basePath,
    primaryFieldName: String(primaryField.field_name),
    payloadFieldName: FEISHU_STORE_PAYLOAD_FIELD,
    updatedAtFieldName: FEISHU_STORE_UPDATED_AT_FIELD,
    kindFieldName: FEISHU_STORE_KIND_FIELD,
    kindLabelFieldName: FEISHU_STORE_KIND_LABEL_FIELD,
    summaryFieldName: FEISHU_STORE_SUMMARY_FIELD,
  };
  return feishuSchemaCache;
}

async function ensureFeishuMetricsSchema() {
  if (feishuMetricsSchemaCache) {
    return feishuMetricsSchemaCache;
  }
  if (!isFeishuBitableConfigured()) {
    throw new Error('飞书多维表格存储未配置完整。');
  }

  const tables = await listFeishuTables();
  let table = tables.find((item) => String(item?.name || '').trim() === FEISHU_METRICS_TABLE_NAME) || null;
  if (!table?.table_id) {
    const created = await callFeishuBitableApi(
      'POST',
      `/bitable/v1/apps/${encodeURIComponent(FEISHU_BITABLE_APP_TOKEN)}/tables`,
      {
        table: {
          name: FEISHU_METRICS_TABLE_NAME,
        },
      },
    );
    table = {
      table_id: created.table_id,
      name: FEISHU_METRICS_TABLE_NAME,
    };
  }

  const basePath = `/bitable/v1/apps/${encodeURIComponent(FEISHU_BITABLE_APP_TOKEN)}/tables/${encodeURIComponent(table.table_id)}`;
  const fieldsData = await callFeishuBitableApi('GET', `${basePath}/fields?page_size=100`);
  const items = Array.isArray(fieldsData.items) ? fieldsData.items : [];
  const primaryField = items.find((field) => field?.is_primary) || null;
  if (!primaryField?.field_name) {
    throw new Error('飞书运营指标表缺少主字段。');
  }

  const fieldNames = new Set(items.map((field) => String(field?.field_name || '').trim()).filter(Boolean));
  const desiredFields = [
    [FEISHU_METRICS_KEY_FIELD, 1],
    [FEISHU_METRICS_VALUE_FIELD, 2],
    [FEISHU_METRICS_UNIT_FIELD, 1],
    [FEISHU_METRICS_DESCRIPTION_FIELD, 1],
    [FEISHU_METRICS_UPDATED_AT_FIELD, 1],
  ];
  for (const [fieldName, fieldType] of desiredFields) {
    if (!fieldNames.has(fieldName)) {
      await callFeishuBitableApi('POST', `${basePath}/fields`, {
        field_name: fieldName,
        type: fieldType,
      });
      fieldNames.add(fieldName);
    }
  }

  await ensureFeishuTableViews(table.table_id, FEISHU_METRICS_VIEW_NAMES);

  feishuMetricsSchemaCache = {
    tableId: table.table_id,
    tableName: FEISHU_METRICS_TABLE_NAME,
    basePath,
    primaryFieldName: String(primaryField.field_name),
    metricKeyFieldName: FEISHU_METRICS_KEY_FIELD,
    metricValueFieldName: FEISHU_METRICS_VALUE_FIELD,
    unitFieldName: FEISHU_METRICS_UNIT_FIELD,
    descriptionFieldName: FEISHU_METRICS_DESCRIPTION_FIELD,
    updatedAtFieldName: FEISHU_METRICS_UPDATED_AT_FIELD,
  };
  return feishuMetricsSchemaCache;
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

async function findFeishuStoreRecord(schema) {
  const result = await callFeishuBitableApi('POST', `${schema.basePath}/records/search`, {
    page_size: 1,
    filter: {
      conjunction: 'and',
      conditions: [
        {
          field_name: schema.primaryFieldName,
          operator: 'is',
          value: [FEISHU_STORE_KEY],
        },
      ],
    },
  });
  const items = Array.isArray(result.items) ? result.items : [];
  return items[0] || null;
}

function buildFeishuStoreRowKey(kind, identifier = 'default') {
  return `${kind}:${String(identifier || 'default').trim() || 'default'}`;
}

function getFeishuStoreKindLabel(kind) {
  switch (String(kind || '').trim()) {
    case FEISHU_ROW_KIND_USER:
      return '用户';
    case FEISHU_ROW_KIND_INVITE_CODE:
      return '邀请码';
    case FEISHU_ROW_KIND_OPERATOR_SESSION:
      return '管理员浏览器会话';
    case FEISHU_ROW_KIND_PDF_LINK:
      return 'PDF 短链';
    case FEISHU_ROW_KIND_REPORT_LINK:
      return '报告短链';
    case FEISHU_ROW_KIND_WEIXIN_BOT:
      return '微信 Bot 配置';
    case FEISHU_ROW_KIND_WEIXIN_BINDING_SESSION:
      return '微信绑定会话';
    case 'legacy_store':
      return '旧版整库快照';
    default:
      return '其他';
  }
}

function buildFeishuStoreSummary(kind, payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  switch (String(kind || '').trim()) {
    case FEISHU_ROW_KIND_USER:
      return [source.name, source.phone, source.username].filter(Boolean).join(' / ') || String(source.id || '').trim() || '用户';
    case FEISHU_ROW_KIND_INVITE_CODE:
      return [
        source.code,
        source.status === 'used'
          ? `已使用 ${source.usedByName || source.usedByPhone || ''}`.trim()
          : '未使用',
        source.createdByName,
      ].filter(Boolean).join(' / ') || String(source.code || '').trim() || '邀请码';
    case FEISHU_ROW_KIND_OPERATOR_SESSION:
      return [source.userName, source.accountType, source.expiresAt].filter(Boolean).join(' / ') || '管理员浏览器会话';
    case FEISHU_ROW_KIND_PDF_LINK:
      return [source.patientName, source.variant, source.code].filter(Boolean).join(' / ') || String(source.code || '').trim() || 'PDF 短链';
    case FEISHU_ROW_KIND_REPORT_LINK:
      return [source.patientName, source.variant, source.code].filter(Boolean).join(' / ') || String(source.code || '').trim() || '报告短链';
    case FEISHU_ROW_KIND_WEIXIN_BOT:
      return [source.accountId, source.botType].filter(Boolean).join(' / ') || '微信 Bot 配置';
    case FEISHU_ROW_KIND_WEIXIN_BINDING_SESSION:
      return [source.userId, source.status, source.sessionKey].filter(Boolean).join(' / ') || String(source.sessionKey || '').trim() || '微信绑定会话';
    default:
      return String(source.code || source.id || source.sessionKey || '').trim() || getFeishuStoreKindLabel(kind);
  }
}

function inferFeishuStoreRowKind(primaryKey, fieldKind = '') {
  const normalizedFieldKind = String(fieldKind || '').trim();
  if (normalizedFieldKind) {
    return normalizedFieldKind;
  }
  const normalizedPrimaryKey = String(primaryKey || '').trim();
  if (!normalizedPrimaryKey) {
    return '';
  }
  if (normalizedPrimaryKey === FEISHU_STORE_KEY) {
    return 'legacy_store';
  }
  const separatorIndex = normalizedPrimaryKey.indexOf(':');
  return separatorIndex > 0 ? normalizedPrimaryKey.slice(0, separatorIndex) : '';
}

function isManagedFeishuStoreRow(primaryKey, kind = '') {
  const normalizedPrimaryKey = String(primaryKey || '').trim();
  const inferredKind = inferFeishuStoreRowKind(normalizedPrimaryKey, kind);
  return normalizedPrimaryKey === FEISHU_STORE_KEY
    || FEISHU_MANAGED_ROW_PREFIXES.some((prefix) => normalizedPrimaryKey.startsWith(prefix))
    || [
      FEISHU_ROW_KIND_USER,
      FEISHU_ROW_KIND_INVITE_CODE,
      FEISHU_ROW_KIND_OPERATOR_SESSION,
      FEISHU_ROW_KIND_PDF_LINK,
      FEISHU_ROW_KIND_REPORT_LINK,
      FEISHU_ROW_KIND_WEIXIN_BOT,
      FEISHU_ROW_KIND_WEIXIN_BINDING_SESSION,
    ].includes(inferredKind);
}

function parseFeishuStorePayload(value) {
  const text = readFeishuCellText(value).trim();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function listFeishuStoreRecords(schema) {
  const items = [];
  const seenTokens = new Set();
  let pageToken = '';

  while (true) {
    const query = new URLSearchParams({ page_size: '500' });
    if (pageToken) {
      query.set('page_token', pageToken);
    }
    const result = await callFeishuBitableApi('GET', `${schema.basePath}/records?${query.toString()}`);
    items.push(...(Array.isArray(result.items) ? result.items : []));

    const hasMore = Boolean(result.has_more ?? result.hasMore ?? result.has_more_page);
    const nextPageToken = String(result.page_token || result.next_page_token || '').trim();
    if (!hasMore || !nextPageToken || seenTokens.has(nextPageToken)) {
      break;
    }
    seenTokens.add(nextPageToken);
    pageToken = nextPageToken;
  }

  return items;
}

async function listFeishuTableRecords(schema) {
  const items = [];
  const seenTokens = new Set();
  let pageToken = '';
  while (true) {
    const query = new URLSearchParams({ page_size: '500' });
    if (pageToken) {
      query.set('page_token', pageToken);
    }
    const result = await callFeishuBitableApi('GET', `${schema.basePath}/records?${query.toString()}`);
    items.push(...(Array.isArray(result.items) ? result.items : []));
    const hasMore = Boolean(result.has_more ?? result.hasMore ?? result.has_more_page);
    const nextPageToken = String(result.page_token || result.next_page_token || '').trim();
    if (!hasMore || !nextPageToken || seenTokens.has(nextPageToken)) {
      break;
    }
    seenTokens.add(nextPageToken);
    pageToken = nextPageToken;
  }
  return items;
}

function buildFeishuStoreRows(store) {
  const normalizedStore = normalizeStoreRecord(store);
  const rows = [];

  for (const user of normalizedStore.users) {
    rows.push({
      key: buildFeishuStoreRowKey(FEISHU_ROW_KIND_USER, user.id),
      kind: FEISHU_ROW_KIND_USER,
      payload: user,
      updatedAt: user.updatedAt || nowIso(),
    });
  }

  for (const record of Object.values(normalizedStore.inviteCodes || {})) {
    rows.push({
      key: buildFeishuStoreRowKey(FEISHU_ROW_KIND_INVITE_CODE, record.code),
      kind: FEISHU_ROW_KIND_INVITE_CODE,
      payload: record,
      updatedAt: record.updatedAt || nowIso(),
    });
  }

  if (normalizedStore.operatorSession) {
    rows.push({
      key: buildFeishuStoreRowKey(FEISHU_ROW_KIND_OPERATOR_SESSION),
      kind: FEISHU_ROW_KIND_OPERATOR_SESSION,
      payload: normalizedStore.operatorSession,
      updatedAt: normalizedStore.operatorSession.updatedAt || normalizedStore.operatorSession.syncedAt || nowIso(),
    });
  }

  if (normalizedStore.weixinBot) {
    rows.push({
      key: buildFeishuStoreRowKey(FEISHU_ROW_KIND_WEIXIN_BOT),
      kind: FEISHU_ROW_KIND_WEIXIN_BOT,
      payload: normalizedStore.weixinBot,
      updatedAt: normalizedStore.weixinBot.updatedAt || nowIso(),
    });
  }

  for (const record of Object.values(normalizedStore.pdfLinks || {})) {
    rows.push({
      key: buildFeishuStoreRowKey(FEISHU_ROW_KIND_PDF_LINK, record.code),
      kind: FEISHU_ROW_KIND_PDF_LINK,
      payload: record,
      updatedAt: record.updatedAt || nowIso(),
    });
  }

  for (const record of Object.values(normalizedStore.reportLinks || {})) {
    rows.push({
      key: buildFeishuStoreRowKey(FEISHU_ROW_KIND_REPORT_LINK, record.code),
      kind: FEISHU_ROW_KIND_REPORT_LINK,
      payload: record,
      updatedAt: record.updatedAt || nowIso(),
    });
  }

  for (const record of Object.values(normalizedStore.weixinBindingSessions || {})) {
    rows.push({
      key: buildFeishuStoreRowKey(FEISHU_ROW_KIND_WEIXIN_BINDING_SESSION, record.sessionKey),
      kind: FEISHU_ROW_KIND_WEIXIN_BINDING_SESSION,
      payload: record,
      updatedAt: record.updatedAt || nowIso(),
    });
  }

  return rows;
}

function buildStoreFromFeishuRows(records, schema) {
  const users = new Map();
  const inviteCodes = {};
  const pdfLinks = {};
  const reportLinks = {};
  const weixinBindingSessions = {};
  let operatorSession = null;
  let weixinBot = null;
  let legacyStore = null;

  for (const record of records) {
    const primaryKey = readFeishuCellText(record.fields?.[schema.primaryFieldName]).trim();
    if (!primaryKey) {
      continue;
    }
    const kind = inferFeishuStoreRowKind(primaryKey, readFeishuCellText(record.fields?.[schema.kindFieldName]));
    const payload = parseFeishuStorePayload(record.fields?.[schema.payloadFieldName]);
    if (!payload) {
      continue;
    }

    if (primaryKey === FEISHU_STORE_KEY) {
      legacyStore = normalizeStoreRecord(payload);
      continue;
    }

    if (kind === FEISHU_ROW_KIND_USER) {
      const user = normalizeUserRecord(payload);
      users.set(user.id, user);
      continue;
    }

    if (kind === FEISHU_ROW_KIND_INVITE_CODE) {
      const inviteCode = normalizeInviteCodeRecord(payload.code, payload);
      if (inviteCode) {
        inviteCodes[inviteCode.code] = inviteCode;
      }
      continue;
    }

    if (kind === FEISHU_ROW_KIND_OPERATOR_SESSION) {
      operatorSession = normalizeOperatorSession(payload);
      continue;
    }

    if (kind === FEISHU_ROW_KIND_WEIXIN_BOT) {
      weixinBot = normalizeWeixinBotRecord(payload);
      continue;
    }

    if (kind === FEISHU_ROW_KIND_PDF_LINK) {
      const pdfLink = normalizePdfLinkRecord(payload.code, payload);
      if (pdfLink) {
        pdfLinks[pdfLink.code] = pdfLink;
      }
      continue;
    }

    if (kind === FEISHU_ROW_KIND_REPORT_LINK) {
      const reportLink = normalizeReportLinkRecord(payload.code, payload);
      if (reportLink) {
        reportLinks[reportLink.code] = reportLink;
      }
      continue;
    }

    if (kind === FEISHU_ROW_KIND_WEIXIN_BINDING_SESSION) {
      const session = normalizeWeixinBindingSessionRecord(payload.sessionKey, payload);
      if (session) {
        weixinBindingSessions[session.sessionKey] = session;
      }
    }
  }

  const rowBasedStore = normalizeStoreRecord({
    users: Array.from(users.values()),
    inviteCodes,
    operatorSession,
    pdfLinks,
    reportLinks,
    weixinBot,
    weixinBindingSessions,
  });

  const hasRowBasedData = rowBasedStore.users.length > 0
    || Object.keys(rowBasedStore.inviteCodes).length > 0
    || Boolean(rowBasedStore.operatorSession)
    || Boolean(rowBasedStore.weixinBot)
    || Object.keys(rowBasedStore.pdfLinks).length > 0
    || Object.keys(rowBasedStore.reportLinks).length > 0
    || Object.keys(rowBasedStore.weixinBindingSessions).length > 0;

  if (hasRowBasedData) {
    return rowBasedStore;
  }

  if (legacyStore) {
    return legacyStore;
  }

  return normalizeStoreRecord({ users: [] });
}

function buildFeishuStoreRowFields(schema, row) {
  return {
    [schema.primaryFieldName]: row.key,
    [schema.kindFieldName]: row.kind,
    [schema.kindLabelFieldName]: getFeishuStoreKindLabel(row.kind),
    [schema.summaryFieldName]: buildFeishuStoreSummary(row.kind, row.payload),
    [schema.payloadFieldName]: JSON.stringify(row.payload, null, 2),
    [schema.updatedAtFieldName]: row.updatedAt || nowIso(),
  };
}

function areFeishuStoreRowFieldsEqual(existingFields, expectedFields) {
  const keys = Object.keys(expectedFields);
  return keys.every((fieldName) => readFeishuCellText(existingFields?.[fieldName]) === String(expectedFields[fieldName] || ''));
}

async function readStoreFromFeishuBitable() {
  const schema = await ensureFeishuBitableStoreSchema();
  const records = await listFeishuStoreRecords(schema);
  return buildStoreFromFeishuRows(records, schema);
}

async function writeStoreToFeishuBitable(store) {
  const schema = await ensureFeishuBitableStoreSchema();
  const { store: prunedStore, prunedCount } = pruneStoreForFeishuRecordLimit(store);
  if (prunedCount > 0) {
    console.warn(`[HYFCeph Portal] Feishu store reached ${FEISHU_STORE_MAX_RECORDS} rows, pruned ${prunedCount} oldest report link record(s).`);
  }
  const existingRecords = await listFeishuStoreRecords(schema);
  const existingByKey = new Map();
  for (const record of existingRecords) {
    const primaryKey = readFeishuCellText(record.fields?.[schema.primaryFieldName]).trim();
    if (primaryKey) {
      existingByKey.set(primaryKey, record);
    }
  }

  const desiredRows = buildFeishuStoreRows(prunedStore);
  const desiredKeys = new Set(desiredRows.map((row) => row.key));

  for (const row of desiredRows) {
    const fields = buildFeishuStoreRowFields(schema, row);
    const existing = existingByKey.get(row.key);
    if (existing?.record_id) {
      if (areFeishuStoreRowFieldsEqual(existing.fields, fields)) {
        continue;
      }
      await callFeishuBitableApi('PUT', `${schema.basePath}/records/${encodeURIComponent(existing.record_id)}`, {
        fields,
      });
      continue;
    }
    await callFeishuBitableApi('POST', `${schema.basePath}/records`, {
      fields,
    });
  }

  for (const record of existingRecords) {
    const primaryKey = readFeishuCellText(record.fields?.[schema.primaryFieldName]).trim();
    const kind = readFeishuCellText(record.fields?.[schema.kindFieldName]).trim();
    if (!record?.record_id || !isManagedFeishuStoreRow(primaryKey, kind) || desiredKeys.has(primaryKey)) {
      continue;
    }
    await callFeishuBitableApi('DELETE', `${schema.basePath}/records/${encodeURIComponent(record.record_id)}`);
  }

  try {
    await syncFeishuMetricsTable(prunedStore);
  } catch (error) {
    console.warn(`[HYFCeph Portal] Feishu metrics sync failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function buildFeishuMetricRows(store) {
  const normalizedStore = normalizeStoreRecord(store);
  const shanghaiToday = getDateKeyInTimeZone(new Date(), 'Asia/Shanghai');
  const users = normalizedStore.users.filter((item) => item.role !== 'admin');
  const usersToday = users.filter((item) => getDateKeyInTimeZone(item.createdAt, 'Asia/Shanghai') === shanghaiToday);
  const reportLinks = Object.values(normalizedStore.reportLinks || {});
  const reportsToday = reportLinks.filter((item) => {
    if ((item.variant || 'standard') !== 'standard') {
      return false;
    }
    return getDateKeyInTimeZone(item.createdAt, 'Asia/Shanghai') === shanghaiToday;
  });
  const bindings = users.filter((item) => item.weixinBinding?.weixinUserId);
  const metrics = {
    user_total: users.length,
    users_today: usersToday.length,
    reports_today: reportsToday.length,
    weixin_bindings_success: bindings.length,
    report_shortlinks_total: reportLinks.length,
  };
  const updatedAt = nowIso();
  return FEISHU_METRIC_DEFINITIONS.map((definition) => ({
    metricKey: definition.key,
    metricName: definition.label,
    value: Number(metrics[definition.key] || 0),
    unit: definition.unit,
    description: definition.description,
    updatedAt,
  }));
}

function buildFeishuMetricFields(schema, row) {
  return {
    [schema.primaryFieldName]: row.metricName,
    [schema.metricKeyFieldName]: row.metricKey,
    [schema.metricValueFieldName]: row.value,
    [schema.unitFieldName]: row.unit,
    [schema.descriptionFieldName]: row.description,
    [schema.updatedAtFieldName]: row.updatedAt,
  };
}

function areFeishuMetricFieldsEqual(existingFields, expectedFields) {
  return Object.keys(expectedFields).every((fieldName) => {
    const expected = expectedFields[fieldName];
    const currentValue = existingFields?.[fieldName];
    if (typeof expected === 'number') {
      return Number(currentValue ?? 0) === expected;
    }
    return readFeishuCellText(currentValue) === String(expected || '');
  });
}

async function syncFeishuMetricsTable(store) {
  const schema = await ensureFeishuMetricsSchema();
  const existingRecords = await listFeishuTableRecords(schema);
  const existingByMetricKey = new Map();
  for (const record of existingRecords) {
    const metricKey = readFeishuCellText(record.fields?.[schema.metricKeyFieldName]).trim();
    if (metricKey) {
      existingByMetricKey.set(metricKey, record);
    }
  }

  const desiredRows = buildFeishuMetricRows(store);
  const desiredKeys = new Set(desiredRows.map((row) => row.metricKey));
  for (const row of desiredRows) {
    const fields = buildFeishuMetricFields(schema, row);
    const existing = existingByMetricKey.get(row.metricKey);
    if (existing?.record_id) {
      if (areFeishuMetricFieldsEqual(existing.fields, fields)) {
        continue;
      }
      await callFeishuBitableApi('PUT', `${schema.basePath}/records/${encodeURIComponent(existing.record_id)}`, {
        fields,
      });
      continue;
    }
    await callFeishuBitableApi('POST', `${schema.basePath}/records`, {
      fields,
    });
  }

  for (const record of existingRecords) {
    const metricKey = readFeishuCellText(record.fields?.[schema.metricKeyFieldName]).trim();
    if (!record?.record_id || !metricKey || desiredKeys.has(metricKey)) {
      continue;
    }
    await callFeishuBitableApi('DELETE', `${schema.basePath}/records/${encodeURIComponent(record.record_id)}`);
  }
}

async function readStoreFromBlob() {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    throw new Error('BLOB_READ_WRITE_TOKEN 未配置，无法使用 Blob 存储。');
  }

  const { get, BlobNotFoundError } = await loadBlobSdk();
  try {
    const result = await get(STORE_BLOB_PATH, {
      access: 'private',
      useCache: false,
      token,
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
    if (error instanceof Error && /403|forbidden|token mismatch/i.test(error.message)) {
      throw new Error('Vercel Blob 读取失败：当前项目连接的私有 Blob Store 或 BLOB_READ_WRITE_TOKEN 不匹配，请重新连接 Blob Store 并 redeploy。');
    }
    throw error;
  }
}

async function writeStoreToBlob(store) {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    throw new Error('BLOB_READ_WRITE_TOKEN 未配置，无法写入 Blob 存储。');
  }

  const { put } = await loadBlobSdk();
  await put(STORE_BLOB_PATH, JSON.stringify(store, null, 2), {
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
    token,
  });
}

async function writeStore(store) {
  if (shouldUseFeishuBitableStore()) {
    return writeStoreToFeishuBitable(store);
  }
  if (shouldUseBlobStore()) {
    return writeStoreToBlob(store);
  }
  return writeStoreToFile(store);
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
  const parsed = shouldUseFeishuBitableStore()
    ? await readStoreFromFeishuBitable()
    : shouldUseBlobStore()
      ? await readStoreFromBlob()
      : await readStoreFromFile();
  const normalized = normalizeStoreRecord(parsed);
  const deduped = dedupeUsersByIdentity(normalized.users);
  const normalizedWithDedup = deduped.changed
    ? { ...normalized, users: deduped.users }
    : normalized;
  const { store, changed } = ensureAdminUser(normalizedWithDedup);
  if (deduped.changed || changed || JSON.stringify(normalizedWithDedup) !== JSON.stringify(store)) {
    await writeStore(store);
  }
  return store;
}

async function readRequestJson(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);
  if (!buffer.length) {
    return {};
  }
  const encoding = String(request.headers['content-encoding'] || '').trim().toLowerCase();
  let decodedBuffer = buffer;
  try {
    if (encoding === 'gzip') {
      decodedBuffer = gunzipSync(buffer);
    } else if (encoding === 'deflate') {
      decodedBuffer = inflateSync(buffer);
    }
  } catch {
    throw new Error('请求体解压失败。');
  }
  const raw = decodedBuffer.toString('utf8').trim();
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('请求体不是合法的 JSON');
  }
}

function decodeUploadedImageFields(fields, label = '图片') {
  const imageBase64 = String(fields?.imageBase64 || '').trim();
  const fileName = String(fields?.fileName || fields?.imageName || '').trim();
  const requestedMimeType = String(fields?.mimeType || '').trim();

  if (!imageBase64) {
    throw new Error(`缺少${label}数据。`);
  }

  let imageBuffer;
  try {
    imageBuffer = Buffer.from(imageBase64, 'base64');
  } catch {
    throw new Error(`${label}编码无效。`);
  }

  if (!imageBuffer.length) {
    throw new Error(`${label}数据为空。`);
  }
  if (imageBuffer.length > MAX_IMAGE_UPLOAD_BYTES) {
    throw new Error(`${label}过大，请控制在 ${Math.floor(MAX_IMAGE_UPLOAD_BYTES / (1024 * 1024))}MB 以内。`);
  }

  const sniffedMimeType = sniffImageMimeType(imageBuffer);
  const mimeType = requestedMimeType && requestedMimeType !== 'image/*'
    ? requestedMimeType
    : sniffedMimeType || requestedMimeType;

  return {
    fileName: sanitizeFileStem(path.basename(fileName || 'ceph-image')),
    mimeType,
    imageBuffer,
  };
}

function decodeUploadedImagePayload(payload) {
  return decodeUploadedImageFields(payload);
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

function buildMeasurementResponseArtifactsFromBuffers({
  output,
  svgText,
  pngBuffer,
  contourSvgText = null,
  contourPngBuffer = null,
}) {
  return {
    analysis: output.analysis || null,
    analysisError: output.analysisError || null,
    annotationError: pngBuffer ? null : (output.annotationError || null),
    contourError: contourPngBuffer ? null : (output.contourError || null),
    summary: output.summary || null,
    metrics: output.analysis?.metrics || [],
    taskId: output.taskId || null,
    resultUrl: output.resultUrl || null,
    artifacts: {
      annotatedPngBase64: pngBuffer ? pngBuffer.toString('base64') : null,
      annotatedPngMimeType: pngBuffer ? 'image/png' : null,
      annotatedSvgBase64: svgText ? Buffer.from(svgText, 'utf8').toString('base64') : null,
      annotatedSvgMimeType: svgText ? 'image/svg+xml' : null,
      contourPngBase64: contourPngBuffer ? contourPngBuffer.toString('base64') : null,
      contourPngMimeType: contourPngBuffer ? 'image/png' : null,
      contourSvgBase64: contourSvgText ? Buffer.from(contourSvgText, 'utf8').toString('base64') : null,
      contourSvgMimeType: contourSvgText ? 'image/svg+xml' : null,
    },
  };
}

async function buildMeasurementResponseArtifacts({
  output,
  annotatedSvgPath,
  annotatedPngPath,
  contourSvgPath = null,
  contourPngPath = null,
}) {
  const svgText = annotatedSvgPath ? await readFileIfExists(annotatedSvgPath, 'utf8') : null;
  let pngBuffer = annotatedPngPath ? await readFileIfExists(annotatedPngPath) : null;
  const contourSvgText = contourSvgPath ? await readFileIfExists(contourSvgPath, 'utf8') : null;
  let contourPngBuffer = contourPngPath ? await readFileIfExists(contourPngPath) : null;

  if (!pngBuffer && svgText) {
    try {
      pngBuffer = await convertSvgTextToPngBuffer(svgText);
    } catch {
      pngBuffer = null;
    }
  }

  if (!contourPngBuffer && contourSvgText) {
    try {
      contourPngBuffer = await convertSvgTextToPngBuffer(contourSvgText);
    } catch {
      contourPngBuffer = null;
    }
  }

  return buildMeasurementResponseArtifactsFromBuffers({
    output,
    svgText,
    pngBuffer,
    contourSvgText,
    contourPngBuffer,
  });
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
    contourError: null,
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
      contourPngBase64: null,
      contourPngMimeType: null,
      contourSvgBase64: null,
      contourSvgMimeType: null,
    },
  };
}

async function executeRunnerMeasurement({
  shareUrl,
  bridgeState,
  imagePath,
  operatorSession,
  annotate = true,
}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyfceph-portal-'));
  const outputPath = path.join(tempDir, 'result.json');
  const annotatedSvgPath = path.join(tempDir, 'annotated.svg');
  const annotatedPngPath = path.join(tempDir, 'annotated.png');
  const contourSvgPath = path.join(tempDir, 'contour.svg');
  const contourPngPath = path.join(tempDir, 'contour.png');
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
    '--contour-output',
    contourSvgPath,
    '--contour-png-output',
    contourPngPath,
    '--downloaded-image-output',
    downloadedImagePath,
  ];

  if (!annotate) {
    args.push('--no-annotated-svg');
  }

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
    const resolvedSvgPath = output.annotatedSvgPath || annotatedSvgPath;
    const resolvedPngPath = output.annotatedPngPath || annotatedPngPath;
    const resolvedContourSvgPath = output.contourSvgPath || contourSvgPath;
    const resolvedContourPngPath = output.contourPngPath || contourPngPath;
    const svgText = annotate ? await readFileIfExists(resolvedSvgPath, 'utf8') : null;
    let pngBuffer = annotate ? await readFileIfExists(resolvedPngPath) : null;
    const contourSvgText = annotate ? await readFileIfExists(resolvedContourSvgPath, 'utf8') : null;
    let contourPngBuffer = annotate ? await readFileIfExists(resolvedContourPngPath) : null;

    if (annotate && !pngBuffer && svgText) {
      try {
        pngBuffer = await convertSvgTextToPngBuffer(svgText);
      } catch {
        pngBuffer = null;
      }
    }

    if (annotate && !contourPngBuffer && contourSvgText) {
      try {
        contourPngBuffer = await convertSvgTextToPngBuffer(contourSvgText);
      } catch {
        contourPngBuffer = null;
      }
    }

    return {
      output,
      svgText,
      pngBuffer,
      contourSvgText,
      contourPngBuffer,
    };
  } catch (error) {
    const stderr = String(error?.stderr || '').trim();
    const stdout = String(error?.stdout || '').trim();
    const reason = stderr || stdout || (error instanceof Error ? error.message : String(error));
    throw new Error(reason || '服务端测量失败。');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function runServerSideMeasurement({
  shareUrl,
  bridgeState,
  imagePath,
  operatorSession,
}) {
  const measurement = await executeRunnerMeasurement({
    shareUrl,
    bridgeState,
    imagePath,
    operatorSession,
    annotate: true,
  });

  return buildMeasurementResponseArtifactsFromBuffers({
    output: measurement.output,
    svgText: measurement.svgText,
    pngBuffer: measurement.pngBuffer,
    contourSvgText: measurement.contourSvgText,
    contourPngBuffer: measurement.contourPngBuffer,
  });
}

async function runServerSideOverlapMeasurement({
  baseImagePath,
  compareImagePath,
  operatorSession,
  alignMode,
}) {
  const [baseMeasurement, compareMeasurement] = await Promise.all([
    executeRunnerMeasurement({
      imagePath: baseImagePath,
      operatorSession,
      annotate: false,
    }),
    executeRunnerMeasurement({
      imagePath: compareImagePath,
      operatorSession,
      annotate: false,
    }),
  ]);

  const overlap = buildOverlapRender({
    baseOutput: baseMeasurement.output,
    compareOutput: compareMeasurement.output,
    alignMode,
  });
  const pngBuffer = await convertSvgTextToPngBuffer(overlap.svgText);

  return {
    analysis: overlap.analysis,
    analysisError: null,
    annotationError: pngBuffer ? null : '未生成 PNG 重叠图。',
    contourError: null,
    summary: overlap.summary,
    metrics: overlap.metrics,
    taskId: null,
    resultUrl: null,
    artifacts: {
      annotatedPngBase64: pngBuffer ? pngBuffer.toString('base64') : null,
      annotatedPngMimeType: pngBuffer ? 'image/png' : null,
      annotatedSvgBase64: Buffer.from(overlap.svgText, 'utf8').toString('base64'),
      annotatedSvgMimeType: 'image/svg+xml',
      contourPngBase64: null,
      contourPngMimeType: null,
      contourSvgBase64: null,
      contourSvgMimeType: null,
    },
  };
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

async function fetchJsonWithTimeout(url, { method = 'GET', headers = {}, body, timeoutMs = 5000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal,
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(raw || `HTTP ${response.status}`);
    }
    return raw.trim() ? JSON.parse(raw) : {};
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWeixinBindingQrCode(botType = WEIXIN_BOT_TYPE) {
  const url = new URL('/ilink/bot/get_bot_qrcode', WEIXIN_FIXED_BASE_URL);
  url.searchParams.set('bot_type', botType);
  const payload = await fetchJsonWithTimeout(url, {
    method: 'GET',
    timeoutMs: WEIXIN_QR_TIMEOUT_MS,
  });
  const qrcode = String(payload.qrcode || '').trim();
  const qrcodeUrl = String(payload.qrcode_img_content || '').trim();
  if (!qrcode || !qrcodeUrl) {
    throw new Error('微信二维码获取失败。');
  }
  return {
    qrcode,
    qrcodeUrl,
  };
}

async function pollWeixinBindingStatus(session) {
  const baseUrl = (session?.currentApiBaseUrl || WEIXIN_FIXED_BASE_URL).replace(/\/+$/, '');
  const url = new URL('/ilink/bot/get_qrcode_status', baseUrl);
  url.searchParams.set('qrcode', session.qrcode);
  try {
    const payload = await fetchJsonWithTimeout(url, {
      method: 'GET',
      timeoutMs: WEIXIN_QR_POLL_TIMEOUT_MS,
    });
    return {
      status: typeof payload.status === 'string' ? payload.status.trim() : 'wait',
      botToken: typeof payload.bot_token === 'string' ? payload.bot_token.trim() : '',
      accountId: typeof payload.ilink_bot_id === 'string' ? payload.ilink_bot_id.trim() : '',
      baseUrl: typeof payload.baseurl === 'string' && payload.baseurl.trim()
        ? payload.baseurl.trim().replace(/\/+$/, '')
        : baseUrl,
      weixinUserId: typeof payload.ilink_user_id === 'string' ? payload.ilink_user_id.trim() : '',
      redirectHost: typeof payload.redirect_host === 'string' ? payload.redirect_host.trim() : '',
    };
  } catch (error) {
    if (error instanceof Error && /timeout/i.test(error.message)) {
      return {
        status: 'wait',
        botToken: '',
        accountId: '',
        baseUrl,
        weixinUserId: '',
        redirectHost: '',
      };
    }
    throw error;
  }
}

function findUserByWeixinUserId(store, weixinUserId) {
  const normalized = String(weixinUserId || '').trim();
  if (!normalized) {
    return null;
  }
  return store.users.find((item) => item.weixinBinding?.weixinUserId === normalized) || null;
}

function secureCompareText(left, right) {
  const leftBuffer = Buffer.from(String(left || ''), 'utf8');
  const rightBuffer = Buffer.from(String(right || ''), 'utf8');
  if (!leftBuffer.length || leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

async function requireWeixinBotAccess(request, response) {
  const providedSecret = String(
    request.headers['x-hyfceph-weixin-secret']
      || request.headers['x-weixin-bot-secret']
      || '',
  ).trim();
  if (providedSecret && secureCompareText(providedSecret, WEIXIN_BOT_SECRET)) {
    return true;
  }

  const apiKey = String(request.headers['x-api-key'] || '').trim();
  if (apiKey) {
    const { user } = await requireActiveAdminApiKey(apiKey);
    if (user) {
      return true;
    }
  }

  sendJson(response, 401, { error: '微信 bot 认证失败。' });
  return false;
}

async function handleRegister(request, response) {
  const payload = await readRequestJson(request);
  const name = String(payload.name || '').trim();
  const organization = String(payload.organization || '').trim();
  const phone = normalizePhone(payload.phone);
  const password = String(payload.password || '');
  const inviteCode = String(payload.inviteCode || '').trim().toUpperCase();

  if (!name || !organization || !phone || !password || !inviteCode) {
    return sendJson(response, 400, { error: '请完整填写名字、单位、手机号、密码和邀请码。' });
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
  const inviteRecord = normalizeInviteCodeRecord(inviteCode, store.inviteCodes?.[inviteCode]);
  if (!inviteRecord) {
    return sendJson(response, 400, { error: '邀请码无效，请检查后再试。' });
  }
  if (inviteRecord.status === 'used') {
    return sendJson(response, 400, { error: `邀请码已被${inviteRecord.usedByName || inviteRecord.usedByPhone || '其他用户'}使用。` });
  }
  const inviter = store.users.find((item) => item.id === inviteRecord.createdByUserId) || null;

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
    invitedByUserId: inviteRecord.createdByUserId || inviter?.id || null,
    invitedByName: inviteRecord.createdByName || inviter?.name || null,
    inviteCodeUsed: inviteRecord.code,
  };
  store.inviteCodes = {
    ...(store.inviteCodes || {}),
    [inviteRecord.code]: normalizeInviteCodeRecord(inviteRecord.code, {
      ...inviteRecord,
      status: 'used',
      usedByUserId: user.id,
      usedByName: user.name,
      usedByPhone: user.phone,
      usedAt: nowIso(),
      updatedAt: nowIso(),
    }),
  };
  store.users.push(user);
  await writeStore(store);

  const sessionToken = createSessionToken(user.id);
  setSessionCookie(response, sessionToken);
  await sendBarkPush('HYFCeph 新注册', `名字：${name}\n单位：${organization}\n手机号：${phone}`);

  return sendJson(response, 201, {
    message: '注册成功，已进入控制台。',
    user: publicUser(user, store),
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
    user: publicUser(user, store),
  });
}

async function handleLogout(_request, response) {
  clearSessionCookie(response);
  return sendJson(response, 200, { ok: true });
}

async function handleCurrentUser(request, response) {
  const currentUser = await getSessionUser(request);
  if (!currentUser) {
    return sendJson(response, 401, { error: '未登录。' });
  }
  const store = await readStore();
  const user = findUserForSessionContext(store, currentUser);
  if (!user) {
    return sendJson(response, 401, { error: '未登录。' });
  }
  return sendJson(response, 200, { user: publicUser(user, store) });
}

async function handleWeixinBindingReadinessGet(request, response) {
  const currentUser = await getSessionUser(request);
  if (!currentUser) {
    return sendJson(response, 401, { error: '请先登录。' });
  }

  const store = await readStore();
  const user = findUserForSessionContext(store, currentUser);
  if (!user) {
    return sendJson(response, 404, { error: '用户不存在。' });
  }

  return sendJson(response, 200, {
    ok: true,
    readiness: buildWeixinBindingReadiness(store, user),
    user: publicUser(user, store),
  });
}

async function handleWeixinBindingStart(request, response) {
  const currentUser = await getSessionUser(request);
  if (!currentUser) {
    return sendJson(response, 401, { error: '请先登录。' });
  }

  const store = await readStore();
  const user = findUserForSessionContext(store, currentUser);
  if (!user) {
    return sendJson(response, 404, { error: '用户不存在。' });
  }

  try {
    const qr = await fetchWeixinBindingQrCode(WEIXIN_BOT_TYPE);
    const sessionKey = randomBytes(12).toString('base64url');
    const nextSessions = { ...(store.weixinBindingSessions || {}) };

    for (const [code, session] of Object.entries(nextSessions)) {
      if (session?.userId === user.id) {
        delete nextSessions[code];
      }
    }

    const session = normalizeWeixinBindingSessionRecord(sessionKey, {
      sessionKey,
      userId: user.id,
      qrcode: qr.qrcode,
      qrcodeUrl: qr.qrcodeUrl,
      botType: WEIXIN_BOT_TYPE,
      status: 'wait',
      message: '请使用微信扫描二维码完成 Clawbot 绑定。',
      currentApiBaseUrl: WEIXIN_FIXED_BASE_URL,
      startedAt: nowIso(),
      updatedAt: nowIso(),
      expiresAt: addMinutesIso(WEIXIN_BINDING_TTL_MINUTES),
    });

    nextSessions[sessionKey] = session;
    store.weixinBindingSessions = nextSessions;
    user.updatedAt = nowIso();
    await writeStore(store);

    return sendJson(response, 200, {
      ok: true,
      session: publicWeixinBindingSession(session),
      binding: publicWeixinBinding(user.weixinBinding),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return sendJson(response, 502, { error: message || '微信绑定二维码生成失败。' });
  }
}

async function handleWeixinBindingStatus(request, response, sessionKey) {
  const currentUser = await getSessionUser(request);
  if (!currentUser) {
    return sendJson(response, 401, { error: '请先登录。' });
  }

  const normalizedSessionKey = String(sessionKey || '').trim();
  if (!normalizedSessionKey) {
    return sendJson(response, 400, { error: '缺少绑定会话。' });
  }

  const store = await readStore();
  const user = store.users.find((item) => item.id === currentUser.id);
  if (!user) {
    return sendJson(response, 404, { error: '用户不存在。' });
  }

  const session = normalizeWeixinBindingSessionRecord(
    normalizedSessionKey,
    store.weixinBindingSessions?.[normalizedSessionKey],
  );
  if (!session || session.userId !== user.id) {
    return sendJson(response, 404, { error: '绑定会话不存在。' });
  }
  if (!isWeixinBindingSessionActive(session)) {
    const nextSessions = { ...(store.weixinBindingSessions || {}) };
    delete nextSessions[normalizedSessionKey];
    store.weixinBindingSessions = nextSessions;
    await writeStore(store);
    return sendJson(response, 410, {
      ok: false,
      expired: true,
      error: '二维码已过期，请重新生成。',
    });
  }

  try {
    const polled = await pollWeixinBindingStatus(session);
    const latestStore = await readStore();
    const latestUser = findUserForSessionContext(latestStore, user);
    if (!latestUser) {
      return sendJson(response, 404, { error: '用户不存在。' });
    }
    const latestSessions = { ...(latestStore.weixinBindingSessions || {}) };
    const latestSession = normalizeWeixinBindingSessionRecord(
      normalizedSessionKey,
      latestSessions[normalizedSessionKey],
    );
    if (!latestSession && latestUser.weixinBinding?.weixinUserId) {
      return sendJson(response, 200, {
        ok: true,
        connected: true,
        binding: publicWeixinBinding(latestUser.weixinBinding),
        user: publicUser(latestUser, latestStore),
        weixinBot: publicWeixinBotRecord(latestStore.weixinBot),
      });
    }
    const baseSession = latestSession || session;
    const nextSession = normalizeWeixinBindingSessionRecord(normalizedSessionKey, {
      ...baseSession,
      status: polled.status || session.status,
      message: polled.status === 'scaned'
        ? '已扫码，请在微信中继续确认。'
        : polled.status === 'confirmed'
          ? '绑定已确认。'
          : polled.status === 'expired'
            ? '二维码已过期。'
            : session.message,
      currentApiBaseUrl: polled.redirectHost ? `https://${polled.redirectHost}` : (polled.baseUrl || baseSession.currentApiBaseUrl),
      redirectHost: polled.redirectHost || baseSession.redirectHost,
      updatedAt: nowIso(),
    });

    if (polled.status === 'scaned_but_redirect' && polled.redirectHost) {
      latestSessions[normalizedSessionKey] = nextSession;
      latestStore.weixinBindingSessions = latestSessions;
      await writeStore(latestStore);
      return sendJson(response, 200, {
        ok: true,
        connected: false,
        session: publicWeixinBindingSession(nextSession),
        binding: publicWeixinBinding(latestUser.weixinBinding),
      });
    }

    if (polled.status === 'expired') {
      delete latestSessions[normalizedSessionKey];
      latestStore.weixinBindingSessions = latestSessions;
      await writeStore(latestStore);
      return sendJson(response, 410, {
        ok: false,
        expired: true,
        error: '二维码已过期，请重新生成。',
      });
    }

    if (polled.status === 'confirmed' && polled.weixinUserId) {
      const existing = findUserByWeixinUserId(latestStore, polled.weixinUserId);
      if (existing && existing.id !== latestUser.id) {
        return sendJson(response, 409, {
          error: '这个微信已经绑定到其他 HYFCeph 账号，请先解绑后再试。',
        });
      }

      latestUser.weixinBinding = normalizeWeixinBindingRecord({
        source: 'weixin-clawbot',
        weixinUserId: polled.weixinUserId,
        botAccountId: polled.accountId || latestStore.weixinBot?.accountId || latestUser.weixinBinding?.botAccountId || null,
        botToken: polled.botToken || latestUser.weixinBinding?.botToken || null,
        botBaseUrl: polled.baseUrl || latestUser.weixinBinding?.botBaseUrl || WEIXIN_FIXED_BASE_URL,
        botType: baseSession.botType || latestUser.weixinBinding?.botType || WEIXIN_BOT_TYPE,
        boundAt: latestUser.weixinBinding?.boundAt || nowIso(),
        updatedAt: nowIso(),
      });
      latestUser.updatedAt = nowIso();

      if (polled.botToken && polled.accountId) {
        const existingBot = normalizeWeixinBotRecord(latestStore.weixinBot);
        latestStore.weixinBot = normalizeWeixinBotRecord({
          accountId: polled.accountId,
          token: polled.botToken,
          baseUrl: polled.baseUrl || existingBot?.baseUrl || WEIXIN_FIXED_BASE_URL,
          botType: baseSession.botType || WEIXIN_BOT_TYPE,
          configuredAt: existingBot?.configuredAt || nowIso(),
          updatedAt: nowIso(),
          lastLinkedUserId: polled.weixinUserId,
        });
      }

      delete latestSessions[normalizedSessionKey];
      latestStore.weixinBindingSessions = latestSessions;
      await writeStore(latestStore);

      return sendJson(response, 200, {
        ok: true,
        connected: true,
        binding: publicWeixinBinding(latestUser.weixinBinding),
        user: publicUser(latestUser, latestStore),
        weixinBot: publicWeixinBotRecord(latestStore.weixinBot),
      });
    }

    latestSessions[normalizedSessionKey] = nextSession;
    latestStore.weixinBindingSessions = latestSessions;
    await writeStore(latestStore);
    return sendJson(response, 200, {
      ok: true,
      connected: false,
      session: publicWeixinBindingSession(nextSession),
      binding: publicWeixinBinding(latestUser.weixinBinding),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return sendJson(response, 502, { error: message || '微信绑定状态刷新失败。' });
  }
}

async function handleWeixinBindingDelete(request, response) {
  const currentUser = await getSessionUser(request);
  if (!currentUser) {
    return sendJson(response, 401, { error: '请先登录。' });
  }

  const store = await readStore();
  const user = store.users.find((item) => item.id === currentUser.id);
  if (!user) {
    return sendJson(response, 404, { error: '用户不存在。' });
  }

  user.weixinBinding = null;
  user.updatedAt = nowIso();

  const nextSessions = { ...(store.weixinBindingSessions || {}) };
  for (const [code, session] of Object.entries(nextSessions)) {
    if (session?.userId === user.id) {
      delete nextSessions[code];
    }
  }
  store.weixinBindingSessions = nextSessions;
  await writeStore(store);

  return sendJson(response, 200, {
    ok: true,
    user: publicUser(user, store),
  });
}

async function handleWeixinBotConfigGet(request, response) {
  if (!await requireWeixinBotAccess(request, response)) {
    return;
  }

  const store = await readStore();
  return sendJson(response, 200, {
    ok: true,
    bot: publicWeixinBotRecord(store.weixinBot),
  });
}

async function handleWeixinBotConfigsGet(request, response) {
  if (!await requireWeixinBotAccess(request, response)) {
    return;
  }

  const store = await readStore();
  const configs = collectWeixinBotConfigs(store).map((config) => ({
    configured: true,
    accountId: config.accountId,
    baseUrl: config.baseUrl,
    botType: config.botType,
    configuredAt: config.configuredAt,
    updatedAt: config.updatedAt,
    lastLinkedUserId: maskWeixinUserId(config.lastLinkedUserId),
    token: config.token,
    userId: config.userId,
    userName: config.userName,
    organization: config.organization,
    weixinUserId: config.weixinUserId,
    apiKeyActive: config.apiKeyActive,
  }));

  return sendJson(response, 200, {
    ok: true,
    configs,
  });
}

async function handleWeixinBotOperatorSessionGet(request, response) {
  if (!await requireWeixinBotAccess(request, response)) {
    return;
  }

  const store = await readStore();
  const operatorSession = normalizeOperatorSession(store.operatorSession);
  if (!operatorSession || !isOperatorSessionActive(operatorSession)) {
    return sendJson(response, 503, { error: '管理员远程会话暂不可用，请先重新同步浏览器会话。' });
  }

  return sendJson(response, 200, {
    ok: true,
    operatorSession: {
      source: operatorSession.source,
      syncedAt: operatorSession.syncedAt,
      expiresAt: operatorSession.expiresAt,
      href: operatorSession.href,
      title: operatorSession.title,
      pageUrl: operatorSession.pageUrl,
      token: operatorSession.token,
      accountType: operatorSession.accountType,
      lang: operatorSession.lang,
      userName: operatorSession.userName,
      userAgent: operatorSession.userAgent,
    },
  });
}

async function handleWeixinBotResolveUser(request, response) {
  if (!await requireWeixinBotAccess(request, response)) {
    return;
  }

  const payload = await readRequestJson(request);
  const weixinUserId = String(payload.weixinUserId || payload.conversationId || '').trim();
  if (!weixinUserId) {
    return sendJson(response, 400, { error: '缺少微信用户标识。' });
  }

  const store = await readStore();
  const user = findUserByWeixinUserId(store, weixinUserId);
  if (!user) {
    return sendJson(response, 404, { error: '这个微信尚未绑定 HYFCeph 账号。' });
  }
  if (!isApiKeyActive(user)) {
    user.apiKey = generateApiKey();
    user.apiKeyExpiresAt = addDaysIso(DEFAULT_API_KEY_DAYS);
    user.updatedAt = nowIso();
    await writeStore(store);
  }

  return sendJson(response, 200, {
    ok: true,
    user: publicUser(user, store),
    auth: {
      apiKey: user.apiKey,
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
    user: publicUser(user, store),
  });
}

async function handleInviteCodesGet(request, response) {
  const currentUser = await getSessionUser(request);
  if (!currentUser) {
    return sendJson(response, 401, { error: '请先登录。' });
  }

  const store = await readStore();
  const user = findUserForSessionContext(store, currentUser);
  if (!user) {
    return sendJson(response, 404, { error: '用户不存在。' });
  }

  return sendJson(response, 200, {
    inviteQuota: buildInviteQuota(user, store),
    inviteCodes: listInviteCodesByCreator(store, user.id),
    user: publicUser(user, store),
  });
}

async function handleInviteCodesCreate(request, response) {
  const currentUser = await getSessionUser(request);
  if (!currentUser) {
    return sendJson(response, 401, { error: '请先登录。' });
  }

  const store = await readStore();
  const user = findUserForSessionContext(store, currentUser);
  if (!user) {
    return sendJson(response, 404, { error: '用户不存在。' });
  }

  const inviteQuota = buildInviteQuota(user, store);
  if (!inviteQuota?.canGenerate) {
    return sendJson(response, 400, {
      error: user.role === 'admin'
        ? '管理员邀请码生成失败，请稍后再试。'
        : `你最多只能生成 ${DEFAULT_INVITE_CODE_LIMIT} 个邀请码，当前额度已用完。`,
    });
  }

  const code = createUniqueInviteCode(store);
  const record = normalizeInviteCodeRecord(code, {
    code,
    createdByUserId: user.id,
    createdByName: user.name,
    createdByRole: user.role,
    status: 'unused',
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });

  store.inviteCodes = {
    ...(store.inviteCodes || {}),
    [record.code]: record,
  };
  user.updatedAt = nowIso();
  await writeStore(store);

  return sendJson(response, 201, {
    message: '邀请码已生成。',
    inviteCode: publicInviteCode(record),
    inviteQuota: buildInviteQuota(user, store),
    inviteCodes: listInviteCodesByCreator(store, user.id),
    user: publicUser(user, store),
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

async function handlePdfUploadTicket(request, response) {
  const payload = await readRequestJson(request);
  const apiKey = String(payload.apiKey || request.headers['x-api-key'] || '').trim();
  if (!apiKey) {
    return sendJson(response, 400, { error: '缺少 API Key。' });
  }

  const { user } = await requireActiveApiKeyUser(apiKey);
  if (!user) {
    return sendJson(response, 401, { error: 'API Key 无效或已过期。' });
  }

  if (!isPdfOssConfigured()) {
    return sendJson(response, 503, { error: 'PDF 上传服务暂未配置。' });
  }

  const fileName = String(payload.fileName || 'hyfceph-report.pdf').trim() || 'hyfceph-report.pdf';
  const mimeType = String(payload.mimeType || 'application/pdf').trim() || 'application/pdf';
  const patientName = String(payload.patientName || '').trim();
  const reportType = String(payload.reportType || '').trim() || 'report';

  try {
    const ticket = await createPdfUploadTicket({
      user,
      fileName,
      mimeType,
      patientName,
      reportType,
      request,
    });
    return sendJson(response, 200, {
      ok: true,
      upload: ticket,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return sendJson(response, 502, { error: message || 'PDF 上传票据生成失败。' });
  }
}

async function handlePdfShortLink(request, response, code) {
  const normalizedCode = String(code || '').trim();
  if (!normalizedCode) {
    return sendText(response, 404, 'Not Found');
  }

  const store = await readStore();
  const record = normalizePdfLinkRecord(normalizedCode, store.pdfLinks?.[normalizedCode]);
  if (!record) {
    return sendText(response, 404, 'PDF link not found.');
  }
  if (isPdfLinkExpired(record)) {
    return sendText(response, 410, 'PDF link expired.');
  }

  let location = '';
  if (PDF_OSS_PUBLIC_READ) {
    location = buildOssPublicUrl(record.objectKey);
  } else {
    const downloadClient = await getPdfOssDownloadClient();
    const downloadExpiresIn = Math.min(
      safePositiveInteger(PDF_OSS_DOWNLOAD_EXPIRES_SECONDS, 60 * 60 * 24 * 7),
      OSS_V4_MAX_EXPIRES_SECONDS,
    );
    location = normalizeOssSignedUrl(await downloadClient.signatureUrlV4('GET', downloadExpiresIn, undefined, record.objectKey));
  }

  record.lastAccessedAt = nowIso();
  record.updatedAt = nowIso();
  store.pdfLinks = {
    ...(store.pdfLinks || {}),
    [record.code]: record,
  };
  await writeStore(store);

  response.writeHead(302, {
    Location: location,
    'Cache-Control': 'no-store',
  });
  response.end();
}

async function handleReportShortLink(request, response, code) {
  const normalizedCode = String(code || '').trim();
  if (!normalizedCode) {
    return sendText(response, 404, 'Not Found');
  }

  const store = await readStore();
  const record = normalizeReportLinkRecord(normalizedCode, store.reportLinks?.[normalizedCode]);
  if (!record) {
    return sendText(response, 404, 'Report link not found.');
  }
  if (isReportLinkExpired(record)) {
    return sendText(response, 410, 'Report link expired.');
  }

  record.lastAccessedAt = nowIso();
  record.updatedAt = nowIso();
  store.reportLinks = {
    ...(store.reportLinks || {}),
    [record.code]: record,
  };
  await writeStore(store);

  try {
    let html = '';
    if (record.objectKey) {
      html = await loadTextObjectFromOss(record.objectKey);
    } else if (record.payloadObjectKey) {
      const resultPayload = await loadReportPayloadFromOss(record.payloadObjectKey);
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyfceph-report-live-'));
      const resultJsonPath = path.join(tempDir, 'result.json');
      const htmlOutputPath = path.join(tempDir, `report-${sanitizeFileStem(record.variant || 'standard')}.html`);
      try {
        await fs.writeFile(resultJsonPath, JSON.stringify(resultPayload, null, 2), 'utf8');
        await generateHyfcephHtmlReport({
          inputPath: resultJsonPath,
          outputPath: htmlOutputPath,
          patientName: record.patientName || undefined,
          variant: record.variant || 'standard',
        });
        html = await fs.readFile(htmlOutputPath, 'utf8');
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    } else if (record.inlinePayload) {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyfceph-report-inline-'));
      const resultJsonPath = path.join(tempDir, 'result.json');
      const htmlOutputPath = path.join(tempDir, `report-${sanitizeFileStem(record.variant || 'standard')}.html`);
      try {
        await fs.writeFile(resultJsonPath, JSON.stringify(record.inlinePayload, null, 2), 'utf8');
        await generateHyfcephHtmlReport({
          inputPath: resultJsonPath,
          outputPath: htmlOutputPath,
          patientName: record.patientName || undefined,
          variant: record.variant || 'standard',
        });
        html = await fs.readFile(htmlOutputPath, 'utf8');
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    } else {
      throw new Error('报告内容不存在。');
    }
    return sendText(response, 200, html, 'text/html; charset=utf-8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return sendText(response, 502, `Report fetch failed: ${message || 'unknown error'}`);
  }
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
  const apiKey = String(payload.apiKey || request.headers['x-api-key'] || '').trim();
  const shouldGenerateReport = payload.generateReport !== false && payload.generatePdf !== false;
  const patientName = String(payload.patientName || '').trim();
  if (!apiKey) {
    return sendJson(response, 400, { error: '缺少 API Key。' });
  }

  const { store, user } = await requireActiveApiKeyUser(apiKey);
  if (!user) {
    return sendJson(response, 401, { error: 'API Key 无效或已过期。' });
  }

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
    if (payload.includeReportPayloadKey && isPdfOssConfigured()) {
      result.reportPayload = await uploadReportPayloadToOss({
        user,
        resultPayload: result,
        reportType: 'image',
      });
    }
    if (shouldGenerateReport) {
      result.report = await generateAndUploadHtmlReport({
        user,
        resultPayload: result,
        patientName,
        reportType: 'image',
        request,
        variant: 'standard',
      });
      result.prettyReport = await generateAndUploadHtmlReport({
        user,
        resultPayload: result,
        patientName,
        reportType: 'image',
        request,
        variant: 'pretty',
      });
      result.feishuDoc = await createFeishuDocReport({
        resultPayload: result,
        patientName,
        reportType: 'image',
        prettyReportUrl: result.prettyReport?.reportShareUrl || '',
        standardReportUrl: result.report?.reportShareUrl || '',
      });
    }
    await sendBarkPush('HYFCeph 图片测量', `用户：${user.name}\n单位：${user.organization || '-'}\n图片：${path.basename(resolvedImagePath)}`);
    return sendJson(response, 200, {
      ok: true,
      mode: 'image',
      result,
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

async function handleGenerateReport(request, response) {
  const payload = await readRequestJson(request);
  const apiKey = String(payload.apiKey || request.headers['x-api-key'] || '').trim();
  const patientName = String(payload.patientName || '').trim();
  const reportType = String(payload.reportType || payload.mode || 'image').trim() || 'image';
  const resultPayloadKey = String(payload.resultPayloadKey || '').trim();
  let resultPayload = payload.resultPayload && typeof payload.resultPayload === 'object'
    ? payload.resultPayload
    : null;

  if (!apiKey) {
    return sendJson(response, 400, { error: '缺少 API Key。' });
  }
  if (!resultPayload && !resultPayloadKey) {
    return sendJson(response, 400, { error: '缺少 resultPayload。' });
  }

  const { user } = await requireActiveApiKeyUser(apiKey);
  if (!user) {
    return sendJson(response, 401, { error: 'API Key 无效或已过期。' });
  }

  try {
    if (!resultPayload && resultPayloadKey) {
      resultPayload = await loadReportPayloadFromOss(resultPayloadKey);
    }
    const report = await generateAndUploadHtmlReport({
      user,
      resultPayload,
      patientName,
      reportType,
      request,
      variant: 'standard',
    });
    const prettyReport = await generateAndUploadHtmlReport({
      user,
      resultPayload,
      patientName,
      reportType,
      request,
      variant: 'pretty',
    });
    const feishuDoc = await createFeishuDocReport({
      resultPayload,
      patientName,
      reportType,
      prettyReportUrl: prettyReport?.reportShareUrl || '',
      standardReportUrl: report?.reportShareUrl || '',
    });
    return sendJson(response, 200, {
      ok: true,
      report,
      prettyReport,
      feishuDoc,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return sendJson(response, 502, { error: message || '在线报告生成失败。' });
  }
}

async function handleUploadReportPayload(request, response) {
  const payload = await readRequestJson(request);
  const apiKey = String(payload.apiKey || request.headers['x-api-key'] || '').trim();
  const reportType = String(payload.reportType || payload.mode || 'image').trim() || 'image';
  const resultPayload = payload.resultPayload && typeof payload.resultPayload === 'object'
    ? payload.resultPayload
    : null;

  if (!apiKey) {
    return sendJson(response, 400, { error: '缺少 API Key。' });
  }
  if (!resultPayload) {
    return sendJson(response, 400, { error: '缺少 resultPayload。' });
  }
  if (!isPdfOssConfigured()) {
    return sendJson(response, 503, { error: '报告存储未配置。' });
  }

  const { user } = await requireActiveApiKeyUser(apiKey);
  if (!user) {
    return sendJson(response, 401, { error: 'API Key 无效或已过期。' });
  }

  try {
    const reportPayload = await uploadReportPayloadToOss({
      user,
      resultPayload,
      reportType,
    });
    return sendJson(response, 200, {
      ok: true,
      reportPayload,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return sendJson(response, 502, { error: message || '报告结果上传失败。' });
  }
}

async function handleGenerateFeishuDoc(request, response) {
  const payload = await readRequestJson(request);
  const apiKey = String(payload.apiKey || request.headers['x-api-key'] || '').trim();
  const patientName = String(payload.patientName || '').trim();
  const reportType = String(payload.reportType || payload.mode || 'image').trim() || 'image';
  const resultPayloadKey = String(payload.resultPayloadKey || '').trim();
  let resultPayload = payload.resultPayload && typeof payload.resultPayload === 'object'
    ? payload.resultPayload
    : null;
  const prettyReportUrl = String(payload.prettyReportUrl || '').trim();
  const standardReportUrl = String(payload.standardReportUrl || '').trim();

  if (!apiKey) {
    return sendJson(response, 400, { error: '缺少 API Key。' });
  }
  if (!resultPayload && !resultPayloadKey) {
    return sendJson(response, 400, { error: '缺少 resultPayload。' });
  }

  const { user } = await requireActiveApiKeyUser(apiKey);
  if (!user) {
    return sendJson(response, 401, { error: 'API Key 无效或已过期。' });
  }

  try {
    if (!resultPayload && resultPayloadKey) {
      resultPayload = await loadReportPayloadFromOss(resultPayloadKey);
    }
    const feishuDoc = await createFeishuDocReport({
      resultPayload,
      patientName,
      reportType,
      prettyReportUrl,
      standardReportUrl,
    });
    return sendJson(response, 200, {
      ok: true,
      feishuDoc,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return sendJson(response, 502, { error: message || '飞书文档生成失败。' });
  }
}

async function handleMeasureOverlap(request, response) {
  const payload = await readRequestJson(request);
  const apiKey = String(payload.apiKey || request.headers['x-api-key'] || '').trim();
  const shouldGenerateReport = Boolean(payload.generateReport || payload.generatePdf);
  const patientName = String(payload.patientName || '').trim();
  if (!apiKey) {
    return sendJson(response, 400, { error: '缺少 API Key。' });
  }

  const { store, user } = await requireActiveApiKeyUser(apiKey);
  if (!user) {
    return sendJson(response, 401, { error: 'API Key 无效或已过期。' });
  }

  let baseUpload;
  let compareUpload;
  try {
    baseUpload = decodeUploadedImageFields({
      imageBase64: payload.baseImageBase64 || payload.imageBase64,
      fileName: payload.baseFileName || payload.fileName || payload.imageName,
      mimeType: payload.baseMimeType || payload.mimeType,
    }, '基准图');
    compareUpload = decodeUploadedImageFields({
      imageBase64: payload.compareImageBase64,
      fileName: payload.compareFileName,
      mimeType: payload.compareMimeType,
    }, '对照图');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return sendJson(response, 400, { error: message || '重叠上传无效。' });
  }

  const alignMode = String(payload.alignMode || 'SN').trim().toUpperCase() || 'SN';
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyfceph-overlap-upload-'));
  const baseImagePath = path.join(
    tempDir,
    `base-${sanitizeFileStem(path.basename(baseUpload.fileName, path.extname(baseUpload.fileName)))}${extensionFromUpload(baseUpload)}`,
  );
  const compareImagePath = path.join(
    tempDir,
    `compare-${sanitizeFileStem(path.basename(compareUpload.fileName, path.extname(compareUpload.fileName)))}${extensionFromUpload(compareUpload)}`,
  );

  try {
    const operatorSession = normalizeOperatorSession(store.operatorSession);
    if (!isOperatorSessionActive(operatorSession)) {
      if (store.operatorSession) {
        store.operatorSession = null;
        await writeStore(store);
      }
      return sendJson(response, 503, { error: '服务端远程会话暂不可用，请稍后重试。' });
    }

    await fs.writeFile(baseImagePath, baseUpload.imageBuffer);
    await fs.writeFile(compareImagePath, compareUpload.imageBuffer);

    const result = await runServerSideOverlapMeasurement({
      baseImagePath,
      compareImagePath,
      operatorSession,
      alignMode,
    });
    if (shouldGenerateReport) {
      result.report = await generateAndUploadHtmlReport({
        user,
        resultPayload: result,
        patientName,
        reportType: 'overlap',
        request,
        variant: 'standard',
      });
      result.prettyReport = await generateAndUploadHtmlReport({
        user,
        resultPayload: result,
        patientName,
        reportType: 'overlap',
        request,
        variant: 'pretty',
      });
      result.feishuDoc = await createFeishuDocReport({
        resultPayload: result,
        patientName,
        reportType: 'overlap',
        prettyReportUrl: result.prettyReport?.reportShareUrl || '',
        standardReportUrl: result.report?.reportShareUrl || '',
      });
    }

    await sendBarkPush(
      'HYFCeph 轮廓重叠',
      [
        `用户：${user.name}`,
        `单位：${user.organization || '-'}`,
        `模式：${result.summary?.alignLabel || alignMode}`,
        `基准图：${path.basename(baseImagePath)}`,
        `对照图：${path.basename(compareImagePath)}`,
      ].join('\n'),
    );

    return sendJson(response, 200, {
      ok: true,
      mode: 'overlap',
      result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isLikelyUpstreamAuthError(message)) {
      store.operatorSession = null;
      await writeStore(store);
      return sendJson(response, 503, { error: '服务端远程会话暂不可用，请稍后重试。' });
    }
    return sendJson(response, 502, {
      error: message || '轮廓重叠失败。',
      supportedAlignModes: listSupportedAlignModes(),
    });
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
    .map((user) => publicUser(user, store));

  return sendJson(response, 200, {
    currentAdmin: publicUser(adminUser, store),
    users,
    inviteCodes: listInviteCodesForAdmin(store),
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
        feishuStoreConfigured: isFeishuBitableConfigured(),
        operatorSessionActive: isOperatorSessionActive(store.operatorSession),
        pdfOssConfigured: isPdfOssConfigured(),
        pdfOssCustomDomain: PDF_OSS_CUSTOM_DOMAIN ? `https://${PDF_OSS_CUSTOM_DOMAIN}` : null,
        weixinBotConfigured: Boolean(store.weixinBot?.token && store.weixinBot?.accountId),
        weixinBindingSessions: Object.keys(store.weixinBindingSessions || {}).length,
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
    if (request.method === 'POST' && url.pathname === '/api/weixin/binding/start') {
      return await handleWeixinBindingStart(request, response);
    }
    if (request.method === 'GET' && url.pathname === '/api/weixin/binding/status') {
      const sessionKey = String(url.searchParams.get('sessionKey') || '').trim();
      return await handleWeixinBindingStatus(request, response, sessionKey);
    }
    if (request.method === 'GET' && url.pathname === '/api/weixin/binding/readiness') {
      return await handleWeixinBindingReadinessGet(request, response);
    }
    if (request.method === 'DELETE' && url.pathname === '/api/weixin/binding') {
      return await handleWeixinBindingDelete(request, response);
    }
    if (request.method === 'GET' && url.pathname === '/api/weixin/bot/config') {
      return await handleWeixinBotConfigGet(request, response);
    }
    if (request.method === 'GET' && url.pathname === '/api/weixin/bot/configs') {
      return await handleWeixinBotConfigsGet(request, response);
    }
    if (request.method === 'GET' && url.pathname === '/api/weixin/bot/operator-session') {
      return await handleWeixinBotOperatorSessionGet(request, response);
    }
    if (request.method === 'POST' && url.pathname === '/api/weixin/bot/resolve-user') {
      return await handleWeixinBotResolveUser(request, response);
    }
    if (request.method === 'POST' && url.pathname === '/api/api-key/generate') {
      return await handleGenerateApiKey(request, response);
    }
    if (request.method === 'GET' && url.pathname === '/api/invite-codes') {
      return await handleInviteCodesGet(request, response);
    }
    if (request.method === 'POST' && url.pathname === '/api/invite-codes') {
      return await handleInviteCodesCreate(request, response);
    }
    if (request.method === 'POST' && url.pathname === '/api/validate-key') {
      return await handleValidateApiKey(request, response);
    }
    if (request.method === 'POST' && url.pathname === '/api/pdf/upload-ticket') {
      return await handlePdfUploadTicket(request, response);
    }
    if (request.method === 'GET' && (url.pathname.startsWith('/report/') || url.pathname.startsWith('/api/report/'))) {
      const prefix = url.pathname.startsWith('/api/report/') ? '/api/report/' : '/report/';
      const code = decodeURIComponent(url.pathname.slice(prefix.length));
      return await handleReportShortLink(request, response, code);
    }
    if (request.method === 'GET' && (url.pathname.startsWith('/report-pretty/') || url.pathname.startsWith('/api/report-pretty/'))) {
      const prefix = url.pathname.startsWith('/api/report-pretty/') ? '/api/report-pretty/' : '/report-pretty/';
      const code = decodeURIComponent(url.pathname.slice(prefix.length));
      return await handleReportShortLink(request, response, code);
    }
    if (request.method === 'GET' && (url.pathname.startsWith('/pdf/') || url.pathname.startsWith('/api/pdf/'))) {
      const prefix = url.pathname.startsWith('/api/pdf/') ? '/api/pdf/' : '/pdf/';
      const code = decodeURIComponent(url.pathname.slice(prefix.length));
      return await handlePdfShortLink(request, response, code);
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
    if (request.method === 'POST' && url.pathname === '/api/report/generate') {
      return await handleGenerateReport(request, response);
    }
    if (request.method === 'POST' && url.pathname === '/api/report/links') {
      return await handleIssueReportLinks(request, response);
    }
    if (request.method === 'POST' && url.pathname === '/api/report/payload') {
      return await handleUploadReportPayload(request, response);
    }
    if (request.method === 'POST' && url.pathname === '/api/report/feishu-doc') {
      return await handleGenerateFeishuDoc(request, response);
    }
    if (request.method === 'POST' && url.pathname === '/api/measure/overlap') {
      return await handleMeasureOverlap(request, response);
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
