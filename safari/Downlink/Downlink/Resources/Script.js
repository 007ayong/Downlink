const send = (command) => webkit.messageHandlers.controller.postMessage(command);
function show(enabled, stale) {
    const status = document.querySelector('#extension-status');
    status.textContent = typeof enabled === 'boolean' ? (enabled ? '已启用' : '未启用') : '无法确认';
    if (stale && typeof enabled === 'boolean') status.textContent += '（上次确认）';
    status.dataset.state = enabled === true && !stale ? 'ok' : 'warning';
}
function showLoginItem(state) {
    document.querySelector('.login-item-state').textContent = state.error ? '无法更改登录时启动：' + state.error : state.message;
    const checkbox = document.querySelector('#launch-at-login');
    checkbox.checked = state.action === 'unregister';
    checkbox.indeterminate = state.settings === 'true';
    checkbox.disabled = !['register', 'unregister'].includes(state.action);
    document.querySelector('#login-settings').hidden = state.settings !== 'true' && state.action !== 'settings';
}
function showService(state) {
    const status = document.querySelector('#service-status');
    status.textContent = state.running ? '运行中' : (state.error ? '启动失败' : '已停止');
    status.dataset.state = state.running ? 'ok' : 'warning';
    document.querySelector('#service-description').textContent = state.running
        ? '本地桥接已就绪。关闭此窗口后，服务仍会在后台运行。'
        : 'Safari 下载接管可能不可用。启动服务后，可在插件中重新检测连接。';
    const error = document.querySelector('#service-error');
    error.hidden = !state.error;
    error.textContent = state.error;
    const button = document.querySelector('#toggle-service');
    button.disabled = false;
    button.textContent = state.running ? '停止服务' : '启动服务';
    button.dataset.running = String(state.running);
}
document.querySelector('.open-preferences').addEventListener('click', () => send('open-preferences'));
document.querySelector('#launch-at-login').addEventListener('change', ({ currentTarget }) => {
    currentTarget.disabled = true;
    send(currentTarget.checked ? 'login-enable' : 'login-disable');
});
document.querySelector('#toggle-service').addEventListener('click', () => send('toggle-service'));
document.querySelector('#refresh').addEventListener('click', () => send('refresh'));

document.querySelector('#login-settings').addEventListener('click', () => send('login-settings'));

document.querySelector('#quit-downlink').addEventListener('click', () => send('quit-downlink'));
