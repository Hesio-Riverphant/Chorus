'use strict';

// Reusable inside the isolated Electron harness. Real IPC and JSON storage,
// synthetic content only. The caller must replace CLI execution before load.
module.exports = async function roomChecks({ win, persistence, check }) {
  const page = (fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
  const waitFor = async (fn, ...args) => {
    for (let i = 0; i < 80; i++) {
      if (await page(fn, ...args)) return true;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    return false;
  };
  const parent = persistence.saveRoom({ name: 'Pane fixture', cwd: persistence.getDataPath() });
  await page(async (id) => { closeAllModals(); await reloadFromMain(); switchRoom(id); }, parent.id);
  await page(async (id) => { await RoomUI.pin(state.rooms.find((room) => room.id === id)); }, parent.id);
  check('置顶立即排序并写入房间记录', persistence.rooms.find((room) => room.id === parent.id).pinnedAt > 0 &&
    await page((id) => document.querySelector('#roomList .side-item').dataset.roomId === id, parent.id));
  await page((id) => { RoomUI.rename(state.rooms.find((room) => room.id === id)); }, parent.id);
  await page(() => { document.querySelector('#messageEditText').value = 'Pane renamed'; document.querySelector('#messageEditSave').click(); });
  check('重命名动作更新标题并保持原房间ID', await waitFor((id) => document.querySelector('#roomName').textContent === 'Pane renamed' && state.currentRoomId === id, parent.id));
  await page(async (id) => { await SideChatUI.create(id); }, parent.id);
  const side = persistence.rooms.find((room) => room.parentRoomId === parent.id);
  check('侧边聊天保留主会话并快照成员配置', !!side && side.cwd === parent.cwd &&
    side.botIds.every((id) => parent.botIds.includes(id)) && persistence.getMessages(side.id).length === 0 &&
    await page((id) => state.currentRoomId === id && !document.querySelector('#sideChatPane').hidden && document.querySelector('#sideChatMembers').children.length >= 2, parent.id));
  if (!side) throw new Error('Side conversation fixture creation failed');
  await page(() => {
    document.querySelector('#input').value = 'main draft';
    document.querySelector('#sideChatInput').value = 'side draft';
    document.querySelector('#sideChatClose').click();
  });
  await page((id) => SideChatUI.open(id), side.id);
  check('侧边聊天收起再打开保留独立草稿', await page(() => document.querySelector('#input').value === 'main draft' && document.querySelector('#sideChatInput').value === 'side draft'));

  await page(() => {
    state.importedSkills = [{ alias: 'side-fixture', name: 'side-fixture', cliTypes: ['claude', 'codex'] }];
    const input = document.querySelector('#sideChatInput'); input.focus(); input.value = '/side-fixture';
    input.setSelectionRange(input.value.length, input.value.length); input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#sideChatCompletion .mention-item').click();
  });
  check('侧聊独立斜杠菜单插入整体技能标签', await page(() => document.querySelector('#sideChatInput [data-token="skill"]')?.textContent === '/side-fixture' && document.querySelector('#input').value === 'main draft'));

  const originalBot = persistence.bots.find((bot) => bot.id === parent.botIds[0]);
  await page(() => document.querySelector('#sideChatMembers .side-chat-member').click());
  const editingSide = await page((id) => state.editingBotRoomId === id && document.querySelector('#f_cwd').disabled, side.id);
  await page(async () => {
    document.querySelector('#f_name').value = 'Side only member';
    document.querySelector('#f_modelSelect').value = '__custom__';
    document.querySelector('#f_modelSelect').dispatchEvent(new Event('change'));
    document.querySelector('#f_model').value = 'side-fixture-model';
    await saveBot();
  });
  check('侧聊成员编辑只影响此侧聊', editingSide &&
    persistence.rooms.find(room => room.id === side.id).memberProfiles[side.botIds[0]].model === 'side-fixture-model' &&
    persistence.bots.find((bot) => bot.id === originalBot.id).name === originalBot.name &&
    await page(() => document.querySelector('#sideChatMembers').textContent.includes('Side only member')));

  const template = persistence.saveBot({ name: 'Added template', cliType: 'codex', enabled: true, model: '' });
  await page(async (id) => { await reloadFromMain(); openAddMember(id); }, side.id);
  await page(async (id) => { document.querySelector(`#am_list input[value="${id}"]`).checked = true; await addCheckedMembers(); }, template.id);
  const updatedSide = persistence.rooms.find((room) => room.id === side.id);
  check('侧聊添加已有成员生成本地快照并立即显示', updatedSide.botIds.length === side.botIds.length + 1 &&
    updatedSide.botIds.includes(template.id) &&
    await page(() => document.querySelector('#sideChatMembers').textContent.includes('Added template')));

  await page(async (id, botId) => {
    const room = state.rooms.find(item => item.id === id);
    await removeMember(room, roomMembers(room).find(bot => bot.id === botId));
  }, side.id, template.id);
  check('侧聊成员可移出且全局 bot 保留', !persistence.rooms.find(room => room.id === side.id).botIds.includes(template.id) &&
    persistence.bots.some(bot => bot.id === template.id));
  await page(async (id, botId) => { openAddMember(id); document.querySelector(`#am_list input[value="${botId}"]`).checked = true; await addCheckedMembers(); }, side.id, template.id);

  await page(() => {
    const select = document.querySelector('#sideChatRouting'); select.value = 'all'; select.dispatchEvent(new Event('change'));
  });
  await waitFor((id) => state.rooms.find((room) => room.id === id).routingMode === 'all', side.id);
  check('侧聊发言设置与主房间独立', persistence.rooms.find((room) => room.id === side.id).routingMode === 'all' &&
    persistence.rooms.find((room) => room.id === parent.id).routingMode === parent.routingMode);

  // The synthetic harness marks empty rooms as having no recipients for this
  // check; accepting a human message is still the full renderer/preload/IPC
  // path and cannot cause a provider request.
  const bots = persistence.roomMembers(updatedSide);
  for (const bot of bots) persistence.saveRoomMember(updatedSide.id, { ...bot, enabled: false });
  await page(async () => { await reloadFromMain(); document.querySelector('#sideChatInput').value = 'side message'; document.querySelector('#sideChatSend').click(); });
  const sent = await waitFor((id) => messages(id).some((message) => message.text === 'side message'), side.id);
  check('侧聊真实发送入口仅写入侧聊且清空对应草稿', sent && persistence.getMessages(side.id).some((message) => message.text === 'side message') &&
    !persistence.getMessages(parent.id).some((message) => message.text === 'side message') &&
    await page(() => document.querySelector('#sideChatInput').value === '' && document.querySelector('#input').value === 'main draft'));

  // Synthetic streams pass through the real IPC event listener. Both panes
  // must render only their conversation while activity remains expandable.
  const stream = { id: 'side_stream_fixture', roomId: side.id, authorType: 'bot', authorId: side.botIds[0],
    text: '', status: 'streaming', createdAt: Date.now() };
  win.webContents.send('room:event', { kind: 'message_add', roomId: side.id, message: stream });
  win.webContents.send('room:event', { kind: 'message_delta', roomId: side.id, id: stream.id, text: 'isolated stream' });
  win.webContents.send('room:event', { kind: 'message_update', roomId: side.id, id: stream.id,
    patch: { status: 'done', activities: [{ id: 'fixture_activity', name: 'fixture tool', status: 'done', detail: 'fixture details' }] } });
  check('侧聊流式事件和工具活动只更新对应面板', await waitFor((id) =>
    document.querySelector(`#sideChatMessages [data-msg-id="${id}"] .bubble-text`)?.textContent.trim() === 'isolated stream' &&
    !!document.querySelector(`#sideChatMessages [data-msg-id="${id}"] .activities details`) &&
    !document.querySelector(`#messages [data-msg-id="${id}"]`), stream.id));

  const parentMessage = { id: 'parent_fixture_message', roomId: parent.id, authorType: 'human', authorId: 'owner', text: 'parent kept', status: 'done', createdAt: Date.now() };
  persistence.addMessage(parent.id, parentMessage);
  const sideMessage = { id: 'side_fixture_message', roomId: side.id, authorType: 'human', authorId: 'owner', text: 'side edit', status: 'done', createdAt: Date.now() };
  persistence.addMessage(side.id, sideMessage);
  persistence.addMessage(side.id, { ...sideMessage, id: 'side_later_fixture', text: 'later' });
  await page(async () => { await reloadFromMain(); });
  await page((id) => { document.querySelector(`#sideChatMessages [data-msg-id="${id}"] [title="编辑并回溯"]`).click(); }, sideMessage.id);
  await page(() => { document.querySelector('#messageEditText').value = 'side edited'; document.querySelector('#messageEditSave').click(); });
  const rewound = await waitFor((id) => !document.querySelector(`#sideChatMessages [data-msg-id="${id}"]`), 'side_later_fixture');
  check('侧聊回溯即时刷新侧栏消息并保留主会话', rewound && persistence.getMessage(side.id, sideMessage.id).text === 'side edited' && persistence.getMessage(parent.id, parentMessage.id).text === 'parent kept');

  await page((id) => SideChatUI.open(id), side.id);
  await page((id) => { document.querySelector(`#sideChatMessages [data-msg-id="${id}"] .msg-del`).click(); }, sideMessage.id);
  await page(() => document.querySelector('#appDialogAccept').click());
  check('侧聊删除动作准确作用于侧聊消息', await waitFor((id) => !document.querySelector(`#sideChatMessages [data-msg-id="${id}"]`), sideMessage.id) &&
    persistence.getMessage(side.id, sideMessage.id) === null && !!persistence.getMessage(parent.id, parentMessage.id));

  const sourceIds = updatedSide.botIds.slice();
  await page(async (id) => { await window.api.deleteRoom(id); await reloadFromMain(); }, parent.id);
  const detached = persistence.rooms.find((room) => room.id === side.id);
  check('主房间删除后侧聊历史成为可见独立房间', !detached.parentRoomId && detached.botIds.every((id) => sourceIds.includes(id)) &&
    await page((id) => !!document.querySelector(`#roomList .side-item[data-room-id="${id}"]`), side.id));
  const globalBot = persistence.saveBot({ name: 'Unassigned global fixture', cliType: 'codex', enabled: true });
  await page(async () => { await reloadFromMain(); openSettings('bots'); });
  check('设置中可管理未加入任何房间的成员', await page(() => document.querySelector('#botManagementList').textContent.includes('Unassigned global fixture')));
  await page((id) => openBotEdit(state.bots.find(bot => bot.id === id), null), globalBot.id);
  await page(async () => { document.querySelector('#f_name').value = 'Global edited'; await saveBot(); });
  check('全局编辑不会把未加入成员意外加入当前房间', persistence.bots.find(bot => bot.id === globalBot.id).name === 'Global edited' && persistence.rooms.every(room => !room.botIds.includes(globalBot.id)));
  await page(() => closeAllModals());

  const archiveRoom = persistence.saveRoom({ name: 'Archive search fixture', cwd: persistence.getDataPath() });
  persistence.addMessage(archiveRoom.id, { id: 'archive_hit', authorType: 'bot', text: 'Final conclusion',
    activities: [{ phase: 'commentary', detail: 'archived exact needle 927', order: 0 }], status: 'done', createdAt: Date.now() });
  const snapshot = persistence.archiveCurrent(archiveRoom.id);
  await page(async () => {
    await reloadFromMain(); ConversationUI.openSearch();
    const input = document.querySelector('#conversationSearchDialog input'); input.value = 'archived exact needle 927';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  check('Ctrl K 搜索归档并跳转只读归档中的准确消息', await waitFor(() => !document.querySelector('#archiveViewerModal').hidden &&
    document.querySelector('[data-archive-message-id="archive_hit"]')?.classList.contains('message-search-target')));
  check('查看搜索结果不恢复或修改归档', persistence.getMessages(archiveRoom.id).length === 0 && !!persistence.getArchive(archiveRoom.id, snapshot.id));
  check('归档查看器显示搜索命中的公开过程文字', await page(() => document.querySelector('#archiveViewerBody').textContent.includes('archived exact needle 927')));
  await page(async id => { closeAllModals(); openSettings('history'); await loadHistoryTab(); await window.api.setRoomArchived({ roomId: id, archived: true }); await reloadFromMain(); }, archiveRoom.id);
  check('归档后历史房间选择立即移除失效活动房间', await page(id => ![...document.querySelector('#histRoom').options].some(option => option.value === id), archiveRoom.id));
  await page(async id => { await window.api.deleteRoom(id); await reloadFromMain(); }, archiveRoom.id);
  check('删除后归档区域与选择房间立即同步', await page(id => ![...document.querySelector('#histRoom').options].some(option => option.value === id) && !document.querySelector('#archivedRoomList').textContent.includes('Archive search fixture'), archiveRoom.id));
  await page(() => { closeAllModals(); document.querySelector('.project-create').click(); });
  check('项目铅笔新建房间预填当前项目路径', await page(() => !document.querySelector('#roomModal').hidden && document.querySelector('#r_cwd').value === document.querySelector('.room-nav-group[data-group-id^="project:"] .room-nav-project-path').textContent));
  await page(() => { closeAllModals(); document.querySelector('.project-menu').click(); });
  check('项目省略号提供置顶打开重命名归档及移除', await page(() => ['置顶项目', '在资源管理器打开', '重命名项目', '归档当前项目下的房间', '移除项目'].every(label => document.querySelector('#popMenu').textContent.includes(label))));
  await page(() => closePopMenu());

  const warningRoom = persistence.saveRoom({ name: 'Corrupt archive fixture', cwd: persistence.getDataPath() });
  persistence.addMessage(warningRoom.id, { id: 'warning_live', authorType: 'human', text: 'healthy live needle 314', status: 'done', createdAt: Date.now() });
  require('node:fs').writeFileSync(require('node:path').join(persistence.archivesDir(warningRoom.id), 'broken.json'), '{broken');
  await page(async () => {
    await reloadFromMain(); ConversationUI.openSearch();
    const input = document.querySelector('#conversationSearchDialog input'); input.value = 'healthy live needle 314';
    ConversationUI.openSearch();
  });
  check('损坏归档给出可见警告且保留正常会话搜索结果', await waitFor(() =>
    document.querySelector('.conversation-search-results').textContent.includes('归档损坏') &&
    document.querySelector('.conversation-search-result').textContent.includes('healthy live needle 314')));
  await page(() => document.querySelector('#conversationSearchDialog').close());

};
