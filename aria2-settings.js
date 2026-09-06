(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const extensionApi = globalThis.chrome;
  const rpcApi = globalThis.Aria2Rpc;
  const params = new URLSearchParams(location.search);
  const embedded = params.get('embedded') === '1';
  let settingsSection = params.get('section') === 'rpc' ? 'rpc' : 'global';
  let rpcOnly = settingsSection === 'rpc';
  document.body.classList.toggle('embedded', embedded);
  const COLORS = ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#007aff', '#af52de', '#8e8e93'];
  const DEFAULT_ARIA2_TRACKER_SUBSCRIPTION = 'https://ngosang.github.io/trackerslist/trackers_best.txt';
  const storageKeys = {
    aria2Rpc: rpcApi?.DEFAULT_RPC || 'http://localhost:6800/jsonrpc',
    aria2Secret: '',
    aria2CustomSaveEnabled: false,
    aria2SaveLocations: [],
    aria2TrackerSubscriptions: [DEFAULT_ARIA2_TRACKER_SUBSCRIPTION],
    aria2Trackers: [],
    aria2PanelConnections: '',
    aria2PanelDownloadLimit: '',
    aria2PanelUploadLimit: '',
  };
  let loadedSettings = { ...storageKeys };

  const globalControls = [
    $('saveSettingsGroup'),
    $('trackerSettingsGroup'),
    $('transferSettingsGroup'),
    document.querySelector('.form > .note'),
  ].filter(Boolean);
  globalControls.forEach((element) => element.classList.add('global-settings-control'));
  const title = document.querySelector('.top h1');
  const lead = document.querySelector('.top .lead');
  const cardTitle = document.querySelector('.card-head h2');
  const cardLead = document.querySelector('.card-head p');
  function applySection(section) {
    settingsSection = section === 'rpc' ? 'rpc' : 'global';
    rpcOnly = settingsSection === 'rpc';
    document.body.classList.toggle('rpc-only', rpcOnly);
    document.body.classList.toggle('global-only', !rpcOnly);
    document.title = rpcOnly ? 'Aria2 RPC 连接设置' : 'Aria2 全局设置';
    if (title) title.textContent = rpcOnly ? 'RPC 连接设置' : '全局设置';
    if (lead) lead.textContent = rpcOnly ? '配置与测试扩展和 Aria2 之间的 RPC 连接。' : '管理当前 aria2c 实例的默认下载行为。';
    if (cardTitle) cardTitle.textContent = rpcOnly ? '连接设置' : 'Aria2 设置';
    if (cardLead) cardLead.textContent = rpcOnly
      ? '地址、端口、路径和密钥与扩展悬浮页共用并保持同步。'
      : '连接、任务行为与传输参数按功能分组；保存后会同步到扩展的其他设置入口。';
  }
  applySection(settingsSection);

  function normalizeLocations(locations) {
    return (Array.isArray(locations) ? locations : []).map((item) => ({
      name: String(item?.name || '').trim(),
      path: String(item?.path || '').trim(),
      color: COLORS.includes(String(item?.color || '').toLowerCase()) ? String(item.color).toLowerCase() : '#ff9500',
    })).filter((item) => item.name && item.path);
  }

  function editableLocations() {
    return Array.from($('locations').querySelectorAll('.location')).map((row) => ({
      name: row.querySelector('.location-name').value,
      path: row.querySelector('.location-path').value,
      color: row.dataset.color || '#ff9500',
    }));
  }

  function colorBackground(color) {
    const value = color.slice(1);
    return `rgba(${parseInt(value.slice(0, 2), 16)}, ${parseInt(value.slice(2, 4), 16)}, ${parseInt(value.slice(4, 6), 16)}, .15)`;
  }

  function renderLocations(locations) {
    const list = $('locations');
    list.replaceChildren();
    locations.forEach((location, index) => {
      const row = document.createElement('div');
      row.className = 'location';
      row.dataset.color = location.color || '#ff9500';
      row.style.setProperty('--location-color', row.dataset.color);
      row.style.setProperty('--location-bg', colorBackground(row.dataset.color));
      const bar = document.createElement('div');
      bar.className = 'location-bar';
      const content = document.createElement('div');
      content.className = 'location-content';
      const header = document.createElement('div');
      header.className = 'location-header';
      const name = document.createElement('input');
      name.className = 'location-name'; name.placeholder = '名称'; name.value = location.name || '';
      header.appendChild(name);
      if (index === 0) { const badge = document.createElement('span'); badge.className = 'default'; badge.textContent = '默认'; header.appendChild(badge); }
      const path = document.createElement('input');
      path.className = 'location-path'; path.placeholder = '/path/to/downloads'; path.value = location.path || '';
      const pathRow = document.createElement('div');
      pathRow.className = 'location-path-row';
      pathRow.appendChild(path);
      const palette = document.createElement('div');
      palette.className = 'palette';
      COLORS.forEach((color) => { const swatch = document.createElement('button'); swatch.type = 'button'; swatch.className = `swatch${color === row.dataset.color ? ' selected' : ''}`; swatch.style.background = color; swatch.title = color; swatch.addEventListener('click', () => { row.dataset.color = color; renderLocations(editableLocations()); }); palette.appendChild(swatch); });
      const footer = document.createElement('div');
      footer.className = 'location-footer';
      footer.appendChild(palette);
      const controls = document.createElement('div'); controls.className = 'location-controls';
      [['↑', -1, '上移'], ['↓', 1, '下移']].forEach(([label, direction, title]) => { const button = document.createElement('button'); button.type = 'button'; button.className = 'mini'; button.textContent = label; button.title = title; button.disabled = (direction < 0 && index === 0) || (direction > 0 && index === locations.length - 1); button.addEventListener('click', () => { const next = editableLocations(); const [item] = next.splice(index, 1); next.splice(index + direction, 0, item); renderLocations(next); }); controls.appendChild(button); });
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'mini remove'; remove.textContent = '×'; remove.title = '删除'; remove.addEventListener('click', () => { const next = editableLocations(); next.splice(index, 1); renderLocations(next); }); controls.appendChild(remove);
      footer.appendChild(controls);
      content.append(header, pathRow, footer);
      row.append(bar, content); list.appendChild(row);
    });
  }

  function normalizeTrackerSubscriptions(subscriptions) {
    return (Array.isArray(subscriptions) ? subscriptions : [])
      .map((item) => String(item || '').trim())
      .filter(Boolean);
  }

  function trackerSubscriptionInputs() {
    return Array.from($('trackerSubscriptions').querySelectorAll('.tracker-subscription-input'));
  }

  function editableTrackerSubscriptions() {
    return trackerSubscriptionInputs().map((input) => input.value.trim()).filter(Boolean);
  }

  function renderTrackerSubscriptions(subscriptions = []) {
    const list = $('trackerSubscriptions');
    if (!list) return;
    list.replaceChildren();
    (Array.isArray(subscriptions) ? subscriptions : []).forEach((value, index) => {
      const row = document.createElement('div');
      row.className = 'tracker-subscription';
      const icon = document.createElement('span');
      icon.className = 'tracker-subscription-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML = '<svg viewBox="0 0 24 24"><path d="M10.6 13.4a4 4 0 0 0 5.7 0l2.1-2.1a4 4 0 0 0-5.7-5.7l-1.2 1.2"/><path d="M13.4 10.6a4 4 0 0 0-5.7 0l-2.1 2.1a4 4 0 0 0 5.7 5.7l1.2-1.2"/></svg>';
      const input = document.createElement('input');
      input.className = 'tracker-subscription-input';
      input.type = 'text';
      input.placeholder = 'https://example.com/trackers.txt';
      input.value = String(value || '');
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'mini remove';
      remove.textContent = '×';
      remove.title = '删除';
      remove.addEventListener('click', () => {
        const next = trackerSubscriptionInputs().map((item) => item.value);
        next.splice(index, 1);
        renderTrackerSubscriptions(next);
      });
      row.append(icon, input, remove);
      list.appendChild(row);
    });
  }

  function renderTrackers(trackers = [], failed = []) {
    const preview = $('trackerPreview');
    if (!preview) return;
    preview.replaceChildren();
    const title = document.createElement('div');
    title.className = 'tracker-preview-title';
    title.textContent = `已解析 Tracker（${trackers.length}）`;
    preview.appendChild(title);
    if (!trackers.length) {
      const empty = document.createElement('div');
      empty.className = 'tracker-preview-empty';
      empty.textContent = '暂无 Tracker，添加订阅后点击“立即更新”拉取。';
      preview.appendChild(empty);
    } else {
      trackers.forEach((tracker) => {
        const item = document.createElement('div');
        item.className = 'tracker-item';
        item.textContent = tracker;
        preview.appendChild(item);
      });
    }
    (Array.isArray(failed) ? failed : []).forEach((item) => {
      const error = document.createElement('div');
      error.className = 'tracker-preview-empty';
      error.style.color = 'var(--red)';
      error.textContent = `订阅失败：${item?.url || ''}（${item?.error || '未知错误'}）`;
      preview.appendChild(error);
    });
  }

  async function refreshTrackers({ silent = false } = {}) {
    const button = $('refreshTrackers');
    const previousText = button?.textContent || '';
    if (button) { button.disabled = true; button.textContent = '更新中…'; }
    try {
      const response = await sendRuntimeMessage({ type: 'REFRESH_ARIA2_TRACKERS' });
      renderTrackers(response?.trackers || [], response?.failed || []);
      if (!silent) {
        const failedCount = response?.failed?.length || 0;
        if (response?.preserved) toast(`更新失败，已保留原有 ${response?.trackers?.length || 0} 个 Tracker`);
        else toast(failedCount ? `Tracker 已更新，${failedCount} 个订阅失败` : `已更新 ${response?.trackers?.length || 0} 个 Tracker`);
      }
      return response;
    } catch (error) {
      if (!silent) toast(`Tracker 更新失败：${error.message}`);
      throw error;
    } finally {
      if (button) { button.disabled = false; button.textContent = previousText; }
    }
  }

  function fill(data = {}) {
    loadedSettings = { ...storageKeys, ...data };
    const parts = rpcApi?.rpcParts?.(loadedSettings.aria2Rpc) || {
      protocol: 'http', host: 'localhost', port: '6800', path: '/jsonrpc',
    };
    $('rpcProtocol').value = parts.protocol;
    $('rpcHost').value = parts.host;
    $('rpcPort').value = parts.port;
    $('rpcPath').value = parts.path;
    $('rpcSecret').value = loadedSettings.aria2Secret || '';
    renderRpcPreview();
    $('customSaveEnabled').checked = !!data.aria2CustomSaveEnabled;
    renderLocations(normalizeLocations(data.aria2SaveLocations));
    renderTrackerSubscriptions(data.aria2TrackerSubscriptions);
    renderTrackers(data.aria2Trackers);
    $('connections').value = data.aria2PanelConnections || '';
    $('downlimit').value = data.aria2PanelDownloadLimit || '0';
    $('uplimit').value = data.aria2PanelUploadLimit || '0';
  }

  function getStorage() {
    return new Promise((resolve) => {
      if (!extensionApi?.storage?.sync?.get) {
        resolve({ ...storageKeys });
        return;
      }
      extensionApi.storage.sync.get(storageKeys, resolve);
    });
  }

  function setStorage(values) {
    return new Promise((resolve, reject) => {
      if (!extensionApi?.storage?.sync?.set) {
        reject(new Error('Extension storage unavailable'));
        return;
      }
      extensionApi.storage.sync.set(values, () => {
        if (extensionApi.runtime?.lastError) reject(new Error(extensionApi.runtime.lastError.message));
        else resolve();
      });
    });
  }

  function getCurrentRpcFields() {
    return {
      protocol: $('rpcProtocol').value,
      host: $('rpcHost').value,
      port: $('rpcPort').value,
      path: $('rpcPath').value,
    };
  }

  function showRpcError(message = '') {
    $('rpcError').textContent = message;
  }

  function buildRpcFromForm() {
    try {
      const value = rpcApi?.buildRpcEndpoint
        ? rpcApi.buildRpcEndpoint(getCurrentRpcFields())
        : new URL(`${$('rpcProtocol').value}://${$('rpcHost').value}:${$('rpcPort').value}${$('rpcPath').value || '/jsonrpc'}`).toString();
      showRpcError('');
      return value;
    } catch (error) {
      showRpcError(error?.message || 'RPC 地址无效');
      return '';
    }
  }

  function renderRpcPreview() {
    buildRpcFromForm();
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
      const runtime = extensionApi?.runtime;
      if (!runtime?.sendMessage) {
        reject(new Error('Extension runtime unavailable'));
        return;
      }
      runtime.sendMessage(message, (response) => {
        if (runtime.lastError) {
          reject(new Error(runtime.lastError.message));
          return;
        }
        if (!response?.ok && message.type !== 'GET_STATE') {
          reject(new Error(response?.error || 'Operation failed'));
          return;
        }
        resolve(response);
      });
    });
  }

  async function getConfig() {
    try {
      const response = await sendRuntimeMessage({ type: 'GET_STATE' });
      if (response?.config) return { ...(await getStorage()), ...response.config };
    } catch (_) {}
    return getStorage();
  }

  async function saveConfig(values) {
    if (extensionApi?.runtime?.sendMessage) {
      await sendRuntimeMessage({ type: 'SAVE_CONFIG', config: values });
      return;
    }
    await setStorage(values);
  }

  async function refreshConnectionsStatus() {
    const status = $('connectionsStatus');
    const details = $('connectionsDetails');
    try {
      const options = await rpc('getGlobalOption');
      const perServer = Number(options['max-connection-per-server']);
      const split = Number(options.split);
      const known = Number.isSafeInteger(perServer) && perServer > 0 && Number.isSafeInteger(split) && split > 0;
      status.textContent = known
        ? `当前单任务连接上限：${Math.min(perServer, split)}（新任务，单服务器）`
        : '当前单任务连接上限：未知';
      details.textContent = `aria2 返回值：每服务器连接数 ${options['max-connection-per-server'] || '未知'}，分段连接数 ${options.split || '未知'}。`;
      return options;
    } catch (error) {
      status.textContent = '暂时无法读取当前连接上限，请检查 RPC 连接';
      details.textContent = `读取失败：${error.message}`;
      throw error;
    }
  }

  async function load() {
    fill(await getConfig());
    if (!rpcOnly) await refreshConnectionsStatus().catch(() => {});
  }

  function validateConnections() {
    const input = $('connections');
    const value = input.value.trim();
    const valid = !input.validity?.badInput && (value === '' || (/^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 16));
    input.setCustomValidity(valid ? '' : '请输入本页支持的 1–16 整数；留空则保持当前值');
    return valid;
  }
  $('connections').addEventListener('input', validateConnections);
  $('connections').addEventListener('invalid', validateConnections);
  function toast(message) { const el = $('toast'); el.textContent = message; el.style.opacity = '1'; clearTimeout(toast.timer); toast.timer = setTimeout(() => { el.style.opacity = '0'; }, 2600); }
  function rpc(method, params = []) { return new Promise((resolve, reject) => {
    const runtime = extensionApi?.runtime;
    if (!runtime?.sendMessage) return reject(new Error('Extension runtime unavailable'));
    runtime.sendMessage({ type: 'ARIA2_RPC', method, params }, (res) => { if (runtime.lastError) return reject(new Error(runtime.lastError.message)); if (!res?.ok) return reject(new Error(res?.error || 'RPC failed')); resolve(res.result); });
  }); }

  $('back').onclick = () => {
    if (embedded && window.parent !== window) window.parent.postMessage({ type: 'ARIA2_SHOW_TASKS' }, location.origin);
    else location.href = extensionApi?.runtime?.getURL ? extensionApi.runtime.getURL('aria2-tasks.html') : 'aria2-tasks.html';
  };
  $('testRpc').onclick = async () => {
    const aria2Rpc = buildRpcFromForm();
    if (!aria2Rpc) return;
    const button = $('testRpc');
    button.disabled = true;
    try {
      const response = await sendRuntimeMessage({
        type: 'TEST_CONNECTION',
        config: { ...loadedSettings, downloaderType: 'aria2', aria2Rpc, aria2Secret: $('rpcSecret').value.trim() },
      });
      const stat = response?.stat || {};
      toast(`连接成功 · 活跃 ${stat.numActive || 0} · 等待 ${stat.numWaiting || 0} · 完成 ${stat.numStopped || 0}`);
    } catch (error) {
      toast(`连接失败：${error.message}`);
    } finally {
      button.disabled = false;
    }
  };
  $('addLocation').onclick = () => { const next = editableLocations(); next.push({ name: '', path: '', color: '#ff9500' }); renderLocations(next); };
  $('addTrackerSubscription').onclick = () => {
    const next = trackerSubscriptionInputs().map((input) => input.value);
    next.push('');
    renderTrackerSubscriptions(next);
    const inputs = trackerSubscriptionInputs();
    inputs[inputs.length - 1]?.focus();
  };
  $('refreshTrackers').onclick = async () => {
    const subscriptions = normalizeTrackerSubscriptions(editableTrackerSubscriptions());
    if (!subscriptions.length) {
      toast('请先添加 Tracker 订阅链接');
      return;
    }
    try {
      await saveConfig({ ...loadedSettings, aria2TrackerSubscriptions: subscriptions });
      await refreshTrackers();
    } catch (error) {
      toast(`操作失败：${error.message}`);
    }
  };
  extensionApi?.storage?.onChanged?.addListener(async (changes, area) => {
    if (area !== 'sync' && area !== 'local') return;
    if (changes.aria2Rpc || changes.aria2Secret || changes.aria2CustomSaveEnabled || changes.aria2SaveLocations || changes.aria2TrackerSubscriptions || changes.aria2Trackers) {
      const data = await getConfig();
      fill(data);
      if (changes.aria2Rpc || changes.aria2Secret) toast('已同步悬浮页中的 RPC 连接设置');
      else if (changes.aria2CustomSaveEnabled?.newValue === false) toast('已关闭自定义位置；新任务将使用 aria2c 自身目录');
      else if (changes.aria2TrackerSubscriptions || changes.aria2Trackers) toast('已同步 Tracker 设置');
      else toast('已同步悬浮页中的保存位置');
    }
  });
  ['rpcProtocol', 'rpcHost', 'rpcPort', 'rpcPath'].forEach((id) => {
    $(id).addEventListener('input', renderRpcPreview);
    $(id).addEventListener('change', renderRpcPreview);
  });
  window.addEventListener('message', (event) => {
    if (event.origin !== location.origin) return;
    if (event.data?.type === 'ARIA2_SET_SECTION') {
      applySection(event.data.section);
      return;
    }
    if (rpcOnly && event.data?.type === 'ARIA2_FOCUS_RPC') $('rpcHost').focus();
  });
  $('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!rpcOnly && !validateConnections()) { $('connections').reportValidity(); return; }
    const locations = rpcOnly ? loadedSettings.aria2SaveLocations : normalizeLocations(editableLocations());
    const customSaveEnabled = rpcOnly ? loadedSettings.aria2CustomSaveEnabled : $('customSaveEnabled').checked;
    const trackerSubscriptions = rpcOnly ? loadedSettings.aria2TrackerSubscriptions : normalizeTrackerSubscriptions(editableTrackerSubscriptions());
    const values = rpcOnly
      ? { connections: loadedSettings.aria2PanelConnections, downlimit: loadedSettings.aria2PanelDownloadLimit, uplimit: loadedSettings.aria2PanelUploadLimit }
      : { connections: $('connections').value.trim(), downlimit: $('downlimit').value, uplimit: $('uplimit').value };
    const aria2Rpc = rpcOnly ? buildRpcFromForm() : loadedSettings.aria2Rpc;
    if (!aria2Rpc) return;
    const aria2Secret = rpcOnly ? $('rpcSecret').value.trim() : loadedSettings.aria2Secret;
    const options = { 'max-overall-download-limit': values.downlimit, 'max-overall-upload-limit': values.uplimit };
    if (!rpcOnly && values.connections) {
      options['max-connection-per-server'] = values.connections;
      options.split = values.connections;
    }
    const save = $('save'); save.disabled = true;
    const trackerSubscriptionsChanged = JSON.stringify(trackerSubscriptions) !== JSON.stringify(loadedSettings.aria2TrackerSubscriptions || []);
    try {
      const disablingCustomLocations = loadedSettings.aria2CustomSaveEnabled && !customSaveEnabled;
      if (!rpcOnly) {
        await rpc('changeGlobalOption', [options]);
        let applied;
        try { applied = await refreshConnectionsStatus(); }
        catch (error) { throw new Error(`已发送设置，但无法确认是否生效：${error.message}`); }
        if (values.connections && (Number(applied['max-connection-per-server']) !== Number(values.connections) || Number(applied.split) !== Number(values.connections))) {
          throw new Error(`单任务连接数未生效：请求 ${values.connections}，aria2 返回每服务器 ${applied['max-connection-per-server'] || '未知'}、分段 ${applied.split || '未知'}`);
        }
      }
      const nextConfig = {
        ...loadedSettings,
        aria2Rpc,
        aria2Secret,
        aria2CustomSaveEnabled: customSaveEnabled,
        aria2SaveLocations: locations,
        aria2TrackerSubscriptions: trackerSubscriptions,
        aria2PanelConnections: values.connections,
        aria2PanelDownloadLimit: values.downlimit,
        aria2PanelUploadLimit: values.uplimit,
      };
      await saveConfig(nextConfig);
      if (!rpcOnly && trackerSubscriptionsChanged) {
        try {
          await refreshTrackers({ silent: true });
        } catch (_) {}
      }
      loadedSettings = {
        ...loadedSettings,
        aria2Rpc,
        aria2Secret,
        aria2CustomSaveEnabled: customSaveEnabled,
        aria2SaveLocations: locations,
        aria2TrackerSubscriptions: trackerSubscriptions,
        aria2PanelConnections: values.connections,
        aria2PanelDownloadLimit: values.downlimit,
        aria2PanelUploadLimit: values.uplimit,
      };
      if (rpcOnly) toast('RPC 连接设置已同步');
      else if (customSaveEnabled) toast('RPC 连接与全局设置已同步');
      else if (disablingCustomLocations) toast('已关闭自定义位置；请重启一次 aria2c 以清除旧版本写入的目录');
      else toast('全局设置已应用并核验；新任务使用 aria2c 默认目录');
    } catch (error) { toast(`操作失败：${error.message}`); } finally { save.disabled = false; }
  });
  load();
})();
