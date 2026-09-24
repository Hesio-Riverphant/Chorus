'use strict';

// Called only by the isolated Electron acceptance harness after app startup.
// Renderer fixtures are synthetic; no model request or native configuration is used.
module.exports = async function checkProductionInterface(win, check) {
  const evaluate = fn => win.webContents.executeJavaScript(`(${fn.toString()})()`);
  const waitFor = async fn => {
    for (let attempt = 0; attempt < 60; attempt++) {
      if (await evaluate(fn)) return true;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return false;
  };
  await evaluate(() => {
    const room = currentRoom();
    const createdAt = Date.now();
    state.dataByRoom[room.id] = [
      { id: 'ui-user-1', roomId: room.id, authorType: 'human', createdAt, status: 'done', text: '验收搜索 Alpha needle', roundRun: { startedAt: createdAt - 61000, endedAt: createdAt, status: 'done' } },
      { id: 'ui-reply-1', roomId: room.id, authorType: 'bot', createdAt, roundId: 'ui-user-1', status: 'done', text: '结论必须始终可见', activities: [{ id: 'progress-1', kind: 'reasoning', phase: 'commentary', status: 'done', detail: '这是执行过程的文字输出', order: 0 }, { id: 'tool-1', order: 1, name: 'synthetic tool', kind: 'tool', status: 'done', detail: '过程详情' }] },
      { id: 'ui-user-2', roomId: room.id, authorType: 'human', createdAt: createdAt + 1, status: 'done', text: '第二次用户输入' },
    ]; renderMessages();
  });
  check('user round shows persisted wall time and both input nodes', await evaluate(() =>
    document.querySelector('[data-round-timing="ui-user-1"]').textContent.includes('01:01') && document.querySelectorAll('#messages .input-node').length === 2));
  check('round arrow folds the process and restores independent tool state while preserving the final answer', await evaluate(() => {
    const toggle = document.querySelector('[data-round-timing="ui-user-1"]'), row = document.querySelector('[data-msg-id="ui-reply-1"]');
    const tool = row.querySelector('[data-activity-id="tool-1"]'); tool.open = true;
    const collapsed = getComputedStyle(row.querySelector('.activities')).display === 'none';
    toggle.click(); const expanded = getComputedStyle(row.querySelector('.activities')).display !== 'none';
    toggle.click(); const hidden = tool.getBoundingClientRect().height === 0; toggle.click(); return collapsed && expanded && hidden && tool.open && tool.getBoundingClientRect().height > 0 && row.querySelector('.bubble-text').getBoundingClientRect().height > 0;
  }));
  check('process timeline precedes final answer and uses reliable action icons', await evaluate(() => {
    const row = document.querySelector('[data-msg-id="ui-reply-1"]');
    return !!(row.querySelector('.activities').compareDocumentPosition(row.querySelector('.bubble')) & Node.DOCUMENT_POSITION_FOLLOWING) && !!row.querySelector('[aria-label="分支到新聊天"] svg');
  }));
  await evaluate(() => {
    ConversationUI.openSearch();
    const input = document.querySelector('#conversationSearchDialog input'); input.value = '执行过程的文字';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  check('search finds public process output and expands its own round on jump', await waitFor(() => {
    const row = document.querySelector('[data-msg-id="ui-reply-1"]');
    return !document.querySelector('#conversationSearchDialog').open && document.activeElement === row &&
      getComputedStyle(row.querySelector('.activities')).display !== 'none';
  }));
  await evaluate(() => document.querySelector('[data-round-timing="ui-user-1"]').click());
  check('running process stays visible, final permits collapse and setting disables auto collapse', await evaluate(() => {
    const roomId = state.currentRoomId, wrap = document.querySelector('#messages');
    const message = messages(roomId).find(item => item.id === 'ui-reply-1');
    message.status = 'streaming'; message.finalAnswer = false; ConversationUI.decorate(wrap, roomId);
    const toggle = wrap.querySelector('[data-round-timing="ui-user-1"]'), row = wrap.querySelector('[data-msg-id="ui-reply-1"]');
    const running = toggle.disabled && getComputedStyle(row.querySelector('.activities')).display !== 'none';
    message.finalAnswer = true; ConversationUI.decorate(wrap, roomId);
    const final = !toggle.disabled && getComputedStyle(row.querySelector('.activities')).display === 'none';
    message.status = 'done';
    // Use a fresh round so a deliberate per-round choice does not override the preference.
    const human = messages(roomId).find(item => item.id === 'ui-user-2');
    message.roundId = human.id; const saved = state.settings.autoCollapseProcess;
    state.settings.autoCollapseProcess = false; ConversationUI.decorate(wrap, roomId);
    const manual = getComputedStyle(row.querySelector('.activities')).display !== 'none';
    state.settings.autoCollapseProcess = saved; message.roundId = 'ui-user-1'; ConversationUI.decorate(wrap, roomId);
    return running && final && manual;
  }));
  await evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })));
  check('Ctrl+K opens accessible search dialog', await evaluate(() => document.querySelector('#conversationSearchDialog').open));
  await evaluate(() => {
    const input = document.querySelector('#conversationSearchDialog input'); input.value = 'Alpha needle';
    ConversationUI.openSearch();
  });
  await waitFor(() => !!document.querySelector('.conversation-search-result'));
  await evaluate(() => document.querySelector('.conversation-search-result').click());
  await evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  check('search result selects exact message and closes search', await evaluate(() =>
    !document.querySelector('#conversationSearchDialog').open && document.querySelector('[data-msg-id="ui-user-1"]').classList.contains('message-search-target')));
  await evaluate(() => {
    ConversationUI.openSearch();
    const input = document.querySelector('#conversationSearchDialog input'); input.value = '第二次用户';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  await evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  check('immediate Enter searches the newest query instead of stale debounced results', await waitFor(() =>
    document.activeElement?.dataset.msgId === 'ui-user-2'));
  await evaluate(() => document.querySelectorAll('#messages .input-node')[1].click());
  await evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  check('input node jumps to corresponding user message', await evaluate(() => document.activeElement?.dataset.msgId === 'ui-user-2'));
  check('maximize action lives in right workbench header', await evaluate(() => !!document.querySelector('#workbenchDock > .wb-tab-header #workbenchMaximize')));
  await evaluate(() => { window.WorkbenchUI.toggleDock(true); document.querySelector('#workbenchMaximize').click(); document.querySelector('#workbenchPreviewToggle').click(); });
  check('maximized workspace can show and collapse main conversation', await evaluate(() => {
    const main = document.getElementById('main'), shown = main.classList.contains('wb-preview-open');
    document.querySelector('#workbenchPreviewClose').click(); const closed = !main.classList.contains('wb-preview-open');
    document.querySelector('#workbenchMaximize').click(); return shown && closed;
  }));
  check('project rename affordance and requested archive copy are present', await evaluate(() => {
    openRoomMenu(document.querySelector('#roomName'), currentRoom());
    const ok = document.querySelector('#popMenu').textContent.includes('归档聊天但不归档房间') && !!document.querySelector('.project-create') && !!document.querySelector('.project-menu');
    closePopMenu(); return ok;
  }));
  const originalCwd = await evaluate(() => currentRoom().cwd);
  await evaluate(() => {
    document.querySelector('.project-menu').click();
    [...document.querySelectorAll('#popMenu button')].find(button => button.textContent === '重命名项目').click();
    document.querySelector('#messageEditText').value = 'Production project';
    document.querySelector('#messageEditText').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  check('project rename accepts Enter and updates the real sidebar', await waitFor(() => document.querySelector('.room-nav-group-label').textContent === 'Production project'));
  check('project rename persists through IPC without changing cwd', await evaluate(async () => {
    const data = await window.api.getInitial();
    return Object.values(data.settings.projectDisplayNames || {}).includes('Production project');
  }) && await evaluate(() => currentRoom().cwd) === originalCwd);
  await evaluate(() => {
    const side = SideChatUI.getRoom();
    state.dataByRoom[side.id] = [{ id: 'ui-side-user', roomId: side.id, authorType: 'human', text: 'SideSearch needle', status: 'done', createdAt: Date.now() }];
    SideChatUI.refreshMessages(side.id); ConversationUI.openSearch();
    const input = document.querySelector('#conversationSearchDialog input'); input.value = 'SideSearch';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  await evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  check('search jumps into the exact side conversation and exposes its input node', await waitFor(() =>
    document.activeElement?.dataset.msgId === 'ui-side-user' && document.querySelector('#sideChatMessages .input-node')));
  await evaluate(() => document.querySelector('#sideChatMessages .input-node').click());
  await evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  check('side conversation input node selects its own message', await evaluate(() => document.activeElement?.dataset.msgId === 'ui-side-user'));
  check('tool-only completed round folds all activities, retains final and restores tool expansion', await evaluate(() => {
    const room = currentRoom(), now = Date.now();
    state.dataByRoom[room.id] = [
      { id: 'tool-user', authorType: 'human', roomId: room.id, text: 'Read', status: 'done', createdAt: now, roundRun: { startedAt: now - 1000, endedAt: now, status: 'done' } },
      { id: 'tool-answer', authorType: 'bot', roomId: room.id, roundId: 'tool-user', text: 'Final', status: 'done', createdAt: now,
        activities: [{ id: 'only-tool', kind: 'tool', name: 'Read', detail: 'Actual event', status: 'done' }] },
    ]; renderMessages();
    const toggle = document.querySelector('[data-round-timing="tool-user"]'), row = document.querySelector('[data-msg-id="tool-answer"]');
    if (toggle.disabled) return false;
    if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
    const tool = row.querySelector('details'); tool.open = true; toggle.click();
    const hidden = tool.getBoundingClientRect().height === 0 && row.querySelector('.bubble-text').getBoundingClientRect().height > 0;
    toggle.click(); return hidden && tool.open && tool.getBoundingClientRect().height > 0;
  }));
  const [width, height] = win.getSize(); win.setSize(950, 760);
  await evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  check('split workspace fits a narrower desktop window without horizontal document overflow', await evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  win.setSize(width, height);
  win.webContents.debugger.attach('1.3');
  try {
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    check('reduced motion disables transitions in real renderer', await evaluate(() => getComputedStyle(document.querySelector('#actionBtn')).transitionDuration === '0s'));
  } finally { win.webContents.debugger.detach(); }
};
