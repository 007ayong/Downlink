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

    function normalizeShortcutInput(value) {
      const tokens = String(value || '')
        .toLowerCase()
        .replace(/control/g, 'ctrl')
        .replace(/option/g, 'alt')
        .replace(/command|cmd|meta/g, 'cmd')
        .split(/[^a-z]+/)
        .filter(Boolean);
      if (tokens.includes('none') || tokens.includes('off')) return 'none';
      const ordered = ['ctrl', 'alt', 'shift', 'cmd'].filter((key) => tokens.includes(key));
      return ordered.join('+') || 'alt';
    }

    function shortcutFromKeyboardEvent(event) {
      const keyAliases = {
        control: 'ctrl',
        ctrl: 'ctrl',
        alt: 'alt',
        option: 'alt',
        shift: 'shift',
        command: 'cmd',
        cmd: 'cmd',
      };
      const eventKey = keyAliases[event.key?.toLowerCase?.()] || '';
      const keys = [];
      if (event.ctrlKey || eventKey === 'ctrl') keys.push('ctrl');
      if (event.altKey || eventKey === 'alt') keys.push('alt');
      if (event.shiftKey || eventKey === 'shift') keys.push('shift');
      if (event.metaKey || eventKey === 'cmd') keys.push('cmd');
      return keys.join('+');
    }

    function collectSettingsFromForm() {
      return {
        downloaderType: document.getElementById('cfgDownloaderType').value,
        language: document.getElementById('cfgLanguage').value || 'auto',
        aria2Rpc: document.getElementById('cfgRpc').value.trim() || 'http://localhost:6800/jsonrpc',
        aria2Secret: document.getElementById('cfgSecret').value.trim(),
        saveDir: document.getElementById('cfgSaveDir').value.trim(),
        aria2Silent: document.getElementById('cfgAria2Silent').checked,
        useMotrixNext: document.getElementById('cfgUseMotrixNext').checked,
        motrixBridgeAutoClose: document.getElementById('cfgMotrixBridgeAutoClose').checked,
        motrixNextPort: document.getElementById('cfgMotrixNextPort').value.trim() || '16801',
        motrixNextSecret: document.getElementById('cfgMotrixNextSecret').value.trim(),
        externalLauncherName: AB_DM_NAME,
        externalLauncherHost: document.getElementById('cfgLauncherHost').value.trim() || 'localhost',
        externalLauncherPort: document.getElementById('cfgLauncherPort').value.trim() || '15151',
        abDownloadSilent: document.getElementById('cfgAbDownloadSilent').checked,
        autoCapture: document.getElementById('cfgAutoCapture').checked,
        captureBypassModifier: normalizeShortcutInput(document.getElementById('cfgCaptureBypassModifier').value),
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
        cfg.motrixNextSecret !== prevCfg.motrixNextSecret
      );
      chrome.runtime.sendMessage({ type: 'SAVE_CONFIG', config: cfg }, () => {
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
      const nextCfg = collectSettingsFromForm();
      setCurrentConfig({ ...getCurrentConfig(), ...nextCfg });
      updateSettingsVisibility(nextCfg.downloaderType);
      updateDynamicLabels(nextCfg);
      const state = getCurrentState();
      renderTasks(state.tasks, state.pending);
      setSaveButtonState(t('autoSavingSettings', undefined, '自动保存中…'), -1);
      setAutoSaveTimer(setTimeout(() => {
        persistSettings(collectSettingsFromForm());
      }, delay));
      syncGlobals();
    }

    function loadSettings(cfg) {
      if (!cfg) return;
      setLoading(true);
      setCurrentConfig({ ...cfg });
      setSavedConfig({ ...cfg });
      document.getElementById('cfgDownloaderType').value = cfg.downloaderType || 'aria2';
      document.getElementById('cfgLanguage').value = cfg.language || 'auto';
      document.getElementById('cfgRpc').value = cfg.aria2Rpc || '';
      document.getElementById('cfgSecret').value = cfg.aria2Secret || '';
      document.getElementById('cfgSaveDir').value = cfg.saveDir || '';
      document.getElementById('cfgAria2Silent').checked = !!cfg.aria2Silent;
      document.getElementById('cfgUseMotrixNext').checked = !!cfg.useMotrixNext;
      document.getElementById('cfgMotrixBridgeAutoClose').checked = !!cfg.motrixBridgeAutoClose;
      document.getElementById('cfgMotrixNextPort').value = cfg.motrixNextPort || '16801';
      document.getElementById('cfgMotrixNextSecret').value = cfg.motrixNextSecret || '';
      document.getElementById('cfgLauncherHost').value = cfg.externalLauncherHost || 'localhost';
      document.getElementById('cfgLauncherPort').value = cfg.externalLauncherPort || '15151';
      document.getElementById('cfgAbDownloadSilent').checked = !!cfg.abDownloadSilent;
      document.getElementById('cfgAutoCapture').checked = !!cfg.autoCapture;
      document.getElementById('cfgCaptureBypassModifier').value = normalizeShortcutInput(cfg.captureBypassModifier || 'alt');
      document.getElementById('cfgExts').value = cfg.captureExtensions || '';
      document.getElementById('cfgSkipSmallDownloads').checked = !!cfg.skipSmallDownloads;
      document.getElementById('cfgSmallDownloadThresholdMb').value = ((Number(cfg.smallDownloadThresholdBytes) || 1048576) / 1024 / 1024).toString();
      updateSettingsVisibility(cfg.downloaderType || 'aria2');
      updateDynamicLabels(cfg);
      setLoading(false);
      syncGlobals();
      requestAutoConnectionCheck?.(cfg);
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
        'cfgSaveDir',
        'cfgMotrixNextPort',
        'cfgMotrixNextSecret',
        'cfgLauncherHost',
        'cfgLauncherPort',
        'cfgCaptureBypassModifier',
        'cfgExts',
        'cfgSmallDownloadThresholdMb',
      ].forEach((id) => {
        const el = document.getElementById(id);
        if (id === 'cfgCaptureBypassModifier') {
          el.readOnly = true;
          el.addEventListener('keydown', (event) => {
            if (event.key === 'Tab') return;
            event.preventDefault?.();
            if (event.key === 'Backspace' || event.key === 'Delete') {
              el.value = 'none';
            } else {
              const shortcut = shortcutFromKeyboardEvent(event);
              if (!shortcut) return;
              el.value = shortcut;
            }
            scheduleAutoSave(0);
          });
          el.addEventListener('blur', () => {
            el.value = normalizeShortcutInput(el.value);
          });
        }
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

      ['cfgAutoCapture', 'cfgAria2Silent', 'cfgUseMotrixNext', 'cfgMotrixBridgeAutoClose', 'cfgAbDownloadSilent', 'cfgSkipSmallDownloads'].forEach((id) => {
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
