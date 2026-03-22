const DEFAULT_PORTAL_BASE_URL = 'https://hyfceph.52ortho.com/';
const DEFAULT_AUTO_REFRESH_ENABLED = true;
const DEFAULT_AUTO_REFRESH_MINUTES = 10;
const MIN_AUTO_REFRESH_MINUTES = 1;
const MAX_AUTO_REFRESH_MINUTES = 240;
const AUTO_REFRESH_ALARM = 'hyfceph:auto-refresh';
const AUTO_SYNC_DELAY_MS = 1500;
const TAB_SYNC_MAX_ATTEMPTS = 3;
const TAB_SYNC_RETRY_MS = 1200;
const BARK_BASE_URL = 'https://api.day.app';
const BARK_DEVICE_KEY = '7ffBf7F85e3WbFyKrJTEcH';
const ALERT_COOLDOWN_MS = 10 * 60 * 1000;
const STORAGE_KEYS = {
  portalBaseUrl: 'hyfceph_portal_base_url',
  operatorApiKey: 'hyfceph_operator_api_key',
  autoRefreshEnabled: 'hyfceph_auto_refresh_enabled',
  autoRefreshMinutes: 'hyfceph_auto_refresh_minutes',
  lastStatus: 'hyfceph_last_status',
  lastPayload: 'hyfceph_last_payload',
  lastAlert: 'hyfceph_last_bark_alert',
};
const SUPPORTED_URL_PATTERN = /^https:\/\/pd\.aiyayi\.com\/latera\//i;
const SUPPORTED_TAB_PATTERNS = ['https://pd.aiyayi.com/latera/*'];

function ensureTrailingSlash(value) {
  return value.endsWith('/') ? value : `${value}/`;
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeAutoRefreshMinutes(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_AUTO_REFRESH_MINUTES;
  }
  return Math.min(MAX_AUTO_REFRESH_MINUTES, Math.max(MIN_AUTO_REFRESH_MINUTES, Math.round(numeric)));
}

async function getStoredConfig() {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.portalBaseUrl,
    STORAGE_KEYS.operatorApiKey,
    STORAGE_KEYS.autoRefreshEnabled,
    STORAGE_KEYS.autoRefreshMinutes,
    STORAGE_KEYS.lastStatus,
    STORAGE_KEYS.lastPayload,
  ]);
  return {
    portalBaseUrl: ensureTrailingSlash(String(stored[STORAGE_KEYS.portalBaseUrl] || DEFAULT_PORTAL_BASE_URL).trim() || DEFAULT_PORTAL_BASE_URL),
    operatorApiKey: String(stored[STORAGE_KEYS.operatorApiKey] || '').trim(),
    autoRefreshEnabled: stored[STORAGE_KEYS.autoRefreshEnabled] !== false,
    autoRefreshMinutes: normalizeAutoRefreshMinutes(stored[STORAGE_KEYS.autoRefreshMinutes]),
    lastStatus: stored[STORAGE_KEYS.lastStatus] || null,
    lastPayload: stored[STORAGE_KEYS.lastPayload] || null,
  };
}

async function ensureAutoRefreshAlarm(config = null) {
  const nextConfig = config || await getStoredConfig();
  await chrome.alarms.clear(AUTO_REFRESH_ALARM);
  if (!nextConfig.autoRefreshEnabled) {
    return;
  }
  chrome.alarms.create(AUTO_REFRESH_ALARM, {
    periodInMinutes: normalizeAutoRefreshMinutes(nextConfig.autoRefreshMinutes),
  });
}

async function saveStoredConfig({
  portalBaseUrl,
  operatorApiKey,
  autoRefreshEnabled,
  autoRefreshMinutes,
}) {
  const nextConfig = {
    portalBaseUrl: ensureTrailingSlash(String(portalBaseUrl || DEFAULT_PORTAL_BASE_URL).trim() || DEFAULT_PORTAL_BASE_URL),
    operatorApiKey: String(operatorApiKey || '').trim(),
    autoRefreshEnabled: Boolean(autoRefreshEnabled),
    autoRefreshMinutes: normalizeAutoRefreshMinutes(autoRefreshMinutes),
  };

  await chrome.storage.local.set({
    [STORAGE_KEYS.portalBaseUrl]: nextConfig.portalBaseUrl,
    [STORAGE_KEYS.operatorApiKey]: nextConfig.operatorApiKey,
    [STORAGE_KEYS.autoRefreshEnabled]: nextConfig.autoRefreshEnabled,
    [STORAGE_KEYS.autoRefreshMinutes]: nextConfig.autoRefreshMinutes,
  });

  await ensureAutoRefreshAlarm(nextConfig);
}

async function setBridgeBadge(status) {
  const ok = Boolean(status?.ok);
  await chrome.action.setBadgeText({ text: ok ? 'ON' : (status ? 'ERR' : '') });
  if (status) {
    await chrome.action.setBadgeBackgroundColor({ color: ok ? '#166534' : '#991b1b' });
  }
}

