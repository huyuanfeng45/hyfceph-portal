const state = {
  user: null,
  adminUsers: [],
  measurements: [],
  activeMeasurementId: null,
  activeView: 'overview',
};

const marketingShell = document.querySelector('.hero');
const portalApp = document.querySelector('#portal-app');
const authFlash = document.querySelector('#flash');
const portalFlash = document.querySelector('#portal-flash');
const authTabs = Array.from(document.querySelectorAll('.tab'));
const authPanels = Array.from(document.querySelectorAll('.tab-panel'));
const workspaceTabs = Array.from(document.querySelectorAll('.workspace-tab'));
const workspaceViews = Array.from(document.querySelectorAll('.workspace-view'));
const registerForm = document.querySelector('#register-form');
const loginForm = document.querySelector('#login-form');
const logoutButton = document.querySelector('#logout-button');
const generateKeyButton = document.querySelector('#generate-key-button');
const copyKeyButton = document.querySelector('#copy-key-button');
const apiKeyOutput = document.querySelector('#api-key-output');
const apiKeyExpiry = document.querySelector('#api-key-expiry');
const measureImageInput = document.querySelector('#measure-image-input');
const measureImageButton = document.querySelector('#measure-image-button');
const measureDropzone = document.querySelector('#measure-dropzone');
const viewerEmptyState = document.querySelector('#viewer-empty-state');
const activeMeasurementTitle = document.querySelector('#active-measurement-title');
const activeMeasurementSubtitle = document.querySelector('#active-measurement-subtitle');
const measureRiskLabel = document.querySelector('#measure-risk-label');
const measureInsight = document.querySelector('#measure-insight');
const measureImage = document.querySelector('#measure-image');
const measureMetrics = document.querySelector('#measure-metrics');
const measurementHistoryList = document.querySelector('#measurement-history-list');
const measurementHistoryEmpty = document.querySelector('#measurement-history-empty');
const measurementCountBadge = document.querySelector('#measurement-count-badge');
const workspaceUserName = document.querySelector('#workspace-user-name');
const workspaceUserRole = document.querySelector('#workspace-user-role');
const userName = document.querySelector('#user-name');
const userOrganization = document.querySelector('#user-organization');
const userPhone = document.querySelector('#user-phone');
const userRole = document.querySelector('#user-role');
const userMeasurementCount = document.querySelector('#user-measurement-count');
const operatorSyncStatus = document.querySelector('#operator-sync-status');
const operatorSyncDetail = document.querySelector('#operator-sync-detail');
const refreshOperatorSyncButton = document.querySelector('#refresh-operator-sync-button');
const clearOperatorSyncButton = document.querySelector('#clear-operator-sync-button');
const refreshAdminButton = document.querySelector('#refresh-admin-button');
const adminUsersBody = document.querySelector('#admin-users-body');

function getActiveFlash() {
  return state.user ? portalFlash : authFlash;
}

function showFlash(message, type = 'success', target = getActiveFlash()) {
  target.textContent = message;
  target.classList.remove('hidden', 'error');
  if (type === 'error') {
    target.classList.add('error');
  } else {
    target.classList.remove('error');
  }
}

function clearFlash(target = getActiveFlash()) {
  target.textContent = '';
  target.classList.add('hidden');
  target.classList.remove('error');
}

function setAuthTab(tabName) {
  authTabs.forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.tab === tabName);
  });
  authPanels.forEach((panel) => {
    panel.classList.toggle('active', panel.dataset.panel === tabName);
    panel.classList.toggle('hidden', panel.dataset.panel !== tabName);
  });
}

