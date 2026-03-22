const portalBaseUrlInput = document.getElementById('portalBaseUrl');
const operatorApiKeyInput = document.getElementById('operatorApiKey');
const saveBtn = document.getElementById('saveBtn');
const syncBtn = document.getElementById('syncBtn');
const pageStateEl = document.getElementById('pageState');
const syncStateEl = document.getElementById('syncState');
const detailEl = document.getElementById('detail');

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      resolve(response);
    });
  });
}

function setDetail(text) {
  detailEl.textContent = text || '';
}

function renderStatus(payload) {
  const activeTab = payload?.activeTab || {};
  const lastStatus = payload?.lastStatus || null;

  pageStateEl.textContent = activeTab.supported ? '已就绪' : '未就绪';
  syncStateEl.textContent = lastStatus?.ok ? '在线' : (lastStatus ? '异常' : '未同步');

  if (!activeTab.supported) {
    setDetail(activeTab.label || '请先打开侧位片网页。');
    return;
  }

  if (lastStatus?.ok) {
    const details = [
      lastStatus.operatorSession?.userName ? `操作者：${lastStatus.operatorSession.userName}` : '',
      lastStatus.operatorSession?.syncedAt ? `最近同步：${new Date(lastStatus.operatorSession.syncedAt).toLocaleString('zh-CN')}` : '',
      lastStatus.operatorSession?.expiresAt ? `过期：${new Date(lastStatus.operatorSession.expiresAt).toLocaleString('zh-CN')}` : '',
    ].filter(Boolean);
    setDetail(details.join('\n') || '同步成功。');
    return;
  }

  setDetail(lastStatus?.message || '请先保存管理员 API Key，然后点击“立即同步”。');
}

async function loadState() {
  const response = await sendMessage({ type: 'hyfceph:get-state' });
  if (!response?.ok) {
    throw new Error(response?.error || '加载扩展状态失败。');
  }

  portalBaseUrlInput.value = response.portalBaseUrl || '';
  operatorApiKeyInput.value = response.operatorApiKey || '';
  renderStatus(response);
}

async function saveConfig() {
  const response = await sendMessage({
    type: 'hyfceph:save-config',
    portalBaseUrl: portalBaseUrlInput.value.trim(),
    operatorApiKey: operatorApiKeyInput.value.trim(),
  });
  if (!response?.ok) {
    throw new Error(response?.error || '保存失败。');
  }
  setDetail('配置已保存。');
}

async function forceSync() {
  const response = await sendMessage({ type: 'hyfceph:force-sync' });
  if (!response?.ok) {
    throw new Error(response?.error || '同步失败。');
  }
  await loadState();
}

saveBtn.addEventListener('click', async () => {
  try {
    await saveConfig();
    await loadState();
  } catch (error) {
    setDetail(error instanceof Error ? error.message : String(error));
  }
});

syncBtn.addEventListener('click', async () => {
  try {
    setDetail('正在同步...');
    await forceSync();
  } catch (error) {
    setDetail(error instanceof Error ? error.message : String(error));
  }
});

loadState().catch((error) => {
  setDetail(error instanceof Error ? error.message : String(error));
});
