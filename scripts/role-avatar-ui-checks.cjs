'use strict';
module.exports = async ({ win, persistence, check }) => {
  const page = (fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
  const bots = [persistence.saveBot({ name: 'Role Alpha', cliType: 'claude', role: '主持人', persona: 'Personal instructions', enabled: true }),
    persistence.saveBot({ name: 'Role Beta', cliType: 'codex', role: '审查者', enabled: true })];
  const first = persistence.saveRoom({ name: 'Role One', botIds: bots.map(bot => bot.id), moderatorBotId: bots[0].id });
  const second = persistence.saveRoom({ name: 'Role Two', botIds: bots.map(bot => bot.id), moderatorBotId: bots[0].id });
  const side = persistence.createSideChat(first.id);
  check('host checkbox changes the displayed role immediately and save keeps other rooms/global roles isolated', await page(async (roomId, botId) => {
    closeAllModals(); await reloadFromMain(); await switchRoom(roomId);
    openBotEdit(roomMembers(currentRoom()).find(bot => bot.id === botId));
    document.querySelector('#f_moderator').click();
    const changed = selectedRole() === '主持人' && document.querySelector('#f_rolePreset').value === '主持人';
    await saveBot();
    const roles = roomMembers(currentRoom()).map(bot => bot.role);
    return changed && roles[0] === '协作者' && roles[1] === '主持人';
  }, first.id, bots[1].id) && persistence.listBots().find(bot => bot.id === bots[1].id).role === '审查者'
    && persistence.roomMembers(persistence.listRooms().find(room => room.id === second.id))[0].role === '主持人'
    && persistence.roomMembers(persistence.listRooms().find(room => room.id === side.id))[0].role === '主持人');
  check('role selection sets host checkbox and side-room save only changes its host', await page(async (roomId, botId) => {
    await reloadFromMain(); openBotEdit(roomMembers(state.rooms.find(room => room.id === roomId)).find(bot => bot.id === botId), roomId);
    document.querySelector('#f_rolePreset').value = '主持人'; document.querySelector('#f_rolePreset').dispatchEvent(new Event('change'));
    const checked = document.querySelector('#f_moderator').checked; await saveBot();
    return checked && state.rooms.find(room => room.id === roomId).moderatorBotId === botId;
  }, side.id, bots[1].id) && persistence.listRooms().find(room => room.id === second.id).moderatorBotId === bots[0].id);
  check('avatar has exactly three options and empty text saves the licensed blue whale', await page(async (roomId, botId) => {
    openBotEdit(state.bots.find(bot => bot.id === botId), roomId);
    const select = document.querySelector('#f_avatarType');
    const options = [...select.options].map(option => option.value).join(',') === 'default,text,image';
    select.value = 'text'; document.querySelector('#f_avatarText').value = ''; select.dispatchEvent(new Event('change'));
    const preview = document.querySelector('#f_avatarPreview img')?.getAttribute('src') === 'assets/deepseek.svg' && !document.querySelector('#f_avatarEasterEgg').hidden;
    await saveBot(); return options && preview;
  }, first.id, bots[1].id) && persistence.listBots().find(bot => bot.id === bots[1].id).avatar?.text === '');
  check('custom CLI defaults to image choice; missing and failed images have a safe visible fallback', await page(() => {
    openBotNew(null); populateBotProfile({ cliType: 'custom_' + 'a'.repeat(32) });
    const imageDefault = document.querySelector('#f_avatarType').value === 'image';
    const host = document.createElement('div'); document.body.append(host);
    host.innerHTML = avatarHtml({ name: 'Custom', cliType: 'custom_' + 'a'.repeat(32), avatar: { type: 'image', dataUrl: '' } });
    const emptySafe = !host.querySelector('img') && !!host.textContent.trim();
    host.innerHTML = avatarHtml({ name: 'Custom', cliType: 'codex', avatar: { type: 'image', dataUrl: 'data:image/png;base64,AAAA' } });
    host.querySelector('img').dispatchEvent(new Event('error'));
    const errorSafe = !host.querySelector('img') && !!host.textContent.trim(); host.remove(); closeAllModals();
    return imageDefault && emptySafe && errorSafe;
  }));
};
