#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { start as startWeixinBot } from 'weixin-agent-sdk';

const PORTAL_BASE_URL = (process.env.HYFCEPH_WEIXIN_PORTAL_BASE_URL || 'http://127.0.0.1:3077').replace(/\/+$/, '');
const WEIXIN_BOT_SECRET = String(process.env.HYFCEPH_WEIXIN_BOT_SECRET || '').trim();
const OPENCLAW_STATE_DIR = process.env.OPENCLAW_STATE_DIR?.trim()
  || process.env.CLAWDBOT_STATE_DIR?.trim()
  || path.join(os.homedir(), '.openclaw');
const OPENCLAW_WEIXIN_DIR = path.join(OPENCLAW_STATE_DIR, 'openclaw-weixin');
const OPENCLAW_WEIXIN_ACCOUNTS_DIR = path.join(OPENCLAW_WEIXIN_DIR, 'accounts');
const MEDIA_OUT_DIR = path.join(os.tmpdir(), 'hyfceph-weixin-bot');

if (!WEIXIN_BOT_SECRET) {
  throw new Error('缺少 HYFCEPH_WEIXIN_BOT_SECRET，无法启动微信 bot 服务。');
}

function normalizeAccountId(raw) {
  return String(raw || '').trim().toLowerCase().replace(/[@.]/g, '-');
}

async function requestJson(url, { method = 'GET', headers = {}, body } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-hyfceph-weixin-secret': WEIXIN_BOT_SECRET,
      ...headers,
    },
    body,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `请求失败（${response.status}）。`);
  }
  return payload;
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

async function measureImageForUser({ apiKey, media }) {
  const fileBuffer = await fs.readFile(media.filePath);
  const payload = await fetch(`${PORTAL_BASE_URL}/api/measure/image`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({
      fileName: media.fileName || path.basename(media.filePath),
      mimeType: media.mimeType || 'application/octet-stream',
      imageBase64: fileBuffer.toString('base64'),
      generateReport: true,
    }),
  });
  const result = await payload.json().catch(() => ({}));
  if (!payload.ok) {
    throw new Error(result.error || '测量失败。');
  }
  return result.result;
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
          text: `HYFCeph 处理失败：${error instanceof Error ? error.message : String(error)}`,
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
