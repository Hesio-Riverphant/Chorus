'use strict';
const I18n = require('../../shared/i18n');
// Keep application notices translatable without rewriting persisted chat text.
const systemText = (parts, ...values) => ({ parts: [...parts], values });

const path = require('path');
const persistence = require('../store/persistence');
const { runBot } = require('../adapters/cliAdapter');
const { requireAppOnly, requireEnabled } = require('../cliRegistry');
const { upsertActivity } = require('../adapters/activities');
const { calculateCost } = require('./pricing');
const UsageBudget = require('./usageBudget');
const { resolveTargets } = require('./router');
const { buildPrompt, isTranscriptMessage, selectTranscript, audienceFor } = require('./transcript');
const references = require('../skills/skillReferences');
const nativeCapabilities = require('../nativeCapabilities');
const { normalizeMode } = require('../../shared/conversationMode');
const { normalizeExecutionMode } = require('../../shared/reasoning');
const { validateAnswers } = require('../adapters/inputAnswers');
const { parseMentions } = require('../../shared/mention');
const { estimateTokens, uid } = require('../../shared/util');
const {
  AuthorType, MessageStatus, RunStatus, SpeakMode,
  DEFAULTS, RoomEvent,
} = require('../../shared/constants');

const ROOT = path.join(__dirname, '..', '..', '..');

class Orchestrator {
  constructor() {
    this.runs = new Map(); // roomId -> run context
    this.inputHandles = new Map();
    this.pendingInputs = new Map();
    this.emit = () => {};
  }

  setEmitter(fn) { this.emit = fn; }
  getPendingInputs(roomId) {
    const live = [...this.pendingInputs.values()];
    if (!roomId) return live;
    const deferred = persistence.getMessages(roomId).filter(message => !message.supersededBy).flatMap(message =>
      (message.deferredInputs || []).filter(input => input.status === 'deferred').map(input => ({
        ...input, kind: 'input_request', roomId, messageId: message.id, botId: message.authorId,
      })));
    return [...live.filter(input => input.roomId === roomId), ...deferred];
  }

  respondInput({ roomId, messageId, requestId, answers }) {
    const entry = this.inputHandles.get(messageId);
    if (entry && entry.roomId === roomId && this.isBusy(roomId)) return entry.handle.respondInput(requestId, answers);
    if (this.isBusy(roomId)) throw new Error(I18n.t('房间仍在运行，请先停止或等待完成'));
    const message = persistence.getMessage(roomId, messageId);
    const input = message?.deferredInputs?.find(value => value.requestId === requestId && value.status === 'deferred');
    if (!input || message.supersededBy) throw new Error(I18n.t('该问题已结束，请刷新聊天'));
    const response = validateAnswers(input.questions, answers);
    const room = persistence.listRooms().find(value => value.id === roomId);
    if (!room || room.archivedAt) throw new Error(I18n.t('请先恢复归档房间'));
    const bot = this.roomMembers(room).find(value => value.id === message.authorId && value.enabled !== false);
    if (!bot) throw new Error(I18n.t('该成员已不在房间或已禁用'));
    const original = persistence.getMessage(roomId, message.roundId)?.text || '';
    const text = `@${bot.name}\n` + I18n.t('继续之前等待回答的任务。先核对已完成的操作，避免重复执行。') + '\n' +
      JSON.stringify({ originalRequest: original, partialResponse: message.text || '',
        answers: input.questions.map(question => ({ question: question.question, answer: response[question.id].answers })) });
    // A closed native process cannot be resumed invisibly. Start an explicit,
    // targeted continuation and retain the prior transcript and partial output.
    const operation = this.handleHuman(roomId, text, { targetBotId: bot.id, mode: message.mode || bot.executionMode });
    const patch = { deferredInputs: message.deferredInputs.map(value => value.requestId === requestId ? { ...value, status: 'answered' } : value) };
    persistence.updateMessage(roomId, messageId, patch);
    this.emit({ kind: 'message_update', roomId, id: messageId, patch });
    this.emit({ kind: 'input_resolved', roomId, messageId, requestId });
    return operation.catch(error => {
      const restored = { deferredInputs: message.deferredInputs.map(value => value.requestId === requestId ? { ...value, status: 'deferred' } : value) };
      persistence.updateMessage(roomId, messageId, restored);
      this.emit({ kind: 'message_update', roomId, id: messageId, patch: restored });
      throw error;
    });
  }

  isBusy(roomId) { return roomId ? this.runs.has(roomId) : this.runs.size > 0; }

  getActiveRuns() {
    return [...this.runs.values()].map((run) => ({ roomId: run.roomId, ...this.runSnapshot(run) }));
  }

  async stopAll() { await Promise.all([...this.runs.keys()].map((id) => this.stop(id))); }

  finishRun(run) {
    if (run.stopping && run.status !== RunStatus.ERROR) run.status = RunStatus.STOPPED;
    else if (run.status === RunStatus.RUNNING) run.status = RunStatus.DONE;
    run.endedAt = Date.now();
    try { this.emitRun(run); }
    finally {
      if (this.runs.get(run.roomId) === run) this.runs.delete(run.roomId);
      run.resolveFinished();
    }
  }

