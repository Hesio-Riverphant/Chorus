'use strict';
const I18n = require('../shared/i18n');

const fs = require('fs');
const path = require('path');
const { ipcMain, dialog, shell } = require('electron');
const orchestrator = require('./orchestrator/orchestrator');
const scanner = require('./skills/skillScanner');
const discovery = require('./skills/skillDiscovery');
const references = require('./skills/skillReferences');
const { normalizeAvatar, MAX_AVATAR_BYTES } = require('../shared/botProfile');
const connectionTest = require('./connectionTest');
const { discoverModels } = require('./modelCatalog');
const cliRegistry = require('./cliRegistry');
const { discoverClis } = require('./cliDiscovery');
const nativeCapabilities = require('./nativeCapabilities');
const { contextUsage } = require('./contextUsage');

function registerIpc(win, persistence) {
  const projectRoot = path.resolve(__dirname, '..', '..');
  nativeCapabilities.configureStorage(persistence.getDataPath());
  let skillCandidates = new Set();
  let skillCandidateDetails = new Map(), skillCandidateOwners = {};
  const scanOwners = (owners, settings = persistence.getSettings()) => {
    if (owners === undefined) return {};
    if (!owners || typeof owners !== 'object' || Array.isArray(owners) || Object.keys(owners).length > 24) throw new Error(I18n.t('技能来源归属无效'));
    const valid = new Set(cliRegistry.listProfiles(settings).map(profile => profile.id));
    return Object.fromEntries(Object.entries(owners).map(([root, cli]) => {
      if (!path.isAbsolute(root) || root.includes('\0') || !valid.has(cli)) throw new Error(I18n.t('技能来源目录或 Agent 归属无效'));
      return [path.resolve(root), cli];
    }));
  };
  const scanRoots = (roots) => {
    if (roots === undefined) return [];
    if (!Array.isArray(roots) || roots.length > 24 || roots.some((root) =>
      typeof root !== 'string' || !path.isAbsolute(root) || root.includes('\0'))) {
      throw new Error(I18n.t('技能扫描目录须为绝对路径，最多 24 个'));
    }
    return [...new Set(roots.map((root) => path.resolve(root)))];
  };
  const activeRoom = (roomId) => {
    const room = persistence.listRooms().find((r) => r.id === roomId);
    if (!room) throw new Error(I18n.t('房间不存在'));
    if (room.archivedAt) throw new Error(I18n.t('请先恢复归档房间，再继续对话'));
    return room;
  };
  const idleRoom = (roomId) => {
    if (orchestrator.isBusy(roomId)) throw new Error(I18n.t('房间正在运行，请先停止再修改配置或记录'));
  };
  const idleBot = (botId) => {
    for (const room of persistence.listRooms()) {
      if (!room.memberProfiles && (room.botIds || []).includes(botId)) idleRoom(room.id);
    }
  };
  const mutations = new Set(['room:save', 'room:delete', 'room:clear', 'room:archive',
    'archive:create', 'archive:restore', 'message:delete', 'room:rewind', 'room:fork',
    'message:annotate', 'message:removeAnnotation']);
  // Validate path components before they reach filesystem-backed stores.
  const id = (value) => {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
      throw new Error(I18n.t('无效的记录标识'));
    }
  };
  const handle = (channel, fn) => ipcMain.handle(channel, (event, payload) => {
    if (event.sender !== win.webContents ||
        (event.senderFrame && event.senderFrame !== win.webContents.mainFrame)) {
      throw new Error(I18n.t('请求来源无效'));
    }
    if (payload && typeof payload === 'object') {
      for (const key of ['id', 'roomId', 'messageId', 'archiveId', 'annotationId', 'parentRoomId', 'ownerRoomId']) {
        if (payload[key] != null && payload[key] !== '') id(payload[key]);
      }
    } else if (/^(room:(delete|clear|export)|bot:delete|archive:(list|create)|trash:(restore|purge)|chat:stop|skills:referenceRemove)$/.test(channel)) {
      id(payload);
    }
    if (mutations.has(channel)) idleRoom(typeof payload === 'string' ? payload : payload.roomId || payload.id);
    if (channel === 'room:saveMember') idleRoom(payload.roomId);
    if (channel === 'bot:save') idleBot(payload.id);
    if (channel === 'bot:delete') idleBot(payload);
    if (channel === 'settings:save' && orchestrator.getActiveRuns().length) {
      throw new Error(I18n.t('请先停止所有房间，再修改全局设置'));
    }
    return fn(event, payload);
  });
  orchestrator.setEmitter((data) => {
    if (win && !win.isDestroyed()) win.webContents.send('room:event', data);
  });
  handle('cli:list', () => {
    const settings = persistence.getSettings();
    const enabled = new Set(cliRegistry.resolveEnabledCliIds(settings, persistence.listBots()));
    return cliRegistry.listProfiles(settings).map(profile => ({ ...profile, enabled: enabled.has(profile.id) }));
  });
  handle('cli:discover', () => discoverClis(persistence.getSettings(), { bots: persistence.listBots() }));
  handle('native:discover', (_event, payload) => {
    const room = persistence.listRooms().find(item => item.id === payload.roomId);
    return nativeCapabilities.discover(payload.cliType, payload.cwd || room?.cwd || persistence.getSettings().defaultCwd || projectRoot, { refresh: payload.refresh === true });
  });
  handle('room:context', (_event, roomId) => {
    id(roomId);
    const room = activeRoom(roomId);
    const members = persistence.roomMembers(room);
    const settings = persistence.getSettings();
    return members.map(bot => contextUsage(room, bot, members, persistence.getMessages(roomId), settings.catchupMessages ?? 20, settings.historyTokenBudget));
  });
  handle('bot:models', (_event, request) => discoverModels(typeof request === 'string' ? request : request?.cliType,
    { bots: persistence.listBots(), settings: persistence.getSettings(), refresh: request?.refresh === true }));
  handle('bot:hideModelCandidate', (_event, payload) => {
    const settings = persistence.getSettings();
    if (!payload || !cliRegistry.findProfile(payload.cliType, settings) || !require('../shared/botProfile').isModelIdentifier(payload.model)) throw new Error(I18n.t('模型候选无效'));
    const entries = Array.isArray(settings.hiddenModelCandidates) ? settings.hiddenModelCandidates : [];
    const hiddenModelCandidates = [...entries.filter(item => item.cliType !== payload.cliType || item.model !== payload.model),
      { cliType: payload.cliType, model: payload.model }].slice(-256);
    persistence.saveSettings({ hiddenModelCandidates });
    return { ok: true };
  });

  handle('app:getInitial', () => ({ ...persistence.getInitial(),
    appInfo: { version: require('../../package.json').version, executable: process.execPath, packaged: !!require('electron').app?.isPackaged },
    skillsPath: persistence.getSkillsDir(), defaultCwd: projectRoot,
    pendingInputs: orchestrator.getPendingInputs?.() || [], activeRuns: orchestrator.getActiveRuns() }));

  handle('room:saveMember', (_event, payload) => persistence.saveRoomMember(payload.roomId, payload.bot));
  handle('bot:save', (_event, bot) => persistence.saveBot(bot));
  handle('bot:delete', (_event, botId) => persistence.deleteBot(botId));
  handle('bot:testConnection', (_event, payload) => connectionTest.test(payload, persistence.getSettings()));
  handle('bot:cancelConnectionTest', (_event, payload) => connectionTest.cancel(payload));
  handle('chat:respondInput', (_event, payload) => orchestrator.respondInput(payload));

  handle('room:save', (_event, room) => {
    const current = persistence.listRooms().find((item) => item.id === room.id);
    if (current && ((Object.hasOwn(room, 'cwd') && room.cwd !== current.cwd) || Object.hasOwn(room, 'botIds'))) {
      for (const child of persistence.listRooms().filter((item) => item.parentRoomId === current.id)) idleRoom(child.id);
    }
    return persistence.saveRoom(room);
  });
  handle('project:rooms', (_event, payload) => {
    if (!payload || !['archive', 'delete'].includes(payload.action) || !Array.isArray(payload.roomIds)
      || !payload.roomIds.length || payload.roomIds.length > 10000) throw new Error(I18n.t('项目操作无效'));
    const ids = [...new Set(payload.roomIds)];
    for (const roomId of ids) { id(roomId); idleRoom(roomId); if (!persistence.listRooms().some(room => room.id === roomId)) throw new Error(I18n.t('房间已变化，请重试')); }
    if (payload.action === 'archive') return persistence.archiveRooms(ids);
    for (const roomId of ids) persistence.permanentDeleteRoom(roomId);
    return { count: ids.length };
  });
  handle('room:pin', (_event, payload) => persistence.setRoomPinned(payload.roomId, payload.pinned));
  handle('navigation:save', (_event, patch) => persistence.saveNavigation(patch));
  handle('room:rename', (_event, payload) => persistence.renameRoom(payload.roomId, payload.name));
  handle('room:sideChat', (_event, payload) => {
    activeRoom(payload.roomId);
    return persistence.createSideChat(payload.roomId);
  });
  handle('room:delete', (_event, roomId) => persistence.permanentDeleteRoom(roomId));
  handle('room:displayOrder', (_event, payload) =>
    persistence.setMemberDisplayOrder(payload.roomId, payload.ids));
  handle('room:rewind', (_event, payload) => {
    activeRoom(payload.roomId);
    return persistence.rewindRoom(payload.roomId, payload.messageId, payload.text);
  });
  handle('room:fork', (_event, payload) => persistence.forkRoomAt(payload.roomId, payload.messageId));
  handle('message:annotate', (_event, payload) =>
    persistence.addAnnotation(payload.roomId, payload.messageId, payload));
  handle('message:removeAnnotation', (_event, payload) =>
    persistence.removeAnnotation(payload.roomId, payload.messageId, payload.annotationId));
  handle('room:archive', (_event, payload) => {
    if (!payload || typeof payload.archived !== 'boolean') throw new Error(I18n.t('房间归档状态无效'));
    return persistence.setRoomArchived(payload.roomId, payload.archived);
  });

  handle('trash:list', () => persistence.listTrash());
  handle('trash:restore', (_event, key) => persistence.restoreTrash(key));
  handle('trash:purge', (_event, key) => persistence.purgeTrash(key));

  // Per-room history: archive the live transcript, list / view / restore /
  // delete archives, delete a single message, clear the live transcript.
  let archiveSearchController, archiveSearchTask = Promise.resolve();
  handle('archive:cancelSearch', () => { archiveSearchController?.abort(); });
  handle('archive:search', async (_event, query) => {
    archiveSearchController?.abort();
    const controller = new AbortController(); archiveSearchController = controller;
    const previous = archiveSearchTask;
    const task = (async () => {
      await previous.catch(() => {});
      if (controller.signal.aborted) return { hits: [], warnings: [], cancelled: true };
      return persistence.searchArchives(query, 100, controller.signal);
    })();
    archiveSearchTask = task;
    return task.catch(error => {
      if (error.name === 'AbortError') return { hits: [], warnings: [], cancelled: true };
      throw error;
    });
  });
  handle('archive:list', (_event, roomId) => persistence.listArchives(roomId));
  handle('archive:create', (_event, roomId) => persistence.archiveCurrent(roomId));
  handle('archive:get', (_event, payload) =>
    persistence.getArchive(payload.roomId, payload.archiveId));
  handle('archive:restore', (_event, payload) =>
    persistence.restoreArchive(payload.roomId, payload.archiveId));
  handle('archive:delete', (_event, payload) =>
    persistence.deleteArchive(payload.roomId, payload.archiveId));
  handle('message:delete', (_event, payload) =>
    persistence.deleteMessage(payload.roomId, payload.messageId));
  handle('room:clear', (_event, roomId) => persistence.clearRoom(roomId));

  // Export a room's live transcript to a user-chosen JSON file.
  handle('room:export', async (_event, roomId) => {
    const room = persistence.listRooms().find((r) => r.id === roomId);
    const res = await dialog.showSaveDialog(win, {
      title: I18n.t('导出房间记录'),
      defaultPath: `${(room ? room.name : 'room').replace(/[\\/:*?"<>|]/g, '_')}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (res.canceled || !res.filePath) return { ok: false };
    const payload = {
      room: room || { id: roomId },
      exportedAt: Date.now(),
      messages: persistence.getMessages(roomId),
    };
    fs.writeFileSync(res.filePath, JSON.stringify(payload, null, 2), 'utf8');
    return { ok: true, path: res.filePath };
  });

  handle('settings:save', (_event, settings) => {
    if (Object.hasOwn(settings, 'skillScanRoots')) {
      settings = { ...settings, skillScanRoots: scanRoots(settings.skillScanRoots) };
    }
    if (Object.hasOwn(settings, 'skillScanOwners')) settings = { ...settings,
      skillScanOwners: scanOwners(settings.skillScanOwners, { ...persistence.getSettings(), ...settings }) };
    return persistence.saveSettings(settings);
  });

  // Scan metadata and register source references; source files remain external.
  const discover = async (payload = {}) => {
    const settings = persistence.getSettings();
    const enabled = cliRegistry.resolveEnabledCliIds(settings, persistence.listBots());
    const categories = cliRegistry.listProfiles(settings).filter(profile => enabled.includes(profile.id)).map(({ id, label }) => ({ id, label }));
    if (payload.category != null && !['other', ...enabled].includes(payload.category)) throw new Error(I18n.t('请先在 Agent 接入中启用此技能来源'));
    const owners = scanOwners(payload.owners === undefined ? settings.skillScanOwners : payload.owners);
    const options = { category: payload.category || 'all', categories: enabled, owners,
      cwd: payload.cwd || settings.defaultCwd || projectRoot,
      roots: scanRoots(payload.roots === undefined ? persistence.getSettings().skillScanRoots : payload.roots),
      skillsDir: persistence.getSkillsDir() };
    if (payload.addedRoot) {
      const root = scanRoots([payload.addedRoot])[0];
      if (!options.roots.includes(root)) throw new Error(I18n.t('请先添加此来源目录'));
      const scope = scanner.sourceScope(root, owners);
      options.category = scope.nativeCliTypes?.includes(options.category) ? options.category : scope.nativeCliTypes?.find(id => enabled.includes(id)) || scope.category;
      if (!['other', ...enabled].includes(options.category)) throw new Error(I18n.t('请先启用此目录所属 Agent，再添加来源'));
    }
    const result = await discovery.scan(options);
    skillCandidates = new Set(result.skills.map((skill) => path.resolve(skill.sourcePath)));
    skillCandidateDetails = new Map(result.skills.map(skill => [path.resolve(skill.sourcePath), skill]));
    skillCandidateOwners = owners;
    return { ...result, categories, sourceRoots: options.roots.map(root => ({ path: root, ...scanner.sourceScope(root, owners) })) };
  };
  handle('skills:discover', async (_event, payload) => (await discover(payload)).skills);
  handle('skills:discoverDetailed', (_event, payload) => discover(payload));
  // Preserve each source's metadata; the shared composer merges display aliases.
  handle('skills:imported', () => references.list(persistence.getDataPath()));
  handle('skills:copies', () => scanner.listImported(persistence.getSkillsDir()));
  handle('skills:references', () => references.list(persistence.getDataPath()));
  handle('skills:referenceRegister', (_event, payload) => {
    if (!payload || typeof payload.sourcePath !== 'string' ||
        !skillCandidates.has(path.resolve(payload.sourcePath))) {
      throw new Error(I18n.t('请重新扫描并选择要登记的技能来源'));
    }
    if (payload.direct === true) {
      const settings = persistence.getSettings();
      return references.registerDiscovered(persistence.getDataPath(), skillCandidateDetails.get(path.resolve(payload.sourcePath)), {
        owners: skillCandidateOwners, enabledCliIds: cliRegistry.resolveEnabledCliIds(settings, persistence.listBots()),
      });
    }
    return references.register(persistence.getDataPath(), payload, { owners: skillCandidateOwners });
  });
  handle('skills:referenceRemove', (_event, referenceId) => references.remove(persistence.getDataPath(), referenceId));
  handle('skills:import', (_event, payload) => {
    if (!payload || typeof payload.sourcePath !== 'string' ||
        !skillCandidates.has(path.resolve(payload.sourcePath))) {
      throw new Error(I18n.t('请重新扫描并选择要导入的技能来源'));
    }
    if (typeof payload.name !== 'string' || !/^[^\s/]+$/.test(payload.name)) {
      throw new Error(I18n.t('技能名称不能包含空白或斜杠'));
    }
    const exists = scanner.listImported(persistence.getSkillsDir()).some((skill) =>
      skill.name.toLowerCase() === payload.name.toLowerCase());
    if (exists && payload.overwrite !== true) throw new Error(I18n.t('同名技能已存在，请确认替换或换一个名称'));
    return scanner.importSkill(persistence.getSkillsDir(), payload.sourcePath, payload.name);
  });
  handle('skills:remove', (_event, name) =>
    scanner.removeImported(persistence.getSkillsDir(), name));

  handle('dialog:pickFolder', async (_event, current) => {
    const res = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      defaultPath: current || undefined,
    });
    return res.canceled ? null : res.filePaths[0] || null;
  });
  handle('dialog:pickAvatar', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: I18n.t('选择成员头像（最多 256 KB）'), properties: ['openFile'],
      filters: [{ name: I18n.t('图片'), extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    const file = res.filePaths[0];
    const ext = path.extname(file).toLowerCase();
    const mime = { '.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg', '.webp': 'webp' }[ext];
    if (!mime) throw new Error(I18n.t('请选择 PNG、JPEG 或 WebP 图片'));
    const handle = await fs.promises.open(file, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_AVATAR_BYTES) throw new Error(I18n.t('头像须为不超过 256 KB 的图片文件'));
      const buffer = Buffer.alloc(MAX_AVATAR_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_AVATAR_BYTES) throw new Error(I18n.t('头像不能超过 256 KB'));
      return normalizeAvatar({ type: 'image', dataUrl: `data:image/${mime};base64,${buffer.subarray(0, bytesRead).toString('base64')}` }).dataUrl;
    } finally { await handle.close(); }
  });

  handle('shell:openDataDir', () => shell.openPath(persistence.getDataPath()));
  handle('shell:openRoomDirectory', async (_event, roomId) => {
    id(roomId);
    const room = activeRoom(roomId);
    const directory = path.resolve(room.cwd || persistence.getSettings().defaultCwd || projectRoot);
    const stat = await fs.promises.stat(directory);
    if (!stat.isDirectory()) throw new Error(I18n.t('工作目录不存在'));
    const error = await shell.openPath(directory);
    if (error) throw new Error(error);
  });
  handle('shell:openSkillsDir', async () => {
    const error = await shell.openPath(persistence.getSkillsDir());
    if (error) throw new Error(error);
  });

  handle('chat:human', (_event, payload) => {
    if (!payload || typeof payload.text !== 'string' || !payload.text.trim()) throw new Error(I18n.t('消息不能为空'));
    activeRoom(payload.roomId);
    return orchestrator.handleHuman(payload.roomId, payload.text, { mode: payload.mode });
  });
  handle('chat:stop', (_event, roomId) => orchestrator.stop(roomId));
  handle('chat:continue', (_event, payload) => {
    activeRoom(payload.roomId);
    return orchestrator.continueHuman(payload.roomId, payload.messageId);
  });
  handle('chat:retry', (_event, payload) => {
    activeRoom(payload.roomId);
    return orchestrator.retry(payload.roomId, payload.messageId);
  });

  // v1 runs in headless modes that do not prompt; the channel is reserved for
  // future ACP-based permission cards.
  handle('permission:respond', () => { throw new Error(I18n.t('当前 CLI 通道尚未实现交互授权')); });
}

module.exports = { registerIpc };
