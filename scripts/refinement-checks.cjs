'use strict';

// Real Electron and IPC; fixtures only. No real model or external skill writes.
module.exports = async function refinementChecks({ win, persistence, check }) {
  const fs = require('node:fs');
  const path = require('node:path');
  const page = (fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`).catch(error => { throw new Error(error.message + "\nUI check: " + fn.toString().slice(0,1600)); });
  const settle = () => new Promise(resolve => setTimeout(resolve, 140));
  await page(() => { closeAllModals(); openSettings('skills'); }); await settle();
  check('技能来源可读，扫描详情可折叠且添加来源保持可见', await page(() => {
    const source = document.querySelector('#skillReferences .sk-source') || document.querySelector('#skillDiscover .sk-source');
    const roots = document.querySelector('#skillScanStatus');
    return !!source?.textContent && source.getClientRects().length > 0 && !source.closest('details')?.open &&
      !!roots.closest('.scan-details') &&
      !document.querySelector('#skillAddRoot').closest('details') &&
      document.querySelector('#skillAddRoot').getClientRects().length > 0 &&
      !document.querySelector('#skillImported,#skillsPath,#openSkillsBtn');
  }));
  check('技能多类型说明明确且接力控制没有token或成本上限', await page(() => {
    const text = document.querySelector('[data-panel="skills"]').textContent;
    return text.includes('对应 Agent') && text.includes('登记来源引用') &&
      !document.querySelector('#s_tokens,#s_cost') && !!document.querySelector('#s_calls');
  }));
  await page(() => { hideModal('settingsModal'); });
  check('默认阅读区与侧栏采用相邻浅灰', await page(() =>
    getComputedStyle(document.body).backgroundColor === 'rgb(247, 247, 248)' &&
    getComputedStyle(document.querySelector('#sidebar')).backgroundColor === 'rgb(241, 242, 243)'));

  await page(() => {
    openSettings('appearance');
    const size = document.querySelector('#appearanceFontSize'); size.value = '18'; size.dispatchEvent(new Event('change'));
    document.querySelector('#appearanceTextSwatches [data-color="#354455"]').click();
  });
  check('色板和字号即时应用到正文侧栏与输入控件，取消恢复', await page(() => {
    const result = getComputedStyle(document.body).fontSize === '18px' &&
      getComputedStyle(document.querySelector('#f_name')).fontSize === '18px' &&
      getComputedStyle(document.querySelector('#actionBtn')).fontSize === '18px' &&
      getComputedStyle(document.body).color === 'rgb(53, 68, 85)' &&
      getComputedStyle(document.querySelector('#sidebar')).color === 'rgb(53, 68, 85)';
    hideModal('settingsModal');
    return result && getComputedStyle(document.body).fontSize === '14px' &&
      getComputedStyle(document.body).color !== 'rgb(53, 68, 85)';
  }));

  await page(() => {
    openSettings('appearance');
    const bg = document.querySelector('#appearanceBackground');
    bg.value = '#dde3dc'; bg.dispatchEvent(new Event('input', { bubbles: true }));
  });
  check('自定义颜色即时预览且关闭回退', await page(() => {
    const preview = getComputedStyle(document.body).backgroundColor === 'rgb(221, 227, 220)';
    hideModal('settingsModal');
    return preview && getComputedStyle(document.body).backgroundColor === 'rgb(247, 247, 248)';
  }));
  check('无效颜色阻止保存并展示错误', await page(async () => {
    openSettings('appearance');
    const input = document.querySelector('#appearanceAccent'); input.value = 'invalid';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await saveSettings();
    return !document.querySelector('#settingsModal').hidden && !document.querySelector('#appearanceError').hidden &&
      getComputedStyle(document.body).backgroundColor === 'rgb(247, 247, 248)';
  }));
  await page(async () => {
    document.querySelector('#appearanceReset').click();
    document.querySelector('#appearanceMode').value = 'system';
    document.querySelector('#appearanceMode').dispatchEvent(new Event('change'));
    await saveSettings();
  });
  const stored = JSON.parse(fs.readFileSync(path.join(persistence.getDataPath(), 'settings.json'), 'utf8'));
  check('外观保存通过真实IPC落盘', stored.appearance?.mode === 'system' && stored.appearance.preset === 'graphite');
  win.webContents.debugger.attach('1.3');
  try {
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    await page(async () => {
      for (let n = 0; n < 40 && document.documentElement.dataset.theme !== 'dark'; n++) {
        getComputedStyle(document.body).backgroundColor; await new Promise(resolve => setTimeout(resolve, 50));
      }
    });
    const dark = await page(() => getComputedStyle(document.body).backgroundColor === 'rgb(32, 34, 38)');
    if (process.env.AR_UI_EVIDENCE_DIR) fs.writeFileSync(path.join(process.env.AR_UI_EVIDENCE_DIR, 'dark.png'), (await win.webContents.capturePage()).toPNG());
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await page(async () => {
      for (let n = 0; n < 40 && document.documentElement.dataset.theme !== 'light'; n++) {
        getComputedStyle(document.body).backgroundColor; await new Promise(resolve => setTimeout(resolve, 50));
      }
    });
    check('跟随系统在真实渲染中即时切换明暗', dark && await page(() => getComputedStyle(document.body).backgroundColor === 'rgb(247, 247, 248)'));
  } finally { win.webContents.debugger.detach(); }
  await page(async () => {
    openSettings('appearance');
    document.querySelector('#appearancePreset').value = 'sage';
    document.querySelector('#appearancePreset').dispatchEvent(new Event('change'));
    document.querySelector('#appearanceMode').value = 'light';
    document.querySelector('#appearanceMode').dispatchEvent(new Event('change'));
    const side = document.querySelector('#appearanceSidebar'); side.value = '#303438'; side.dispatchEvent(new Event('input'));
    const size = document.querySelector('#appearanceFontSize'); size.value = '18'; size.dispatchEvent(new Event('change'));
    document.querySelector('#appearanceTextSwatches [data-color="#354455"]').click();
    await saveSettings();
  });
  const beforeReloadErrors = await page(() => ({ errors: window.__caught || [], rejections: window.__unhandled || [] }));
  await new Promise(resolve => { win.webContents.once('did-finish-load', resolve); win.webContents.reload(); });
  await page(previous => {
    window.__caught = previous.errors; window.__unhandled = previous.rejections;
    window.addEventListener('error', event => window.__caught.push(event.message));
    window.addEventListener('unhandledrejection', event => window.__unhandled.push(String(event.reason?.stack || event.reason)));
  }, beforeReloadErrors);
  await settle();
  check('刷新窗口保留自定义外观字号与文字颜色', await page(() => state.settings.appearance?.sidebar === '#303438' &&
    state.settings.appearance.text === '#354455' && state.settings.appearance.fontSize === 18 &&
    getComputedStyle(document.querySelector('#sidebar')).backgroundColor === 'rgb(48, 52, 56)' &&
    getComputedStyle(document.body).fontSize === '18px' && getComputedStyle(document.body).color === 'rgb(53, 68, 85)'));
  await page(() => { openSettings('appearance'); });
  if (process.env.AR_UI_EVIDENCE_DIR) fs.writeFileSync(path.join(process.env.AR_UI_EVIDENCE_DIR, 'appearance.png'), (await win.webContents.capturePage()).toPNG());
  await page(async () => { document.querySelector('#appearanceReset').click(); await saveSettings(); });

  const modelBot = persistence.listBots()[0];
  for (const cliType of ['claude', 'codex', 'kimi']) {
    await page(type => { openBotEdit(state.bots[0]); document.querySelector('#f_cliType').value = type; document.querySelector('#f_cliType').dispatchEvent(new Event('change')); if (type === 'kimi') document.querySelector('input[name="f_permRadio"][value="full"]').click(); }, cliType);
    await settle();
    await page(type => { const select = document.querySelector('#f_modelSelect'); select.value = type + '-fixture'; select.dispatchEvent(new Event('change')); document.querySelector('#botSaveBtn').click(); }, cliType);
    await settle();
    check(cliType + ' 模型从候选选择并保存到对应Bot', persistence.listBots().find(bot => bot.id === modelBot.id)?.model === cliType + '-fixture');
  }
  await page(() => openBotEdit(state.bots[0])); await settle();
  await page(() => {
    const select = document.querySelector('#f_modelSelect'); select.value = '__custom__'; select.dispatchEvent(new Event('change'));
    document.querySelector('#f_model').value = 'provider/custom-model'; document.querySelector('#botSaveBtn').click();
  }); await settle();
  await page(() => openBotEdit(state.bots[0])); await settle();
  check('自定义模型保存后重新打开仍保留且可编辑', persistence.listBots().find(bot => bot.id === modelBot.id).model === 'provider/custom-model' &&
    await page(() => !document.querySelector('#botModal').hidden && document.querySelector('#f_modelSelect').value === '__custom__' && !document.querySelector('#f_model').hidden));
  if (process.env.AR_UI_EVIDENCE_DIR) {
    await page(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const layout = await page(() => ({ hidden:document.querySelector('#botModal').hidden, rect:document.querySelector('#botModal').getBoundingClientRect().toJSON(), selected:document.querySelector('#f_modelSelect').value }));
    fs.writeFileSync(path.join(process.env.AR_UI_EVIDENCE_DIR, 'model-picker-layout.json'), JSON.stringify(layout,null,2));
    fs.writeFileSync(path.join(process.env.AR_UI_EVIDENCE_DIR, 'model-picker.png'), (await win.webContents.capturePage()).toPNG());
  }
  await page(() => { const select = document.querySelector('#f_modelSelect'); select.value = ''; select.dispatchEvent(new Event('change')); document.querySelector('#botSaveBtn').click(); }); await settle();
  check('可切回CLI默认模型', persistence.listBots().find(bot => bot.id === modelBot.id).model === '');

  // Keep actual rewind persistence/IPC, replace only the external generation boundary.
  const orchestrator = require('../src/main/orchestrator/orchestrator');
  const original = orchestrator.continueHuman;
  let continued;
  orchestrator.continueHuman = async (roomId, messageId) => { continued = { roomId, messageId }; return { ok: true }; };
  const room = persistence.saveRoom({ name: '直接重新生成验收', botIds: [] });
  persistence.addMessage(room.id, { id: 'direct_h', roomId: room.id, authorType: 'human', authorId: 'owner', text: '原内容', status: 'done', createdAt: Date.now() });
  persistence.addMessage(room.id, { id: 'direct_tail', roomId: room.id, authorType: 'system', text: '后文', status: 'done', createdAt: Date.now() });
  try {
    await page(async id => { await reloadFromMain(); await switchRoom(id); document.querySelector('[data-msg-id="direct_h"] [title="编辑并回溯"]').click(); }, room.id);
    await page(() => { document.querySelector('#messageEditText').value = '改写后的内容'; document.querySelector('#messageEditRegenerate').click(); });
    await settle();
    check('保存并重新生成直接回溯后调用生成且无确认弹窗', continued?.messageId === 'direct_h' && continued.roomId === room.id &&
      persistence.getMessages(room.id).length === 1 && persistence.getMessages(room.id)[0].text === '改写后的内容' &&
      await page(() => !AppDialog.isOpen() && !document.querySelector('#messageEditDialog')));
  } finally { orchestrator.continueHuman = original; }
};
