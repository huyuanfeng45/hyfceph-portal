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
import { buildOverlapRender } from './hyfceph-overlap-renderer.mjs';
import { qrcode } from './vendor/qrcode.mjs';
import { sendMessageWeixin, start as startWeixinBot } from './vendor/weixin-agent-sdk-hyf.mjs';

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
const BARK_DEVICE_KEY = String(
  process.env.HYFCEPH_BARK_KEY
  || LOCAL_CONFIG.barkKey
  || '7ffBf7F85e3WbFyKrJTEcH',
).trim();
const BARK_BASE_URL = String(
  process.env.HYFCEPH_BARK_BASE_URL
  || LOCAL_CONFIG.barkBaseUrl
  || 'https://api.day.app',
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
const WEIXIN_MEASURE_MODE = normalizeWeixinMeasureMode(
  process.env.HYFCEPH_WEIXIN_MEASURE_MODE
  || LOCAL_CONFIG.measureMode
  || 'local-only',
);

if (!WEIXIN_BOT_SECRET && !PORTAL_API_KEY) {
  throw new Error(`缺少 HYFCEPH_WEIXIN_BOT_SECRET 或 HYFCEPH_API_KEY，无法启动微信 bot 服务。可在环境变量中提供，或写入 ${WEIXIN_CONFIG_PATH}`);
}

const PORTAL_RESOLVE_TIMEOUT_MS = 15_000;
const PORTAL_MEASURE_TIMEOUT_MS = 240_000;
const PORTAL_REPORT_TIMEOUT_MS = 90_000;
const REPORT_GENERATION_SOFT_TIMEOUT_MS = 30_000;
const REPORT_PAYLOAD_SOFT_TIMEOUT_MS = 20_000;
const FEISHU_DOC_SOFT_TIMEOUT_MS = 15_000;
const PORTAL_RETRY_ATTEMPTS = 6;
const PORTAL_RETRY_BASE_DELAY_MS = 1_500;
const PORTAL_RETRY_MAX_DELAY_MS = 15_000;
const BOT_CONFIG_REFRESH_MS = 10_000;
const LOCAL_MEASURE_BUFFER_BYTES = 128 * 1024 * 1024;
const WEIXIN_RESULT_CACHE_LIMIT = 50;
const REPORT_FOLLOW_UP_REPORT_TIMEOUT_MS = 120_000;
const REPORT_FOLLOW_UP_FEISHU_TIMEOUT_MS = 60_000;
const WEIXIN_REPLY_IMAGE_MAX_EDGE = Number(process.env.HYFCEPH_WEIXIN_REPLY_IMAGE_MAX_EDGE || '1280');
const WEIXIN_REPLY_IMAGE_JPEG_QUALITY = Number(process.env.HYFCEPH_WEIXIN_REPLY_IMAGE_JPEG_QUALITY || '82');
const LOCAL_AI_ANALYSIS_CONFIG = LOCAL_CONFIG.aiAnalysis && typeof LOCAL_CONFIG.aiAnalysis === 'object'
  ? LOCAL_CONFIG.aiAnalysis
  : {};
const AI_ANALYSIS_BASE_URL = String(
  process.env.HYFCEPH_AI_ANALYSIS_BASE_URL
  || process.env.HYFCEPH_AI_BASE_URL
  || LOCAL_CONFIG.aiAnalysisBaseUrl
  || LOCAL_CONFIG.aiBaseUrl
  || LOCAL_AI_ANALYSIS_CONFIG.baseUrl
  || '',
).trim().replace(/\/+$/, '');
const AI_ANALYSIS_API_KEY = String(
  process.env.HYFCEPH_AI_ANALYSIS_API_KEY
  || process.env.HYFCEPH_AI_API_KEY
  || LOCAL_CONFIG.aiAnalysisApiKey
  || LOCAL_CONFIG.aiApiKey
  || LOCAL_AI_ANALYSIS_CONFIG.apiKey
  || '',
).trim();
const AI_ANALYSIS_MODEL = String(
  process.env.HYFCEPH_AI_ANALYSIS_MODEL
  || process.env.HYFCEPH_AI_MODEL
  || LOCAL_CONFIG.aiAnalysisModel
  || LOCAL_CONFIG.aiModel
  || LOCAL_AI_ANALYSIS_CONFIG.model
  || 'gpt-5.4',
).trim();
const AI_ANALYSIS_IS_DEEPSEEK = /deepseek/i.test(`${AI_ANALYSIS_BASE_URL} ${AI_ANALYSIS_MODEL}`);
const AI_ANALYSIS_FAST_MODE = /^(1|true|yes|on)$/i.test(String(
  process.env.HYFCEPH_AI_ANALYSIS_FAST_MODE
  || LOCAL_CONFIG.aiAnalysisFastMode
  || LOCAL_AI_ANALYSIS_CONFIG.fastMode
  || 'true',
));
const AI_ANALYSIS_TIMEOUT_MS = Number(
  process.env.HYFCEPH_AI_ANALYSIS_TIMEOUT_MS
  || LOCAL_CONFIG.aiAnalysisTimeoutMs
  || LOCAL_AI_ANALYSIS_CONFIG.timeoutMs
  || (AI_ANALYSIS_IS_DEEPSEEK ? 90_000 : (AI_ANALYSIS_FAST_MODE ? 45_000 : 120_000)),
);
const AI_ANALYSIS_MAX_INPUT_CHARS = Math.max(10_000, Number(
  process.env.HYFCEPH_AI_ANALYSIS_MAX_INPUT_CHARS
  || LOCAL_CONFIG.aiAnalysisMaxInputChars
  || LOCAL_AI_ANALYSIS_CONFIG.maxInputChars
  || (AI_ANALYSIS_FAST_MODE ? 22_000 : 45_000),
) || (AI_ANALYSIS_FAST_MODE ? 22_000 : 45_000));
const AI_ANALYSIS_MAX_OUTPUT_TOKENS = Math.max(600, Number(
  process.env.HYFCEPH_AI_ANALYSIS_MAX_OUTPUT_TOKENS
  || LOCAL_CONFIG.aiAnalysisMaxOutputTokens
  || LOCAL_AI_ANALYSIS_CONFIG.maxOutputTokens
  || (AI_ANALYSIS_IS_DEEPSEEK ? 3_200 : (AI_ANALYSIS_FAST_MODE ? 1_400 : 2_600)),
) || (AI_ANALYSIS_IS_DEEPSEEK ? 3_200 : (AI_ANALYSIS_FAST_MODE ? 1_400 : 2_600)));
const AI_ANALYSIS_RETRY_ATTEMPTS = Math.max(1, Number(
  process.env.HYFCEPH_AI_ANALYSIS_RETRY_ATTEMPTS
  || LOCAL_CONFIG.aiAnalysisRetryAttempts
  || LOCAL_AI_ANALYSIS_CONFIG.retryAttempts
  || (AI_ANALYSIS_IS_DEEPSEEK ? 2 : (AI_ANALYSIS_FAST_MODE ? 1 : 2)),
) || (AI_ANALYSIS_IS_DEEPSEEK ? 2 : (AI_ANALYSIS_FAST_MODE ? 1 : 2)));
const AI_ANALYSIS_FRAMEWORK_LIMIT = Math.max(2, Number(
  process.env.HYFCEPH_AI_ANALYSIS_FRAMEWORK_LIMIT
  || LOCAL_CONFIG.aiAnalysisFrameworkLimit
  || LOCAL_AI_ANALYSIS_CONFIG.frameworkLimit
  || (AI_ANALYSIS_FAST_MODE ? 6 : 12),
) || (AI_ANALYSIS_FAST_MODE ? 6 : 12));
const AI_ANALYSIS_FRAMEWORK_ITEM_LIMIT = Math.max(4, Number(
  process.env.HYFCEPH_AI_ANALYSIS_FRAMEWORK_ITEM_LIMIT
  || LOCAL_CONFIG.aiAnalysisFrameworkItemLimit
  || LOCAL_AI_ANALYSIS_CONFIG.frameworkItemLimit
  || (AI_ANALYSIS_FAST_MODE ? 5 : 8),
) || (AI_ANALYSIS_FAST_MODE ? 5 : 8));
const AI_ANALYSIS_FRAMEWORK_NORMAL_ITEM_LIMIT = Math.max(0, Number(
  process.env.HYFCEPH_AI_ANALYSIS_FRAMEWORK_NORMAL_ITEM_LIMIT
  || LOCAL_CONFIG.aiAnalysisFrameworkNormalItemLimit
  || LOCAL_AI_ANALYSIS_CONFIG.frameworkNormalItemLimit
  || (AI_ANALYSIS_FAST_MODE ? 0 : 2),
) || (AI_ANALYSIS_FAST_MODE ? 0 : 2));
const AI_ANALYSIS_ALLOWED_FRAMEWORKS = [
  { label: '华西分析法', keys: ['huaxi', 'huaxitype', '华西', '华西分析法'] },
  { label: 'Jarabak分析法', keys: ['jarabak', 'jarabaktype', 'jarabak分析法'] },
  { label: 'TWEED分析法', keys: ['tweed', 'tweedtype', 'tweed分析法'] },
  { label: 'Ricketts分析法', keys: ['ricketts', 'rickettstype', 'ricketts分析法'] },
  { label: 'Downs分析法', keys: ['downs', 'downstype', 'downs分析法'] },
  { label: 'Steiner分析法', keys: ['steiner', 'steinertype', 'steiner分析法'] },
];
const execFileAsync = promisify(execFile);

function normalizeWeixinMeasureMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  if (mode === 'portal-only' || mode === 'local-first' || mode === 'local-only') {
    return mode;
  }
  return 'local-only';
}
const PYTHON_QR_OVERLAY_SCRIPT = `
import json
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

payload = json.loads(sys.argv[1])
input_path = payload["inputPath"]
base_image_path = payload.get("baseImagePath") or ""
output_path = payload["outputPath"]
matrix = payload["matrix"]
position = (payload.get("position") or "top-right").strip().lower()

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
    target_qr_size = max(110, min(170, int(short_edge * 0.145)))
    quiet_zone_modules = 4
    scale = max(2, target_qr_size // (module_count + quiet_zone_modules * 2))
    qr_size = (module_count + quiet_zone_modules * 2) * scale
    card_padding = max(12, qr_size // 10)
    label = "扫码查看完整分析"
    label_gap = max(8, qr_size // 16)
    font_size = max(16, qr_size // 7)
    font = None
    for candidate in (
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/Hiragino Sans GB.ttc",
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    ):
        try:
            font = ImageFont.truetype(candidate, font_size)
            break
        except Exception:
            continue
    if font is None:
        font = ImageFont.load_default()
    temp_draw = ImageDraw.Draw(Image.new("RGBA", (8, 8), (0, 0, 0, 0)))
    text_bbox = temp_draw.textbbox((0, 0), label, font=font)
    text_width = max(1, text_bbox[2] - text_bbox[0])
    text_height = max(1, text_bbox[3] - text_bbox[1])
    card_width = max(qr_size, text_width) + card_padding * 2
    card_height = qr_size + text_height + label_gap + card_padding * 2
    margin = max(20, short_edge // 36)
    radius = max(16, card_padding)
    top_offset = margin + max(18, short_edge // 24)

    overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
    draw_overlay = ImageDraw.Draw(overlay)
    if position == "bottom-left":
        x = margin
        y = height - card_height - margin
    else:
        x = width - card_width - margin
        y = top_offset
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

    qr_x = x + (card_width - qr_size) // 2
    qr_y = y + card_padding
    overlay.paste(qr_image, (qr_x, qr_y), qr_image)
    text_x = x + (card_width - text_width) // 2
    text_y = qr_y + qr_size + label_gap - text_bbox[1]
    draw_overlay.text(
        (text_x, text_y),
        label,
        font=font,
        fill=(30, 41, 59, 255),
    )
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
const pendingReportFollowUps = new Map();
const pendingAiAnalysisFollowUps = new Map();

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

function shortenConversationId(value) {
  const text = normalizeConversationKey(value);
  if (text.length <= 12) {
    return text;
  }
  return `${text.slice(0, 6)}...${text.slice(-4)}`;
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
    console.warn(`[HYFCeph Weixin] bark push failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function notifyImageReceived(request, pending) {
  const modeText = pending?.images?.length >= 2 ? '重叠候选（第 2 张）' : '单图候选（第 1 张）';
  const fileName = String(request?.media?.fileName || '').trim() || '未命名图片';
  let userLabel = shortenConversationId(request?.conversationId);
  try {
    const portalUser = await resolvePortalUser(request?.conversationId);
    userLabel = portalUser?.user?.name || userLabel;
  } catch {
    // 非阻塞：拿不到绑定用户时，退回到会话标识
  }
  const body = [
    `用户：${userLabel}`,
    `模式：${modeText}`,
    `文件：${fileName}`,
  ].join('\n');
  await sendBarkPush('HYFCeph 微信收到侧位片', body);
}