function setWorkspaceView(viewName) {
  const isAdmin = state.user?.role === 'admin';
  const safeView = viewName === 'admin' && !isAdmin ? 'overview' : viewName;
  state.activeView = safeView;
  workspaceTabs.forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.view === safeView);
  });
  workspaceViews.forEach((panel) => {
    panel.classList.toggle('active', panel.dataset.viewPanel === safeView);
    panel.classList.toggle('hidden', panel.dataset.viewPanel !== safeView);
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

function buildMetricMarkup(metrics) {
  if (!metrics.length) {
    return '<div class="empty-cell">本次未返回可展示的测量值。</div>';
  }
  return metrics.map((metric) => `
    <article class="metric-chip metric-${metric.tone || 'default'}">
      <div class="metric-code">${metric.code}</div>
      <div class="metric-value">${metric.valueText}</div>
      <div class="metric-label">${metric.label}</div>
    </article>
  `).join('');
}

function updateDashboard(user) {
  const roleText = user?.role === 'admin' ? '管理员' : '普通用户';
  userName.textContent = user?.name || '-';
  userOrganization.textContent = user?.organization || '-';
  userPhone.textContent = user?.phone || user?.username || '-';
  userRole.textContent = roleText;
  userMeasurementCount.textContent = String(user?.measurementCount || 0);
  workspaceUserName.textContent = user?.name || '-';
  workspaceUserRole.textContent = roleText;

  apiKeyOutput.value = user?.apiKey || '';
  apiKeyOutput.placeholder = user?.apiKey ? '' : '还没有 API Key，点击下方按钮生成。';
  apiKeyExpiry.textContent = user?.apiKeyExpiresAt ? formatDateTime(user.apiKeyExpiresAt) : '-';
  generateKeyButton.textContent = user?.apiKey ? '重新生成 API Key' : '生成 API Key';
}

function resetMeasurementViewer() {
  state.activeMeasurementId = null;
  activeMeasurementTitle.textContent = '尚未开始测量';
  activeMeasurementSubtitle.textContent = '上传一张侧位片后，这里会显示标注图和本次测量时间。';
  measureRiskLabel.textContent = '尚未分析';
  measureInsight.textContent = '完成测量后，这里会给出简明的骨性与牙性判断摘要。';
  measureMetrics.innerHTML = buildMetricMarkup([]);
  measureImage.classList.add('hidden');
  measureImage.removeAttribute('src');
  viewerEmptyState.classList.remove('hidden');
}

function renderMeasurementHistory() {
  const measurements = Array.isArray(state.measurements) ? state.measurements : [];
  measurementCountBadge.textContent = String(measurements.length);
  userMeasurementCount.textContent = String(measurements.length);

  if (!measurements.length) {
    measurementHistoryList.innerHTML = '';
    measurementHistoryEmpty.classList.remove('hidden');
    if (!state.activeMeasurementId) {
      resetMeasurementViewer();
    }
    return;
  }

  measurementHistoryEmpty.classList.add('hidden');
  measurementHistoryList.innerHTML = measurements.map((measurement) => {
    const values = Object.entries(measurement.metricValues || {})
      .slice(0, 3)
      .map(([key, value]) => `${key} ${value}`)
      .join(' · ');
    return `
      <button class="history-item ${measurement.id === state.activeMeasurementId ? 'active' : ''}" type="button" data-measurement-id="${measurement.id}">
        <div class="history-item-top">
          <strong>${measurement.imageName}</strong>
          <span>${formatDateTime(measurement.createdAt)}</span>
        </div>
        <div class="history-item-body">
          <span>${measurement.riskLabel || '未生成结论'}</span>
          <small>${values || (measurement.insightPreview || '点击查看详情')}</small>
        </div>
      </button>
    `;
  }).join('');

  measurementHistoryList.querySelectorAll('.history-item').forEach((button) => {
    button.addEventListener('click', async () => {
      const measurementId = button.dataset.measurementId;
      if (!measurementId) return;
      clearFlash(portalFlash);
      try {
        await loadMeasurementDetail(measurementId);
      } catch (error) {
        showFlash(error.message, 'error', portalFlash);
      }
    });
  });
}

function renderMeasurementDetail(measurement, result) {
  state.activeMeasurementId = measurement?.id || null;
  renderMeasurementHistory();

  const analysis = result?.analysis || {};
  const metrics = result?.metrics || analysis.metrics || [];
  const artifacts = result?.artifacts || {};
  const pngSrc = artifacts.annotatedPngBase64
    ? `data:${artifacts.annotatedPngMimeType || 'image/png'};base64,${artifacts.annotatedPngBase64}`
    : '';
  const svgSrc = artifacts.annotatedSvgBase64
    ? `data:${artifacts.annotatedSvgMimeType || 'image/svg+xml'};base64,${artifacts.annotatedSvgBase64}`
    : '';

  activeMeasurementTitle.textContent = measurement?.imageName || '当前测量';
  activeMeasurementSubtitle.textContent = [
    measurement?.createdAt ? `测量于 ${formatDateTime(measurement.createdAt)}` : '',
    measurement?.riskLabel || analysis?.riskLabel || '',
  ].filter(Boolean).join(' · ') || '已完成分析';

  measureRiskLabel.textContent = analysis.riskLabel || measurement?.riskLabel || '未生成结论';
  measureInsight.textContent = analysis.insight || measurement?.insightPreview || '本次服务端测量已完成。';
  measureMetrics.innerHTML = buildMetricMarkup(metrics);

  if (pngSrc || svgSrc) {
    measureImage.src = pngSrc || svgSrc;
    measureImage.classList.remove('hidden');
    viewerEmptyState.classList.add('hidden');
  } else {
    measureImage.classList.add('hidden');
    measureImage.removeAttribute('src');
    viewerEmptyState.classList.remove('hidden');
  }
}

function renderOperatorSyncStatus(operatorSession) {
  if (!operatorSession) {
    operatorSyncStatus.textContent = '未连接';
    operatorSyncDetail.textContent = '扩展开始同步后，这里会显示最近一次同步时间和操作者信息。';
    return;
  }
  operatorSyncStatus.textContent = operatorSession.active ? '在线' : '已过期';
  operatorSyncDetail.textContent = [
    operatorSession.userName ? `用户 ${operatorSession.userName}` : '',
    operatorSession.accountType ? `类型 ${operatorSession.accountType}` : '',
    operatorSession.syncedAt ? `同步于 ${formatDateTime(operatorSession.syncedAt)}` : '',
    operatorSession.expiresAt ? `过期于 ${formatDateTime(operatorSession.expiresAt)}` : '',
  ].filter(Boolean).join('，') || '扩展已连接，但暂无更多细节。';
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
    adminUsersBody.innerHTML = '<tr><td colspan="5" class="empty-cell">暂无数据</td></tr>';
    return;
  }

  adminUsersBody.innerHTML = users.map((user) => {
    const displayName = user.role === 'admin' ? `${user.name}（管理员）` : user.name;
    const identifier = [user.organization || '-', user.phone || user.username || '-'].join('<br />');
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
        showFlash('请先填写新的有效期。', 'error', portalFlash);
        return;
      }
      try {
        await requestJson(`/api/admin/users/${userId}/api-key`, {
          method: 'PATCH',
          body: JSON.stringify({ expiresAt: new Date(value).toISOString() }),
        });
        await loadAdminUsers();
        showFlash('有效期已更新。', 'success', portalFlash);
      } catch (error) {
        showFlash(error.message, 'error', portalFlash);
      }
    });
  });

  adminUsersBody.querySelectorAll('.js-delete-key').forEach((button) => {
    button.addEventListener('click', async () => {
      const userId = button.dataset.userId;
      const shouldContinue = window.confirm('删除后，该用户当前 API Key 将立即失效。是否继续？');
      if (!shouldContinue) return;
      try {
        await requestJson(`/api/admin/users/${userId}/api-key`, {
          method: 'DELETE',
          body: JSON.stringify({}),
        });
        await loadAdminUsers();
        showFlash('API Key 已删除。', 'success', portalFlash);
      } catch (error) {
        showFlash(error.message, 'error', portalFlash);
      }
    });
  });
}

