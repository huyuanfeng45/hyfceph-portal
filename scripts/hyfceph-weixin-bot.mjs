#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { qrcode } from './vendor/qrcode.mjs';
import { start as startWeixinBot } from './vendor/weixin-agent-sdk-hyf.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const SERVICE_RUNNER = path.join(REPO_ROOT, 'scripts', 'hyfceph-remote-runner.mjs');
const DEFAULT_CONFIG_PATH = path.join(os.homedir(), 'Library', 'Application Support', 'HYFCeph', 'weixin-bot.json');
const WEIXIN_CONFIG_PATH = process.env.HYFCEPH_WEIXIN_CONFIG_PATH?.trim() || DEFAULT_CONFIG_PATH;
const HYFCEPH_APP_SUPPORT_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'HYFCeph');
const WEIXIN_RESULT_CACHE_PATH = path.join(HYFCEPH_APP_SUPPORT_DIR, 'weixin-latest-results.json');
const WEIXIN_MEDIA_CACHE_DIR = path.join(HYFCEPH_APP_SUPPORT_DIR, 'weixin-media');
const OPENCLAW_STATE_DIR = process.env.OPENCLAW_STATE_DIR?.trim()
  || process.env.CLAWDBOT_STATE_DIR?.trim()
  || path.join(os.homedir(), '.openclaw');
const OPENCLAW_WEIXIN_DIR = path.join(OPENCLAW_STATE_DIR, 'openclaw-weixin');
const OPENCLAW_WEIXIN_ACCOUNTS_DIR = path.join(OPENCLAW_WEIXIN_DIR, 'accounts');
const MEDIA_OUT_DIR = path.join(os.tmpdir(), 'hyfceph-weixin-bot');

