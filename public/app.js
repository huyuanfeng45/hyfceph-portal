const state = {
  user: null,
  adminUsers: [],
  adminInviteCodes: [],
  selectedAdminInviteCodes: new Set(),
  inviteCodes: [],
  weixinBindingSession: null,
  dashboardView: 'weixin',
};

const flash = document.querySelector('#flash');
const tabs = Array.from(document.querySelectorAll('.tab'));
const panels = Array.from(document.querySelectorAll('.tab-panel'));
const dashboardMenuItems = Array.from(document.querySelectorAll('.dashboard-menu-item'));
const dashboardViews = Array.from(document.querySelectorAll('.dashboard-view'));
const registerTab = document.querySelector('[data-tab="register"]');
const loginTab = document.querySelector('[data-tab="login"]');
const dashboardTab = document.querySelector('[data-tab="dashboard"]');
const registerForm = document.querySelector('#register-form');
const loginForm = document.querySelector('#login-form');
const logoutButton = document.querySelector('#logout-button');
const generateKeyButton = document.querySelector('#generate-key-button');
const copyKeyButton = document.querySelector('#copy-key-button');
const copySkillLinkButton = document.querySelector('#copy-skill-link-button');
const apiKeyOutput = document.querySelector('#api-key-output');
const apiKeyExpiry = document.querySelector('#api-key-expiry');
const inviteQuotaBadge = document.querySelector('#invite-quota-badge');
const inviteQuotaText = document.querySelector('#invite-quota-text');
const inviteCodeNote = document.querySelector('#invite-code-note');
const generateInviteCodeButton = document.querySelector('#generate-invite-code-button');
const inviteCodesBody = document.querySelector('#invite-codes-body');
const weixinBindingStatus = document.querySelector('#weixin-binding-status');
const weixinBindingDetail = document.querySelector('#weixin-binding-detail');
const weixinBindingStartButton = document.querySelector('#weixin-binding-start-button');
const weixinBindingRefreshButton = document.querySelector('#weixin-binding-refresh-button');
const weixinBindingDeleteButton = document.querySelector('#weixin-binding-delete-button');
const weixinBindingQrWrap = document.querySelector('#weixin-binding-qr-wrap');
const weixinBindingQrImage = document.querySelector('#weixin-binding-qr-image');
const weixinBindingQrCaption = document.querySelector('#weixin-binding-qr-caption');
const weixinBindingSessionCode = document.querySelector('#weixin-binding-session-code');
const weixinBindingReadinessBadge = document.querySelector('#weixin-binding-readiness-badge');
const weixinBindingReadyHint = document.querySelector('#weixin-binding-ready-hint');
const measureImageInput = document.querySelector('#measure-image-input');
const measureImageButton = document.querySelector('#measure-image-button');
const measurePanel = document.querySelector('#measure-panel');
const measureResult = document.querySelector('#measure-result');
const measureRiskLabel = document.querySelector('#measure-risk-label');
const measureInsight = document.querySelector('#measure-insight');
const measureImage = document.querySelector('#measure-image');
const measureMetrics = document.querySelector('#measure-metrics');
const operatorSyncPanel = document.querySelector('#operator-sync-panel');
const operatorSyncStatus = document.querySelector('#operator-sync-status');
const operatorSyncDetail = document.querySelector('#operator-sync-detail');
const refreshOperatorSyncButton = document.querySelector('#refresh-operator-sync-button');
const clearOperatorSyncButton = document.querySelector('#clear-operator-sync-button');
const refreshAdminButton = document.querySelector('#refresh-admin-button');
const adminPanel = document.querySelector('#admin-panel');
const adminUsersBody = document.querySelector('#admin-users-body');
const adminInviteCodesBody = document.querySelector('#admin-invite-codes-body');
const adminInviteSearchInput = document.querySelector('#admin-invite-search-input');
const adminInviteStatusFilter = document.querySelector('#admin-invite-status-filter');
const adminInviteFilterSummary = document.querySelector('#admin-invite-filter-summary');
const adminInviteSelectAll = document.querySelector('#admin-invite-select-all');
const adminInviteExportAllButton = document.querySelector('#admin-invite-export-all-button');
const adminInviteExportSelectedButton = document.querySelector('#admin-invite-export-selected-button');
const profileUserName = document.querySelector('#profile-user-name');
const profileUserRole = document.querySelector('#profile-user-role');
const profileUserOrganization = document.querySelector('#profile-user-organization');
const profileUserPhone = document.querySelector('#profile-user-phone');
let weixinBindingPollTimer = null;
let weixinBindingPollInFlight = false;
let weixinBindingReadinessTimer = null;
let weixinBindingReadinessInFlight = false;

function showFlash(message, type = 'success') {
  flash.textContent = message;
  flash.classList.remove('hidden', 'error');
  if (type === 'error') {
    flash.classList.add('error');
  }
}

function clearFlash() {
  flash.textContent = '';
  flash.classList.add('hidden');
  flash.classList.remove('error');
}

function setActiveTab(tabName) {
  tabs.forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.tab === tabName);
  });
  panels.forEach((panel) => {
    panel.classList.toggle('active', panel.dataset.panel === tabName);
    panel.classList.toggle('hidden', panel.dataset.panel !== tabName);
  });
}

function setDashboardView(viewName) {
  state.dashboardView = viewName;
  dashboardMenuItems.forEach((item) => {
    const isActive = item.dataset.dashboardView === viewName;
    item.classList.toggle('active', isActive);
  });
  dashboardViews.forEach((panel) => {
    const isActive = panel.dataset.dashboardPanel === viewName;
    panel.classList.toggle('active', isActive);
    panel.classList.toggle('hidden', !isActive);
  });
}

function formatDateTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function toDatetimeLocal(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const offset = date.getTimezoneOffset();
  const local = new Date(date.getTime() - offset * 60000);
  return local.toISOString().slice(0, 16);
}

function updateDashboard(user) {
  document.querySelector('#user-name').textContent = user?.name || '-';
  document.querySelector('#user-organization').textContent = user?.organization || '-';
  document.querySelector('#user-phone').textContent = user?.phone || user?.username || '-';
  document.querySelector('#user-role').textContent = user?.role === 'admin' ? '管理员' : '普通用户';
  profileUserName.textContent = user?.name || '-';
  profileUserOrganization.textContent = user?.organization || '-';
  profileUserPhone.textContent = user?.phone || user?.username || '-';
  profileUserRole.textContent = user?.role === 'admin' ? '管理员' : '普通用户';
  apiKeyOutput.value = user?.apiKey || '';
  apiKeyOutput.placeholder = user?.apiKey
    ? ''
    : '还没有 API Key，点击下方按钮生成。';
  apiKeyExpiry.textContent = user?.apiKeyExpiresAt ? formatDateTime(user.apiKeyExpiresAt) : '-';
  generateKeyButton.textContent = user?.apiKey ? '重新生成 API Key' : '生成 API Key';
}

function stopWeixinBindingPolling() {
  if (weixinBindingPollTimer) {
    window.clearInterval(weixinBindingPollTimer);
    weixinBindingPollTimer = null;
  }
  weixinBindingPollInFlight = false;
}

function stopWeixinBindingReadinessPolling() {
  if (weixinBindingReadinessTimer) {
    window.clearInterval(weixinBindingReadinessTimer);
    weixinBindingReadinessTimer = null;
  }
  weixinBindingReadinessInFlight = false;
}

function renderWeixinBindingReadiness(binding) {
  const readiness = binding?.readiness || null;
  if (!readiness || !binding) {
    weixinBindingReadinessBadge.classList.add('hidden');
    weixinBindingReadinessBadge.classList.remove('pending', 'ready');
    weixinBindingReadinessBadge.textContent = '';
    weixinBindingReadyHint.classList.add('hidden');
    weixinBindingReadyHint.textContent = '';
    return;
  }

  const badgeText = readiness.code === 'ready'
    ? '🟢 已就绪'
    : readiness.code === 'pending'
      ? '⏳ 等待接管'
      : '';

  if (badgeText) {
    weixinBindingReadinessBadge.textContent = badgeText;
    weixinBindingReadinessBadge.classList.remove('hidden');
    weixinBindingReadinessBadge.classList.toggle('pending', readiness.code === 'pending');
    weixinBindingReadinessBadge.classList.toggle('ready', readiness.code === 'ready');
  } else {
    weixinBindingReadinessBadge.classList.add('hidden');
    weixinBindingReadinessBadge.classList.remove('pending', 'ready');
    weixinBindingReadinessBadge.textContent = '';
  }

  if (readiness.detail) {
    weixinBindingReadyHint.textContent = readiness.detail;
    weixinBindingReadyHint.classList.remove('hidden');
  } else {
    weixinBindingReadyHint.classList.add('hidden');
    weixinBindingReadyHint.textContent = '';
  }
}

function renderWeixinBinding() {
  const binding = state.user?.weixinBinding || null;
  const session = state.weixinBindingSession;
  const readiness = binding?.readiness || null;

  if (binding) {
    weixinBindingStatus.textContent = readiness?.code === 'ready'
      ? '已就绪'
      : readiness?.code === 'pending'
        ? '等待接管'
        : '已绑定';
    weixinBindingDetail.textContent = [
      binding.displayUserId ? `微信用户 ${binding.displayUserId}` : '',
      binding.boundAt ? `绑定于 ${formatDateTime(binding.boundAt)}` : '',
    ].filter(Boolean).join('，') || '当前微信已绑定 HYFCeph。';
    weixinBindingDeleteButton.disabled = false;
  } else if (session?.active) {
    weixinBindingStatus.textContent = session.status === 'scaned' ? '已扫码，待确认' : '等待扫码';
    weixinBindingDetail.textContent = session.message || '二维码已生成，请使用微信扫码完成绑定。';
    weixinBindingDeleteButton.disabled = true;
  } else {
    weixinBindingStatus.textContent = '未绑定';
    weixinBindingDetail.textContent = '先在这里生成二维码，再用微信扫描完成绑定。绑定成功后，就能在微信里直接把侧位片发给 HYFCeph。';
    weixinBindingDeleteButton.disabled = true;
  }

  renderWeixinBindingReadiness(binding);

  if (session?.qrcodeUrl && session?.active && !binding) {
    weixinBindingQrImage.src = session.qrcodeDataUrl || session.qrcodeUrl;
    weixinBindingQrWrap.classList.remove('hidden');
    weixinBindingQrCaption.textContent = session.message || '二维码已生成，系统会自动轮询绑定状态。';
    weixinBindingSessionCode.textContent = session.sessionKey ? `会话：${session.sessionKey}` : '';
  } else {
    weixinBindingQrWrap.classList.add('hidden');
    weixinBindingQrImage.removeAttribute('src');
    weixinBindingQrCaption.textContent = '二维码生成后，会在这里自动轮询绑定状态。';
    weixinBindingSessionCode.textContent = '';
  }
}

