#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { start as startWeixinBot } from './vendor/weixin-agent-sdk-hyf.mjs';

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), 'Library', 'Application Support', 'HYFCeph', 'weixin-bot.json');
const WEIXIN_CONFIG_PATH = process.env.HYFCEPH_WEIXIN_CONFIG_PATH?.trim() || DEFAULT_CONFIG_PATH;
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
const PORTAL_RETRY_ATTEMPTS = 3;
const PORTAL_RETRY_DELAY_MS = 1_500;

function normalizeAccountId(raw) {
  return String(raw || '').trim().toLowerCase().replace(/[@.]/g, '-');
}

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

function isRetriableStatus(status) {
  return [408, 425, 429, 500, 502, 503, 504].includes(Number(status));
}

function isTransientFetchError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  const causeMessage = String(error?.cause?.message || '').toLowerCase();
  return /fetch failed|socket|econnreset|other side closed|empty reply|timeout|timed out|connect|network/.test(`${message} ${causeMessage}`);
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
  timeoutMs = PORTAL_RESOLVE_TIMEOUT_MS,
  label = 'request',
  attempts = PORTAL_RETRY_ATTEMPTS,
} = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
    try {
      const response = await fetch(url, {
        method,
        headers,
        body,
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
      await sleep(PORTAL_RETRY_DELAY_MS * attempt);
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

  if (result?.report?.shortUrl) {
    lines.push('', `在线报告链接：${result.report.shortUrl}`);
  }
  if (result?.prettyReport?.shortUrl) {
    lines.push(`美化报告链接：${result.prettyReport.shortUrl}`);
  }

  lines.push('', '如需继续，请直接再发一张侧位片。这个微信入口只处理 HYFCeph 测量，不提供普通聊天。');
  return lines.join('\n');
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
    }),
    timeoutMs: PORTAL_MEASURE_TIMEOUT_MS,
    label: 'portal image measurement request',
  });
  return payload.result;
}

async function generateReportsForUser({ apiKey, resultPayload }) {
  console.log('[HYFCeph Weixin] generating report links');
  const payload = await fetchJsonWithRetry(`${PORTAL_BASE_URL}/api/report/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({
      reportType: 'image',
      resultPayload,
    }),
    timeoutMs: PORTAL_REPORT_TIMEOUT_MS,
    label: 'portal html report generation request',
  });
  return {
    report: payload.report || null,
    prettyReport: payload.prettyReport || null,
  };
}

function buildUnsupportedText() {
  return [
    '这个微信入口只支持 HYFCeph 侧位片测量。',
    '请直接发送一张头影侧位片；如果还没绑定，请先回到门户完成微信绑定。',
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
            ].join('\n'),
          };
        }
        return {
          text: buildUnsupportedText(),
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
          const reports = await generateReportsForUser({
            apiKey: portalUser.auth.apiKey,
            resultPayload: result,
          });
          if (reports.report) {
            result.report = reports.report;
          }
          if (reports.prettyReport) {
            result.prettyReport = reports.prettyReport;
          }
        } catch (error) {
          console.warn(`[HYFCeph Weixin] report generation skipped: ${error instanceof Error ? error.message : String(error)}`);
        }
        const pngBase64 = result?.artifacts?.annotatedPngBase64 || '';
        const pngMimeType = result?.artifacts?.annotatedPngMimeType || 'image/png';
        const mediaReply = pngBase64
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
