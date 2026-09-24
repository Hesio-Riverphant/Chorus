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
  check('通过房间菜单归档聊天，房间保持可用', await page(async () => {
    const button = [...document.querySelectorAll('#popMenu button')].find((el) => el.textContent.includes('归档聊天但不归档房间'));
    button.click(); document.querySelector('#appDialogAccept').click(); await new Promise((resolve) => setTimeout(resolve, 150));
    return document.querySelector('#roomName').textContent === '历史验收' &&
      document.querySelectorAll('#messages [data-msg-id]').length === 0;
  }));
  check('聊天归档实际落盘', persistence.listArchives(room.id).length === 1 && persistence.getMessages(room.id).length === 0);
  check('通过菜单归档整个房间，历史页可以恢复', await page(async (roomId) => {
    document.querySelector('#roomList .side-item.active .row-menu').click();
    [...document.querySelectorAll('#popMenu button')].find((el) => el.textContent.trim() === '归档房间').click();
    document.querySelector('#appDialogAccept').click();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const hidden = ![...document.querySelectorAll('#roomList .side-item-name')].some((el) => el.textContent === '历史验收');
    document.querySelector('#historyBtn').click();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const row = [...document.querySelectorAll('#archivedRoomList .skill-row')].find((el) => el.textContent.includes('历史验收'));
    if (!row) return false;
    [...row.querySelectorAll('button')].find((el) => el.textContent.includes('恢复')).click();
    await new Promise((resolve) => setTimeout(resolve, 150));
    return hidden && state.rooms.find((item) => item.id === roomId)?.archivedAt == null;
  }, room.id));
  // Legacy deleted records remain reachable through the unified archive list.
  persistence.deleteRoom(room.id);
  await page(async () => {
    await reloadFromMain(); document.querySelector('#historyBtn').click();
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
  check('旧回收记录并入归档并可连同聊天归档恢复', await page(async (roomId) => {
    const row = [...document.querySelectorAll('#archivedRoomList .skill-row')].find((el) => el.textContent.includes('历史验收'));
    if (!row) return false;
    [...row.querySelectorAll('button')].find((el) => el.textContent.includes('恢复')).click();
    await new Promise((resolve) => setTimeout(resolve, 150));
    return state.rooms.some((item) => item.id === roomId) && (await window.api.listArchives(roomId)).length === 1 &&
      !document.querySelector('#trashList');
  }, room.id));

  check('全部房间归档后仍可访问历史并恢复', await page(async () => {
    const ids = state.rooms.filter((room) => !room.archivedAt).map((room) => room.id);
    for (const roomId of ids) await window.api.setRoomArchived({ roomId, archived: true });
    await reloadFromMain();
    const empty = !document.querySelector('#roomList .side-item') && document.querySelector('#actionBtn').disabled;
    document.querySelector('#historyBtn').click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const listed = document.querySelectorAll('#archivedRoomList .skill-row').length === ids.length;
    for (const roomId of ids) await window.api.setRoomArchived({ roomId, archived: false });
    await reloadFromMain();
    return empty && listed && !document.querySelector('#actionBtn').disabled;
  }));

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