async function refreshWeixinBindingReadiness() {
  if (weixinBindingReadinessInFlight || !state.user?.weixinBinding) {
    return;
  }

  weixinBindingReadinessInFlight = true;
  try {
    const payload = await requestJson('/api/weixin/binding/readiness', {
      method: 'GET',
    });
    if (payload.user) {
      state.user = payload.user;
      updateDashboard(state.user);
    }
    renderWeixinBinding();
    if (payload.readiness?.ready) {
      stopWeixinBindingReadinessPolling();
    }
  } finally {
    weixinBindingReadinessInFlight = false;
  }
}

async function refreshWeixinBindingStatus() {
  if (weixinBindingPollInFlight) {
    return;
  }
  const sessionKey = state.weixinBindingSession?.sessionKey;
  if (!sessionKey) {
    renderWeixinBinding();
    return;
  }

  weixinBindingPollInFlight = true;
  try {
    const payload = await requestJson(`/api/weixin/binding/status?sessionKey=${encodeURIComponent(sessionKey)}`, {
      method: 'GET',
    });
    state.weixinBindingSession = payload.session || null;
    if (payload.user) {
      state.user = payload.user;
      updateDashboard(state.user);
      stopWeixinBindingPolling();
      state.weixinBindingSession = null;
      ensureWeixinBindingReadinessPolling();
      showFlash('微信绑定成功，机器人正在接管，通常 10 秒内就绪。');
    } else if (!payload.session?.active) {
      stopWeixinBindingPolling();
    }
    renderWeixinBinding();
  } catch (error) {
    if (/过期|不存在/.test(error.message)) {
      state.weixinBindingSession = null;
      stopWeixinBindingPolling();
      renderWeixinBinding();
    }
    throw error;
  } finally {
    weixinBindingPollInFlight = false;
  }
}

function ensureWeixinBindingPolling() {
  stopWeixinBindingPolling();
  if (!state.weixinBindingSession?.sessionKey) {
    return;
  }
  weixinBindingPollTimer = window.setInterval(async () => {
    try {
      await refreshWeixinBindingStatus();
    } catch {
      // Ignore polling jitter; manual refresh still surfaces errors.
    }
  }, 3000);
}

function ensureWeixinBindingReadinessPolling() {
  stopWeixinBindingReadinessPolling();
  const readiness = state.user?.weixinBinding?.readiness;
  if (!state.user?.weixinBinding || readiness?.ready) {
    return;
  }
  weixinBindingReadinessTimer = window.setInterval(async () => {
    try {
      await refreshWeixinBindingReadiness();
    } catch {
      // ignore transient jitter; manual refresh still exposes errors
    }
  }, 5000);
}

function resetMeasureResult() {
  measureResult.classList.add('hidden');
  measureRiskLabel.textContent = '-';
  measureInsight.textContent = '-';
  measureImage.classList.add('hidden');
  measureImage.removeAttribute('src');
  measureMetrics.innerHTML = '';
}

function renderMeasureResult(result) {
  const analysis = result?.analysis || {};
  const metrics = result?.metrics || analysis.metrics || [];
  const artifacts = result?.artifacts || {};
  const riskLabel = analysis.riskLabel || result?.summary?.riskLabel || '未生成结论';
  const insight = analysis.insight || '本次服务端测量已完成。';
  const pngSrc = artifacts.annotatedPngBase64
    ? `data:${artifacts.annotatedPngMimeType || 'image/png'};base64,${artifacts.annotatedPngBase64}`
    : '';
  const svgSrc = artifacts.annotatedSvgBase64
    ? `data:${artifacts.annotatedSvgMimeType || 'image/svg+xml'};base64,${artifacts.annotatedSvgBase64}`
    : '';

  measureRiskLabel.textContent = riskLabel;
  measureInsight.textContent = insight;
  if (pngSrc || svgSrc) {
    measureImage.src = pngSrc || svgSrc;
    measureImage.classList.remove('hidden');
  } else {
    measureImage.classList.add('hidden');
    measureImage.removeAttribute('src');
  }

  if (metrics.length) {
    measureMetrics.innerHTML = metrics.map((metric) => `
      <article class="metric-chip metric-${metric.tone || 'default'}">
        <div class="metric-code">${metric.code}</div>
        <div class="metric-value">${metric.valueText}</div>
        <div class="metric-label">${metric.label}</div>
      </article>
    `).join('');
  } else {
    measureMetrics.innerHTML = '<div class="empty-cell">本次未返回可展示的测量值。</div>';
  }

  measureResult.classList.remove('hidden');
}

function renderOperatorSyncStatus(operatorSession) {
  if (!operatorSession) {
    operatorSyncStatus.textContent = '未连接';
    operatorSyncDetail.textContent = '扩展开始同步后，这里会显示最近一次同步时间和操作者信息。';
    return;
  }

  operatorSyncStatus.textContent = operatorSession.active ? '在线' : '已过期';
  const details = [
    operatorSession.userName ? `用户 ${operatorSession.userName}` : '',
    operatorSession.accountType ? `类型 ${operatorSession.accountType}` : '',
    operatorSession.syncedAt ? `同步于 ${formatDateTime(operatorSession.syncedAt)}` : '',
    operatorSession.expiresAt ? `过期于 ${formatDateTime(operatorSession.expiresAt)}` : '',
  ].filter(Boolean);
  operatorSyncDetail.textContent = details.join('，') || '扩展已连接，但暂无更多细节。';
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || '请求失败。');
  }
  return payload;
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const base64 = result.includes(',') ? result.split(',').pop() : result;
      resolve(base64 || '');
    };
    reader.onerror = () => reject(new Error('读取图片失败。'));
    reader.readAsDataURL(file);
  });
}