  // Independent members of a room (global bot definitions projected through
  // the room's own botIds).
  roomMembers(room) {
    if (!room) return [];
    return persistence.roomMembers(room);
  }

  // ---------- public API ----------

  async handleHuman(roomId, text, options = {}) {
    if (this.isBusy(roomId)) throw new Error(I18n.t('房间仍在运行，请先停止或等待完成'));
    const room = persistence.listRooms().find((r) => r.id === roomId);
    if (!room) return;
    if (room.archivedAt) throw new Error(I18n.t('请先恢复归档房间'));
    const mode = normalizeMode(options.mode);
    const explicitTarget = options.targetBotId && this.roomMembers(room).find(bot => bot.id === options.targetBotId && bot.enabled !== false);
    if (options.targetBotId && !explicitTarget) throw new Error(I18n.t('该成员已不在房间或已禁用'));
    const modeTargetIds = this.validateModeTargets(room, explicitTarget ? `@${explicitTarget.name}` : text, mode);
    const addressed = resolveTargets({ room, text, mode, bots: this.roomMembers(room) });
    const audienceBotIds = explicitTarget ? [explicitTarget.id] : addressed.via === 'mention' ? addressed.targets.map(bot => bot.id) : null;

    const human = {
      id: uid('msg_'),
      roomId,
      authorType: AuthorType.HUMAN,
      authorId: 'owner',
      text,
      ...(options.targetBotId ? { targetBotId: options.targetBotId } : {}),
      ...(audienceBotIds ? { audienceBotIds } : {}),
      ...(mode ? { mode, modeTargetIds } : {}),
      mentions: [],
      status: MessageStatus.DONE,
      usage: null,
      replyToId: null,
      roundId: null,
      createdAt: Date.now(),
    };
    persistence.addMessage(roomId, human);
    this.emit({ kind: 'message_add', roomId, message: human });

    return this.continueHuman(roomId, human.id);
  }

  async continueHuman(roomId, messageId) {
    if (this.isBusy(roomId)) throw new Error(I18n.t('房间仍在运行，请先停止或等待完成'));
    const room = persistence.listRooms().find((record) => record.id === roomId);
    if (!room) throw new Error(I18n.t('房间不存在'));
    const list = persistence.getMessages(roomId);
    const human = list.at(-1);
    if (!human || human.id !== messageId || human.authorType !== AuthorType.HUMAN || human.status !== MessageStatus.DONE) {
      throw new Error(I18n.t('只能从当前最后一条已保存的人类消息重新生成'));
    }
    const text = human.text;
    const mode = normalizeMode(human.mode);
    const explicitTarget = human.targetBotId && this.roomMembers(room).find(bot => bot.id === human.targetBotId && bot.enabled !== false);
    if (human.targetBotId && !explicitTarget) throw new Error(I18n.t('该成员已不在房间或已禁用'));
    const modeTargetIds = this.validateModeTargets(room, explicitTarget ? `@${explicitTarget.name}` : text, mode);
    if (mode) {
      persistence.updateMessage(roomId, human.id, { mode, modeTargetIds });
      this.emit({ kind: 'message_update', roomId, id: human.id, patch: { mode, modeTargetIds } });
    }

    const resolved = resolveTargets({
      text, mode,
      bots: this.roomMembers(room),
      room,
    });
    const audienceBotIds = audienceFor(human, list, this.roomMembers(room));
    const targets = (human.targetBotId ? this.roomMembers(room).filter(bot => bot.id === human.targetBotId && bot.enabled !== false) : resolved.targets)
      .filter(bot => !Array.isArray(audienceBotIds) || audienceBotIds.includes(bot.id));
    const via = human.targetBotId ? 'mention' : resolved.via;

    const run = {
      id: uid('run_'),
      roomId,
      roundId: human.id,
      wave: 0,
      calls: 0,
      edges: {},
      tokens: 0,
      cost: 0,
      status: RunStatus.RUNNING,
      targets, mode, modeTargetIds, audienceBotIds,
      active: new Set(),
      stopping: false,
      via,
      skillBlocks: this.skillBlocksForText(text),
    };
    this.initializeBudget(run);
    run.finished = new Promise((resolve) => { run.resolveFinished = resolve; });
    this.runs.set(roomId, run);

    try {
      this.emitRun(run);
      await this.runWave(run, targets, true);
      await this.relayLoop(run);
    } catch (err) {
      await this.failRun(run, err);
    } finally {
      this.finishRun(run);
    }
  }

  async failRun(run, err) {
    if (this.runs.get(run.roomId) !== run) return;
    const reason = (err && err.message) || String(err);
    run.stopping = true; // stops any in-flight pumps
    await Promise.all([...run.active].map((h) => h.cancel().catch(() => {})));
    run.status = RunStatus.ERROR;
    this.systemNote(run, systemText`运行异常已中止：${reason}`);
    this.emitRun(run);
  }

