#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SKILL_ROOT = path.join(__dirname, '..');
const VENV_DIR = path.join(SKILL_ROOT, '.venv');
const VENV_PYTHON = path.join(VENV_DIR, 'bin', 'python');
const CORE_SCRIPT = path.join(__dirname, 'ceph_autopoint.py');
const REQUIREMENTS_PATH = path.join(__dirname, 'requirements.txt');
const READY_SENTINEL = path.join(VENV_DIR, '.ready');

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function runOrFail(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: SKILL_ROOT,
    encoding: 'utf8',
    stdio: options.stdio || 'pipe',
    env: {
      ...process.env,
      ...options.env
    }
  });

  if (result.error) {
    fail(result.error.message);
  }

  if (result.status !== 0) {
    const stderr = result.stderr || '';
    const stdout = result.stdout || '';
    fail((stderr || stdout || `command failed: ${command}`).trim());
  }

  if (result.stdout) {
    process.stderr.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  return result;
}

function commandExists(command) {
  const result = spawnSync(command, ['--version'], {
    encoding: 'utf8',
    stdio: 'ignore'
  });
  return result.status === 0;
}

function findBootstrapPython() {
  const candidates = [
    process.env.CEPH_AUTOPOINT_BOOTSTRAP_PYTHON,
    '/opt/homebrew/bin/python3.12',
    '/Users/hyf/.local/bin/python3.12',
    'python3.12',
    'python3'
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate.includes('/')) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
      continue;
    }

    if (commandExists(candidate)) {
      return candidate;
    }
  }

  return '';
}

function runtimeReady() {
  if (!fs.existsSync(VENV_PYTHON) || !fs.existsSync(READY_SENTINEL)) {
    return false;
  }

  const probe = spawnSync(VENV_PYTHON, ['-c', 'import numpy, torch; from PIL import Image'], {
    encoding: 'utf8',
    stdio: 'ignore'
  });
  return probe.status === 0;
}

function ensureRuntime() {
  if (runtimeReady()) {
    return;
  }

  const bootstrapPython = findBootstrapPython();
  if (!bootstrapPython) {
    fail('No usable Python runtime found. Install python3.12 or set CEPH_AUTOPOINT_BOOTSTRAP_PYTHON.');
  }

  if (!fs.existsSync(VENV_PYTHON)) {
    process.stderr.write('Creating ceph-autopoint virtualenv...\n');
    runOrFail(bootstrapPython, ['-m', 'venv', VENV_DIR]);
  }

  process.stderr.write('Installing ceph-autopoint dependencies...\n');
  runOrFail(VENV_PYTHON, ['-m', 'pip', 'install', '--upgrade', 'pip']);
  runOrFail(VENV_PYTHON, ['-m', 'pip', 'install', '-r', REQUIREMENTS_PATH]);
  fs.writeFileSync(READY_SENTINEL, `${Date.now()}\n`);
}

function main() {
  ensureRuntime();

  const result = spawnSync(VENV_PYTHON, [CORE_SCRIPT, ...process.argv.slice(2)], {
    cwd: SKILL_ROOT,
    encoding: 'utf8',
    env: process.env
  });

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  if (result.error) {
    fail(result.error.message);
  }

  process.exit(result.status == null ? 1 : result.status);
}

main();
