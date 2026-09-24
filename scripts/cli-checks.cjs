'use strict';

// Real Electron UI, IPC and fixture persistence with a synthetic CLI boundary.
module.exports = async function cliChecks({ win, persistence, check }) {
  const fs = require('node:fs');
  const path = require('node:path');
  const adapter = require('../src/main/adapters/cliAdapter');
  const originalRunBot = adapter.runBot;
  let attemptedCalls = 0;
  adapter.runBot = () => {
    attemptedCalls++;
    return { promise: Promise.resolve({ text: 'OK', error: null, usage: { inputTokens: 1, outputTokens: 1, tokens: 2 } }),
      onEvent() {}, cancel() { return Promise.resolve(); } };
  };
  const page = (fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`).catch(error => { throw new Error(error.message + "\nUI check: " + fn.toString().slice(0,1600)); });
  const waitFor = async (fn, ...args) => {
    for (let attempt = 0; attempt < 60; attempt++) {
      if (await page(fn, ...args)) return true;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return false;
  };
  const settingsFile = path.join(persistence.getDataPath(), 'settings.json');
  const diskSettings = () => JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  const originalProfiles = JSON.parse(JSON.stringify(persistence.getSettings().cliProfiles || []));
  const originalEnabled = [...(persistence.getSettings().enabledCliIds || [])];
  const botName = 'CLI 接入 UI fixture';
  const profileName = '自定义 CLI UI fixture';
  let fixtureBotId;
  try {
    await page(() => { closeAllModals(); openSettings('cli'); });
    check('Agent接入展示扫描、独立启用选择与逐项连接测试', await page(() => {
      const text = document.querySelector('#cliProfileList').textContent;
      return ['Pi', 'OpenCode', 'Hermes'].every(name => text.includes(name)) &&
        document.querySelectorAll('[data-cli-enable]').length >= 6 && document.querySelectorAll('[data-cli-action="test"]').length >= 6;
    }));
    await page(command => {
      document.querySelector('#cliProfileAdd').click();
      const fields = { cliProfileLabel: '取消的新接入', cliProfileCommand: command, cliProfileArgs: '--model\n{model}' };
      for (const [id, value] of Object.entries(fields)) {
        const node = document.getElementById(id); node.value = value; node.dispatchEvent(new Event('input', { bubbles: true }));
      }
      document.querySelector('#cliProfileApply').click();
    }, process.execPath);
    check('新CLI暂存只影响设置草稿', await page(() => document.querySelector('#cliProfileList').textContent.includes('取消的新接入')) &&
      !persistence.getSettings().cliProfiles?.some(profile => profile.label === '取消的新接入'));
    await page(() => { hideModal('settingsModal'); openSettings('cli'); });
    check('关闭设置取消新增CLI草稿', await page(() => !document.querySelector('#cliProfileList').textContent.includes('取消的新接入')) &&
      JSON.stringify(persistence.getSettings().cliProfiles || []) === JSON.stringify(originalProfiles));

    await page((command, label) => {
      document.querySelector('#cliProfileAdd').click();
      for (const [id, value] of Object.entries({ cliProfileLabel: label, cliProfileCommand: command, cliProfileArgs: '--model\n{model}' })) {
        const node = document.getElementById(id); node.value = value; node.dispatchEvent(new Event('input', { bubbles: true }));
      }
      document.querySelector('#cliProfilePromptMode').value = 'arg';
      document.querySelector('#cliProfilePromptMode').dispatchEvent(new Event('change'));
      document.querySelector('#cliProfileApply').click();
    }, process.execPath, profileName);
    check('参数消息缺少独立prompt占位符时表单阻止收录', await page(() =>
      !document.querySelector('#cliProfileError').hidden && document.querySelector('#cliProfileError').textContent.includes('{prompt}') &&
      !document.querySelector('#cliProfileEditor').hidden));
    await page(async () => {
      const args = document.querySelector('#cliProfileArgs'); args.value = '--model\n{model}\n{prompt}'; args.dispatchEvent(new Event('input'));
      // Global Save must include valid unfinished editor content.
      await saveSettings();
    });
    const profile = persistence.getSettings().cliProfiles?.find(item => item.label === profileName);
    check('全局保存收录当前CLI编辑并经真实IPC落盘', !!profile &&
      profile.args.join('|') === '--model|{model}|{prompt}' && profile.promptMode === 'arg' && profile.outputMode === 'text' &&
      diskSettings().cliProfiles.some(item => item.id === profile.id) &&
      await page(() => document.querySelector('#settingsModal').hidden));
    if (!profile) throw new Error('CLI fixture profile was not saved; dependent checks cannot continue');

    const diagnostics = await page(() => ({ errors: window.__caught || [], rejections: window.__unhandled || [] }));
    await new Promise(resolve => { win.webContents.once('did-finish-load', resolve); win.webContents.reload(); });
    await page(previous => {
      window.__caught = previous.errors; window.__unhandled = previous.rejections;
      window.addEventListener('error', event => window.__caught.push(event.message));
      window.addEventListener('unhandledrejection', event => window.__unhandled.push(String(event.reason?.stack || event.reason)));
    }, diagnostics);
    const restored = await waitFor(id => state.settings.cliProfiles?.some(item => item.id === id) && state.cliProfiles.some(item => item.id === id), profile.id);
    check('刷新窗口恢复自定义CLI注册与设置', restored);
    await page(() => openSettings('cli'));
    check('自定义CLI默认未启用且不能自证隐私能力', await page(id => {
      const row = document.querySelector(`[data-cli-id="${CSS.escape(id)}"]`).closest('.cli-profile-row');
      return !row.querySelector('[data-cli-enable]').checked &&
        state.cliProfiles.find(item => item.id === id).historyModeSupport === 'unknown';
    }, profile.id));
    await page(id => {
      const checkbox = document.querySelector(`[data-cli-enable="${CSS.escape(id)}"]`);
      checkbox.checked = true; checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    }, profile.id);
    check('启用Agent先保留为设置草稿', !persistence.getSettings().enabledCliIds.includes(profile.id));
    await page(async () => saveSettings());
    check('启用选择经IPC保存后可在成员中选择', persistence.getSettings().enabledCliIds.includes(profile.id));

    await page((id, name) => {
      hideModal('settingsModal'); openBotNew();
      document.querySelector('#f_name').value = name;
      const cli = document.querySelector('#f_cliType'); cli.value = id; cli.dispatchEvent(new Event('change', { bubbles: true }));
    }, profile.id, botName);
    await waitFor(() => !document.querySelector('#f_modelRefresh').disabled);
    check('成员CLI选择动态包含已启用项目并说明原生保存方式', await page(id =>
      document.querySelector('#f_cliType').value === id &&
      document.querySelector('#f_cliNotice').textContent.includes('原生设置'), profile.id));
    check('自定义CLI权限明确沿用原生参数', await page(() => document.querySelector('#f_perm').hidden && !document.querySelector('#nativePermissionNotice').hidden));
    await page(async () => {
      const select = document.querySelector('#f_modelSelect'); select.value = '__custom__'; select.dispatchEvent(new Event('change'));
      document.querySelector('#f_model').value = 'fixture-provider/custom-model';
      await saveBot();
    });
    const bot = persistence.listBots().find(item => item.name === botName);
    fixtureBotId = bot?.id;
    check('自定义CLI与自由模型标识原样保存到成员', bot?.cliType === profile.id && bot?.model === 'fixture-provider/custom-model');
    if (!bot) throw new Error('CLI fixture bot was not saved; dependent checks cannot continue');
    await page(id => openBotEdit(state.bots.find(item => item.id === id)), bot.id);
    await waitFor(() => !document.querySelector('#f_modelRefresh').disabled);
    check('重新打开自定义CLI成员保留模型与有效头像选择', await page(id =>
      document.querySelector('#f_cliType').value === id && document.querySelector('#f_model').value === 'fixture-provider/custom-model' &&
      !!document.querySelector('#f_avatarType').value, profile.id));
    await page(async () => { document.querySelector('#f_name').value += ' 已编辑'; await saveBot(); });
    check('自定义CLI成员二次保存无头像回归', persistence.listBots().find(item => item.id === bot.id)?.name === botName + ' 已编辑' &&
      await page(() => document.querySelector('#botModal').hidden));

    // Native-history uncertainty remains advisory at the real connection IPC.
    await page(id => openBotEdit(state.bots.find(item => item.id === id)), bot.id);
    await waitFor(() => !document.querySelector('#f_modelRefresh').disabled);
    await page(() => document.querySelector('#botTestBtn').click());
    await page(() => { if (AppDialog.isOpen()) document.querySelector('#appDialogAccept').click(); });
    const connected = await waitFor(() => !document.querySelector('#botTestBtn').disabled && document.querySelector('#botTestResult').textContent.includes('连接成功'));
    check('自定义CLI连接测试经IPC调用适配器并返回结果', connected && attemptedCalls === 1);

    // Deferred synthetic requests verify cancellation identity across live form edits.
    const pending = [];
    adapter.runBot = ({ bot }) => {
      const entry = { model: bot.model, cancelled: false }; pending.push(entry);
      const promise = new Promise(resolve => { entry.resolve = resolve; });
      return { promise, onEvent() {}, cancel: async () => { entry.cancelled = true; entry.resolve({ aborted: true }); } };
    };
    const connections = require('../src/main/connectionTest');
    const other = connections.test({ cliType: 'codex', model: 'parallel-fixture', confirmed: true }, persistence.getSettings());
    await page(() => document.querySelector('#botTestBtn').click());
    await page(() => document.querySelector('#appDialogAccept').click());
    await waitFor(() => !document.querySelector('#botTestCancel').hidden);
    await page(() => { document.querySelector('#f_model').value = 'changed-after-start'; document.querySelector('#botTestCancel').click(); });
    await new Promise(resolve => setTimeout(resolve, 40));
    check('修改表单模型后取消仍只终止原测试', pending.length === 2 && pending[1].cancelled && !pending[0].cancelled);
    await page(() => document.querySelector('#botTestBtn').click());
    await page(() => document.querySelector('#appDialogAccept').click());
    await waitFor(() => !document.querySelector('#botTestCancel').hidden);
    await page(id => { hideModal('botModal'); openBotEdit(state.bots.find(bot => bot.id === id)); document.querySelector('#botTestResult').textContent = 'new-editor'; }, fixtureBotId);
    await new Promise(resolve => setTimeout(resolve, 40));
    check('关闭成员编辑只取消自身测试，迟到结果不覆盖新编辑窗口', pending.length === 3 && pending[2].cancelled && !pending[0].cancelled && await page(() => document.querySelector('#botTestResult').textContent === 'new-editor'));
    pending[0].resolve({ text: 'OK' }); await other;

    // Settings failure must preserve disk data and show a recoverable UI error.
    await page(id => {
      hideModal('botModal'); openSettings('cli');
      document.querySelector(`[data-cli-action="remove"][data-cli-id="${CSS.escape(id)}"]`).click();
      document.querySelector('#settingsSaveBtn').click();
    }, profile.id);
    const removalRejected = await waitFor(() => {
      const inline = document.querySelector('#cliProfileError');
      const modal = document.querySelector('#appDialogMessage');
      return !document.querySelector('#settingsSaveBtn').disabled &&
        ((!inline.hidden && inline.textContent.includes('成员')) || (AppDialog.isOpen() && modal.textContent.includes('成员')));
    });
    check('使用中CLI移除被IPC拒绝且设置保留可见错误', removalRejected &&
      persistence.getSettings().cliProfiles.some(item => item.id === profile.id) &&
      diskSettings().cliProfiles.some(item => item.id === profile.id) &&
      await page(() => !document.querySelector('#settingsModal').hidden));
    await page(() => {
      if (AppDialog.isOpen()) document.querySelector('#appDialogAccept').click();
      hideModal('settingsModal'); openSettings('cli');
    });
    check('拒绝移除后关闭重开恢复原配置', await page(id =>
      !!document.querySelector(`[data-cli-action="edit"][data-cli-id="${CSS.escape(id)}"]`), profile.id));
    check('CLI接入验收仅发起一次合成连接测试', attemptedCalls === 1);
  } finally {
    adapter.runBot = originalRunBot;
    // Remove only fixtures created by this packet; preserve pre-existing profiles.
    if (!fixtureBotId) fixtureBotId = persistence.listBots().find(bot => bot.name === botName || bot.name === botName + ' 已编辑')?.id;
    if (fixtureBotId) persistence.deleteBot(fixtureBotId);
    persistence.saveSettings({ cliProfiles: originalProfiles, enabledCliIds: originalEnabled });
    await page(async () => {
      if (AppDialog.isOpen()) document.querySelector('#appDialogAccept').click();
      closeAllModals(); await reloadFromMain();
    });
  }
};
