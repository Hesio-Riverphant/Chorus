'use strict';
const I18n = require('../../shared/i18n');

const fs = require('fs');
const path = require('path');
const { ensureDir, readJson, writeJsonAtomic, appendLine } = require('./jsonStore');
const { uid } = require('../../shared/util');
const { RoutingMode, SpeakMode, PermissionMode, DEFAULTS } = require('../../shared/constants');
const { normalizeBotProfile } = require('../../shared/botProfile');
const { normalizeAppearance } = require('../../shared/appearance');
const cliRegistry = require('../cliRegistry');
const Reasoning = require('../../shared/reasoning');
const { normalizeSelection } = require('../nativeCapabilities');
const RoomProfiles = require('../../shared/roomProfiles');
const { parseMentions } = require('../../shared/mention');

const ROOT = path.join(__dirname, '..', '..', '..'); // project root

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateData(value, valid, file) {
  if (!valid(value)) {
    const err = new Error(I18n.tpl`数据格式无效，已保留原文件：${file}`);
    err.code = 'DATA_INVALID';
    throw err;
  }
  return value;
}

function isRecordList(value) {
  return Array.isArray(value) && value.every((item) =>
    isRecord(item) && typeof item.id === 'string' && item.id.length > 0);
}

function nameKey(name) { return name.trim().toLowerCase(); }

function availableRoomName(name, rooms) {
  const base = (typeof name === 'string' ? name : '房间').trim() || '房间';
  const taken = new Set(rooms.map((room) => nameKey(room.name)));
  let candidate = base;
  for (let n = 2; taken.has(nameKey(candidate)); n += 1) candidate = `${base} (${n})`;
  return candidate;
}

function isArchiveList(items) {
  return isRecordList(items) && items.every((item) =>
    /^[a-zA-Z0-9_-]+$/.test(item.id) && isRecordList(item.messages));
}

function seed() {
  const bots = [
    {
      id: uid('bot_'),
      name: '主持人',
      cliType: 'claude',
      model: '',
      persona: '你是房间的主持人：引导讨论、归纳分歧、必要时点名其他成员，并在讨论收敛时给出结论。',
      cwd: '',
      permissionMode: PermissionMode.WORKSPACE,
      role: '主持人',
      enabled: true,
      createdAt: Date.now(),
    },
    {
      id: uid('bot_'),
      name: '执行者',
      cliType: 'codex',
      model: '',
      persona: '你是执行者：专注把方案落地，给出可执行步骤与代码，并主动指出实现风险。',
      cwd: '',
      permissionMode: PermissionMode.WORKSPACE,
      role: '执行者',
      enabled: true,
      createdAt: Date.now(),
    },
  ];

  const rooms = [
    {
      id: uid('room_'),
      name: '主房间',
      moderatorBotId: bots[0].id,
      routingMode: RoutingMode.MODERATOR,
      speakMode: SpeakMode.PARALLEL,
      cwd: '',
      botIds: bots.map((b) => b.id),
      createdAt: Date.now(),
    },
  ];

  const settings = {
    enabledCliIds: [],
    maxAutoTurns: null, // null = per-room member count
    perEdgeMentionCap: DEFAULTS.perEdgeMentionCap,
    maxCliCallsPerRun: DEFAULTS.maxCliCallsPerRun,
    catchupMessages: DEFAULTS.catchupMessages,
    costMode: DEFAULTS.costMode,
    priceInputPer1M: DEFAULTS.priceInputPer1M,
    priceOutputPer1M: DEFAULTS.priceOutputPer1M,
    defaultCwd: DEFAULTS.defaultCwd,
  };

  return { bots, rooms, settings };
}

class Persistence {
  constructor() {
    this.dataPath = '';
    this.logPath = '';
    this.bots = [];
    this.rooms = [];
    this.settings = {};
    this.sessions = {};
    this.messages = new Map(); // roomId -> array
    this.dirty = new Set();
    this.timer = null;
  }

  async init(app) {
    if (app.isPackaged) {
      this.dataPath = app.getPath('userData');
      this.logPath = path.join(this.dataPath, 'logs');
    } else if (process.env.AR_DATA_DIR) {
      // Overridable data dir for smoke tests; keeps real data untouched.
      this.dataPath = process.env.AR_DATA_DIR;
      this.logPath = path.join(this.dataPath, 'logs');
    } else {
      this.dataPath = app.getPath('userData');
      this.logPath = path.join(this.dataPath, 'logs');
    }
    ensureDir(this.dataPath);
    ensureDir(path.join(this.dataPath, 'messages'));
    ensureDir(path.join(this.dataPath, 'trash'));
    ensureDir(path.join(this.dataPath, 'skills'));
    ensureDir(path.join(this.dataPath, 'archives'));
    ensureDir(this.logPath);

    const botsFile = path.join(this.dataPath, 'bots.json');
    const roomsFile = path.join(this.dataPath, 'rooms.json');
    const settingsFile = path.join(this.dataPath, 'settings.json');
    const sessionsFile = path.join(this.dataPath, 'sessions.json');

    // Read all registries before any migration writes. Only an entirely new
    // store may seed rooms/bots; a missing registry is not an empty store.
    const existingBots = readJson(botsFile, undefined);
    const existingRooms = readJson(roomsFile, undefined);
    const existingSettings = readJson(settingsFile, undefined);
    const existingSessions = readJson(sessionsFile, undefined);
    const fresh = [existingBots, existingRooms, existingSettings, existingSessions]
      .every((value) => value === undefined);
    if (fresh) {
      const s = seed();
      this.bots = s.bots;
      this.rooms = s.rooms;
      this.settings = s.settings;
    } else {
      this.bots = validateData(existingBots, isRecordList, botsFile);
      this.rooms = validateData(existingRooms, isRecordList, roomsFile);
      this.settings = validateData(existingSettings === undefined ? {} : existingSettings, isRecord, settingsFile);
    }
    I18n.setLanguage(this.settings.language);
    this.sessions = validateData(existingSessions === undefined ? {} : existingSessions, isRecord, sessionsFile);

    // A known legacy recovery title is presentation state, not the user's
    // room name. Preserve the registry before this narrowly scoped migration.
    const legacyTitle = '\u4e3b\u623f\u95f4\uff08\u5df2\u6062\u590d\uff09';
    if (this.rooms.some((room) => room.recovered === true && room.name === legacyTitle)) {
      const backup = path.join(this.dataPath, 'rooms-before-title-migration.json');
      if (!fs.existsSync(backup)) writeJsonAtomic(backup, this.rooms);
      this.rooms = this.rooms.map((room) => room.recovered === true && room.name === legacyTitle
        ? { ...room, name: '主房间' } : room);
    }
    this.migrateRoomProfiles();
    this.migrate();
    this.recoverOrphanedMessages();
    // Load/validate live transcripts before the window can accept new writes;
    // messages interrupted by a prior exit become retryable aborted messages.
    for (const room of this.rooms) this.getMessages(room.id);
    writeJsonAtomic(botsFile, this.bots);
    writeJsonAtomic(roomsFile, this.rooms);
    writeJsonAtomic(settingsFile, this.settings);

    // Periodic flush of dirty message lists.
    this.timer = setInterval(() => {
      try { this.flushDirty(); }
      catch (err) { console.error('[persistence:flush-failed]', err.message); }
    }, 1000);
    if (this.timer.unref) this.timer.unref();
  }