function renderAdminUsers(users) {
  if (!users.length) {
    adminUsersBody.innerHTML = '<tr><td colspan="6" class="empty-cell">暂无数据</td></tr>';
    return;
  }

  adminUsersBody.innerHTML = users.map((user) => {
    const displayName = user.role === 'admin'
      ? `${user.name}（管理员）`
      : user.name;
    const identifier = [user.organization || '-', user.phone || user.username || '-'].join('<br />');
    const inviteSource = user.role === 'admin'
      ? '<span class="empty-cell">系统管理员</span>'
      : user.invitedByName
        ? `<strong>${user.invitedByName}</strong><div class="api-tip">邀请码 ${user.inviteCodeUsed || '-'}</div>`
        : '<span class="empty-cell">未记录</span>';
    const keyMarkup = user.apiKey
      ? `<code>${user.apiKey}</code><div class="status-pill ${user.apiKeyActive ? 'active' : 'inactive'}">${user.apiKeyActive ? '有效' : '已过期'}</div>`
      : '<span class="empty-cell">未生成</span>';
    const expiryControl = user.apiKey
      ? `<input class="admin-expiry-input" type="datetime-local" value="${toDatetimeLocal(user.apiKeyExpiresAt)}" data-user-id="${user.id}" />`
      : '<span class="empty-cell">-</span>';
    const actionButtons = user.role === 'admin'
      ? '<span class="empty-cell">管理员账号不可删除 Key</span>'
      : user.apiKey
        ? `<div class="admin-actions">
            <button class="ghost-button js-save-expiry" type="button" data-user-id="${user.id}">保存有效期</button>
            <button class="ghost-button js-delete-key" type="button" data-user-id="${user.id}">删除 Key</button>
          </div>`
        : '<span class="empty-cell">暂无可操作 Key</span>';

    return `
      <tr>
        <td>${displayName}</td>
        <td>${identifier}</td>
        <td>${inviteSource}</td>
        <td>${keyMarkup}</td>
        <td>${expiryControl}<div class="api-tip">${formatDateTime(user.apiKeyExpiresAt)}</div></td>
        <td>${actionButtons}</td>
      </tr>
    `;
  }).join('');

  adminUsersBody.querySelectorAll('.js-save-expiry').forEach((button) => {
    button.addEventListener('click', async () => {
      const userId = button.dataset.userId;
      const input = adminUsersBody.querySelector(`.admin-expiry-input[data-user-id="${userId}"]`);
      const value = input?.value;
      if (!value) {
        showFlash('请先填写新的有效期。', 'error');
        return;
      }
      try {
        await requestJson(`/api/admin/users/${userId}/api-key`, {
          method: 'PATCH',
          body: JSON.stringify({ expiresAt: new Date(value).toISOString() }),
        });
        await loadAdminUsers();
        showFlash('有效期已更新。');
      } catch (error) {
        showFlash(error.message, 'error');
      }
    });
  });

  adminUsersBody.querySelectorAll('.js-delete-key').forEach((button) => {
    button.addEventListener('click', async () => {
      const userId = button.dataset.userId;
      const shouldContinue = window.confirm('删除后，该用户当前 API Key 将立即失效。是否继续？');
      if (!shouldContinue) {
        return;
      }
      try {
        await requestJson(`/api/admin/users/${userId}/api-key`, {
          method: 'DELETE',
          body: JSON.stringify({}),
        });
        await loadAdminUsers();
        showFlash('API Key 已删除。');
      } catch (error) {
        showFlash(error.message, 'error');
      }
    });
  });
}

