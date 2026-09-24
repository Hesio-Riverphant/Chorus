'use strict';

// Delay only persistence responses to exercise real IPC/form lifecycle races.
module.exports = async function saveRaceChecks({ win, persistence, check }) {
  const page = (fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`).catch(error => { throw new Error(error.message + "\nUI check: " + fn.toString().slice(0,1600)); });
  const settle = () => new Promise(resolve => setTimeout(resolve, 120));
  const waitUntil = async predicate => {
    for (let n = 0; n < 40; n++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
    throw new Error('Expected delayed IPC did not start');
  };
  const saveSettings = persistence.saveSettings;
  let releaseSettings;
  persistence.saveSettings = function (patch) {
    const result = saveSettings.call(this, patch);
    return new Promise(resolve => { releaseSettings = () => resolve(result); });
  };
  try {
    await page(() => {
      openSettings('appearance');
      const field = document.querySelector('#appearanceBackground'); field.value = '#dddddd'; field.dispatchEvent(new Event('input'));
      document.querySelector('#settingsSaveBtn').click();
    });
    await waitUntil(() => releaseSettings);
    await page(() => {
      hideModal('settingsModal'); openSettings('appearance');
      const field = document.querySelector('#appearanceBackground'); field.value = '#dce4ea'; field.dispatchEvent(new Event('input'));
    });
    releaseSettings(); await settle();
    check('旧设置保存返回不关闭新表单或覆盖新配色草稿', await page(() => !document.querySelector('#settingsModal').hidden &&
      document.querySelector('#appearanceBackground').value === '#dce4ea' && getComputedStyle(document.body).backgroundColor === 'rgb(220, 228, 234)'));
  } finally { releaseSettings?.(); persistence.saveSettings = saveSettings; }
  await page(async () => { document.querySelector('#appearanceReset').click(); await saveSettings(); });

  const existing = persistence.listBots()[0];
  const originalRoom = persistence.saveRoom({ name: '保存来源房间', botIds: [existing.id], moderatorBotId: existing.id });
  const otherRoom = persistence.saveRoom({ name: '保存期间切换房间', botIds: [existing.id], moderatorBotId: existing.id });
  const saveBot = persistence.saveBot;
  let releaseBot, created;
  persistence.saveBot = function (payload) {
    created = saveBot.call(this, payload);
    return new Promise(resolve => { releaseBot = () => resolve(created); });
  };
  try {
    await page(async id => {
      await reloadFromMain(); await switchRoom(id); openBotNew();
      document.querySelector('#f_name').value = '保存中的新成员'; document.querySelector('#f_moderator').checked = true;
      document.querySelector('#botSaveBtn').click();
    }, originalRoom.id);
    await waitUntil(() => releaseBot);
    await page(async ({ roomId, botId }) => {
      hideModal('botModal'); await switchRoom(roomId); openBotEdit(state.bots.find(bot => bot.id === botId));
      document.querySelector('#f_moderator').checked = false;
    }, { roomId: otherRoom.id, botId: existing.id });
    releaseBot(); await settle();
    const a = persistence.listRooms().find(room => room.id === originalRoom.id);
    const b = persistence.listRooms().find(room => room.id === otherRoom.id);
    check('旧Bot保存归属原房间及主持选择且不关闭新表单', a.botIds.includes(created.id) && a.moderatorBotId === created.id &&
      !b.botIds.includes(created.id) && b.moderatorBotId === existing.id &&
      await page(id => !document.querySelector('#botModal').hidden && state.editingBotId === id, existing.id));
  } finally { releaseBot?.(); persistence.saveBot = saveBot; }
  await page(() => hideModal('botModal'));
};