  // Preserve the exact currently visible side configuration once. Older clone
  // author IDs remain intact; snapshots never create globally editable bots.
  migrateRoomProfiles() {
    const changing = this.rooms.some(room => room.parentRoomId && !room.memberProfiles)
      || this.rooms.some(room => !room.memberProfiles && !room.memberCapabilities &&
        room.botIds?.some(id => this.bots.find(bot => bot.id === id)?.nativeCapabilities?.mode === 'selected'));
    if (changing) {
      const backup = path.join(this.dataPath, 'rooms-before-local-profiles.json');
      if (!fs.existsSync(backup)) writeJsonAtomic(backup, { rooms: this.rooms, bots: this.bots });
    }
    for (const room of this.rooms) {
      if (!room.memberProfiles && !room.memberCapabilities) {
        room.memberCapabilities = Object.fromEntries((room.botIds || []).flatMap(id => {
          const choice = this.bots.find(bot => bot.id === id)?.nativeCapabilities;
          return choice?.mode === 'selected' ? [[id, normalizeSelection(choice)]] : [];
        }));
      }
      if (room.parentRoomId && !room.memberProfiles) {
        room.memberProfiles = Object.fromEntries(RoomProfiles.members(room, this.bots, this.settings)
          .map(bot => [bot.id, JSON.parse(JSON.stringify(bot))]));
      }
    }
  }

  roomMembers(room) { return RoomProfiles.members(room, this.bots, this.settings); }

  saveRoomMember(roomId, patch) {
    const room = this.rooms.find(item => item.id === roomId);
    if (!RoomProfiles.isLocal(room)) throw new Error(I18n.t('只能在侧聊中修改此成员配置'));
    if (patch.id && !Object.hasOwn(room.memberProfiles || {}, patch.id)) throw new Error(I18n.t('侧聊成员不存在'));
    const id = patch.id || uid('bot_');
    const bot = normalizeBotProfile({ ...room.memberProfiles?.[id], ...patch, id });
    bot.name = String(bot.name || '').trim();
    if (!bot.name) throw new Error(I18n.t('请填写成员名称'));
    if (Object.values(room.memberProfiles || {}).some(item => item.id !== id && room.botIds.includes(item.id)
      && nameKey(item.name) === nameKey(bot.name))) throw new Error(I18n.t('侧聊中已存在同名成员'));
    if (!cliRegistry.findProfile(bot.cliType, this.settings)) throw new Error(I18n.t('CLI 接入不存在'));
    bot.reasoningEffort = Reasoning.normalizeEffort(bot.cliType, bot.reasoningEffort, bot.model);
    bot.executionMode = Reasoning.normalizeExecutionMode(bot.cliType, bot.executionMode);
    const changedAgent = room.memberProfiles?.[id]?.cliType !== bot.cliType;
    bot.nativeCapabilities = normalizeSelection((!changedAgent && room.memberProfiles?.[id]?.nativeCapabilities) || this.settings.agentCapabilities?.[bot.cliType]);
    const memberCapabilities = { ...room.memberCapabilities };
    if (changedAgent) delete memberCapabilities[id];
    const memberRoles = room.memberRoles?.[id] && Object.hasOwn(patch, 'role')
      ? { ...room.memberRoles, [id]: null } : room.memberRoles;
    bot.cwd = ''; delete bot.ownerRoomId;
    const saved = this.saveRoom({ ...room, memberRoles, memberCapabilities, memberProfiles: { ...room.memberProfiles, [id]: bot },
      botIds: [...new Set([...room.botIds, id])] }, { localProfileEdit: true });
    return { bot: saved.memberProfiles[id], room: saved };
  }

  // Normalize older data to the current schema: per-room independent members,
  // unique room names, valid moderators.
  migrate() {
    this.settings.enabledCliIds = cliRegistry.resolveEnabledCliIds(this.settings, this.bots);
    const botIds = new Set(this.bots.map((b) => b.id));

    // Skills are per-message (chosen via "/" in the composer), not attached to
    // a bot, so drop the obsolete field from older data.
    for (const bot of this.bots) delete bot.attachedSkill;

    for (const room of this.rooms) {
      if (Array.isArray(room.botIds)) {
        room.botIds = room.botIds.filter((id) => botIds.has(id) || room.memberProfiles?.[id]);
      } else {
        // Older schema: membership was the global enabled set.
        room.botIds = this.bots.filter((b) => b.enabled && (!b.ownerRoomId || b.ownerRoomId === room.id)).map((b) => b.id);
      }
      if (!room.botIds.includes(room.moderatorBotId)) {
        room.moderatorBotId = room.botIds[0] || '';
      }
    }

    // Unique room names: disambiguate collisions deterministically.
    const named = [];
    for (const room of this.rooms) {
      room.name = availableRoomName(room.name, named);
      named.push(room);
    }
  }

  // Safety net: if a transcript file exists but its room is missing (the room
  // record was clobbered by a stale writer), reattach it so history is never
  // silently lost. The room keeps its original id so the transcript loads.
  recoverOrphanedMessages() {
    const messagesDir = path.join(this.dataPath, 'messages');
    let files = [];
    try { files = fs.readdirSync(messagesDir); } catch { return; }
    const existing = new Set(this.rooms.map((r) => r.id));
    // A crash after committing room removal may leave its transcript behind.
    // The durable trash copy marks that removal so recovery cannot revive it.
    const deleted = new Set();
    for (const entry of fs.readdirSync(path.join(this.dataPath, 'trash'), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const room = readJson(path.join(this.dataPath, 'trash', entry.name, 'room.json'), null);
      if (room) deleted.add(room.id);
      const restoring = readJson(path.join(this.dataPath, 'trash', entry.name, 'restore.json'), null);
      if (restoring) deleted.add(restoring.id);
    }
    const botById = new Map(this.bots.map((b) => [b.id, b]));

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const id = file.slice(0, -'.json'.length);
      if (existing.has(id) || deleted.has(id)) continue;
      const list = validateData(readJson(path.join(messagesDir, file), []), isRecordList, file);
      if (!list.length) continue;

      // Reconstruct the member list from the transcript's bot authors.
      const ordered = [];
      for (const m of list) {
        if (m.authorType === 'bot' && botById.has(m.authorId) && !ordered.includes(m.authorId)) {
          ordered.push(m.authorId);
        }
      }
      const botIds = ordered.length ? ordered : this.bots.filter((b) => b.enabled && (!b.ownerRoomId || b.ownerRoomId === id)).map((b) => b.id);
      const name = availableRoomName('房间', this.rooms);

      this.rooms.push({
        id, name, cwd: '',
        routingMode: RoutingMode.MODERATOR,
        speakMode: SpeakMode.PARALLEL,
        botIds,
        moderatorBotId: botIds[0] || '',
        recovered: true,
        createdAt: Date.now(),
      });
      existing.add(id);
    }
  }

  // ---------- events ----------
  logEvent(entry) {
    try {
      appendLine(path.join(this.dataPath, 'events.log'), { t: Date.now(), ...entry });
    } catch (_) { /* logging must never break the run */ }
  }

  logCli(name, line) {
    try {
      appendLine(path.join(this.logPath, `${name}.log`), { t: Date.now(), line: String(line) });
    } catch (_) { /* ignore */ }
  }

  // ---------- bots ----------
  listBots() { return this.bots; }

