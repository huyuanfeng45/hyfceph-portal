#!/usr/bin/env node

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const LABEL = 'com.hyf.hyfceph.weixin-bot';
const HOME_DIR = os.homedir();
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const BOT_SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'hyfceph-weixin-bot.mjs');
const CONFIG_DIR = path.join(HOME_DIR, 'Library', 'Application Support', 'HYFCeph');
const CONFIG_PATH = path.join(CONFIG_DIR, 'weixin-bot.json');
const LAUNCH_AGENTS_DIR = path.join(HOME_DIR, 'Library', 'LaunchAgents');
const PLIST_PATH = path.join(LAUNCH_AGENTS_DIR, `${LABEL}.plist`);
const LOG_DIR = path.join(HOME_DIR, 'Library', 'Logs', 'HYFCeph');
const STDOUT_LOG = path.join(LOG_DIR, 'weixin-bot.out.log');
const STDERR_LOG = path.join(LOG_DIR, 'weixin-bot.err.log');
const DEFAULT_PORTAL_BASE_URL = 'https://hyfceph.52ortho.com';
const PATH_VALUE = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith('--')) {
      continue;
    }
    const [flag, inlineValue] = current.split('=', 2);
    const next = inlineValue !== undefined ? inlineValue : argv[index + 1];
    switch (flag) {
      case '--portal-base-url':
        options.portalBaseUrl = next;
        if (inlineValue === undefined) index += 1;
        break;
      case '--api-key':
        options.portalApiKey = next;
        if (inlineValue === undefined) index += 1;
        break;
      case '--secret':
      case '--weixin-bot-secret':
        options.weixinBotSecret = next;
        if (inlineValue === undefined) index += 1;
        break;
      case '--openclaw-state-dir':
        options.openclawStateDir = next;
        if (inlineValue === undefined) index += 1;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      default:
        break;
    }
  }
  return options;
}

function renderPlist({ nodePath, configPath, openclawStateDir }) {
  const openclawEntry = openclawStateDir
    ? `\n    <key>OPENCLAW_STATE_DIR</key>\n    <string>${escapeXml(openclawStateDir)}</string>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodePath)}</string>
    <string>${escapeXml(BOT_SCRIPT_PATH)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(REPO_ROOT)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${PATH_VALUE}</string>
    <key>HOME</key>
    <string>${escapeXml(HOME_DIR)}</string>
    <key>HYFCEPH_WEIXIN_CONFIG_PATH</key>
    <string>${escapeXml(configPath)}</string>${openclawEntry}
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(STDOUT_LOG)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(STDERR_LOG)}</string>
</dict>
</plist>
`;
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function runLaunchctl(args, { allowFailure = false } = {}) {
  const result = spawnSync('/bin/launchctl', args, { encoding: 'utf8' });
  if (result.status !== 0 && !allowFailure) {
    const stderr = (result.stderr || result.stdout || '').trim();
    throw new Error(stderr || `launchctl ${args.join(' ')} 失败。`);
  }
  return result;
}

async function ensureFile(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const portalBaseUrl = String(
    args.portalBaseUrl
    || process.env.HYFCEPH_WEIXIN_PORTAL_BASE_URL
    || DEFAULT_PORTAL_BASE_URL,
  ).trim().replace(/\/+$/, '');
  const portalApiKey = String(
    args.portalApiKey
    || process.env.HYFCEPH_API_KEY
    || '',
  ).trim();
  const weixinBotSecret = String(
    args.weixinBotSecret
    || process.env.HYFCEPH_WEIXIN_BOT_SECRET
    || '',
  ).trim();
  const openclawStateDir = String(
    args.openclawStateDir
    || process.env.OPENCLAW_STATE_DIR
    || process.env.CLAWDBOT_STATE_DIR
    || '',
  ).trim();

  if (!weixinBotSecret && !portalApiKey) {
    throw new Error('缺少管理员 API Key 或微信 bot secret。请通过 --api-key / HYFCEPH_API_KEY，或 --secret / HYFCEPH_WEIXIN_BOT_SECRET 提供。');
  }

  const config = {
    portalBaseUrl,
    portalApiKey: portalApiKey || undefined,
    weixinBotSecret,
    openclawStateDir: openclawStateDir || undefined,
    updatedAt: new Date().toISOString(),
  };

  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.mkdir(LAUNCH_AGENTS_DIR, { recursive: true });
  await fs.mkdir(LOG_DIR, { recursive: true });
  await ensureFile(STDOUT_LOG);
  await ensureFile(STDERR_LOG);
  await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
  await fs.writeFile(
    PLIST_PATH,
    renderPlist({
      nodePath: process.execPath,
      configPath: CONFIG_PATH,
      openclawStateDir,
    }),
    'utf8',
  );

  if (args.dryRun) {
    console.log(JSON.stringify({
      ok: true,
      dryRun: true,
      label: LABEL,
      plistPath: PLIST_PATH,
      configPath: CONFIG_PATH,
      portalBaseUrl,
      stdoutLog: STDOUT_LOG,
      stderrLog: STDERR_LOG,
    }, null, 2));
    return;
  }

  const uid = spawnSync('/usr/bin/id', ['-u'], { encoding: 'utf8' }).stdout.trim();
  runLaunchctl(['bootout', `gui/${uid}`, PLIST_PATH], { allowFailure: true });
  runLaunchctl(['bootstrap', `gui/${uid}`, PLIST_PATH]);
  runLaunchctl(['enable', `gui/${uid}/${LABEL}`], { allowFailure: true });
  runLaunchctl(['kickstart', '-k', `gui/${uid}/${LABEL}`], { allowFailure: true });

  console.log([
    'HYFCeph 微信 bot 已安装为开机自启。',
    `launchd label: ${LABEL}`,
    `配置文件: ${CONFIG_PATH}`,
    `日志输出: ${STDOUT_LOG}`,
    `错误日志: ${STDERR_LOG}`,
    '',
    '可用命令：',
    `launchctl print gui/${uid}/${LABEL}`,
    `tail -f '${STDOUT_LOG}' '${STDERR_LOG}'`,
  ].join('\n'));
}

main().catch((error) => {
  console.error('[HYFCeph Weixin launchd install] failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
