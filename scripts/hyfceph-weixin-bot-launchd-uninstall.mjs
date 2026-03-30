#!/usr/bin/env node

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const LABEL = 'com.hyf.hyfceph.weixin-bot';
const HOME_DIR = os.homedir();
const CONFIG_PATH = path.join(HOME_DIR, 'Library', 'Application Support', 'HYFCeph', 'weixin-bot.json');
const PLIST_PATH = path.join(HOME_DIR, 'Library', 'LaunchAgents', `${LABEL}.plist`);

function parseArgs(argv) {
  return {
    purgeConfig: argv.includes('--purge-config'),
  };
}

function runLaunchctl(args, { allowFailure = false } = {}) {
  const result = spawnSync('/bin/launchctl', args, { encoding: 'utf8' });
  if (result.status !== 0 && !allowFailure) {
    const stderr = (result.stderr || result.stdout || '').trim();
    throw new Error(stderr || `launchctl ${args.join(' ')} 失败。`);
  }
  return result;
}

async function removeIfExists(filePath) {
  await fs.rm(filePath, { force: true });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const uid = spawnSync('/usr/bin/id', ['-u'], { encoding: 'utf8' }).stdout.trim();

  runLaunchctl(['bootout', `gui/${uid}`, PLIST_PATH], { allowFailure: true });
  await removeIfExists(PLIST_PATH);
  if (args.purgeConfig) {
    await removeIfExists(CONFIG_PATH);
  }

  console.log([
    'HYFCeph 微信 bot 开机自启已移除。',
    `launchd label: ${LABEL}`,
    args.purgeConfig ? `配置文件也已删除：${CONFIG_PATH}` : `配置文件保留：${CONFIG_PATH}`,
  ].join('\n'));
}

main().catch((error) => {
  console.error('[HYFCeph Weixin launchd uninstall] failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