function readLocalConfig(configPath) {
  try {
    const raw = fsSync.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

const LOCAL_CONFIG = readLocalConfig(WEIXIN_CONFIG_PATH);
const PORTAL_BASE_URL = String(
  process.env.HYFCEPH_WEIXIN_PORTAL_BASE_URL
  || LOCAL_CONFIG.portalBaseUrl
  || 'http://127.0.0.1:3077',
).trim().replace(/\/+$/, '');
const PORTAL_API_KEY = String(
  process.env.HYFCEPH_API_KEY
  || LOCAL_CONFIG.portalApiKey
  || '',
).trim();
const WEIXIN_BOT_SECRET = String(
  process.env.HYFCEPH_WEIXIN_BOT_SECRET
  || LOCAL_CONFIG.weixinBotSecret
  || '',
).trim();

if (!WEIXIN_BOT_SECRET && !PORTAL_API_KEY) {
  throw new Error(`缺少 HYFCEPH_WEIXIN_BOT_SECRET 或 HYFCEPH_API_KEY，无法启动微信 bot 服务。可在环境变量中提供，或写入 ${WEIXIN_CONFIG_PATH}`);
}

const PORTAL_RESOLVE_TIMEOUT_MS = 15_000;
const PORTAL_MEASURE_TIMEOUT_MS = 240_000;
const PORTAL_REPORT_TIMEOUT_MS = 90_000;
const REPORT_GENERATION_SOFT_TIMEOUT_MS = 15_000;
const PORTAL_RETRY_ATTEMPTS = 6;
const PORTAL_RETRY_BASE_DELAY_MS = 1_500;
const PORTAL_RETRY_MAX_DELAY_MS = 15_000;
const LOCAL_MEASURE_BUFFER_BYTES = 128 * 1024 * 1024;
const WEIXIN_RESULT_CACHE_LIMIT = 50;
const execFileAsync = promisify(execFile);
const PYTHON_QR_OVERLAY_SCRIPT = `
import json
import sys
from pathlib import Path
from PIL import Image, ImageDraw

payload = json.loads(sys.argv[1])
input_path = payload["inputPath"]
base_image_path = payload.get("baseImagePath") or ""
output_path = payload["outputPath"]
matrix = payload["matrix"]

if base_image_path:
    overlay_source = Image.open(input_path).convert("RGBA")
    base = Image.open(base_image_path).convert("RGBA")
    if base.size != overlay_source.size:
        base = base.resize(overlay_source.size, Image.Resampling.LANCZOS)
    base = Image.alpha_composite(base, overlay_source)
else:
    base = Image.open(input_path).convert("RGBA")
width, height = base.size
result = base
if matrix:
    short_edge = max(1, min(width, height))
    module_count = len(matrix)
    target_qr_size = max(120, min(220, int(short_edge * 0.19)))
    quiet_zone_modules = 4
    scale = max(2, target_qr_size // (module_count + quiet_zone_modules * 2))
    qr_size = (module_count + quiet_zone_modules * 2) * scale
    card_padding = max(12, qr_size // 10)
    card_width = qr_size + card_padding * 2
    card_height = qr_size + card_padding * 2
    margin = max(20, short_edge // 36)
    radius = max(16, card_padding)

    overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
    draw_overlay = ImageDraw.Draw(overlay)
    x = margin
    y = height - card_height - margin
    draw_overlay.rounded_rectangle(
        [x, y, x + card_width, y + card_height],
        radius=radius,
        fill=(255, 255, 255, 238),
        outline=(219, 234, 254, 255),
        width=max(2, radius // 7),
    )

    qr_image = Image.new("RGBA", (qr_size, qr_size), (255, 255, 255, 255))
    draw_qr = ImageDraw.Draw(qr_image)
    for row_index, row in enumerate(matrix):
        for col_index, value in enumerate(row):
            if value:
                x0 = (col_index + quiet_zone_modules) * scale
                y0 = (row_index + quiet_zone_modules) * scale
                draw_qr.rectangle(
                    [x0, y0, x0 + scale - 1, y0 + scale - 1],
                    fill=(15, 23, 42, 255),
                )

    overlay.paste(qr_image, (x + card_padding, y + card_padding), qr_image)
    result = Image.alpha_composite(base, overlay)
Path(output_path).parent.mkdir(parents=True, exist_ok=True)
result.save(output_path, format="PNG")
`;

function normalizeAccountId(raw) {
  return String(raw || '').trim().toLowerCase().replace(/[@.]/g, '-');
}

function normalizeConversationKey(value) {
  return String(value || '').trim() || 'unknown';
}

function readJsonFileSync(filePath, fallback = {}) {
  try {
    const raw = fsSync.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

const latestResultCache = readJsonFileSync(WEIXIN_RESULT_CACHE_PATH, {});

async function requestJson(url, { method = 'GET', headers = {}, body } = {}) {
  return fetchJsonWithRetry(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(WEIXIN_BOT_SECRET ? { 'x-hyfceph-weixin-secret': WEIXIN_BOT_SECRET } : {}),
      ...(PORTAL_API_KEY ? { 'x-api-key': PORTAL_API_KEY } : {}),
      ...headers,
    },
    body,
    timeoutMs: PORTAL_RESOLVE_TIMEOUT_MS,
    label: `portal request ${method} ${url}`,
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function promiseWithTimeout(promise, timeoutMs, message) {
  let timeout = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(message || 'timeout'));
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });
}

function isRetriableStatus(status) {
  return [408, 425, 429, 500, 502, 503, 504].includes(Number(status));
}

function isTransientFetchError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  const causeMessage = String(error?.cause?.message || '').toLowerCase();
  return /fetch failed|socket|econnreset|other side closed|empty reply|timeout|timed out|connect|network/.test(`${message} ${causeMessage}`);
}

function retryDelayMs(attempt) {
  const jitter = Math.floor(Math.random() * 400);
  const exponential = PORTAL_RETRY_BASE_DELAY_MS * (2 ** Math.max(0, attempt - 1));
  return Math.min(PORTAL_RETRY_MAX_DELAY_MS, exponential) + jitter;
}

async function readResponsePayload(response) {
  const rawText = await response.text().catch(() => '');
  if (!rawText.trim()) {
    return {};
  }
  try {
    return JSON.parse(rawText);
  } catch {
    return { error: rawText.trim() };
  }
}

async function fetchJsonWithRetry(url, {
  method = 'GET',
  headers = {},
  body,
  compressBody = false,
  timeoutMs = PORTAL_RESOLVE_TIMEOUT_MS,
  label = 'request',
  attempts = PORTAL_RETRY_ATTEMPTS,
} = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
    try {
      let requestBody = body;
      const requestHeaders = { ...headers };
      if (compressBody && typeof body === 'string' && body.length) {
        requestBody = gzipSync(Buffer.from(body, 'utf8'));
        requestHeaders['Content-Encoding'] = 'gzip';
        requestHeaders['Content-Length'] = String(requestBody.length);
      }
      const response = await fetch(url, {
        method,
        headers: requestHeaders,
        body: requestBody,
        signal: controller.signal,
      });
      const payload = await readResponsePayload(response);
      if (!response.ok) {
        const error = new Error(payload.error || `${label} failed (${response.status})`);
        error.status = response.status;
        throw error;
      }
      if (attempt > 1) {
        console.log(`[HYFCeph Weixin] ${label} recovered on retry ${attempt}/${attempts}`);
      }
      return payload;
    } catch (error) {
      lastError = error;
      const retriable = (error?.status && isRetriableStatus(error.status)) || isTransientFetchError(error);
      console.warn(`[HYFCeph Weixin] ${label} failed (${attempt}/${attempts}): ${error instanceof Error ? error.message : String(error)}`);
      if (!retriable || attempt >= attempts) {
        break;
      }
      await sleep(retryDelayMs(attempt));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || `${label} failed`));
}

