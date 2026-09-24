'use strict';
module.exports = async function chorusChecks({ win, persistence, check }) {
  const page = (fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
  check('font size accepts 8px and rejects out-of-range input without saving', await page(() => {
    closeAllModals(); openSettings('appearance');
    const input = document.querySelector('#appearanceFontSize'); input.value = '8';
    const valid = AppearanceUI.read()?.fontSize === 8;
    input.value = '7'; const invalid = AppearanceUI.read() === null;
    input.value = '14'; closeAllModals(); return valid && invalid;
  }));
  check('soft budget controls persist through Apply and reopening', await page(async () => {
    closeAllModals(); openSettings('guard');
    document.querySelector('#s_tokenBudget').value = '123'; document.querySelector('#s_costBudget').value = '0.25';
    await saveSettings(false);
    const saved = (await window.api.getInitial()).settings;
    closeAllModals(); openSettings('guard');
    const good = saved.tokenBudgetPerRun === 123 && saved.costBudgetPerRun === 0.25 &&
      document.querySelector('#s_tokenBudget').value === '123' && document.querySelector('#s_costBudget').value === '0.25';
    document.querySelector('#s_tokenBudget').value = '0'; document.querySelector('#s_costBudget').value = '0';
    await saveSettings(false); closeAllModals(); return good;
  }));
  check('skill reference removal completes without confirmation', await page(async () => {
    closeAllModals(); openSettings('skills'); await loadSkillLibrary();
    const rows = document.querySelectorAll('#skillReferences .skill-row');
    if (!rows.length) return false;
    const priorCount = state.skillReferences.length, original = AppDialog.confirm;
    let confirmations = 0; AppDialog.confirm = async () => { confirmations++; return false; };
    try {
      rows[0].querySelector('button').click();
      for (let i = 0; i < 80 && state.skillReferences.length === priorCount; i++) await new Promise(resolve => setTimeout(resolve, 20));
      return confirmations === 0 && state.skillReferences.length === priorCount - 1;
    } finally { AppDialog.confirm = original; closeAllModals(); }
  }));
  const bots = ['Searchable Alpha', 'Searchable Beta'].map(name => persistence.saveBot({ name, cliType: 'claude', enabled: true, model: 'claude-fixture' }));
  const room = persistence.saveRoom({ name: 'Command fixture', cwd: 'D:/room-fixture', botIds: bots.map(bot => bot.id) });
  const native = require('../src/main/nativeCapabilities'), discover = native.discover;
  native.discover = async () => ({ items: [], scannedAt: Date.now() });
  try {
    check('native capability room search filters names and preserves displayed scope until selection', await page(async roomId => {
      await reloadFromMain(); const host = document.createElement('div'); document.body.append(host);
      try {
        await NativeCapabilitiesUI.manage({ host, bots: state.bots, rooms: state.rooms, settings: state.settings, cliProfiles: state.cliProfiles });
        const search = host.querySelector('.native-room-search'); search.value = 'Command fixture'; search.dispatchEvent(new Event('input'));
        const select = host.querySelector('.native-room-choice');
        const matches = [...select.options].filter(option => option.value);
        if (matches.length !== 1 || matches[0].value !== roomId) return false;
        select.value = roomId; select.dispatchEvent(new Event('change'));
        await new Promise(resolve => setTimeout(resolve, 50));
        const nextSearch = host.querySelector('.native-room-search'); nextSearch.value = 'no-such-room'; nextSearch.dispatchEvent(new Event('input'));
        return host.querySelector('.native-room-choice').value === '__choose__' && host.querySelector('.native-selected-member').textContent.includes('Command fixture');
      } finally { NativeCapabilitiesUI.closeManagement(); host.remove(); }
    }, room.id));
  } finally { native.discover = discover; }
  check('model command offers searchable members and opens actual model editor', await page(async roomId => {
    await reloadFromMain();
    const pending = RoomCommands.intercept('/model', roomId, { clearSent() {} });
    const search = document.querySelector('.command-member-dialog input');
    search.value = 'Beta'; search.dispatchEvent(new Event('input'));
    const buttons = [...document.querySelectorAll('.command-member-option')].filter(button => !button.hidden);
    if (buttons.length !== 1 || !buttons[0].textContent.includes('Beta')) return false;
    buttons[0].click(); await pending;
    const result = !document.querySelector('#botModal').hidden && document.querySelector('#f_name').value === 'Searchable Beta';
    const directory = document.querySelector('#botEffectiveCwd');
    document.querySelector('#f_cwd').value = 'D:/member-fixture'; document.querySelector('#f_cwd').dispatchEvent(new Event('input'));
    const cwd = directory.textContent.includes('D:/member-fixture') && getComputedStyle(directory).display !== 'none';
    closeAllModals(); return result && cwd;
  }, room.id));
  check('yolo cancellation leaves member permissions unchanged', await page(async roomId => {
    const original = AppDialog.confirm; let prompt = '';
    AppDialog.confirm = async text => { prompt = text; return false; };
    try {
      const pending = RoomCommands.intercept('/yolo', roomId, { clearSent() {} });
      document.querySelector('.command-member-option').click(); await pending;
      return prompt.includes('共享成员') && document.querySelector('#botModal').hidden;
    } finally { AppDialog.confirm = original; }
  }, room.id) && bots.every(bot => persistence.bots.find(item => item.id === bot.id).permissionMode === bot.permissionMode));
  check('application command help states native command boundary', await page(async roomId => {
    await RoomCommands.intercept('/help', roomId, { clearSent() {} });
    const dialog = document.querySelector('dialog[open]');
    const valid = dialog.textContent.includes('/permissions') && dialog.textContent.includes('原生 CLI');
    dialog.querySelector('button').click(); return valid;
  }, room.id));
  for (const [index, updateModerator] of [true, false].entries()) {
    const bot = bots[index];
    const fresh = persistence.listRooms().find(item => item.id === room.id);
    persistence.saveRoom({ ...fresh, memberCapabilities: { ...fresh.memberCapabilities,
      [bot.id]: { mode: 'selected', mcp: ['old-agent-fixture-tool'], plugins: [] } } });
    check(`changing Agent cannot restore old capability overrides through ${updateModerator ? 'immediate moderator update' : 'later room save'}`, await page(async (roomId, botId, updateModerator) => {
      await reloadFromMain(); closeAllModals();
      openBotEdit(state.bots.find(item => item.id === botId), roomId);
      const cli = document.querySelector('#f_cliType'); cli.value = 'codex'; cli.dispatchEvent(new Event('change'));
      document.querySelector('#f_moderator').checked = updateModerator;
      await ModelPicker.load('codex');
      await saveBot();
      if (!document.querySelector('#botModal').hidden) return false;
      const current = state.rooms.find(item => item.id === roomId);
      if (current.memberCapabilities?.[botId]) return false;
      if (!updateModerator) await window.api.saveRoom({ ...current, name: current.name + ' renamed' });
      const final = await window.api.getInitial(), stored = final.rooms.find(item => item.id === roomId);
      return !stored.memberCapabilities?.[botId] && (!updateModerator || stored.moderatorBotId === botId);
    }, room.id, bot.id, updateModerator));
  }
};
