#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const STORE_BLOB_PATH = process.env.HYFCEPH_STORE_BLOB_PATH || 'hyfceph/users.json';
const FEISHU_APP_ID = process.env.HYFCEPH_FEISHU_APP_ID || '';
const FEISHU_APP_SECRET = process.env.HYFCEPH_FEISHU_APP_SECRET || '';
const FEISHU_BITABLE_APP_TOKEN = process.env.HYFCEPH_FEISHU_BITABLE_APP_TOKEN || '';
const FEISHU_BITABLE_TABLE_ID = process.env.HYFCEPH_FEISHU_BITABLE_TABLE_ID || '';
const FEISHU_STORE_KEY = process.env.HYFCEPH_FEISHU_STORE_KEY || 'hyfceph-store';
const FEISHU_API_BASE = (process.env.HYFCEPH_FEISHU_API_BASE || 'https://open.feishu.cn/open-apis').replace(/\/+$/, '');
const FEISHU_STORE_PAYLOAD_FIELD = process.env.HYFCEPH_FEISHU_STORE_PAYLOAD_FIELD || 'payload';
const FEISHU_STORE_UPDATED_AT_FIELD = process.env.HYFCEPH_FEISHU_STORE_UPDATED_AT_FIELD || 'updated_at';
const FEISHU_STORE_KIND_FIELD = process.env.HYFCEPH_FEISHU_STORE_KIND_FIELD || 'kind';
const FEISHU_STORE_KIND_LABEL_FIELD = process.env.HYFCEPH_FEISHU_STORE_KIND_LABEL_FIELD || 'kind_label';
const FEISHU_STORE_SUMMARY_FIELD = process.env.HYFCEPH_FEISHU_STORE_SUMMARY_FIELD || 'summary';

let feishuTokenCache = null;
let feishuSchemaCache = null;
const FEISHU_ROW_KIND_USER = 'user';
const FEISHU_ROW_KIND_OPERATOR_SESSION = 'operator_session';
const FEISHU_ROW_KIND_PDF_LINK = 'pdf_link';
const FEISHU_ROW_KIND_REPORT_LINK = 'report_link';
const FEISHU_ROW_KIND_WEIXIN_BOT = 'weixin_bot';
const FEISHU_ROW_KIND_WEIXIN_BINDING_SESSION = 'weixin_binding_session';
const FEISHU_MANAGED_ROW_PREFIXES = [
  `${FEISHU_ROW_KIND_USER}:`,
  `${FEISHU_ROW_KIND_OPERATOR_SESSION}:`,
  `${FEISHU_ROW_KIND_PDF_LINK}:`,
  `${FEISHU_ROW_KIND_REPORT_LINK}:`,
  `${FEISHU_ROW_KIND_WEIXIN_BOT}:`,
  `${FEISHU_ROW_KIND_WEIXIN_BINDING_SESSION}:`,
];