function renderInviteCodes(inviteCodes, inviteQuota) {
  const quota = inviteQuota || state.user?.inviteQuota || null;

  if (quota?.isUnlimited) {
    inviteQuotaBadge.textContent = '管理员无限制';
    inviteQuotaText.textContent = `已生成 ${quota.created ?? 0} 个邀请码`;
    inviteCodeNote.textContent = '管理员可以无限生成邀请码。邀请码被使用后，会在列表中显示被谁使用。';
    generateInviteCodeButton.disabled = false;
  } else if (quota) {
    inviteQuotaBadge.textContent = `剩余 ${quota.remaining}`;
    inviteQuotaText.textContent = `已生成 ${quota.created}/${quota.limit} 个邀请码`;
    inviteCodeNote.textContent = quota.canGenerate
      ? '普通用户最多生成 3 个邀请码。邀请码一旦被使用，会显示使用者信息。'
      : `你的 3 个邀请码额度已经全部用完，当前不能继续生成。`;
    generateInviteCodeButton.disabled = !quota.canGenerate;
  } else {
    inviteQuotaBadge.textContent = '未加载';
    inviteQuotaText.textContent = '-';
    inviteCodeNote.textContent = '邀请码生成后会显示在下方列表中，可直接复制给被邀请用户注册使用。';
    generateInviteCodeButton.disabled = false;
  }

  if (!inviteCodes.length) {
    inviteCodesBody.innerHTML = '<tr><td colspan="5" class="empty-cell">暂无邀请码</td></tr>';
    return;
  }

  inviteCodesBody.innerHTML = inviteCodes.map((invite) => {
    const usedBy = invite.status === 'used'
      ? [invite.usedByName || '-', invite.usedByPhone || ''].filter(Boolean).join('<br />')
      : '<span class="empty-cell">未使用</span>';
    const statusMarkup = invite.status === 'used'
      ? '<span class="status-pill inactive">已使用</span>'
      : '<span class="status-pill active">未使用</span>';

    return `
      <tr>
        <td><code>${invite.code}</code></td>
        <td>${statusMarkup}</td>
        <td>${usedBy}</td>
        <td>${formatDateTime(invite.createdAt)}</td>
        <td>
          <button class="ghost-button js-delete-invite-code" type="button" data-code="${invite.code}">删除</button>
        </td>
      </tr>
    `;
  }).join('');

  inviteCodesBody.querySelectorAll('.js-delete-invite-code').forEach((button) => {
    button.addEventListener('click', async () => {
      const code = String(button.dataset.code || '').trim();
      if (!code) {
        return;
      }
      const shouldContinue = window.confirm(`确定删除邀请码 ${code} 吗？删除后将无法恢复。`);
      if (!shouldContinue) {
        return;
      }
      try {
        button.disabled = true;
        const result = await requestJson(`/api/invite-codes/${encodeURIComponent(code)}`, {
          method: 'DELETE',
          body: JSON.stringify({}),
        });
        state.user = result.user || state.user;
        updateDashboard(state.user);
        state.inviteCodes = result.inviteCodes || [];
        renderInviteCodes(state.inviteCodes, result.inviteQuota || state.user?.inviteQuota || null);
        if (state.user?.role === 'admin') {
          await loadAdminUsers();
        }
        showFlash(result.message || '邀请码已删除。');
      } catch (error) {
        showFlash(error.message, 'error');
      } finally {
        button.disabled = false;
      }
    });
  });
}

function sanitizeAdminInviteSelection() {
  const validCodes = new Set(state.adminInviteCodes.map((invite) => invite.code));
  state.selectedAdminInviteCodes = new Set(
    [...state.selectedAdminInviteCodes].filter((code) => validCodes.has(code)),
  );
}

