(function initPopupSettings(global) {
  function createSettingsController({
    getCurrentConfig,
    setCurrentConfig,
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
    updateHeaderStatusDisplay,
    renderTasks,
    checkStatus,
  }) {
    const AB_DM_NAME = 'AB DM';

    function collectSettingsFromForm() {
      return {
        downloaderType: document.getElementById('cfgDownloaderType').value,
        aria2Rpc: document.getElementById('cfgRpc').value.trim() || 'http://localhost:6800/jsonrpc',
        aria2Secret: document.getElementById('cfgSecret').value.trim(),
        saveDir: document.getElementById('cfgSaveDir').value.trim(),
        useMotrixNext: document.getElementById('cfgUseMotrixNext').checked,
        externalLauncherName: AB_DM_NAME,
        externalLauncherHost: document.getElementById('cfgLauncherHost').value.trim() || 'localhost',
        externalLauncherPort: document.getElementById('cfgLauncherPort').value.trim() || '15151',
        externalLauncherPath: document.getElementById('cfgLauncherPath').value.trim() || '/start-headless-download',
        autoCapture: document.getElementById('cfgAutoCapture').checked,
        showConfirm: document.getElementById('cfgShowConfirm').checked,
        captureExtensions: document.getElementById('cfgExts').value.trim(),
        notification: document.getElementById('cfgNotification').checked,
      };
    }

    function setSaveButtonState(text, resetDelay = 1500) {
      const btn = document.getElementById('saveSettingsBtn');
      if (!btn) return;
      btn.textContent = text;
      clearTimeout(getSaveFeedbackTimer());
      if (resetDelay >= 0) {
        setSaveFeedbackTimer(setTimeout(() => {
          btn.textContent = '保存设置';
        }, resetDelay));
      }
      syncGlobals();
    }

    function persistSettings(cfg, { showSavedFeedback = true } = {}) {
      clearTimeout(getAutoSaveTimer());
      setSaveButtonState('保存中…', -1);
      chrome.runtime.sendMessage({ type: 'SAVE_CONFIG', config: cfg }, () => {
        setCurrentConfig({ ...cfg });
        updateSettingsVisibility(cfg.downloaderType);
        updateDynamicLabels(cfg);
        const state = getCurrentState();
        renderTasks(state.tasks, state.pending);
        updateHeaderStatusDisplay({ cfg, state: 'checking' });
        syncGlobals();
        checkStatus(cfg);
        setSaveButtonState(showSavedFeedback ? '✓ 已自动保存' : '✓ 已保存');
      });
    }

    function scheduleAutoSave(delay = 350) {
      if (getLoading()) return;
      clearTimeout(getAutoSaveTimer());
      const nextCfg = collectSettingsFromForm();
      setCurrentConfig({ ...getCurrentConfig(), ...nextCfg });
      updateSettingsVisibility(nextCfg.downloaderType);
      updateDynamicLabels(nextCfg);
      const state = getCurrentState();
      renderTasks(state.tasks, state.pending);
      setSaveButtonState('自动保存中…', -1);
      setAutoSaveTimer(setTimeout(() => {
        persistSettings(collectSettingsFromForm());
      }, delay));
      syncGlobals();
    }

    function loadSettings(cfg) {
      if (!cfg) return;
      setLoading(true);
      setCurrentConfig({ ...cfg });
      document.getElementById('cfgDownloaderType').value = cfg.downloaderType || 'aria2';
      document.getElementById('cfgRpc').value = cfg.aria2Rpc || '';
      document.getElementById('cfgSecret').value = cfg.aria2Secret || '';
      document.getElementById('cfgSaveDir').value = cfg.saveDir || '';
      document.getElementById('cfgUseMotrixNext').checked = !!cfg.useMotrixNext;
      document.getElementById('cfgLauncherHost').value = cfg.externalLauncherHost || 'localhost';
      document.getElementById('cfgLauncherPort').value = cfg.externalLauncherPort || '15151';
      document.getElementById('cfgLauncherPath').value = cfg.externalLauncherPath || '/start-headless-download';
      document.getElementById('cfgAutoCapture').checked = !!cfg.autoCapture;
      document.getElementById('cfgShowConfirm').checked = !!cfg.showConfirm;
      document.getElementById('cfgExts').value = cfg.captureExtensions || '';
      document.getElementById('cfgNotification').checked = !!cfg.notification;
      updateSettingsVisibility(cfg.downloaderType || 'aria2');
      updateDynamicLabels(cfg);
      updateHeaderStatusDisplay({ cfg, state: 'checking' });
      setLoading(false);
      syncGlobals();
    }

    function bindSettingsEvents() {
      document.getElementById('saveSettingsBtn').addEventListener('click', () => {
        persistSettings(collectSettingsFromForm(), { showSavedFeedback: false });
      });

      document.getElementById('cfgDownloaderType').addEventListener('change', (event) => {
        const currentConfig = getCurrentConfig();
        const nextCfg = {
          ...currentConfig,
          downloaderType: event.target.value,
          externalLauncherName: AB_DM_NAME,
        };
        setCurrentConfig(nextCfg);
        updateSettingsVisibility(nextCfg.downloaderType);
        updateDynamicLabels(nextCfg);
        updateHeaderStatusDisplay({ cfg: nextCfg, state: 'checking' });
        syncGlobals();
        scheduleAutoSave(0);
      });

      [
        'cfgRpc',
        'cfgSecret',
        'cfgSaveDir',
        'cfgLauncherHost',
        'cfgLauncherPort',
        'cfgLauncherPath',
        'cfgExts',
      ].forEach((id) => {
        const el = document.getElementById(id);
        el.addEventListener('input', () => {
          if (id === 'cfgLauncherHost' || id === 'cfgLauncherPort' || id === 'cfgLauncherPath') {
            const nextCfg = { ...getCurrentConfig(), externalLauncherName: AB_DM_NAME };
            setCurrentConfig(nextCfg);
            updateDynamicLabels(nextCfg);
            updateHeaderStatusDisplay({ cfg: nextCfg, state: 'checking' });
            syncGlobals();
          }
          scheduleAutoSave();
        });
        el.addEventListener('change', () => {
          if (id === 'cfgLauncherHost' || id === 'cfgLauncherPort' || id === 'cfgLauncherPath') {
            const nextCfg = { ...getCurrentConfig(), externalLauncherName: AB_DM_NAME };
            setCurrentConfig(nextCfg);
            updateDynamicLabels(nextCfg);
            updateHeaderStatusDisplay({ cfg: nextCfg, state: 'checking' });
            syncGlobals();
          }
          scheduleAutoSave(0);
        });
      });

      ['cfgAutoCapture', 'cfgShowConfirm', 'cfgNotification', 'cfgUseMotrixNext'].forEach((id) => {
        document.getElementById(id).addEventListener('change', () => scheduleAutoSave(0));
      });
    }

    return {
      bindSettingsEvents,
      collectSettingsFromForm,
      loadSettings,
      persistSettings,
      scheduleAutoSave,
      setSaveButtonState,
    };
  }

  global.PopupSettings = {
    createSettingsController,
  };
})(globalThis);
