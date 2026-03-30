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
const LOG_DIR = path.join(HOME_DIR, 'Library', 'Logs', 'HYFCeph');

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function runLaunchctlPrint(target) {
  const result = spawnSync('/bin/launchctl', ['print', target], { encoding: 'utf8' });
  return {
    ok: result.status === 0,
    output: (result.stdout || result.stderr || '').trim(),
  };
}

async function main() {
  const uid = spawnSync('/usr/bin/id', ['-u'], { encoding: 'utf8' }).stdout.trim();
  const target = `gui/${uid}/${LABEL}`;
  const [hasConfig, hasPlist] = await Promise.all([exists(CONFIG_PATH), exists(PLIST_PATH)]);
  const launchctl = runLaunchctlPrint(target);
  const summary = {
    label: LABEL,
    plistPath: PLIST_PATH,
    configPath: CONFIG_PATH,
    logDir: LOG_DIR,
    hasConfig,
    hasPlist,
    loaded: launchctl.ok,
    launchctlOutput: launchctl.output,
  };
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error('[HYFCeph Weixin launchd status] failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