  async stop(roomId) {
    const run = this.runs.get(roomId);
    if (!run) return;
    if (run.stopping) return run.finished;
    run.stopping = true;
    run.status = RunStatus.STOPPING;
    this.emitRun(run);

    await Promise.all([...run.active].map((h) => h.cancel().catch(() => {})));

    // Mark every unfinished bot message in this run as aborted.
    const list = persistence.getMessages(roomId);
    for (const msg of list) {
      if (msg.roundId === run.roundId && msg.authorType === AuthorType.BOT &&
          (msg.status === MessageStatus.STREAMING)) {
        persistence.updateMessage(roomId, msg.id, { status: MessageStatus.ABORTED });
        this.emit({ kind: 'message_update', roomId, id: msg.id, patch: { status: MessageStatus.ABORTED } });
      }
    }

    await run.finished;
  }

  async retry(roomId, messageId) {
    if (this.isBusy(roomId)) throw new Error(I18n.t('房间仍在运行，请先停止或等待完成'));
    const failed = persistence.getMessage(roomId, messageId);
    if (!failed || failed.authorType !== AuthorType.BOT || failed.supersededBy ||
        ![MessageStatus.ERROR, MessageStatus.ABORTED].includes(failed.status)) {
      throw new Error(I18n.t('只能重试尚未被替代的失败或中断消息'));
    }
    const room = persistence.listRooms().find((r) => r.id === roomId);
    const bot = this.roomMembers(room).find((b) => b.id === failed.authorId && b.enabled !== false);
    if (!bot) throw new Error(I18n.t('该成员已不在房间或已禁用'));

    const newId = uid('msg_');
    const slice = this.catchupSlice(roomId, failed.roundId, bot);
    // Only the initial human-directed turn receives that message's skills.
    // Preserve the scope on retries so retrying a relay cannot acquire them.
    const skillScope = failed.skillScope || ((failed._wave || 0) === 0 ? 'human' : 'relay');
    const human = persistence.getMessage(roomId, failed.roundId);
    const skillBlocks = skillScope === 'human' && human && human.authorType === AuthorType.HUMAN
      ? this.skillBlocksForText(human.text) : [];
    const run = this.miniRun(roomId, failed.roundId, { mode: failed.mode || human?.mode,
      modeTargetIds: failed.modeTargetIds || human?.modeTargetIds,
      audienceBotIds: audienceFor(failed, persistence.getMessages(roomId), this.roomMembers(room)) });
    try {
      if (this.canDispatch(run, [bot])) {
        persistence.updateMessage(roomId, messageId, { supersededBy: newId });
        this.emit({ kind: 'message_update', roomId, id: messageId, patch: { supersededBy: newId } });
        await this.runTurn(bot, run, slice, { messageId: newId, supersedes: failed.id, skillBlocks, skillScope });
        await this.relayLoop(run);
      }
    } catch (err) {
      await this.failRun(run, err);
    } finally {
      this.finishRun(run);
    }
  }

  validateModeTargets(room, text, mode) {
    if (!mode || mode === 'chat') return [];
    const { targets } = resolveTargets({ room, text, mode, bots: this.roomMembers(room) });
    if (!targets.length) throw new Error(I18n.t('请先添加并启用接收此模式的房间成员'));
    for (const bot of targets) {
      try { normalizeExecutionMode(bot.cliType, mode); }
      catch (error) { throw new Error(`${bot.name}：${error.message}`); }
    }
    return targets.map(bot => bot.id);
  }

  miniRun(roomId, roundId, modeState = {}) {
    const run = {
      id: uid('run_'), roomId, roundId, calls: 0, edges: {}, tokens: 0, cost: 0,
      status: RunStatus.RUNNING, stopping: false, active: new Set(),
      wave: 0, ...modeState,
    };
    this.initializeBudget(run);
    run.finished = new Promise((resolve) => { run.resolveFinished = resolve; });
    this.runs.set(roomId, run);
    try { this.emitRun(run); }
    catch (error) { this.runs.delete(roomId); run.resolveFinished(); throw error; }
    return run;
  }

  // ---------- wave execution ----------