async function ensureWeixinAccountFiles(bot) {
  const normalizedAccountId = normalizeAccountId(bot.accountId);
  await fs.mkdir(OPENCLAW_WEIXIN_ACCOUNTS_DIR, { recursive: true });
  await fs.writeFile(
    path.join(OPENCLAW_WEIXIN_DIR, 'accounts.json'),
    JSON.stringify([normalizedAccountId], null, 2),
    'utf8',
  );
  await fs.writeFile(
    path.join(OPENCLAW_WEIXIN_ACCOUNTS_DIR, `${normalizedAccountId}.json`),
    JSON.stringify({
      token: bot.token,
      baseUrl: bot.baseUrl,
      userId: bot.lastLinkedUserId || undefined,
      savedAt: new Date().toISOString(),
    }, null, 2),
    'utf8',
  );
  return normalizedAccountId;
}

async function syncBotConfigFromPortal() {
  const payload = await requestJson(`${PORTAL_BASE_URL}/api/weixin/bot/config`);
  const bot = payload.bot || null;
  if (!bot?.configured || !bot?.accountId || !bot?.token) {
    throw new Error('门户里还没有可用的微信 Clawbot 配置，请先在认证中心完成一次扫码绑定。');
  }
  const normalizedAccountId = await ensureWeixinAccountFiles(bot);
  return {
    ...bot,
    normalizedAccountId,
  };
}

function extractMetricMap(result) {
  const metrics = result?.analysis?.metrics || result?.metrics || [];
  return new Map(metrics.map((metric) => [metric.code, metric.valueText]));
}

function frameworkAliases() {
  return [
    { code: 'downs', label: 'Downs', patterns: ['downs'] },
    { code: 'steiner', label: 'Steiner', patterns: ['steiner'] },
    { code: 'pku', label: '北大分析法', patterns: ['北大分析法', '北大', 'pku'] },
    { code: 'abo', label: 'ABO', patterns: ['abo'] },
    { code: 'ricketts', label: 'Ricketts', patterns: ['ricketts'] },
    { code: 'tweed', label: 'Tweed', patterns: ['tweed'] },
    { code: 'mcnamara', label: 'McNamara', patterns: ['mcnamara', 'mcnamara分析'] },
    { code: 'jarabak', label: 'Jarabak', patterns: ['jarabak'] },
  ];
}

function findRequestedFramework(text) {
  const normalized = String(text || '').trim().toLowerCase();
  for (const item of frameworkAliases()) {
    if (item.patterns.some((pattern) => normalized.includes(String(pattern).toLowerCase()))) {
      return item;
    }
  }
  return null;
}

function metricSeverityScore(metric) {
  if (!metric) return 0;
  if (metric.tone === 'danger') return 3;
  if (metric.tone === 'warn') return 2;
  if (metric.tone === 'success') return 1;
  return 0;
}

function frameworkItemSeverityScore(item) {
  if (!item) return 0;
  if (item.status && item.status !== 'supported') return -1;
  if (item.tone === 'danger') return 3;
  if (item.tone === 'warn') return 2;
  if (item.tone === 'success') return 1;
  return 0;
}

function metricMeaning(metric) {
  if (!metric) return '';
  if (metric.tone === 'danger') return '偏离较明显';
  if (metric.tone === 'warn') return '有一定偏离';
  if (metric.tone === 'success') return '接近参考范围';
  return '需要结合临床判断';
}

function buildQrMatrix(url) {
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  const count = qr.getModuleCount();
  return Array.from({ length: count }, (_, row) => (
    Array.from({ length: count }, (_, col) => (qr.isDark(row, col) ? 1 : 0))
  ));
}

function frameworkStatusText(item) {
  if (!item) return '未算出';
  if (item.status && item.status !== 'supported') return '暂未算出';
  if (item.tone === 'danger') return '偏离较明显';
  if (item.tone === 'warn') return '有一定偏离';
  if (item.tone === 'success') return '接近参考';
  return '需结合临床';
}

