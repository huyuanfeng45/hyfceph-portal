// ==UserScript==
// @name         HYFCeph Current Case Bridge
// @namespace    codex
// @version      0.3.0
// @description  Silently sync the current ceph case to the HYFCeph cloud bridge so public installs can use current-case mode without exposing share links.
// @match        https://pd.aiyayi.com/latera/*
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      hyfceph.52ortho.com
// ==/UserScript==

(function () {
  'use strict';

  const DEFAULT_PORTAL_BASE_URL = 'https://hyfceph.52ortho.com/';
  const STORAGE_KEYS = {
    apiKey: 'hyfceph_api_key',
    portalBaseUrl: 'hyfceph_portal_base_url',
  };
  const SYNC_INTERVAL_MS = 10000;
  let lastSignature = '';
  let syncTimer = null;

  function ensureTrailingSlash(value) {
    return value.endsWith('/') ? value : `${value}/`;
  }

  function getPortalBaseUrl() {
    const stored = String(GM_getValue(STORAGE_KEYS.portalBaseUrl, DEFAULT_PORTAL_BASE_URL) || '').trim();
    return ensureTrailingSlash(stored || DEFAULT_PORTAL_BASE_URL);
  }

  function getBridgeUrl() {
    return new URL('api/bridge/current-case', getPortalBaseUrl()).toString();
  }

  function getHealthUrl() {
    return new URL('api/health', getPortalBaseUrl()).toString();
  }

  function getApiKey() {
    return String(GM_getValue(STORAGE_KEYS.apiKey, '') || '').trim();
  }

  function setApiKey(value) {
    GM_setValue(STORAGE_KEYS.apiKey, String(value || '').trim());
  }

  function setPortalBaseUrl(value) {
    GM_setValue(STORAGE_KEYS.portalBaseUrl, ensureTrailingSlash(String(value || '').trim() || DEFAULT_PORTAL_BASE_URL));
  }

  function safeJsonParse(value) {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  function isFiniteNumber(value) {
    return Number.isFinite(Number(value));
  }

  function visitObjects(root, visitor, depth = 0, seen = new WeakSet()) {
    if (!root || typeof root !== 'object' || depth > 6) return;
    if (seen.has(root)) return;
    seen.add(root);
    visitor(root);
    if (Array.isArray(root)) {
      root.forEach((item) => visitObjects(item, visitor, depth + 1, seen));
      return;
    }
    Object.values(root).forEach((value) => visitObjects(value, visitor, depth + 1, seen));
  }

  function scanSessionStorage() {
    const summary = {
      token: '',
      ptId: null,
      ptVersion: null,
      accountType: '',
      lang: '',
      userName: '',
    };

    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index);
      if (!key) continue;
      const rawValue = sessionStorage.getItem(key);
      if (!rawValue) continue;

      const parsed = safeJsonParse(rawValue);
      if (!parsed) {
        continue;
      }

      visitObjects(parsed, (node) => {
        if (!summary.token && typeof node.token === 'string' && node.token.trim()) {
          summary.token = node.token.trim();
        }
        if (summary.ptId === null && isFiniteNumber(node.ptId)) {
          summary.ptId = Number(node.ptId);
        }
        if (summary.ptVersion === null && isFiniteNumber(node.ptVersion)) {
          summary.ptVersion = Number(node.ptVersion);
        }
        if (summary.ptVersion === null && isFiniteNumber(node.version) && summary.ptId !== null) {
          summary.ptVersion = Number(node.version);
        }
        if (!summary.accountType && typeof node.accountType === 'string') {
          summary.accountType = node.accountType;
        }
        if (!summary.lang && typeof node.lang === 'string') {
          summary.lang = node.lang;
        }
        if (!summary.userName && typeof node.userName === 'string') {
          summary.userName = node.userName;
        }
      });
    }

    return summary;
  }

  function buildPayload() {
    const session = scanSessionStorage();
    const shareUrl = window.location.search.includes('a=') ? window.location.href : '';
    return {
      source: 'portal-bridge',
      href: window.location.href,
      title: document.title,
      pageUrl: new URL('./', window.location.href).toString(),
      shareUrl,
      token: shareUrl ? '' : (session.token || ''),
      ptId: session.ptId,
      ptVersion: session.ptVersion,
      accountType: session.accountType || '',
      lang: session.lang || navigator.language || '',
      userName: session.userName || '',
      userAgent: navigator.userAgent,
    };
  }

  function postJson(url, payload, apiKey, onload, onerror) {
    GM_xmlhttpRequest({
      method: 'POST',
      url,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      data: JSON.stringify(payload),
      onload,
      onerror,
      ontimeout: onerror,
    });
  }

  function getJson(url, apiKey, onload, onerror) {
    GM_xmlhttpRequest({
      method: 'GET',
      url,
      headers: apiKey ? { 'x-api-key': apiKey } : {},
      onload,
      onerror,
      ontimeout: onerror,
    });
  }

  function syncNow(reason) {
    const apiKey = getApiKey();
    if (!apiKey) {
      console.warn('[HYFCeph Bridge] missing API key, open the userscript menu and configure it first');
      return;
    }

    const payload = buildPayload();
    const signature = JSON.stringify([
      payload.href,
      payload.shareUrl,
      payload.token,
      payload.ptId,
      payload.ptVersion,
      payload.title,
    ]);

    if (signature === lastSignature && reason !== 'menu') {
      return;
    }
    lastSignature = signature;

    postJson(
      getBridgeUrl(),
      payload,
      apiKey,
      (response) => {
        console.debug('[HYFCeph Bridge] synced', reason, response.status, payload);
      },
      (error) => {
        console.warn('[HYFCeph Bridge] sync failed', reason, error);
      },
    );
  }

  function scheduleSync(reason, delay = 250) {
    window.clearTimeout(syncTimer);
    syncTimer = window.setTimeout(() => syncNow(reason), delay);
  }

  function wrapHistory(methodName) {
    const original = history[methodName];
    history[methodName] = function wrappedHistoryMethod(...args) {
      const result = original.apply(this, args);
      scheduleSync(methodName, 300);
      return result;
    };
  }

  function configureApiKey() {
    const current = getApiKey();
    const value = window.prompt('请输入你的 HYFCeph API Key', current);
    if (value == null) {
      return;
    }
    setApiKey(value);
    console.debug('[HYFCeph Bridge] API key updated');
    scheduleSync('api-key-updated', 100);
  }

  function configurePortalUrl() {
    const current = getPortalBaseUrl();
    const value = window.prompt('请输入 HYFCeph 门户地址', current);
    if (value == null) {
      return;
    }
    setPortalBaseUrl(value);
    console.debug('[HYFCeph Bridge] portal URL updated', getPortalBaseUrl());
  }

  function clearApiKey() {
    setApiKey('');
    console.debug('[HYFCeph Bridge] API key cleared');
  }

  wrapHistory('pushState');
  wrapHistory('replaceState');
  window.addEventListener('hashchange', () => scheduleSync('hashchange'));
  window.addEventListener('popstate', () => scheduleSync('popstate'));
  window.addEventListener('focus', () => scheduleSync('focus'));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      scheduleSync('visibilitychange');
    }
  });

  window.setInterval(() => syncNow('interval'), SYNC_INTERVAL_MS);
  scheduleSync('boot', 800);
  scheduleSync('boot-late', 3000);

  GM_registerMenuCommand('设置 HYFCeph API Key', configureApiKey);
  GM_registerMenuCommand('清除 HYFCeph API Key', clearApiKey);
  GM_registerMenuCommand('设置 HYFCeph 门户地址', configurePortalUrl);
  GM_registerMenuCommand('立即同步当前病例', () => syncNow('menu'));
  GM_registerMenuCommand('检测 HYFCeph 连接', () => {
    getJson(
      getHealthUrl(),
      getApiKey(),
      (response) => console.debug('[HYFCeph Bridge] health', response.status, response.responseText),
      (error) => console.warn('[HYFCeph Bridge] health failed', error),
    );
  });
})();