async function loadAdminUsers() {
  if (state.user?.role !== 'admin') {
    state.adminUsers = [];
    adminUsersBody.innerHTML = '<tr><td colspan="5" class="empty-cell">暂无数据</td></tr>';
    return;
  }
  const payload = await requestJson('/api/admin/users', { method: 'GET' });
  state.adminUsers = payload.users || [];
  renderAdminUsers(state.adminUsers);
}

async function loadOperatorSyncStatus() {
  if (state.user?.role !== 'admin') {
    renderOperatorSyncStatus(null);
    return;
  }
  try {
    const payload = await requestJson('/api/admin/operator-session', { method: 'GET' });
    renderOperatorSyncStatus(payload.operatorSession || null);
  } catch {
    renderOperatorSyncStatus(null);
  }
}

function upsertMeasurementSummary(measurement) {
  if (!measurement?.id) return;
  const next = [measurement, ...state.measurements.filter((item) => item.id !== measurement.id)];
  state.measurements = next.sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
  if (state.user) {
    state.user.measurementCount = state.measurements.length;
  }
}

async function loadMeasurements() {
  if (!state.user) {
    state.measurements = [];
    renderMeasurementHistory();
    return;
  }
  const payload = await requestJson('/api/measurements', { method: 'GET' });
  state.measurements = Array.isArray(payload.measurements) ? payload.measurements : [];
  if (state.user) {
    state.user.measurementCount = state.measurements.length;
  }
  renderMeasurementHistory();
}