function buildSummaryText(result) {
  const metrics = extractMetricMap(result);
  const summary = result?.summary || {};
  const analysis = result?.analysis || {};
  const lines = [
    analysis.riskLabel || summary.riskLabel || '测量完成。',
    analysis.insight || summary.insight || '',
  ].filter(Boolean);

  const keyCodes = ['SNA', 'SNB', 'ANB', 'GoGn-SN', 'FMA', 'U1-SN', 'IMPA', 'Wits'];
  const keyLines = keyCodes
    .filter((code) => metrics.has(code))
    .map((code) => `${code} ${metrics.get(code)}`);

  if (keyLines.length) {
    lines.push('', '关键值：', keyLines.join('；'));
  }

  if (result?.prettyReport?.shortUrl) {
    lines.push('', `美化报告链接：${result.prettyReport.shortUrl}`);
  }
  if (result?.feishuDoc?.docUrl) {
    lines.push(`飞书文档版：${result.feishuDoc.docUrl}`);
  }
  if (result?.report?.shortUrl) {
    lines.push(`在线报告链接：${result.report.shortUrl}`);
  }

  lines.push('', '如需继续，请直接再发一张侧位片。这个微信入口只处理 HYFCeph 测量，不提供普通聊天。');
  return lines.join('\n');
}

function buildQuickConsultationText(cacheEntry) {
  const result = cacheEntry?.result;
  if (!result) {
    return buildUnsupportedText();
  }
  const metrics = Array.isArray(result?.analysis?.metrics) ? result.analysis.metrics : [];
  const topMetrics = metrics
    .slice()
    .sort((left, right) => metricSeverityScore(right) - metricSeverityScore(left))
    .slice(0, 4)
    .map((metric) => `- ${metric.code} ${metric.valueText}：${metricMeaning(metric)}`);
  return [
    result?.analysis?.riskLabel || '最近一次测量结果已找到。',
    result?.analysis?.insight || '',
    topMetrics.length ? '' : null,
    topMetrics.length ? '当前重点指标：' : null,
    ...topMetrics,
    '',
    '你还可以继续问我：Downs、Steiner、北大分析法、ABO、Ricketts、Tweed、McNamara、Jarabak，或者直接发“在线报告”“标点图”“白底轮廓图”。',
  ].filter(Boolean).join('\n');
}

function buildFrameworkReply(cacheEntry, frameworkMeta) {
  const framework = cacheEntry?.result?.analysis?.frameworkReports?.[frameworkMeta.code];
  if (!framework) {
    return `${frameworkMeta.label} 目前还没有可用结果。你可以先重新发送一张侧位片。`;
  }
  const items = Array.isArray(framework.items) ? framework.items : [];
  const topItems = items
    .filter((item) => !item.status || item.status === 'supported')
    .slice()
    .sort((left, right) => frameworkItemSeverityScore(right) - frameworkItemSeverityScore(left))
    .slice(0, 6)
    .map((item) => `- ${item.label || item.code}：${item.valueText || '-'}（${frameworkStatusText(item)}）`);
  const supportedCount = Number(framework.supportedItemCount || topItems.length || 0);
  const unsupportedCount = Number(framework.unsupportedItemCount || 0);
  return [
    `${frameworkMeta.label} 分析法`,
    supportedCount || unsupportedCount ? `已输出 ${supportedCount} 项，未算出 ${unsupportedCount} 项。` : null,
    framework.note || '',
    topItems.length ? '' : null,
    topItems.length ? '当前重点条目：' : null,
    ...topItems,
    '',
    '如果你要，我也可以继续把这一套分析法完整条目再分几条发给你。',
  ].filter(Boolean).join('\n');
}

async function ensureCacheDirs() {
  await fs.mkdir(HYFCEPH_APP_SUPPORT_DIR, { recursive: true });
  await fs.mkdir(WEIXIN_MEDIA_CACHE_DIR, { recursive: true });
}

async function saveResultCache() {
  await ensureCacheDirs();
  await fs.writeFile(WEIXIN_RESULT_CACHE_PATH, JSON.stringify(latestResultCache, null, 2), 'utf8');
}

async function persistArtifactBase64(base64, mimeType, prefix) {
  if (!base64) {
    return null;
  }
  await ensureCacheDirs();
  const extension = String(mimeType || '').includes('svg')
    ? '.svg'
    : '.png';
  const filePath = path.join(
    WEIXIN_MEDIA_CACHE_DIR,
    `${prefix}-${Date.now()}-${randomBytes(4).toString('hex')}${extension}`,
  );
  await fs.writeFile(filePath, Buffer.from(base64, 'base64'));
  return filePath;
}

