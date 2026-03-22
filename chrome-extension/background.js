const DEFAULT_PORTAL_BASE_URL = 'https://hyfceph.52ortho.com/';
const STORAGE_KEYS = {
  portalBaseUrl: 'hyfceph_portal_base_url',
  operatorApiKey: 'hyfceph_operator_api_key',
  lastStatus: 'hyfceph_last_status',
  lastPayload: 'hyfceph_last_payload',
};
const SUPPORTED_URL_PATTERN = /^https:\/\/pd\.aiyayi\.com\/latera\//i;

function ensureTrailingSlash(value) {
  return value.endsWith('/') ? value : `${value}/`;
}

async function getStoredConfig() {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.portalBaseUrl,
    STORAGE_KEYS.operatorApiKey,
    STORAGE_KEYS.lastStatus,
    STORAGE_KEYS.lastPayload,
  ]);
  return {
    portalBaseUrl: ensureTrailingSlash(String(stored[STORAGE_KEYS.portalBaseUrl] || DEFAULT_PORTAL_BASE_URL).trim() || DEFAULT_PORTAL_BASE_URL),
    operatorApiKey: String(stored[STORAGE_KEYS.operatorApiKey] || '').trim(),
    lastStatus: stored[STORAGE_KEYS.lastStatus] || null,
    lastPayload: stored[STORAGE_KEYS.lastPayload] || null,
  };
}

async function saveStoredConfig({ portalBaseUrl, operatorApiKey }) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.portalBaseUrl]: ensureTrailingSlash(String(portalBaseUrl || DEFAULT_PORTAL_BASE_URL).trim() || DEFAULT_PORTAL_BASE_URL),
    [STORAGE_KEYS.operatorApiKey]: String(operatorApiKey || '').trim(),
  });
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

  const response = await fetch(buildOperatorSessionUrl(config.portalBaseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.operatorApiKey,
    },
    body: JSON.stringify(payload),
  });
  const data = await parseJsonResponse(response);
  if (!response.ok) {
    const status = {
      ok: false,
      reason,
      message: data?.error || `HTTP ${response.status}`,
      syncedAt: null,
      operatorSession: null,
    };
    await persistStatus(status);
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

async function requestTabSync() {
  const activeTab = await getActiveTabSummary();
  if (!activeTab.supported || !activeTab.tabId) {
    throw new Error(activeTab.label);
  }

  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(activeTab.tabId, { type: 'hyfceph:force-sync' }, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error('当前页面还没有连接到扩展，请刷新页面后重试。'));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || '同步失败。'));
        return;
      }
      resolve(response);
    });
  });
}

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
        lastStatus: config.lastStatus,
        activeTab,
      };
    }

    if (message.type === 'hyfceph:save-config') {
      await saveStoredConfig({
        portalBaseUrl: message.portalBaseUrl,
        operatorApiKey: message.operatorApiKey,
      });
      const config = await getStoredConfig();
      return {
        ok: true,
        portalBaseUrl: config.portalBaseUrl,
        operatorApiKey: config.operatorApiKey,
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
