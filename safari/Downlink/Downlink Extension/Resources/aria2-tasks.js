(function initAria2TasksPage() {
  'use strict';

  const DEFAULT_RPC = 'http://localhost:6800/jsonrpc';
  const REFRESH_INTERVAL_MS = 3000;
  const HISTORY_LIMIT = 1000;
  const DETAIL_FILE_LIMIT = 50;
  const DETAIL_URI_LIMIT = 3;
  const isZh = (navigator.language || '').toLowerCase().includes('zh');

  const T = isZh
    ? {
      pageTitle: 'Aria2 任务管理',
      statusChecking: '检测中…',
      statusOk: '已连接',
      statusOffline: '未连接',
      statSpeedLabel: '下载',
      statUpSpeedLabel: '上传',
      statActiveLabel: '下载中',
      statPausedLabel: '已暂停',
      statWaitingLabel: '等待中',
      statStoppedLabel: '已完成',
      filterAll: '全部',
      filterActive: '下载中',
      filterWaiting: '等待中',
      filterPaused: '已暂停',
      filterStopped: '已完成',
      searchPlaceholder: '搜索文件名 / GID / 路径…',
      queueTitle: '任务队列',
      fileNameColumn: '文件名',
      progressColumn: '下载进度',
      speedColumn: '速度',
      stateColumn: '状态',
      actionsColumn: '操作',
      purgeAll: '清除已完成',
      pauseAll: '全部暂停',
      resumeAll: '全部继续',
      bulkPause: '批量暂停',
      bulkResume: '批量启用',
      bulkDone: '已处理 $1 个任务',
      noEligibleSelected: '所选任务没有可执行此操作的项目',
      refresh: '刷新',
      refreshing: '刷新中…',
      globalSettings: '全局设置',
      rpcConnection: 'RPC 连接',
      createTask: '新建任务',
      createTaskTitle: '新建下载任务',
      createTaskSub: '支持 HTTP、FTP、磁力链接与 aria2c 支持的地址',
      createTaskUrisLabel: '下载链接',
      createTaskUrisPlaceholder: 'https://example.com/file.iso\nmagnet:?xt=urn:btih:...',
      createTaskUrisHelp: '每行一个链接。多行会创建多个独立任务。',
      createTaskDirLabel: '本次保存位置（可选）',
      createTaskDirPlaceholder: '使用全局默认保存位置',
      createTaskSubmit: '加入下载队列',
      createTaskQueued: '已加入 $1 个任务',
      createTaskRequired: '请至少输入一个下载链接',
      globalSettingsTitle: 'Aria2 全局设置',
      globalSettingsSub: '应用于之后新加入的下载任务',
      globalDirLabel: '默认保存位置',
      globalDirPlaceholder: '/Users/name/Downloads',
      globalDirHelp: '留空时使用 aria2c 当前配置中的默认目录。',
      globalConcurrentLabel: '最大并行下载',
      globalSettingsNote: '设置会立即同步到正在运行的 Aria2。若需在重启 aria2c 后保留，请同时写入 aria2.conf。',
      cancel: '取消',
      saveSettings: '保存并应用',
      settingsSaved: '全局设置已应用',
      autoRefreshNote: '自动刷新：3 秒',
      close: '关闭',
      selectTaskHint: '选择一个任务查看详情',
      selectTask: '选择任务',
      emptyTitle: '暂无任务',
      emptySub: '任务会实时显示在这里',
      loadFailed: '无法连接 Aria2 RPC：$1',
      taskStateActive: '下载中',
      taskStateWaiting: '等待中',
      taskStatePaused: '已暂停',
      taskStateComplete: '已完成',
      taskStateError: '错误',
      taskStateRemoved: '已移除',
      taskStateUnknown: '未知',
      progressLabel: '进度',
      sizeLabel: '大小',
      speedLabel: '速度',
      etaLabel: '剩余时间',
      connectionsLabel: '连接数',
      seedersLabel: '做种数',
      infoHashLabel: 'Info Hash',
      downloadDirLabel: '保存目录',
      gidLabel: 'GID',
      stateLabel: '状态',
      errorLabel: '错误信息',
      filesLabel: '文件列表',
      filesMore: '仅显示前 $1 项，共 $2 项',
      addedTimeLabel: '添加时间',
      completedTimeLabel: '完成时间',
      actionPause: '暂停',
      actionResume: '继续',
      actionRemove: '移除任务',
      actionRemoveResult: '删除记录',
      actionRedownload: '重新下载',
      confirmRemove: '确定要移除任务 $1 吗？',
      confirmRemoveResult: '确定要删除这条完成/停止记录吗？',
      confirmPurge: '确定要清除所有已完成/已停止的任务记录吗？此操作不可恢复。',
      confirmRedownload: '确定要重新下载 $1 吗？将按原地址加入新任务。',
      actionDone: '操作完成',
      actionFailed: '操作失败：$1',
      noFiles: '无文件信息',
      unknownFile: '未知文件',
      unknownSize: '大小未知',
      etaInfinity: '—',
      waitingDetail: '等待中',
      pausedDetail: '已暂停',
      downloadProgressLabel: '下载进度',
      linksLabel: '下载链接',
      moreLinks: '还有 $1 个不同链接',
      noLinks: '无可用下载链接',
      copyLink: '复制链接',
      copyLinks: '复制全部链接',
      copiedLink: '已复制链接',
      copiedLinks: '已复制全部链接',
      copyGid: '复制 GID',
      copiedGid: '已复制 GID',
      copyFailed: '复制失败',
      rpcEndpointLabel: 'RPC：$1',
      metaLabel: '基本信息',
      noUriForRedownload: '该任务没有可用的下载地址，无法重新下载',
      redownloadQueued: '已重新加入下载队列',
    }
    : {
      pageTitle: 'Aria2 Tasks',
      statusChecking: 'Checking…',
      statusOk: 'Connected',
      statusOffline: 'Offline',
      statSpeedLabel: 'Down',
      statUpSpeedLabel: 'Up',
      statActiveLabel: 'Active',
      statPausedLabel: 'Paused',
      statWaitingLabel: 'Waiting',
      statStoppedLabel: 'Stopped',
      filterAll: 'All',
      filterActive: 'Active',
      filterWaiting: 'Waiting',
      filterPaused: 'Paused',
      filterStopped: 'Stopped',
      searchPlaceholder: 'Search name / GID / path…',
      queueTitle: 'Task queue',
      fileNameColumn: 'File name',
      progressColumn: 'Progress',
      speedColumn: 'Speed',
      stateColumn: 'Status',
      actionsColumn: 'Actions',
      purgeAll: 'Clear stopped',
      pauseAll: 'Pause all',
      resumeAll: 'Resume all',
      bulkPause: 'Pause selected',
      bulkResume: 'Resume selected',
      bulkDone: '$1 task(s) processed',
      noEligibleSelected: 'No selected tasks can perform this action',
      refresh: 'Refresh',
      refreshing: 'Refreshing…',
      globalSettings: 'Global settings',
      rpcConnection: 'RPC connection',
      createTask: 'New task',
      createTaskTitle: 'Create download task',
      createTaskSub: 'HTTP, FTP, magnet links, and other aria2c-supported addresses',
      createTaskUrisLabel: 'Download URLs',
      createTaskUrisPlaceholder: 'https://example.com/file.iso\nmagnet:?xt=urn:btih:...',
      createTaskUrisHelp: 'One URL per line. Each line becomes an independent task.',
      createTaskDirLabel: 'Save location for this batch (optional)',
      createTaskDirPlaceholder: 'Use global default directory',
      createTaskSubmit: 'Add to queue',
      createTaskQueued: '$1 task(s) added to queue',
      createTaskRequired: 'Enter at least one download URL',
      globalSettingsTitle: 'Aria2 global settings',
      globalSettingsSub: 'Applies to downloads added from now on',
      globalDirLabel: 'Default download directory',
      globalDirPlaceholder: '/Users/name/Downloads',
      globalDirHelp: 'Leave blank to retain aria2c’s current default directory.',
      globalConcurrentLabel: 'Concurrent downloads',
      globalSettingsNote: 'Changes are applied to the running Aria2 immediately. Add them to aria2.conf to keep them after restarting aria2c.',
      cancel: 'Cancel',
      saveSettings: 'Save & apply',
      settingsSaved: 'Global settings applied',
      autoRefreshNote: 'Auto refresh: 3s',
      close: 'Close',
      selectTaskHint: 'Select a task to view details',
      selectTask: 'Select task',
      emptyTitle: 'No tasks',
      emptySub: 'Tasks will appear here in real time',
      loadFailed: 'Cannot reach Aria2 RPC: $1',
      taskStateActive: 'Active',
      taskStateWaiting: 'Waiting',
      taskStatePaused: 'Paused',
      taskStateComplete: 'Complete',
      taskStateError: 'Error',
      taskStateRemoved: 'Removed',
      taskStateUnknown: 'Unknown',
      progressLabel: 'Progress',
      sizeLabel: 'Size',
      speedLabel: 'Speed',
      etaLabel: 'ETA',
      connectionsLabel: 'Connections',
      seedersLabel: 'Seeders',
      infoHashLabel: 'Info Hash',
      downloadDirLabel: 'Directory',
      gidLabel: 'GID',
      stateLabel: 'Status',
      errorLabel: 'Error',
      filesLabel: 'Files',
      filesMore: 'Showing the first $1 of $2 files',
      addedTimeLabel: 'Added',
      completedTimeLabel: 'Completed',
      actionPause: 'Pause',
      actionResume: 'Resume',
      actionRemove: 'Remove task',
      actionRemoveResult: 'Delete record',
      actionRedownload: 'Re-download',
      confirmRemove: 'Remove task $1?',
      confirmRemoveResult: 'Delete this stopped record?',
      confirmPurge: 'Clear all stopped task records? This cannot be undone.',
      confirmRedownload: 'Re-download $1 from the original URL?',
      actionDone: 'Done',
      actionFailed: 'Failed: $1',
      noFiles: 'No file info',
      unknownFile: 'Unknown file',
      unknownSize: 'Unknown size',
      etaInfinity: '—',
      waitingDetail: 'Waiting',
      pausedDetail: 'Paused',
      downloadProgressLabel: 'Download progress',
      linksLabel: 'Download links',
      moreLinks: '$1 more distinct links',
      noLinks: 'No download links available',
      copyLink: 'Copy link',
      copyLinks: 'Copy all links',
      copiedLink: 'Link copied',
      copiedLinks: 'All links copied',
      copyGid: 'Copy GID',
      copiedGid: 'GID copied',
      copyFailed: 'Copy failed',
      rpcEndpointLabel: 'RPC: $1',
      metaLabel: 'Details',
      noUriForRedownload: 'No usable URL in this task, cannot re-download',
      redownloadQueued: 'Task queued for re-download',
    };

  const FILE_ICON_MAP = {
    video: 'assets/file-icons/media-list-video.png',
    audio: 'assets/file-icons/media-list-audio.png',
    image: 'assets/file-icons/image.svg',
    archive: 'assets/file-icons/archive.svg',
    document: 'assets/file-icons/document.svg',
    pdf: 'assets/file-icons/pdf.svg',
    spreadsheet: 'assets/file-icons/spreadsheet.svg',
    executable: 'assets/file-icons/executable.svg',
    torrent: 'assets/file-icons/torrent.svg',
    default: 'assets/file-icons/default.svg',
  };
  const EXECUTABLE_EXTENSIONS = new Set(['exe', 'msi', 'dmg', 'pkg', 'deb', 'apk', 'appimage', 'bin']);
  const DOCUMENT_EXTENSIONS = new Set(['doc', 'docx', 'txt', 'md', 'rtf', 'odt']);
  const SPREADSHEET_EXTENSIONS = new Set(['xls', 'xlsx', 'csv', 'tsv', 'ods']);
  const ARCHIVE_EXTENSIONS = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'zst', 'iso']);

  const state = {
    config: null,
    snapshot: null,
    tasks: [],
    filter: 'all',
    search: '',
    detailGid: '',
    selectedGids: new Set(),
    loaded: false,
    loading: false,
  };

  const $ = (id) => document.getElementById(id);

  function l10n() {
    document.title = T.pageTitle;
    $('statusText').textContent = T.statusChecking;
    document.querySelectorAll('[data-l10n]').forEach((el) => {
      const key = el.dataset.l10n;
      if (T[key]) el.textContent = T[key];
    });
    document.querySelectorAll('[data-l10n-placeholder]').forEach((el) => {
      const key = el.dataset.l10nPlaceholder;
      if (T[key]) el.placeholder = T[key];
    });
    document.querySelectorAll('[data-l10n-title]').forEach((el) => {
      const key = el.dataset.l10nTitle;
      if (T[key]) el.title = T[key];
    });
    document.querySelectorAll('[data-l10n-option]').forEach((el) => {
      const key = el.dataset.l10nOption;
      if (T[key]) el.textContent = T[key];
    });
  }

  function fmtBytes(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
    return `${(value / Math.pow(1024, index)).toFixed(index > 0 ? 1 : 0)} ${units[index]}`;
  }

  function fmtSpeed(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value <= 0) return '—';
    return `${fmtBytes(value)}/s`;
  }

  function fmtEta(speed, total, completed) {
    const remaining = Number(total) - Number(completed);
    if (!Number.isFinite(speed) || speed <= 0 || !Number.isFinite(remaining) || remaining <= 0) return T.etaInfinity;
    const sec = remaining / speed;
    if (sec < 60) return `${Math.ceil(sec)}s`;
    if (sec < 3600) return `${Math.ceil(sec / 60)}m`;
    if (sec < 86400) return `${(sec / 3600).toFixed(1)}h`;
    return `${(sec / 86400).toFixed(1)}d`;
  }

  function fmtTime(unixSec) {
    const value = Number(unixSec);
    if (!Number.isFinite(value) || value <= 0) return '—';
    const date = new Date(value * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  function extFromName(name = '') {
    const normalized = String(name || '').trim().toLowerCase();
    if (!normalized.includes('.')) return '';
    return normalized.split('.').pop();
  }

  function fileIcon(name = '', mime = '') {
    const normalizedMime = String(mime || '').split(';')[0].trim().toLowerCase();
    if (normalizedMime.startsWith('video/')) return FILE_ICON_MAP.video;
    if (normalizedMime.startsWith('audio/')) return FILE_ICON_MAP.audio;
    if (normalizedMime.startsWith('image/')) return FILE_ICON_MAP.image;
    if (normalizedMime === 'application/pdf') return FILE_ICON_MAP.pdf;
    if (normalizedMime.includes('zip') || normalizedMime.includes('compressed') || normalizedMime.includes('archive')) return FILE_ICON_MAP.archive;
    if (normalizedMime.includes('bittorrent')) return FILE_ICON_MAP.torrent;
    if (normalizedMime.includes('word') || normalizedMime.includes('text')) return FILE_ICON_MAP.document;
    if (normalizedMime.includes('spreadsheet') || normalizedMime === 'text/csv') return FILE_ICON_MAP.spreadsheet;
    const ext = extFromName(name);
    if (EXECUTABLE_EXTENSIONS.has(ext)) return FILE_ICON_MAP.executable;
    if (DOCUMENT_EXTENSIONS.has(ext)) return FILE_ICON_MAP.document;
    if (SPREADSHEET_EXTENSIONS.has(ext)) return FILE_ICON_MAP.spreadsheet;
    if (ARCHIVE_EXTENSIONS.has(ext)) return FILE_ICON_MAP.archive;
    if (ext === 'pdf') return FILE_ICON_MAP.pdf;
    if (['mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'ts', 'm3u8'].includes(ext)) return FILE_ICON_MAP.video;
    if (['mp3', 'flac', 'wav', 'aac', 'ogg', 'm4a', 'opus'].includes(ext)) return FILE_ICON_MAP.audio;
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'heic'].includes(ext)) return FILE_ICON_MAP.image;
    if (['torrent'].includes(ext)) return FILE_ICON_MAP.torrent;
    return FILE_ICON_MAP.default;
  }

  function getConfig() {
    return new Promise((resolve) => {
      const extensionApi = globalThis.chrome;
      if (!extensionApi?.storage?.sync?.get) {
        resolve({ aria2Rpc: DEFAULT_RPC, aria2Secret: '', aria2PanelDownloadDir: '', aria2PanelMaxConcurrent: '' });
        return;
      }
      extensionApi.storage.sync.get({
        aria2Rpc: DEFAULT_RPC,
        aria2Secret: '',
        aria2PanelDownloadDir: '',
        aria2PanelMaxConcurrent: '',
      }, (stored) => {
        resolve({
          aria2Rpc: String(stored?.aria2Rpc || DEFAULT_RPC).trim() || DEFAULT_RPC,
          aria2Secret: String(stored?.aria2Secret || ''),
          aria2PanelDownloadDir: String(stored?.aria2PanelDownloadDir || ''),
          aria2PanelMaxConcurrent: String(stored?.aria2PanelMaxConcurrent || ''),
        });
      });
    });
  }

  function setRpcEndpoint(endpoint) {
    const label = $('rpcEndpoint');
    const value = String(endpoint || DEFAULT_RPC).trim() || DEFAULT_RPC;
    if (label) label.textContent = T.rpcEndpointLabel.replace('$1', value);
  }

  function rpc(method, params = []) {
    return new Promise((resolve, reject) => {
      const runtime = globalThis.chrome?.runtime;
      if (!runtime?.sendMessage) {
        reject(new Error('Extension runtime unavailable'));
        return;
      }
      runtime.sendMessage({ type: 'ARIA2_RPC', method, params }, (res) => {
        if (runtime.lastError) {
          reject(new Error(runtime.lastError.message || 'RPC unavailable'));
          return;
        }
        if (!res) {
          reject(new Error('No response from background'));
          return;
        }
        if (!res.ok) {
          reject(new Error(res.error || 'RPC failed'));
          return;
        }
        resolve(res.result);
      });
    });
  }

  function taskDisplayName(task) {
    const firstFile = task.files?.[0];
    if (firstFile?.path) {
      const parts = String(firstFile.path).split(/[\\/]/);
      const last = parts[parts.length - 1];
      if (last) return last;
    }
    const uri = firstFile?.uris?.[0]?.uri;
    if (uri) {
      const clean = String(uri).split('?')[0].split('/').pop();
      if (clean) return clean;
    }
    if (task.bittorrent?.info?.name) return task.bittorrent.info.name;
    return T.unknownFile;
  }

  function taskUriEntries(task) {
    const rawTask = task?.raw && typeof task.raw === 'object' ? task.raw : task;
    const files = Array.isArray(task?.files)
      ? task.files
      : (Array.isArray(rawTask?.files) ? rawTask.files : []);
    const seen = new Set();
    const entries = [];
    const firstFilePath = String(files[0]?.path || '');
    const originalUris = Array.isArray(task?.downlinkOriginalUris)
      ? task.downlinkOriginalUris
      : (Array.isArray(rawTask?.downlinkOriginalUris) ? rawTask.downlinkOriginalUris : []);

    originalUris.forEach((value) => {
      const uri = String(value || '').trim();
      if (!uri || seen.has(uri)) return;
      seen.add(uri);
      entries.push({ uri, filePath: firstFilePath });
    });
    if (entries.length) return entries;

    files.forEach((file) => {
      (Array.isArray(file?.uris) ? file.uris : []).forEach((entry) => {
        const uri = String(entry?.uri || '').trim();
        if (!uri || seen.has(uri)) return;
        seen.add(uri);
        entries.push({ uri, filePath: String(file?.path || '') });
      });
    });
    return entries;
  }

  function taskUris(task) {
    return taskUriEntries(task).map((entry) => entry.uri);
  }

  function shortenUriLabel(value, maxLength = 64) {
    const text = String(value || '');
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
  }

  function decodeUriLabel(value) {
    try { return decodeURIComponent(value); } catch (_) { return value; }
  }

  function uriDisplayLabel(uri) {
    try {
      const parsed = new URL(uri);
      const protocol = parsed.protocol.replace(':', '');
      if (protocol === 'magnet') {
        const name = parsed.searchParams.get('dn');
        return shortenUriLabel(name ? `magnet · ${decodeUriLabel(name)}` : 'magnet link');
      }
      const host = parsed.host || protocol || 'download';
      const pathname = decodeUriLabel(parsed.pathname || '/');
      const path = pathname.length > 48 ? `…${pathname.slice(-47)}` : pathname;
      return shortenUriLabel(`${host} · ${path}`);
    } catch (_) {
      return shortenUriLabel(String(uri).split(/[?#]/)[0] || 'download link');
    }
  }

  function firstTaskUri(task) {
    return taskUris(task)[0] || '';
  }

  function normalizeTask(raw) {
    const status = String(raw.status || '');
    const firstFile = raw.files?.[0] || {};
    const total = Number(raw.totalLength) || 0;
    const completed = Number(raw.completedLength) || 0;
    const pct = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : (status === 'complete' ? 100 : 0);
    const name = taskDisplayName(raw);
    const rawErrorCode = String(raw.errorCode ?? '').trim();
    const errorCode = rawErrorCode && rawErrorCode !== '0' ? rawErrorCode : '';
    return {
      gid: String(raw.gid || ''),
      raw,
      status,
      name,
      icon: fileIcon(name, firstFile.mime || ''),
      total,
      completed,
      pct,
      downloadProgressAvailable: total > 0 || status === 'complete',
      speed: Number(raw.downloadSpeed) || 0,
      uploadSpeed: Number(raw.uploadSpeed) || 0,
      dir: raw.dir || '',
      filePath: firstFile.path || '',
      addedTime: Number(raw.addedTime) || 0,
      completedTime: Number(raw.completedTime) || 0,
      connections: Number(raw.connections) || 0,
      numSeeders: Number(raw.numSeeders) || 0,
      errorCode,
      errorMessage: errorCode ? (raw.errorMessage || '') : '',
      infoHash: raw.infoHash || '',
      isTorrent: !!(raw.bittorrent && raw.bittorrent.info),
      uri: firstTaskUri(raw),
      uris: taskUris(raw),
    };
  }

  function buildSnapshot(activeRaw, waitingRaw, stoppedRaw, globalStat) {
    const byGid = new Map();
    const add = (raw) => {
      if (!raw || !raw.gid) return;
      byGid.set(String(raw.gid), normalizeTask(raw));
    };
    (Array.isArray(activeRaw) ? activeRaw : []).forEach(add);
    (Array.isArray(waitingRaw) ? waitingRaw : []).forEach(add);
    (Array.isArray(stoppedRaw) ? stoppedRaw : []).forEach(add);

    const all = Array.from(byGid.values());
    const activeTasks = all.filter((t) => t.status === 'active');
    const waitingTasks = all.filter((t) => t.status === 'waiting');
    const pausedTasks = all.filter((t) => t.status === 'paused');
    const stoppedTasks = all.filter((t) => ['complete', 'error', 'removed'].includes(t.status));
    const totalSpeed = activeTasks.reduce((sum, t) => sum + t.speed, 0);
    const totalUploadSpeed = activeTasks.reduce((sum, t) => sum + t.uploadSpeed, 0);

    return {
      all,
      activeTasks,
      waitingTasks,
      pausedTasks,
      stoppedTasks,
      totalSpeed,
      totalUploadSpeed,
      numActive: Number(globalStat?.numActive) || activeTasks.length,
      numWaiting: Number(globalStat?.numWaiting) || waitingTasks.length,
      numStopped: Number(globalStat?.numStopped) || stoppedTasks.length,
    };
  }

  async function loadSnapshot() {
    if (state.loading) return;
    state.loading = true;
    try {
      const [stat, active, waiting, stopped] = await Promise.all([
        rpc('getGlobalStat'),
        rpc('tellActive'),
        rpc('tellWaiting', [0, HISTORY_LIMIT]),
        rpc('tellStopped', [0, HISTORY_LIMIT]),
      ]);
      state.snapshot = buildSnapshot(active, waiting, stopped, stat);
      state.tasks = sortTasks(state.snapshot.all);
      const validGids = new Set(state.tasks.map((task) => task.gid));
      state.selectedGids.forEach((gid) => {
        if (!validGids.has(gid)) state.selectedGids.delete(gid);
      });
      if (state.detailGid && !validGids.has(state.detailGid)) state.detailGid = '';
      state.loaded = true;
      setStatus(true);
      setRpcEndpoint(state.config?.aria2Rpc || DEFAULT_RPC);
      render();
    } catch (error) {
      if (!state.loaded) {
        setStatus(false);
        showAlert(T.loadFailed.replace('$1', error?.message || String(error)));
      }
    } finally {
      state.loading = false;
    }
  }

  function sortTasks(tasks) {
    return tasks.sort((a, b) => {
      const groupOrder = { active: 0, waiting: 1, paused: 2, complete: 3, error: 4, removed: 5 };
      const ga = groupOrder[a.status] ?? 9;
      const gb = groupOrder[b.status] ?? 9;
      if (ga !== gb) return ga - gb;
      const timeA = a.status === 'active' ? (a.addedTime || 0) : (a.completedTime || a.addedTime || 0);
      const timeB = b.status === 'active' ? (b.addedTime || 0) : (b.completedTime || b.addedTime || 0);
      return timeB - timeA;
    });
  }

  function visibleTasks() {
    const keyword = state.search.trim().toLowerCase();
    return state.tasks.filter((task) => {
      if (state.filter === 'active' && task.status !== 'active') return false;
      if (state.filter === 'waiting' && task.status !== 'waiting') return false;
      if (state.filter === 'paused' && task.status !== 'paused') return false;
      if (state.filter === 'stopped' && !['complete', 'error', 'removed'].includes(task.status)) return false;
      if (!keyword) return true;
      const haystack = `${task.name} ${task.gid} ${task.dir} ${task.filePath} ${task.uri}`.toLowerCase();
      return haystack.includes(keyword);
    });
  }

  function statusClass(status) {
    return `status-${status}`;
  }

  function statusLabel(status) {
    return T[`taskState${status.charAt(0).toUpperCase()}${status.slice(1)}`] || T.taskStateUnknown;
  }

  const ICONS = {
    pause: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M5.25 3h1.5a.75.75 0 0 1 .75.75v8.5a.75.75 0 0 1-.75.75h-1.5a.75.75 0 0 1-.75-.75v-8.5A.75.75 0 0 1 5.25 3Zm4 0h1.5a.75.75 0 0 1 .75.75v8.5a.75.75 0 0 1-.75.75h-1.5a.75.75 0 0 1-.75-.75v-8.5A.75.75 0 0 1 9.25 3Z"/></svg>',
    play: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M5.1 3.05a.6.6 0 0 1 .9-.51l7.04 4.46a.6.6 0 0 1 0 1.02L6 12.48a.6.6 0 0 1-.9-.51V3.05Z"/></svg>',
    trash: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M5.5 1.75h5a.75.75 0 0 1 .75.75v1h2.5a.75.75 0 0 1 0 1.5h-.4l-.63 8.2A1.75 1.75 0 0 1 11 14.75H5A1.75 1.75 0 0 1 3.28 13.2l-.63-8.2h-.4a.75.75 0 0 1 0-1.5h2.5v-1a.75.75 0 0 1 .75-.75Zm.75 2.25h3.5V3h-3.5v1Zm-1.6 1.5.61 8.2a.25.25 0 0 0 .25.22h5.98a.25.25 0 0 0 .25-.22l.61-8.2H4.65Z"/></svg>',
    redownload: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 1a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm0 1.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11Zm.53 2.72a.75.75 0 0 0-1.06 0L5.9 6.79a.75.75 0 0 0 0 1.06l1.57 1.57a.75.75 0 0 0 1.06-1.06l-.32-.32h1.04a1.9 1.9 0 0 1 0 3.8H8.75a.75.75 0 0 0 0 1.5h.5a3.4 3.4 0 0 0 0-6.8H8.27l.32-.32a.75.75 0 0 0 0-1.06Z"/></svg>',
  };

  function iconBtn(action, icon, title, extraClass = '') {
    const btn = document.createElement('button');
    btn.className = `icon-btn${extraClass ? ` ${extraClass}` : ''}`;
    btn.dataset.action = action;
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.innerHTML = icon;
    return btn;
  }

  function selectedTasks() {
    return state.tasks.filter((task) => state.selectedGids.has(task.gid));
  }

  function updateBulkControls() {
    const count = selectedTasks().length;
    const pauseBtn = $('pauseAllBtn');
    const resumeBtn = $('resumeAllBtn');
    pauseBtn.textContent = count ? `${T.bulkPause} (${count})` : T.pauseAll;
    resumeBtn.textContent = count ? `${T.bulkResume} (${count})` : T.resumeAll;
    pauseBtn.title = count ? T.bulkPause : T.pauseAll;
    resumeBtn.title = count ? T.bulkResume : T.resumeAll;
  }

  function toggleTaskSelection(gid, checked) {
    if (checked) state.selectedGids.add(gid);
    else state.selectedGids.delete(gid);
    const row = Array.from(document.querySelectorAll('.task-row')).find((item) => item.dataset.gid === gid);
    updateBulkControls();
  }

  function syncDetailRowSelection() {
    document.querySelectorAll('.task-row').forEach((row) => {
      row.classList.toggle('selected', row.dataset.gid === state.detailGid);
    });
  }

  function createTaskRow(task) {
    const row = document.createElement('div');
    const isDetailSelected = task.gid === state.detailGid;
    const isChecked = state.selectedGids.has(task.gid);
    row.className = `task-row${isDetailSelected ? ' selected' : ''}`;
    row.dataset.gid = task.gid;

    const selectLabel = document.createElement('label');
    selectLabel.className = 'task-select';
    selectLabel.title = T.selectTask;
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = isChecked;
    checkbox.setAttribute('aria-label', `${T.selectTask}: ${task.name}`);
    checkbox.addEventListener('click', (event) => event.stopPropagation());
    checkbox.addEventListener('change', (event) => toggleTaskSelection(task.gid, event.target.checked));
    const checkmark = document.createElement('span');
    checkmark.className = 'task-check';
    selectLabel.append(checkbox, checkmark);

    const icon = document.createElement('div');
    icon.className = 'task-icon';
    const img = document.createElement('img');
    img.src = task.icon;
    img.alt = '';
    img.addEventListener('error', () => { img.src = FILE_ICON_MAP.default; });
    icon.appendChild(img);

    const info = document.createElement('div');
    info.className = 'task-info';
    const name = document.createElement('div');
    name.className = 'task-name';
    name.textContent = task.name;
    name.title = task.name;
    const sub = document.createElement('div');
    sub.className = 'task-sub';
    if (task.errorCode) {
      const err = document.createElement('span');
      const errorMessage = String(task.errorMessage || '').trim().replace(/\s+/g, ' ');
      const errorPreview = errorMessage.length > 120 ? `${errorMessage.slice(0, 120)}…` : errorMessage;
      err.textContent = errorPreview ? `#${task.errorCode} · ${errorPreview}` : `#${task.errorCode}`;
      if (errorMessage) err.title = errorMessage;
      err.style.color = 'var(--red)';
      sub.appendChild(err);
    } else if (task.total > 0 && ['complete', 'error'].includes(task.status)) {
      const size = document.createElement('span');
      size.textContent = fmtBytes(task.total);
      sub.appendChild(size);
    }
    if (task.status === 'complete' && task.completedTime) {
      const time = document.createElement('span');
      time.textContent = fmtTime(task.completedTime);
      sub.appendChild(time);
    }
    const badge = document.createElement('span');
    badge.className = `status-badge ${statusClass(task.status)}`;
    badge.textContent = statusLabel(task.status);

    const progress = document.createElement('div');
    progress.className = 'task-progress';
    const track = document.createElement('div');
    track.className = 'progress-track';
    const fill = document.createElement('div');
    fill.className = `progress-fill${task.status === 'complete' ? ' done' : ''}`;
    fill.style.width = `${task.pct}%`;
    track.appendChild(fill);
    const meta = document.createElement('div');
    meta.className = 'progress-meta';
    const left = document.createElement('span');
    left.textContent = `${task.pct}% · ${fmtBytes(task.completed)}/${fmtBytes(task.total)}`;
    const right = document.createElement('span');
    if (task.status === 'active') {
      right.className = 'eta';
      right.textContent = fmtEta(task.speed, task.total, task.completed);
    } else {
      right.textContent = task.status === 'complete' && task.total > 0 ? fmtBytes(task.total) : '';
    }
    meta.append(left, right);
    progress.append(track, meta);
    info.append(name, sub);

    const traffic = document.createElement('div');
    traffic.className = 'task-traffic';
    const down = document.createElement('span');
    down.className = 'traffic-down';
    down.textContent = `↓ ${task.speed > 0 ? fmtSpeed(task.speed) : '0 B/s'}`;
    const up = document.createElement('span');
    up.className = 'traffic-up';
    up.textContent = `↑ ${task.uploadSpeed > 0 ? fmtSpeed(task.uploadSpeed) : '0 B/s'}`;
    traffic.append(down, up);

    const actions = document.createElement('div');
    actions.className = 'task-actions';
    if (['active', 'waiting'].includes(task.status)) {
      actions.appendChild(iconBtn('pause', ICONS.pause, T.actionPause));
    }
    if (['paused', 'waiting'].includes(task.status)) {
      actions.appendChild(iconBtn('resume', ICONS.play, T.actionResume));
    }
    if (['active', 'waiting', 'paused'].includes(task.status)) {
      actions.appendChild(iconBtn('remove', ICONS.trash, T.actionRemove, 'danger'));
    }
    if (['complete', 'error', 'removed'].includes(task.status)) {
      actions.appendChild(iconBtn('redownload', ICONS.redownload, T.actionRedownload));
      actions.appendChild(iconBtn('removeResult', ICONS.trash, T.actionRemoveResult, 'danger'));
    }

    row.append(selectLabel, icon, info, progress, traffic, badge, actions);
    row.addEventListener('click', (event) => {
      if (event.target.closest?.('.icon-btn, .task-select')) return;
      selectTask(task.gid);
    });
    actions.querySelectorAll('.icon-btn').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        handleRowAction(task, btn.dataset.action);
      });
    });
    return row;
  }

  async function handleRowAction(task, action) {
    if (action === 'pause') return runAction('pause', [task.gid]);
    if (action === 'resume') return runAction('unpause', [task.gid]);
    if (action === 'remove') {
      if (!window.confirm(T.confirmRemove.replace('$1', task.name))) return;
      return runAction(task.status === 'paused' ? 'forceRemove' : 'remove', [task.gid]);
    }
    if (action === 'removeResult') {
      if (!window.confirm(T.confirmRemoveResult)) return;
      return runAction('removeDownloadResult', [task.gid]);
    }
    if (action === 'redownload') return redownloadTask(task);
  }

  async function redownloadTask(task) {
    if (!task.uri) {
      showToast(T.noUriForRedownload);
      return;
    }
    if (!window.confirm(T.confirmRedownload.replace('$1', task.name))) return;
    try {
      await rpc('addUri', [[task.uri], {}]);
      showToast(T.redownloadQueued);
      await loadSnapshot();
    } catch (error) {
      showToast(T.actionFailed.replace('$1', error?.message || String(error)));
    }
  }

  function renderStats() {
    const snapshot = state.snapshot;
    if (!snapshot) return;
    $('statSpeed').textContent = fmtSpeed(snapshot.totalSpeed);
    $('statUpSpeed').textContent = fmtSpeed(snapshot.totalUploadSpeed);
  }

  function renderCounts() {
    document.querySelectorAll('.filter-btn').forEach((btn) => {
      let countEl = btn.querySelector('.count');
      if (!countEl) {
        countEl = document.createElement('span');
        countEl.className = 'count';
        countEl.setAttribute('aria-hidden', 'true');
        btn.appendChild(countEl);
      }
      const filter = btn.dataset.filter;
      let count = 0;
      if (filter === 'all') count = state.tasks.length;
      else if (filter === 'active') count = state.snapshot?.activeTasks.length || 0;
      else if (filter === 'waiting') count = state.snapshot?.waitingTasks.length || 0;
      else if (filter === 'paused') count = state.snapshot?.pausedTasks.length || 0;
      else if (filter === 'stopped') count = state.snapshot?.stoppedTasks.length || 0;
      countEl.textContent = String(count);
    });
  }

  function renderList() {
    const list = $('taskList');
    const items = visibleTasks();
    list.replaceChildren();

    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      const img = document.createElement('img');
      img.src = 'assets/empty-downloads.png';
      img.alt = '';
      const title = document.createElement('div');
      title.textContent = T.emptyTitle;
      const sub = document.createElement('div');
      sub.className = 'muted';
      sub.textContent = T.emptySub;
      empty.append(img, title, sub);
      list.appendChild(empty);
    } else {
      items.forEach((task) => list.appendChild(createTaskRow(task)));
    }

    updateBulkControls();
  }

  function detailRow(dt, dd) {
    const fragment = document.createDocumentFragment();
    const dtEl = document.createElement('dt');
    dtEl.textContent = dt;
    const ddEl = document.createElement('dd');
    if (typeof dd === 'string') ddEl.textContent = dd;
    else if (dd) ddEl.appendChild(dd);
    fragment.append(dtEl, ddEl);
    return fragment;
  }

  async function copyText(value, successMessage) {
    if (!navigator.clipboard?.writeText) {
      showToast(T.copyFailed);
      return;
    }
    try {
      await navigator.clipboard.writeText(String(value));
      showToast(successMessage);
    } catch (_) {
      showToast(T.copyFailed);
    }
  }

  function createProgressRing(label, percent, detail, color, available = true) {
    const card = document.createElement('div');
    card.className = 'detail-progress-card';

    const ring = document.createElement('div');
    ring.className = `detail-progress-ring${available ? '' : ' unavailable'}`;
    ring.style.setProperty('--ring-color', color);
    ring.style.setProperty('--ring-progress', available ? String(Math.max(0, Math.min(100, percent))) : '0');
    ring.setAttribute('role', 'img');
    ring.setAttribute('aria-label', `${label}: ${available ? `${Math.round(percent)}%` : '—'}`);

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 40 40');
    svg.setAttribute('aria-hidden', 'true');
    const track = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    track.classList.add('ring-track');
    track.setAttribute('cx', '20');
    track.setAttribute('cy', '20');
    track.setAttribute('r', '16');
    track.setAttribute('pathLength', '100');
    const value = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    value.classList.add('ring-value');
    value.setAttribute('cx', '20');
    value.setAttribute('cy', '20');
    value.setAttribute('r', '16');
    value.setAttribute('pathLength', '100');
    svg.append(track, value);

    const center = document.createElement('span');
    center.className = 'ring-center';
    center.textContent = available ? `${Math.round(percent)}%` : '—';
    ring.append(svg, center);

    const copy = document.createElement('div');
    copy.className = 'detail-progress-copy';
    const labelEl = document.createElement('div');
    labelEl.className = 'detail-progress-label';
    labelEl.textContent = label;
    const detailEl = document.createElement('div');
    detailEl.className = 'detail-progress-detail';
    detailEl.textContent = detail;
    copy.append(labelEl, detailEl);
    card.append(ring, copy);
    return card;
  }

  function createCopyButton(value, successMessage, label = T.copyLink) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'icon-btn copy-link';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M5.5 4.25A1.75 1.75 0 0 1 7.25 2.5h4A1.75 1.75 0 0 1 13 4.25v4A1.75 1.75 0 0 1 11.25 10H10V8.5h1.25a.25.25 0 0 0 .25-.25v-4a.25.25 0 0 0-.25-.25h-4a.25.25 0 0 0-.25.25V5.5H5.5v-1.25ZM4.75 6.5h4A1.75 1.75 0 0 1 10.5 8.25v4A1.75 1.75 0 0 1 8.75 14h-4A1.75 1.75 0 0 1 3 12.25v-4A1.75 1.75 0 0 1 4.75 6.5Zm0 1.5a.25.25 0 0 0-.25.25v4a.25.25 0 0 0 .25.25h4a.25.25 0 0 0 .25-.25v-4a.25.25 0 0 0-.25-.25h-4Z"/></svg>';
    button.addEventListener('click', () => copyText(value, successMessage));
    return button;
  }

  function renderDetail() {
    const panel = $('detailPanel');
    const workspace = $('taskWorkspace');
    const body = $('detailBody');
    const actions = $('detailActions');
    body.replaceChildren();
    actions.replaceChildren();

    const task = state.tasks.find((t) => t.gid === state.detailGid);
    if (!task) {
      $('detailTitle').textContent = T.selectTaskHint;
      panel.classList.remove('open');
      // Move focus out before hiding: aria-hidden on an ancestor of the
      // focused element breaks the accessibility tree and is blocked by the
      // browser ("Blocked aria-hidden on an element because its descendant
      // retained focus"). The panel stays visible during its close transition,
      // so the close button can still hold focus here; send it somewhere safe.
      if (panel.contains(document.activeElement)) {
        $('searchInput')?.focus();
      }
      panel.setAttribute('aria-hidden', 'true');
      panel.inert = true; // belt-and-suspenders: also prevents focus from entering the hidden panel
      workspace.classList.remove('has-detail');
      return;
    }

    workspace.classList.add('has-detail');
    panel.classList.add('open');
    panel.setAttribute('aria-hidden', 'false');
    panel.inert = false;
    $('detailTitle').textContent = task.name;

    const section = (label) => {
      const title = document.createElement('div');
      title.className = 'detail-section-title';
      title.textContent = label;
      return title;
    };

    const kv = document.createElement('dl');
    kv.className = 'kv';

    const gidLink = document.createElement('span');
    gidLink.className = 'gid';
    gidLink.textContent = task.gid;
    gidLink.addEventListener('click', () => {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(task.gid).then(
          () => showToast(T.copiedGid),
          () => showToast(T.copyFailed)
        );
      } else {
        showToast(T.copyFailed);
      }
    });
    gidLink.title = T.copyGid;

    const progressGrid = document.createElement('div');
    progressGrid.className = 'detail-progress-grid';
    progressGrid.append(
      createProgressRing(
        T.downloadProgressLabel,
        task.pct,
        task.downloadProgressAvailable ? `${fmtBytes(task.completed)} / ${fmtBytes(task.total)}` : T.unknownSize,
        'var(--accent)',
        task.downloadProgressAvailable,
      ),
    );
    body.appendChild(progressGrid);

    kv.append(
      detailRow(T.gidLabel, gidLink),
      detailRow(T.stateLabel, statusLabel(task.status)),
      detailRow(T.progressLabel, `${task.pct}%`),
      detailRow(T.sizeLabel, `${fmtBytes(task.completed)} / ${fmtBytes(task.total)}`)
    );
    if (task.status === 'active') {
      kv.append(
        detailRow(T.speedLabel, `${fmtSpeed(task.speed)}${task.uploadSpeed > 0 ? ` / ↑ ${fmtSpeed(task.uploadSpeed)}` : ''}`),
        detailRow(T.etaLabel, fmtEta(task.speed, task.total, task.completed)),
        detailRow(T.connectionsLabel, `${task.connections}`)
      );
    }
    if (task.status === 'waiting') kv.append(detailRow(T.connectionsLabel, T.waitingDetail));
    if (task.status === 'paused') kv.append(detailRow(T.connectionsLabel, T.pausedDetail));
    if (task.isTorrent && task.infoHash) {
      kv.append(detailRow(T.infoHashLabel, task.infoHash));
      if (task.numSeeders) kv.append(detailRow(T.seedersLabel, `${task.numSeeders}`));
    }
    if (task.dir) kv.append(detailRow(T.downloadDirLabel, task.dir));
    if (task.addedTime) kv.append(detailRow(T.addedTimeLabel, fmtTime(task.addedTime)));
    if (task.completedTime) kv.append(detailRow(T.completedTimeLabel, fmtTime(task.completedTime)));
    if (task.errorCode) {
      kv.append(
        detailRow(T.errorLabel, `#${task.errorCode}${task.errorMessage ? ` · ${task.errorMessage}` : ''}`)
      );
    }

    body.appendChild(section(T.metaLabel));
    body.appendChild(kv);

    const files = Array.isArray(task.raw?.files) ? task.raw.files : [];
    const visibleFiles = files.slice(0, DETAIL_FILE_LIMIT);
    body.appendChild(section(T.filesLabel));
    if (visibleFiles.length) {
      const filesBox = document.createElement('div');
      filesBox.style.display = 'flex';
      filesBox.style.flexDirection = 'column';
      filesBox.style.gap = '8px';
      visibleFiles.forEach((file) => {
        const item = document.createElement('div');
        item.className = 'file-item';
        const path = document.createElement('div');
        path.className = 'path';
        path.textContent = file.path || T.unknownFile;
        const meta = document.createElement('div');
        meta.className = 'file-meta';
        const size = document.createElement('span');
        size.textContent = `${fmtBytes(file.completedLength)} / ${fmtBytes(file.length)}`;
        meta.appendChild(size);
        if (Number(file.length) > 0 && Number(file.completedLength) >= 0) {
          const pct = document.createElement('span');
          pct.textContent = `${Math.min(100, Math.round((Number(file.completedLength) / Number(file.length)) * 100))}%`;
          meta.appendChild(pct);
        }
        item.appendChild(path);
        item.appendChild(meta);
        filesBox.appendChild(item);
      });
      body.appendChild(filesBox);
      if (files.length > visibleFiles.length) {
        const more = document.createElement('div');
        more.className = 'muted';
        more.textContent = T.filesMore
          .replace('$1', String(visibleFiles.length))
          .replace('$2', String(files.length));
        body.appendChild(more);
      }
    } else {
      const empty = document.createElement('div');
      empty.className = 'muted';
      empty.textContent = T.noFiles;
      body.appendChild(empty);
    }

    const uriEntries = taskUriEntries(task);
    const linksHeading = document.createElement('div');
    linksHeading.className = 'detail-section-heading';
    const linksTitle = section(T.linksLabel);
    linksHeading.appendChild(linksTitle);
    if (uriEntries.length > 1) {
      linksHeading.appendChild(createCopyButton(
        uriEntries.map((entry) => entry.uri).join('\n'),
        T.copiedLinks,
        T.copyLinks,
      ));
    }
    body.appendChild(linksHeading);
    if (uriEntries.length) {
      const linksBox = document.createElement('div');
      linksBox.className = 'uri-list';
      uriEntries.slice(0, DETAIL_URI_LIMIT).forEach((entry) => {
        const row = document.createElement('div');
        row.className = 'uri-row';
        const link = document.createElement('a');
        link.className = 'uri-link';
        const label = uriDisplayLabel(entry.uri);
        link.textContent = label;
        link.href = entry.uri;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.title = entry.filePath ? `${entry.filePath}\n${label}` : label;
        link.setAttribute('aria-label', label);
        row.append(link, createCopyButton(entry.uri, T.copiedLink));
        linksBox.appendChild(row);
      });
      if (uriEntries.length > DETAIL_URI_LIMIT) {
        const more = document.createElement('div');
        more.className = 'muted';
        more.textContent = T.moreLinks.replace('$1', String(uriEntries.length - DETAIL_URI_LIMIT));
        linksBox.appendChild(more);
      }
      body.appendChild(linksBox);
    } else {
      const emptyLinks = document.createElement('div');
      emptyLinks.className = 'muted';
      emptyLinks.textContent = T.noLinks;
      body.appendChild(emptyLinks);
    }

    const makeBtn = (label, className, onClick) => {
      const btn = document.createElement('button');
      btn.className = `btn${className ? ` ${className}` : ''}`;
      btn.textContent = label;
      btn.addEventListener('click', onClick);
      actions.appendChild(btn);
      return btn;
    };

    if (task.status === 'active' || task.status === 'waiting') {
      makeBtn(T.actionPause, '', () => runAction('pause', [task.gid]));
    }
    if (task.status === 'paused' || task.status === 'waiting') {
      makeBtn(T.actionResume, '', () => runAction('unpause', [task.gid]));
    }
    if (['complete', 'error', 'removed'].includes(task.status)) {
      makeBtn(T.actionRedownload, 'primary', () => redownloadTask(task));
    }
    if (['active', 'waiting', 'paused'].includes(task.status)) {
      makeBtn(T.actionRemove, 'danger', () => {
        if (!window.confirm(T.confirmRemove.replace('$1', task.name))) return;
        runAction(task.status === 'paused' ? 'forceRemove' : 'remove', [task.gid]);
      });
    }
    if (['complete', 'error', 'removed'].includes(task.status)) {
      makeBtn(T.actionRemoveResult, 'danger', () => {
        if (!window.confirm(T.confirmRemoveResult)) return;
        runAction('removeDownloadResult', [task.gid]);
      });
    }
  }

  async function runAction(method, params) {
    try {
      await rpc(method, params);
      showToast(T.actionDone);
      await loadSnapshot();
    } catch (error) {
      showToast(T.actionFailed.replace('$1', error?.message || String(error)));
    }
  }

  async function runSelectedAction(action) {
    const selected = selectedTasks();
    if (!selected.length) {
      return runAction(action === 'pause' ? 'pauseAll' : 'unpauseAll', []);
    }
    const eligible = selected.filter((task) => {
      if (action === 'pause') return ['active', 'waiting'].includes(task.status);
      return ['paused', 'waiting'].includes(task.status);
    });
    if (!eligible.length) {
      showToast(T.noEligibleSelected);
      return;
    }
    const method = action === 'pause' ? 'pause' : 'unpause';
    const results = await Promise.allSettled(eligible.map((task) => rpc(method, [task.gid])));
    const failed = results.filter((result) => result.status === 'rejected').length;
    state.selectedGids.clear();
    updateBulkControls();
    if (failed) {
      showToast(T.actionFailed.replace('$1', `${failed}/${eligible.length}`));
    } else {
      showToast(T.bulkDone.replace('$1', String(eligible.length)));
    }
    await loadSnapshot();
  }

  function setStatus(ok) {
    const dot = $('statusDot');
    dot.className = 'status-dot';
    if (ok) {
      dot.classList.add('ok');
      $('statusText').textContent = `${T.statusOk} · ${fmtSpeed(state.snapshot?.totalSpeed || 0)}`;
    } else {
      dot.classList.add('bad');
      $('statusText').textContent = T.statusOffline;
    }
    renderStats();
  }

  function showAlert(message) {
    const alert = $('alert');
    alert.textContent = message;
    alert.classList.add('show');
  }

  function hideAlert() {
    $('alert').classList.remove('show');
  }

  let toastTimer = null;
  function showToast(message) {
    const toast = $('toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.classList.remove('show'); }, 2200);
  }

  function selectTask(gid) {
    // Detail selection is independent from the batch-selection set.
    // Clicking a row opens details; only its checkbox changes selectedGids.
    if (!gid || state.detailGid === gid) return;
    state.detailGid = gid;
    syncDetailRowSelection();
    renderDetail();
    const panel = $('detailPanel');
    if (window.matchMedia('(max-width: 860px)').matches && panel.classList.contains('open')) {
      panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function render() {
    renderStats();
    renderCounts();
    renderList();
    renderDetail();
    hideAlert();
  }

  function bindEvents() {
    $('sidebarToggleBtn').addEventListener('click', () => {
      setSidebarCollapsed(!document.body.classList.contains('sidebar-collapsed'));
    });
    document.querySelectorAll('.filter-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        setWorkspaceView('tasks');
        state.filter = btn.dataset.filter;
        syncFilterSelection(false);
        renderList();
      });
    });
    $('searchInput').addEventListener('input', (event) => {
      state.search = event.target.value;
      renderList();
    });
    $('refreshBtn').addEventListener('click', async () => {
      const original = $('refreshBtn').textContent;
      $('refreshBtn').disabled = true;
      $('refreshBtn').textContent = T.refreshing;
      await loadSnapshot();
      $('refreshBtn').disabled = false;
      $('refreshBtn').textContent = original;
    });
    $('purgeBtn').addEventListener('click', () => {
      if (!window.confirm(T.confirmPurge)) return;
      runAction('purgeDownloadResult', []);
    });
    $('pauseAllBtn').addEventListener('click', () => runSelectedAction('pause'));
    $('resumeAllBtn').addEventListener('click', () => runSelectedAction('resume'));
    $('globalSettingsBtn').addEventListener('click', () => openSettingsSection('global'));
    $('rpcConnectionLink').addEventListener('click', () => openSettingsSection('rpc'));
    $('createTaskBtn').addEventListener('click', () => {
      const frame = $('createTaskFrame');
      if (frame) frame.src = `aria2-create-task.html?embedded=1&t=${Date.now()}`;
      setWorkspaceView('createTask');
    });
    $('detailCloseBtn').addEventListener('click', () => {
      state.detailGid = '';
      syncDetailRowSelection();
      renderDetail();
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) loadSnapshot();
    });
  }

  function openSettingsSection(section) {
    setWorkspaceView('settings', section);
    const frame = $('settingsFrame');
    if (!frame) return;
    const target = 'aria2-settings.html?embedded=1';
    const applySection = () => {
      frame.contentWindow?.postMessage({ type: 'ARIA2_SET_SECTION', section }, location.origin);
      if (section === 'rpc') frame.contentWindow?.postMessage({ type: 'ARIA2_FOCUS_RPC' }, location.origin);
    };
    frame.title = section === 'rpc' ? 'Aria2 RPC 连接设置' : 'Aria2 全局设置';
    if (frame.getAttribute('src') === target) {
      if (frame.contentDocument?.readyState === 'complete') {
        applySection();
        window.setTimeout(applySection, 0);
      } else {
        frame.addEventListener('load', applySection, { once: true });
      }
      return;
    }
    frame.addEventListener('load', applySection, { once: true });
    frame.src = target;
  }

  function setWorkspaceView(view, settingsSection = 'global') {
    const showSettings = view === 'settings';
    const showCreateTask = view === 'createTask';
    const globalSettingsActive = showSettings && settingsSection === 'global';
    const rpcConnectionActive = showSettings && settingsSection === 'rpc';
    document.body.classList.toggle('settings-mode', showSettings);
    document.body.classList.toggle('create-task-mode', showCreateTask);
    $('globalSettingsBtn').classList.toggle('active', globalSettingsActive);
    $('rpcConnectionLink').classList.toggle('active', rpcConnectionActive);
    if (globalSettingsActive) $('globalSettingsBtn').setAttribute('aria-current', 'page');
    else $('globalSettingsBtn').removeAttribute('aria-current');
    if (rpcConnectionActive) $('rpcConnectionLink').setAttribute('aria-current', 'page');
    else $('rpcConnectionLink').removeAttribute('aria-current');
    $('settingsView').setAttribute('aria-hidden', String(!showSettings));
    $('createTaskView').setAttribute('aria-hidden', String(!showCreateTask));
    syncFilterSelection(showSettings || showCreateTask);
  }

  function syncFilterSelection(showSettings) {
    document.querySelectorAll('.filter-btn').forEach((btn) => {
      const active = !showSettings && btn.dataset.filter === state.filter;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    });
  }

  window.addEventListener('message', (event) => {
    if (event.origin !== location.origin || event.data?.type !== 'ARIA2_SHOW_TASKS') return;
    setWorkspaceView('tasks');
    loadSnapshot();
  });

  async function init() {
    l10n();
    bindEvents();
    setWorkspaceView('tasks');
    state.config = await getConfig();
    setRpcEndpoint(state.config.aria2Rpc);
    await loadSnapshot();
    setInterval(loadSnapshot, REFRESH_INTERVAL_MS);
  }

  function setSidebarCollapsed(collapsed) {
    const sidebarToggle = $('sidebarToggleBtn');
    document.body.classList.toggle('sidebar-collapsed', collapsed);
    sidebarToggle?.setAttribute('aria-expanded', String(!collapsed));
    if (sidebarToggle) {
      sidebarToggle.title = collapsed ? '展开侧边栏' : '收起侧边栏';
      const label = sidebarToggle.querySelector('span');
      if (label) label.textContent = collapsed ? '展开侧边栏' : '收起侧边栏';
    }
    try { window.localStorage.setItem('aria2SidebarCollapsed', String(collapsed)); } catch (_) { /* storage unavailable */ }
  }

  try {
    setSidebarCollapsed(window.localStorage.getItem('aria2SidebarCollapsed') === 'true');
  } catch (_) {
    setSidebarCollapsed(false);
  }
  globalThis.__aria2TasksTestHooks = { getState: () => state, taskUriEntries, T };

  init().catch((error) => {
    setStatus(false);
    showAlert(T.loadFailed.replace('$1', error?.message || String(error)));
  });
})();