  async runWave(run, targets, isKick) {
    if (!targets.length) return [];
    const room = persistence.listRooms().find((r) => r.id === run.roomId);
    // The kick wave follows the configured speak mode. Relay waves keep
    // ordering for sequential/host rooms (an @ is itself a "naming"); only
    // parallel rooms fan out.
    const mode = isKick
      ? room.speakMode
      : room.speakMode === SpeakMode.PARALLEL ? SpeakMode.PARALLEL : SpeakMode.SEQUENTIAL;

    if (mode === SpeakMode.SEQUENTIAL || mode === SpeakMode.HOST) {
      let order;
      if (mode === SpeakMode.HOST && isKick && !['plan', 'goal'].includes(run.mode) && run.via !== 'mention' && run.via !== 'all') {
        // No explicit addressee: only the moderator speaks / names someone.
        order = [this.moderatorBot(run.roomId)].filter(Boolean);
      } else {
        order = [...targets];
      }

      const completed = [];
      for (const bot of order) {
        if (run.stopping) break;
        if (!this.canDispatch(run, order.slice(order.indexOf(bot)))) break;
        const slice = this.sliceFor(run, bot);
        const entry = await this.runTurn(bot, run, slice, {
          skillBlocks: isKick ? run.skillBlocks : [],
        });
        if (entry) completed.push(entry);
      }
      return completed;
    }

    // Parallel with bounded concurrency.
    const queue = [...targets];
    const completed = [];
    const limit = DEFAULTS.maxParallel;

    async function pump(orchestrator) {
      while (queue.length && !run.stopping) {
        if (!orchestrator.canDispatch(run, queue)) return;
        const bot = queue.shift();
        const slice = orchestrator.sliceFor(run, bot);
        const entry = await orchestrator.runTurn(bot, run, slice, {
          skillBlocks: isKick ? run.skillBlocks : [],
        });
        if (entry) completed.push(entry);
      }
    }

    const workers = Array.from({ length: Math.min(limit, queue.length) }, () => pump(this));
    try {
      await Promise.all(workers);
    } catch (error) {
      // Keep ownership until every worker has settled, even if storage fails.
      run.stopping = true;
      await Promise.allSettled([...run.active].map((handle) => handle.cancel()));
      await Promise.allSettled(workers);
      throw error;
    }
    return completed;
  }

  async relayLoop(run) {
    while (!run.stopping && run.status === RunStatus.RUNNING) {
      // Build next targets from the latest bot messages.
      const list = persistence.getMessages(run.roomId);
      const waveMessages = list.filter(
        (m) => m.authorType === AuthorType.BOT && m.roundId === run.roundId &&
          m.runId === run.id && m._wave === run.wave && !m.supersededBy && m.status === MessageStatus.DONE,
      );

      const next = this.nextTargets(run, waveMessages);

      if (!next.length) { run.status = RunStatus.DONE; break; }

      run.wave += 1;
      if (run.wave > this.maxAutoTurns(run.roomId)) {
        this.guardNote(run, systemText`已达最大自动接力轮次（${this.maxAutoTurns(run.roomId)}），如需继续请手动发起；未发言：${next.map((b) => b.name).join('、')}`);
        run.status = RunStatus.BUDGET;
        run.stopReason = 'auto_turns';
        break;
      }
      if (!this.canDispatch(run, next)) break;

      this.emitRun(run);
      await this.runWave(run, next, false);
    }

  }

  // ---------- target / guard helpers ----------

  nextTargets(run, waveMessages) {
    const room = persistence.listRooms().find((r) => r.id === run.roomId);
    const bots = this.roomMembers(room).filter((b) => b.enabled !== false);
    const ids = [];
    const edgeNotes = [];

    for (const msg of waveMessages) {
      const mentions = parseMentions(msg.text, bots);
      let targets = mentions.includes('all')
        ? bots.map((b) => b.id)
        : mentions.filter((x) => x !== 'all');

      for (const target of targets) {
        if (Array.isArray(run.audienceBotIds) && !run.audienceBotIds.includes(target)) continue;
        if (['plan', 'goal'].includes(run.mode) && !(run.modeTargetIds || []).includes(target)) {
          if (msg.authorId !== (room.moderatorBotId || bots[0]?.id)) continue;
          run.modeTargetIds = [...(run.modeTargetIds || []), target];
          for (const scoped of persistence.getMessages(run.roomId).filter(item => item.id === run.roundId || item.roundId === run.roundId)) {
            persistence.updateMessage(run.roomId, scoped.id, { modeTargetIds: [...run.modeTargetIds] });
            this.emit({ kind: 'message_update', roomId: run.roomId, id: scoped.id, patch: { modeTargetIds: [...run.modeTargetIds] } });
          }
        }
        if (target === msg.authorId) continue; // a bot does not hand off to itself
        const key = `${msg.authorId}:${target}`;
        run.edges[key] = (run.edges[key] || 0) + 1;
        if (run.edges[key] > this.setting('perEdgeMentionCap')) {
          const tb = bots.find((b) => b.id === target);
          edgeNotes.push(systemText`已忽略 ${this.botName(msg.authorId, room)} 对 ${tb ? tb.name : I18n.t('某 bot')} 的重复 @（超过单边上限 ${this.setting('perEdgeMentionCap')} 次）`);
          continue;
        }
        if (!ids.includes(target)) ids.push(target);
      }
    }

    edgeNotes.forEach((n) => this.systemNote(run, n));

    // Budget pre-check: list targets that will be skipped.
    const result = ids
      .map((id) => bots.find((b) => b.id === id))
      .filter(Boolean);

    return result;
  }

  maxAutoTurns(roomId) {
    const s = this.setting('maxAutoTurns');
    if (s != null && s !== 'auto') return s;
    // Default = number of this room's independent members.
    const room = persistence.listRooms().find((r) => r.id === roomId);
    return this.roomMembers(room).filter((b) => b.enabled !== false).length;
  }