async function persistOriginalImageFile(filePath, prefix) {
  if (!filePath) {
    return null;
  }
  await ensureCacheDirs();
  const extension = path.extname(String(filePath || '')).trim() || '.png';
  const outputPath = path.join(
    WEIXIN_MEDIA_CACHE_DIR,
    `${prefix}-${Date.now()}-${randomBytes(4).toString('hex')}${extension}`,
  );
  await fs.copyFile(filePath, outputPath);
  return outputPath;
}

async function composeAnnotatedImageForReply(imagePath, feishuDocUrl, prefix, {
  baseImagePath = null,
} = {}) {
  if (!imagePath) {
    return imagePath;
  }
  await ensureCacheDirs();
  const outputPath = path.join(
    WEIXIN_MEDIA_CACHE_DIR,
    `${prefix}-${Date.now()}-${randomBytes(4).toString('hex')}.png`,
  );
  const normalizedUrl = String(feishuDocUrl || '').trim();
  const payload = {
    inputPath: imagePath,
    baseImagePath: baseImagePath || '',
    outputPath,
    matrix: normalizedUrl ? buildQrMatrix(normalizedUrl) : [],
  };
  try {
    await execFileAsync('python3', ['-c', PYTHON_QR_OVERLAY_SCRIPT, JSON.stringify(payload)]);
    return outputPath;
  } catch (error) {
    console.warn(`[HYFCeph Weixin] failed to compose annotated image QR: ${error instanceof Error ? error.message : String(error)}`);
    return imagePath;
  }
}

async function updateLatestResultCache(conversationId, result, options = {}) {
  const key = normalizeConversationKey(conversationId);
  const sourceImagePath = await persistOriginalImageFile(
    options.sourceImagePath || '',
    `${key}-source`,
  );
  const rawAnnotatedImagePath = await persistArtifactBase64(
    result?.artifacts?.annotatedPngBase64 || '',
    result?.artifacts?.annotatedPngMimeType || 'image/png',
    `${key}-annotated`,
  );
  const annotatedImagePath = await composeAnnotatedImageForReply(
    rawAnnotatedImagePath,
    result?.feishuDoc?.docUrl || '',
    `${key}-annotated-qr`,
    {
      baseImagePath: sourceImagePath,
    },
  );
  const contourImagePath = await persistArtifactBase64(
    result?.artifacts?.contourPngBase64 || '',
    result?.artifacts?.contourPngMimeType || 'image/png',
    `${key}-contour`,
  );
  latestResultCache[key] = {
    updatedAt: new Date().toISOString(),
    result: {
      analysis: {
        riskLabel: result?.analysis?.riskLabel || '',
        insight: result?.analysis?.insight || '',
        metrics: Array.isArray(result?.analysis?.metrics) ? result.analysis.metrics : [],
        frameworkReports: result?.analysis?.frameworkReports || {},
      },
      summary: result?.summary || {},
      report: result?.report || null,
      prettyReport: result?.prettyReport || null,
      feishuDoc: result?.feishuDoc || null,
    },
    sourceImagePath,
    annotatedImagePath,
    contourImagePath,
  };
  const keys = Object.keys(latestResultCache)
    .sort((left, right) => new Date(latestResultCache[right]?.updatedAt || 0).getTime() - new Date(latestResultCache[left]?.updatedAt || 0).getTime());
  for (const staleKey of keys.slice(WEIXIN_RESULT_CACHE_LIMIT)) {
    delete latestResultCache[staleKey];
  }
  await saveResultCache();
  return latestResultCache[key];
}

function getLatestResultCache(conversationId) {
  return latestResultCache[normalizeConversationKey(conversationId)] || null;
}

async function writeBase64Image(base64, mimeType, prefix) {
  await fs.mkdir(MEDIA_OUT_DIR, { recursive: true });
  const extension = String(mimeType || '').includes('svg')
    ? '.svg'
    : '.png';
  const filePath = path.join(
    MEDIA_OUT_DIR,
    `${prefix}-${Date.now()}-${randomBytes(4).toString('hex')}${extension}`,
  );
  await fs.writeFile(filePath, Buffer.from(base64, 'base64'));
  return filePath;
}

async function resolvePortalUser(weixinUserId) {
  return requestJson(`${PORTAL_BASE_URL}/api/weixin/bot/resolve-user`, {
    method: 'POST',
    body: JSON.stringify({ weixinUserId }),
  });
}

async function fetchOperatorSessionForBot() {
  const payload = await requestJson(`${PORTAL_BASE_URL}/api/weixin/bot/operator-session`);
  return payload.operatorSession || null;
}

