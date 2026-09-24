'use strict';

module.exports = async function experienceFlows({ win, persistence, check }) {
  const fs = require('node:fs');
  const path = require('node:path');
  const page = (fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`).catch(error => { throw new Error(error.message + "\nUI check: " + fn.toString().slice(0,1600)); });
  const settle = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms));
  const bots = persistence.listBots().slice(0, 2);
  const room = persistence.saveRoom({ name: '协作设计 · 验收示例', botIds: bots.map((bot) => bot.id), moderatorBotId: bots[0].id });
  const records = [
    { id: 'ux_human_1', authorType: 'human', authorId: 'owner', text: '请一起评审本地房间的交互，先关注稳定性。' },
    { id: 'ux_bot_1', authorType: 'bot', authorId: bots[0].id,
      text: '## 一次清晰的协作\n先把**可恢复的状态**和**不可恢复的删除**说明白，再逐项验证交互。\n\n- 归档保留成员与聊天记录\n- 回溯编辑原消息，分支保留原房间\n- Skill 按来源引用，避免副本漂移\n\n```js\nawait validateRoom();\n```',
      activities: [{ id: 'flow_tool', kind: 'command', name: '命令', status: 'done', summary: '检查项目状态', detail: 'node --check app.js\n检查完成' }] },
    { id: 'ux_human_2', authorType: 'human', authorId: 'owner', text: '继续检查成员配置和工具过程。' },
    { id: 'ux_bot_2', authorType: 'bot', authorId: bots[1]?.id || bots[0].id, text: '工具过程可以展开查看；成员角色、头像和模型计价独立保存。' },
  ];
  records.forEach((record, index) => persistence.addMessage(room.id, { roomId: room.id, status: 'done', createdAt: Date.now() + index, ...record }));
  await page(async (id) => { closeAllModals(); await reloadFromMain(); await switchRoom(id); }, room.id);
  check('运行开始禁用回溯分支，结束立即恢复且请求锁保留', await page((roomId) => {
    const button = document.querySelector('[data-msg-id="ux_human_1"] [title="编辑并回溯"]');
    handleEvent({ kind: 'run_update', roomId, run: { status: 'running', calls: 1, tokens: 0, cost: 0 } });
    const disabled = button.disabled;
    button.dataset.pending = 'true';
    handleEvent({ kind: 'run_update', roomId, run: { status: 'done', calls: 1, tokens: 0, cost: 0 } });
    const locked = button.disabled;
    delete button.dataset.pending; syncMessageActions();
    return disabled && locked && !button.disabled;
  }, room.id));
  await page(() => {
    openBotEdit(state.bots[0]);
    document.querySelector('#f_rolePreset').value = '审查者';
    document.querySelector('#f_rolePreset').dispatchEvent(new Event('change'));
    document.querySelector('#f_persona').value = '';
    document.querySelector('#f_avatarType').value = 'kimi';
    document.querySelector('#f_avatarType').dispatchEvent(new Event('change'));
    document.querySelector('#f_model').value = 'fixture-model';
    document.querySelector('#botSaveBtn').click();
  });
  await settle();
  const saved = persistence.listBots().find((bot) => bot.id === bots[0].id);
  check('Bot角色空人设、固定头像和模型经UI持久化', saved.role === '审查者' && saved.persona === '' &&
    saved.avatar?.provider === 'kimi' && saved.model === 'fixture-model');

  if (bots.length > 1) {
    await page(() => document.querySelector('#botList .bot-item').focus());
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down', modifiers: ['alt'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Down', modifiers: ['alt'] });
    await settle();
    let savedRoom = persistence.listRooms().find((item) => item.id === room.id);
    check('键盘成员排序只改变显示顺序', savedRoom.memberDisplayOrder?.[0] === bots[1].id && savedRoom.botIds[0] === bots[0].id);
    const points = await page(() => [...document.querySelectorAll('#botList .bot-item')].map((item) => {
      const rect = item.getBoundingClientRect(); return { x: Math.round(rect.x + 70), y: Math.round(rect.y + rect.height / 2) };
    }));
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...points[0] });
    await settle(10);
    win.webContents.sendInputEvent({ type: 'mouseMove', ...points[1], y: points[1].y + 9 });
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...points[1], y: points[1].y + 9 });
    await settle();
    savedRoom = persistence.listRooms().find((item) => item.id === room.id);
    check('快速跨行松手结束手势且不会误开Bot编辑', await page(() => !memberOrderInteractionActive(state.currentRoomId) && document.querySelector('#botModal').hidden));
    check('直接鼠标拖动排序持久化且不改变编排顺序', savedRoom.memberDisplayOrder?.[0] === bots[0].id && savedRoom.botIds[0] === bots[0].id);
  }

  await page(() => {
    const row = document.querySelector('[data-msg-id="ux_bot_1"]');
    row.querySelector('.activities details').open = true;
    const msg = messages(state.currentRoomId).find((item) => item.id === 'ux_bot_1');
    renderActivities(row, [...msg.activities, { id: 'next', name: '检查', status: 'running', summary: '进行中', detail: '' }]);
  });
  check('活动流更新保留用户展开状态', await page(() => {
    const row = document.querySelector('[data-msg-id="ux_bot_1"]');
    return row.querySelector('.activities details').open;
  }));

  // Clipboard writer is replaced only at its boundary: keep the user's system
  // clipboard untouched while checking the complete transcript payload.
  check('复制完整对话包含当前房间所有文本和时间', await page(async () => {
    const original = Object.getOwnPropertyDescriptor(navigator.clipboard, 'writeText');
    let copied;
    Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async (value) => { copied = value; } });
    try {
      document.querySelector('[data-msg-id="ux_bot_1"] [title="复制完整对话"]').click();
      await new Promise((resolve) => setTimeout(resolve, 20));
      return copied === transcriptText(state.currentRoomId) && copied.includes('继续检查成员配置') && /\d{4}-\d{2}-\d{2}/.test(copied);
    } finally {
      if (original) Object.defineProperty(navigator.clipboard, 'writeText', original);
      else delete navigator.clipboard.writeText;
    }
  }));

  if (process.env.AR_UI_EVIDENCE_DIR) {
    const dir = path.resolve(process.env.AR_UI_EVIDENCE_DIR); fs.mkdirSync(dir, { recursive: true });
    win.setContentSize(1180, 820); await settle();
    win.webContents.debugger.attach('1.3');
    try {
      await win.webContents.debugger.sendCommand('DOM.enable');
      await win.webContents.debugger.sendCommand('CSS.enable');
      const doc = await win.webContents.debugger.sendCommand('DOM.getDocument');
      const node = await win.webContents.debugger.sendCommand('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '[data-msg-id="ux_human_1"] .bubble-text' });
      const fonts = await win.webContents.debugger.sendCommand('CSS.getPlatformFontsForNode', { nodeId: node.nodeId });
      const layout = await page(() => {
        const row = document.querySelector('[data-msg-id="ux_human_1"]');
        return [...row.querySelectorAll('.bubble,.bubble-text,.foot-row,.message-actions')].map((e) => ({
          className: e.className, height: e.getBoundingClientRect().height, font: getComputedStyle(e).fontFamily,
          whiteSpace: getComputedStyle(e).whiteSpace, margin: getComputedStyle(e).margin,
        }));
      });
      fs.writeFileSync(path.join(dir, 'layout.json'), JSON.stringify({ fonts, layout }, null, 2));
    } finally { win.webContents.debugger.detach(); }
    await page(() => { document.querySelector('#messages').scrollTop = 0; }); await settle();
    fs.writeFileSync(path.join(dir, 'main.png'), (await win.webContents.capturePage()).toPNG());
    await page(() => openSettings('skills')); await settle();
    fs.writeFileSync(path.join(dir, 'skills.png'), (await win.webContents.capturePage()).toPNG());
    await page(() => { hideModal('settingsModal'); openBotEdit(state.bots[0]); }); await settle();
    fs.writeFileSync(path.join(dir, 'bot.png'), (await win.webContents.capturePage()).toPNG());
    await page(() => hideModal('botModal'));
  }

  await page(() => document.querySelector('[data-msg-id="ux_bot_1"] [title="分支到新聊天"]').click());
  await settle();
  check('分支直接执行且无二次确认', await page(() => !AppDialog.isOpen()));
  const fork = persistence.listRooms().find((item) => item.forkedFrom?.messageId === 'ux_bot_1');
  check('UI分支新房间保留此前消息与原房间', !!fork && persistence.getMessages(fork.id).length === 2 && persistence.getMessages(room.id).length === 4);
  await page(async (id) => { await switchRoom(id); document.querySelector('[data-msg-id="ux_human_1"] [title="编辑并回溯"]').click(); }, room.id);
  await page(() => {
    document.querySelector('#messageEditText').value = '修改后的起点';
    document.querySelector('#messageEditSave').click();
  });
  await settle();
  check('回溯仅保存直接执行且无二次确认', await page(() => !AppDialog.isOpen()));
  const rewound = persistence.getMessages(room.id);
  check('UI回溯编辑原消息并丢弃后文，分支保持完整', rewound.length === 1 && rewound[0].text === '修改后的起点' &&
    (!fork || persistence.getMessages(fork.id).length === 2));

  if (fork) {
    await page(async (id) => { await window.api.setRoomArchived({ roomId: id, archived: true }); await reloadFromMain(); openSettings('history'); }, fork.id);
    await settle();
    await page((name) => {
      const row = [...document.querySelectorAll('#archivedRoomList .skill-row')].find((item) => item.textContent.includes(name));
      [...row.querySelectorAll('button')].find((button) => button.textContent === '永久删除').click();
    }, fork.name);
    await page(() => document.querySelector('#appDialogAccept').click()); await settle();
    check('已归档房间可直接永久删除且无额外回收记录', !persistence.listRooms().some((item) => item.id === fork.id) &&
      !persistence.listTrash().some((item) => item.name === fork.name));
  }
  await page(() => { closeAllModals(); });
};
