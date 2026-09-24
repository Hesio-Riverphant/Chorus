'use strict';
const path = require('path'), fs = require('fs'), os = require('os');
const { app, BrowserWindow } = require('electron');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-language-'));
process.env.AR_DATA_DIR = root;
const persistence = require('../src/main/store/persistence');
require('../src/main/modelCatalog').discoverModels = async () => ({ models: [{ id: 'fixture', label: 'fixture' }], notice: '' });
require('../src/main/skills/skillDiscovery').scan = async () => ({ skills: [], roots: [], warnings: [] });
require('../src/main/cliDiscovery').discoverClis = async () => require('../src/main/cliRegistry').listProfiles(persistence.getSettings()).map(item => ({ ...item, enabled: ['claude', 'codex', 'kimi'].includes(item.id), installed: false }));
const { registerIpc } = require('../src/main/ipc');
const watchdog = setTimeout(() => { console.error('Language UI test timed out'); app.exit(2); }, 60000); watchdog.unref();
app.whenReady().then(async () => {
  await persistence.init(app);
  persistence.saveSettings({ enabledCliIds: ['claude', 'codex', 'kimi'], language: 'en' });
  const room = persistence.listRooms()[0];
  persistence.saveRoom({ ...room, name: '中文用户房间', cwd: root });
  const side = persistence.createSideChat(room.id);
  persistence.addMessage(room.id, { id: 'language-human', roomId: room.id, authorType: 'human', text: '设置 发送 当前房间成员', createdAt: Date.now(), status: 'done' });
  persistence.addMessage(room.id, { id: 'language-native', roomId: room.id, authorType: 'bot', authorId: room.botIds[0], text: '原生输出：设置 保存', createdAt: Date.now(), status: 'done', activities: [{ id: 'language-tool', kind: 'tool', status: 'done', name: '中文原生工具', detail: '工具输出：设置' }] });
  persistence.addMessage(room.id, { id: 'language-system', roomId: room.id, authorType: 'system', text: '运行异常已中止：原生错误', createdAt: Date.now(), status: 'done', i18n: { parts: ['运行异常已中止：', ''], values: ['原生错误'] } });
  const win = new BrowserWindow({ show: false, width: 1180, height: 840, webPreferences: { preload: path.join(__dirname, '../src/main/preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false } });
  registerIpc(win, persistence); require('../src/main/workbench').registerWorkbench(win, persistence);
  const errors = []; win.webContents.on('console-message', e => { if (e.level === 'error') errors.push(e.message); });
  await win.loadFile(path.join(__dirname, '../src/renderer/index.html'));
  await new Promise(resolve => setTimeout(resolve, 700));
  const result = await win.webContents.executeJavaScript(`(async () => {
    const out = {}, wait = () => new Promise(r => setTimeout(r, 80));
    const residual = () => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT), result = [];
      while(walker.nextNode()) { const n = walker.currentNode, p=n.parentElement;
        if (p.closest('script,style,[contenteditable],textarea,option[value="zh-CN"],.sk-source,.sk-desc,.sk-name,.side-item-name,.bubble,.sys-bubble,.activities,.msg-name,.member-chip,.side-chat-member,.wb-tab-select,#sideChatTitle,#sideChatSelect,#sideChatMessages,#roomName,#workbenchMainPreview')) continue;
        if (p.getClientRects().length && /[\\u3400-\\u9fff]/.test(n.data)) result.push(p.tagName + ':' + p.id + ':' + n.data.trim()); }
      return result;
    };
    out.startLanguage = document.documentElement.lang; out.main = residual();
    out.systemNotice = document.querySelector('[data-msg-id="language-system"] .sys-bubble').textContent.includes('Execution stopped after an error: 原生错误');
    try { await window.api.saveBot({ name: '', cliType: 'claude' }); out.englishIpcError = false; }
    catch (error) { out.englishIpcError = error.message.includes('Enter a member name') && !/[\\u3400-\\u9fff]/.test(error.message); }
    out.sourceMessages = messages(state.currentRoomId).map(item => item.text);
    const renderedBefore = ['language-human','language-native'].map(id => document.querySelector('[data-msg-id="' + id + '"] .bubble-text').textContent);
    composer.value = '主草稿 设置 发送';
    SideChatUI.open(state.rooms.find(item => item.parentRoomId === state.currentRoomId).id);
    SideChatUI.composer.value = '侧聊草稿 保存 设置';
    const mainDraft = composer.value, sideDraft = SideChatUI.composer.value, roomId = state.currentRoomId, sideId = SideChatUI.getRoom().id;
    const terminalId = await WorkbenchUI.openTerminal('bottom');
    const terminalStatus = document.querySelector('.wb-terminal-status').textContent;
    openSettings();
    for (const tab of ['general','bots','cli','appearance','guard','pricing','skills','extensions','history','data','about']) {
      switchSettingsTab(tab); await wait(); out[tab] = residual();
    }
    openBotNew(); await wait(); out.bot = residual(); hideModal('botModal');
    openSettings('general'); document.querySelector('#s_language').value = 'zh-CN'; await saveSettings(false); await wait();
    out.chineseApplied = document.documentElement.lang === 'zh-CN' && !document.querySelector('#settingsModal').hidden && document.querySelector('.settings-tab.active').dataset.tab === 'general';
    out.chinese = residual();
    document.querySelector('#s_language').value = 'en'; await saveSettings(false); await wait();
    out.englishApplied = document.documentElement.lang === 'en' && !document.querySelector('#settingsModal').hidden;
    out.afterSwitch = residual();
    out.draftsPreserved = composer.value === mainDraft && SideChatUI.composer.value === sideDraft;
    out.roomPreserved = state.currentRoomId === roomId && SideChatUI.getRoom().id === sideId;
    out.terminalPreserved = !!document.querySelector('[data-tab-id="' + terminalId + '"]') && document.querySelector('.wb-terminal-status').textContent === terminalStatus;
    out.contentPreserved = JSON.stringify(out.sourceMessages) === JSON.stringify(messages(state.currentRoomId).map(item => item.text));
    out.messageDOMPreserved = JSON.stringify(renderedBefore) === JSON.stringify(['language-human','language-native'].map(id => document.querySelector('[data-msg-id="' + id + '"] .bubble-text').textContent));
    out.actualRendered = [document.querySelector('[data-msg-id="language-human"] .bubble-text').textContent, document.querySelector('[data-msg-id="language-native"] .bubble-text').textContent];
    out.nativeToolPreserved = document.querySelector('[data-activity-id="language-tool"] pre').textContent === '工具输出：设置';
    await saveSettings(true); out.saveClosed = document.querySelector('#settingsModal').hidden;
    out.persistedLanguage = (await window.api.getInitial()).settings.language;
    await WorkbenchUI.closeTab(terminalId);
    out.missing = I18n.getMissing();
    return out;
  })()`);
  for (const [width, height] of [[1180, 840], [880, 600]]) {
    win.setSize(width, height);
    await new Promise(resolve => setTimeout(resolve, 150));
    const geometry = await win.webContents.executeJavaScript(`(async () => {
      const report = {}, wait = () => new Promise(resolve => setTimeout(resolve, 60));
      const fits = element => { const r = element.getBoundingClientRect(); return r.left >= -1 && r.right <= innerWidth + 1 && r.top >= -1 && r.bottom <= innerHeight + 1 && element.scrollWidth <= element.clientWidth + 2; };
      openSettings('general'); await wait();
      report.settings = fits(document.querySelector('#settingsModal .settings-modal'));
      report.applyVisible = fits(document.querySelector('#settingsApplyBtn'));
      openBotNew(); await wait(); report.member = fits(document.querySelector('#botModal .modal'));
      report.memberSaveVisible = fits(document.querySelector('#botSaveBtn')); hideModal('botModal'); hideModal('settingsModal');
      const pending = RoomCommands.intercept('/model', state.currentRoomId, { clearSent() {} }); await wait();
      report.command = fits(document.querySelector('.command-member-dialog'));
      document.querySelector('.command-member-dialog .ghost-btn').click(); await pending;
      report.viewport = document.documentElement.scrollWidth <= innerWidth + 2;
      return report;
    })()`);
    result['layout' + width] = Object.values(geometry).every(Boolean);
    console.log('layout', width, height, JSON.stringify(geometry));
  }
  await win.reload();
  await new Promise(resolve => setTimeout(resolve, 500));
  result.restartLanguage = await win.webContents.executeJavaScript(`document.documentElement.lang === 'en' && document.querySelector('#settingsBtn').textContent.includes('Settings')`);
  const ignored = new Set(['sourceMessages', 'chinese', 'actualRendered']);
  const failures = Object.entries(result).filter(([key, value]) => !ignored.has(key) && (Array.isArray(value) ? value.length > 0 : typeof value === 'boolean' ? !value : ['startLanguage', 'persistedLanguage'].includes(key) && value !== 'en'));
  console.log(JSON.stringify({ result, errors, failures }, null, 2));
  clearTimeout(watchdog); await require('../src/main/orchestrator/orchestrator').stopAll(); persistence.flushSync();
  if (persistence.timer) clearInterval(persistence.timer);
  win.destroy(); fs.rmSync(root, { recursive: true, force: true }); app.exit(errors.length || failures.length ? 1 : 0);
}).catch(error => { console.error(error); app.exit(1); });