async function persistStatus(status) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.lastStatus]: status,
  });
  await setBridgeBadge(status);
}

function normalizeAlertText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

async function sendBarkAlert({ title, body, fingerprint }) {
  if (!BARK_DEVICE_KEY) {
    return false;
  }

  const stored = await chrome.storage.local.get([STORAGE_KEYS.lastAlert]);
  const lastAlert = stored[STORAGE_KEYS.lastAlert] || null;
  const now = Date.now();
  if (
    lastAlert
    && lastAlert.fingerprint === fingerprint
    && typeof lastAlert.sentAt === 'number'
    && now - lastAlert.sentAt < ALERT_COOLDOWN_MS
  ) {
    return false;
  }

  const alertUrl = new URL(
    `${BARK_BASE_URL}/${encodeURIComponent(BARK_DEVICE_KEY)}/${encodeURIComponent(normalizeAlertText(title))}/${encodeURIComponent(normalizeAlertText(body))}`,
  );
  alertUrl.searchParams.set('group', 'HYFCeph Bridge');
  alertUrl.searchParams.set('isArchive', '1');

  try {
    await fetch(alertUrl.toString(), { method: 'GET' });
    await chrome.storage.local.set({
      [STORAGE_KEYS.lastAlert]: {
        fingerprint,
        sentAt: now,
      },
    });
    return true;
  } catch {
    return false;
  }
}

function buildOperatorSessionUrl(portalBaseUrl) {
  return new URL('api/admin/operator-session', portalBaseUrl).toString();
}

async function parseJsonResponse(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {
      error: text.slice(0, 500) || `HTTP ${response.status}`,
    };
  }
}

async function syncOperatorSession(payload, reason = 'capture') {
  const config = await getStoredConfig();
  if (!config.operatorApiKey) {
    const status = {
      ok: false,
      reason,
      message: '请先在扩展里填写管理员 API Key。',
      syncedAt: null,
      operatorSession: null,
    };
    await persistStatus(status);
    return status;
  }

  if (!payload?.token || !payload?.pageUrl) {
    const status = {
      ok: false,
      reason,
      message: '当前页面还没有可用的远程会话。',
      syncedAt: null,
      operatorSession: null,
    };
    await persistStatus(status);
    return status;
  }

  let response;
  let data;
  try {
    response = await fetch(buildOperatorSessionUrl(config.portalBaseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.operatorApiKey,
      },
      body: JSON.stringify(payload),
    });
    data = await parseJsonResponse(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = {
      ok: false,
      reason,
      message: message || '网络异常',
      syncedAt: null,
      operatorSession: null,
    };
    await persistStatus(status);
    await sendBarkAlert({
      title: 'HYFCeph Bridge 异常',
      body: `同步失败：${status.message}\n页面：${payload?.href || payload?.pageUrl || '-'}`,
      fingerprint: `sync-network:${status.message}:${payload?.pageUrl || ''}`,
    });
    throw new Error(status.message);
  }

  if (!response.ok) {
    const status = {
      ok: false,
      reason,
      message: data?.error || `HTTP ${response.status}`,
      syncedAt: null,
      operatorSession: null,
    };
    await persistStatus(status);
    await sendBarkAlert({
      title: 'HYFCeph Bridge 异常',
      body: `同步失败：${status.message}\n页面：${payload?.href || payload?.pageUrl || '-'}`,
      fingerprint: `sync-http:${response.status}:${status.message}:${payload?.pageUrl || ''}`,
    });
    throw new Error(status.message);
  }

  const status = {
    ok: true,
    reason,
    message: '同步成功。',
    syncedAt: new Date().toISOString(),
    operatorSession: data.operatorSession || null,
  };

  await chrome.storage.local.set({
    [STORAGE_KEYS.lastPayload]: payload,
  });
  await persistStatus(status);
  return status;
}

async function getSupportedTabs() {
  return chrome.tabs.query({
    url: SUPPORTED_TAB_PATTERNS,
  });
}

async function getActiveTabSummary() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = tabs[0];
  if (!tab || !tab.id) {
    return {
      supported: false,
      label: '没有找到活动标签页。',
      tabId: null,
    };
  }
  const url = String(tab.url || '');
  return {
    supported: SUPPORTED_URL_PATTERN.test(url),
    label: SUPPORTED_URL_PATTERN.test(url)
      ? '当前标签页支持同步。'
      : '请先打开侧位片网页。',
    tabId: tab.id,
    url,
    title: tab.title || '',
  };
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      resolve(response);
    });
  });
}