  saveBot(bot) {
    const idx = this.bots.findIndex((b) => b.id === bot.id);
    const next = [...this.bots];
    let saved;
    if (idx >= 0) {
      saved = { ...this.bots[idx], ...bot };
      // Legacy private profiles retain ownership while their room exists.
      if (this.bots[idx].ownerRoomId) saved.ownerRoomId = this.bots[idx].ownerRoomId;
      else delete saved.ownerRoomId;
      if (saved.ownerRoomId) saved.cwd = '';
      next[idx] = saved;
    } else {
      saved = { ...bot, id: bot.id || uid('bot_'), createdAt: Date.now() };
      next.push(saved);
    }
    saved = normalizeBotProfile(saved);
    saved.reasoningEffort = Reasoning.normalizeEffort(saved.cliType, saved.reasoningEffort, saved.model);
    saved.executionMode = Reasoning.normalizeExecutionMode(saved.cliType, saved.executionMode);
    saved.nativeCapabilities = normalizeSelection(saved.nativeCapabilities);
    saved.name = String(saved.name || '').trim();
    if (!saved.name) throw new Error(I18n.t('请填写成员名称'));
    if (!saved.ownerRoomId && this.bots.some(item => item.id !== saved.id && !item.ownerRoomId && nameKey(item.name) === nameKey(saved.name))
      && (idx < 0 || nameKey(this.bots[idx].name) !== nameKey(saved.name))) {
      const error = new Error(I18n.t('已存在同名成员，请换一个名字')); error.code = 'BOT_NAME_DUPLICATE'; throw error;
    }
    if (saved.ownerRoomId) {
      if (!this.rooms.some((room) => room.id === saved.ownerRoomId)) {
        if (idx < 0) throw new Error(I18n.t('成员所属会话不存在'));
        delete saved.ownerRoomId; // An explicitly edited orphan becomes a reusable global profile.
      } else saved.cwd = '';
    }
    if (saved.cliType !== undefined && !cliRegistry.findProfile(saved.cliType, this.settings)) throw new Error(I18n.t('CLI 接入不存在，请先在设置中配置'));
    next[idx >= 0 ? idx : next.length - 1] = saved;
    if (idx >= 0 && this.bots[idx].cliType !== saved.cliType) {
      const rooms = this.rooms.map(room => {
        if (RoomProfiles.isLocal(room) || !room.memberCapabilities?.[saved.id]) return room;
        const memberCapabilities = { ...room.memberCapabilities }; delete memberCapabilities[saved.id];
        return { ...room, memberCapabilities };
      });
      this.commitRoomsAndBots(rooms, next);
    } else {
      writeJsonAtomic(path.join(this.dataPath, 'bots.json'), next);
      this.bots = next;
    }
    return saved;
  }

  deleteBot(botId) {
    const bots = this.bots.filter(bot => bot.id !== botId);
    const rooms = this.rooms.map(room => {
      const botIds = (room.botIds || []).filter(id => id !== botId || room.memberProfiles?.[id]);
      return { ...room, botIds,
        moderatorBotId: botIds.includes(room.moderatorBotId) ? room.moderatorBotId : (botIds[0] || ''),
        ...(room.memberDisplayOrder ? { memberDisplayOrder: room.memberDisplayOrder.filter(id => botIds.includes(id)) } : {}) };
    });
    // Reuse the recoverable paired commit: a failed room write must not leave
    // live member references pointing at a bot already removed from disk.
    this.commitRoomsAndBots(rooms, bots);
  }

  // ---------- rooms ----------
  listRooms() { return this.rooms; }

  setRoomPinned(roomId, pinned) {
    if (typeof pinned !== 'boolean') throw new Error(I18n.t('置顶状态无效'));
    const room = this.rooms.find((item) => item.id === roomId);
    if (!room) throw new Error(I18n.t('房间不存在'));
    return this.saveRoom({ id: roomId, name: room.name, pinnedAt: pinned ? (room.pinnedAt || Date.now()) : null });
  }

