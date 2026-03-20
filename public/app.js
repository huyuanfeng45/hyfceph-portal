const state = {
  user: null,
  adminUsers: [],
};

const flash = document.querySelector('#flash');
const tabs = Array.from(document.querySelectorAll('.tab'));
const panels = Array.from(document.querySelectorAll('.tab-panel'));
const registerForm = document.querySelector('#register-form');
const loginForm = document.querySelector('#login-form');
const logoutButton = document.querySelector('#logout-button');
const generateKeyButton = document.querySelector('#generate-key-button');
const copyKeyButton = document.querySelector('#copy-key-button');
const apiKeyOutput = document.querySelector('#api-key-output');
const apiKeyExpiry = document.querySelector('#api-key-expiry');
const refreshAdminButton = document.querySelector('#refresh-admin-button');
const adminPanel = document.querySelector('#admin-panel');
const adminUsersBody = document.querySelector('#admin-users-body');

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
  apiKeyOutput.value = user?.apiKey || '';
  apiKeyOutput.placeholder = user?.apiKey
    ? ''
    : '还没有 API Key，点击下方按钮生成。';
  apiKeyExpiry.textContent = user?.apiKeyExpiresAt ? formatDateTime(user.apiKeyExpiresAt) : '-';
  generateKeyButton.textContent = user?.apiKey ? '重新生成 API Key' : '生成 API Key';
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

function renderAdminUsers(users) {
  if (!users.length) {
    adminUsersBody.innerHTML = '<tr><td colspan="5" class="empty-cell">暂无数据</td></tr>';
    return;
  }

  adminUsersBody.innerHTML = users.map((user) => {
    const displayName = user.role === 'admin'
      ? `${user.name}（管理员）`
      : user.name;
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

async function loadAdminUsers() {
  if (state.user?.role !== 'admin') {
    state.adminUsers = [];
    adminPanel.classList.add('hidden');
    return;
  }
  const payload = await requestJson('/api/admin/users', { method: 'GET' });
  state.adminUsers = payload.users || [];
  adminPanel.classList.remove('hidden');
  renderAdminUsers(state.adminUsers);
}

async function syncAuthUi() {
  const dashboardTab = document.querySelector('[data-tab="dashboard"]');
  dashboardTab.classList.toggle('hidden', !state.user);
  if (state.user) {
    updateDashboard(state.user);
    setActiveTab('dashboard');
    await loadAdminUsers();
  } else {
    adminPanel.classList.add('hidden');
    adminUsersBody.innerHTML = '<tr><td colspan="5" class="empty-cell">暂无数据</td></tr>';
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
  await syncAuthUi();
}

tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    clearFlash();
    setActiveTab(tab.dataset.tab);
  });
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
    if (state.user.role === 'admin') {
      await loadAdminUsers();
    }
    showFlash(result.message || 'API Key 已生成。');
  } catch (error) {
    showFlash(error.message, 'error');
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

refreshAdminButton.addEventListener('click', async () => {
  clearFlash();
  try {
    await loadAdminUsers();
    showFlash('列表已刷新。');
  } catch (error) {
    showFlash(error.message, 'error');
  }
});

loadCurrentUser();
