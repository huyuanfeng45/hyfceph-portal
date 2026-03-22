const SYNC_INTERVAL_MS = 15000;
let lastSignature = '';
let syncTimer = null;

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
  if (!root || typeof root !== 'object' || depth > 6) {
    return;
  }
  if (seen.has(root)) {
    return;
  }
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
    accountType: '',
    lang: '',
    userName: '',
    ptId: null,
    ptVersion: null,
  };

  for (let index = 0; index < sessionStorage.length; index += 1) {
    const key = sessionStorage.key(index);
    if (!key) continue;
    const rawValue = sessionStorage.getItem(key);
    if (!rawValue) continue;
    const parsed = safeJsonParse(rawValue);
    if (!parsed) continue;

    visitObjects(parsed, (node) => {
      if (!summary.token && typeof node.token === 'string' && node.token.trim()) {
        summary.token = node.token.trim();
      }
      if (!summary.accountType && typeof node.accountType === 'string' && node.accountType.trim()) {
        summary.accountType = node.accountType.trim();
      }
      if (!summary.lang && typeof node.lang === 'string' && node.lang.trim()) {
        summary.lang = node.lang.trim();
      }
      if (!summary.userName && typeof node.userName === 'string' && node.userName.trim()) {
        summary.userName = node.userName.trim();
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
    });
  }

  return summary;
}

function buildPayload() {
  const session = scanSessionStorage();
  return {
    source: 'chrome-extension',
    href: window.location.href,
    title: document.title,
    pageUrl: new URL('/latera/', window.location.origin).toString(),
    token: session.token,
    accountType: session.accountType,
    lang: session.lang || navigator.language || '',
    userName: session.userName,
    ptId: session.ptId,
    ptVersion: session.ptVersion,
    userAgent: navigator.userAgent,
  };
}

function emitCapture(reason = 'capture', force = false) {
  const payload = buildPayload();
  if (!payload.token) {
    return;
  }

  const signature = JSON.stringify([
    payload.pageUrl,
    payload.token,
    payload.userName,
    payload.href,
    payload.ptId,
    payload.ptVersion,
  ]);
  if (!force && signature === lastSignature) {
    return;
  }
  lastSignature = signature;

  chrome.runtime.sendMessage({
    type: 'hyfceph:session-capture',
    reason,
    payload,
  }, () => {
    void chrome.runtime.lastError;
  });
}

function scheduleCapture(reason, delay = 300) {
  window.clearTimeout(syncTimer);
  syncTimer = window.setTimeout(() => emitCapture(reason), delay);
}

function wrapHistory(methodName) {
  const original = history[methodName];
  history[methodName] = function wrappedHistoryMethod(...args) {
    const result = original.apply(this, args);
    scheduleCapture(methodName);
    return result;
  };
}

wrapHistory('pushState');
wrapHistory('replaceState');

window.addEventListener('hashchange', () => scheduleCapture('hashchange'));
window.addEventListener('popstate', () => scheduleCapture('popstate'));
window.addEventListener('focus', () => scheduleCapture('focus'));
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    scheduleCapture('visibilitychange');
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'hyfceph:force-sync') {
    return false;
  }

  try {
    emitCapture('popup-force-sync', true);
    sendResponse({ ok: true, status: null });
  } catch (error) {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return false;
});

window.setInterval(() => emitCapture('interval'), SYNC_INTERVAL_MS);
scheduleCapture('boot', 800);