  moderatorBot(roomId) {
    const room = persistence.listRooms().find((r) => r.id === roomId);
    const bots = this.roomMembers(room).filter((b) => b.enabled !== false);
    return bots.find((b) => b.id === room.moderatorBotId) || bots[0];
  }

  botName(id, room) {
    const b = this.roomMembers(room).find(x => x.id === id) || persistence.listBots().find((x) => x.id === id);
    return b ? b.name : I18n.t('某 bot');
  }

  setting(key) {
    const s = persistence.getSettings();
    return s[key] != null ? s[key] : DEFAULTS[key];
  }

  guardNote(run, text) { this.systemNote(run, text); }

  initializeBudget(run) {
    const tokenLimit = this.setting('tokenBudgetPerRun'), costLimit = this.setting('costBudgetPerRun');
    run.budgetLimits = {
      tokenLimit: Number.isSafeInteger(tokenLimit) && tokenLimit > 0 ? tokenLimit : 0,
      costLimit: Number.isFinite(costLimit) && costLimit > 0 ? costLimit : 0,
    };
    // Retries keep the original human round's spend, including failed/superseded
    // attempts. A new human message starts a separate allowance in this room.
    run.budgetEntries = new Map(persistence.getMessages(run.roomId)
      .filter(message => message.authorType === AuthorType.BOT && message.roundId === run.roundId)
      .map(message => [message.id, message.budgetUsage || {
        tokens: message.usage && message.usage.inputEstimated === false && message.usage.outputEstimated === false &&
          Number.isSafeInteger(message.usage.tokens) && message.usage.tokens >= 0 ? message.usage.tokens : null,
        cost: message.costInfo?.costSource && message.costInfo.costSource !== 'none' ? message.costInfo.cost : null,
      }]));
  }

  budgetSnapshot(run) {
    return UsageBudget.summary(run.budgetEntries?.values() || [], run.budgetLimits || {});
  }

  recordBudgetUsage(run, message, bot, usage, prices) {
    if (!run.budgetEntries) this.initializeBudget(run);
    const previous = run.budgetEntries.get(message.id) || {};
    const reported = UsageBudget.reportedUsage(usage || {}, bot, message.createdAt, prices);
    // A final response may omit counters already reported by streaming events.
    const budgetUsage = { tokens: reported.tokens ?? previous.tokens ?? null,
      cost: reported.cost ?? previous.cost ?? null,
      costSource: reported.cost != null ? reported.costSource : previous.costSource || 'none' };
    run.budgetEntries.set(message.id, budgetUsage);
    persistence.updateMessage(run.roomId, message.id, { budgetUsage });
    return budgetUsage;
  }

  canDispatch(run, pending, reserved = false) {
    if (run.stopping || !(reserved ? [RunStatus.RUNNING, RunStatus.BUDGET] : [RunStatus.RUNNING]).includes(run.status)) return false;
    let reason, stopReason;
    if (!reserved && run.calls >= this.setting('maxCliCallsPerRun')) { reason = I18n.t('已达每次 run 最大 CLI 调用数'); stopReason = 'calls'; }
    const budget = this.budgetSnapshot(run);
    if (!reason && budget.tokenLimit > 0 && budget.reportedTokens >= budget.tokenLimit) { reason = I18n.t('已报告 Token 达到本轮软上限'); stopReason = 'tokens'; }
    if (!reason && budget.costLimit > 0 && budget.reportedCost >= budget.costLimit) { reason = I18n.t('已报告用量费用达到本轮软上限'); stopReason = 'cost'; }
    if (!reason) return true;
    run.status = RunStatus.BUDGET;
    run.stopReason = stopReason;
    this.guardNote(run, systemText`${reason}；未发言：${pending.map((b) => b.name).join('、')}。已开始的任务继续完成。`);
    return false;
  }

  // Resolve selected native references for this human turn only.
  skillBlocksForText(text) {
    const requested = [...String(text || '').matchAll(/(^|[\s])\/([A-Za-z0-9_.\-]+)/g)].map((match) => match[2]);
    if (!requested.length) return [];
    const registered = references.list(persistence.getDataPath());
    const byReference = new Map(registered.map((record) => [record.alias.toLowerCase(), record.alias]));
    const names = [];
    for (const name of requested) {
      const real = byReference.get(name.toLowerCase());
      if (real && !names.includes(real)) names.push(real);
    }
    return names.map((name) => ({ mode: 'reference', name, alias: name }));
  }

  systemNote(run, content) {
    const metadata = content && typeof content === 'object' && Array.isArray(content.parts) ? content : null;
    const text = metadata ? metadata.parts.map((part, index) => part + (index < metadata.values.length ? String(metadata.values[index] ?? '') : '')).join('') : content;
    const msg = {
      id: uid('msg_'),
      roomId: run.roomId,
      authorType: AuthorType.SYSTEM,
      authorId: 'system',
      ...(run.mode ? { mode: run.mode, modeTargetIds: [...(run.modeTargetIds || [])] } : {}),
      ...(Array.isArray(run.audienceBotIds) ? { audienceBotIds: [...run.audienceBotIds] } : {}),
      text,
      ...(metadata ? { i18n: metadata } : {}),
      status: MessageStatus.DONE,
      roundId: run.roundId,
      createdAt: Date.now(),
    };
    persistence.addMessage(run.roomId, msg);
    this.emit({ kind: 'message_add', roomId: run.roomId, message: msg });
  }

