'use strict';
const I18n = require('../../shared/i18n');

const { randomUUID } = require('node:crypto');
const { CodexRpc } = require('./codexRpc');
const { safeText, emitActivity, nextActivityOrder } = require('./activities');
const { isModelIdentifier } = require('../../shared/botProfile');
const { codexSubagents, codexChildEvent } = require('./subagents');
const { codexTokenUsage } = require('./tokenUsage');

const MAX_TEXT = 4 * 1024 * 1024;
const SANDBOX = { read_only: 'read-only', workspace: 'workspace-write', full: 'danger-full-access' };
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;

// This override is application-owned. Only capability enablement belongs here;
// runtime permissions, credentials and instructions remain with the native CLI.
function capabilityConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(I18n.t('能力配置无效'));
  const result = {};
  for (const [kind, entries] of Object.entries(value)) {
    if (!['mcp_servers', 'plugins'].includes(kind) || !entries || typeof entries !== 'object' || Array.isArray(entries)) {
      throw new Error(I18n.t('能力配置无效'));
    }
    if (Object.keys(entries).length > 256) throw new Error(I18n.t('能力配置过多'));
    result[kind] = Object.create(null);
    for (const [name, entry] of Object.entries(entries)) {
      if (!name || name.length > 256 || /[\x00-\x1f]/.test(name) || !entry || typeof entry !== 'object' ||
          Object.keys(entry).some(key => key !== 'enabled') || typeof entry.enabled !== 'boolean') throw new Error(I18n.t('能力配置无效'));
      result[kind][name] = { enabled: entry.enabled };
    }
  }
  return result;
}