function getFilteredAdminInviteCodes() {
  const keyword = (adminInviteSearchInput?.value || '').trim().toLowerCase();
  const status = adminInviteStatusFilter?.value || 'all';

  return state.adminInviteCodes.filter((invite) => {
    const matchesStatus = status === 'all' || invite.status === status;
    if (!matchesStatus) {
      return false;
    }

    if (!keyword) {
      return true;
    }

    const haystack = [
      invite.code,
      invite.createdByName,
      invite.createdByRole === 'admin' ? '管理员' : '普通用户',
      invite.usedByName,
      invite.usedByPhone,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    return haystack.includes(keyword);
  });
}

function formatCsvCell(value) {
  const text = String(value ?? '');
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function downloadTextFile(filename, content, contentType = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: contentType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportInviteCodesCsv(inviteCodes, filenamePrefix = 'hyfceph-invite-codes') {
  if (!inviteCodes.length) {
    showFlash('当前没有可导出的邀请码。', 'error');
    return;
  }
  const header = ['邀请码', '创建人', '创建角色', '状态', '使用人', '使用手机号', '创建时间', '使用时间'];
  const lines = inviteCodes.map((invite) => [
    invite.code,
    invite.createdByName || '',
    invite.createdByRole === 'admin' ? '管理员' : '普通用户',
    invite.status === 'used' ? '已使用' : '未使用',
    invite.usedByName || '',
    invite.usedByPhone || '',
    formatDateTime(invite.createdAt),
    invite.usedAt ? formatDateTime(invite.usedAt) : '',
  ]);
  const csv = [header, ...lines]
    .map((row) => row.map(formatCsvCell).join(','))
    .join('\n');
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  downloadTextFile(`${filenamePrefix}-${stamp}.csv`, `\uFEFF${csv}`, 'text/csv;charset=utf-8');
}

function updateAdminInviteExportControls(filteredInvites) {
  if (adminInviteFilterSummary) {
    const total = state.adminInviteCodes.length;
    const filteredCount = filteredInvites.length;
    const selectedCount = [...state.selectedAdminInviteCodes]
      .filter((code) => filteredInvites.some((invite) => invite.code === code))
      .length;
    adminInviteFilterSummary.textContent = total
      ? `共 ${total} 条邀请码，当前显示 ${filteredCount} 条，已选择 ${selectedCount} 条`
      : '共 0 条邀请码';
  }

  if (adminInviteExportAllButton) {
    adminInviteExportAllButton.disabled = !filteredInvites.length;
  }
  if (adminInviteExportSelectedButton) {
    adminInviteExportSelectedButton.disabled = state.selectedAdminInviteCodes.size === 0;
  }
  if (adminInviteSelectAll) {
    if (!filteredInvites.length) {
      adminInviteSelectAll.checked = false;
      adminInviteSelectAll.indeterminate = false;
      adminInviteSelectAll.disabled = true;
      return;
    }
    adminInviteSelectAll.disabled = false;
    const selectedInView = filteredInvites.filter((invite) => state.selectedAdminInviteCodes.has(invite.code)).length;
    adminInviteSelectAll.checked = selectedInView === filteredInvites.length;
    adminInviteSelectAll.indeterminate = selectedInView > 0 && selectedInView < filteredInvites.length;
  }
}

function renderAdminInviteCodes(inviteCodes) {
  sanitizeAdminInviteSelection();
  updateAdminInviteExportControls(inviteCodes);

  if (!inviteCodes.length) {
    const emptyMessage = state.adminInviteCodes.length
      ? '没有符合筛选条件的邀请码'
      : '暂无邀请码数据';
    adminInviteCodesBody.innerHTML = `<tr><td colspan="7" class="empty-cell">${emptyMessage}</td></tr>`;
    return;
  }

  adminInviteCodesBody.innerHTML = inviteCodes.map((invite) => {
    const creatorMarkup = [invite.createdByName || '-', invite.createdByRole === 'admin' ? '管理员' : '普通用户']
      .filter(Boolean)
      .join('<br />');
    const statusMarkup = invite.status === 'used'
      ? '<span class="status-pill inactive">已使用</span>'
      : '<span class="status-pill active">未使用</span>';
    const usedByMarkup = invite.status === 'used'
      ? [invite.usedByName || '-', invite.usedByPhone || '', invite.usedAt ? `使用于 ${formatDateTime(invite.usedAt)}` : '']
        .filter(Boolean)
        .join('<br />')
      : '<span class="empty-cell">-</span>';
    const timeMarkup = [formatDateTime(invite.createdAt), invite.updatedAt ? `更新于 ${formatDateTime(invite.updatedAt)}` : '']
      .filter(Boolean)
      .join('<br />');

    return `
      <tr>
        <td class="admin-table-check">
          <input class="js-admin-invite-select" type="checkbox" data-code="${invite.code}" ${state.selectedAdminInviteCodes.has(invite.code) ? 'checked' : ''} />
        </td>
        <td><code>${invite.code}</code></td>
        <td>${creatorMarkup}</td>
        <td>${statusMarkup}</td>
        <td>${usedByMarkup}</td>
        <td>${timeMarkup}</td>
        <td>
          <button class="ghost-button js-admin-copy-invite-code" type="button" data-code="${invite.code}">复制</button>
          <button class="ghost-button js-admin-delete-invite-code" type="button" data-code="${invite.code}">删除</button>
        </td>
      </tr>
    `;
  }).join('');

  adminInviteCodesBody.querySelectorAll('.js-admin-invite-select').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      const code = String(checkbox.dataset.code || '').trim();
      if (!code) {
        return;
      }
      if (checkbox.checked) {
        state.selectedAdminInviteCodes.add(code);
      } else {
        state.selectedAdminInviteCodes.delete(code);
      }
      updateAdminInviteExportControls(inviteCodes);
    });
  });

  adminInviteCodesBody.querySelectorAll('.js-admin-copy-invite-code').forEach((button) => {
    button.addEventListener('click', async () => {
      const code = String(button.dataset.code || '').trim();
      if (!code) {
        return;
      }
      try {
        await navigator.clipboard.writeText(code);
        showFlash(`邀请码 ${code} 已复制。`);
      } catch {
        showFlash('复制失败，请手动复制邀请码。', 'error');
      }
    });
  });

  adminInviteCodesBody.querySelectorAll('.js-admin-delete-invite-code').forEach((button) => {
    button.addEventListener('click', async () => {
      const code = String(button.dataset.code || '').trim();
      if (!code) {
        return;
      }
      const shouldContinue = window.confirm(`确定删除邀请码 ${code} 吗？删除后将无法恢复。`);
      if (!shouldContinue) {
        return;
      }
      try {
        button.disabled = true;
        const result = await requestJson(`/api/invite-codes/${encodeURIComponent(code)}`, {
          method: 'DELETE',
          body: JSON.stringify({}),
        });
        if (result.user) {
          state.user = result.user;
          updateDashboard(state.user);
        }
        if (result.inviteCodes) {
          state.inviteCodes = result.inviteCodes;
          renderInviteCodes(state.inviteCodes, result.inviteQuota || state.user?.inviteQuota || null);
        } else {
          await loadInviteCodes();
        }
        await loadAdminUsers();
        showFlash(result.message || '邀请码已删除。');
      } catch (error) {
        showFlash(error.message, 'error');
      } finally {
        button.disabled = false;
      }
    });
  });
}

async function loadAdminUsers() {
  if (state.user?.role !== 'admin') {
    state.adminUsers = [];
    state.adminInviteCodes = [];
    state.selectedAdminInviteCodes = new Set();
    adminPanel.classList.add('hidden');
    operatorSyncPanel.classList.add('hidden');
    renderOperatorSyncStatus(null);
    if (adminInviteSearchInput) adminInviteSearchInput.value = '';
    if (adminInviteStatusFilter) adminInviteStatusFilter.value = 'all';
    renderAdminInviteCodes([]);
    return;
  }
  const payload = await requestJson('/api/admin/users', { method: 'GET' });
  state.adminUsers = payload.users || [];
  state.adminInviteCodes = payload.inviteCodes || [];
  sanitizeAdminInviteSelection();
  adminPanel.classList.remove('hidden');
  operatorSyncPanel.classList.remove('hidden');
  renderAdminUsers(state.adminUsers);
  renderAdminInviteCodes(getFilteredAdminInviteCodes());
}

async function loadInviteCodes() {
  if (!state.user) {
    state.inviteCodes = [];
    renderInviteCodes([], null);
    return;
  }

  const payload = await requestJson('/api/invite-codes', { method: 'GET' });
  state.inviteCodes = payload.inviteCodes || [];
  state.user = payload.user || state.user;
  updateDashboard(state.user);
  renderInviteCodes(state.inviteCodes, payload.inviteQuota || state.user?.inviteQuota || null);
}