function inferMimeType(filePath, fallback = 'application/octet-stream') {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.bmp') return 'image/bmp';
  if (ext === '.svg') return 'image/svg+xml';
  return fallback;
}

function toUserFacingPortalError(error) {
  const message = String(error?.message || error || '').trim();
  if (isTransientFetchError(error)) {
    return '暂时无法连接 HYFCeph 服务端，请稍后再试。';
  }
  return message || 'HYFCeph 服务暂时不可用。';
}

async function measureImageForUser({ apiKey, media }) {
  void apiKey;
  const operatorSession = await fetchOperatorSessionForBot();
  if (!operatorSession?.token || !operatorSession?.pageUrl) {
    throw new Error('管理员远程会话暂不可用，请稍后再试。');
  }

  await fs.mkdir(MEDIA_OUT_DIR, { recursive: true });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyfceph-weixin-measure-'));
  const outputPath = path.join(tempDir, 'result.json');
  const annotatedSvgPath = path.join(tempDir, 'annotated.svg');
  const annotatedPngPath = path.join(tempDir, 'annotated.png');
  const contourSvgPath = path.join(tempDir, 'contour.svg');
  const contourPngPath = path.join(tempDir, 'contour.png');
  const downloadedImagePath = path.join(tempDir, 'input');
  const fileName = media.fileName || path.basename(media.filePath);
  console.log(`[HYFCeph Weixin] measuring locally file=${fileName} via local runner`);

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
    '--image',
    media.filePath,
    '--token',
    operatorSession.token,
    '--page-url',
    operatorSession.pageUrl,
  ];

  try {
    await execFileAsync(process.execPath, args, {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
      },
      maxBuffer: LOCAL_MEASURE_BUFFER_BYTES,
    });
    const output = JSON.parse(await fs.readFile(outputPath, 'utf8'));
    const annotatedPngBuffer = await fs.readFile(output.annotatedPngPath || annotatedPngPath).catch(() => null);
    const annotatedSvgText = await fs.readFile(output.annotatedSvgPath || annotatedSvgPath, 'utf8').catch(() => null);
    const contourPngBuffer = await fs.readFile(output.contourPngPath || contourPngPath).catch(() => null);
    const contourSvgText = await fs.readFile(output.contourSvgPath || contourSvgPath, 'utf8').catch(() => null);

    return {
      analysis: output.analysis || null,
      analysisError: output.analysisError || null,
      annotationError: annotatedPngBuffer ? null : (output.annotationError || null),
      contourError: contourPngBuffer ? null : (output.contourError || null),
      summary: output.summary || null,
      metrics: output.analysis?.metrics || [],
      taskId: output.taskId || null,
      resultUrl: output.resultUrl || null,
      artifacts: {
        annotatedPngBase64: annotatedPngBuffer ? annotatedPngBuffer.toString('base64') : null,
        annotatedPngMimeType: annotatedPngBuffer ? 'image/png' : null,
        annotatedSvgBase64: annotatedSvgText ? Buffer.from(annotatedSvgText, 'utf8').toString('base64') : null,
        annotatedSvgMimeType: annotatedSvgText ? 'image/svg+xml' : null,
        contourPngBase64: contourPngBuffer ? contourPngBuffer.toString('base64') : null,
        contourPngMimeType: contourPngBuffer ? 'image/png' : null,
        contourSvgBase64: contourSvgText ? Buffer.from(contourSvgText, 'utf8').toString('base64') : null,
        contourSvgMimeType: contourSvgText ? 'image/svg+xml' : null,
      },
    };
  } catch (error) {
    const stderr = String(error?.stderr || '').trim();
    const stdout = String(error?.stdout || '').trim();
    const reason = stderr || stdout || (error instanceof Error ? error.message : String(error));
    throw new Error(reason || '本机测量失败。');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function measureImageViaPortal({ apiKey, media }) {
  const fileBuffer = await fs.readFile(media.filePath);
  const fileName = media.fileName || path.basename(media.filePath);
  const mimeType = inferMimeType(media.filePath, media.mimeType || 'application/octet-stream');
  console.log(`[HYFCeph Weixin] measuring image file=${fileName} mime=${mimeType} bytes=${fileBuffer.byteLength}`);
  const payload = await fetchJsonWithRetry(`${PORTAL_BASE_URL}/api/measure/image`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({
      fileName,
      mimeType,
      imageBase64: fileBuffer.toString('base64'),
      generateReport: false,
      includeReportPayloadKey: true,
    }),
    timeoutMs: PORTAL_MEASURE_TIMEOUT_MS,
    label: 'portal image measurement request',
  });
  return payload.result;
}

