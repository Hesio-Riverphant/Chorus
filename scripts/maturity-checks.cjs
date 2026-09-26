'use strict';

// Real renderer/preload/IPC/storage with synthetic discovery and transport.
// This verifies application behavior; it does not claim live provider support.
module.exports = async function maturityChecks({ win, persistence, orchestrator, fixture, check }) {
  const page = (fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
  const waitFor = async (fn, ...args) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await page(fn, ...args)) return true;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    return false;
  };
  const slash = async (side, query, name) => page((side, query, name) => {
    const input = document.querySelector(side ? '#sideChatInput' : '#input');
    input.focus(); input.value = '/' + query; input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const box = document.querySelector(side ? '#sideChatCompletion' : '#slashBox');
    const button = [...box.querySelectorAll('.mention-item')].find(item => side
      ? item.querySelector('.m-name')?.firstChild?.textContent === '/' + name : item.querySelector('.m-name')?.firstChild?.textContent === name);
    if (!button) throw new Error(`Missing slash entry ${side ? 'side' : 'main'} /${name}`);
    button.click();
  }, side, query, name);
  const closeCommandDialog = () => page(() => {
    for (const dialog of document.querySelectorAll('dialog[open]')) dialog.querySelector(':scope > button')?.click();
  });
  if (!await waitFor(() => typeof state !== 'undefined' && !!state.currentRoomId)) throw new Error('Renderer initialization failed');
  const bot = persistence.saveBot({ name: 'Maturity member', cliType: 'codex', enabled: true, model: '', role: 'custom', persona: '' });
  const main = persistence.saveRoom({ name: 'Maturity fixture', cwd: persistence.getDataPath(), botIds: [bot.id], moderatorBotId: bot.id });
  await page(async id => { await reloadFromMain(); switchRoom(id); }, main.id);
  check('工作目录在主界面直接显示', await page(cwd => document.querySelector('#roomWorkspace').textContent.includes(cwd), main.cwd));

  await slash(false, 'model', 'model');
  check('主 /model 打开正确成员设置', await waitFor(id => state.editingBotId === id && !document.querySelector('#botModal').hidden, bot.id));
  if (!await waitFor(() => !document.querySelector('#f_modelRefresh').disabled)) throw new Error('Model fixture metadata did not load');
  await page(() => {
    const model = document.querySelector('#f_modelSelect'); model.value = 'fixture-reasoner'; model.dispatchEvent(new Event('change'));
    document.querySelector('#f_reasoningEffort').value = 'ultra';
  });
  check('模型元数据提供推理等级且成员表单移除扩展控件', await page(() => document.querySelector('#f_reasoningEffort').value === 'ultra' && !document.querySelector('#nativeCapabilityDetails')));
  await page(() => saveBot());
  const saved = persistence.bots.find(item => item.id === bot.id);
  check('模型推理经 IPC 持久化', saved.model === 'fixture-reasoner' && saved.reasoningEffort === 'ultra' && saved.executionMode === 'chat');
  await slash(false, 'plugins', 'plugins');
  check('主 /plugins 打开设置内扩展管理', await waitFor(() => !document.querySelector('#settings-extensions').hidden &&
    document.querySelector('#nativeSettingsHost').textContent.includes('Fixture Plugin')));
  check('扩展页默认显示 Agent 配置且缓存可读', await page(() => document.querySelector('#settingsSaveBtn').hidden && document.querySelector('.native-room-choice').value === '') && fixture.discoveries.at(-1).refresh === false);
  check('插件所属 MCP 由插件控制且不可单独修改', await page(() => document.querySelector('.native-inventory input[value="fixture_plugin_mcp"]').disabled));
  await page(() => {
    document.querySelector('.native-inventory input[value="fixture_plugin@fixture"]').click();
    document.querySelector('.native-save').click();
  });
  check('设置内扩展开关真正保存 Agent 默认选择', await waitFor(() => state.settings.agentCapabilities?.codex?.plugins[0] === 'fixture_plugin@fixture') && persistence.getSettings().agentCapabilities.codex.plugins[0] === 'fixture_plugin@fixture');
  await page(id => { const select = document.querySelector('.native-room-choice'); select.value = id; select.dispatchEvent(new Event('change')); }, main.id);
  check('扩展设置按房间选择该房间的成员', await waitFor(id => document.querySelector('.native-member-choice')?.value === id && !document.querySelector('.native-refresh').disabled, bot.id));
  await page(() => document.querySelector('.native-inventory input[value="fixture_plugin@fixture"]').click());
  await page(() => document.querySelector('.native-save').click());
  check('房间扩展覆盖与 Agent 默认独立持久化', await waitFor((roomId, botId) => state.rooms.find(room => room.id === roomId)?.memberCapabilities?.[botId]?.plugins.length === 0, main.id, bot.id) && persistence.getSettings().agentCapabilities.codex.plugins.length === 1);
  await page(() => document.querySelector('.native-inventory input[value="fixture_plugin@fixture"]').click());
  await page(() => document.querySelector('.native-save').click());
  if (!await waitFor((roomId, botId) => state.rooms.find(room => room.id === roomId)?.memberCapabilities?.[botId]?.plugins.length === 1, main.id, bot.id)) throw new Error('Room capability save did not finish');
  await page(() => document.querySelector('.native-refresh').click());
  check('更新按钮显式请求重新扫描', await waitFor(() => !document.querySelector('.native-refresh').disabled) && fixture.discoveries.at(-1).refresh === true);
  await page(() => closeAllModals());

  await slash(false, 'plan', 'plan');
  check('主 /plan 显示计划和接收成员且不修改成员设置', await waitFor(id => state.bots.find(item => item.id === id).executionMode === 'chat' &&
    !document.querySelector('#composerMode').hidden && document.querySelector('#composerMode').textContent.includes('Maturity member') && !document.querySelector('dialog[open]'), bot.id) && fixture.calls.length === 0);
  await page(() => document.querySelector('#composerMode .mode-cancel').click());
  check('计划标记可直接取消', await waitFor(() => document.querySelector('#composerMode').hidden));
  await closeCommandDialog();
  await page(async id => { await SideChatUI.create(id); }, main.id);
  const side = persistence.rooms.find(item => item.parentRoomId === main.id);
  const sideBotId = side.botIds[0];
  check('侧聊直接显示同一工作目录', await page(cwd => document.querySelector('#sideChatWorkspace').textContent.includes(cwd), main.cwd));
  await page(() => {
    state.importedSkills = [{ alias: 'maturity-skill', name: 'Maturity Skill', description: '文档审查 校验', cliTypes: ['codex'] }];
    const input = document.querySelector('#sideChatInput'); input.focus(); input.value = '/'; input.setSelectionRange(1, 1); input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  check('侧聊斜杠菜单同时提供命令与技能', await page(() => {
    const values = [...document.querySelectorAll('#sideChatCompletion .m-name')].map(item => item.firstChild?.textContent);
    return ['/model', '/plan', '/goal', '/context', '/mcp', '/plugins', '/stop', '/maturity-skill'].every(value => values.includes(value));
  }));
  await slash(true, 'maturity-skill', 'maturity-skill');
  check('侧聊技能仍插入整体标签且不触发命令对话框', await page(() => document.querySelector('#sideChatInput [data-token="skill"]')?.textContent === '/maturity-skill' && !document.querySelector('dialog[open]')));
  await slash(false, 'skill 文档', 'maturity-skill');
  check('主聊 /skill 按说明关键词选择引用', await page(() => document.querySelector('#input [data-token="skill"]')?.textContent === '/maturity-skill'));
  await slash(true, 'skill 校验', 'maturity-skill');
  check('侧聊 /skill 按说明关键词选择引用', await page(() => document.querySelector('#sideChatInput [data-token="skill"]')?.textContent === '/maturity-skill'));
  await slash(true, 'mcp', 'mcp');
  check('侧 /mcp 打开扩展管理并使用继承目录', await waitFor(() => !document.querySelector('#settings-extensions').hidden &&
    document.querySelector('#nativeSettingsHost').textContent.includes('Fixture MCP')) && fixture.discoveries.at(-1).cwd === main.cwd);
  await page(() => closeAllModals());
  await slash(true, 'plan', 'plan');
  check('侧 /plan 与主聊模式独立且不修改成员', await waitFor(() => !document.querySelector('#sideChatMode').hidden && document.querySelector('#composerMode').hidden) &&
    persistence.bots.find(item => item.id === sideBotId).executionMode === 'chat');
  await closeCommandDialog();

  persistence.addMessage(main.id, { id: 'context_main', roomId: main.id, authorType: 'bot', authorId: bot.id, text: 'main context fixture', status: 'done', createdAt: Date.now(), usage: { inputTokens: 456, cachedInputTokens: 100 }, contextUsage: { totalTokens: 654, contextWindow: 200000, inputTokens: 400, cachedInputTokens: 100 } });
  await page(async () => reloadFromMain());
  await slash(false, 'context', 'context');
  check('主 /context 显示原生用量和当前房间成员', await waitFor(() => document.querySelector('.context-table tbody')?.textContent.includes('456 tok') && document.querySelector('.context-table tbody')?.textContent.includes('654 / 200K tok')));
  check('上下文进度及最近请求缓存命中来自具体字段', await page(() => {
    const bar = document.querySelector('.context-meter');
    return bar.value === 654 && bar.max === 200000 && document.querySelector('.context-table').textContent.includes('最近请求 25%');
  }));
  await closeCommandDialog();
  await slash(true, 'context', 'context');
  check('侧 /context 使用独立历史且不发送聊天消息', await waitFor(() => document.querySelector('.context-table tbody')?.textContent.includes('尚无记录') && document.querySelector('.context-table tbody')?.textContent.includes('CLI 未提供')) && fixture.calls.length === 0 && persistence.getMessages(side.id).length === 0);
  await closeCommandDialog();

  await page(() => { document.querySelector('#sideChatInput').value = 'synthetic question'; document.querySelector('#sideChatSend').click(); });
  check('原生问题经实际 IPC 仅出现在对应侧聊', await waitFor(() => !!document.querySelector('#sideChatMessages .native-question') && !document.querySelector('#messages .native-question')));
  const call = fixture.calls.at(-1);
  check('运行使用侧聊模型推理计划和已选能力配置', call?.bot.id === sideBotId && call.bot.model === 'fixture-reasoner' && call.bot.reasoningEffort === 'ultra' && call.bot.executionMode === 'plan' && fixture.preparations.at(-1)?.plugins[0] === 'fixture_plugin@fixture');
  await page(() => {
    const input = document.querySelector('#sideChatMessages .native-question input'); input.value = 'typed fixture'; input.dispatchEvent(new Event('input'));
    SideChatUI.refreshMessages(SideChatUI.getRoom().id);
  });
  check('侧聊消息重渲染保留待答问题与输入', await page(() => document.querySelector('#sideChatMessages .native-question input')?.value === 'typed fixture'));
  const pending = orchestrator.getPendingInputs()[0];
  check('跨房间回答被 IPC 拒绝且保留原待答问题', await page(async (roomId, messageId) => {
    try { await window.api.respondNativeInput({ roomId, messageId, requestId: 'fixture_question', answers: { choice: { answers: ['wrong room'] } } }); return false; }
    catch (_) { return !!document.querySelector('#sideChatMessages .native-question'); }
  }, main.id, pending.messageId) && fixture.answers.length === 0);

  await new Promise(resolve => { win.webContents.once('did-finish-load', resolve); win.webContents.reload(); });
  if (!await waitFor(() => typeof state !== 'undefined' && !!state.currentRoomId)) throw new Error('Renderer refresh failed');
  await page((mainId, sideId) => { switchRoom(mainId); SideChatUI.open(sideId); }, main.id, side.id);
  check('整页刷新从主进程恢复待答问题', await waitFor(() => !!document.querySelector('#sideChatMessages .native-question')));
  check('整页刷新仍显示正在执行的计划模式', await page(() => !document.querySelector('#sideChatMode').hidden && document.querySelector('#sideChatMode').textContent.includes('计划')));
  await page(() => {
    const form = document.querySelector('#sideChatMessages .native-question');
    [...form.querySelectorAll('.native-question-choice')].find(button => button.optionLabel === 'Option B').click(); form.requestSubmit();
  });
  check('回答正确路由并让侧聊继续完成', await waitFor(() => !document.querySelector('#sideChatMessages .native-question') && document.querySelector('#sideChatMessages').textContent.includes('Synthetic reply')) && fixture.answers.length === 1 && fixture.answers[0].botId === sideBotId && fixture.answers[0].answers.choice.answers[0] === 'Option B');
  check('补充答案只用于运行协议且不写聊天正文', !JSON.stringify(persistence.getMessages(side.id)).includes('Option B') && !orchestrator.isBusy(side.id));
  await slash(true, 'context', 'context');
  check('侧聊完成后 /context 显示最新原生用量', await waitFor(() => document.querySelector('.context-table tbody')?.textContent.includes('123 tok') && document.querySelector('.context-table tbody')?.textContent.includes('987 / 200K tok')));
  await closeCommandDialog();

  await page(() => { document.querySelector('#input').value = 'main synthetic question'; document.querySelector('#actionBtn').click(); });
  check('主聊原生问题显示与侧聊独立', await waitFor(() => !!document.querySelector('#messages .native-question') && !document.querySelector('#sideChatMessages .native-question')));
  await slash(false, 'stop', 'stop');
  check('主 /stop 清理待答问题并结束所属运行', await waitFor(() => !document.querySelector('#messages .native-question')) && !orchestrator.isBusy(main.id) && orchestrator.getPendingInputs().length === 0);

  await slash(false, 'goal', 'goal');
  check('目标标记显示原生保存方式并可取消', await page(() => {
    const chip = document.querySelector('#composerMode');
    return !chip.hidden && chip.textContent.includes('目标') && chip.textContent.includes('Codex 历史');
  }));
  await page(() => document.querySelector('#composerMode .mode-cancel').click());
  check('退出目标后恢复普通路由控件', await waitFor(() => document.querySelector('#composerMode').hidden && !document.querySelector('#composer .composer-toolbar').hidden));

  await page(() => { document.querySelector('#input').value = '/plan @Maturity member scoped fixture'; document.querySelector('#actionBtn').click(); });
  check('前缀命令与消息一起发送为原生计划且正文保留 @', await waitFor(() => !!document.querySelector('#messages .native-question')) &&
    fixture.calls.at(-1)?.bot.executionMode === 'plan' && persistence.getMessages(main.id).some(message => message.authorType === 'human' && message.text === '@Maturity member scoped fixture' && message.mode === 'plan'));
  await page(() => document.querySelector('#composerMode .mode-cancel').click());
  check('模式关闭按钮停止活动运行并退出标记', await waitFor(() => document.querySelector('#composerMode').hidden && !document.querySelector('#messages .native-question')) && !orchestrator.isBusy(main.id));

  const nativeCapabilities = require('../src/main/nativeCapabilities');
  const previousDiscover = nativeCapabilities.discover;
  const legacyMember = persistence.saveBot({ name: 'Claude capability recovery', cliType: 'claude', enabled: true,
    nativeCapabilities: { mode: 'selected', mcp: ['disabled_fixture'], plugins: [] } });
  const recoveryRoom = persistence.saveRoom({ name: 'Capability recovery', cwd: persistence.getDataPath(),
    botIds: [legacyMember.id], moderatorBotId: legacyMember.id, memberCapabilities: { [legacyMember.id]: legacyMember.nativeCapabilities } });
  nativeCapabilities.discover = async (cli, cwd, options) => cli === 'claude' ? {
    items: [{ id: 'disabled_fixture', name: 'Disabled fixture', kind: 'mcp', enabled: false,
      status: 'disabled', enableSupported: false }], scannedAt: Date.now(),
  } : previousDiscover(cli, cwd, options);
  try {
    await page(async roomId => { await reloadFromMain(); openSettings('extensions', roomId); }, recoveryRoom.id);
    await waitFor(() => !!document.querySelector('.native-room-choice'));
    await page(id => { const select = document.querySelector('.native-room-choice'); select.value = id; select.dispatchEvent(new Event('change')); }, recoveryRoom.id);
    check('原生已禁用的已选 MCP 仍可取消', await waitFor(() => {
      const input = document.querySelector('.native-inventory input[value="disabled_fixture"]');
      return input?.checked && !input.disabled;
    }));
    await page(() => document.querySelector('.native-inventory input[value="disabled_fixture"]').click());
    check('原生禁用项可保留选择但明确显示原生启用要求', await page(() => {
      let input = document.querySelector('.native-inventory input[value="disabled_fixture"]');
      if (input.disabled || input.checked) return false;
      input.click(); input = document.querySelector('.native-inventory input[value="disabled_fixture"]');
      const selected = input.checked && !input.disabled && input.closest('label').textContent.includes('原生已禁用');
      input.click();
      return selected && !document.querySelector('.native-save').disabled;
    }));
    await page(() => document.querySelector('.native-save').click());
    check('取消 MCP 的选择经 IPC 保存', await waitFor(botId =>
      state.rooms.find(room => room.botIds.includes(botId))?.memberCapabilities?.[botId]?.mcp.length === 0, legacyMember.id) &&
      persistence.rooms.find(room => room.id === recoveryRoom.id).memberCapabilities[legacyMember.id].mcp.length === 0);
    await page(roomId => openNativeManagement(roomId), recoveryRoom.id);
    await page(id => { const select = document.querySelector('.native-room-choice'); select.value = id; select.dispatchEvent(new Event('change')); }, recoveryRoom.id);
    await waitFor(() => !document.querySelector('.native-refresh').disabled);
    check('重开扩展管理保留未选状态并提供原生管理入口', await page(() => {
      const input = document.querySelector('.native-inventory input[value="disabled_fixture"]');
      return input && !input.checked && !input.disabled && !document.querySelector('.native-open-terminal').hidden;
    }));
  } finally {
    nativeCapabilities.discover = previousDiscover;
    await page(roomId => { closeAllModals(); switchRoom(roomId); }, main.id);
  }
  const archivedMember = persistence.saveBot({ name: 'Archived-only should not appear', cliType: 'codex', enabled: true });
  const archivedRoom = persistence.saveRoom({ name: 'Archived-only room', botIds: [archivedMember.id] });
  persistence.setRoomArchived(archivedRoom.id, true);
  const orphan = persistence.saveBot({ name: 'Orphan should not appear', cliType: 'codex', enabled: true });
  const inherited = persistence.saveBot({ name: 'Searchable fresh member', cliType: 'codex', enabled: true });
  const inheritedRoom = persistence.saveRoom({ name: 'Searchable project room', cwd: persistence.getDataPath(), botIds: [inherited.id] });
  await page(async roomId => { await reloadFromMain(); openSettings('extensions', roomId); }, inheritedRoom.id);
  await waitFor(() => !!document.querySelector('.native-room-choice'));
  await page(id => { const select = document.querySelector('.native-room-choice'); select.value = id; select.dispatchEvent(new Event('change')); }, inheritedRoom.id);
  check('未定制房间成员跟随 Agent 默认配置', await waitFor(() => document.querySelector('.native-mode')?.value === 'default'));
  check('扩展成员列表不显示未加入房间的 bot', await page(id =>
    ![...document.querySelector('.native-member-choice').options].some(option => option.value === id), orphan.id));
  check('扩展成员列表不显示仅在归档房间的 bot', await page(id =>
    ![...document.querySelector('.native-member-choice').options].some(option => option.value === id), archivedMember.id));
  check('成员列表仅含所选房间且可按成员名搜索', await page(() => {
    const input = document.querySelector('.native-member-search'); input.value = 'Searchable fresh'; input.dispatchEvent(new Event('input'));
    const options = [...document.querySelector('.native-member-choice').options];
    return options.length === 1 && options[0].textContent.includes('Searchable fresh member') && document.querySelector('.native-room-choice').selectedOptions[0].textContent.includes('Searchable project room');
  }));
  check('成员搜索无匹配不会悄悄切换操作对象', await page(() => {
    const before = document.querySelector('.native-selected-member').textContent;
    const input = document.querySelector('.native-member-search'); input.value = 'no-such-fixture'; input.dispatchEvent(new Event('input'));
    return document.querySelector('.native-member-choice').disabled && document.querySelector('.native-selected-member').textContent === before;
  }));
  await page(() => openSettings('skills'));
  check('技能库扫描当前分类并显示已接入 Agent', await waitFor(() => !document.querySelector('#skillSourceCategory').disabled) && fixture.skillScans.at(-1)?.category === await page(() => document.querySelector('#skillSourceCategory').value) && await page(() => state.cliProfiles.filter(profile => profile.enabled).every(profile => [...document.querySelector('#skillSourceCategory').options].some(option => option.value === profile.id))));
  for (const category of ['codex', 'other']) {
    await page(value => { const select = document.querySelector('#skillSourceCategory'); select.value = value; select.dispatchEvent(new Event('change')); }, category);
    check(`技能库只刷新 ${category} 分类`, await waitFor(() => !document.querySelector('#skillSourceCategory').disabled) && fixture.skillScans.at(-1)?.category === category);
  }
  await page(async () => { closeAllModals(); state.settings = await window.api.saveSettings({ historyTokenBudget: 4000 }); openSettings('guard'); });
  check('历史 token 预算经 IPC 落盘并在设置显示', persistence.getSettings().historyTokenBudget === 4000 && await page(() => document.querySelector('#s_historyTokens').value === '4000'));
  check('历史 token 预算拒绝越界输入且保留原值', await page(async () => {
    try { await window.api.saveSettings({ historyTokenBudget: -1 }); return false; } catch (_) { return true; }
  }) && persistence.getSettings().historyTokenBudget === 4000);
  await page(() => closeAllModals());
};