  renameRoom(roomId, name) {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) {
      throw new Error(I18n.t('名称须为 1–100 个字符'));
    }
    if (!this.rooms.some((room) => room.id === roomId)) throw new Error(I18n.t('房间不存在'));
    return this.saveRoom({ id: roomId, name: name.trim() });
  }

  createSideChat(parentRoomId) {
    const parent = this.rooms.find((room) => room.id === parentRoomId);
    if (!parent || parent.archivedAt || parent.parentRoomId) throw new Error(I18n.t('请在当前房间内发起侧边聊天'));
    const room = {
      ...JSON.parse(JSON.stringify(parent)), id: uid('room_'), parentRoomId,
      name: availableRoomName(`${parent.name} · 侧聊`, this.rooms),
      createdAt: Date.now(), archivedAt: null, pinnedAt: null,
    };
    room.memberProfiles = Object.fromEntries(this.roomMembers(parent).map(bot => [bot.id, JSON.parse(JSON.stringify(bot))]));
    room.memberCapabilities = {};
    delete room.forkedFrom;
    delete room.recovered;
    return this.saveRoom(room);
  }

  // Commit profiles first; a crash can leave unused private profiles, but can
  // never expose a side conversation backed by another room's mutable bots.
  commitRoomsAndBots(rooms, bots) {
    const previous = this.bots;
    const changed = bots !== previous;
    if (changed) {
      writeJsonAtomic(path.join(this.dataPath, 'bots.json'), bots);
      this.bots = bots;
    }
    try { writeJsonAtomic(path.join(this.dataPath, 'rooms.json'), rooms); }
    catch (error) {
      if (changed) {
        try {
          writeJsonAtomic(path.join(this.dataPath, 'bots.json'), previous);
          this.bots = previous;
        } catch (rollback) {
          throw new AggregateError([error, rollback], I18n.t('房间保存失败，成员配置已保留，请重试'));
        }
      }
      throw error;
    }
    this.rooms = rooms;
  }

  setMemberDisplayOrder(roomId, ids) {
    const index = this.rooms.findIndex((room) => room.id === roomId);
    if (index < 0) throw new Error(I18n.t('房间不存在'));
    const room = this.rooms[index];
    if (!Array.isArray(ids) || new Set(ids).size !== ids.length ||
        ids.some((id) => typeof id !== 'string' || !room.botIds.includes(id))) {
      throw new Error(I18n.t('显示排序必须是房间成员 ID 的无重复列表'));
    }
    const saved = { ...room, memberDisplayOrder: [...ids, ...room.botIds.filter((id) => !ids.includes(id))] };
    const next = [...this.rooms];
    next[index] = saved;
    writeJsonAtomic(path.join(this.dataPath, 'rooms.json'), next);
    this.rooms = next;
    return saved;
  }

  permanentDeleteRoom(roomId) {
    const key = this.deleteRoom(roomId);
    if (key) this.purgeTrash(key);
  }

  rewindRoom(roomId, messageId, text) {
    if (!this.rooms.some((room) => room.id === roomId)) throw new Error(I18n.t('房间不存在'));
    const messages = this.getMessages(roomId);
    const index = messages.findIndex((message) => message.id === messageId);
    const selected = messages[index];
    if (!selected || selected.authorType !== 'human' || selected.status !== 'done') {
      throw new Error(I18n.t('只能回溯到已完成的人类消息'));
    }
    if (typeof text !== 'string' || !text.trim()) throw new Error(I18n.t('消息不能为空'));
    const next = messages.slice(0, index + 1).map((message) => ({ ...message }));
    const retained = new Set(next.map((message) => message.id));
    for (const message of next) {
      for (const field of ['roundId', 'replyToId', 'supersedes', 'supersededBy']) {
        if (message[field] && !retained.has(message[field])) delete message[field];
      }
    }
    const edited = next[index];
    if (text !== selected.text) {
      delete edited.audienceBotIds;
      delete edited.targetBotId;
      delete edited.modeTargetIds;
      delete edited.roundRun;
      const room = this.rooms.find(record => record.id === roomId);
      const mentions = parseMentions(text, this.roomMembers(room));
      if (mentions.length && !mentions.includes('all')) edited.audienceBotIds = mentions;
    }
    edited.text = text;
    edited.updatedAt = Date.now();
    // Existing notes remain private and readable, but stale text anchors must
    // not highlight unrelated text after editing the original message.
    if (text !== selected.text && edited.annotations) {
      edited.annotations = edited.annotations.map((annotation) => ({ ...annotation, detached: true }));
    }
    this.clearRoomSessions(roomId);
    writeJsonAtomic(path.join(this.dataPath, 'messages', `${roomId}.json`), next);
    this.messages.set(roomId, next);
    this.dirty.delete(roomId);
    return next;
  }

  forkRoomAt(roomId, messageId) {
    const room = this.rooms.find((item) => item.id === roomId);
    if (!room) throw new Error(I18n.t('房间不存在'));
    const messages = this.getMessages(roomId);
    const index = messages.findIndex((message) => message.id === messageId);
    if (index < 0 || messages[index].status !== 'done') throw new Error(I18n.t('分支起点必须是已完成的消息'));
    const source = messages.slice(0, index + 1);
    const ids = new Map(source.map((message) => [message.id, uid('msg_')]));
    const saved = { ...room, id: uid('room_'), name: availableRoomName(room.name, this.rooms),
      archivedAt: null, createdAt: Date.now(), forkedFrom: { roomId, messageId },
      botIds: [...room.botIds] };
    if (room.memberProfiles) saved.memberProfiles = JSON.parse(JSON.stringify(room.memberProfiles));
    if (room.memberCapabilities) saved.memberCapabilities = JSON.parse(JSON.stringify(room.memberCapabilities));
    if (room.memberRoles) saved.memberRoles = JSON.parse(JSON.stringify(room.memberRoles));
    if (room.memberDisplayOrder) saved.memberDisplayOrder = [...room.memberDisplayOrder];
    delete saved.recovered;
    delete saved.parentRoomId;
    saved.pinnedAt = null;
    const botIds = new Map();
    let nextBots = this.bots;
    if (room.botIds.some((id) => this.bots.find((bot) => bot.id === id)?.ownerRoomId)) {
      const copies = room.botIds.map((id) => {
        const bot = this.bots.find((item) => item.id === id);
        const copy = { ...JSON.parse(JSON.stringify(bot)), id: uid('bot_'),
          ownerRoomId: saved.id, sourceBotId: bot.sourceBotId || bot.id, createdAt: Date.now() };
        botIds.set(id, copy.id);
        return copy;
      });
      nextBots = [...this.bots, ...copies];
      if (saved.memberProfiles) saved.memberProfiles = Object.fromEntries(Object.entries(saved.memberProfiles)
        .map(([id, profile]) => [botIds.get(id) || id, { ...profile, id: botIds.get(id) || id }]));
      if (saved.memberCapabilities) saved.memberCapabilities = Object.fromEntries(Object.entries(saved.memberCapabilities)
        .map(([id, choice]) => [botIds.get(id) || id, choice]));
      if (saved.memberRoles) saved.memberRoles = Object.fromEntries(Object.entries(saved.memberRoles)
        .map(([id, role]) => [botIds.get(id) || id, role]));
      saved.botIds = saved.botIds.map((id) => botIds.get(id));
      saved.moderatorBotId = botIds.get(saved.moderatorBotId) || '';
      if (saved.memberDisplayOrder) saved.memberDisplayOrder = saved.memberDisplayOrder.map((id) => botIds.get(id)).filter(Boolean);
    }
    const copies = source.map((message) => {
      const copy = JSON.parse(JSON.stringify(message));
      copy.id = ids.get(message.id);
      copy.roomId = saved.id;
      if (botIds.has(copy.authorId)) copy.authorId = botIds.get(copy.authorId);
      if (Array.isArray(copy.mentions)) copy.mentions = copy.mentions.map((id) => botIds.get(id) || id);
      if (Array.isArray(copy.modeTargetIds)) copy.modeTargetIds = copy.modeTargetIds.map(id => botIds.get(id) || id);
      if (Array.isArray(copy.audienceBotIds)) copy.audienceBotIds = copy.audienceBotIds.map(id => botIds.get(id) || id);
      if (copy.targetBotId) copy.targetBotId = botIds.get(copy.targetBotId) || copy.targetBotId;
      delete copy.runId;
      for (const field of ['roundId', 'replyToId', 'supersedes', 'supersededBy']) {
        if (copy[field]) {
          if (ids.has(copy[field])) copy[field] = ids.get(copy[field]);
          else delete copy[field];
        }
      }
      if (copy.annotations) copy.annotations = copy.annotations.map((annotation) => ({
        ...annotation, id: uid('note_'), messageId: copy.id,
      }));
      return copy;
    });
    // Write history first so a failed room-table commit cannot create an empty
    // visible branch. On a reported failure, remove only this new branch file;
    // after a hard crash existing orphan recovery preserves staged history.
    const file = path.join(this.dataPath, 'messages', `${saved.id}.json`);
    writeJsonAtomic(file, copies);
    try { this.commitRoomsAndBots([...this.rooms, saved], nextBots); }
    catch (error) {
      try { fs.unlinkSync(file); }
      catch (cleanup) { throw new AggregateError([error, cleanup], I18n.t('分支保存失败，暂存记录未能清理，可在重启后找回')); }
      throw error;
    }
    this.messages.set(saved.id, copies);
    return saved;
  }

  addAnnotation(roomId, messageId, input) {
    const message = this.getMessage(roomId, messageId);
    if (!message || message.status !== 'done' || typeof message.text !== 'string') {
      throw new Error(I18n.t('只能批注已完成的文字消息'));
    }
    if (!isRecord(input) || !Number.isInteger(input.start) || !Number.isInteger(input.end) ||
        input.start < 0 || input.end <= input.start || input.end > message.text.length ||
        typeof input.quote !== 'string' || input.quote !== message.text.slice(input.start, input.end) ||
        typeof input.note !== 'string' || !input.note.trim()) {
      throw new Error(I18n.t('批注须包含有效原文选区和非空批注'));
    }
    const annotation = { id: uid('note_'), messageId, quote: input.quote,
      start: input.start, end: input.end, note: input.note.trim(), createdAt: Date.now() };
    this.saveAnnotations(roomId, messageId, [...(message.annotations || []), annotation]);
    return annotation;
  }

  removeAnnotation(roomId, messageId, annotationId) {
    const message = this.getMessage(roomId, messageId);
    if (!message) throw new Error(I18n.t('消息不存在'));
    const annotations = message.annotations || [];
    const next = annotations.filter((annotation) => annotation.id !== annotationId);
    if (next.length === annotations.length) return false;
    this.saveAnnotations(roomId, messageId, next);
    return true;
  }

  saveAnnotations(roomId, messageId, annotations) {
    const next = this.getMessages(roomId).map((message) =>
      message.id === messageId ? { ...message, annotations } : message);
    writeJsonAtomic(path.join(this.dataPath, 'messages', `${roomId}.json`), next);
    this.messages.set(roomId, next);
    this.dirty.delete(roomId);
  }

  // Whole-room archive changes visibility only. Identity, chat archives and
  // CLI sessions remain associated with the same room for later continuation.
  setRoomArchived(roomId, archived) {
    if (typeof archived !== 'boolean') throw new Error(I18n.t('房间归档状态必须为布尔值'));
    const index = this.rooms.findIndex((room) => room.id === roomId);
    if (index < 0) throw new Error(I18n.t('房间不存在'));
    const room = this.rooms[index];
    const saved = { ...room, archivedAt: archived ? (room.archivedAt || Date.now()) : null };
    const next = [...this.rooms];
    next[index] = saved;
    writeJsonAtomic(path.join(this.dataPath, 'rooms.json'), next);
    this.rooms = next;
    return saved;
  }

  archiveRooms(ids) {
    if (ids.some(id => !this.rooms.some(room => room.id === id))) throw new Error(I18n.t('房间不存在'));
    const selected = new Set(ids), now = Date.now();
    const next = this.rooms.map(room => selected.has(room.id) ? { ...room, archivedAt: room.archivedAt || now } : room);
    writeJsonAtomic(path.join(this.dataPath, 'rooms.json'), next);
    this.rooms = next;
    return { count: selected.size };
  }

  saveRoom(room, { localProfileEdit = false } = {}) {
    const idx = this.rooms.findIndex((r) => r.id === room.id);
    const next = [...this.rooms];
    const name = (room.name || (idx >= 0 && this.rooms[idx].name) || '新房间').trim() || '新房间';

    // Room names must be unique (case-insensitive) so they can be told apart.
    const clash = this.rooms.some((r, i) =>
      i !== idx && nameKey(r.name) === nameKey(name));
    if (clash) {
      const err = new Error(I18n.tpl`已存在同名房间「${name}」，请换一个名字`);
      err.code = 'ROOM_NAME_DUPLICATE';
      throw err;
    }

    let saved;
    if (idx >= 0) {
      saved = { ...this.rooms[idx], ...room, name };
      saved.parentRoomId = this.rooms[idx].parentRoomId;
      if (this.rooms[idx].memberProfiles && !localProfileEdit) saved.memberProfiles = this.rooms[idx].memberProfiles;
      next[idx] = saved;
    } else {
      saved = {
        cwd: '', routingMode: RoutingMode.MODERATOR, speakMode: SpeakMode.PARALLEL,
        botIds: this.bots.filter((b) => b.enabled && !b.ownerRoomId).map((b) => b.id),
        ...room,
        name,
        id: room.id || uid('room_'),
        createdAt: Date.now(),
      };
      next.push(saved);
    }

    // Keep the member list and moderator consistent.
    const botIdSet = new Set(this.bots.map((b) => b.id));
    saved.botIds = [...new Set((saved.botIds || []).filter((id) => botIdSet.has(id) || saved.memberProfiles?.[id]))];
    if (saved.memberCapabilities !== undefined) {
      if (!isRecord(saved.memberCapabilities)) throw new Error(I18n.t('房间扩展配置无效'));
      saved.memberCapabilities = Object.fromEntries(Object.entries(saved.memberCapabilities).map(([id, choice]) => [id, normalizeSelection(choice)]));
    }
    const clearedRoles = new Set();
    if (saved.memberRoles !== undefined) {
      if (!isRecord(saved.memberRoles)) throw new Error(I18n.t('成员配置无效'));
      saved.memberRoles = Object.fromEntries(Object.entries(saved.memberRoles).flatMap(([id, choice]) => {
        if (choice === null) { clearedRoles.add(id); return []; }
        const profile = normalizeBotProfile(choice);
        return [[id, { role: profile.role, customRole: !!profile.customRole }]];
      }));
    }
    if (RoomProfiles.isLocal(saved)) {
      const snapshots = { ...(saved.memberProfiles || {}) };
      const parent = this.rooms.find(item => item.id === saved.parentRoomId);
      for (const id of saved.botIds) {
        const source = snapshots[id] || this.roomMembers(parent).find(bot => bot.id === id) ||
          RoomProfiles.members({ botIds: [id] }, this.bots, this.settings)[0];
        if (!source) throw new Error(I18n.t('成员不存在'));
        snapshots[id] = { ...normalizeBotProfile(JSON.parse(JSON.stringify(source))), id,
          nativeCapabilities: normalizeSelection(source.nativeCapabilities || this.settings.agentCapabilities?.[source.cliType]) };
      }
      const added = saved.botIds.filter(id => !(this.rooms[idx]?.botIds || []).includes(id));
      for (const id of added) {
        if (saved.botIds.some(other => other !== id && nameKey(snapshots[other].name) === nameKey(snapshots[id].name))) throw new Error(I18n.t('侧聊中已存在同名成员'));
      }
      saved.memberProfiles = snapshots;
    }
    let nextBots = this.bots;
    if (saved.parentRoomId) {
      const parent = this.rooms.find(item => item.id === saved.parentRoomId && !item.parentRoomId);
      if (!parent) throw new Error(I18n.t('侧边聊天的所属房间不存在'));
      saved.cwd = parent.cwd || '';
      // Membership and configuration stay local to this side conversation.
      saved.botIds = saved.botIds.filter(id => {
        const bot = this.bots.find(item => item.id === id);
        return !!saved.memberProfiles?.[id] || !bot?.ownerRoomId || bot.ownerRoomId === saved.id;
      });
    } else if (!saved.memberProfiles && this.bots.some((bot) => bot.ownerRoomId === saved.id && saved.botIds.includes(bot.id))) {
      const remap = new Map();
      nextBots = [...this.bots];
      saved.botIds = saved.botIds.map((id) => {
        const source = this.bots.find((bot) => bot.id === id);
        if (source.ownerRoomId === saved.id) { remap.set(id, id); return id; }
        const sourceBotId = source.sourceBotId || source.id;
        let clone = nextBots.find((bot) => bot.ownerRoomId === saved.id && bot.sourceBotId === sourceBotId);
        if (!clone) {
          clone = { ...JSON.parse(JSON.stringify(source)), id: uid('bot_'),
            ownerRoomId: saved.id, sourceBotId, cwd: '', createdAt: Date.now() };
          nextBots.push(clone);
        }
        remap.set(id, clone.id);
        return clone.id;
      });
      saved.botIds = [...new Set(saved.botIds)];
      saved.moderatorBotId = remap.get(saved.moderatorBotId) || saved.moderatorBotId;
      if (saved.memberRoles) saved.memberRoles = Object.fromEntries(Object.entries(saved.memberRoles)
        .map(([id, role]) => [remap.get(id) || id, role]));
      if (saved.memberDisplayOrder) saved.memberDisplayOrder = [...new Set(saved.memberDisplayOrder
        .map((id) => remap.get(id) || id).filter((id) => saved.botIds.includes(id)))];
      if (nextBots.length === this.bots.length) nextBots = this.bots;
    } else {
      // Private member configurations belong to the side conversation only.
      saved.botIds = saved.botIds.filter((id) => {
        const bot = this.bots.find((item) => item.id === id);
        return !!saved.memberProfiles?.[id] || !bot?.ownerRoomId || bot.ownerRoomId === saved.id;
      });
    }
    if (!saved.botIds.includes(saved.moderatorBotId)) {
      saved.moderatorBotId = saved.botIds[0] || '';
    }
    const previousHost = this.rooms[idx]?.moderatorBotId;
    if (previousHost && previousHost !== saved.moderatorBotId && saved.botIds.includes(previousHost) && !clearedRoles.has(previousHost)) {
      saved.memberRoles = { ...saved.memberRoles, [previousHost]: { role: '协作者', customRole: false } };
    }
    if (saved.memberRoles) saved.memberRoles = Object.fromEntries(Object.entries(saved.memberRoles)
      .filter(([id]) => saved.botIds.includes(id)));

    // The project directory belongs to the parent; all side conversations
    // follow a directory edit in the same atomic room-table update.
    for (let i = 0; i < next.length; i += 1) {
      if (next[i].parentRoomId === saved.id) next[i] = { ...next[i], cwd: saved.cwd || '' };
    }
    this.commitRoomsAndBots(next, nextBots);
    return saved;
  }

  // Commit a complete recovery snapshot before removing the room. A failed
  // cleanup leaves the durable trash copy available for restore or purge.
  deleteRoom(roomId) {
    const room = this.rooms.find((r) => r.id === roomId);
    if (!room) return;
    const trashDir = path.join(this.dataPath, 'trash', `${roomId}_${Date.now()}`);
    ensureDir(trashDir);
    writeJsonAtomic(path.join(trashDir, 'messages.json'), this.getMessages(roomId));
    const archives = this.readRoomArchives(roomId);
    writeJsonAtomic(path.join(trashDir, 'archives.json'), archives);
    // This marker is written last: incomplete snapshots never appear as trash.
    writeJsonAtomic(path.join(trashDir, 'room.json'), room);
    this.clearRoomSessions(roomId);
    // Keep independent side histories reachable if their parent is removed.
    const next = this.rooms.filter((r) => r.id !== roomId).map((child) => {
      if (child.parentRoomId !== roomId) return child;
      const detached = { ...child };
      delete detached.parentRoomId;
      return detached;
    });
    writeJsonAtomic(path.join(this.dataPath, 'rooms.json'), next);
    this.rooms = next;
    this.messages.delete(roomId);
    this.dirty.delete(roomId);
    // The trash snapshot above includes pending deltas; the empty checkpoint
    // prevents resurrection after the trash item is later restored/purged.
    writeJsonAtomic(path.join(this.dataPath, 'messages', `${roomId}.json`), []);
    this.removeRoomArchiveFiles(roomId);
    return path.basename(trashDir);
  }

  readRoomArchives(roomId) {
    const dir = path.join(this.dataPath, 'archives', roomId);
    let files;
    try { files = fs.readdirSync(dir); }
    catch (err) { if (err.code === 'ENOENT') return []; throw err; }
    const records = files.filter((file) => file.endsWith('.json')).map((file) => {
      const record = readJson(path.join(dir, file), null);
      return validateData(record, (value) => isArchiveList([value]) && `${value.id}.json` === file, file);
    });
    return records;
  }

  trashArchives(trashDir, roomId) {
    const bundle = readJson(path.join(trashDir, 'archives.json'), undefined);
    const records = bundle === undefined ? this.readRoomArchives(roomId) : bundle;
    return validateData(records, isArchiveList, trashDir);
  }

  removeRoomArchiveFiles(roomId) {
    // Only remove recognized archive files after a durable snapshot exists or
    // an explicit purge. Keep unrelated files and the directory itself.
    for (const archive of this.readRoomArchives(roomId)) this.deleteArchive(roomId, archive.id);
  }

  // ---------- trash (recycle bin) ----------
  listTrash() {
    const dir = path.join(this.dataPath, 'trash');
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
    const out = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const room = readJson(path.join(dir, e.name, 'room.json'), null);
      if (!room) continue;
      const stamp = Number(e.name.slice(room.id.length + 1)) || 0;
      const count = readJson(path.join(dir, e.name, 'messages.json'), []).length;
      const archiveCount = this.trashArchives(path.join(dir, e.name), room.id).length;
      out.push({ key: e.name, name: room.name, count, archiveCount, deletedAt: stamp });
    }
    out.sort((a, b) => b.deletedAt - a.deletedAt);
    return out;
  }

  restoreTrash(key) {
    const trashDir = path.join(this.dataPath, 'trash', key);
    const originalRoom = readJson(path.join(trashDir, 'room.json'), null);
    if (!originalRoom) throw new Error(I18n.t('回收站条目无效'));
    const msgs = validateData(readJson(path.join(trashDir, 'messages.json'), []), isRecordList, trashDir);
    const archives = this.trashArchives(trashDir, originalRoom.id);
    // Upgrade a legacy trash item before any restore writes. A retry no longer
    // depends on archive files which could have been partly moved already.
    writeJsonAtomic(path.join(trashDir, 'archives.json'), archives);
    let room = readJson(path.join(trashDir, 'restore.json'), null);
    if (room && this.rooms.some((existing) => existing.id === room.id)) {
      // rooms.json is the restore commit point. A previous attempt committed
      // and only cleanup failed; preserve any newer chat and finish cleanup.
      fs.rmSync(trashDir, { recursive: true, force: true });
      return room.id;
    }

    if (!room) {
      room = { ...originalRoom, archivedAt: null };
      if (this.rooms.some((r) => r.id === room.id)) room.id = uid('room_');
    }
    room.name = availableRoomName(originalRoom.name, this.rooms);
    if (room.parentRoomId && !this.rooms.some(parent => parent.id === room.parentRoomId)) delete room.parentRoomId;

    // Persist the target before staging cloned profiles, so a failed restore
    // can reuse the same room and member identities after restart.
    writeJsonAtomic(path.join(trashDir, 'restore.json'), room);
    const profilesFile = path.join(trashDir, 'restore-bots.json');
    let profiles = readJson(profilesFile, null);
    if (profiles == null) {
      const referenced = new Set(originalRoom.botIds || []);
      for (const messages of [msgs, ...archives.map(archive => archive.messages)]) {
        for (const message of messages) {
          if (message.authorType === 'bot') referenced.add(message.authorId);
          if (Array.isArray(message.mentions)) for (const id of message.mentions) referenced.add(id);
        }
      }
      profiles = this.bots.filter(bot => referenced.has(bot.id) && bot.ownerRoomId && bot.ownerRoomId !== room.id)
        .map(bot => ({ id: bot.id, bot: { ...JSON.parse(JSON.stringify(bot)), id: uid('bot_'),
          ownerRoomId: room.id, sourceBotId: bot.sourceBotId || bot.id, createdAt: Date.now() } }));
      writeJsonAtomic(profilesFile, profiles);
    }
    validateData(profiles, values => isRecordList(values) && values.every(value => isRecord(value.bot) &&
      typeof value.bot.id === 'string' && value.bot.id && value.bot.ownerRoomId === room.id), profilesFile);
    const remap = new Map(profiles.map(profile => [profile.id, profile.bot.id]));
    const copies = profiles.filter(profile => !this.bots.some(bot => bot.id === profile.bot.id)).map(profile => profile.bot);
    const nextBots = copies.length ? [...this.bots, ...copies] : this.bots;
    const botIdSet = new Set(nextBots.map(bot => bot.id));
    if (originalRoom.memberProfiles) room.memberProfiles = Object.fromEntries(Object.entries(originalRoom.memberProfiles)
      .map(([id, profile]) => [remap.get(id) || id, { ...profile, id: remap.get(id) || id }]));
    if (originalRoom.memberCapabilities) room.memberCapabilities = Object.fromEntries(Object.entries(originalRoom.memberCapabilities)
      .map(([id, choice]) => [remap.get(id) || id, choice]));
    if (originalRoom.memberRoles) room.memberRoles = Object.fromEntries(Object.entries(originalRoom.memberRoles)
      .map(([id, role]) => [remap.get(id) || id, role]));
    room.botIds = (originalRoom.botIds || []).map(id => remap.get(id) || id).filter(id => botIdSet.has(id) || room.memberProfiles?.[id]);
    room.moderatorBotId = remap.get(originalRoom.moderatorBotId) || originalRoom.moderatorBotId;
    if (originalRoom.memberDisplayOrder) room.memberDisplayOrder = originalRoom.memberDisplayOrder
      .map(id => remap.get(id) || id).filter(id => room.botIds.includes(id));
    if (!room.botIds.includes(room.moderatorBotId)) room.moderatorBotId = room.botIds[0] || '';
    writeJsonAtomic(path.join(trashDir, 'restore.json'), room);

    const restoreMessage = message => {
      const restored = { ...message, roomId: room.id };
      if (message.authorType === 'bot' && remap.has(message.authorId)) restored.authorId = remap.get(message.authorId);
      if (Array.isArray(message.mentions)) restored.mentions = message.mentions.map(id => remap.get(id) || id);
      if (Array.isArray(message.modeTargetIds)) restored.modeTargetIds = message.modeTargetIds.map(id => remap.get(id) || id);
      if (Array.isArray(message.audienceBotIds)) restored.audienceBotIds = message.audienceBotIds.map(id => remap.get(id) || id);
      if (message.targetBotId) restored.targetBotId = remap.get(message.targetBotId) || message.targetBotId;
      return restored;
    };
    const restored = msgs.map(restoreMessage);
    const next = [...this.rooms, room];
    for (const archive of archives) {
      writeJsonAtomic(path.join(this.archivesDir(room.id), `${archive.id}.json`), {
        ...archive, roomId: room.id,
        messages: archive.messages.map(restoreMessage),
      });
    }
    writeJsonAtomic(path.join(this.dataPath, 'messages', `${room.id}.json`), restored);
    this.commitRoomsAndBots(next, nextBots);
    this.messages.set(room.id, restored);
    this.dirty.delete(room.id);
    fs.rmSync(trashDir, { recursive: true, force: true });
    return room.id;
  }

  purgeTrash(key) {
    const trashDir = path.join(this.dataPath, 'trash', key);
    const room = readJson(path.join(trashDir, 'room.json'), null);
    const restoring = readJson(path.join(trashDir, 'restore.json'), null);
    const roomIds = new Set([room && room.id, restoring && restoring.id].filter(Boolean));
    for (const roomId of roomIds) if (!this.rooms.some((active) => active.id === roomId)) {
      // Finish an interrupted delete before removing its recovery marker.
      writeJsonAtomic(path.join(this.dataPath, 'messages', `${roomId}.json`), []);
      this.removeRoomArchiveFiles(roomId);
    }
    fs.rmSync(trashDir, { recursive: true, force: true });
  }

  // Data directory (for the settings "open data folder" action).
  getDataPath() { return this.dataPath; }

  // App-owned imported skills (copies, independent of external skill files).
  getSkillsDir() { return path.join(this.dataPath, 'skills'); }

  // ---------- archives (per-room history) ----------
  archivesDir(roomId) {
    const dir = path.join(this.dataPath, 'archives', roomId);
    ensureDir(dir);
    return dir;
  }

  // Move the room's current transcript into an archive and clear the live
  // transcript. Returns a summary, or null when there is nothing to archive.
  archiveCurrent(roomId) {
    const room = this.rooms.find((r) => r.id === roomId);
    const messages = this.getMessages(roomId);
    if (!messages.length) return null;
    const id = uid('arc_');
    const record = {
      id,
      roomId,
      roomName: room ? room.name : '',
      archivedAt: Date.now(),
      messages,
    };
    writeJsonAtomic(path.join(this.archivesDir(roomId), `${id}.json`), record);
    this.clearRoom(roomId);
    return { id, count: messages.length, archivedAt: record.archivedAt };
  }

  listArchives(roomId) {
    const dir = path.join(this.dataPath, 'archives', roomId);
    let files = [];
    try { files = fs.readdirSync(dir); } catch { return []; }
    const out = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const rec = readJson(path.join(dir, file), null);
      if (!rec) continue;
      out.push({
        id: rec.id,
        roomName: rec.roomName || '',
        count: Array.isArray(rec.messages) ? rec.messages.length : 0,
        archivedAt: rec.archivedAt || 0,
      });
    }
    out.sort((a, b) => b.archivedAt - a.archivedAt);
    return out;
  }

  searchArchives(query, limit = 100, signal) {
    return require('./archiveSearch').searchArchives(this.dataPath, this.rooms, query, { limit, signal });
  }

  getArchive(roomId, archiveId) {
    return readJson(
      path.join(this.dataPath, 'archives', roomId, `${archiveId}.json`), null,
    );
  }

  // Merge an archive back into the live transcript (de-duped by message id),
  // ordered by creation time, then remove the archive file.
  restoreArchive(roomId, archiveId) {
    const rec = this.getArchive(roomId, archiveId);
    if (!rec || !Array.isArray(rec.messages)) throw new Error(I18n.t('归档不存在或已损坏'));
    const current = [...this.getMessages(roomId)];
    const byId = new Map(current.map((m) => [m.id, m]));
    for (const m of rec.messages) if (!byId.has(m.id)) {
      current.push({ ...m, roomId });
      byId.set(m.id, m);
    }
    current.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    this.clearRoomSessions(roomId);
    writeJsonAtomic(path.join(this.dataPath, 'messages', `${roomId}.json`), current);
    this.messages.set(roomId, current);
    this.dirty.delete(roomId);
    fs.rmSync(path.join(this.dataPath, 'archives', roomId, `${archiveId}.json`), { force: true });
    return current.length;
  }

  deleteArchive(roomId, archiveId) {
    fs.rmSync(
      path.join(this.dataPath, 'archives', roomId, `${archiveId}.json`),
      { force: true },
    );
  }

  // ---------- settings ----------
  getSettings() { return this.settings; }

  // Navigation is presentation-only and can be updated during an Agent run.
  // Keep this entry point separate from runtime settings and reject stray keys.
  saveNavigation(patch) {
    if (!isRecord(patch) || Object.keys(patch).some(key =>
      !['roomDisplayOrder', 'navigationCollapsedGroups', 'projectDisplayNames', 'pinnedProjects'].includes(key))) throw new Error(I18n.t('导航设置无效'));
    const next = {};
    if (Object.hasOwn(patch, 'pinnedProjects')) {
      const keys = patch.pinnedProjects;
      if (!Array.isArray(keys) || keys.length > 1024 || new Set(keys).size !== keys.length ||
        keys.some(key => typeof key !== 'string' || !key.startsWith('project:') || key.includes('\0') || key.length > 32768)) throw new Error(I18n.t('项目置顶设置无效'));
      next.pinnedProjects = [...keys];
    }
    if (Object.hasOwn(patch, 'projectDisplayNames')) {
      const names = patch.projectDisplayNames;
      if (!isRecord(names) || Object.keys(names).length > 1024 || Object.entries(names).some(([key, name]) =>
        !key.startsWith('project:') || key.length > 32768 || key.includes('\0') ||
        typeof name !== 'string' || !name.trim() || name.length > 120 || /[\x00-\x1f]/.test(name))) throw new Error(I18n.t('项目显示名称无效'));
      next.projectDisplayNames = Object.fromEntries(Object.entries(names).map(([key, name]) => [key, name.trim()]));
    }
    if (Object.hasOwn(patch, 'roomDisplayOrder')) {
      const ids = patch.roomDisplayOrder, valid = new Set(this.rooms.map(room => room.id));
      if (!Array.isArray(ids) || ids.length > this.rooms.length || new Set(ids).size !== ids.length ||
          ids.some(id => typeof id !== 'string' || !valid.has(id))) throw new Error(I18n.t('房间显示顺序须为现有房间 ID 的无重复列表'));
      next.roomDisplayOrder = [...ids, ...this.rooms.filter(room => !ids.includes(room.id)).map(room => room.id)];
    }
    if (Object.hasOwn(patch, 'navigationCollapsedGroups')) {
      const groups = patch.navigationCollapsedGroups;
      if (!Array.isArray(groups) || groups.length > 1024 || new Set(groups).size !== groups.length ||
          groups.some(key => typeof key !== 'string' || key.length > 32768 || key.includes('\0') ||
            (key !== 'pinned' && !key.startsWith('project:')))) throw new Error(I18n.t('项目折叠状态无效'));
      next.navigationCollapsedGroups = [...groups];
    }
    const settings = { ...this.settings, ...next };
    writeJsonAtomic(path.join(this.dataPath, 'settings.json'), settings);
    this.settings = settings;
    return next;
  }

  saveSettings(settings) {
    const next = { ...this.settings, ...settings };
    if (Object.hasOwn(settings, 'language')) {
      if (!['zh-CN', 'en'].includes(settings.language)) throw new Error('Unsupported interface language');
      next.language = settings.language;
    }
    if (Object.hasOwn(settings, 'agentPricing')) next.agentPricing = require('../../shared/agentPricing').normalizeAgentPricing(settings.agentPricing);
    if (Object.hasOwn(settings, 'autoCollapseProcess') && typeof settings.autoCollapseProcess !== 'boolean') throw new Error(I18n.t('自动收起过程须为开关值'));
    for (const [key, maximum, integer] of [['tokenBudgetPerRun', 1e12, true], ['costBudgetPerRun', 1e9, false]]) {
      if (!Object.hasOwn(settings, key)) continue;
      const value = settings[key] ?? 0;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maximum || (integer && !Number.isSafeInteger(value))) {
        throw new Error(I18n.t('软预算须为有效非负数，Token 须为整数'));
      }
      next[key] = value;
    }
    if (Object.hasOwn(settings, 'historyTokenBudget')) {
      const budget = settings.historyTokenBudget ?? 0;
      if (!Number.isSafeInteger(budget) || budget < 0 || budget > 200000) throw new Error(I18n.t('旧历史 token 预算须为 0–200000 的整数'));
      next.historyTokenBudget = budget;
    }
    if (Object.hasOwn(settings, 'cliProfiles')) {
      next.cliProfiles = cliRegistry.normalizeProfiles(settings.cliProfiles);
      const available = new Set(cliRegistry.listProfiles(next).map(profile => profile.id));
      const configuredBots = [...this.bots, ...this.rooms.flatMap(room => Object.values(room.memberProfiles || {}))];
      if (configuredBots.some(bot => bot.cliType?.startsWith('custom_') && !available.has(bot.cliType))) throw new Error(I18n.t('该 CLI 仍被成员使用，请先更改成员的接入方式'));
    }
    next.enabledCliIds = cliRegistry.resolveEnabledCliIds(next, this.bots);
    if (Object.hasOwn(settings, 'agentCapabilities')) {
      if (!isRecord(settings.agentCapabilities)) throw new Error(I18n.t('Agent 扩展配置无效'));
      next.agentCapabilities = Object.fromEntries(Object.entries(settings.agentCapabilities).map(([id, choice]) => {
        if (!cliRegistry.findProfile(id, next)) throw new Error(I18n.t('CLI 接入不存在'));
        return [id, normalizeSelection(choice)];
      }));
    }
    if (Object.hasOwn(settings, 'appearance')) next.appearance = normalizeAppearance(settings.appearance);
    writeJsonAtomic(path.join(this.dataPath, 'settings.json'), next);
    this.settings = next;
    I18n.setLanguage(this.settings.language);
    return this.settings;
  }

  // ---------- sessions ----------
  getSessions() { return this.sessions; }

  setSession(botId, sessionId) {
    if (!sessionId || this.sessions[botId] === sessionId) return;
    const next = { ...this.sessions, [botId]: sessionId };
    writeJsonAtomic(path.join(this.dataPath, 'sessions.json'), next);
    this.sessions = next;
  }

  clearRoomSessions(roomId) {
    const next = Object.fromEntries(Object.entries(this.sessions).filter(([key]) => {
      try {
        const parts = JSON.parse(key);
        return !Array.isArray(parts) || parts[0] !== roomId;
      }
      catch { return true; } // Legacy bot-only IDs are not room sessions.
    }));
    if (Object.keys(next).length === Object.keys(this.sessions).length) return;
    writeJsonAtomic(path.join(this.dataPath, 'sessions.json'), next);
    this.sessions = next;
  }

  // ---------- messages ----------
  getMessages(roomId) {
    if (!this.messages.has(roomId)) {
      const file = path.join(this.dataPath, 'messages', `${roomId}.json`);
      const list = validateData(readJson(file, []), isRecordList, file);
      let recovered = false;
      for (const message of list) {
        if (message.roundRun && ['running', 'stopping'].includes(message.roundRun.status)) {
          message.roundRun = { ...message.roundRun, status: 'interrupted', endedAt: null };
          recovered = true;
        }
        if (message.status === 'streaming') {
          message.status = 'aborted';
          message.error = message.error || I18n.t('应用上次退出时发言未完成，已保留最近保存的内容');
          recovered = true;
        }
      }
      if (recovered) writeJsonAtomic(file, list);
      this.messages.set(roomId, list);
    }
    return this.messages.get(roomId);
  }

  getMessage(roomId, messageId) {
    return this.getMessages(roomId).find((m) => m.id === messageId) || null;
  }

  addMessage(roomId, msg) {
    const list = this.getMessages(roomId);
    if (list.some((m) => m.id === msg.id)) return;
    const next = [...list, msg];
    writeJsonAtomic(path.join(this.dataPath, 'messages', `${roomId}.json`), next);
    this.messages.set(roomId, next);
    this.dirty.delete(roomId);
    this.logEvent({ kind: 'message_add', roomId, id: msg.id, authorType: msg.authorType, authorId: msg.authorId });
  }

  updateMessage(roomId, messageId, patch) {
    const msg = this.getMessage(roomId, messageId);
    if (msg) {
      if (patch.status && patch.status !== 'streaming') {
        const next = this.getMessages(roomId).map((item) =>
          item.id === messageId ? { ...item, ...patch } : item);
        writeJsonAtomic(path.join(this.dataPath, 'messages', `${roomId}.json`), next);
        Object.assign(msg, patch);
        this.dirty.delete(roomId);
        return msg;
      }
      Object.assign(msg, patch);
      this.dirty.add(roomId);
    }
    return msg;
  }

  // Permanently remove a single message from the live transcript (user action).
  deleteMessage(roomId, messageId) {
    const list = this.getMessages(roomId);
    const next = list.filter((m) => m.id !== messageId);
    if (next.length === list.length) return false;
    this.clearRoomSessions(roomId);
    writeJsonAtomic(path.join(this.dataPath, 'messages', `${roomId}.json`), next);
    this.messages.set(roomId, next);
    this.dirty.delete(roomId);
    return true;
  }

  // Empty the live transcript without archiving (user action).
  clearRoom(roomId) {
    this.clearRoomSessions(roomId);
    writeJsonAtomic(path.join(this.dataPath, 'messages', `${roomId}.json`), []);
    this.messages.set(roomId, []);
    this.dirty.delete(roomId);
  }

  flushDirty() {
    const errors = [];
    for (const roomId of this.dirty) {
      const list = this.messages.get(roomId);
      try {
        if (list) writeJsonAtomic(path.join(this.dataPath, 'messages', `${roomId}.json`), list);
        this.dirty.delete(roomId);
      } catch (err) { errors.push(err); }
    }
    if (errors.length) throw new AggregateError(errors,
      I18n.tpl`消息持久化失败（${errors.length} 个房间），待重试：${errors.map((err) => err.message).join('; ')}`);
  }

  flushSync() {
    this.flushDirty();
  }

  getInitial() {
    const messagesByRoom = {};
    for (const room of this.rooms) {
      messagesByRoom[room.id] = this.getMessages(room.id);
    }
    return {
      bots: this.bots,
      rooms: this.rooms,
      settings: this.settings,
      defaults: DEFAULTS,
      messagesByRoom,
      dataPath: this.dataPath,
      currentRoomId: this.rooms[0] ? this.rooms[0].id : null,
    };
  }
}

module.exports = new Persistence();