async function loadMeasurementDetail(measurementId) {
  const payload = await requestJson(`/api/measurements/${encodeURIComponent(measurementId)}`, { method: 'GET' });
  renderMeasurementDetail(payload.measurement || null, payload.result || null);
}

function toggleShells() {
  const loggedIn = Boolean(state.user);
  marketingShell.classList.toggle('hidden', loggedIn);
  portalApp.classList.toggle('hidden', !loggedIn);
}

async function syncAuthUi() {
  toggleShells();
  if (!state.user) {
    setAuthTab('register');
    resetMeasurementViewer();
    renderMeasurementHistory();
    clearFlash(portalFlash);
    return;
  }

  updateDashboard(state.user);
  workspaceTabs.forEach((tab) => {
    if (tab.dataset.view === 'admin') {
      tab.classList.toggle('hidden', state.user.role !== 'admin');
    }
  });

  await Promise.all([
    loadMeasurements(),
    loadOperatorSyncStatus(),
    loadAdminUsers(),
  ]);

  if (state.measurements.length) {
    await loadMeasurementDetail(state.measurements[0].id);
  } else {
    resetMeasurementViewer();
  }

  setWorkspaceView(state.activeView);
}

async function loadCurrentUser() {
  try {
    const payload = await requestJson('/api/me', { method: 'GET' });
    state.user = payload.user;
  } catch {
    state.user = null;
  }
  await syncAuthUi();
}

authTabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    clearFlash(authFlash);
    setAuthTab(tab.dataset.tab);
  });
});

workspaceTabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    clearFlash(portalFlash);
    setWorkspaceView(tab.dataset.view);
  });
});

registerForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearFlash(authFlash);
  const payload = Object.fromEntries(new FormData(registerForm).entries());
  try {
    const result = await requestJson('/api/register', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    state.user = result.user;
    state.activeView = 'overview';
    registerForm.reset();
    await syncAuthUi();
    showFlash(result.message || '注册成功。', 'success', portalFlash);
  } catch (error) {
    showFlash(error.message, 'error', authFlash);
  }
});

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearFlash(authFlash);
  const payload = Object.fromEntries(new FormData(loginForm).entries());
  try {
    const result = await requestJson('/api/login', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    state.user = result.user;
    state.activeView = 'overview';
    loginForm.reset();
    await syncAuthUi();
    showFlash(result.message || '登录成功。', 'success', portalFlash);
  } catch (error) {
    showFlash(error.message, 'error', authFlash);
  }
});

