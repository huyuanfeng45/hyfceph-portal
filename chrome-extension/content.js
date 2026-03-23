const SYNC_INTERVAL_MS = 15000;
const AUTO_LOGIN_CHECK_DELAY_MS = 400;
const AUTO_LOGIN_COOLDOWN_MS = 60 * 1000;
const AUTO_LOGIN_MAX_ATTEMPTS = 3;
const AUTO_LOGIN_RESULT_DELAY_MS = 8000;
const STORAGE_KEYS = {
  upstreamUsername: 'hyfceph_upstream_username',
  upstreamPassword: 'hyfceph_upstream_password',
};
const AUTO_LOGIN_STATE_KEY = 'hyfceph_auto_login_state';
let lastSignature = '';
let tickTimer = null;
let autoLoginResultTimer = null;
let observer = null;
let lastAutoLoginNotice = '';

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

function isVisible(element) {
  if (!element) {
    return false;
  }
  const style = window.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden') {
    return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function normalizedText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function textMatches(value, keywords) {
  const text = normalizedText(value);
  return keywords.some((keyword) => text.includes(keyword));
}

function getInputHint(input) {
  return [
    input?.placeholder,
    input?.name,
    input?.id,
    input?.autocomplete,
    input?.getAttribute?.('aria-label'),
  ].filter(Boolean).join(' ');
}

function getInputs() {
  return Array.from(document.querySelectorAll('input, textarea')).filter((input) => {
    if (!isVisible(input)) {
      return false;
    }
    const type = normalizedText(input.getAttribute('type'));
    return type !== 'hidden' && type !== 'checkbox' && type !== 'radio' && !input.disabled && !input.readOnly;
  });
}

function findPasswordInput() {
  return getInputs().find((input) => {
    const hint = getInputHint(input);
    const type = normalizedText(input.getAttribute('type'));
    return type === 'password'
      || textMatches(hint, ['密码', 'password', 'pwd', 'pass']);
  }) || null;
}

function findUsernameInput(passwordInput) {
  const inputs = getInputs().filter((input) => input !== passwordInput);
  const preferred = inputs.find((input) => {
    const hint = getInputHint(input);
    return textMatches(hint, ['用户名', '账号', '账户', 'user', 'username', 'account', '手机号', '手机', 'phone', 'email']);
  });
  if (preferred) {
    return preferred;
  }

  if (passwordInput) {
    const form = passwordInput.form || passwordInput.closest('form, .el-form, .loginForm, .login, .el-card');
    if (form) {
      const formInputs = Array.from(form.querySelectorAll('input, textarea')).filter((input) => {
        if (input === passwordInput || !isVisible(input) || input.disabled || input.readOnly) {
          return false;
        }
        const type = normalizedText(input.getAttribute('type'));
        return type !== 'hidden' && type !== 'checkbox' && type !== 'radio';
      });
      if (formInputs.length > 0) {
        return formInputs[0];
      }
    }
  }

  return inputs[0] || null;
}

function findCaptchaInput(container) {
  const scope = container || document;
  return Array.from(scope.querySelectorAll('input, textarea')).find((input) => {
    if (!isVisible(input) || input.disabled || input.readOnly) {
      return false;
    }
    const hint = getInputHint(input);
    return textMatches(hint, ['验证码', 'captcha', 'code']);
  }) || null;
}

function getButtonText(button) {
  return normalizedText([
    button?.textContent,
    button?.innerText,
    button?.value,
    button?.getAttribute?.('aria-label'),
  ].filter(Boolean).join(' '));
}

function findSubmitButton(container) {
  const scope = container || document;
  const buttons = Array.from(scope.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"], .el-button'))
    .filter((button) => isVisible(button) && !button.disabled);
  return buttons.find((button) => textMatches(getButtonText(button), ['登录', 'login', 'sign in']))
    || buttons.find((button) => button.classList?.contains('el-button--primary'))
    || buttons[0]
    || null;
}

function findLoginElements() {
  const passwordInput = findPasswordInput();
  const usernameInput = findUsernameInput(passwordInput);
  const container = passwordInput?.form || passwordInput?.closest('form, .el-form, .loginForm, .login, .el-card') || document;
  const captchaInput = findCaptchaInput(container);
  const submitButton = findSubmitButton(container);
  return {
    usernameInput,
    passwordInput,
    captchaInput,
    submitButton,
    container,
  };
}

function looksLikeLoginPage() {
  if (/\/login(?:[/?#]|$)/i.test(window.location.hash)) {
    return true;
  }
  const { passwordInput, submitButton } = findLoginElements();
  return Boolean(passwordInput && submitButton);
}

function readAutoLoginState() {
  const raw = sessionStorage.getItem(AUTO_LOGIN_STATE_KEY);
  if (!raw) {
    return {
      attemptCount: 0,
      lastAttemptAt: 0,
      inProgress: false,
      lastHref: '',
    };
  }
  try {
    const parsed = JSON.parse(raw);
    return {
      attemptCount: Number(parsed.attemptCount || 0),
      lastAttemptAt: Number(parsed.lastAttemptAt || 0),
      inProgress: Boolean(parsed.inProgress),
      lastHref: String(parsed.lastHref || ''),
    };
  } catch {
    return {
      attemptCount: 0,
      lastAttemptAt: 0,
      inProgress: false,
      lastHref: '',
    };
  }
}

function writeAutoLoginState(state) {
  sessionStorage.setItem(AUTO_LOGIN_STATE_KEY, JSON.stringify({
    attemptCount: Number(state.attemptCount || 0),
    lastAttemptAt: Number(state.lastAttemptAt || 0),
    inProgress: Boolean(state.inProgress),
    lastHref: String(state.lastHref || ''),
  }));
}

function resetAutoLoginState() {
  sessionStorage.removeItem(AUTO_LOGIN_STATE_KEY);
  lastAutoLoginNotice = '';
  window.clearTimeout(autoLoginResultTimer);
}

function setNativeInputValue(input, value) {
  if (!input) {
    return;
  }
  const prototype = input instanceof window.HTMLTextAreaElement
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
  if (descriptor?.set) {
    descriptor.set.call(input, value);
  } else {
    input.value = value;
  }
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.dispatchEvent(new Event('blur', { bubbles: true }));
}

function notifyAutoLogin(stage, message) {
  const signature = `${stage}:${message}`;
  if (lastAutoLoginNotice === signature) {
    return;
  }
  lastAutoLoginNotice = signature;
  chrome.runtime.sendMessage({
    type: 'hyfceph:auto-login-status',
    payload: {
      stage,
      message,
      href: window.location.href,
      pageUrl: new URL('/latera/', window.location.origin).toString(),
    },
  }, () => {
    void chrome.runtime.lastError;
  });
}

async function getStoredAutoLoginCredentials() {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.upstreamUsername,
    STORAGE_KEYS.upstreamPassword,
  ]);
  return {
    username: String(stored[STORAGE_KEYS.upstreamUsername] || '').trim(),
    password: String(stored[STORAGE_KEYS.upstreamPassword] || ''),
  };
}

function emitCapturePayload(payload, reason = 'capture', force = false) {
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

function emitCapture(reason = 'capture', force = false) {
  emitCapturePayload(buildPayload(), reason, force);
}

async function attemptAutoLogin(reason = 'auto-login') {
  if (!looksLikeLoginPage()) {
    return { ok: false, loginPage: false };
  }

  const credentials = await getStoredAutoLoginCredentials();
  if (!credentials.username || !credentials.password) {
    notifyAutoLogin('missing-credentials', '检测到登录页，但扩展里还没有填写自动登录账号密码。');
    return {
      ok: false,
      pendingLogin: false,
      error: '检测到登录页，但扩展里还没有填写自动登录账号密码。',
    };
  }

  const state = readAutoLoginState();
  const now = Date.now();
  if (state.inProgress && now - state.lastAttemptAt < AUTO_LOGIN_RESULT_DELAY_MS) {
    notifyAutoLogin('waiting', '检测到登录页，自动登录正在进行中。');
    return {
      ok: false,
      pendingLogin: true,
      error: '检测到登录页，自动登录正在进行中。',
    };
  }

  if (
    state.lastHref === window.location.href
    && state.attemptCount >= AUTO_LOGIN_MAX_ATTEMPTS
    && now - state.lastAttemptAt < 10 * 60 * 1000
  ) {
    notifyAutoLogin('failed', '自动登录连续失败次数过多，请人工检查账号密码或重新登录。');
    return {
      ok: false,
      pendingLogin: false,
      error: '自动登录连续失败次数过多，请人工检查账号密码或重新登录。',
    };
  }

  if (now - state.lastAttemptAt < AUTO_LOGIN_COOLDOWN_MS) {
    notifyAutoLogin('waiting', '检测到登录页，自动登录冷却中。');
    return {
      ok: false,
      pendingLogin: true,
      error: '检测到登录页，自动登录冷却中。',
    };
  }

  const { usernameInput, passwordInput, captchaInput, submitButton } = findLoginElements();
  if (!usernameInput || !passwordInput || !submitButton) {
    return {
      ok: false,
      pendingLogin: true,
      error: '检测到登录页，但登录表单还没有渲染完成。',
    };
  }

  if (captchaInput) {
    notifyAutoLogin('captcha', '登录页已出现验证码，扩展不会自动处理验证码，请手动登录一次。');
    return {
      ok: false,
      pendingLogin: false,
      error: '登录页已出现验证码，请手动登录一次。',
    };
  }

  writeAutoLoginState({
    attemptCount: state.lastHref === window.location.href ? state.attemptCount + 1 : 1,
    lastAttemptAt: now,
    inProgress: true,
    lastHref: window.location.href,
  });

  setNativeInputValue(usernameInput, credentials.username);
  setNativeInputValue(passwordInput, credentials.password);
  usernameInput.focus();
  passwordInput.focus();
  submitButton.click();
  notifyAutoLogin('triggered', '检测到登录页，已使用扩展里保存的账号密码尝试自动登录。');

  window.clearTimeout(autoLoginResultTimer);
  autoLoginResultTimer = window.setTimeout(() => {
    const payload = buildPayload();
    if (payload.token) {
      resetAutoLoginState();
      return;
    }
    const stateAfter = readAutoLoginState();
    writeAutoLoginState({
      ...stateAfter,
      inProgress: false,
      lastHref: window.location.href,
    });
    const nextElements = findLoginElements();
    if (nextElements.captchaInput) {
      notifyAutoLogin('captcha', '自动登录后页面要求输入验证码，请手动登录一次。');
      return;
    }
    notifyAutoLogin('failed', '自动登录后页面仍停留在登录页，请检查账号密码或手动重新登录。');
  }, AUTO_LOGIN_RESULT_DELAY_MS);

  window.setTimeout(() => emitCapture('post-auto-login', true), 3000);
  return {
    ok: false,
    pendingLogin: true,
    error: '检测到登录页，已触发自动登录。',
  };
}

async function tick(reason = 'capture', force = false) {
  const payload = buildPayload();
  if (payload.token) {
    resetAutoLoginState();
    emitCapturePayload(payload, reason, force);
    return { ok: true, status: null };
  }

  if (looksLikeLoginPage()) {
    return attemptAutoLogin(reason);
  }

  return {
    ok: false,
    pendingLogin: false,
    error: '当前页面还没有可用的远程会话。',
  };
}

function scheduleTick(reason, delay = 300, force = false) {
  window.clearTimeout(tickTimer);
  tickTimer = window.setTimeout(() => {
    void tick(reason, force);
  }, delay);
}

function wrapHistory(methodName) {
  const original = history[methodName];
  history[methodName] = function wrappedHistoryMethod(...args) {
    const result = original.apply(this, args);
    scheduleTick(methodName);
    return result;
  };
}

wrapHistory('pushState');
wrapHistory('replaceState');

window.addEventListener('hashchange', () => scheduleTick('hashchange'));
window.addEventListener('popstate', () => scheduleTick('popstate'));
window.addEventListener('focus', () => scheduleTick('focus'));
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    scheduleTick('visibilitychange');
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'hyfceph:force-sync') {
    return false;
  }

  void tick('popup-force-sync', true).then((result) => {
    sendResponse({
      ok: Boolean(result?.ok),
      pendingLogin: Boolean(result?.pendingLogin),
      status: result?.status || null,
      error: result?.error || null,
    });
  }).catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

observer = new MutationObserver(() => {
  scheduleTick('mutation', AUTO_LOGIN_CHECK_DELAY_MS);
});

if (document.documentElement) {
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}

window.setInterval(() => {
  void tick('interval');
}, SYNC_INTERVAL_MS);
scheduleTick('boot', 800);