  emitRun(run) {
    if (!Number.isFinite(run.startedAt)) run.startedAt = Date.now();
    const human = persistence.getMessage(run.roomId, run.roundId);
    if (human?.authorType === AuthorType.HUMAN && (human.roundRun?.id !== run.id || run.endedAt)) {
      const roundRun = { id: run.id, startedAt: run.startedAt, endedAt: run.endedAt || null, status: run.status, stopReason: run.stopReason || null, budget: this.budgetSnapshot(run) };
      if (JSON.stringify(human.roundRun) !== JSON.stringify(roundRun)) {
        // Persist boundaries immediately; elapsed display must survive a clean restart.
        persistence.updateMessage(run.roomId, human.id, { roundRun, status: human.status });
        this.emit({ kind: 'message_update', roomId: run.roomId, id: human.id, patch: { roundRun } });
      }
    }
    this.emit({
      kind: 'run_update',
      roomId: run.roomId,
      run: this.runSnapshot(run),
    });
  }

  runSnapshot(run) {
    return {
      id: run.id, status: run.status === RunStatus.BUDGET && !run.endedAt ? RunStatus.RUNNING : run.status,
      dispatchStopped: run.status === RunStatus.BUDGET, wave: run.wave, calls: run.calls,
      stopReason: run.stopReason || null,
      roundId: run.roundId, startedAt: run.startedAt, endedAt: run.endedAt || null,
      tokens: run.tokens, cost: run.cost, stopping: run.stopping, budget: this.budgetSnapshot(run),
      mode: run.mode || 'chat', modeTargetIds: run.modeTargetIds || [],
    };
  }

  // ---------- slices ----------

  sliceFor(run, bot) {
    return this.catchupSlice(run.roomId, run.roundId, bot);
  }

  catchupSlice(roomId, roundId, bot) {
    const list = persistence.getMessages(roomId);
    const room = persistence.listRooms().find(record => record.id === roomId);
    return selectTranscript(list, bot, this.roomMembers(room), { roundId,
      catchupMessages: this.setting('catchupMessages'), historyTokenBudget: this.setting('historyTokenBudget') }).messages;
  }

  isTranscriptMessage(message) {
    return isTranscriptMessage(message);
  }

  sessionFor(roomId, bot) {
    const room = persistence.listRooms().find((r) => r.id === roomId);
    const workspace = bot.cwd || (room && room.cwd) || this.setting('defaultCwd') || ROOT;
    const key = JSON.stringify([roomId, bot.id]);
    const config = JSON.stringify([bot.cliType, bot.model, bot.persona, bot.role, workspace, bot.permissionMode]);
    // Room transcript is authoritative; never resume a native CLI session.
    const record = null;
    return { key, config, workspace, record };
  }

  // ---------- single turn ----------

