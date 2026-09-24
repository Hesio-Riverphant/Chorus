'use strict';

// Runs only inside the isolated Electron smoke app, against its real preload
// and IPC. No real CLI or external skill source is used.
module.exports = async function desktopChecks({ win, persistence, check }) {
  const page = (fn, ...args) => win.webContents.executeJavaScript(
    `(${fn.toString()})(...${JSON.stringify(args)})`);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 100));
  const press = async (keyCode, modifiers = []) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (keyCode === 'Enter') win.webContents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await settle();
  };
  const selectSkill = async () => page(() => {
    hideModal('settingsModal');
    const input = document.querySelector('#input');
    input.focus(); input.value = '/smoke-fixture'; input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#slashBox .mention-item').click();
    input.focus(); input.setSelectionRange(input.value.length, input.value.length);
    return input.value;
  });

  await selectSkill();
  check('技能选择生成蓝色不可编辑整体标签', await page(() => {
    const token = document.querySelector('#input [data-token="skill"]');
    return token && token.contentEditable === 'false' && token.textContent === '/smoke-fixture' &&
      getComputedStyle(token).color !== getComputedStyle(document.querySelector('#input')).color;
  }));
  await press('Backspace');
  check('真实 Backspace 一次删除完整技能标签和分隔空格', await page(() =>
    !document.querySelector('#input [data-token]') && document.querySelector('#input').value.trim() === ''));
  await press('z', ['control']);
  check('撤销恢复完整技能标签', await page(() =>
    document.querySelector('#input [data-token="skill"]')?.textContent === '/smoke-fixture'));
  await page(() => { document.querySelector('#input').setSelectionRange(0, 0); });
  await press('Delete');
  check('真实 Delete 从标签前删除整体', await page(() => !document.querySelector('#input [data-token]')));

  check('粘贴仅保留文本且非文本粘贴不损坏选区', await page(() => {
    const input = document.querySelector('#input');
    input.value = '保留草稿'; input.setSelectionRange(0, 4);
    const empty = new DataTransfer(); empty.setData('text/html', '<img src=x>');
    input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: empty }));
    const preserved = input.value === '保留草稿';
    const plain = new DataTransfer(); plain.setData('text/plain', '第一行\n第二行');
    plain.setData('text/html', '<b>不要解释为HTML</b>');
    input.setSelectionRange(0, input.value.length);
    input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: plain }));
    return preserved && input.value === '第一行\n第二行' && !input.querySelector('b,img');
  }));
  await page(() => {
    const input = document.querySelector('#input'); input.value = '换行'; input.setSelectionRange(2, 2); input.focus();
  });
  await press('Enter', ['shift']);
  check('Shift+Enter 保留可序列化换行', await page(() => document.querySelector('#input').value === '换行\n'));
  check('中文组合期间 Enter 保留草稿且不发送', await page(() => {
    const input = document.querySelector('#input');
    input.value = '中文输入';
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
    const retained = input.value === '中文输入';
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文输入' }));
    return retained;
  }));
  check('成员选择也生成整体标签', await page(() => {
    const input = document.querySelector('#input'); input.value = '@'; input.setSelectionRange(1, 1);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#mentionBox .mention-item').click();
    return !!input.querySelector('[data-token="mention"][contenteditable="false"]');
  }));
  check('房间间草稿隔离且切回恢复标签', await page(async () => {
    const first = state.currentRoomId;
    const next = state.rooms.find((room) => room.id !== first && !room.archivedAt).id;
    const text = document.querySelector('#input').value;
    await switchRoom(next);
    const separate = document.querySelector('#input').value !== text;
    document.querySelector('#input').value = '另一间草稿';
    await switchRoom(first);
    return separate && document.querySelector('#input').value === text && !!document.querySelector('#input [data-token]');
  }));

  const sendRoom = persistence.saveRoom({ name: '无成员发送验收', botIds: [], moderatorBotId: '' });
  await page(async (roomId) => { await reloadFromMain(); await switchRoom(roomId); }, sendRoom.id);
  await selectSkill();
  await page(async () => { await doSend(); });
  await settle();
  check('技能标签经真实 IPC 保存为文本，确认后清空草稿',
    persistence.getMessages(sendRoom.id).some((message) => message.text === '/smoke-fixture') &&
    await page(() => document.querySelector('#input').value === ''));

  const room = persistence.saveRoom({ name: '历史验收' });
  persistence.addMessage(room.id, { id: 'desktop_history', roomId: room.id, authorType: 'human', authorId: 'owner',
    text: '历史测试消息', status: 'done', createdAt: Date.now() });
  await page(async (roomId) => { await reloadFromMain(); await switchRoom(roomId); }, room.id);
  check('房间菜单提供两种归档和历史入口', await page(() => {
    document.querySelector('#roomList .side-item.active .row-menu').click();
    return /归档房间/.test(document.querySelector('#popMenu').textContent) &&
      /归档聊天但不归档房间/.test(document.querySelector('#popMenu').textContent);
  }));
  const waitForArchiveState = async (label, observe) => {
    const started = Date.now(); let last;
    do {
      last = await observe();
      if (last.ok) return true;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() - started < 3000);
    console.error('Archive UI wait failed:', JSON.stringify({ label, elapsedMs: Date.now() - started, ...last }));
    return false;
  };
  const roomView = roomId => page(id => ({
    currentRoomId: state.currentRoomId,
    roomName: document.querySelector('#roomName').textContent,
    exists: state.rooms.some(room => room.id === id),
    archived: !!state.rooms.find(room => room.id === id)?.archivedAt,
    messageCount: document.querySelectorAll('#messages [data-msg-id]').length,
    listed: [...document.querySelectorAll('#roomList .side-item-name')].some(el => el.textContent === '历史验收'),
    historyRow: [...document.querySelectorAll('#archivedRoomList .skill-row')].some(el => el.textContent.includes('历史验收')),
    settingsHidden: document.querySelector('#settingsModal').hidden,
    obsoleteTrashList: !!document.querySelector('#trashList'),
  }), roomId);
  await page(() => {
    [...document.querySelectorAll('#popMenu button')].find(el => el.textContent.includes('归档聊天但不归档房间')).click();
    document.querySelector('#appDialogAccept').click();
  });
  check('通过房间菜单归档聊天，房间保持可用', await waitForArchiveState('archive chat', async () => {
    const view = await roomView(room.id), archiveCount = persistence.listArchives(room.id).length;
    const messageCount = persistence.getMessages(room.id).length;
    return { ok: view.currentRoomId === room.id && view.roomName === '历史验收' && view.listed && !view.archived &&
      view.messageCount === 0 && archiveCount === 1 && messageCount === 0, view, archiveCount, messageCount };
  }));
  check('聊天归档实际落盘', persistence.listArchives(room.id).length === 1 && persistence.getMessages(room.id).length === 0);
  await page(() => {
    document.querySelector('#roomList .side-item.active .row-menu').click();
    [...document.querySelectorAll('#popMenu button')].find(el => el.textContent.trim() === '归档房间').click();
    document.querySelector('#appDialogAccept').click();
  });
  const hidden = await waitForArchiveState('archive room', async () => {
    const view = await roomView(room.id), storedArchived = !!persistence.listRooms().find(item => item.id === room.id)?.archivedAt;
    return { ok: storedArchived && view.archived && !view.listed, storedArchived, view };
  });
  await page(() => document.querySelector('#historyBtn').click());
  const restoreFromHistory = async label => {
    const ready = await waitForArchiveState(label + ' row', async () => {
      const view = await roomView(room.id); return { ok: !view.settingsHidden && view.historyRow, view };
    });
    if (!ready) return false;
    await page(() => {
      const row = [...document.querySelectorAll('#archivedRoomList .skill-row')].find(el => el.textContent.includes('历史验收'));
      [...row.querySelectorAll('button')].find(el => el.textContent.includes('恢复')).click();
    });
    return waitForArchiveState(label + ' restored', async () => {
      const view = await roomView(room.id), stored = persistence.listRooms().find(item => item.id === room.id);
      const archiveCount = persistence.listArchives(room.id).length;
      return { ok: !!stored && !stored.archivedAt && view.exists && !view.archived && view.listed &&
        view.currentRoomId === room.id && view.settingsHidden && archiveCount === 1 && !view.obsoleteTrashList,
        view, storedExists: !!stored, storedArchived: !!stored?.archivedAt, archiveCount };
    });
  };
  const restored = await restoreFromHistory('archived room');
  check('通过菜单归档整个房间，历史页可以恢复', hidden && restored);
  // Legacy deleted records remain reachable through the unified archive list.
  persistence.deleteRoom(room.id);
  await page(async () => { await reloadFromMain(); document.querySelector('#historyBtn').click(); });
  check('旧回收记录并入归档并可连同聊天归档恢复', await restoreFromHistory('deleted room'));

  const ids = await page(async () => {
    const active = state.rooms.filter(room => !room.archivedAt).map(room => room.id);
    for (const roomId of active) await window.api.setRoomArchived({ roomId, archived: true });
    await reloadFromMain(); return active;
  });
  const empty = await page(() => !document.querySelector('#roomList .side-item') && document.querySelector('#actionBtn').disabled);
  await page(() => document.querySelector('#historyBtn').click());
  const listed = await waitForArchiveState('all archived rooms listed', async () => {
    const view = await page(() => ({ count: document.querySelectorAll('#archivedRoomList .skill-row').length,
      settingsHidden: document.querySelector('#settingsModal').hidden }));
    const storedArchived = persistence.listRooms().filter(item => ids.includes(item.id) && item.archivedAt).length;
    return { ok: !view.settingsHidden && view.count === ids.length && storedArchived === ids.length, view, storedArchived, expected: ids.length };
  });
  await page(async roomIds => {
    for (const roomId of roomIds) await window.api.setRoomArchived({ roomId, archived: false });
    await reloadFromMain();
  }, ids);
  const activeAgain = await waitForArchiveState('all rooms restored', async () => {
    const disabled = await page(() => document.querySelector('#actionBtn').disabled);
    const storedActive = persistence.listRooms().filter(item => ids.includes(item.id) && !item.archivedAt).length;
    return { ok: !disabled && storedActive === ids.length, disabled, storedActive, expected: ids.length };
  });
  check('全部房间归档后仍可访问历史并恢复', empty && listed && activeAgain);

  const discovery = require('../src/main/skills/skillDiscovery');
  const successfulScan = discovery.scan;
  discovery.scan = async () => { throw new Error('fixture scan unavailable'); };
  try {
    check('扫描失败显示原因且原生登记仍可见', await page(async () => {
      openSettings('skills');
      await new Promise((resolve) => setTimeout(resolve, 100));
      return document.querySelector('#skillScanSummary').textContent.includes('扫描失败') &&
        document.querySelectorAll('#skillReferences .skill-row').length > 0 &&
        !document.querySelector('#skillImported') && !document.querySelector('#skillsPath');
    }));
  } finally { discovery.scan = successfulScan; }

  await require('./experience-checks.cjs')({ win, persistence, check });
  await require('./experience-flow-checks.cjs')({ win, persistence, check });
  await require('./refinement-checks.cjs')({ win, persistence, check });
  await require('./save-race-checks.cjs')({ win, persistence, check });

  check('零成员且零活跃房间时可新建成员并建立房间', await page(async () => {
    const ids = state.rooms.map((room) => room.id);
    try {
      for (const bot of [...state.bots]) await window.api.deleteBot(bot.id);
      for (const roomId of ids) await window.api.setRoomArchived({ roomId, archived: true });
      await reloadFromMain(); hideModal('settingsModal');
      document.querySelector('#addBot').click();
      if (document.querySelector('#botModal').hidden) return false;
      document.querySelector('#f_name').value = '新成员';
      document.querySelector('#botSaveBtn').click();
      await new Promise((resolve) => setTimeout(resolve, 100));
      document.querySelector('#addRoom').click();
      document.querySelector('#r_name').value = '重新开始';
      const member = document.querySelector('#r_members .member-check');
      member.checked = true; member.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('#roomSaveBtn').click();
      await new Promise((resolve) => setTimeout(resolve, 100));
      return document.querySelector('#roomName').textContent === '重新开始';
    } finally {
      for (const roomId of ids) await window.api.setRoomArchived({ roomId, archived: false });
      await reloadFromMain();
    }
  }));

  for (const [width, height] of [[1180, 840], [880, 600]]) {
    win.setContentSize(width, height); await settle();
    check(`设置固定左下角且页面不横向溢出 ${width}×${height}`, await page(() => {
      hideModal('settingsModal');
      const button = document.querySelector('#settingsBtn').getBoundingClientRect();
      return button.bottom <= innerHeight && button.top > innerHeight - 110 &&
        document.documentElement.scrollWidth <= innerWidth;
    }));
  }
  await page(() => { hideModal('settingsModal'); document.querySelector('#input').value = ''; });
};