async function requestTabSyncById(tabId, {
  reason = 'force-sync',
  alertOnFailure = true,
  maxAttempts = TAB_SYNC_MAX_ATTEMPTS,
} = {}) {
  let lastErrorMessage = '同步失败。';

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await sendTabMessage(tabId, { type: 'hyfceph:force-sync' });
      if (response?.ok) {
        return response;
      }
      lastErrorMessage = response?.error || '同步失败。';
    } catch (error) {
      lastErrorMessage = error instanceof Error ? error.message : String(error);
    }

    if (attempt < maxAttempts) {
      await wait(TAB_SYNC_RETRY_MS);
    }
  }

  if (alertOnFailure) {
    await sendBarkAlert({
      title: 'HYFCeph Bridge 异常',
      body: `自动同步失败：${lastErrorMessage}`,
      fingerprint: `tab-sync:${reason}:${lastErrorMessage}`,
    });
  }
  throw new Error(lastErrorMessage);
}

async function requestTabSync() {
  const activeTab = await getActiveTabSummary();
  if (!activeTab.supported || !activeTab.tabId) {
    await sendBarkAlert({
      title: 'HYFCeph Bridge 异常',
      body: `强制同步失败：${activeTab.label}`,
      fingerprint: `force-sync:${activeTab.label}`,
    });
    throw new Error(activeTab.label);
  }

  return requestTabSyncById(activeTab.tabId, {
    reason: 'popup-force-sync',
    alertOnFailure: true,
  });
}

async function reloadSupportedTabs(reason = 'auto-refresh') {
  const config = await getStoredConfig();
  if (!config.autoRefreshEnabled || !config.operatorApiKey) {
    return { ok: true, refreshedTabs: 0, skipped: true };
  }

  const tabs = await getSupportedTabs();
  const supportedTabs = tabs.filter((tab) => tab.id && SUPPORTED_URL_PATTERN.test(String(tab.url || '')));
  if (!supportedTabs.length) {
    return { ok: true, refreshedTabs: 0, skipped: true };
  }

  await Promise.all(supportedTabs.map((tab) => chrome.tabs.reload(tab.id)));
  await persistStatus({
    ok: true,
    reason,
    message: `已刷新 ${supportedTabs.length} 个页面，等待自动同步。`,
    syncedAt: new Date().toISOString(),
    operatorSession: config.lastStatus?.operatorSession || null,
  });
  return { ok: true, refreshedTabs: supportedTabs.length };
}

async function handleCompletedSupportedTab(tabId, tabUrl) {
  const config = await getStoredConfig();
  if (!config.operatorApiKey) {
    return;
  }
  if (!SUPPORTED_URL_PATTERN.test(String(tabUrl || ''))) {
    return;
  }

  await wait(AUTO_SYNC_DELAY_MS);
  try {
    await requestTabSyncById(tabId, {
      reason: 'tab-load-complete',
      alertOnFailure: true,
    });
  } catch {
    // Bark and status are handled inside requestTabSyncById/syncOperatorSession.
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void ensureAutoRefreshAlarm();
});

chrome.runtime.onStartup.addListener(() => {
  void ensureAutoRefreshAlarm();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== AUTO_REFRESH_ALARM) {
    return;
  }
  void reloadSupportedTabs('auto-refresh');
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') {
    return;
  }
  const url = String(tab.url || '');
  if (!SUPPORTED_URL_PATTERN.test(url)) {
    return;
  }
  void handleCompletedSupportedTab(tabId, url);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (!message || typeof message.type !== 'string') {
      return { ok: false, error: 'Unsupported message.' };
    }

    if (message.type === 'hyfceph:session-capture') {
      const status = await syncOperatorSession(message.payload || {}, message.reason || 'capture');
      return { ok: status.ok, status };
    }

    if (message.type === 'hyfceph:get-state') {
      const config = await getStoredConfig();
      const activeTab = await getActiveTabSummary();
      return {
        ok: true,
        portalBaseUrl: config.portalBaseUrl,
        operatorApiKey: config.operatorApiKey,
        autoRefreshEnabled: config.autoRefreshEnabled,
        autoRefreshMinutes: config.autoRefreshMinutes,
        lastStatus: config.lastStatus,
        activeTab,
      };
    }

    if (message.type === 'hyfceph:save-config') {
      await saveStoredConfig({
        portalBaseUrl: message.portalBaseUrl,
        operatorApiKey: message.operatorApiKey,
        autoRefreshEnabled: message.autoRefreshEnabled,
        autoRefreshMinutes: message.autoRefreshMinutes,
      });
      const config = await getStoredConfig();
      return {
        ok: true,
        portalBaseUrl: config.portalBaseUrl,
        operatorApiKey: config.operatorApiKey,
        autoRefreshEnabled: config.autoRefreshEnabled,
        autoRefreshMinutes: config.autoRefreshMinutes,
      };
    }

    if (message.type === 'hyfceph:force-sync') {
      const response = await requestTabSync();
      return {
        ok: true,
        status: response.status || null,
      };
    }

    return { ok: false, error: 'Unsupported message.' };
  })().then(sendResponse).catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });

  return true;
});

void ensureAutoRefreshAlarm();
