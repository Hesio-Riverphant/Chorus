'use strict';

// Called by the isolated Electron smoke harness; never launches a real CLI.
module.exports = async function experienceChecks({ win, persistence, check }) {
  const page = (fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`).catch(error => { throw new Error(error.message + "\nUI check: " + fn.toString().slice(0,1600)); });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 100));
  const click = async (selector) => {
    const point = await page((sel) => {
      const element = document.querySelector(sel); element.scrollIntoView({ block: 'center' });
      const rect = element.getBoundingClientRect(); return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    }, selector);
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point }); await settle();
  };
  await page(() => { closeAllModals(); openBotEdit(state.bots[0]); }); await settle();
  check('bot modal sets initial focus', await page(() => document.activeElement.id === 'f_name'));
  await click('#f_persona');
  await page(() => { document.querySelector('#f_persona').value = ''; });
  win.webContents.sendInputEvent({ type: 'char', keyCode: 'x' }); await settle();
  check('real click and character input work in persona', await page(() => document.querySelector('#f_persona').value === 'x'));
  await page(() => { window.__dialogResult = null; AppDialog.confirm('focus test').then((value) => { window.__dialogResult = value; }); });
  await click('#appDialogCancel');
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Y' });
  win.webContents.sendInputEvent({ type: 'char', keyCode: 'y' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Y' }); await settle();
  check('in-app confirmation cancel restores persona focus and typing', await page(() =>
    window.__dialogResult === false && document.activeElement.id === 'f_persona' && document.querySelector('#f_persona').value === 'xy'));
  check('role changes placeholder without overwriting user persona', await page(() => {
    const role = document.querySelector('#f_rolePreset');
    role.value = BotProfile.ROLE_PRESETS.at(-1).value; role.dispatchEvent(new Event('change'));
    return document.querySelector('#f_persona').value === 'xy' &&
      document.querySelector('#f_persona').placeholder === BotProfile.getDefaultPersona(role.value);
  }));
  check('自定义角色使用空白人设且保留已填写内容', await page(() => {
    const role = document.querySelector('#f_rolePreset'); role.value = '__custom__';
    document.querySelector('#f_role').value = '主持人'; role.dispatchEvent(new Event('change'));
    return document.querySelector('#f_persona').placeholder === '' &&
      document.querySelector('#f_persona').value === 'xy' &&
      document.querySelector('#f_personaLabel').textContent === '人设' && botFormPayload().customRole;
  }));
  check('provider avatars are actual local SVG images', await page(() =>
    document.querySelector('#f_avatarPreview img')?.getAttribute('src').endsWith('.svg')));
  await page(() => { hideModal('botModal'); });

  const room = persistence.listRooms().find((item) => !item.archivedAt);
  const message = { id: 'msg_experience_source', roomId: room.id, authorType: 'bot', authorId: persistence.listBots()[0].id,
    text: '第一行重复\n第二行重复\n**强调** 和 `代码`', status: 'done', createdAt: Date.now(), annotations: [],
    activities: [{ id: 'act_1', kind: 'tool', name: 'Read', status: 'done', summary: '公开摘要', detail: '公开工具结果' }] };
  message.activities.push({ id: 'act_thinking', kind: 'reasoning', name: 'fixture reasoning', status: 'done', summary: 'fixture summary', detail: 'fixture detail' });
  persistence.addMessage(room.id, message);
  await page(async (id) => { await reloadFromMain(); switchRoom(id); }, room.id);
  check('思考过程显示精简标题并保留可展开详情', await page(() => {
    const activity = document.querySelector('[data-activity-id="act_thinking"]');
    return activity?.querySelector('summary').textContent === '思考 · 已完成' &&
      activity.querySelector('pre').textContent === 'fixture detail' && !activity.open;
  }));
  check('safe markdown and collapsed public activities', await page(() => {
    const row = document.querySelector('[data-msg-id="msg_experience_source"]');
    return row.querySelector('strong')?.textContent === '强调' && row.querySelector('code')?.textContent === '代码' && !row.querySelector('.activities details').open;
  }));
  check('expanded activity survives streaming and message-state refresh', await page(() => {
    const row = document.querySelector('[data-msg-id="msg_experience_source"]');
    row.querySelector('[data-activity-id="act_1"]').open = true;
    const message = messages(state.currentRoomId).find((item) => item.id === 'msg_experience_source');
    renderActivities(row, message.activities);
    refreshBubbleState(state.currentRoomId, message.id);
    const updated = document.querySelector('[data-msg-id="msg_experience_source"]');
    return updated.querySelector('[data-activity-id="act_1"]').open;
  }));
  await page(() => {
    const segment = document.querySelector('[data-msg-id="msg_experience_source"] [data-source-start="6"]');
    const node = segment.firstChild; const range = document.createRange(); range.setStart(node, 3); range.setEnd(node, 5);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
  }); await settle();
  await click('#annotateSelection');
  check('批注说明与选中文本分开展示且输入有标签', await page(() => document.querySelector('.annotation-selection-preview strong')?.textContent === '选中文本' && document.querySelector('.annotation-selection-preview blockquote')?.textContent === '重复' && document.querySelector('label[for="messageEditText"]')?.textContent === '批注内容'));
  if (process.env.AR_UI_EVIDENCE_DIR) {
    const fs = require('node:fs'), path = require('node:path');
    fs.mkdirSync(process.env.AR_UI_EVIDENCE_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.AR_UI_EVIDENCE_DIR, 'annotation.png'), (await win.webContents.capturePage()).toPNG());
  }
  await page(() => { document.querySelector('#messageEditText').value = '第二处重复的批注'; });
  await click('#messageEditSave'); await settle();
  const annotated = persistence.getMessage(room.id, message.id);
  check('annotation anchors second repeated text on second line', annotated.annotations?.some((item) =>
    item.start === 9 && item.end === 11 && item.quote === '重复'));
  check('no native alert/confirm on renderer code path', await page(() =>
    typeof AppDialog.confirm === 'function' && !document.querySelector('#trashList')));
  await page(() => { closeAllModals(); });
};
