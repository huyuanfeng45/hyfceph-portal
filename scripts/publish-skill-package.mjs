#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';

const DEFAULT_PACKAGE_NAME = 'HYFCeph-openclaw.zip';

function printHelp() {
  console.log(`Usage:
  node scripts/publish-skill-package.mjs --source /abs/path/to/HYFCeph-openclaw.zip

Options:
  --source <file>         Source skill zip file
  --name <filename>       Published filename, default: ${DEFAULT_PACKAGE_NAME}
  --public-dir <dir>      Public downloads directory, default: ./public/downloads
  --portal-base <url>     Optional portal base URL for printed link
  --help                  Show this help
`);
}

function formatBytes(value) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MB`;
}

async function ensureFile(filePath) {
  const stats = await fs.stat(filePath).catch(() => null);
  if (!stats || !stats.isFile()) {
    throw new Error(`Source file not found: ${filePath}`);
  }
  return stats;
}

async function main() {
  const { values } = parseArgs({
    options: {
      source: { type: 'string' },
      name: { type: 'string', default: DEFAULT_PACKAGE_NAME },
      'public-dir': { type: 'string' },
      'portal-base': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    printHelp();
    return;
  }

  const source = String(values.source || process.env.HYFCEPH_SKILL_PACKAGE || '').trim();
  if (!source) {
    printHelp();
    throw new Error('Missing --source. Please provide the latest HYFCeph skill zip path.');
  }

  const sourcePath = path.resolve(source);
  const sourceStats = await ensureFile(sourcePath);
  const publicDir = path.resolve(values['public-dir'] || path.join(process.cwd(), 'public', 'downloads'));
  const fileName = path.basename(String(values.name || DEFAULT_PACKAGE_NAME).trim() || DEFAULT_PACKAGE_NAME);
  const targetPath = path.join(publicDir, fileName);
  const metadataPath = path.join(publicDir, 'skill-package.json');
  const fileBuffer = await fs.readFile(sourcePath);
  const sha256 = createHash('sha256').update(fileBuffer).digest('hex');
  const publishedAt = new Date().toISOString();

  await fs.mkdir(publicDir, { recursive: true });
  await fs.writeFile(targetPath, fileBuffer);

  const metadata = {
    name: fileName,
    path: `/downloads/${fileName}`,
    publishedAt,
    sizeBytes: sourceStats.size,
    sizeText: formatBytes(sourceStats.size),
    sha256,
  };
  await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

  const portalBase = String(values['portal-base'] || process.env.HYFCEPH_PORTAL_BASE_URL || '').trim();
  const directUrl = portalBase
    ? `${portalBase.replace(/\/+$/, '')}${metadata.path}`
    : metadata.path;

  console.log(JSON.stringify({
    targetPath,
    metadataPath,
    directUrl,
    sizeBytes: metadata.sizeBytes,
    sha256: metadata.sha256,
    publishedAt,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