async function loadOperatorSyncStatus() {
  if (state.user?.role !== 'admin') {
    renderOperatorSyncStatus(null);
    return;
  }

  try {
    const payload = await requestJson('/api/admin/operator-session', {
      method: 'GET',
    });
    renderOperatorSyncStatus(payload.operatorSession || null);
  } catch {
    renderOperatorSyncStatus(null);
  }
}

async function syncAuthUi() {
  document.body.classList.toggle('dashboard-mode', Boolean(state.user));
  document.body.classList.toggle('admin-mode', state.user?.role === 'admin');
  dashboardTab.classList.toggle('hidden', !state.user);
  if (state.user) {
    const isAdmin = state.user.role === 'admin';
    dashboardMenuItems.forEach((item) => {
      if (item.dataset.adminOnly === 'true') {
        item.classList.toggle('hidden', !isAdmin);
      }
    });
    dashboardViews.forEach((panel) => {
      if (panel.dataset.adminOnly === 'true' && !isAdmin && panel.dataset.dashboardPanel === state.dashboardView) {
        state.dashboardView = 'weixin';
      }
    });
    registerTab.classList.add('hidden');
    loginTab.classList.add('hidden');
    updateDashboard(state.user);
    renderWeixinBinding();
    ensureWeixinBindingReadinessPolling();
    measurePanel.classList.toggle('hidden', !isAdmin);
    operatorSyncPanel.classList.toggle('hidden', !isAdmin);
    adminPanel.classList.toggle('hidden', !isAdmin);
    setActiveTab('dashboard');
    setDashboardView(state.dashboardView || 'weixin');
    await loadInviteCodes();
    await loadOperatorSyncStatus();
    await loadAdminUsers();
  } else {
    state.weixinBindingSession = null;
    state.inviteCodes = [];
    state.adminInviteCodes = [];
    state.selectedAdminInviteCodes = new Set();
    stopWeixinBindingPolling();
    stopWeixinBindingReadinessPolling();
    renderOperatorSyncStatus(null);
    renderWeixinBinding();
    renderInviteCodes([], null);
    renderAdminInviteCodes([]);
    measurePanel.classList.add('hidden');
    operatorSyncPanel.classList.add('hidden');
    adminPanel.classList.add('hidden');
    adminUsersBody.innerHTML = '<tr><td colspan="6" class="empty-cell">暂无数据</td></tr>';
    registerTab.classList.remove('hidden');
    loginTab.classList.remove('hidden');
    state.dashboardView = 'weixin';
    setActiveTab('register');
  }
}

async function loadCurrentUser() {
  try {
    const payload = await requestJson('/api/me', { method: 'GET' });
    state.user = payload.user;
  } catch {
    state.user = null;
  }
  resetMeasureResult();
  renderWeixinBinding();
  await syncAuthUi();
}

tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    clearFlash();
    setActiveTab(tab.dataset.tab);
  });
});

dashboardMenuItems.forEach((item) => {
  item.addEventListener('click', () => {
    if (item.classList.contains('hidden')) {
      return;
    }
    clearFlash();
    setDashboardView(item.dataset.dashboardView);
  });
});

adminInviteSearchInput?.addEventListener('input', () => {
  renderAdminInviteCodes(getFilteredAdminInviteCodes());
});

adminInviteStatusFilter?.addEventListener('change', () => {
  renderAdminInviteCodes(getFilteredAdminInviteCodes());
});

adminInviteSelectAll?.addEventListener('change', () => {
  const filteredInvites = getFilteredAdminInviteCodes();
  if (adminInviteSelectAll.checked) {
    filteredInvites.forEach((invite) => state.selectedAdminInviteCodes.add(invite.code));
  } else {
    filteredInvites.forEach((invite) => state.selectedAdminInviteCodes.delete(invite.code));
  }
  renderAdminInviteCodes(filteredInvites);
});

adminInviteExportAllButton?.addEventListener('click', () => {
  exportInviteCodesCsv(getFilteredAdminInviteCodes(), 'hyfceph-invite-codes-filtered');
});

adminInviteExportSelectedButton?.addEventListener('click', () => {
  const selectedInvites = state.adminInviteCodes.filter((invite) => state.selectedAdminInviteCodes.has(invite.code));
  exportInviteCodesCsv(selectedInvites, 'hyfceph-invite-codes-selected');
});

registerForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearFlash();
  const formData = new FormData(registerForm);
  const payload = Object.fromEntries(formData.entries());
  try {
    const result = await requestJson('/api/register', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    state.user = result.user;
    await syncAuthUi();
    showFlash(result.message || '注册成功。');
    registerForm.reset();
  } catch (error) {
    showFlash(error.message, 'error');
  }
});

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearFlash();
  const formData = new FormData(loginForm);
  const payload = Object.fromEntries(formData.entries());
  try {
    const result = await requestJson('/api/login', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    state.user = result.user;
    await syncAuthUi();
    showFlash(result.message || '登录成功。');
    loginForm.reset();
  } catch (error) {
    showFlash(error.message, 'error');
  }
});

logoutButton.addEventListener('click', async () => {
  clearFlash();
  await requestJson('/api/logout', { method: 'POST', body: JSON.stringify({}) });
  state.user = null;
  await syncAuthUi();
  showFlash('已退出登录。');
});

