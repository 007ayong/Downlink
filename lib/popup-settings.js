(function initPopupSettings(global) {
    const t = global.Localization?.t || ((key, substitutions, fallback = key) => {
      if (fallback && substitutions !== undefined) {
        const values = Array.isArray(substitutions) ? substitutions : [substitutions];
        return String(fallback).replace(/\$(\d+)/g, (_, index) => String(values[Number(index) - 1] ?? ''));
      }
      return fallback || key;
    });

    function createSettingsController({
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

    function collectSettingsFromForm() {
      return {
        downloaderType: document.getElementById('cfgDownloaderType').value,
        language: document.getElementById('cfgLanguage').value || 'auto',
        aria2Rpc: document.getElementById('cfgRpc').value.trim() || 'http://localhost:6800/jsonrpc',
        aria2Secret: document.getElementById('cfgSecret').value.trim(),
        aria2Silent: document.getElementById('cfgAria2Silent').checked,
        useMotrixNext: document.getElementById('cfgUseMotrixNext').checked,
        motrixBridgeAutoClose: document.getElementById('cfgMotrixBridgeAutoClose').checked,
        motrixNextPort: document.getElementById('cfgMotrixNextPort').value.trim() || '16801',
        motrixNextSecret: document.getElementById('cfgMotrixNextSecret').value.trim(),
        gopeedApi: document.getElementById('cfgGopeedApi').value.trim() || 'http://127.0.0.1:9999',
        gopeedToken: document.getElementById('cfgGopeedToken').value.trim(),
        externalLauncherName: AB_DM_NAME,
        externalLauncherHost: document.getElementById('cfgLauncherHost').value.trim() || 'localhost',
        externalLauncherPort: document.getElementById('cfgLauncherPort').value.trim() || '15151',
        abDownloadSilent: document.getElementById('cfgAbDownloadSilent').checked,
        autoCapture: document.getElementById('cfgAutoCapture').checked,
        mediaSniffing: document.getElementById('cfgMediaSniffing').checked,
        captureExtensions: document.getElementById('cfgExts').value.trim(),
        skipSmallDownloads: document.getElementById('cfgSkipSmallDownloads').checked,
        smallDownloadThresholdBytes: Math.max(0.1, Number.parseFloat(document.getElementById('cfgSmallDownloadThresholdMb').value) || 1) * 1024 * 1024,
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
      clearTimeout(getAutoSaveTimer());
      setSaveButtonState(t('savingSettings', undefined, '保存中…'), -1);
      const prevCfg = getSavedConfig();
      const shouldRetestConnection = (
        cfg.downloaderType !== prevCfg.downloaderType ||
        cfg.aria2Rpc !== prevCfg.aria2Rpc ||
        cfg.aria2Secret !== prevCfg.aria2Secret ||
        cfg.externalLauncherHost !== prevCfg.externalLauncherHost ||
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
      const normalizedCfg = { ...getCurrentConfig(), ...cfg };
      setCurrentConfig({ ...normalizedCfg });
      setSavedConfig({ ...normalizedCfg });
      document.getElementById('cfgDownloaderType').value = normalizedCfg.downloaderType || 'aria2';
      document.getElementById('cfgLanguage').value = normalizedCfg.language || 'auto';
      document.getElementById('cfgRpc').value = normalizedCfg.aria2Rpc || '';
      document.getElementById('cfgSecret').value = normalizedCfg.aria2Secret || '';
      document.getElementById('cfgAria2Silent').checked = !!normalizedCfg.aria2Silent;
      document.getElementById('cfgUseMotrixNext').checked = !!normalizedCfg.useMotrixNext;
      document.getElementById('cfgMotrixBridgeAutoClose').checked = !!normalizedCfg.motrixBridgeAutoClose;
      document.getElementById('cfgMotrixNextPort').value = normalizedCfg.motrixNextPort || '16801';
      document.getElementById('cfgMotrixNextSecret').value = normalizedCfg.motrixNextSecret || '';
      document.getElementById('cfgGopeedApi').value = normalizedCfg.gopeedApi || 'http://127.0.0.1:9999';
      document.getElementById('cfgGopeedToken').value = normalizedCfg.gopeedToken || '';
      document.getElementById('cfgLauncherHost').value = normalizedCfg.externalLauncherHost || 'localhost';
      document.getElementById('cfgLauncherPort').value = normalizedCfg.externalLauncherPort || '15151';
      document.getElementById('cfgAbDownloadSilent').checked = !!normalizedCfg.abDownloadSilent;
      document.getElementById('cfgAutoCapture').checked = !!normalizedCfg.autoCapture;
      document.getElementById('cfgMediaSniffing').checked = normalizedCfg.mediaSniffing !== false;
      document.getElementById('cfgExts').value = normalizedCfg.captureExtensions || '';
      document.getElementById('cfgSkipSmallDownloads').checked = !!normalizedCfg.skipSmallDownloads;
      document.getElementById('cfgSmallDownloadThresholdMb').value = ((Number(normalizedCfg.smallDownloadThresholdBytes) || 1048576) / 1024 / 1024).toString();
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
        'cfgRpc',
        'cfgSecret',
        'cfgMotrixNextPort',
        'cfgMotrixNextSecret',
        'cfgGopeedApi',
        'cfgGopeedToken',
        'cfgLauncherHost',
        'cfgLauncherPort',
        'cfgExts',
        'cfgSmallDownloadThresholdMb',
      ].forEach((id) => {
        const el = document.getElementById(id);
        el.addEventListener('input', () => {
          if (id === 'cfgLauncherHost' || id === 'cfgLauncherPort') {
            const nextCfg = { ...getCurrentConfig(), externalLauncherName: AB_DM_NAME };
            setCurrentConfig(nextCfg);
            updateDynamicLabels(nextCfg);
            syncGlobals();
          }
          scheduleAutoSave();
        });
        el.addEventListener('change', () => {
          if (id === 'cfgLauncherHost' || id === 'cfgLauncherPort') {
            const nextCfg = { ...getCurrentConfig(), externalLauncherName: AB_DM_NAME };
            setCurrentConfig(nextCfg);
            updateDynamicLabels(nextCfg);
            syncGlobals();
          }
          scheduleAutoSave(0);
        });
      });

      ['cfgAutoCapture', 'cfgMediaSniffing', 'cfgAria2Silent', 'cfgUseMotrixNext', 'cfgMotrixBridgeAutoClose', 'cfgAbDownloadSilent', 'cfgSkipSmallDownloads'].forEach((id) => {
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