// Chat/plan use temporary threads. Native goals require a persistent thread.
// Every run owns its thread; no unrelated native conversation is resumed.
// Plan mode uses Codex's actual collaboration mode, including request_user_input.
function runCodexNative({ bot, prompt, workspace, noBytesTimeoutMs = 90000, inputTimeoutMs = 30 * 60 * 1000,
  nativeConfig = {}, probe = false, cliSettings = {}, rpcFactory = options => new CodexRpc(options) }) {
  if (bot.cliType !== 'codex') throw new Error(I18n.t('原生运行仅适用于 Codex'));
  if (bot.model && !isModelIdentifier(bot.model)) throw new Error(I18n.t('模型名称格式无效'));
  if (bot.reasoningEffort && !/^[a-z][a-z0-9_-]{0,31}$/.test(bot.reasoningEffort)) throw new Error(I18n.t('推理程度格式无效'));
  if (typeof prompt !== 'string' || Buffer.byteLength(prompt) > MAX_TEXT) throw new Error(I18n.t('消息过长'));
  const config = capabilityConfig(nativeConfig);
  const isGoal = bot.executionMode === 'goal';
  if (isGoal && bot.reasoningEffort) config.model_reasoning_effort = bot.reasoningEffort;
  const rpc = rpcFactory({ cwd: workspace, cliSettings });
  const listeners = new Set();
  const messages = new Map();
  const commandOutput = new Set();
  const inputs = new Map();
  const acc = { text: '', usage: null, contextUsage: null, activities: [] };
  let messageChars = 0;
  let threadId, turnId, timer, goal, turnInProgress = false, settled = false, finishing = false, aborted = false;
  let resolve;
  const promise = new Promise(done => { resolve = done; });

  function emit(type, payload) {
    if (settled || finishing) return;
    for (const listener of listeners) { try { listener(type, payload); } catch (_) { /* listener isolation */ } }
  }
  function armTimer() {
    clearTimeout(timer);
    if (settled || finishing || [...inputs.values()].some(input => input.blocking)) return;
    timer = setTimeout(() => finish({ error: I18n.t('超时：长时间无输出，已停止 Codex') }), noBytesTimeoutMs);
  }
  async function finish(extra = {}) {
    if (settled || finishing) return;
    flushMessages(true);
    // Some native turns end with progress only. Retain that response rather
    // than replacing it with a fabricated conclusion or an empty message.
    if (!acc.text) appendText([...messages.values()].map(message => message.text).filter(Boolean).join('\n\n'));
    if (extra.error) emit('error', safeText(extra.error));
    finishing = true;
    clearTimeout(timer);
    for (const input of inputs.values()) clearTimeout(input.timer);
    inputs.clear();
    if (isGoal && threadId && (!goal || goal.status === 'active')) {
      try {
        const paused = await rpc.request('thread/goal/set', { threadId, status: 'paused' }, 1000);
        if (paused?.goal && ['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'].includes(paused.goal.status)) {
          goal = { status: paused.goal.status, tokensUsed: count(paused.goal.tokensUsed), timeUsedSeconds: count(paused.goal.timeUsedSeconds) };
        }
      } catch (_) { /* Keep the last confirmed state; close remains bounded. */ }
    }
    await rpc.close();
    settled = true;
    resolve({ text: acc.text, sessionId: null, usage: acc.usage, contextUsage: acc.contextUsage,
      ...(goal ? { goal } : {}), aborted: !!extra.aborted, error: extra.error ? safeText(extra.error) : null });
  }
  function finishGoal() {
    const reason = { paused: I18n.t('已暂停'), blocked: I18n.t('被阻塞'), usageLimited: I18n.t('达到原生用量限制'), budgetLimited: I18n.t('达到原生预算限制') }[goal?.status];
    if (reason) finish({ error: I18n.tpl`Codex 目标${reason}，可调整任务后重试` });
    else if (goal?.status === 'complete') { emit('done', {}); finish(); }
  }
  function appendText(text) {
    if (!text) return;
    if (acc.text.length + text.length > MAX_TEXT) { finish({ error: I18n.t('Codex 回复超过大小上限') }); return; }
    acc.text += text;
    emit('text_delta', text);
  }
  function activity(item, done) {
    if (!item || typeof item.id !== 'string') return;
    if (codexSubagents(item, acc, emit)) return;
    const status = item.status === 'failed' || item.error || (Number.isInteger(item.exitCode) && item.exitCode !== 0)
      ? 'error' : done ? 'done' : 'running';
    let value;
    if (item.type === 'commandExecution') value = { kind: 'command', name: I18n.t('命令'), summary: item.command,
      detail: [item.command, item.aggregatedOutput].filter(x => typeof x === 'string').join('\n') };
    else if (item.type === 'reasoning') value = { kind: 'reasoning', name: I18n.t('思考'),
      detail: Array.isArray(item.summary) ? item.summary.filter(x => typeof x === 'string').join('\n') : '' };
    else if (item.type === 'plan') value = { kind: 'tool', name: I18n.t('计划'), detail: item.text || '' };
    else if (item.type === 'mcpToolCall') value = { kind: 'tool', name: item.tool || 'MCP',
      summary: [item.server, item.tool].filter(x => typeof x === 'string').join(' / '), detail: item.error?.message || '' };
    else if (item.type === 'fileChange') value = { kind: 'tool', name: I18n.t('文件变更'),
      files: (item.changes || []).map(x => x.path).filter(x => typeof x === 'string'),
      summary: (item.changes || []).map(x => x.path).filter(x => typeof x === 'string').join(', ') };
    else if (item.type === 'webSearch') value = { kind: 'tool', name: I18n.t('搜索'), summary: item.query || '' };
    if (value) emitActivity(acc, emit, { id: item.id, status, ...value });
  }
  function messageState(id) {
    if (!messages.has(id)) {
      if (messages.size >= 1000) throw new Error(I18n.t('Codex 回复项目超过上限'));
      if (messageChars + 2 > MAX_TEXT) throw new Error(I18n.t('Codex 回复超过大小上限'));
      messages.set(id, { id, text: '', phase: null, done: false, emitted: 0, order: nextActivityOrder(acc) });
      messageChars += 2; // Reserve separators even for buffered messages.
    }
    return messages.get(id);
  }
  function updateMessageText(message, text) {
    if (messageChars + text.length - message.text.length > MAX_TEXT) throw new Error(I18n.t('Codex 回复超过大小上限'));
    messageChars += text.length - message.text.length;
    message.text = text;
  }
  function flushMessages(terminal = false) {
    for (const message of messages.values()) {
      if (message.phase === 'commentary' && message.activitySaved) continue;
      // A late completed snapshot can supply the phase. Do not leak its
      // unclassified deltas into the answer, or interleave adjacent items.
      if (!terminal && !message.done && message.phase !== 'final_answer') break;
      const delta = message.text.slice(message.emitted);
      if (delta) appendText((!message.emitted && acc.text ? '\n\n' : '') + delta);
      message.emitted = message.text.length;
      if (!terminal && !message.done) break;
    }
  }
  function publishMessage(message) {
    if (message.phase === 'final_answer' && message.text && !message.finalPublished) {
      message.finalPublished = true; emit('final_answer', true);
    }
    if (message.phase === 'commentary') {
      emitActivity(acc, emit, { id: message.id, kind: 'reasoning', phase: 'commentary', name: I18n.t('进展'),
        status: message.done ? 'done' : 'running', detail: message.text, order: message.order });
      message.activitySaved = acc.activities.some(item => item.id === message.id && item.phase === 'commentary');
      // If the bounded activity list is full, keep the text in the body.
    }
    flushMessages();
  }
  function snapshot(item, done) {
    if (!item || !['agentMessage', 'plan'].includes(item.type) || typeof item.id !== 'string') return;
    if (item.type === 'plan' && !done) return;
    const message = messageState(item.id);
    const phase = item.type === 'plan' ? 'final_answer' : ['commentary', 'final_answer'].includes(item.phase) ? item.phase : null;
    if (phase && message.phase && message.phase !== phase) throw new Error(I18n.t('Codex 回复阶段不一致，请重试'));
    if (phase && message.emitted && !message.phase && phase === 'commentary') throw new Error(I18n.t('Codex 回复阶段在完成后发生变化，请重试'));
    if (phase) message.phase = phase;
    if (typeof item.text === 'string') {
      if (item.text.startsWith(message.text)) updateMessageText(message, item.text);
      else if (done || item.text) throw new Error(I18n.t('Codex 回复内容与流式结果不一致，请重试'));
    }
    message.done ||= done;
    publishMessage(message);
  }
  function serverRequest(message) {
    const { id, method, params = {} } = message;
    if (method === 'currentTime/read') { rpc.respond(id, { currentTimeAt: Math.floor(Date.now() / 1000) }); return; }
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      rpc.respond(id, { decision: 'decline' }); return;
    }
    if (method === 'mcpServer/elicitation/request') {
      rpc.respond(id, { action: 'decline' });
      emit('activity', { id: `elicitation:${id}`, kind: 'tool', name: 'MCP', status: 'error',
        summary: I18n.t('此工具需要交互表单，请在原生 Agent 完成设置后重试'), detail: '' });
      return;
    }
    if (method !== 'item/tool/requestUserInput') { rpc.reject(id, I18n.t('Chorus 不支持此交互请求')); return; }
    if (!Array.isArray(params.questions) || !params.questions.length || params.questions.length > 10 || inputs.size >= 8) {
      rpc.reject(id, I18n.t('提问数量无效')); finish({ error: I18n.t('Codex 交互提问格式无效') }); return;
    }
    const ids = new Set();
    const questions = params.questions.map(question => {
      if (!question || typeof question.id !== 'string' || !question.id || question.id.length > 200 || ids.has(question.id) ||
          question.isSecret || typeof question.question !== 'string' ||
          (question.options != null && (!Array.isArray(question.options) || question.options.length > 20))) throw new Error(I18n.t('Codex 提问格式不受支持'));
      ids.add(question.id);
      return { id: question.id, header: safeText(question.header, 100), question: safeText(question.question, 3000),
        isOther: !!question.isOther, options: question.options?.map(option => ({ label: safeText(option.label, 200),
          description: safeText(option.description, 1000) })) || null };
    });
    const requestId = randomUUID();
    const input = { id, questions, blocking: params.isBlocking !== false,
      timer: setTimeout(() => finish({ error: I18n.t('等待回复超时，已停止 Codex；可重新发送消息') }), inputTimeoutMs) };
    inputs.set(requestId, input);
    armTimer();
    emit('input_request', { requestId, questions, isBlocking: input.blocking });
  }
  function respondInput(requestId, answers) {
    const input = inputs.get(requestId);
    if (!input || settled || finishing) throw new Error(I18n.t('该提问已结束，请重新发送消息'));
    if (!answers || typeof answers !== 'object' || Array.isArray(answers) ||
        Object.keys(answers).some(key => !input.questions.some(question => question.id === key))) throw new Error(I18n.t('回答格式无效'));
    const response = Object.create(null);
    for (const question of input.questions) {
      const values = answers[question.id]?.answers;
      if (!Array.isArray(values) || !values.length || values.length > 10 ||
          values.some(value => typeof value !== 'string' || !value.trim() || value.length > 16000)) throw new Error(I18n.t('请回答所有问题'));
      response[question.id] = { answers: values };
    }
    rpc.respond(input.id, { answers: response });
    clearTimeout(input.timer); inputs.delete(requestId);
    emit('input_resolved', { requestId });
    armTimer();
    return { ok: true };
  }
  rpc.onMessage(message => {
    if (settled || finishing || aborted) return;
    try {
      const { method, params = {} } = message;
      if (method === 'transport/error' || method === 'transport/closed') {
        finish({ error: params.message || I18n.t('Codex 连接在回复完成前结束') }); return;
      }
      if (params.threadId && params.threadId !== threadId) {
        // Accept only threads observed in this run's native dispatch events.
        if (acc.subagents?.agents.has(params.threadId)) {
          armTimer();
          if (message.id != null && method) serverRequest(message);
          else codexChildEvent(method, params, acc, emit);
        }
        return;
      }
      if (!isGoal && params.turnId && turnId && params.turnId !== turnId) return;
      armTimer();
      if (message.id != null && method) { serverRequest(message); return; }
      if (method === 'thread/goal/updated' && params.goal) {
        goal = { status: params.goal.status, tokensUsed: count(params.goal.tokensUsed), timeUsedSeconds: count(params.goal.timeUsedSeconds) };
        emit('goal_update', goal);
        if (isGoal && goal.status !== 'active' && !turnInProgress) finishGoal();
      } else if (method === 'turn/started') { turnId = params.turn?.id || turnId; turnInProgress = true; }
      else if (method === 'item/agentMessage/delta') {
        if (typeof params.delta !== 'string' || typeof params.itemId !== 'string') return;
        const message = messageState(params.itemId);
        if (message.done) return; // Completed snapshots are authoritative.
        updateMessageText(message, message.text + params.delta);
        publishMessage(message);
      } else if (method === 'item/started' || method === 'item/completed') {
        const done = method === 'item/completed';
        activity(params.item, done);
        snapshot(params.item, done);
      } else if (method === 'item/commandExecution/outputDelta') {
        const previous = acc.activities.find(item => item.id === params.itemId && item.kind === 'command');
        if (previous && typeof params.delta === 'string' && previous.status === 'running') {
          emitActivity(acc, emit, { ...previous, detail: previous.detail + (!commandOutput.has(params.itemId) && previous.detail ? '\n' : '') + params.delta });
          commandOutput.add(params.itemId);
        }
      } else if (method === 'item/reasoning/summaryTextDelta' || method === 'item/plan/delta') {
        const previous = acc.activities.find(item => item.id === params.itemId);
        emitActivity(acc, emit, { id: params.itemId, kind: method.includes('reasoning') ? 'reasoning' : 'tool',
          name: method.includes('reasoning') ? I18n.t('思考') : I18n.t('计划'), status: 'running',
          detail: (previous?.detail || '') + (typeof params.delta === 'string' ? params.delta : '') });
      } else if (method === 'thread/tokenUsage/updated' && params.tokenUsage) {
        const normalized = codexTokenUsage(params.tokenUsage);
        acc.usage = normalized.usage;
        acc.contextUsage = normalized.contextUsage;
        emit('usage', acc.usage); emit('context_usage', acc.contextUsage);
      } else if (method === 'error' && !params.willRetry) {
        finish({ error: params.error?.message || I18n.t('Codex 运行失败') });
      } else if (method === 'turn/completed') {
        const turn = params.turn || {};
        turnInProgress = false;
        if (turn.status === 'failed') finish({ error: turn.error?.message || I18n.t('Codex 运行失败') });
        else if (turn.status === 'interrupted') finish({ aborted: true });
        else if (turn.status === 'completed') {
          if (!isGoal) { emit('done', {}); finish(); }
          else if (goal && goal.status !== 'active') finishGoal();
          else { turnId = null; armTimer(); }
        }
      }
    } catch (error) { finish({ error: error.message }); }
  });
  // Defer startup so callers attach event listeners before native notifications.
  queueMicrotask(async () => {
    try {
      if (finishing || settled || aborted) return;
      armTimer();
      await rpc.initialize();
      if (finishing || settled || aborted) return;
      const started = await rpc.request('thread/start', { cwd: workspace, ephemeral: !isGoal,
        approvalPolicy: 'never', sandbox: probe ? 'read-only' : SANDBOX[bot.permissionMode] || 'read-only',
        ...(bot.model ? { model: bot.model, allowProviderModelFallback: false } : {}),
        ...(Object.keys(config).length ? { config } : {}) });
      if (finishing || settled || aborted) return;
      if (!started?.thread?.id) throw new Error(I18n.t('Codex 未返回会话标识'));
      if (isGoal && started.thread.ephemeral !== false) throw new Error(I18n.t('Codex 原生目标需要持久会话'));
      if (started.thread.ephemeral !== true || started.thread.path != null) {
        emit('history_notice', { mode: 'native', detail: isGoal ? I18n.t('目标模式使用 Codex 原生会话，记录也会保存在 Codex。') : I18n.t('Codex 本次会话可能同时保存在原生记录中。') });
      }
      threadId = started.thread.id;
      if (isGoal) {
        // Setting an active goal starts native continuation automatically. A
        // separate turn/start would create a competing turn and duplicate work.
        const response = await rpc.request('thread/goal/set', { threadId, objective: prompt, status: 'active' });
        if (!response?.goal) throw new Error(I18n.t('Codex 未确认原生目标'));
        if (!goal) {
          goal = { status: response.goal.status, tokensUsed: count(response.goal.tokensUsed), timeUsedSeconds: count(response.goal.timeUsedSeconds) };
          emit('goal_update', goal);
        }
        if (goal.status !== 'active' && !turnInProgress) finishGoal();
        return;
      }
      const params = { threadId, input: [{ type: 'text', text: prompt }] };
      if (bot.executionMode === 'plan') {
        if (!started.model) throw new Error(I18n.t('Codex 未返回当前模型，无法启动计划模式'));
        params.collaborationMode = { mode: 'plan', settings: { model: started.model,
          reasoning_effort: bot.reasoningEffort || started.reasoningEffort || null, developer_instructions: null } };
      } else if (bot.reasoningEffort) params.effort = bot.reasoningEffort;
      const response = await rpc.request('turn/start', params);
      if (!finishing && !settled) turnId = response?.turn?.id || turnId;
    } catch (error) { if (!finishing && !settled) finish({ error: error.message }); }
  });
  async function cancel() {
    if (settled || finishing) return promise;
    aborted = true;
    clearTimeout(timer);
    if (threadId && turnId) { try { await rpc.request('turn/interrupt', { threadId, turnId }, 1000); } catch (_) { /* close still kills the process */ } }
    await finish({ aborted: true });
    return promise;
  }
  return { promise, onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); }, cancel, respondInput };
}

module.exports = { runCodexNative };