logoutButton.addEventListener('click', async () => {
  clearFlash(portalFlash);
  await requestJson('/api/logout', { method: 'POST', body: JSON.stringify({}) });
  state.user = null;
  state.measurements = [];
  state.activeMeasurementId = null;
  state.activeView = 'overview';
  await syncAuthUi();
  showFlash('已退出登录。', 'success', authFlash);
});

generateKeyButton.addEventListener('click', async () => {
  clearFlash(portalFlash);
  if (state.user?.apiKey) {
    const shouldContinue = window.confirm('重新生成后，旧 API Key 会失效。是否继续？');
    if (!shouldContinue) return;
  }

  try {
    const result = await requestJson('/api/api-key/generate', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    state.user = result.user;
    updateDashboard(state.user);
    await loadAdminUsers();
    await loadOperatorSyncStatus();
    showFlash(result.message || 'API Key 已生成。', 'success', portalFlash);
  } catch (error) {
    showFlash(error.message, 'error', portalFlash);
  }
});

copyKeyButton.addEventListener('click', async () => {
  const value = apiKeyOutput.value.trim();
  if (!value) {
    showFlash('请先生成 API Key。', 'error', portalFlash);
    return;
  }
  try {
    await navigator.clipboard.writeText(value);
    showFlash('API Key 已复制。', 'success', portalFlash);
  } catch {
    showFlash('复制失败，请手动复制。', 'error', portalFlash);
  }
});

measureDropzone.addEventListener('dragover', (event) => {
  event.preventDefault();
  measureDropzone.classList.add('dragover');
});

measureDropzone.addEventListener('dragleave', () => {
  measureDropzone.classList.remove('dragover');
});

measureDropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  measureDropzone.classList.remove('dragover');
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;
  const transfer = new DataTransfer();
  transfer.items.add(file);
  measureImageInput.files = transfer.files;
});

measureImageButton.addEventListener('click', async () => {
  clearFlash(portalFlash);
  const file = measureImageInput.files?.[0];
  if (!file) {
    showFlash('请先选择一张侧位片。', 'error', portalFlash);
    return;
  }

  try {
    measureImageButton.disabled = true;
    setWorkspaceView('workspace');
    const imageBase64 = await readFileAsBase64(file);
    const payload = await requestJson('/api/measure/image', {
      method: 'POST',
      body: JSON.stringify({
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        imageBase64,
      }),
    });
    if (payload.measurement) {
      upsertMeasurementSummary(payload.measurement);
    }
    renderMeasurementDetail(payload.measurement || null, payload.result || null);
    renderMeasurementHistory();
    measureImageInput.value = '';
    showFlash('图片测量完成，已自动归档到你的账户。', 'success', portalFlash);
  } catch (error) {
    showFlash(error.message, 'error', portalFlash);
  } finally {
    measureImageButton.disabled = false;
  }
});

refreshOperatorSyncButton.addEventListener('click', async () => {
  clearFlash(portalFlash);
  try {
    await loadOperatorSyncStatus();
    showFlash('浏览器同步状态已刷新。', 'success', portalFlash);
  } catch (error) {
    showFlash(error.message, 'error', portalFlash);
  }
});

clearOperatorSyncButton.addEventListener('click', async () => {
  clearFlash(portalFlash);
  const shouldContinue = window.confirm('清除后，在线测量会暂时不可用，直到扩展重新同步。是否继续？');
  if (!shouldContinue) return;
  try {
    await requestJson('/api/admin/operator-session', {
      method: 'DELETE',
      body: JSON.stringify({}),
    });
    await loadOperatorSyncStatus();
    showFlash('远程会话已清除。', 'success', portalFlash);
  } catch (error) {
    showFlash(error.message, 'error', portalFlash);
  }
});

refreshAdminButton.addEventListener('click', async () => {
  clearFlash(portalFlash);
  try {
    await loadAdminUsers();
    await loadOperatorSyncStatus();
    showFlash('列表已刷新。', 'success', portalFlash);
  } catch (error) {
    showFlash(error.message, 'error', portalFlash);
  }
});

loadCurrentUser();