  async runTurn(bot, run, slice, opts) {
    opts = opts || {};
    if (run.mode) bot = { ...bot, executionMode: run.mode };
    if (!slice || !slice.length) {
      this.systemNote(run, systemText`${bot.name} 没有新的消息需要处理，已跳过`);
      return null;
    }

    const agentPricing = structuredClone(persistence.getSettings().agentPricing || {});
    const session = this.sessionFor(run.roomId, bot);
    const priorSessionId = session.record ? session.record.id : null;
    const room = persistence.listRooms().find((r) => r.id === run.roomId) || null;
    let prompt;

    const message = {
      id: opts.messageId || uid('msg_'),
      roomId: run.roomId,
      authorType: AuthorType.BOT,
      authorId: bot.id,
      text: '',
      status: MessageStatus.STREAMING,
      error: null,
      usage: null,
      activities: [],
      supersedes: opts.supersedes || null,
      roundId: run.roundId,
      runId: run.id,
      _wave: run.wave || 0,
      ...(run.mode ? { mode: run.mode, modeTargetIds: [...(run.modeTargetIds || [])] } : {}),
      ...(Array.isArray(run.audienceBotIds) ? { audienceBotIds: [...run.audienceBotIds] } : {}),
      skillScope: opts.skillScope || ((run.wave || 0) === 0 ? 'human' : 'relay'),
      createdAt: Date.now(),
    };
    persistence.addMessage(run.roomId, message);
    run.budgetEntries?.set(message.id, { tokens: null, cost: null });
    run.calls += 1;
    this.emit({ kind: 'message_add', roomId: run.roomId, message });
    this.emitRun(run);

    let handle;
    let result;
    let extensions;
    let preparation;
    try {
      normalizeExecutionMode(bot.cliType, bot.executionMode);
      requireEnabled(bot.cliType, persistence.getSettings());
      requireAppOnly(bot.cliType, persistence.getSettings());
      const skillBlocks = [];
      for (const skill of opts.skillBlocks || []) {
        try {
          skillBlocks.push(skill.mode === 'reference'
            ? references.resolve(persistence.getDataPath(), { alias: skill.alias, cliType: bot.cliType }) : skill);
        } catch (error) {
          this.systemNote(run, systemText`${bot.name}：${error.message}。已跳过此技能引用，普通回答继续。`);
          skillBlocks.push({ mode: 'unavailable', name: skill.alias || skill.name, reason: error.message });
        }
      }
      prompt = buildPrompt(bot, slice, this.roomMembers(room), room, skillBlocks);
      if (nativeCapabilities.normalizeSelection(bot.nativeCapabilities).mode === 'selected') {
        const controller = new AbortController();
        preparation = { cancel: async () => controller.abort() };
        run.active.add(preparation);
        extensions = await nativeCapabilities.prepare(bot, session.workspace, { signal: controller.signal });
        run.active.delete(preparation);
      } else extensions = { nativeArgs: [], nativeConfig: null, cleanup() {} };
      for (const warning of extensions.warnings || []) this.systemNote(run, `${bot.name}：${warning}`);
      if (run.stopping) throw new Error(I18n.t('运行已停止'));
      if (!this.canDispatch(run, [bot], true)) throw new Error(I18n.t('本轮已停止派发新任务'));
      handle = runBot({
        bot,
        prompt,
        goalObjective: bot.executionMode === 'goal' ? persistence.getMessage(run.roomId, run.roundId)?.text : undefined,
        workspace: session.workspace,
        priorSessionId,
        cliSettings: persistence.getSettings(),
        log: (line) => persistence.logCli(bot.name, line),
        noBytesTimeoutMs: DEFAULTS.noBytesTimeoutMs,
        nativeArgs: extensions.nativeArgs, nativeConfig: extensions.nativeConfig,
      });
      run.active.add(handle);
      if (handle.respondInput) this.inputHandles.set(message.id, { roomId: run.roomId, handle });

      handle.onEvent((type, payload) => {
        if (run.stopping) return;
        if (type === 'input_request' || type === 'input_resolved') {
          const event = { ...payload, kind: type, roomId: run.roomId, messageId: message.id, botId: bot.id };
          const key = message.id + ':' + payload.requestId;
          if (type === 'input_request') this.pendingInputs.set(key, event);
          else this.pendingInputs.delete(key);
          this.emit(event);
        } else if (type === 'goal_update' || type === 'history_notice') {
          const patch = type === 'goal_update' ? { goal: payload } : { historyNotice: payload };
          persistence.updateMessage(run.roomId, message.id, patch);
          this.emit({ kind: 'message_update', roomId: run.roomId, id: message.id, patch });
        } else if (type === 'context_usage') {
          persistence.updateMessage(run.roomId, message.id, { contextUsage: payload });
          this.emit({ kind: 'message_update', roomId: run.roomId, id: message.id, patch: { contextUsage: payload } });
        } else if (type === RoomEvent.USAGE) {
          this.recordBudgetUsage(run, message, bot, payload, agentPricing);
          this.emitRun(run);
          persistence.updateMessage(run.roomId, message.id, { usage: payload });
          this.emit({ kind: 'message_update', roomId: run.roomId, id: message.id, patch: { usage: payload } });
        } else if (type === 'text_replace' || type === 'final_answer') {
          const patch = type === 'text_replace' ? { text: payload } : { finalAnswer: payload === true };
          persistence.updateMessage(run.roomId, message.id, patch);
          this.emit({ kind: 'message_update', roomId: run.roomId, id: message.id, patch });
        } else if (type === RoomEvent.TEXT_DELTA) {
          persistence.updateMessage(run.roomId, message.id, { text: message.text + payload });
          this.emit({ kind: 'message_delta', roomId: run.roomId, id: message.id, text: payload });
        } else if (type === RoomEvent.ERROR) {
          persistence.updateMessage(run.roomId, message.id, { error: payload });
        } else if (type === RoomEvent.ACTIVITY) {
          const activities = upsertActivity(message.activities, payload);
          const patch = { activities, ...(payload.status === 'running' && message.finalAnswer ? { finalAnswer: false } : {}) };
          persistence.updateMessage(run.roomId, message.id, patch);
          this.emit({ kind: 'message_update', roomId: run.roomId, id: message.id, patch });
        }
      });

      result = await handle.promise;
    } catch (error) {
      result = { text: message.text, error: error.message || String(error),
        ...(!handle ? { usage: { inputTokens: 0, outputTokens: 0, tokens: 0 } } : {}) };
    } finally {
      if (preparation) run.active.delete(preparation);
      this.inputHandles.delete(message.id);
      for (const [key, pending] of this.pendingInputs) if (pending.messageId === message.id) this.pendingInputs.delete(key);
      if (handle) run.active.delete(handle);
      try { if (extensions) extensions.cleanup(); }
      catch (_) { this.systemNote(run, systemText`临时扩展设置未能清理；本次回复与用量已保留。`); }
    }

    // Cancellation suppresses streaming events, but a native goal pause response
    // remains authoritative and must replace the last in-flight active state.
    if (result.cleanupWarning) this.systemNote(run, `${bot.name}：${result.cleanupWarning}`);
    if (result.deferredInputs?.length && !run.stopping) {
      const patch = { deferredInputs: result.deferredInputs };
      persistence.updateMessage(run.roomId, message.id, patch);
      this.emit({ kind: 'message_update', roomId: run.roomId, id: message.id, patch });
      for (const input of result.deferredInputs) this.emit({ ...input, kind: 'input_request', roomId: run.roomId,
        messageId: message.id, botId: bot.id });
    }
    if (result.goal) {
      persistence.updateMessage(run.roomId, message.id, { goal: result.goal });
      this.emit({ kind: 'message_update', roomId: run.roomId, id: message.id, patch: { goal: result.goal } });
    }

    // Display can estimate missing token counts; the independent budget ledger
    // uses native reports only and retains explicit unknown counters.
    const u = result.usage || {};
    this.recordBudgetUsage(run, message, bot, u, agentPricing);
    const nativeUsage = Object.fromEntries(['cachedInputTokens', 'cacheCreationInputTokens', 'reasoningTokens'].filter(key => Number.isSafeInteger(u[key]) && u[key] >= 0).map(key => [key, u[key]]));
    nativeUsage.inputEstimated = !Number.isSafeInteger(u.inputTokens) || u.inputTokens < 0;
    nativeUsage.outputEstimated = !Number.isSafeInteger(u.outputTokens) || u.outputTokens < 0;
    // Final snapshots also cover cancellation, which suppresses streamed UI events.
    if (result.contextUsage) {
      persistence.updateMessage(run.roomId, message.id, { contextUsage: result.contextUsage });
      this.emit({ kind: 'message_update', roomId: run.roomId, id: message.id, patch: { contextUsage: result.contextUsage } });
    }
    const inputTokens = nativeUsage.inputEstimated ? estimateTokens(prompt) : u.inputTokens;
    const outputTokens = nativeUsage.outputEstimated ? estimateTokens(result.text) : u.outputTokens;
    const tokens = Number.isSafeInteger(u.tokens) && u.tokens >= 0 ? u.tokens : inputTokens + outputTokens;

    const costInfo = calculateCost(bot, u, inputTokens, outputTokens, this.setting('costMode'), message.createdAt, agentPricing);
    const { cost, estimated } = costInfo;
    // Preserve pricing provenance with each new message; old messages remain untouched.
    persistence.updateMessage(run.roomId, message.id, { costInfo });
    const activities = (message.activities || []).map((activity) => activity.status === 'running'
      ? { ...activity, status: activity.kind === 'subagent' ? 'unknown' : run.stopping || result.aborted ? 'aborted' : result.error ? 'error' : 'done' } : activity);
    persistence.updateMessage(run.roomId, message.id, { activities });
    this.emit({ kind: 'message_update', roomId: run.roomId, id: message.id, patch: { activities, costInfo } });

    run.tokens += tokens;
    if (cost != null) run.cost += cost;


    if (run.stopping || result.aborted) {
      persistence.updateMessage(run.roomId, message.id, {
        status: MessageStatus.ABORTED,
        text: result.text || message.text,
        usage: { inputTokens, outputTokens, tokens, cost, estimated, ...nativeUsage },
      });
      this.emit({ kind: 'message_update', roomId: run.roomId, id: message.id, patch: { status: MessageStatus.ABORTED, text: result.text || message.text, usage: { inputTokens, outputTokens, tokens, cost, estimated, ...nativeUsage } } });
      return { bot, message, result };
    }

    if (result.error) {
      persistence.updateMessage(run.roomId, message.id, {
        status: MessageStatus.ERROR,
        text: result.text || message.text,
        error: result.error,
        usage: { inputTokens, outputTokens, tokens, cost, estimated, ...nativeUsage },
      });
      this.systemNote(run, systemText`${bot.name} 已停止：${result.error}（可重试此消息，或 @该成员携带中断上下文继续）`);
      this.emit({ kind: 'message_update', roomId: run.roomId, id: message.id, patch: { status: MessageStatus.ERROR, text: result.text || message.text, error: result.error, usage: { inputTokens, outputTokens, tokens, cost, estimated, ...nativeUsage } } });
      return { bot, message, result };
    }

    persistence.updateMessage(run.roomId, message.id, {
      status: MessageStatus.DONE,
      text: result.text,
      usage: { inputTokens, outputTokens, tokens, cost, estimated, ...nativeUsage },
    });
    this.emit({ kind: 'message_update', roomId: run.roomId, id: message.id, patch: { status: MessageStatus.DONE, text: result.text, usage: { inputTokens, outputTokens, tokens, cost, estimated, ...nativeUsage } } });
    this.emitRun(run);

    return { bot, message, result };
  }
}

module.exports = new Orchestrator();