async function notifyMeasurementCompleted({ conversationId, portalUser, result }) {
  const isOverlap = String(result?.mode || '').trim().toLowerCase() === 'overlap';
  const userLabel = portalUser?.user?.name || shortenConversationId(conversationId);
  const patientName = normalizePatientName(result?.patientName || '') || '匿名';
  const title = isOverlap ? 'HYFCeph 微信重叠测量完成' : 'HYFCeph 微信测量完成';
  const summary = isOverlap
    ? (result?.analysis?.summary?.compareRiskLabel || result?.analysis?.compare?.riskLabel || result?.summary?.compareRiskLabel || '')
    : (result?.analysis?.riskLabel || result?.summary?.riskLabel || '');
  const docUrl = String(result?.feishuDoc?.docUrl || '').trim();
  const bodyLines = [
    `用户：${userLabel}`,
    `患者：${patientName}`,
    `模式：${isOverlap ? '重叠图' : '单图'}`,
    summary ? `结论：${summary}` : '',
    docUrl ? `飞书：${docUrl}` : '飞书：未生成',
  ].filter(Boolean);
  await sendBarkPush(title, bodyLines.join('\n'));
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
  let existingAccounts = [];
  try {
    const raw = await fs.readFile(path.join(OPENCLAW_WEIXIN_DIR, 'accounts.json'), 'utf8');
    const parsed = JSON.parse(raw);
    existingAccounts = Array.isArray(parsed) ? parsed.map((item) => normalizeAccountId(item)).filter(Boolean) : [];
  } catch {
    existingAccounts = [];
  }
  const nextAccounts = [...new Set([...existingAccounts, normalizedAccountId])];
  await fs.writeFile(
    path.join(OPENCLAW_WEIXIN_DIR, 'accounts.json'),
    JSON.stringify(nextAccounts, null, 2),
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

function botFingerprint(bot) {
  return JSON.stringify([
    String(bot.accountId || '').trim(),
    String(bot.token || '').trim(),
    String(bot.baseUrl || '').trim(),
    String(bot.botType || '').trim(),
  ]);
}

function normalizeBotConfigEntries(entries) {
  const deduped = new Map();
  for (const item of Array.isArray(entries) ? entries : []) {
    const accountId = String(item?.accountId || '').trim();
    const token = String(item?.token || '').trim();
    if (!accountId || !token) {
      continue;
    }
    deduped.set(normalizeAccountId(accountId), {
      ...item,
      accountId,
      token,
      baseUrl: String(item?.baseUrl || 'https://ilinkai.weixin.qq.com').trim().replace(/\/+$/, ''),
      botType: String(item?.botType || '').trim() || '3',
    });
  }
  return [...deduped.values()];
}

async function syncBotConfigsFromPortal() {
  try {
    const payload = await requestJson(`${PORTAL_BASE_URL}/api/weixin/bot/configs`);
    const configs = normalizeBotConfigEntries(payload.configs);
    if (configs.length) {
      const synced = [];
      for (const bot of configs) {
        const normalizedAccountId = await ensureWeixinAccountFiles(bot);
        synced.push({
          ...bot,
          normalizedAccountId,
          fingerprint: botFingerprint(bot),
        });
      }
      return synced;
    }
  } catch (error) {
    console.warn(`[HYFCeph Weixin] bot config list unavailable, fallback to single config: ${error instanceof Error ? error.message : String(error)}`);
  }

  const payload = await requestJson(`${PORTAL_BASE_URL}/api/weixin/bot/config`);
  const bot = payload.bot || null;
  if (!bot?.configured || !bot?.accountId || !bot?.token) {
    throw new Error('门户里还没有可用的微信 Clawbot 配置，请先在认证中心完成一次扫码绑定。');
  }
  const normalizedAccountId = await ensureWeixinAccountFiles(bot);
  return [{
    ...bot,
    normalizedAccountId,
    fingerprint: botFingerprint(bot),
  }];
}

async function stopRuntime(runtime, reason = '') {
  if (!runtime) {
    return;
  }
  runtime.controller.abort();
  try {
    await Promise.race([
      runtime.promise.catch(() => {}),
      sleep(1_500),
    ]);
  } catch {
    // ignore shutdown race
  }
  if (reason) {
    console.log(`[HYFCeph Weixin] stopped bot account ${runtime.accountId}${reason ? ` (${reason})` : ''}`);
  }
}

async function reconcileBotRuntimes(agent, runtimes) {
  const configs = await syncBotConfigsFromPortal();
  const desired = new Map(configs.map((item) => [item.normalizedAccountId, item]));

  for (const [accountId, runtime] of [...runtimes.entries()]) {
    if (!desired.has(accountId)) {
      await stopRuntime(runtime, 'binding removed');
      runtimes.delete(accountId);
    }
  }

  for (const config of configs) {
    const current = runtimes.get(config.normalizedAccountId);
    if (current?.fingerprint === config.fingerprint) {
      continue;
    }
    if (current) {
      await stopRuntime(current, 'config updated');
      runtimes.delete(config.normalizedAccountId);
    }

    const controller = new AbortController();
    const accountId = config.normalizedAccountId;
    console.log(`[HYFCeph Weixin] using bot account ${accountId}${config.userName ? ` for ${config.userName}` : ''}`);
    const promise = startWeixinBot(agent, {
      accountId,
      abortSignal: controller.signal,
      log: (message) => console.log(`[HYFCeph Weixin][${accountId}] ${message}`),
    }).catch((error) => {
      if (!controller.signal.aborted) {
        console.error(`[HYFCeph Weixin] bot account ${accountId} exited: ${error instanceof Error ? error.stack || error.message : String(error)}`);
      }
    }).finally(() => {
      const latest = runtimes.get(accountId);
      if (latest?.controller === controller) {
        runtimes.delete(accountId);
      }
    });

    runtimes.set(accountId, {
      accountId,
      fingerprint: config.fingerprint,
      controller,
      promise,
    });
  }
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

function isOverlapResult(result) {
  return String(result?.mode || result?.summary?.mode || result?.analysis?.type || '').trim().toLowerCase() === 'overlap';
}

function buildSummaryText(result) {
  const metrics = extractMetricMap(result);
  const summary = result?.summary || {};
  const analysis = result?.analysis || {};
  const patientName = String(result?.patientName || '').trim();
  const isOverlap = isOverlapResult(result);
  if (isOverlap) {
    const baseMetricValues = summary?.baseMetricValues || {};
    const compareMetricValues = summary?.compareMetricValues || {};
    const keyCodes = ['SNA', 'SNB', 'ANB', 'GoGn-SN', 'FMA', 'U1-SN', 'IMPA', 'Wits'];
    const changedLines = keyCodes
      .filter((code) => baseMetricValues?.[code] || compareMetricValues?.[code])
      .map((code) => `${code} ${baseMetricValues?.[code] || '-'} → ${compareMetricValues?.[code] || '-'}`);
    const lines = [
      patientName ? `患者：${patientName}` : '',
      `重叠对比完成（${summary.alignLabel || summary.alignMode || 'SN'} 对齐）。`,
      summary?.baseRiskLabel ? `基准图：${summary.baseRiskLabel}` : '',
      summary?.compareRiskLabel ? `对照图：${summary.compareRiskLabel}` : '',
    ].filter(Boolean);
    if (changedLines.length) {
      lines.push('', '关键值对比：', changedLines.join('；'));
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
    lines.push('', '如需继续，你可以继续问我：Downs、Steiner、北大分析法，或者直接发“在线报告”“标点图”。');
    return lines.join('\n');
  }
  const lines = [
    patientName ? `患者：${patientName}` : '',
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

function collectReportLinkLines(result) {
  const lines = [];
  const prettyReportUrl = result?.prettyReport?.reportShareUrl || result?.prettyReport?.shortUrl || '';
  const feishuDocUrl = result?.feishuDoc?.docUrl || '';
  const reportUrl = result?.report?.reportShareUrl || result?.report?.shortUrl || '';
  if (prettyReportUrl) {
    lines.push(`美化报告链接：${prettyReportUrl}`);
  }
  if (feishuDocUrl) {
    lines.push(`飞书文档版：${feishuDocUrl}`);
  }
  if (reportUrl) {
    lines.push(`在线报告链接：${reportUrl}`);
  }
  return lines;
}

function hasMissingReportLinks(result) {
  const lines = collectReportLinkLines(result);
  return lines.length < 3;
}

async function sendWeixinFollowUpText(request, text) {
  const contextToken = String(request?.weixin?.contextToken || '').trim();
  const baseUrl = String(request?.weixin?.baseUrl || '').trim();
  const token = String(request?.weixin?.token || '').trim();
  const to = String(request?.conversationId || '').trim();
  if (!contextToken || !baseUrl || !token || !to || !text) {
    return false;
  }
  await sendMessageWeixin({
    to,
    text,
    opts: {
      baseUrl,
      token,
      contextToken,
    },
  });
  return true;
}

function buildQuickConsultationText(cacheEntry) {
  const result = cacheEntry?.result;
  if (!result) {
    return buildUnsupportedText();
  }
  if (String(result?.mode || result?.summary?.mode || '').trim().toLowerCase() === 'overlap') {
    const summary = result?.summary || {};
    const keyCodes = ['SNA', 'SNB', 'ANB', 'GoGn-SN', 'FMA', 'U1-SN', 'IMPA', 'Wits'];
    const keyLines = keyCodes
      .filter((code) => summary?.baseMetricValues?.[code] || summary?.compareMetricValues?.[code])
      .slice(0, 4)
      .map((code) => `- ${code}：${summary?.baseMetricValues?.[code] || '-'} → ${summary?.compareMetricValues?.[code] || '-'}`);
    return [
      `这是最近一次重叠结果（${summary.alignLabel || summary.alignMode || 'SN'} 对齐）。`,
      summary?.baseRiskLabel ? `基准图：${summary.baseRiskLabel}` : '',
      summary?.compareRiskLabel ? `对照图：${summary.compareRiskLabel}` : '',
      keyLines.length ? '' : null,
      keyLines.length ? '当前重点变化：' : null,
      ...keyLines,
      '',
      '你还可以继续问我：Downs、Steiner、北大分析法、ABO、Ricketts、Tweed、McNamara、Jarabak，或者直接发“在线报告”“标点图”。',
    ].filter(Boolean).join('\n');
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

function normalizePatientName(raw) {
  return String(raw || '').trim().replace(/\s+/g, ' ').slice(0, 40);
}

function isSkipPatientNameText(text) {
  return /^(匿名|无名|不写|不填|跳过|无需填写|不用写|直接开始|开始测量)$/i.test(String(text || '').trim());
}

function isMeasurementCommandText(text) {
  return /^(帮助|help|怎么用|如何使用|在线报告|报告链接|报告地址|报告|标点图|标注图|标点|标注|轮廓图|白底轮廓|怎么看|怎么分析|解读|分析|总结|综合判断|关键值|指标|Downs|Steiner|北大分析法|ABO|Ricketts|Tweed|McNamara|Jarabak)$/i.test(String(text || '').trim());
}

function isResetConversationText(text) {
  return /^(重置|重新开始|重新对话|新对话|清空|清除缓存|重新来过)$/i.test(String(text || '').trim());
}

function isAiSupplementSkipText(text) {
  return /^(无|没有|暂无|无补充|没有补充|都没有|不清楚|未知|跳过|略过|直接生成|直接分析|先生成|先分析)$/i.test(String(text || '').trim());
}

function normalizeAiSupplementText(text) {
  const rawText = String(text || '').trim().replace(/\s+/g, ' ');
  if (!rawText || isAiSupplementSkipText(rawText)) {
    return '用户未提供额外临床补充信息。';
  }
  return rawText.slice(0, 2000);
}

function buildAiSupplementQuestionText(result) {
  const patientName = normalizePatientName(result?.patientName || '') || '匿名';
  return [
    `飞书文档已经生成。AI 综合分析前，请先补充一下 ${patientName} 的临床信息：`,
    '',
    '1. 是否有缺牙、先天缺失、已拔牙、多生牙或埋伏牙？',
    '2. 当前是恒牙列、替牙期，还是乳牙列？如果是儿童，年龄大概多少？',
    '3. 是否已经明确要拔牙，或明确不拔牙？',
    '4. 主要诉求是什么？例如前突、拥挤、反颌、开合、偏颌、露龈笑等。',
    '5. 是否有牙周、关节、CBCT、根形、种植钉、二类牵引等特殊限制或计划？',
    '',
    '你可以按下面格式回复：',
    '缺牙：无；牙列阶段：恒牙列；拔牙意向：未定；主诉：前突和拥挤；其他：无。',
    '',
    '如果没有补充，直接回复“无补充”或“跳过”。',
  ].join('\n');
}

function normalizePendingMeasurement(pendingMeasurement) {
  if (!pendingMeasurement || typeof pendingMeasurement !== 'object') {
    return null;
  }
  const normalizeEntry = (entry) => {
    if (!entry || typeof entry !== 'object' || !entry.filePath) {
      return null;
    }
    return {
      filePath: String(entry.filePath),
      fileName: String(entry.fileName || path.basename(String(entry.filePath))),
      mimeType: inferMimeType(String(entry.filePath), entry.mimeType || 'application/octet-stream'),
      receivedAt: entry.receivedAt || new Date().toISOString(),
    };
  };
  const images = Array.isArray(pendingMeasurement.images)
    ? pendingMeasurement.images.map(normalizeEntry).filter(Boolean).slice(-2)
    : [normalizeEntry(pendingMeasurement)].filter(Boolean);
  if (!images.length) {
    return null;
  }
  return {
    mode: images.length >= 2 ? 'overlap' : 'single',
    images,
  };
}

function hasPendingMeasurement(conversationId) {
  return Boolean(normalizePendingMeasurement(getLatestResultCache(conversationId)?.pendingMeasurement)?.images?.length);
}

function getPendingAiSupplement(conversationId) {
  const cached = getLatestResultCache(conversationId);
  const result = cached?.result;
  const pending = cached?.pendingAiSupplement;
  const documentId = String(result?.feishuDoc?.documentId || '').trim();
  if (!result || !pending || !documentId || result?.feishuDoc?.aiAnalysis?.ok) {
    return null;
  }
  return String(pending.documentId || '').trim() === documentId ? pending : null;
}

function hasPendingAiSupplement(conversationId) {
  return Boolean(getPendingAiSupplement(conversationId));
}

async function setPendingMeasurement(conversationId, media) {
  const key = normalizeConversationKey(conversationId);
  const previous = latestResultCache[key] || {};
  const persistedPath = await persistOriginalImageFile(
    media?.filePath || '',
    `${key}-pending-source`,
  );
  const nextEntry = persistedPath ? {
    filePath: persistedPath,
    fileName: media?.fileName || path.basename(persistedPath),
    mimeType: inferMimeType(persistedPath, media?.mimeType || 'application/octet-stream'),
    receivedAt: new Date().toISOString(),
  } : null;
  const previousPending = normalizePendingMeasurement(previous.pendingMeasurement);
  let images = previousPending?.images ? [...previousPending.images] : [];
  if (nextEntry) {
    if (images.length >= 2) {
      images = [nextEntry];
    } else {
      images.push(nextEntry);
      images = images.slice(-2);
    }
  }
  latestResultCache[key] = {
    ...previous,
    updatedAt: new Date().toISOString(),
    pendingMeasurement: images.length ? {
      mode: images.length >= 2 ? 'overlap' : 'single',
      images,
    } : previous.pendingMeasurement || null,
  };
  await saveResultCache();
  return latestResultCache[key];
}

async function clearPendingMeasurement(conversationId) {
  const key = normalizeConversationKey(conversationId);
  const current = latestResultCache[key];
  if (!current) {
    return;
  }
  latestResultCache[key] = {
    ...current,
    updatedAt: new Date().toISOString(),
    pendingMeasurement: null,
  };
  await saveResultCache();
}

async function resetConversationState(conversationId) {
  const key = normalizeConversationKey(conversationId);
  if (!latestResultCache[key]) {
    return false;
  }
  delete latestResultCache[key];
  await saveResultCache();
  return true;
}

function buildFrameworkReply(cacheEntry, frameworkMeta) {
  const result = cacheEntry?.result;
  const isOverlap = String(result?.mode || result?.summary?.mode || '').trim().toLowerCase() === 'overlap';
  if (isOverlap) {
    const baseFramework = result?.analysis?.base?.frameworkReports?.[frameworkMeta.code];
    const compareFramework = result?.analysis?.compare?.frameworkReports?.[frameworkMeta.code];
    if (!baseFramework && !compareFramework) {
      return `${frameworkMeta.label} 目前还没有可用结果。你可以先重新发送两张侧位片。`;
    }
    const formatSide = (framework, label) => {
      if (!framework) {
        return `${label}：暂无可用结果。`;
      }
      const items = Array.isArray(framework.items) ? framework.items : [];
      const topItems = items
        .filter((item) => !item.status || item.status === 'supported')
        .slice()
        .sort((left, right) => frameworkItemSeverityScore(right) - frameworkItemSeverityScore(left))
        .slice(0, 4)
        .map((item) => `- ${item.label || item.code}：${item.valueText || '-'}（${frameworkStatusText(item)}）`);
      const supportedCount = Number(framework.supportedItemCount || topItems.length || 0);
      const unsupportedCount = Number(framework.unsupportedItemCount || 0);
      return [
        `${label}：已输出 ${supportedCount} 项，未算出 ${unsupportedCount} 项。`,
        framework.note || '',
        ...topItems,
      ].filter(Boolean).join('\n');
    };
    return [
      `${frameworkMeta.label} 分析法（重叠对比）`,
      '',
      formatSide(baseFramework, '基准图'),
      '',
      formatSide(compareFramework, '对照图'),
      '',
      '如果你要，我也可以继续把这一套分析法的变化重点再展开讲。',
    ].filter(Boolean).join('\n');
  }
  const framework = result?.analysis?.frameworkReports?.[frameworkMeta.code];
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

function rewriteOverlapSvgForWechat(svgText) {
  if (!svgText || !svgText.includes('HYF Ceph Overlap')) {
    return svgText;
  }
  const svgOpenTagMatch = svgText.match(/<svg\b[^>]*width="(\d+)"[^>]*height="(\d+)"[^>]*>/i);
  let rewritten = svgText;
  if (svgOpenTagMatch && !/<rect x="0" y="0" width="[^"]+" height="[^"]+" fill="#ffffff"\s*\/>/.test(rewritten)) {
    const [, width, height] = svgOpenTagMatch;
    rewritten = rewritten.replace(
      svgOpenTagMatch[0],
      `${svgOpenTagMatch[0]}<rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff" />`,
    );
  }
  rewritten = rewritten
    .replace(/<rect x="[^"]+" y="44" width="196" height="130" rx="16" fill="#ffffff" fill-opacity="0\.88" stroke="#d8dcf7" stroke-width="1"\s*\/>/, '<rect x="32" y="44" width="196" height="130" rx="16" fill="#ffffff" fill-opacity="0.92" stroke="#d8dcf7" stroke-width="1" />')
    .replace(/<line x1="[^"]+" y1="60" x2="[^"]+" y2="60" stroke="#f59e0b" stroke-width="3\.5" stroke-linecap="round" opacity="0\.95"\s*\/>/, '<line x1="52" y1="60" x2="96" y2="60" stroke="#f59e0b" stroke-width="3.5" stroke-linecap="round" opacity="0.95" />')
    .replace(/<line x1="[^"]+" y1="60" x2="[^"]+" y2="60" stroke="#22d3ee" stroke-width="3\.5" stroke-linecap="round" opacity="0\.95"\s*\/>/, '<line x1="128" y1="60" x2="172" y2="60" stroke="#22d3ee" stroke-width="3.5" stroke-linecap="round" opacity="0.95" />')
    .replace(/<text x="[^"]+" y="42"([^>]*)>HYF Ceph Overlap<\/text>/, '<text x="50" y="42"$1>HYF Ceph Overlap</text>')
    .replace(/<text x="[^"]+" y="66"([^>]*)>(.*?)<\/text>/, '<text x="50" y="66"$1>$2</text>')
    .replace(/<text x="[^"]+" y="90"([^>]*)>基准: /, '<text x="50" y="90"$1>治疗前: ')
    .replace(/<text x="[^"]+" y="114"([^>]*)>对照: /, '<text x="50" y="114"$1>治疗后: ');
  return rewritten;
}

async function convertSvgTextToPngForWechat(svgText, prefix) {
  if (!svgText) {
    return null;
  }
  await ensureCacheDirs();
  const svgPath = path.join(
    WEIXIN_MEDIA_CACHE_DIR,
    `${prefix}-${Date.now()}-${randomBytes(4).toString('hex')}.svg`,
  );
  const pngPath = path.join(
    WEIXIN_MEDIA_CACHE_DIR,
    `${prefix}-${Date.now()}-${randomBytes(4).toString('hex')}.png`,
  );
  await fs.writeFile(svgPath, svgText, 'utf8');
  try {
    await execFileAsync('sips', ['-s', 'format', 'png', svgPath, '--out', pngPath]);
    return pngPath;
  } catch (error) {
    console.warn(`[HYFCeph Weixin] failed to convert overlap svg locally: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
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
  qrPosition = 'top-right',
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
    position: qrPosition || 'top-right',
  };
  try {
    await execFileAsync('python3', ['-c', PYTHON_QR_OVERLAY_SCRIPT, JSON.stringify(payload)]);
    return outputPath;
  } catch (error) {
    console.warn(`[HYFCeph Weixin] failed to compose annotated image QR: ${error instanceof Error ? error.message : String(error)}`);
    return imagePath;
  }
}

async function prepareWeixinReplyImage(imagePath, prefix) {
  if (!imagePath) {
    return imagePath;
  }
  await ensureCacheDirs();
  const outputPath = path.join(
    WEIXIN_MEDIA_CACHE_DIR,
    `${prefix}-${Date.now()}-${randomBytes(4).toString('hex')}.jpg`,
  );
  const maxEdge = Number.isFinite(WEIXIN_REPLY_IMAGE_MAX_EDGE) && WEIXIN_REPLY_IMAGE_MAX_EDGE > 0
    ? Math.floor(WEIXIN_REPLY_IMAGE_MAX_EDGE)
    : 1280;
  const quality = Number.isFinite(WEIXIN_REPLY_IMAGE_JPEG_QUALITY) && WEIXIN_REPLY_IMAGE_JPEG_QUALITY > 0
    ? Math.min(100, Math.floor(WEIXIN_REPLY_IMAGE_JPEG_QUALITY))
    : 82;
  try {
    await execFileAsync('sips', [
      '-Z',
      String(maxEdge),
      '-s',
      'format',
      'jpeg',
      '-s',
      'formatOptions',
      String(quality),
      imagePath,
      '--out',
      outputPath,
    ]);
    return outputPath;
  } catch (error) {
    console.warn(`[HYFCeph Weixin] failed to prepare reply image: ${error instanceof Error ? error.message : String(error)}`);
    return imagePath;
  }
}

async function updateLatestResultCache(conversationId, result, options = {}) {
  const key = normalizeConversationKey(conversationId);
  const previous = latestResultCache[key] || {};
  const previousFeishuDoc = previous.result?.feishuDoc || null;
  const nextFeishuDoc = result?.feishuDoc || null;
  const previousDocumentId = String(previousFeishuDoc?.documentId || '').trim();
  const nextDocumentId = String(nextFeishuDoc?.documentId || '').trim();
  const previousDocUrl = String(previousFeishuDoc?.docUrl || '').trim();
  const nextDocUrl = String(nextFeishuDoc?.docUrl || '').trim();
  const isSameFeishuDoc = Boolean(
    nextFeishuDoc
    && previousFeishuDoc
    && (
      (previousDocumentId && nextDocumentId && previousDocumentId === nextDocumentId)
      || (previousDocUrl && nextDocUrl && previousDocUrl === nextDocUrl)
    ),
  );
  const sourceImagePath = await persistOriginalImageFile(
    options.sourceImagePath || '',
    `${key}-source`,
  ) || previous.sourceImagePath || '';
  const isOverlap = isOverlapResult(result);
  let overlapRebuiltPngPath = null;
  if (isOverlap && result?.artifacts?.annotatedSvgBase64) {
    const overlapSvgText = Buffer.from(result.artifacts.annotatedSvgBase64, 'base64').toString('utf8');
    const rewrittenSvgText = rewriteOverlapSvgForWechat(overlapSvgText);
    overlapRebuiltPngPath = await convertSvgTextToPngForWechat(rewrittenSvgText, `${key}-overlap`);
  }
  const rawAnnotatedImagePath = await persistArtifactBase64(
    !overlapRebuiltPngPath ? (result?.artifacts?.annotatedPngBase64 || '') : '',
    result?.artifacts?.annotatedPngMimeType || 'image/png',
    `${key}-annotated`,
  ) || overlapRebuiltPngPath || '';
  const composedAnnotatedImagePath = await composeAnnotatedImageForReply(
    rawAnnotatedImagePath || previous.annotatedImagePath || '',
    result?.feishuDoc?.docUrl || '',
    `${key}-annotated-qr`,
    {
      baseImagePath: isOverlap ? '' : sourceImagePath,
      qrPosition: isOverlap ? 'bottom-left' : 'top-right',
    },
  ) || previous.annotatedImagePath || '';
  const annotatedImagePath = await prepareWeixinReplyImage(
    composedAnnotatedImagePath,
    `${key}-annotated-wechat`,
  ) || composedAnnotatedImagePath || previous.annotatedImagePath || '';
  const contourImagePath = await persistArtifactBase64(
    result?.artifacts?.contourPngBase64 || '',
    result?.artifacts?.contourPngMimeType || 'image/png',
    `${key}-contour`,
  ) || previous.contourImagePath || '';
  latestResultCache[key] = {
    updatedAt: new Date().toISOString(),
    result: {
      mode: result?.mode || previous.result?.mode || '',
      analysis: result?.analysis && typeof result.analysis === 'object'
        ? result.analysis
        : (previous.result?.analysis || {
            riskLabel: '',
            insight: '',
            metrics: [],
            frameworkReports: {},
          }),
      analysisError: result?.analysisError || null,
      patientName: normalizePatientName(result?.patientName || previous.result?.patientName || ''),
      metrics: Array.isArray(result?.metrics) ? result.metrics : [],
      summary: result?.summary || {},
      reportPayload: result?.reportPayload || previous.result?.reportPayload || null,
      report: result?.report || null,
      prettyReport: result?.prettyReport || null,
      aiSupplement: result?.aiSupplement || null,
      feishuDoc: nextFeishuDoc
        ? {
            ...(isSameFeishuDoc ? previousFeishuDoc : {}),
            ...nextFeishuDoc,
            aiAnalysis: nextFeishuDoc.aiAnalysis || (isSameFeishuDoc ? previousFeishuDoc?.aiAnalysis : null) || null,
          }
        : (previousFeishuDoc || null),
    },
    sourceImagePath,
    rawAnnotatedImagePath: rawAnnotatedImagePath || previous.rawAnnotatedImagePath || '',
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

async function refreshCachedReportArtifacts(conversationId, cached, result) {
  const key = normalizeConversationKey(conversationId);
  const rawAnnotatedImagePath = cached?.rawAnnotatedImagePath || cached?.annotatedImagePath || '';
  if (!rawAnnotatedImagePath || !result?.feishuDoc?.docUrl) {
    return;
  }
  const refreshedComposedAnnotatedImagePath = await composeAnnotatedImageForReply(
    rawAnnotatedImagePath,
    result.feishuDoc.docUrl,
    `${key}-annotated-qr-refresh`,
    {
      baseImagePath: String(result?.mode || cached?.result?.mode || '').trim().toLowerCase() === 'overlap'
        ? ''
        : (cached?.sourceImagePath || ''),
      qrPosition: String(result?.mode || cached?.result?.mode || '').trim().toLowerCase() === 'overlap'
        ? 'bottom-left'
        : 'top-right',
    },
  );
  const refreshedAnnotatedImagePath = await prepareWeixinReplyImage(
    refreshedComposedAnnotatedImagePath,
    `${key}-annotated-wechat-refresh`,
  );
  if (refreshedAnnotatedImagePath) {
    latestResultCache[key] = {
      ...(latestResultCache[key] || cached),
      annotatedImagePath: refreshedAnnotatedImagePath,
      updatedAt: new Date().toISOString(),
    };
    await saveResultCache();
  }
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

function buildPortalReportPayload(resultPayload) {
  const payload = resultPayload && typeof resultPayload === 'object' ? resultPayload : {};
  return {
    mode: payload.mode || '',
    analysis: payload.analysis || null,
    analysisError: payload.analysisError || null,
    summary: payload.summary || null,
    metrics: payload.metrics || payload.analysis?.metrics || [],
    artifacts: {},
  };
}

function buildFeishuDocPayload(resultPayload) {
  const payload = resultPayload && typeof resultPayload === 'object' ? resultPayload : {};
  return {
    mode: payload.mode || '',
    analysis: payload.analysis || null,
    analysisError: payload.analysisError || null,
    summary: payload.summary || null,
    metrics: payload.metrics || payload.analysis?.metrics || [],
  };
}

function isAiAnalysisConfigured() {
  return Boolean(AI_ANALYSIS_BASE_URL && AI_ANALYSIS_API_KEY && AI_ANALYSIS_MODEL);
}

function sanitizeAiAnalysisPayload(value, depth = 0) {
  if (depth > 12) {
    return '[truncated-depth]';
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeAiAnalysisPayload(item, depth + 1));
  }
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && value.length > 2_000) {
      return `${value.slice(0, 2_000)}……`;
    }
    return value;
  }

  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/base64|artifact|image|png|svg|buffer|filePath|downloadedImage|sourceImage/i.test(key)) {
      continue;
    }
    output[key] = sanitizeAiAnalysisPayload(entry, depth + 1);
  }
  return output;
}

function compactAiText(value, maxLength = 360) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) {
    return '';
  }
  return text.length > maxLength ? `${text.slice(0, maxLength).trim()}……` : text;
}

function omitEmptyAiFields(record) {
  const output = {};
  for (const [key, value] of Object.entries(record || {})) {
    if (value === null || value === undefined || value === '') {
      continue;
    }
    if (Array.isArray(value) && !value.length) {
      continue;
    }
    if (typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length) {
      continue;
    }
    output[key] = value;
  }
  return output;
}

function aiItemPriority(item) {
  if (!item || typeof item !== 'object') {
    return 0;
  }
  const tone = String(item.tone || '').toLowerCase();
  const status = String(item.status || '').toLowerCase();
  const text = [
    item.prompt,
    item.clinicalMeaning,
    item.label,
    item.reference,
  ].map((value) => String(value || '')).join(' ');
  let score = 0;
  if (/danger|error|high|severe|异常|重度/.test(tone)) score += 8;
  if (/warn|warning|medium|中度|偏/.test(tone)) score += 5;
  if (status && !/supported|normal|success/.test(status)) score += 3;
  if (/偏大|偏小|增大|减小|前突|后缩|唇倾|舌倾|高角|低角|开[牙合合]|深覆|反[牙合合]|拥挤|异常|陡|代偿|风险/.test(text)) score += 4;
  if (/正常|适中|无异常/.test(text) && score < 5) score -= 1;
  return score;
}

function selectAiFrameworkItems(items) {
  const source = (Array.isArray(items) ? items : [])
    .map(compactAiMeasurementItem)
    .filter(Boolean);
  const abnormal = source
    .filter((item) => aiItemPriority(item) > 0)
    .sort((left, right) => aiItemPriority(right) - aiItemPriority(left));
  const normal = source.filter((item) => aiItemPriority(item) <= 0);
  const selected = [
    ...abnormal.slice(0, AI_ANALYSIS_FRAMEWORK_ITEM_LIMIT),
    ...normal.slice(0, Math.max(0, AI_ANALYSIS_FRAMEWORK_NORMAL_ITEM_LIMIT)),
  ];
  const deduped = new Map();
  for (const item of selected) {
    const key = `${item.code || ''}:${item.label || ''}:${item.value || ''}`;
    if (!deduped.has(key)) {
      deduped.set(key, item);
    }
  }
  return [...deduped.values()].slice(0, AI_ANALYSIS_FRAMEWORK_ITEM_LIMIT);
}

function compactAiMeasurementItem(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }
  return omitEmptyAiFields({
    code: compactAiText(item.code, 120),
    label: compactAiText(item.label || item.name || item.code, 120),
    category: compactAiText(item.category || item.type, 80),
    value: item.valueText || (Number.isFinite(item.value) ? `${item.value}${item.unit || ''}` : ''),
    reference: compactAiText(item.reference || item.standardText || item.standard || item.norm, 160),
    status: compactAiText(item.status, 80),
    tone: compactAiText(item.tone, 80),
    prompt: compactAiText(item.prompt || item.judgment || item.comment, 220),
    clinicalMeaning: compactAiText(item.clinicalMeaning || item.meaning || item.interpretation, 260),
  });
}

function compactAiMetrics(metrics) {
  return (Array.isArray(metrics) ? metrics : [])
    .map(compactAiMeasurementItem)
    .filter(Boolean);
}

function compactAiFrameworkReport(report) {
  if (!report || typeof report !== 'object') {
    return null;
  }
  const allItems = (Array.isArray(report.items) ? report.items : [])
    .map(compactAiMeasurementItem)
    .filter(Boolean);
  const selectedItems = selectAiFrameworkItems(report.items);
  const abnormalCount = allItems.filter((item) => aiItemPriority(item) > 0).length;
  return omitEmptyAiFields({
    code: compactAiText(report.code, 120),
    label: compactAiText(report.label || report.name || report.code, 120),
    note: compactAiText(report.note, 300),
    status: compactAiText(report.status, 80),
    supportedItemCount: Number.isFinite(Number(report.supportedItemCount)) ? Number(report.supportedItemCount) : undefined,
    unsupportedItemCount: Number.isFinite(Number(report.unsupportedItemCount)) ? Number(report.unsupportedItemCount) : undefined,
    itemSummary: omitEmptyAiFields({
      total: allItems.length,
      abnormal: abnormalCount,
      selected: selectedItems.length,
      selectionRule: '优先保留异常/偏离/有临床意义项目，少量保留正常代表项',
    }),
    items: selectedItems,
  });
}

function summarizeAiFrameworkReport(code, report) {
  const compact = compactAiFrameworkReport(report);
  if (!compact) {
    return null;
  }
  return omitEmptyAiFields({
    code: compactAiText(compact.code || code, 120),
    label: compactAiText(compact.label || code, 120),
    status: compact.status,
    total: compact.itemSummary?.total,
    abnormal: compact.itemSummary?.abnormal,
    selected: compact.itemSummary?.selected,
  });
}

function normalizeAiFrameworkKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_\-:：/\\()[\]{}（）【】]/g, '');
}

function aiFrameworkAllowedIndex(code, report) {
  const candidates = [
    code,
    report?.code,
    report?.label,
    report?.name,
  ].map(normalizeAiFrameworkKey).filter(Boolean);
  if (!candidates.length) {
    return -1;
  }
  return AI_ANALYSIS_ALLOWED_FRAMEWORKS.findIndex((framework) => (
    framework.keys
      .map(normalizeAiFrameworkKey)
      .some((key) => candidates.some((candidate) => candidate === key || candidate.includes(key)))
  ));
}

function compactAiFrameworkChoices(frameworkChoices) {
  const choices = Array.isArray(frameworkChoices) ? frameworkChoices : [];
  return AI_ANALYSIS_ALLOWED_FRAMEWORKS
    .filter((framework, index) => choices.some((choice) => (
      aiFrameworkAllowedIndex(choice, { code: choice, label: choice }) === index
    )))
    .map((framework) => framework.label);
}

function compactAiSummary(summary) {
  if (!summary || typeof summary !== 'object') {
    return sanitizeAiAnalysisPayload(summary || null);
  }
  const compact = sanitizeAiAnalysisPayload(summary);
  if (!compact || typeof compact !== 'object' || Array.isArray(compact)) {
    return compact;
  }
  return omitEmptyAiFields({
    ...compact,
    frameworkChoices: compactAiFrameworkChoices(compact.frameworkChoices),
    supportedFrameworks: compactAiFrameworkChoices(compact.supportedFrameworks),
  });
}

function aiFrameworkPriority(report) {
  if (!report || typeof report !== 'object') {
    return 0;
  }
  const items = Array.isArray(report.items) ? report.items : [];
  const itemScore = items.reduce((sum, item) => sum + Math.max(0, aiItemPriority(compactAiMeasurementItem(item))), 0);
  const abnormalCount = items.filter((item) => aiItemPriority(compactAiMeasurementItem(item)) > 0).length;
  return itemScore + abnormalCount * 3 + Math.min(items.length, 20) * 0.05;
}

function selectAiFrameworkEntries(frameworkReports) {
  const reports = frameworkReports && typeof frameworkReports === 'object' ? frameworkReports : {};
  return Object.entries(reports)
    .map(([code, report]) => {
      const allowedIndex = aiFrameworkAllowedIndex(code, report);
      return {
        code,
        report,
        allowedIndex,
        priority: aiFrameworkPriority(report),
      };
    })
    .filter((entry) => entry.allowedIndex >= 0)
    .sort((left, right) => (
      left.allowedIndex - right.allowedIndex
      || right.priority - left.priority
    ));
}

function compactAiFrameworkReports(frameworkReports) {
  const output = {};
  for (const { code, report } of selectAiFrameworkEntries(frameworkReports).slice(0, Math.max(AI_ANALYSIS_FRAMEWORK_LIMIT, AI_ANALYSIS_ALLOWED_FRAMEWORKS.length))) {
    const compact = compactAiFrameworkReport(report);
    if (compact) {
      output[code] = compact;
    }
  }
  return output;
}

function summarizeAiFrameworkReports(frameworkReports) {
  return selectAiFrameworkEntries(frameworkReports)
    .map(({ code, report }) => summarizeAiFrameworkReport(code, report))
    .filter(Boolean);
}

function compactAiAnalysisSide(side) {
  if (!side || typeof side !== 'object') {
    return null;
  }
  return omitEmptyAiFields({
    riskLabel: compactAiText(side.riskLabel, 180),
    insight: compactAiText(side.insight, 420),
    metrics: compactAiMetrics(side.metrics),
    frameworkOverview: summarizeAiFrameworkReports(side.frameworkReports),
    frameworkReports: compactAiFrameworkReports(side.frameworkReports),
  });
}

function compactAiAnalysis(analysis) {
  if (!analysis || typeof analysis !== 'object') {
    return null;
  }
  return omitEmptyAiFields({
    type: compactAiText(analysis.type, 80),
    riskLabel: compactAiText(analysis.riskLabel, 180),
    insight: compactAiText(analysis.insight, 420),
    frameworkChoices: Array.isArray(analysis.frameworkChoices)
      ? compactAiFrameworkChoices(analysis.frameworkChoices)
      : [],
    metrics: compactAiMetrics(analysis.metrics),
    frameworkOverview: summarizeAiFrameworkReports(analysis.frameworkReports),
    frameworkReports: compactAiFrameworkReports(analysis.frameworkReports),
    base: compactAiAnalysisSide(analysis.base),
    compare: compactAiAnalysisSide(analysis.compare),
  });
}

function buildAiAnalysisSourcePayload(resultPayload) {
  const payload = resultPayload && typeof resultPayload === 'object' ? resultPayload : {};
  return omitEmptyAiFields({
    mode: payload.mode || '',
    patientName: normalizePatientName(payload.patientName || '') || '匿名',
    generatedAt: new Date().toISOString(),
    analysisFrameworkScope: AI_ANALYSIS_ALLOWED_FRAMEWORKS.map((framework) => framework.label),
    summary: compactAiSummary(payload.summary || null),
    metrics: compactAiMetrics(payload.metrics || payload.analysis?.metrics || []),
    analysis: compactAiAnalysis(payload.analysis),
    clinicalSupplement: sanitizeAiAnalysisPayload(payload.aiSupplement || null),
    analysisError: compactAiText(payload.analysisError, 500),
  });
}

function buildAiAnalysisPrompt(resultPayload) {
  const sourcePayload = buildAiAnalysisSourcePayload(resultPayload);
  let reportJson = JSON.stringify(sourcePayload, null, 2);
  if (reportJson.length > AI_ANALYSIS_MAX_INPUT_CHARS) {
    reportJson = `${reportJson.slice(0, AI_ANALYSIS_MAX_INPUT_CHARS)}\n\n[由于数据过长，后续 JSON 已截断；请基于已提供的数据谨慎分析。]`;
  }
  return [
    AI_ANALYSIS_FAST_MODE
      ? '请基于下面这份头影测量结构化数据，快速写一份面向正畸医生阅读的中文综合分析。'
      : '请基于下面这份头影测量美化报告的结构化数据，写一份面向正畸医生阅读的中文综合分析。',
    '',
    '要求：',
    '1. 只基于给定数据分析，不要编造片外信息，不要声称已重新阅片。',
    '2. 不要出现外部平台或数据供应方名称。',
    '3. 本次只使用华西分析法、Jarabak分析法、TWEED分析法、Ricketts分析法、Downs分析法、Steiner分析法的数据进行综合分析；不要引用其它分析法。',
    AI_ANALYSIS_FAST_MODE
      ? '4. 优先分析异常值、偏离项和互相印证的指标；正常项一句带过。总长度控制在 1200-1800 个中文字符。'
      : '4. 内容尽量详细，覆盖骨性矢状向、垂直向、牙性代偿、软组织侧貌、生长型、关键异常值、不同分析法之间的一致与冲突、临床关注点、复核建议。',
    '5. 对每个重要结论尽量引用具体指标名、测量值、标准范围或偏离方向。',
    '6. 语气专业、克制，定位为辅助分析，不替代医生诊断。',
    '7. 必须单独讨论拔牙或不拔牙倾向，但要明确最终需结合拥挤度、Bolton、牙周、面型、CBCT/根形和患者诉求。',
    '8. 必须单独讨论固定矫正注意事项，重点写支抗、转矩、垂直向、前牙移动、牙周和根吸收监测。',
    '9. 必须单独讨论隐形矫正注意事项，重点写附件/IPR/扩弓或远移、转矩表达、垂直向控制、橡皮筋/支抗钉和依从性。',
    '10. 如果 clinicalSupplement 中有用户补充的缺牙、替牙期、拔牙意向、主诉或限制条件，必须结合这些信息分析；未明确的信息不要自行假设。',
    '11. 输出纯文本，不要 Markdown 表格；使用中文序号和短段落。',
    '',
    '建议结构：',
    ...(AI_ANALYSIS_FAST_MODE
      ? [
          '一、总体判断',
          '二、关键指标证据',
          '三、临床风险与复核点',
          '四、拔牙或不拔牙倾向',
          '五、固定矫正注意事项',
          '六、隐形矫正注意事项',
          '七、综合小结',
        ]
      : [
          '一、总体判断',
          '二、骨性关系分析',
          '三、垂直向与生长型分析',
          '四、牙性代偿与咬合倾向',
          '五、软组织侧貌与美学提示',
          '六、多分析法一致性与矛盾点',
          '七、临床关注点与复核建议',
          '八、拔牙或不拔牙的倾向性建议',
          '九、固定矫正中的注意事项',
          '十、隐形矫正中的注意事项',
          '十一、综合小结',
        ]),
    '',
    '结构化报告数据：',
    reportJson,
  ].join('\n');
}

async function postAiChatCompletion(body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('timeout')), AI_ANALYSIS_TIMEOUT_MS);
  try {
    const response = await fetch(`${AI_ANALYSIS_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${AI_ANALYSIS_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const rawText = await response.text().catch(() => '');
    let payload = {};
    try {
      payload = rawText ? JSON.parse(rawText) : {};
    } catch {
      payload = { error: rawText.trim() };
    }
    if (!response.ok) {
      const message = payload?.error?.message || payload?.message || payload?.error || `AI analysis request failed (${response.status})`;
      const error = new Error(String(message));
      error.status = response.status;
      throw error;
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

function isRetriableAiAnalysisError(error) {
  const status = Number(error?.status || 0);
  const message = String(error?.message || error || '').toLowerCase();
  if (/cooling down|quota|insufficient|unauthorized|invalid api key|permission denied|forbidden/.test(message)) {
    return false;
  }
  if ([408, 425, 429, 500, 502, 503, 504].includes(status)) {
    return true;
  }
  return /stream error|internal_error|internal error|fetch failed|socket|econnreset|other side closed|empty reply|timeout|timed out|connect|network/.test(message);
}

function formatAiAnalysisUserError(error) {
  const message = String(error?.message || error || '');
  if (/cooling down|quota|insufficient/i.test(message)) {
    return '模型服务繁忙，请稍后再试。';
  }
  if (/timeout|timed out|AbortError/i.test(message)) {
    return '模型生成超时，请稍后再试。';
  }
  return '模型暂时没有返回可用结果，请稍后再试。';
}

async function postAiChatCompletionWithRetry(body) {
  let lastError = null;
  for (let attempt = 1; attempt <= AI_ANALYSIS_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await postAiChatCompletion(body);
    } catch (error) {
      lastError = error;
      const retriable = isRetriableAiAnalysisError(error);
      console.warn(`[HYFCeph Weixin] AI analysis request failed (${attempt}/${AI_ANALYSIS_RETRY_ATTEMPTS}): ${error instanceof Error ? error.message : String(error)}`);
      if (!retriable || attempt >= AI_ANALYSIS_RETRY_ATTEMPTS) {
        break;
      }
      await sleep(retryDelayMs(attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || 'AI analysis request failed'));
}

function extractAiCompletionContent(payload) {
  return String(
    payload?.choices?.[0]?.message?.content
    || payload?.choices?.[0]?.text
    || '',
  ).trim();
}

function describeEmptyAiCompletion(payload) {
  const choice = payload?.choices?.[0] || {};
  const message = choice?.message || {};
  return [
    `finish_reason=${choice?.finish_reason || '-'}`,
    `reasoningChars=${String(message?.reasoning_content || '').length}`,
    `contentChars=${String(message?.content || choice?.text || '').length}`,
  ].join(' ');
}

async function callAiAnalysisModel(resultPayload) {
  if (!isAiAnalysisConfigured()) {
    return {
      ok: false,
      skipped: true,
      reason: 'ai-analysis-not-configured',
    };
  }

  const messages = [
    {
      role: 'system',
      content: '你是资深正畸头影测量报告撰写助手，擅长把多分析法测量数据转成严谨、细致、可复核的中文临床辅助分析。',
    },
    {
      role: 'user',
      content: buildAiAnalysisPrompt(resultPayload),
    },
  ];
  const promptChars = messages.reduce((sum, message) => sum + String(message.content || '').length, 0);
  const startedAt = Date.now();
  console.log(`[HYFCeph Weixin] AI analysis request start model=${AI_ANALYSIS_MODEL} fast=${AI_ANALYSIS_FAST_MODE ? 'yes' : 'no'} promptChars=${promptChars} maxTokens=${AI_ANALYSIS_MAX_OUTPUT_TOKENS} timeoutMs=${AI_ANALYSIS_TIMEOUT_MS}`);
  const baseBody = {
    model: AI_ANALYSIS_MODEL,
    messages,
    temperature: 0.2,
    stream: false,
  };

  let payload;
  try {
    payload = await postAiChatCompletionWithRetry({
      ...baseBody,
      max_tokens: AI_ANALYSIS_MAX_OUTPUT_TOKENS,
    });
  } catch (error) {
    if (Number(error?.status) !== 400) {
      throw error;
    }
    payload = await postAiChatCompletionWithRetry({
      ...baseBody,
      max_completion_tokens: AI_ANALYSIS_MAX_OUTPUT_TOKENS,
    });
  }

  let content = extractAiCompletionContent(payload);
  if (!content && AI_ANALYSIS_IS_DEEPSEEK) {
    console.warn(`[HYFCeph Weixin] AI analysis returned empty content; retrying with larger DeepSeek budget (${describeEmptyAiCompletion(payload)})`);
    const retryMessages = messages.map((message, index) => index === messages.length - 1
      ? {
          ...message,
          content: `${message.content}\n\n重要：请直接输出最终 AI 综合分析正文，不要只输出推理过程；如果篇幅有限，优先保证正文完整。`,
        }
      : message);
    payload = await postAiChatCompletionWithRetry({
      ...baseBody,
      messages: retryMessages,
      max_tokens: Math.max(AI_ANALYSIS_MAX_OUTPUT_TOKENS, 4_096),
    });
    content = extractAiCompletionContent(payload);
  }
  if (!content) {
    throw new Error(`AI 模型未返回分析内容。${describeEmptyAiCompletion(payload)}`);
  }
  console.log(`[HYFCeph Weixin] AI analysis request done elapsedMs=${Date.now() - startedAt} outputChars=${content.length}`);
  return {
    ok: true,
    content,
    model: AI_ANALYSIS_MODEL,
  };
}

async function appendAiAnalysisToFeishuDocForUser({
  apiKey,
  documentId,
  analysisText,
}) {
  const payload = await fetchJsonWithRetry(`${PORTAL_BASE_URL}/api/report/feishu-doc-analysis`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({
      documentId,
      sectionTitle: 'AI 综合分析',
      analysisText,
    }),
    timeoutMs: PORTAL_REPORT_TIMEOUT_MS,
    label: 'portal feishu doc analysis append request',
  });
  return payload.feishuDoc || null;
}

async function measureImageForUser({ apiKey, media }) {
  void apiKey;
  const operatorSession = await fetchOperatorSessionForBot();
  if (!operatorSession?.token || !operatorSession?.pageUrl) {
    throw new Error('SmartCheck 会话暂不可用，请稍后再试。');
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
  console.log(`[HYFCeph Weixin] measuring file=${fileName} via fallback runner`);

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
  if (operatorSession.provider) {
    args.push('--provider', operatorSession.provider);
  }

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
      resultPayload: output.resultPayload || null,
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

async function measureSingleImageForUser({ apiKey, media }) {
  const tryPortal = async () => measureImageViaPortal({ apiKey, media });
  const tryLocal = async () => measureImageForUser({ apiKey, media });

  if (WEIXIN_MEASURE_MODE === 'local-only') {
    return await tryLocal();
  }
  if (WEIXIN_MEASURE_MODE === 'local-first') {
    try {
      return await tryLocal();
    } catch (error) {
      console.warn(`[HYFCeph Weixin] local image measurement failed, falling back to portal: ${error instanceof Error ? error.message : String(error)}`);
      return await tryPortal();
    }
  }

  try {
    return await tryPortal();
  } catch (error) {
    if (WEIXIN_MEASURE_MODE === 'portal-only') {
      throw error;
    }
    console.warn(`[HYFCeph Weixin] portal image measurement failed, falling back to direct runner: ${error instanceof Error ? error.message : String(error)}`);
    return await tryLocal();
  }
}

async function measureOverlapLocally({ apiKey, baseMedia, compareMedia, alignMode = 'SN' }) {
  const baseFileName = baseMedia.fileName || path.basename(baseMedia.filePath);
  const compareFileName = compareMedia.fileName || path.basename(compareMedia.filePath);
  console.log(`[HYFCeph Weixin] measuring overlap locally base=${baseFileName} compare=${compareFileName} align=${alignMode}`);
  const [baseOutput, compareOutput] = await Promise.all([
    measureImageForUser({ apiKey, media: baseMedia }),
    measureImageForUser({ apiKey, media: compareMedia }),
  ]);
  const overlap = buildOverlapRender({ baseOutput, compareOutput, alignMode });
  const rewrittenSvgText = rewriteOverlapSvgForWechat(overlap.svgText);
  const annotatedPngPath = await convertSvgTextToPngForWechat(rewrittenSvgText, 'hyfceph-overlap-local');
  const annotatedPngBuffer = annotatedPngPath
    ? await fs.readFile(annotatedPngPath).catch(() => null)
    : null;
  return {
    mode: 'overlap',
    analysis: overlap.analysis || null,
    summary: overlap.summary || null,
    metrics: overlap.metrics || [],
    artifacts: {
      annotatedSvgBase64: Buffer.from(rewrittenSvgText, 'utf8').toString('base64'),
      annotatedSvgMimeType: 'image/svg+xml',
      annotatedPngBase64: annotatedPngBuffer ? annotatedPngBuffer.toString('base64') : null,
      annotatedPngMimeType: annotatedPngBuffer ? 'image/png' : null,
    },
  };
}

async function measureOverlapViaPortal({ apiKey, baseMedia, compareMedia, alignMode = 'SN' }) {
  const [baseBuffer, compareBuffer] = await Promise.all([
    fs.readFile(baseMedia.filePath),
    fs.readFile(compareMedia.filePath),
  ]);
  const baseFileName = baseMedia.fileName || path.basename(baseMedia.filePath);
  const compareFileName = compareMedia.fileName || path.basename(compareMedia.filePath);
  const baseMimeType = inferMimeType(baseMedia.filePath, baseMedia.mimeType || 'application/octet-stream');
  const compareMimeType = inferMimeType(compareMedia.filePath, compareMedia.mimeType || 'application/octet-stream');
  console.log(`[HYFCeph Weixin] measuring overlap base=${baseFileName} compare=${compareFileName} align=${alignMode}`);
  const payload = await fetchJsonWithRetry(`${PORTAL_BASE_URL}/api/measure/overlap`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({
      baseFileName,
      baseMimeType,
      baseImageBase64: baseBuffer.toString('base64'),
      compareFileName,
      compareMimeType,
      compareImageBase64: compareBuffer.toString('base64'),
      alignMode,
      generateReport: false,
    }),
    compressBody: true,
    timeoutMs: PORTAL_MEASURE_TIMEOUT_MS,
    label: 'portal overlap measurement request',
  });
  return payload.result;
}

async function measureOverlapForUser({ apiKey, baseMedia, compareMedia, alignMode = 'SN' }) {
  const tryPortal = async () => measureOverlapViaPortal({ apiKey, baseMedia, compareMedia, alignMode });
  const tryLocal = async () => measureOverlapLocally({ apiKey, baseMedia, compareMedia, alignMode });

  if (WEIXIN_MEASURE_MODE === 'local-only') {
    return await tryLocal();
  }
  if (WEIXIN_MEASURE_MODE === 'local-first') {
    try {
      return await tryLocal();
    } catch (error) {
      console.warn(`[HYFCeph Weixin] local overlap measurement failed, falling back to portal: ${error instanceof Error ? error.message : String(error)}`);
      return await tryPortal();
    }
  }

  try {
    return await tryPortal();
  } catch (error) {
    if (WEIXIN_MEASURE_MODE === 'portal-only') {
      throw error;
    }
    console.warn(`[HYFCeph Weixin] portal overlap measurement failed, falling back to local runner: ${error instanceof Error ? error.message : String(error)}`);
    return await tryLocal();
  }
}

function inferReportType(resultPayload) {
  return String(resultPayload?.mode || '').trim().toLowerCase() === 'overlap' ? 'overlap' : 'image';
}

async function generateReportsForUser({ apiKey, resultPayload, patientName = '', reportType = inferReportType(resultPayload) }) {
  console.log('[HYFCeph Weixin] generating report links');
  const reportPayloadKey = String(resultPayload?.reportPayload?.objectKey || '').trim();
  if (reportPayloadKey) {
    const payload = await fetchJsonWithRetry(`${PORTAL_BASE_URL}/api/report/links`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({
        reportType,
        resultPayloadKey: reportPayloadKey,
        patientName,
      }),
      timeoutMs: PORTAL_REPORT_TIMEOUT_MS,
      label: 'portal report link issue request',
    });
    return {
      report: payload.report || null,
      prettyReport: payload.prettyReport || null,
      feishuDoc: payload.feishuDoc || null,
    };
  }
  const compactPayload = reportPayloadKey ? null : buildPortalReportPayload(resultPayload);
  const payload = await fetchJsonWithRetry(`${PORTAL_BASE_URL}/api/report/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({
      reportType,
      patientName,
      ...(reportPayloadKey ? { resultPayloadKey: reportPayloadKey } : { resultPayload: compactPayload }),
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
  const compactPayload = buildPortalReportPayload(resultPayload);
  const reportType = inferReportType(resultPayload);
  const payload = await fetchJsonWithRetry(`${PORTAL_BASE_URL}/api/report/payload`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({
      reportType,
      resultPayload: compactPayload,
    }),
    compressBody: true,
    timeoutMs: PORTAL_REPORT_TIMEOUT_MS,
    label: 'portal report payload upload request',
  });
  return payload.reportPayload || null;
}

async function generateFeishuDocForUser({ apiKey, resultPayload, prettyReportUrl = '', standardReportUrl = '', patientName = '', reportType = inferReportType(resultPayload) }) {
  console.log('[HYFCeph Weixin] generating feishu doc');
  const reportPayloadKey = String(resultPayload?.reportPayload?.objectKey || '').trim();
  const compactPayload = reportPayloadKey ? null : buildFeishuDocPayload(resultPayload);
  const payload = await fetchJsonWithRetry(`${PORTAL_BASE_URL}/api/report/feishu-doc`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({
      reportType,
      patientName,
      prettyReportUrl,
      standardReportUrl,
      ...(reportPayloadKey ? { resultPayloadKey: reportPayloadKey } : { resultPayload: compactPayload }),
    }),
    compressBody: !reportPayloadKey,
    timeoutMs: PORTAL_REPORT_TIMEOUT_MS,
    label: 'portal feishu doc generation request',
  });
  return payload.feishuDoc || null;
}

async function enrichResultForUser({ apiKey, result }) {
  try {
    const reportPayload = await promiseWithTimeout(
      ensureReportPayloadKey({
        apiKey,
        resultPayload: result,
      }),
      REPORT_PAYLOAD_SOFT_TIMEOUT_MS,
      `report payload upload timeout after ${REPORT_PAYLOAD_SOFT_TIMEOUT_MS}ms`,
    );
    if (reportPayload) {
      result.reportPayload = reportPayload;
    }
  } catch (error) {
    console.warn(`[HYFCeph Weixin] report payload upload skipped: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const reports = await promiseWithTimeout(
      generateReportsForUser({
        apiKey,
        resultPayload: result,
        patientName: result.patientName,
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

  try {
    const feishuDoc = await promiseWithTimeout(
      generateFeishuDocForUser({
        apiKey,
        resultPayload: result,
        prettyReportUrl: result?.prettyReport?.reportShareUrl || result?.prettyReport?.shortUrl || '',
        standardReportUrl: result?.report?.reportShareUrl || result?.report?.shortUrl || '',
        patientName: result.patientName,
      }),
      FEISHU_DOC_SOFT_TIMEOUT_MS,
      `feishu doc generation timeout after ${FEISHU_DOC_SOFT_TIMEOUT_MS}ms`,
    );
    if (feishuDoc) {
      result.feishuDoc = feishuDoc;
    }
  } catch (error) {
    console.warn(`[HYFCeph Weixin] feishu doc generation skipped: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!result.report && !result.prettyReport && !result.feishuDoc) {
    try {
      await sleep(1500);
      const reports = await promiseWithTimeout(
        generateReportsForUser({
          apiKey,
          resultPayload: result,
          patientName: result.patientName,
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
      console.warn(`[HYFCeph Weixin] delayed report generation skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      const feishuDoc = await promiseWithTimeout(
        generateFeishuDocForUser({
          apiKey,
          resultPayload: result,
          prettyReportUrl: result?.prettyReport?.reportShareUrl || result?.prettyReport?.shortUrl || '',
          standardReportUrl: result?.report?.reportShareUrl || result?.report?.shortUrl || '',
          patientName: result.patientName,
        }),
        FEISHU_DOC_SOFT_TIMEOUT_MS,
        `feishu doc generation timeout after ${FEISHU_DOC_SOFT_TIMEOUT_MS}ms`,
      );
      if (feishuDoc) {
        result.feishuDoc = feishuDoc;
      }
    } catch (error) {
      console.warn(`[HYFCeph Weixin] delayed feishu doc generation skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return result;
}

async function hydrateCachedReportsForUser({
  conversationId,
  apiKey,
  cached,
  reportSoftTimeoutMs = REPORT_GENERATION_SOFT_TIMEOUT_MS,
  feishuDocSoftTimeoutMs = FEISHU_DOC_SOFT_TIMEOUT_MS,
}) {
  if (!cached?.result) {
    return cached;
  }
  const workingResult = JSON.parse(JSON.stringify(cached.result));
  const patientName = normalizePatientName(workingResult?.patientName || '');

  try {
    const reportPayload = await promiseWithTimeout(
      ensureReportPayloadKey({
        apiKey,
        resultPayload: workingResult,
      }),
      REPORT_PAYLOAD_SOFT_TIMEOUT_MS,
      `report payload upload timeout after ${REPORT_PAYLOAD_SOFT_TIMEOUT_MS}ms`,
    );
    if (reportPayload) {
      workingResult.reportPayload = reportPayload;
    }
  } catch (error) {
    console.warn(`[HYFCeph Weixin] cached report payload upload skipped: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const reports = await promiseWithTimeout(
      generateReportsForUser({
        apiKey,
        resultPayload: workingResult,
        patientName,
      }),
      reportSoftTimeoutMs,
      `report generation timeout after ${reportSoftTimeoutMs}ms`,
    );
    if (reports.report) {
      workingResult.report = reports.report;
    }
    if (reports.prettyReport) {
      workingResult.prettyReport = reports.prettyReport;
    }
    if (reports.feishuDoc && !workingResult.feishuDoc) {
      workingResult.feishuDoc = reports.feishuDoc;
    }
  } catch (error) {
    console.warn(`[HYFCeph Weixin] cached report generation skipped: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const feishuDoc = await promiseWithTimeout(
      generateFeishuDocForUser({
        apiKey,
        resultPayload: workingResult,
        prettyReportUrl: workingResult?.prettyReport?.reportShareUrl || workingResult?.prettyReport?.shortUrl || '',
        standardReportUrl: workingResult?.report?.reportShareUrl || workingResult?.report?.shortUrl || '',
        patientName,
      }),
      feishuDocSoftTimeoutMs,
      `feishu doc generation timeout after ${feishuDocSoftTimeoutMs}ms`,
    );
    if (feishuDoc) {
      workingResult.feishuDoc = feishuDoc;
    }
  } catch (error) {
    console.warn(`[HYFCeph Weixin] cached feishu doc generation skipped: ${error instanceof Error ? error.message : String(error)}`);
  }

  latestResultCache[normalizeConversationKey(conversationId)] = {
    ...cached,
    updatedAt: new Date().toISOString(),
    result: workingResult,
  };
  await saveResultCache();
  await refreshCachedReportArtifacts(conversationId, cached, workingResult);
  return getLatestResultCache(conversationId) || cached;
}

async function markCachedFeishuAiAnalysis(conversationId, feishuDoc) {
  const key = normalizeConversationKey(conversationId);
  const current = latestResultCache[key];
  if (!current?.result) {
    return null;
  }
  const existingDoc = current.result.feishuDoc || {};
  const nextDoc = {
    ...existingDoc,
    ...feishuDoc,
    aiAnalysis: feishuDoc?.aiAnalysis || existingDoc.aiAnalysis || {
      ok: true,
      updatedAt: new Date().toISOString(),
    },
  };
  latestResultCache[key] = {
    ...current,
    updatedAt: new Date().toISOString(),
    result: {
      ...current.result,
      feishuDoc: nextDoc,
    },
  };
  await saveResultCache();
  return latestResultCache[key];
}

async function markPendingAiSupplement(conversationId, result) {
  const key = normalizeConversationKey(conversationId);
  const current = latestResultCache[key];
  const documentId = String(result?.feishuDoc?.documentId || '').trim();
  if (!current?.result || !documentId) {
    return null;
  }
  const previous = getPendingAiSupplement(conversationId);
  const pendingAiSupplement = previous || {
    documentId,
    docUrl: String(result?.feishuDoc?.docUrl || '').trim(),
    patientName: normalizePatientName(result?.patientName || '') || '匿名',
    requestedAt: new Date().toISOString(),
  };
  latestResultCache[key] = {
    ...current,
    updatedAt: new Date().toISOString(),
    pendingAiSupplement,
  };
  await saveResultCache();
  return {
    pendingAiSupplement,
    isNew: !previous,
  };
}

async function saveAiSupplementAnswer(conversationId, answerText) {
  const key = normalizeConversationKey(conversationId);
  const current = latestResultCache[key];
  if (!current?.result) {
    return null;
  }
  const aiSupplement = {
    source: 'weixin',
    rawText: String(answerText || '').trim().slice(0, 4000),
    normalizedText: normalizeAiSupplementText(answerText),
    answeredAt: new Date().toISOString(),
  };
  latestResultCache[key] = {
    ...current,
    updatedAt: new Date().toISOString(),
    pendingAiSupplement: null,
    result: {
      ...current.result,
      aiSupplement,
    },
  };
  await saveResultCache();
  return latestResultCache[key];
}

async function requestAiSupplementBeforeAnalysis({ request, conversationId }) {
  const cached = getLatestResultCache(conversationId);
  const result = cached?.result;
  const documentId = String(result?.feishuDoc?.documentId || '').trim();
  if (!result || !documentId || result?.feishuDoc?.aiAnalysis?.ok || result?.aiSupplement?.answeredAt) {
    return false;
  }
  const marked = await markPendingAiSupplement(conversationId, result);
  if (marked?.isNew) {
    await sendWeixinFollowUpText(request, buildAiSupplementQuestionText(result));
  }
  return true;
}

async function triggerDeferredFeishuAiAnalysis({
  request,
  apiKey,
  conversationId,
  force = false,
  notifyStart = true,
}) {
  if (!isAiAnalysisConfigured()) {
    return null;
  }
  if (!force && await requestAiSupplementBeforeAnalysis({ request, conversationId })) {
    return null;
  }
  const conversationKey = normalizeConversationKey(conversationId);
  if (pendingAiAnalysisFollowUps.has(conversationKey)) {
    return pendingAiAnalysisFollowUps.get(conversationKey);
  }

  const job = (async () => {
    try {
      const cached = getLatestResultCache(conversationId);
      const result = cached?.result;
      const documentId = String(result?.feishuDoc?.documentId || '').trim();
      const docUrl = String(result?.feishuDoc?.docUrl || '').trim();
      if (!result || !documentId || result?.feishuDoc?.aiAnalysis?.ok) {
        return;
      }
      if (!force && !result?.aiSupplement?.answeredAt) {
        await requestAiSupplementBeforeAnalysis({ request, conversationId });
        return;
      }

      console.log('[HYFCeph Weixin] generating AI analysis for feishu doc');
      if (notifyStart) {
        void sendWeixinFollowUpText(
          request,
          'AI 综合分析正在后台生成，完成后会自动写入飞书文档。',
        ).catch(() => {});
      }
      const aiResult = await callAiAnalysisModel(result);
      if (!aiResult?.ok || !aiResult.content) {
        console.warn(`[HYFCeph Weixin] AI analysis skipped: ${aiResult?.reason || 'no content'}`);
        return;
      }
      const feishuDoc = await appendAiAnalysisToFeishuDocForUser({
        apiKey,
        documentId,
        analysisText: aiResult.content,
      });
      const updatedDoc = {
        ...(feishuDoc || {}),
        documentId,
        docUrl: feishuDoc?.docUrl || docUrl,
        aiAnalysis: {
          ok: true,
          model: aiResult.model,
          updatedAt: new Date().toISOString(),
          lineCount: feishuDoc?.aiAnalysis?.lineCount || undefined,
        },
      };
      await markCachedFeishuAiAnalysis(conversationId, updatedDoc);
      await sendWeixinFollowUpText(
        request,
        `更多综合分析内容已经写入飞书文档：${updatedDoc.docUrl || docUrl}`,
      );
    } catch (error) {
      console.warn(`[HYFCeph Weixin] AI feishu analysis follow-up failed: ${error instanceof Error ? error.message : String(error)}`);
      void sendWeixinFollowUpText(
        request,
        `AI 综合分析暂时没有生成成功：${formatAiAnalysisUserError(error)}`,
      ).catch(() => {});
    } finally {
      pendingAiAnalysisFollowUps.delete(conversationKey);
    }
  })();

  pendingAiAnalysisFollowUps.set(conversationKey, job);
  return job;
}

async function triggerDeferredReportFollowUp({ request, apiKey, conversationId }) {
  const conversationKey = normalizeConversationKey(conversationId);
  if (pendingReportFollowUps.has(conversationKey)) {
    return pendingReportFollowUps.get(conversationKey);
  }
  const job = (async () => {
    try {
      const cached = getLatestResultCache(conversationId);
      if (!cached?.result || !hasMissingReportLinks(cached.result)) {
        return;
      }
      const hydrated = await hydrateCachedReportsForUser({
        conversationId,
        apiKey,
        cached,
        reportSoftTimeoutMs: REPORT_FOLLOW_UP_REPORT_TIMEOUT_MS,
        feishuDocSoftTimeoutMs: REPORT_FOLLOW_UP_FEISHU_TIMEOUT_MS,
      });
      const lines = collectReportLinkLines(hydrated?.result);
      if (!lines.length) {
        console.warn('[HYFCeph Weixin] deferred report follow-up skipped: no links generated');
        return;
      }
      await sendWeixinFollowUpText(request, [
        '这次的报告链接我补发给你：',
        ...lines,
      ].join('\n'));
      if (hydrated?.result?.feishuDoc?.documentId) {
        void triggerDeferredFeishuAiAnalysis({
          request,
          apiKey,
          conversationId,
        });
      }
    } catch (error) {
      console.warn(`[HYFCeph Weixin] deferred report follow-up failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      pendingReportFollowUps.delete(conversationKey);
    }
  })();
  pendingReportFollowUps.set(conversationKey, job);
  return job;
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
        if (isResetConversationText(text)) {
          const cleared = await resetConversationState(request.conversationId);
          return {
            text: cleared
              ? '已经帮你清空上一轮缓存了。现在直接发新的侧位片就可以重新开始。'
              : '当前没有需要清空的缓存。你现在直接发新的侧位片就可以开始。',
          };
        }

        if (hasPendingMeasurement(request.conversationId)) {
          const pendingEntry = getLatestResultCache(request.conversationId);
          if (isMeasurementCommandText(text) && !isSkipPatientNameText(text)) {
            const pending = normalizePendingMeasurement(pendingEntry?.pendingMeasurement);
            return {
              text: pending?.images?.length >= 2
                ? '我已经连续收到两张侧位片了，默认会做重叠图。先回复患者姓名；如果不想填写，直接回复“匿名”就可以，我再开始测量。'
                : '我已经收到侧位片了。先回复患者姓名；如果不想填写，直接回复“匿名”就可以，我再开始测量。',
            };
          }
          const patientName = isSkipPatientNameText(text) ? '' : normalizePatientName(text);
          if (!patientName && !isSkipPatientNameText(text)) {
            const pending = normalizePendingMeasurement(pendingEntry?.pendingMeasurement);
            return {
              text: pending?.images?.length >= 2
                ? '我已经连续收到两张侧位片了，默认会做重叠图。先告诉我患者姓名；如果不想填写，直接回复“匿名”就可以，我再开始测量。'
                : '我已经收到侧位片了。先告诉我患者姓名；如果不想填写，直接回复“匿名”就可以，我再开始测量。',
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

          const pendingMedia = normalizePendingMeasurement(pendingEntry?.pendingMeasurement);
          if (!pendingMedia?.images?.length) {
            return {
              text: '这次待测的侧位片缓存已经失效了，你再发一张新的侧位片给我就行。',
            };
          }

          try {
            const result = pendingMedia.images.length >= 2
              ? await measureOverlapForUser({
                  apiKey: portalUser.auth.apiKey,
                  baseMedia: pendingMedia.images[0],
                  compareMedia: pendingMedia.images[1],
                })
              : await measureSingleImageForUser({
                  apiKey: portalUser.auth.apiKey,
                  media: pendingMedia.images[0],
                });
            result.patientName = patientName || '匿名';
            await enrichResultForUser({
              apiKey: portalUser.auth.apiKey,
              result,
            });

            await updateLatestResultCache(request.conversationId, result, {
              sourceImagePath: pendingMedia.images[0]?.filePath || '',
            });
            await clearPendingMeasurement(request.conversationId);
            const cached = getLatestResultCache(request.conversationId);
            await notifyMeasurementCompleted({
              conversationId: request.conversationId,
              portalUser,
              result: cached?.result || result,
            });
            if (cached?.result && hasMissingReportLinks(cached.result)) {
              void triggerDeferredReportFollowUp({
                request,
                apiKey: portalUser.auth.apiKey,
                conversationId: request.conversationId,
              });
            }
            if (cached?.result?.feishuDoc?.documentId) {
              void triggerDeferredFeishuAiAnalysis({
                request,
                apiKey: portalUser.auth.apiKey,
                conversationId: request.conversationId,
              });
            }
            return {
              text: buildSummaryText(result),
              media: cached?.annotatedImagePath
                ? {
                    type: 'image',
                    url: cached.annotatedImagePath,
                    fileName: 'hyfceph-annotated.png',
                  }
                : undefined,
            };
          } catch (error) {
            return {
              text: `HYFCeph 处理失败：${toUserFacingPortalError(error)}`,
            };
          }
        }

        const shouldCaptureAiSupplement = hasPendingAiSupplement(request.conversationId)
          && (!text || !isMeasurementCommandText(text) || isAiSupplementSkipText(text));
        if (shouldCaptureAiSupplement) {
          const cached = getLatestResultCache(request.conversationId);
          if (!text) {
            return {
              text: buildAiSupplementQuestionText(cached?.result),
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

          await saveAiSupplementAnswer(request.conversationId, text);
          void triggerDeferredFeishuAiAnalysis({
            request,
            apiKey: portalUser.auth.apiKey,
            conversationId: request.conversationId,
            force: true,
            notifyStart: false,
          });
          return {
            text: '收到补充信息。AI 综合分析正在后台生成，完成后会自动写入刚才的飞书文档。',
          };
        }

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
          let hydrated = cached;
          const missingAnyLink = !cached.result?.report?.reportShareUrl
            || !cached.result?.prettyReport?.reportShareUrl
            || !cached.result?.feishuDoc?.docUrl;
          if (missingAnyLink) {
            try {
              const portalUser = await resolvePortalUser(request.conversationId);
              hydrated = await hydrateCachedReportsForUser({
                conversationId: request.conversationId,
                apiKey: portalUser.auth.apiKey,
                cached,
              });
              if (hydrated?.result?.feishuDoc?.documentId) {
                void triggerDeferredFeishuAiAnalysis({
                  request,
                  apiKey: portalUser.auth.apiKey,
                  conversationId: request.conversationId,
                });
              }
            } catch (error) {
              console.warn(`[HYFCeph Weixin] on-demand report hydration skipped: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
          const lines = collectReportLinkLines(hydrated?.result);
          return {
            text: lines.length ? lines.join('\n') : '最近一次测量还没有生成在线报告链接。',
          };
        }

        if (/标点图|标注图|标点|标注/.test(text) && cached.annotatedImagePath) {
          let latestAnnotated = cached;
          if (cached.result?.feishuDoc?.docUrl) {
            try {
              await refreshCachedReportArtifacts(request.conversationId, cached, cached.result);
              latestAnnotated = getLatestResultCache(request.conversationId) || cached;
            } catch (error) {
              console.warn(`[HYFCeph Weixin] annotated image QR refresh skipped: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
          return {
            text: '这是最近一次测量的标点图。',
            media: {
              type: 'image',
              url: latestAnnotated.annotatedImagePath || cached.annotatedImagePath,
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

      try {
        const pendingEntry = await setPendingMeasurement(request.conversationId, request.media);
        const pending = normalizePendingMeasurement(pendingEntry?.pendingMeasurement);
        await notifyImageReceived(request, pending);
        return {
          text: pending?.images?.length >= 2
            ? [
                '我已经连续收到两张侧位片了。',
                '这次我会默认按治疗前后重叠图来做。',
                '开始测量前，先告诉我患者姓名；如果不想填写，直接回复“匿名”就可以。',
              ].join('\n')
            : [
                '我已经收到这张侧位片了。',
                '如果你还想做重叠图，可以继续再发第二张侧位片；否则直接回复患者姓名就可以开始测量。',
                '如果不想填写姓名，直接回复“匿名”也可以。',
              ].join('\n'),
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
  const agent = await createRestrictedAgent();
  const runtimes = new Map();
  const shutdown = new AbortController();
  const handleShutdown = () => shutdown.abort();
  process.on('SIGINT', handleShutdown);
  process.on('SIGTERM', handleShutdown);

  try {
    while (!shutdown.signal.aborted) {
      try {
        await reconcileBotRuntimes(agent, runtimes);
      } catch (error) {
        console.error(`[HYFCeph Weixin] runtime reconcile failed: ${error instanceof Error ? error.stack || error.message : String(error)}`);
      }
      if (!shutdown.signal.aborted) {
        await sleep(BOT_CONFIG_REFRESH_MS);
      }
    }
  } finally {
    process.off('SIGINT', handleShutdown);
    process.off('SIGTERM', handleShutdown);
    await Promise.allSettled([...runtimes.values()].map((runtime) => stopRuntime(runtime, 'shutdown')));
  }
}

main().catch((error) => {
  console.error('[HYFCeph Weixin] failed:', error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