function parseArgs(argv) {
  const options = {
    from: '',
    to: '',
    file: '',
    out: '',
    mode: 'merge',
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith('--')) {
      continue;
    }
    const [flag, inlineValue] = current.split('=', 2);
    const next = inlineValue !== undefined ? inlineValue : argv[index + 1];
    switch (flag) {
      case '--from':
        options.from = next;
        if (inlineValue === undefined) index += 1;
        break;
      case '--to':
        options.to = next;
        if (inlineValue === undefined) index += 1;
        break;
      case '--file':
        options.file = next;
        if (inlineValue === undefined) index += 1;
        break;
      case '--out':
        options.out = next;
        if (inlineValue === undefined) index += 1;
        break;
      case '--mode':
        options.mode = next;
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

function nowIso() {
  return new Date().toISOString();
}

function normalizePhone(value) {
  return String(value || '').replace(/[^\d+]/g, '');
}

function normalizeStoreShape(store) {
  const source = store && typeof store === 'object' ? store : {};
  return {
    users: Array.isArray(source.users) ? source.users : [],
    operatorSession: source.operatorSession || null,
    pdfLinks: source.pdfLinks && typeof source.pdfLinks === 'object' ? source.pdfLinks : {},
    reportLinks: source.reportLinks && typeof source.reportLinks === 'object' ? source.reportLinks : {},
    weixinBot: source.weixinBot || null,
    weixinBindingSessions: source.weixinBindingSessions && typeof source.weixinBindingSessions === 'object' ? source.weixinBindingSessions : {},
  };
}

function userMergeKey(user) {
  const phone = normalizePhone(user?.phone || '');
  const username = String(user?.username || '').trim().toLowerCase();
  const id = String(user?.id || '').trim();
  return id || `username:${username}` || `phone:${phone}`;
}

function mergeStores(targetStore, sourceStore) {
  const target = normalizeStoreShape(targetStore);
  const source = normalizeStoreShape(sourceStore);
  const mergedUsers = new Map();

  for (const user of target.users) {
    const key = userMergeKey(user);
    if (key) {
      mergedUsers.set(key, user);
    }
  }
  for (const user of source.users) {
    const key = userMergeKey(user);
    if (key) {
      mergedUsers.set(key, {
        ...mergedUsers.get(key),
        ...user,
      });
    }
  }

  return {
    users: Array.from(mergedUsers.values()),
    operatorSession: source.operatorSession || target.operatorSession || null,
    pdfLinks: {
      ...target.pdfLinks,
      ...source.pdfLinks,
    },
    reportLinks: {
      ...target.reportLinks,
      ...source.reportLinks,
    },
    weixinBot: source.weixinBot || target.weixinBot || null,
    weixinBindingSessions: {
      ...target.weixinBindingSessions,
      ...source.weixinBindingSessions,
    },
  };
}

async function readJsonFile(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

async function writeJsonFile(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readStoreFromBlob() {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    throw new Error('缺少 BLOB_READ_WRITE_TOKEN，无法从 Blob 读取旧数据。');
  }
  const { get } = await import('@vercel/blob');
  const result = await get(STORE_BLOB_PATH, {
    access: 'private',
    useCache: false,
    token,
  });
  if (!result?.stream) {
    return normalizeStoreShape({ users: [] });
  }
  const raw = await new Response(result.stream).text();
  return normalizeStoreShape(raw.trim() ? JSON.parse(raw) : { users: [] });
}

async function getFeishuAppAccessToken() {
  if (!FEISHU_APP_ID || !FEISHU_APP_SECRET || !FEISHU_BITABLE_APP_TOKEN || !FEISHU_BITABLE_TABLE_ID) {
    throw new Error('飞书多维表格环境变量不完整。');
  }
  if (feishuTokenCache && feishuTokenCache.expiresAt > Date.now() + 60_000) {
    return feishuTokenCache.token;
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
  feishuTokenCache = {
    token: String(payload.app_access_token),
    expiresAt: Date.now() + Math.max(300, expireSeconds) * 1000,
  };
  return feishuTokenCache.token;
}

async function callFeishuApi(method, apiPath, body = null) {
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
  return typeof value === 'string' ? value : '';
}

async function ensureFeishuSchema() {
  if (feishuSchemaCache) {
    return feishuSchemaCache;
  }
  const basePath = `/bitable/v1/apps/${encodeURIComponent(FEISHU_BITABLE_APP_TOKEN)}/tables/${encodeURIComponent(FEISHU_BITABLE_TABLE_ID)}`;
  const fieldsData = await callFeishuApi('GET', `${basePath}/fields?page_size=100`);
  const items = Array.isArray(fieldsData.items) ? fieldsData.items : [];
  const primaryField = items.find((field) => field?.is_primary);
  if (!primaryField?.field_name) {
    throw new Error('飞书多维表格缺少主字段。');
  }

  const fieldNames = new Set(items.map((field) => String(field?.field_name || '').trim()).filter(Boolean));
  for (const fieldName of [FEISHU_STORE_PAYLOAD_FIELD, FEISHU_STORE_UPDATED_AT_FIELD, FEISHU_STORE_KIND_FIELD, FEISHU_STORE_KIND_LABEL_FIELD, FEISHU_STORE_SUMMARY_FIELD]) {
    if (!fieldNames.has(fieldName)) {
      await callFeishuApi('POST', `${basePath}/fields`, {
        field_name: fieldName,
        type: 1,
      });
      fieldNames.add(fieldName);
    }
  }

  feishuSchemaCache = {
    basePath,
    primaryFieldName: primaryField.field_name,
    payloadFieldName: FEISHU_STORE_PAYLOAD_FIELD,
    updatedAtFieldName: FEISHU_STORE_UPDATED_AT_FIELD,
    kindFieldName: FEISHU_STORE_KIND_FIELD,
    kindLabelFieldName: FEISHU_STORE_KIND_LABEL_FIELD,
    summaryFieldName: FEISHU_STORE_SUMMARY_FIELD,
  };
  return feishuSchemaCache;
}

async function findFeishuStoreRecord(schema) {
  const result = await callFeishuApi('POST', `${schema.basePath}/records/search`, {
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
      FEISHU_ROW_KIND_OPERATOR_SESSION,
      FEISHU_ROW_KIND_PDF_LINK,
      FEISHU_ROW_KIND_REPORT_LINK,
      FEISHU_ROW_KIND_WEIXIN_BOT,
      FEISHU_ROW_KIND_WEIXIN_BINDING_SESSION,
    ].includes(inferredKind);
}

function parseFeishuPayload(value) {
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

async function listFeishuRecords(schema) {
  const items = [];
  const seenTokens = new Set();
  let pageToken = '';

  while (true) {
    const query = new URLSearchParams({ page_size: '500' });
    if (pageToken) {
      query.set('page_token', pageToken);
    }
    const result = await callFeishuApi('GET', `${schema.basePath}/records?${query.toString()}`);
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

function buildFeishuRows(store) {
  const normalized = normalizeStoreShape(store);
  const rows = [];

  for (const user of normalized.users) {
    rows.push({
      key: buildFeishuStoreRowKey(FEISHU_ROW_KIND_USER, user.id),
      kind: FEISHU_ROW_KIND_USER,
      payload: user,
      updatedAt: user.updatedAt || nowIso(),
    });
  }

  if (normalized.operatorSession) {
    rows.push({
      key: buildFeishuStoreRowKey(FEISHU_ROW_KIND_OPERATOR_SESSION),
      kind: FEISHU_ROW_KIND_OPERATOR_SESSION,
      payload: normalized.operatorSession,
      updatedAt: normalized.operatorSession.updatedAt || normalized.operatorSession.syncedAt || nowIso(),
    });
  }

  if (normalized.weixinBot) {
    rows.push({
      key: buildFeishuStoreRowKey(FEISHU_ROW_KIND_WEIXIN_BOT),
      kind: FEISHU_ROW_KIND_WEIXIN_BOT,
      payload: normalized.weixinBot,
      updatedAt: normalized.weixinBot.updatedAt || nowIso(),
    });
  }

  for (const record of Object.values(normalized.pdfLinks || {})) {
    rows.push({
      key: buildFeishuStoreRowKey(FEISHU_ROW_KIND_PDF_LINK, record.code),
      kind: FEISHU_ROW_KIND_PDF_LINK,
      payload: record,
      updatedAt: record.updatedAt || nowIso(),
    });
  }

  for (const record of Object.values(normalized.reportLinks || {})) {
    rows.push({
      key: buildFeishuStoreRowKey(FEISHU_ROW_KIND_REPORT_LINK, record.code),
      kind: FEISHU_ROW_KIND_REPORT_LINK,
      payload: record,
      updatedAt: record.updatedAt || nowIso(),
    });
  }

  for (const record of Object.values(normalized.weixinBindingSessions || {})) {
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
  const users = [];
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
    const payload = parseFeishuPayload(record.fields?.[schema.payloadFieldName]);
    if (!payload) {
      continue;
    }

    if (primaryKey === FEISHU_STORE_KEY) {
      legacyStore = normalizeStoreShape(payload);
      continue;
    }

    if (kind === FEISHU_ROW_KIND_USER) {
      users.push(payload);
      continue;
    }

    if (kind === FEISHU_ROW_KIND_OPERATOR_SESSION) {
      operatorSession = payload;
      continue;
    }

    if (kind === FEISHU_ROW_KIND_WEIXIN_BOT) {
      weixinBot = payload;
      continue;
    }

    if (kind === FEISHU_ROW_KIND_PDF_LINK && payload.code) {
      pdfLinks[payload.code] = payload;
      continue;
    }

    if (kind === FEISHU_ROW_KIND_REPORT_LINK && payload.code) {
      reportLinks[payload.code] = payload;
      continue;
    }

    if (kind === FEISHU_ROW_KIND_WEIXIN_BINDING_SESSION && payload.sessionKey) {
      weixinBindingSessions[payload.sessionKey] = payload;
    }
  }

  const rowBasedStore = normalizeStoreShape({
    users,
    operatorSession,
    pdfLinks,
    reportLinks,
    weixinBot,
    weixinBindingSessions,
  });

  const hasRowBasedData = rowBasedStore.users.length > 0
    || Boolean(rowBasedStore.operatorSession)
    || Boolean(rowBasedStore.weixinBot)
    || Object.keys(rowBasedStore.pdfLinks).length > 0
    || Object.keys(rowBasedStore.reportLinks).length > 0
    || Object.keys(rowBasedStore.weixinBindingSessions).length > 0;

  return hasRowBasedData ? rowBasedStore : normalizeStoreShape(legacyStore || { users: [] });
}

async function readStoreFromFeishu() {
  const schema = await ensureFeishuSchema();
  const records = await listFeishuRecords(schema);
  return buildStoreFromFeishuRows(records, schema);
}

async function writeStoreToFeishu(store) {
  const schema = await ensureFeishuSchema();
  const existingRecords = await listFeishuRecords(schema);
  const existingByKey = new Map();
  for (const record of existingRecords) {
    const primaryKey = readFeishuCellText(record.fields?.[schema.primaryFieldName]).trim();
    if (primaryKey) {
      existingByKey.set(primaryKey, record);
    }
  }

  const desiredRows = buildFeishuRows(store);
  const desiredKeys = new Set(desiredRows.map((row) => row.key));

  for (const row of desiredRows) {
    const fields = {
      [schema.primaryFieldName]: row.key,
      [schema.kindFieldName]: row.kind,
      [schema.kindLabelFieldName]: getFeishuStoreKindLabel(row.kind),
      [schema.summaryFieldName]: buildFeishuStoreSummary(row.kind, row.payload),
      [schema.payloadFieldName]: JSON.stringify(row.payload, null, 2),
      [schema.updatedAtFieldName]: row.updatedAt || nowIso(),
    };
    const existing = existingByKey.get(row.key);
    if (existing?.record_id) {
      await callFeishuApi('PUT', `${schema.basePath}/records/${encodeURIComponent(existing.record_id)}`, {
        fields,
      });
      continue;
    }
    await callFeishuApi('POST', `${schema.basePath}/records`, { fields });
  }

  for (const record of existingRecords) {
    const primaryKey = readFeishuCellText(record.fields?.[schema.primaryFieldName]).trim();
    const kind = readFeishuCellText(record.fields?.[schema.kindFieldName]).trim();
    if (!record?.record_id || !isManagedFeishuStoreRow(primaryKey, kind) || desiredKeys.has(primaryKey)) {
      continue;
    }
    await callFeishuApi('DELETE', `${schema.basePath}/records/${encodeURIComponent(record.record_id)}`);
  }
}

async function readSource(options) {
  if (options.from === 'blob') {
    return readStoreFromBlob();
  }
  if (options.from === 'file') {
    if (!options.file) {
      throw new Error('使用 --from file 时必须提供 --file。');
    }
    return normalizeStoreShape(await readJsonFile(options.file));
  }
  if (options.from === 'feishu-bitable' || options.from === 'feishu') {
    return readStoreFromFeishu();
  }
  throw new Error('不支持的来源。可选：blob、file、feishu-bitable');
}

async function readTargetForMerge(options) {
  if (options.mode !== 'merge') {
    return normalizeStoreShape({ users: [] });
  }
  if (options.to === 'file') {
    if (!options.out) {
      return normalizeStoreShape({ users: [] });
    }
    try {
      return normalizeStoreShape(await readJsonFile(options.out));
    } catch {
      return normalizeStoreShape({ users: [] });
    }
  }
  if (options.to === 'feishu-bitable' || options.to === 'feishu') {
    return readStoreFromFeishu();
  }
  throw new Error('不支持的目标。可选：file、feishu-bitable');
}

async function writeTarget(options, store) {
  if (options.to === 'file') {
    if (!options.out) {
      throw new Error('使用 --to file 时必须提供 --out。');
    }
    await writeJsonFile(options.out, store);
    return;
  }
  if (options.to === 'feishu-bitable' || options.to === 'feishu') {
    await writeStoreToFeishu(store);
    return;
  }
  throw new Error('不支持的目标。可选：file、feishu-bitable');
}

function summarize(store) {
  const normalized = normalizeStoreShape(store);
  return {
    users: normalized.users.length,
    activeApiKeys: normalized.users.filter((user) => user.apiKey && user.apiKeyExpiresAt).length,
    weixinBindings: normalized.users.filter((user) => user.weixinBinding?.weixinUserId).length,
    pdfLinks: Object.keys(normalized.pdfLinks || {}).length,
    reportLinks: Object.keys(normalized.reportLinks || {}).length,
    weixinBindingSessions: Object.keys(normalized.weixinBindingSessions || {}).length,
    hasOperatorSession: Boolean(normalized.operatorSession),
    hasWeixinBot: Boolean(normalized.weixinBot),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.from || !options.to) {
    throw new Error('用法：--from blob|file|feishu-bitable --to file|feishu-bitable [--file path] [--out path] [--mode merge|replace] [--dry-run]');
  }

  const sourceStore = await readSource(options);
  const targetStore = await readTargetForMerge(options);
  const finalStore = options.mode === 'replace'
    ? normalizeStoreShape(sourceStore)
    : mergeStores(targetStore, sourceStore);

  if (options.dryRun) {
    console.log(JSON.stringify({
      ok: true,
      dryRun: true,
      from: options.from,
      to: options.to,
      mode: options.mode,
      source: summarize(sourceStore),
      targetBefore: summarize(targetStore),
      targetAfter: summarize(finalStore),
    }, null, 2));
    return;
  }

  await writeTarget(options, finalStore);
  console.log(JSON.stringify({
    ok: true,
    from: options.from,
    to: options.to,
    mode: options.mode,
    source: summarize(sourceStore),
    targetAfter: summarize(finalStore),
  }, null, 2));
}

main().catch((error) => {
  console.error('[HYFCeph store migrate] failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
