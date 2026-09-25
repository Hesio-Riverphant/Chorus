'use strict';

// CLI definitions remain a settings draft until the host saves them through IPC.
window.CliSettingsUI = (() => {
  const byId = id => document.getElementById(id);
  const copy = profiles => (Array.isArray(profiles) ? profiles : []).map(profile => ({
    id: profile.id, label: profile.label, command: profile.command,
    args: Array.isArray(profile.args) ? [...profile.args] : [],
    promptMode: profile.promptMode || 'stdin', outputMode: profile.outputMode || 'text',
    ...(Array.isArray(profile.historyArgs) && profile.historyArgs.length ? { historyArgs: [...profile.historyArgs] } : {}),
  }));
  const fieldIds = ['cliProfileLabel', 'cliProfileCommand', 'cliProfileArgs', 'cliProfilePromptMode', 'cliProfileOutputMode', 'cliProfileHistoryArgs'];
  let draft = [];
  let saved = [];
  let registry = [];
  let enabled = new Set();
  let savedEnabled = new Set();
  let generation = 0;
  let scanning = false;
  let testing = new Set();
  let testResults = new Map();
  let editing = null;
  let editorDirty = false;
  let wired = false;
  let pickCommand = null;
  function error(message, field) {
    const target = byId('cliProfileError');
    target.textContent = message;
    target.hidden = !message;
    if (field) { byId(field).setAttribute('aria-invalid', 'true'); byId(field).focus(); }
  }
  function closeEditor() {
    editing = null;
    editorDirty = false;
    byId('cliProfileEditor').hidden = true;
    error('');
  }
  function lines(id) {
    // Spaces within each argument are literal. Empty lines do not create arguments.
    return byId(id).value.replace(/\r\n?/g, '\n').split('\n').filter(line => line.trim() !== '');
  }
  function readEditor() {
    for (const id of fieldIds) byId(id).removeAttribute('aria-invalid');
    const label = byId('cliProfileLabel').value.trim();
    const command = byId('cliProfileCommand').value.trim();
    const args = lines('cliProfileArgs');
    const promptMode = byId('cliProfilePromptMode').value;
    const outputMode = byId('cliProfileOutputMode').value;
    const historyArgs = lines('cliProfileHistoryArgs');
    if (!label) { error(I18n.t('请填写 CLI 名称。'), 'cliProfileLabel'); return null; }
    if (!/^(?:[a-z]:[\\/].+\.(?:exe|cmd)|\/(?!\/).+)$/i.test(command) || /[\r\n\0"]/.test(command)) {
      error(I18n.t('请填写程序完整路径；Windows 使用 .exe 或标准 npm .cmd，Linux 使用可执行文件。'), 'cliProfileCommand'); return null;
    }
    if (!['stdin', 'arg'].includes(promptMode) || !['text', 'jsonl'].includes(outputMode)) {
      error(I18n.t('请选择有效的输入与输出方式。')); return null;
    }
    if (promptMode === 'arg' && !args.includes('{prompt}')) {
      error(I18n.t('使用命令行参数传入消息时，需要单独一行填写 {prompt}。'), 'cliProfileArgs'); return null;
    }
    if ([...args, ...historyArgs].some(arg => arg.includes('\0'))) {
      error(I18n.t('参数中含有无效字符。'), 'cliProfileArgs'); return null;
    }
    error('');
    return { id: editing, label, command, args, promptMode, outputMode, ...(historyArgs.length ? { historyArgs } : {}) };
  }
  function applyEditor() {
    if (!editing) return true;
    const profile = readEditor();
    if (!profile) return false;
    const index = draft.findIndex(item => item.id === profile.id);
    if (index < 0) draft.push(profile);
    else draft[index] = profile;
    closeEditor();
    render();
    return true;
  }
  function makeButton(text, action, id) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'ghost-btn'; I18n.label(button, text);
    button.dataset.cliAction = action; button.dataset.cliId = id;
    return button;
  }
  function render() {
    const list = byId('cliProfileList');
    list.replaceChildren();
    const toolbar = document.createElement('div'); toolbar.className = 'cli-scan-toolbar';
    const scan = makeButton(I18n.live(() => scanning ? I18n.t('扫描中…') : I18n.t('重新扫描')), 'scan', ''); scan.disabled = scanning;
    const scanHint = document.createElement('span'); scanHint.className = 'hint'; I18n.write(scanHint, () => I18n.t('勾选要使用的 Agent。测试连接会发送一条简短请求。'));
    toolbar.append(scanHint, scan); list.append(toolbar);
    const profiles = [...registry.filter(profile => profile.builtin), ...draft.map(profile => ({ ...registry.find(item => item.id === profile.id), ...profile, builtin: false, historyModeSupport: 'unknown' }))];
    for (const profile of profiles) {
      const row = document.createElement('div'); row.className = 'cli-profile-row';
      const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.checked = enabled.has(profile.id);
      toggle.dataset.cliEnable = profile.id; I18n.attr(toggle, 'aria-label', () => I18n.tpl`启用 ${profile.label}`);
      const detail = document.createElement('div'); detail.className = 'cli-profile-detail';
      const title = document.createElement('strong'); title.textContent = profile.label;
      const status = document.createElement('span'); status.className = 'hint';
      I18n.write(status, () => profile.installed === true ? I18n.t('已在本机找到') : profile.installed === false ? I18n.t('未在常用目录找到') : I18n.t('等待扫描'));
      detail.append(title, status);
      const children = document.createElement('span'); children.className = 'hint';
      I18n.write(children, () => {
        const support = profile.builtin ? profile.subagentSupport : profile.outputMode === 'jsonl' ? 'protocol' : 'unavailable';
        return support === 'events' ? I18n.t('子代理：显示原生返回的事件与输出。')
          : support === 'summary' ? I18n.t('子代理：仅显示原生工具返回摘要。')
          : support === 'protocol' ? I18n.t('子代理：程序需提供 Chorus JSONL 子代理事件。')
          : I18n.t('子代理：当前接入未提供可识别事件。');
      }); detail.append(children);
      if (profile.historyModeSupport !== 'verified') {
        const history = document.createElement('span'); history.className = 'hint';
        I18n.write(history, () => I18n.t('会话记录按此 Agent 的原生设置保存。')); detail.append(history);
      }
      if (!profile.builtin || profile.id === 'kimi') {
        const permission = document.createElement('span'); permission.className = 'hint';
        I18n.write(permission, () => profile.id === 'kimi' ? I18n.t('聊天需明确选择全权限；连接测试直接请求提供商，不启动工具。') : I18n.t('聊天与连接测试使用此 CLI 的原生工具权限。')); detail.append(permission);
      }
      if (profile.executablePath || profile.command) {
        const path = document.createElement('span'); path.className = 'cli-profile-path'; path.textContent = profile.executablePath || profile.command;
        path.title = path.textContent;
        detail.append(path);
      }
      const result = testResults.get(profile.id);
      if (result) { const text = document.createElement('span'); text.className = 'cli-test-result hint'; text.setAttribute('role', 'status'); text.textContent = result; detail.append(text); }
      row.append(toggle, detail);
      const actions = document.createElement('div'); actions.className = 'cli-profile-actions';
      const test = makeButton(I18n.live(() => testing.has(profile.id) ? I18n.t('测试中…') : I18n.t('测试连接')), 'test', profile.id);
      test.disabled = testing.has(profile.id) || testing.size >= 3; actions.append(test);
      if (!profile.builtin) {
        actions.append(makeButton(I18n.live(() => I18n.t('编辑')), 'edit', profile.id), makeButton(I18n.live(() => I18n.t('移除')), 'remove', profile.id));
      }
      row.append(actions);
      list.append(row);
    }
    if (!profiles.length) {
      const empty = document.createElement('p'); empty.className = 'hint'; I18n.write(empty, () => I18n.t('尚未配置 CLI 接入。')); list.append(empty);
    }
  }
  async function scan() {
    if (scanning || typeof window.api.discoverClis !== 'function') return;
    const opened = generation;
    scanning = true; render();
    try {
      const found = await window.api.discoverClis();
      if (opened !== generation) return;
      registry = found;
    } catch (_) { if (opened === generation) error(I18n.t('扫描暂未完成，请重试。')); }
    finally { if (opened === generation) { scanning = false; render(); } }
  }
  async function testConnection(id) {
    if (testing.has(id) || testing.size >= 3) return;
    const profile = registry.find(profile => profile.id === id);
    if (!profile || (!profile.builtin && JSON.stringify(saved.find(item => item.id === id)) !== JSON.stringify(draft.find(item => item.id === id)))) {
      testResults.set(id, I18n.t('请先保存此接入配置，再测试连接。')); render(); return;
    }
    const opened = generation;
    testing.add(id); testResults.set(id, I18n.t('正在测试默认模型…')); render();
    try {
      const result = await window.api.testBotConnection({ cliType: id, model: '', confirmed: true });
      if (opened === generation) testResults.set(id, I18n.tpl`${result.ok ? result.transport === 'provider-api' ? I18n.t('模型连接成功') : I18n.t('连接成功') : I18n.t('连接失败：') + result.detail} · ${(result.elapsedMs / 1000).toFixed(1)} 秒`);
    } catch (failure) { if (opened === generation) testResults.set(id, (failure?.message || I18n.t('连接测试失败，请检查该 Agent 是否可以在终端使用。')).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')); }
    finally { if (opened === generation) { testing.delete(id); render(); } }
  }
  function edit(profile) {
    // Preserve in-progress edits when navigating to another definition.
    if (editing && editorDirty && !applyEditor()) return;
    if (profile) profile = draft.find(item => item.id === profile.id) || profile;
    editing = profile?.id || 'custom_' + crypto.randomUUID().replace(/-/g, '');
    editorDirty = false;
    byId('cliProfileEditor').hidden = false;
    I18n.write(byId('cliProfileEditorTitle'), () => profile ? I18n.t('编辑 CLI 接入') : I18n.t('新增 CLI 接入'));
    byId('cliProfileLabel').value = profile?.label || '';
    byId('cliProfileCommand').value = profile?.command || '';
    byId('cliProfileArgs').value = (profile?.args || []).join('\n');
    byId('cliProfilePromptMode').value = profile?.promptMode || 'stdin';
    byId('cliProfileOutputMode').value = profile?.outputMode || 'text';
    byId('cliProfileHistoryArgs').value = (profile?.historyArgs || []).join('\n');
    for (const id of fieldIds) byId(id).removeAttribute('aria-invalid');
    byId('cliProfileAdvanced').open = !!profile?.historyArgs?.length || profile?.outputMode === 'jsonl';
    updateHints(); error(''); byId('cliProfileLabel').focus();
  }
  function updateHints() {
    byId('cliProfileJsonlHelp').hidden = byId('cliProfileOutputMode').value !== 'jsonl';
    I18n.write(byId('cliProfilePromptHelp'), () => byId('cliProfilePromptMode').value === 'arg' ?
      I18n.t('消息会替换参数列表中独立一行的 {prompt}；不使用 shell 拼接。') : I18n.t('消息写入 CLI 的标准输入，参数中通常不需要 {prompt}。'));
  }
  function open(profiles, registryProfiles = []) {
    for (const id of testing) window.api.cancelBotConnectionTest({ cliType: id, model: '' }).catch(() => {});
    generation += 1; scanning = false; testing = new Set(); testResults = new Map();
    saved = copy(profiles); draft = copy(saved);
    registry = Array.isArray(registryProfiles) ? registryProfiles.map(profile => ({ ...profile })) : [];
    enabled = new Set(registry.filter(profile => profile.enabled === true).map(profile => profile.id));
    savedEnabled = new Set(enabled);
    closeEditor(); render();
    scan();
  }
  function read() {
    if (editing && (editorDirty || !draft.some(profile => profile.id === editing)) && !applyEditor()) return null;
    return copy(draft);
  }
  function cancel() {
    for (const id of testing) window.api.cancelBotConnectionTest({ cliType: id, model: '' }).catch(() => {});
    generation += 1; scanning = false; testing = new Set();
    draft = copy(saved); enabled = new Set(savedEnabled); closeEditor(); render();
  }
  function commit(profiles, registryProfiles = registry) { open(profiles, registryProfiles); }
  function wire(options = {}) {
    if (typeof options.pickCommand === 'function') pickCommand = options.pickCommand;
    byId('cliProfileBrowse').hidden = !pickCommand;
    if (wired) return;
    wired = true;
    byId('cliProfileAdd').addEventListener('click', () => edit(null));
    byId('cliProfileApply').addEventListener('click', applyEditor);
    byId('cliProfileCancel').addEventListener('click', closeEditor);
    byId('cliProfileList').addEventListener('click', event => {
      const button = event.target.closest('button[data-cli-action]');
      if (!button) return;
      if (button.dataset.cliAction === 'scan') { scan(); return; }
      if (button.dataset.cliAction === 'test') { testConnection(button.dataset.cliId); return; }
      const profile = draft.find(item => item.id === button.dataset.cliId);
      if (!profile) return;
      if (button.dataset.cliAction === 'edit') edit(profile);
      if (button.dataset.cliAction === 'remove') {
        if (editing === profile.id) closeEditor();
        enabled.delete(profile.id);
        draft = draft.filter(item => item.id !== profile.id); render();
      }
    });
    byId('cliProfileList').addEventListener('change', event => {
      const id = event.target.dataset.cliEnable;
      if (id) { if (event.target.checked) enabled.add(id); else enabled.delete(id); }
    });
    for (const id of fieldIds) {
      byId(id).addEventListener('input', () => { editorDirty = true; });
      byId(id).addEventListener('change', () => { editorDirty = true; updateHints(); });
    }
    byId('cliProfileBrowse').addEventListener('click', async () => {
      if (!pickCommand) return;
      const editorId = editing;
      try {
        const path = await pickCommand(byId('cliProfileCommand').value);
        if (path && editing === editorId) { byId('cliProfileCommand').value = path; editorDirty = true; error(''); }
      } catch (failure) { if (editing === editorId) error(failure?.message || I18n.t('无法选择 CLI 程序，请重试。')); }
    });
  }
  return { wire, open, read, enabledIds: () => [...enabled], cancel, commit };
})();