async function generateReportsForUser({ apiKey, resultPayload }) {
  console.log('[HYFCeph Weixin] generating report links');
  const reportPayloadKey = String(resultPayload?.reportPayload?.objectKey || '').trim();
  const payload = await fetchJsonWithRetry(`${PORTAL_BASE_URL}/api/report/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({
      reportType: 'image',
      ...(reportPayloadKey ? { resultPayloadKey: reportPayloadKey } : { resultPayload }),
    }),
    compressBody: !reportPayloadKey,
    timeoutMs: PORTAL_REPORT_TIMEOUT_MS,
    label: 'portal html report generation request',
  });
  return {
    report: payload.report || null,
    prettyReport: payload.prettyReport || null,
    feishuDoc: payload.feishuDoc || null,
  };
}

async function ensureReportPayloadKey({ apiKey, resultPayload }) {
  const existingKey = String(resultPayload?.reportPayload?.objectKey || '').trim();
  if (existingKey) {
    return resultPayload.reportPayload;
  }
  console.log('[HYFCeph Weixin] uploading result payload key');
  const payload = await fetchJsonWithRetry(`${PORTAL_BASE_URL}/api/report/payload`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({
      reportType: 'image',
      resultPayload,
    }),
    compressBody: true,
    timeoutMs: PORTAL_REPORT_TIMEOUT_MS,
    label: 'portal report payload upload request',
  });
  return payload.reportPayload || null;
}

async function generateFeishuDocForUser({ apiKey, resultPayload, prettyReportUrl = '', standardReportUrl = '' }) {
  console.log('[HYFCeph Weixin] generating feishu doc');
  const reportPayloadKey = String(resultPayload?.reportPayload?.objectKey || '').trim();
  const payload = await fetchJsonWithRetry(`${PORTAL_BASE_URL}/api/report/feishu-doc`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({
      reportType: 'image',
      prettyReportUrl,
      standardReportUrl,
      ...(reportPayloadKey ? { resultPayloadKey: reportPayloadKey } : { resultPayload }),
    }),
    compressBody: !reportPayloadKey,
    timeoutMs: PORTAL_REPORT_TIMEOUT_MS,
    label: 'portal feishu doc generation request',
  });
  return payload.feishuDoc || null;
}

function buildUnsupportedText() {
  return [
    '这个微信入口只处理 HYFCeph 相关内容。',
    '你可以直接发送一张头影侧位片，或者围绕最近一次测量继续问：分析法、在线报告、标点图、白底轮廓图。',
  ].join('\n');
}

async function createRestrictedAgent() {
  return {
    async chat(request) {
      const text = String(request.text || '').trim();

      if (!request.media || request.media.type !== 'image') {
        if (/^(帮助|help|怎么用|如何使用)$/i.test(text)) {
          return {
            text: [
              '使用方法很简单：',
              '1. 先在门户里登录并绑定微信 Clawbot。',
              '2. 直接把一张头影侧位片发给我。',
              '3. 我会返回核心测量结果、标注图和报告链接。',
              '4. 之后你还可以继续问我分析法、在线报告、标点图、白底轮廓图。',
            ].join('\n'),
          };
        }
        const cached = getLatestResultCache(request.conversationId);
        if (!cached) {
          return {
            text: buildUnsupportedText(),
          };
        }

        const frameworkMeta = findRequestedFramework(text);
        if (frameworkMeta) {
          return {
            text: buildFrameworkReply(cached, frameworkMeta),
          };
        }

        if (/在线报告|报告链接|报告地址|报告/.test(text)) {
          const lines = [];
          if (cached.result?.prettyReport?.reportShareUrl || cached.result?.prettyReport?.shortUrl) {
            lines.push(`美化报告链接：${cached.result.prettyReport.reportShareUrl || cached.result.prettyReport.shortUrl}`);
          }
          if (cached.result?.feishuDoc?.docUrl) {
            lines.push(`飞书文档版：${cached.result.feishuDoc.docUrl}`);
          }
          if (cached.result?.report?.reportShareUrl || cached.result?.report?.shortUrl) {
            lines.push(`在线报告链接：${cached.result.report.reportShareUrl || cached.result.report.shortUrl}`);
          }
          return {
            text: lines.length ? lines.join('\n') : '最近一次测量还没有生成在线报告链接。',
          };
        }

        if (/标点图|标注图|标点|标注/.test(text) && cached.annotatedImagePath) {
          return {
            text: '这是最近一次测量的标点图。',
            media: {
              type: 'image',
              url: cached.annotatedImagePath,
              fileName: 'hyfceph-annotated.png',
            },
          };
        }

        if (/轮廓图|白底轮廓/.test(text) && cached.contourImagePath) {
          return {
            text: '这是最近一次测量的白底轮廓图。',
            media: {
              type: 'image',
              url: cached.contourImagePath,
              fileName: 'hyfceph-contour.png',
            },
          };
        }

        if (/怎么看|怎么分析|解读|分析|总结|综合判断|关键值|指标/.test(text)) {
          return {
            text: buildQuickConsultationText(cached),
          };
        }

        return {
          text: [
            buildQuickConsultationText(cached),
            '',
            '如果你问的是别的事情，我这里不会普通聊天；但只要和最近这次侧位片测量相关，我都可以继续回答。',
          ].join('\n'),
        };
      }

      let portalUser;
      try {
        portalUser = await resolvePortalUser(request.conversationId);
      } catch (error) {
        return {
          text: error instanceof Error
            ? `${error.message}\n请先回到门户注册并完成微信绑定。`
            : '这个微信尚未绑定 HYFCeph 账号，请先回到门户完成绑定。',
        };
      }

      try {
        const result = await measureImageForUser({
          apiKey: portalUser.auth.apiKey,
          media: request.media,
        });

        try {
          const reportPayload = await promiseWithTimeout(
            ensureReportPayloadKey({
              apiKey: portalUser.auth.apiKey,
              resultPayload: result,
            }),
            12_000,
            'report payload upload timeout after 12000ms',
          );
          if (reportPayload) {
            result.reportPayload = reportPayload;
          }
        } catch (error) {
          console.warn(`[HYFCeph Weixin] report payload upload skipped: ${error instanceof Error ? error.message : String(error)}`);
        }

        try {
          const feishuDoc = await promiseWithTimeout(
            generateFeishuDocForUser({
              apiKey: portalUser.auth.apiKey,
              resultPayload: result,
            }),
            12_000,
            'feishu doc generation timeout after 12000ms',
          );
          if (feishuDoc) {
            result.feishuDoc = feishuDoc;
          }
        } catch (error) {
          console.warn(`[HYFCeph Weixin] feishu doc generation skipped: ${error instanceof Error ? error.message : String(error)}`);
        }
        try {
          const reports = await promiseWithTimeout(
            generateReportsForUser({
              apiKey: portalUser.auth.apiKey,
              resultPayload: result,
            }),
            REPORT_GENERATION_SOFT_TIMEOUT_MS,
            `report generation timeout after ${REPORT_GENERATION_SOFT_TIMEOUT_MS}ms`,
          );
          if (reports.report) {
            result.report = reports.report;
          }
          if (reports.prettyReport) {
            result.prettyReport = reports.prettyReport;
          }
          if (reports.feishuDoc && !result.feishuDoc) {
            result.feishuDoc = reports.feishuDoc;
          }
        } catch (error) {
          console.warn(`[HYFCeph Weixin] report generation skipped: ${error instanceof Error ? error.message : String(error)}`);
        }
        await updateLatestResultCache(request.conversationId, result, {
          sourceImagePath: request.media?.filePath || '',
        });
        const cached = getLatestResultCache(request.conversationId);
        const pngBase64 = result?.artifacts?.annotatedPngBase64 || '';
        const pngMimeType = result?.artifacts?.annotatedPngMimeType || 'image/png';
        const mediaReply = cached?.annotatedImagePath
          ? {
              type: 'image',
              url: cached.annotatedImagePath,
              fileName: 'hyfceph-annotated.png',
            }
          : pngBase64
          ? {
              type: 'image',
              url: await writeBase64Image(pngBase64, pngMimeType, 'hyfceph-weixin-annotated'),
              fileName: 'hyfceph-annotated.png',
            }
          : undefined;
        return {
          text: buildSummaryText(result),
          media: mediaReply,
        };
      } catch (error) {
        return {
          text: `HYFCeph 处理失败：${toUserFacingPortalError(error)}`,
        };
      }
    },
    clearSession() {
      // 当前版本不保留微信侧多轮聊天状态，只做即发即测。
    },
  };
}

async function main() {
  const bot = await syncBotConfigFromPortal();
  const agent = await createRestrictedAgent();
  console.log(`[HYFCeph Weixin] using bot account ${bot.normalizedAccountId}`);
  await startWeixinBot(agent, {
    accountId: bot.normalizedAccountId,
    log: (message) => console.log(`[HYFCeph Weixin] ${message}`),
  });
}

main().catch((error) => {
  console.error('[HYFCeph Weixin] failed:', error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