generateKeyButton.addEventListener('click', async () => {
  clearFlash();
  if (state.user?.apiKey) {
    const shouldContinue = window.confirm('重新生成后，旧 API Key 会失效。是否继续？');
    if (!shouldContinue) {
      return;
    }
  }

  try {
    const result = await requestJson('/api/api-key/generate', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    state.user = result.user;
    updateDashboard(state.user);
    await loadOperatorSyncStatus();
    if (state.user.role === 'admin') {
      await loadAdminUsers();
    }
    showFlash(result.message || 'API Key 已生成。');
  } catch (error) {
    showFlash(error.message, 'error');
  }
});

generateInviteCodeButton?.addEventListener('click', async () => {
  clearFlash();
  try {
    generateInviteCodeButton.disabled = true;
    const result = await requestJson('/api/invite-codes', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    state.user = result.user || state.user;
    updateDashboard(state.user);
    state.inviteCodes = result.inviteCodes || [];
    renderInviteCodes(state.inviteCodes, result.inviteQuota || state.user?.inviteQuota || null);
    if (state.user?.role === 'admin') {
      await loadAdminUsers();
    }
    showFlash(result.message || '邀请码已生成。');
  } catch (error) {
    showFlash(error.message, 'error');
  } finally {
    generateInviteCodeButton.disabled = false;
  }
});

copyKeyButton.addEventListener('click', async () => {
  const value = apiKeyOutput.value.trim();
  if (!value) {
    showFlash('请先生成 API Key。', 'error');
    return;
  }
  try {
    await navigator.clipboard.writeText(value);
    showFlash('API Key 已复制。');
  } catch {
    showFlash('复制失败，请手动复制。', 'error');
  }
});

copySkillLinkButton?.addEventListener('click', async () => {
  const value = String(copySkillLinkButton.dataset.copyText || '').trim();
  if (!value) {
    showFlash('当前没有可复制的 Skill 直链。', 'error');
    return;
  }

  try {
    await navigator.clipboard.writeText(value);
    showFlash('Skill 直链已复制。把它粘贴到 OpenClaw 对话框中发送即可安装。');
  } catch {
    showFlash('复制失败，请手动复制直链。', 'error');
  }
});

weixinBindingStartButton?.addEventListener('click', async () => {
  clearFlash();
  try {
    weixinBindingStartButton.disabled = true;
    const payload = await requestJson('/api/weixin/binding/start', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    state.weixinBindingSession = payload.session || null;
    stopWeixinBindingReadinessPolling();
    renderWeixinBinding();
    ensureWeixinBindingPolling();
    showFlash('绑定二维码已生成，请用微信扫码。');
  } catch (error) {
    showFlash(error.message, 'error');
  } finally {
    weixinBindingStartButton.disabled = false;
  }
});

weixinBindingRefreshButton?.addEventListener('click', async () => {
  clearFlash();
  try {
    await refreshWeixinBindingStatus();
    showFlash('微信绑定状态已刷新。');
  } catch (error) {
    showFlash(error.message, 'error');
  }
});

weixinBindingDeleteButton?.addEventListener('click', async () => {
  clearFlash();
  const shouldContinue = window.confirm('解绑后，这个微信账号将不能继续在 Clawbot 中使用 HYFCeph。是否继续？');
  if (!shouldContinue) {
    return;
  }
  try {
    await requestJson('/api/weixin/binding', {
      method: 'DELETE',
      body: JSON.stringify({}),
    });
    state.weixinBindingSession = null;
    stopWeixinBindingPolling();
    stopWeixinBindingReadinessPolling();
    if (state.user) {
      state.user.weixinBinding = null;
      state.user.updatedAt = new Date().toISOString();
    }
    renderWeixinBinding();
    showFlash('微信绑定已解除。');
  } catch (error) {
    showFlash(error.message, 'error');
  }
});

refreshAdminButton.addEventListener('click', async () => {
  clearFlash();
  try {
    await loadAdminUsers();
    await loadOperatorSyncStatus();
    showFlash('列表已刷新。');
  } catch (error) {
    showFlash(error.message, 'error');
  }
});

measureImageButton.addEventListener('click', async () => {
  clearFlash();
  const apiKey = state.user?.apiKey || '';
  const file = measureImageInput.files?.[0];
  if (!apiKey) {
    showFlash('请先生成 API Key。', 'error');
    return;
  }
  if (!file) {
    showFlash('请先选择一张侧位片。', 'error');
    return;
  }

  try {
    measureImageButton.disabled = true;
    const imageBase64 = await readFileAsBase64(file);
    const payload = await requestJson('/api/measure/image', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
      },
      body: JSON.stringify({
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        imageBase64,
      }),
    });
    renderMeasureResult(payload.result);
    showFlash('图片测量完成。');
    measureImageInput.value = '';
  } catch (error) {
    showFlash(error.message, 'error');
  } finally {
    measureImageButton.disabled = false;
  }
});

refreshOperatorSyncButton.addEventListener('click', async () => {
  clearFlash();
  try {
    await loadOperatorSyncStatus();
    showFlash('浏览器同步状态已刷新。');
  } catch (error) {
    showFlash(error.message, 'error');
  }
});

clearOperatorSyncButton.addEventListener('click', async () => {
  clearFlash();
  const shouldContinue = window.confirm('清除后，公开用户的远程测量会暂时不可用，直到扩展重新同步。是否继续？');
  if (!shouldContinue) {
    return;
  }
  try {
    await requestJson('/api/admin/operator-session', {
      method: 'DELETE',
      body: JSON.stringify({}),
    });
    await loadOperatorSyncStatus();
    showFlash('远程会话已清除。');
  } catch (error) {
    showFlash(error.message, 'error');
  }
});

loadCurrentUser();
