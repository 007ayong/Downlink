(function initPopupSettings(global) {
    const t = global.Localization?.t || ((key, substitutions, fallback = key) => {
      if (fallback && substitutions !== undefined) {
        const values = Array.isArray(substitutions) ? substitutions : [substitutions];
        return String(fallback).replace(/\$(\d+)/g, (_, index) => String(values[Number(index) - 1] ?? ''));
      }
      return fallback || key;
    });

    function createSettingsController({
      defaultCaptureExtensions = '',
      defaultMediaSniffingBlacklist = 'x.com,youtube.com',
      defaultDownloadInterceptionBlacklist = 'web.telegram.org',
      hideSmallDownloadSettings = false,
      getCurrentConfig,
      setCurrentConfig,
      getSavedConfig = getCurrentConfig,
      setSavedConfig = () => {},
      getCurrentState,
      getLoading,
    setLoading,
    getAutoSaveTimer,
    setAutoSaveTimer,
    getSaveFeedbackTimer,
    setSaveFeedbackTimer,
      syncGlobals,
      updateSettingsVisibility,
      updateDynamicLabels,
      renderTasks,
      requestAutoConnectionCheck,
    }) {
    const AB_DM_NAME = 'AB DM';
    if (hideSmallDownloadSettings) {
      document.querySelectorAll('[data-small-download-setting]').forEach((element) => element.remove());
    }
    const normalizeLocations = global.normalizeAria2SaveLocations || ((locations = []) => (Array.isArray(locations) ? locations : [])
      .map((item) => ({
        name: String(item?.name || '').trim(),
        path: String(item?.path || '').trim(),
        color: normalizeColor(item?.color),
      }))
      .filter((item) => item.name && item.path));
    const normalizeColor = global.normalizeLocationColor || ((color = '') => {
      const value = String(color || '').trim().toLowerCase();
      const colors = ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#007aff', '#af52de', '#8e8e93'];
      return colors.includes(value) ? value : '#ff9500';
    });
    const SAVE_LOCATION_PALETTES = [
      { name: 'Red', label: '红色', color: '#ff3b30' },
      { name: 'Orange', label: '橙色', color: '#ff9500' },
      { name: 'Yellow', label: '黄色', color: '#ffcc00' },
      { name: 'Green', label: '绿色', color: '#34c759' },
      { name: 'Blue', label: '蓝色', color: '#007aff' },
      { name: 'Purple', label: '紫色', color: '#af52de' },
      { name: 'Gray', label: '灰色', color: '#8e8e93' },
    ];

    function normalizeSettingsConfig(cfg = {}) {
      const normalized = {
        ...(cfg || {}),
        externalLauncherHost: 'localhost',
        externalLauncherName: AB_DM_NAME,
      };
      normalized.aria2Rpc = global.Aria2Rpc?.normalizeRpcEndpoint
        ? global.Aria2Rpc.normalizeRpcEndpoint(normalized.aria2Rpc)
        : String(normalized.aria2Rpc || 'http://localhost:6800/jsonrpc').trim() || 'http://localhost:6800/jsonrpc';
      if (hideSmallDownloadSettings) {
        delete normalized.skipSmallDownloads;
        delete normalized.smallDownloadThresholdBytes;
      }
      return normalized;
    }

    function colorToSoftBackground(color = '') {
      const value = normalizeColor(color).replace('#', '');
      const r = Number.parseInt(value.slice(0, 2), 16);
      const g = Number.parseInt(value.slice(2, 4), 16);
      const b = Number.parseInt(value.slice(4, 6), 16);
      return `rgba(${r}, ${g}, ${b}, 0.18)`;
    }

    function applySaveLocationColor(row, color) {
      const selectedColor = normalizeColor(color);
      row.style.setProperty('--save-location-color', selectedColor);
      row.style.setProperty('--save-location-bg', colorToSoftBackground(selectedColor));
    }

    function collectSaveLocationsFromForm({ includeIncomplete = false } = {}) {
      const list = document.getElementById('cfgAria2SaveLocations');
      const rows = Array.from(list?.querySelectorAll?.('.save-location-row') || []);
      const locations = rows.map((row) => ({
        name: row.querySelector('.save-location-name')?.value || '',
        path: row.querySelector('.save-location-path')?.value || '',
        color: row.querySelector('.save-location-color')?.value || '#ff9500',
      }));
      if (includeIncomplete) {
        return locations.map((item) => ({
          name: String(item.name || ''),
          path: String(item.path || ''),
          color: normalizeColor(item.color),
        }));
      }
      return normalizeLocations(locations);
    }

    function renderSaveLocations(locations = []) {
      const list = document.getElementById('cfgAria2SaveLocations');
      if (!list?.replaceChildren) return;
      const editableLocations = collectSaveLocationsFromForm({ includeIncomplete: true });
      const nextLocations = Array.isArray(locations) ? locations : editableLocations;
      list.replaceChildren();
      nextLocations.forEach((location, index) => {
        const row = document.createElement('div');
        row.className = 'save-location-row';
        row.dataset.index = String(index);

        const color = document.createElement('input');
        color.className = 'save-location-color';
        color.type = 'hidden';
        color.value = normalizeColor(location.color);

        const fields = document.createElement('div');
        fields.className = 'save-location-fields';
        const nameRow = document.createElement('div');
        nameRow.className = 'save-location-name-row';
        const name = document.createElement('input');
        name.className = 'settings-input save-location-name';
        name.type = 'text';
        name.placeholder = t('settingsAria2SaveLocationNamePlaceholder', undefined, '名称');
        name.value = location.name || '';
        nameRow.appendChild(name);
        if (index === 0) {
          const defaultBadge = document.createElement('span');
          defaultBadge.className = 'save-location-default-badge';
          defaultBadge.textContent = t('defaultSaveLocation', undefined, '默认');
          nameRow.appendChild(defaultBadge);
        }
        const path = document.createElement('input');
        path.className = 'settings-input save-location-path';
        path.type = 'text';
        path.placeholder = t('settingsAria2SaveLocationPathPlaceholder', undefined, '/path/to/downloads');
        path.value = location.path || '';
        fields.appendChild(nameRow);
        fields.appendChild(path);

        const palette = document.createElement('div');
        palette.className = 'save-location-palette';
        palette.setAttribute('aria-label', t('settingsAria2SaveLocationColor', undefined, '颜色标签'));
        SAVE_LOCATION_PALETTES.forEach((item) => {
          const swatch = document.createElement('button');
          swatch.type = 'button';
          swatch.className = 'save-location-swatch';
          swatch.dataset.color = item.color;
          swatch.title = item.label || item.name;
          swatch.style.background = item.color;
          palette.appendChild(swatch);
        });
        fields.appendChild(palette);

        const controls = document.createElement('div');
        controls.className = 'save-location-controls';
        const up = document.createElement('button');
        up.type = 'button';
        up.className = 'save-location-btn save-location-up';
        up.textContent = '↑';
        up.disabled = index === 0;
        up.title = t('moveUp', undefined, '上移');
        const down = document.createElement('button');
        down.type = 'button';
        down.className = 'save-location-btn save-location-down';
        down.textContent = '↓';
        down.disabled = index === nextLocations.length - 1;
        down.title = t('moveDown', undefined, '下移');
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'save-location-btn save-location-remove';
        remove.textContent = '×';
        remove.title = t('remove', undefined, '删除');
        controls.appendChild(up);
        controls.appendChild(down);
        controls.appendChild(remove);

        row.appendChild(color);
        row.appendChild(fields);
        row.appendChild(controls);
        applySaveLocationColor(row, color.value);
        list.appendChild(row);
      });
    }

    function addSaveLocationRow() {
      const current = collectSaveLocationsFromForm({ includeIncomplete: true });
      current.push({ name: '', path: '', color: '#ff9500' });
      renderSaveLocations(current);
    }

    function moveSaveLocation(index, direction) {
      const current = collectSaveLocationsFromForm({ includeIncomplete: true });
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= current.length) return;
      const [item] = current.splice(index, 1);
      current.splice(nextIndex, 0, item);
      renderSaveLocations(current);
      scheduleAutoSave(0);
    }

    function removeSaveLocation(index) {
      const current = collectSaveLocationsFromForm({ includeIncomplete: true });
      current.splice(index, 1);
      renderSaveLocations(current);
      scheduleAutoSave(0);
    }

    let aria2Profiles = [];
    let aria2ActiveProfileId = '';

    function captureAria2Profile() {
      const profile = aria2Profiles.find((item) => item.id === aria2ActiveProfileId);
      if (!profile) return;
      profile.name = document.getElementById('cfgAria2ProfileName').value.trim() || profile.name;
      profile.rpc = document.getElementById('cfgRpc').value.trim() || 'http://localhost:6800/jsonrpc';
      profile.secret = document.getElementById('cfgSecret').value.trim();
      for (const option of document.getElementById('cfgAria2Profile').children) {
        if (option.value === profile.id) option.textContent = profile.name;
      }
      global.syncAria2ProfilePicker?.(aria2ActiveProfileId);
    }

    function renderAria2Profiles() {
      const select = document.getElementById('cfgAria2Profile');
      select.replaceChildren();
      aria2Profiles.forEach((profile) => {
        const option = document.createElement('option');
        option.value = profile.id;
        option.textContent = profile.name;
        select.appendChild(option);
      });
      select.value = aria2ActiveProfileId;
      global.syncAria2ProfilePicker?.(aria2ActiveProfileId);
      const profile = aria2Profiles.find((item) => item.id === aria2ActiveProfileId);
      if (!profile) return;
      document.getElementById('cfgAria2ProfileName').value = profile.name;
      document.getElementById('cfgRpc').value = profile.rpc;
      document.getElementById('cfgSecret').value = profile.secret;
      document.getElementById('deleteAria2ProfileBtn').disabled = aria2Profiles.length <= 1;
    }

    function collectSettingsFromForm() {
      captureAria2Profile();
      const aria2Silent = document.getElementById('cfgAria2Silent').checked;
      return {
        downloaderType: document.getElementById('cfgDownloaderType').value,
        language: document.getElementById('cfgLanguage').value || 'auto',
        aria2Rpc: document.getElementById('cfgRpc').value.trim() || 'http://localhost:6800/jsonrpc',
        aria2Secret: document.getElementById('cfgSecret').value.trim(),
        ...(aria2Profiles.length ? { aria2Profiles: aria2Profiles.map((item) => ({ ...item })), aria2ActiveProfileId } : {}),
        aria2Silent,
        aria2CustomSaveEnabled: document.getElementById('cfgAria2CustomSaveEnabled').checked,
        aria2SaveLocations: collectSaveLocationsFromForm(),
        useMotrixNext: document.getElementById('cfgUseMotrixNext').checked,
        motrixNextPort: document.getElementById('cfgMotrixNextPort').value.trim() || '16801',
        motrixNextSecret: document.getElementById('cfgMotrixNextSecret').value.trim(),
        gopeedApi: document.getElementById('cfgGopeedApi').value.trim() || 'http://127.0.0.1:9999',
        gopeedToken: document.getElementById('cfgGopeedToken').value.trim(),
        gopeedSilent: document.getElementById('cfgGopeedSilent').checked,
        externalLauncherName: AB_DM_NAME,
        externalLauncherHost: 'localhost',
        externalLauncherPort: document.getElementById('cfgLauncherPort').value.trim() || '15151',
        abDownloadSilent: document.getElementById('cfgAbDownloadSilent').checked,
        autoCapture: document.getElementById('cfgAutoCapture').checked,
        mediaSniffingBlacklist: document.getElementById('cfgMediaSniffingBlacklist').value.trim(),
        downloadInterceptionBlacklist: document.getElementById('cfgDownloadInterceptionBlacklist').value.trim(),
        captureExtensions: document.getElementById('cfgExts').value.trim(),
        ...(hideSmallDownloadSettings ? {} : {
          skipSmallDownloads: document.getElementById('cfgSkipSmallDownloads').checked,
          smallDownloadThresholdBytes: Math.max(0.1, Number.parseFloat(document.getElementById('cfgSmallDownloadThresholdMb').value) || 1) * 1024 * 1024,
        }),
      };
    }

    function setSaveButtonState(text, resetDelay = 1500) {
      const btn = document.getElementById('saveSettingsBtn');
      if (!btn) return;
      btn.textContent = text;
        clearTimeout(getSaveFeedbackTimer());
      if (resetDelay >= 0) {
        setSaveFeedbackTimer(setTimeout(() => {
          btn.textContent = t('saveSettings', undefined, '保存设置');
        }, resetDelay));
      }
      syncGlobals();
    }

    function persistSettings(cfg, { showSavedFeedback = true } = {}) {
      cfg = normalizeSettingsConfig(cfg);
      clearTimeout(getAutoSaveTimer());
      setSaveButtonState(t('savingSettings', undefined, '保存中…'), -1);
      const prevCfg = getSavedConfig();
      const shouldRetestConnection = (
        cfg.downloaderType !== prevCfg.downloaderType ||
        cfg.aria2Rpc !== prevCfg.aria2Rpc ||
        cfg.aria2Secret !== prevCfg.aria2Secret ||
        cfg.externalLauncherPort !== prevCfg.externalLauncherPort ||
        cfg.motrixNextPort !== prevCfg.motrixNextPort ||
        cfg.motrixNextSecret !== prevCfg.motrixNextSecret ||
        cfg.gopeedApi !== prevCfg.gopeedApi ||
        cfg.gopeedToken !== prevCfg.gopeedToken
      );
      chrome.runtime.sendMessage({ type: 'SAVE_CONFIG', config: cfg }, (res) => {
        if (!res?.ok || chrome.runtime?.lastError) {
          setSaveButtonState(t('saveSettings', undefined, '保存设置'));
          return;
        }
        setCurrentConfig({ ...cfg });
        setSavedConfig({ ...cfg });
        updateSettingsVisibility(cfg.downloaderType);
        updateDynamicLabels(cfg);
        const state = getCurrentState();
        renderTasks(state.tasks, state.pending);
        syncGlobals();
        if (shouldRetestConnection) requestAutoConnectionCheck?.(cfg);
        setSaveButtonState(
          showSavedFeedback
            ? t('autoSavedSettings', undefined, '已自动保存')
            : t('savedSettings', undefined, '已保存')
        );
      });
    }

    function scheduleAutoSave(delay = 350) {
      if (getLoading()) return;
      clearTimeout(getAutoSaveTimer());
      const nextCfg = { ...getCurrentConfig(), ...collectSettingsFromForm() };
      setCurrentConfig({ ...getCurrentConfig(), ...nextCfg });
      updateSettingsVisibility(nextCfg.downloaderType);
      updateDynamicLabels(nextCfg);
      const state = getCurrentState();
      renderTasks(state.tasks, state.pending);
      setSaveButtonState(t('autoSavingSettings', undefined, '自动保存中…'), -1);
      setAutoSaveTimer(setTimeout(() => {
        persistSettings({ ...getCurrentConfig(), ...collectSettingsFromForm() });
      }, delay));
      syncGlobals();
    }

    function loadSettings(cfg) {
      if (!cfg) return;
      setLoading(true);
      const normalizedCfg = normalizeSettingsConfig({ ...getCurrentConfig(), ...cfg });
      normalizedCfg.aria2CustomSaveEnabled = !!normalizedCfg.aria2CustomSaveEnabled;
      setCurrentConfig({ ...normalizedCfg });
      setSavedConfig({ ...normalizedCfg });
      document.getElementById('cfgDownloaderType').value = normalizedCfg.downloaderType || 'aria2';
      global.syncDownloaderPicker?.(normalizedCfg.downloaderType || 'aria2');
      document.getElementById('cfgLanguage').value = normalizedCfg.language || 'auto';
      global.syncLanguagePicker?.(normalizedCfg.language || 'auto');
      document.getElementById('cfgRpc').value = normalizedCfg.aria2Rpc || '';
      document.getElementById('cfgSecret').value = normalizedCfg.aria2Secret || '';
      aria2Profiles = Array.isArray(normalizedCfg.aria2Profiles) && normalizedCfg.aria2Profiles.length
        ? normalizedCfg.aria2Profiles.map((item) => ({ ...item }))
        : [{ id: 'default', name: '默认配置', rpc: normalizedCfg.aria2Rpc, secret: normalizedCfg.aria2Secret || '' }];
      aria2ActiveProfileId = aria2Profiles.some((item) => item.id === normalizedCfg.aria2ActiveProfileId)
        ? normalizedCfg.aria2ActiveProfileId : aria2Profiles[0].id;
      const activeProfile = aria2Profiles.find((item) => item.id === aria2ActiveProfileId);
      activeProfile.rpc = normalizedCfg.aria2Rpc;
      activeProfile.secret = normalizedCfg.aria2Secret || '';
      renderAria2Profiles();
      document.getElementById('cfgAria2Silent').checked = !!normalizedCfg.aria2Silent;
      document.getElementById('cfgAria2CustomSaveEnabled').checked = !!normalizedCfg.aria2CustomSaveEnabled;
      renderSaveLocations(normalizedCfg.aria2SaveLocations || []);
      document.getElementById('cfgUseMotrixNext').checked = !!normalizedCfg.useMotrixNext;
      document.getElementById('cfgMotrixNextPort').value = normalizedCfg.motrixNextPort || '16801';
      document.getElementById('cfgMotrixNextSecret').value = normalizedCfg.motrixNextSecret || '';
      document.getElementById('cfgGopeedApi').value = normalizedCfg.gopeedApi || 'http://127.0.0.1:9999';
      document.getElementById('cfgGopeedToken').value = normalizedCfg.gopeedToken || '';
      document.getElementById('cfgGopeedSilent').checked = !!normalizedCfg.gopeedSilent;
      document.getElementById('cfgLauncherPort').value = normalizedCfg.externalLauncherPort || '15151';
      document.getElementById('cfgAbDownloadSilent').checked = !!normalizedCfg.abDownloadSilent;
      document.getElementById('cfgAutoCapture').checked = !!normalizedCfg.autoCapture;
      document.getElementById('cfgMediaSniffingBlacklist').value = normalizedCfg.mediaSniffingBlacklist || '';
      document.getElementById('cfgDownloadInterceptionBlacklist').value = normalizedCfg.downloadInterceptionBlacklist || '';
      document.getElementById('cfgExts').value = normalizedCfg.captureExtensions || '';
      if (!hideSmallDownloadSettings) {
        document.getElementById('cfgSkipSmallDownloads').checked = !!normalizedCfg.skipSmallDownloads;
        document.getElementById('cfgSmallDownloadThresholdMb').value = ((Number(normalizedCfg.smallDownloadThresholdBytes) || 1048576) / 1024 / 1024).toString();
      }
      updateSettingsVisibility(normalizedCfg.downloaderType || 'aria2');
      updateDynamicLabels(normalizedCfg);
      setLoading(false);
      syncGlobals();
      requestAutoConnectionCheck?.(normalizedCfg);
    }

    function bindSettingsEvents() {
      document.getElementById('saveSettingsBtn').addEventListener('click', () => {
        persistSettings(collectSettingsFromForm(), { showSavedFeedback: false });
      });

      document.getElementById('cfgDownloaderType').addEventListener('change', (event) => {
        const currentConfig = getCurrentConfig();
        const nextCfg = {
          ...currentConfig,
          language: document.getElementById('cfgLanguage').value || currentConfig.language || 'auto',
          downloaderType: event.target.value,
          externalLauncherName: AB_DM_NAME,
        };
        setCurrentConfig(nextCfg);
        updateSettingsVisibility(nextCfg.downloaderType);
        updateDynamicLabels(nextCfg);
        syncGlobals();
        scheduleAutoSave(0);
      });

      [
        'cfgLanguage',
        'cfgAria2ProfileName',
        'cfgRpc',
        'cfgSecret',
        'cfgMotrixNextPort',
        'cfgMotrixNextSecret',
        'cfgGopeedApi',
        'cfgGopeedToken',
        'cfgLauncherPort',
        'cfgMediaSniffingBlacklist',
        'cfgDownloadInterceptionBlacklist',
        'cfgExts',
        ...(hideSmallDownloadSettings ? [] : ['cfgSmallDownloadThresholdMb']),
      ].forEach((id) => {
        const el = document.getElementById(id);
        el.addEventListener('input', () => {
          if (id === 'cfgLauncherPort') {
            const nextCfg = { ...getCurrentConfig(), externalLauncherName: AB_DM_NAME };
            setCurrentConfig(nextCfg);
            updateDynamicLabels(nextCfg);
            syncGlobals();
          }
          scheduleAutoSave();
        });
        el.addEventListener('change', () => {
          if (id === 'cfgLauncherPort') {
            const nextCfg = { ...getCurrentConfig(), externalLauncherName: AB_DM_NAME };
            setCurrentConfig(nextCfg);
            updateDynamicLabels(nextCfg);
            syncGlobals();
          }
          scheduleAutoSave(0);
        });
      });

      document.getElementById('cfgAria2Profile').addEventListener('change', (event) => {
        // Capturing edits synchronizes the picker back to the old profile.
        const nextProfileId = event.target.value;
        if (!aria2Profiles.some((item) => item.id === nextProfileId)) return;
        captureAria2Profile();
        aria2ActiveProfileId = nextProfileId;
        renderAria2Profiles();
        scheduleAutoSave(0);
      });
      document.getElementById('addAria2ProfileBtn').addEventListener('click', () => {
        captureAria2Profile();
        aria2ActiveProfileId = global.crypto?.randomUUID?.() || `rpc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        aria2Profiles.push({ id: aria2ActiveProfileId, name: `新配置 ${aria2Profiles.length + 1}`, rpc: 'http://localhost:6800/jsonrpc', secret: '' });
        renderAria2Profiles();
        document.getElementById('cfgAria2ProfileName').focus();
        scheduleAutoSave(0);
      });
      document.getElementById('deleteAria2ProfileBtn').addEventListener('click', () => {
        if (aria2Profiles.length <= 1) return;
        aria2Profiles = aria2Profiles.filter((item) => item.id !== aria2ActiveProfileId);
        aria2ActiveProfileId = aria2Profiles[0].id;
        renderAria2Profiles();
        scheduleAutoSave(0);
      });

      ['cfgAutoCapture', 'cfgAria2Silent', 'cfgAria2CustomSaveEnabled', 'cfgUseMotrixNext', 'cfgAbDownloadSilent', 'cfgGopeedSilent', ...(hideSmallDownloadSettings ? [] : ['cfgSkipSmallDownloads'])].forEach((id) => {
        document.getElementById(id).addEventListener('change', () => scheduleAutoSave(0));
      });

      document.getElementById('addAria2SaveLocationBtn')?.addEventListener('click', () => {
        addSaveLocationRow();
      });

      document.getElementById('restoreDefaultCaptureExtensionsBtn')?.addEventListener('click', () => {
        document.getElementById('cfgExts').value = defaultCaptureExtensions;
        scheduleAutoSave(0);
      });

      document.getElementById('restoreDefaultMediaSniffingBlacklistBtn')?.addEventListener('click', () => {
        document.getElementById('cfgMediaSniffingBlacklist').value = defaultMediaSniffingBlacklist;
        scheduleAutoSave(0);
      });

      document.getElementById('restoreDefaultDownloadInterceptionBlacklistBtn')?.addEventListener('click', () => {
        document.getElementById('cfgDownloadInterceptionBlacklist').value = defaultDownloadInterceptionBlacklist;
        scheduleAutoSave(0);
      });

      document.getElementById('cfgAria2SaveLocations')?.addEventListener('input', () => scheduleAutoSave());
      document.getElementById('cfgAria2SaveLocations')?.addEventListener('change', () => scheduleAutoSave(0));
      document.getElementById('cfgAria2SaveLocations')?.addEventListener('click', (event) => {
        const row = event.target?.closest?.('.save-location-row');
        if (!row) return;
        const index = Number.parseInt(row.dataset.index, 10);
        if (event.target?.classList?.contains?.('save-location-swatch')) {
          const colorInput = row.querySelector('.save-location-color');
          const nextColor = normalizeColor(event.target.dataset.color);
          if (colorInput) colorInput.value = nextColor;
          applySaveLocationColor(row, nextColor);
          scheduleAutoSave(0);
          return;
        }
        if (event.target?.classList?.contains?.('save-location-up')) moveSaveLocation(index, -1);
        if (event.target?.classList?.contains?.('save-location-down')) moveSaveLocation(index, 1);
        if (event.target?.classList?.contains?.('save-location-remove')) removeSaveLocation(index);
      });
    }

    return {
      bindSettingsEvents,
      collectSettingsFromForm,
      loadSettings,
      persistSettings,
      renderSaveLocations,
      scheduleAutoSave,
      setSaveButtonState,
    };
  }

  global.PopupSettings = {
    createSettingsController,
  };
})(globalThis);
