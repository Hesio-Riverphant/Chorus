'use strict';
const I18n = require('../../shared/i18n');

const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { terminateTree } = require('./processTree');
const { StringDecoder } = require('node:string_decoder');
const { resolveExecutable } = require('./resolveExecutable');
const { locateCliExecutable } = require('../cliDiscovery');
const { safeText, emitActivity } = require('./activities');
const { kimiToolSubagent } = require('./subagents');
const { validateAnswers, SKIP_ANSWER } = require('./inputAnswers');
const { createDiagnostics } = require('./diagnostics');

// Official Kimi ACP configOptions contract. Session overrides never rewrite
// config.toml or credentials. Older releases expose only on/off; reject a
// unsupported selected effort before prompting because 0.28.1 treats unknown levels as off.
function runKimiAcp({ bot, prompt, workspace, cliSettings = {}, noBytesTimeoutMs = 90000, inputTimeoutMs = 60000,
  spawnProcess = spawn, executable: suppliedExecutable }) {
  if (bot.permissionMode !== 'full') throw new Error(I18n.t('Kimi 会话需显式选择全权限'));
  const executable = suppliedExecutable || resolveExecutable(locateCliExecutable('kimi', cliSettings) || 'kimi');
  const child = spawnProcess(executable.command, [...executable.argsPrefix, 'acp'], {
    cwd: workspace, shell: false, windowsHide: true, detached: process.platform !== 'win32',
    env: { ...process.env, KIMI_DISABLE_TELEMETRY: '1', KIMI_CODE_NO_AUTO_UPDATE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map(), listeners = new Set(), acc = {}, inputs = new Map(), deferredInputs = [], diagnostics = createDiagnostics();
  let nextId = 0, sessionId, text = '', thought = '', thoughtId = 0, buffer = '', bytes = 0;
  let aborted = false, closed = false, processExited = false, failure = null, timer;
  let settled = false;
  function emit(type, value) { for (const listener of listeners) { try { listener(type, value); } catch { /* isolate UI */ } } }
  function fail(message) {
    failure ||= message;
    for (const item of pending.values()) item.reject(new Error(failure));
    pending.clear();
  }
  function write(message) {
    if (closed || !child.stdin.writable) throw new Error(I18n.t('Kimi 连接已结束'));
    const wire = JSON.stringify({ jsonrpc: '2.0', ...message });
    if (Buffer.byteLength(wire) > 4 * 1024 * 1024) throw new Error(I18n.t('Kimi 请求超过大小上限'));
    child.stdin.write(wire + '\n');
  }
  function request(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++nextId; pending.set(id, { resolve, reject });
      try { write({ id, method, params }); }
      catch (error) { pending.delete(id); reject(error); }
    });
  }
  function pulse() {
    clearTimeout(timer);
    if (inputs.size || closed) return;
    timer = setTimeout(() => { fail(I18n.t('Kimi 等待响应超时')); void close(); }, Math.max(1000, noBytesTimeoutMs));
  }
  function removeInput(requestId, reason) {
    const input = inputs.get(requestId);
    if (!input) return;
    clearTimeout(input.timer); inputs.delete(requestId);
    emit('input_resolved', { requestId, ...(reason ? { reason } : {}) });
    pulse();
  }
  function permissionRequest(message) {
    const params = message.params, tool = params?.toolCall, options = params?.options;
    const cancel = () => write({ id: message.id, result: { outcome: { outcome: 'cancelled' } } });
    // Only the native AskUserQuestion bridge is interactive in full/yolo mode.
    // An unexpected ordinary permission request never grants additional access.
    if (params?.sessionId !== sessionId || tool?.title !== 'AskUserQuestion') { cancel(); return; }
    if ([...inputs.values()].some(input => input.nativeId === message.id)) return;
    const question = Array.isArray(tool.content) ? tool.content
      .filter(block => block.type === 'content' && block.content?.type === 'text')
      .map(block => block.content.text).join('\n') : '';
    if (inputs.size >= 8 || !question.trim() || question.length > 3000 || tool.isSecret ||
        !Array.isArray(options) || !options.length || options.length > 20 ||
        options.some(option => !option || typeof option.optionId !== 'string' || !option.optionId || option.optionId.length > 300 ||
          typeof option.name !== 'string' || !option.name.trim() || option.name.length > 200 ||
          !['allow_once', 'reject_once'].includes(option.kind))) { cancel(); return; }
    const labels = options.map(option => safeText(option.name, 200));
    if (new Set(labels).size !== labels.length || new Set(options.map(option => option.optionId)).size !== options.length) { cancel(); return; }
    const requestId = randomUUID();
    const questions = [{ id: 'q0', question: safeText(question, 3000), optionOnly: true, multiSelect: false,
      options: labels.map(label => ({ label })) }];
    const input = { nativeId: message.id, questions, optionIds: options.map(option => option.optionId) };
    inputs.set(requestId, input); pulse();
    input.timer = setTimeout(() => {
      if (closed || !inputs.has(requestId)) return;
      fail(I18n.t('等待回复超时；问题已保留，回答后可继续')); void close();
    }, inputTimeoutMs);
    emit('input_request', { requestId, questions, isBlocking: true, expiresAt: Date.now() + inputTimeoutMs });
  }
  function respondInput(requestId, answers) {
    const input = inputs.get(requestId);
    if (closed || aborted || settled || !input) throw new Error(I18n.t('该提问已结束，请重新发送消息'));
    const values = validateAnswers(input.questions, answers).q0.answers;
    if (values.length === 1 && values[0] === SKIP_ANSWER) {
      write({ id: input.nativeId, result: { outcome: { outcome: 'cancelled' } } });
      removeInput(requestId);
      return { ok: true };
    }
    const index = values.length === 1 ? input.questions[0].options.findIndex(option => option.label === values[0]) : -1;
    if (index < 0) throw new Error(I18n.t('回答格式无效'));
    write({ id: input.nativeId, result: { outcome: { outcome: 'selected', optionId: input.optionIds[index] } } });
    removeInput(requestId);
    return { ok: true };
  }
  function finishThought() {
    if (!thought) return;
    emitActivity(acc, emit, { id: `kimi-thought-${thoughtId}`, kind: 'reasoning', name: I18n.t('思考'), detail: thought, status: 'done' });
    thought = ''; thoughtId += 1;
  }
  function receive(message) {
    if (!message || typeof message !== 'object') return;
    if (message.id != null && !message.method) {
      const item = pending.get(message.id); if (!item) return;
      pending.delete(message.id);
      if (message.error) item.reject(new Error(safeText(message.error.message || I18n.t('Kimi 请求失败'))));
      else item.resolve(message.result);
      return;
    }
    if (message.id != null && message.method) {
      if (message.method === 'session/request_permission') {
        permissionRequest(message);
      } else write({ id: message.id, error: { code: -32601, message: 'Client capability unavailable' } });
      return;
    }
    if (message.method !== 'session/update' || message.params?.sessionId !== sessionId) return;
    const update = message.params.update || {};
    if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
      finishThought(); text += update.content.text; emit('text_delta', update.content.text);
    } else if (update.sessionUpdate === 'agent_thought_chunk' && update.content?.type === 'text') {
      thought = safeText(thought + update.content.text);
      emitActivity(acc, emit, { id: `kimi-thought-${thoughtId}`, kind: 'reasoning', name: I18n.t('思考'), detail: thought, status: 'running' });
    } else if (['tool_call', 'tool_call_update'].includes(update.sessionUpdate) && typeof update.toolCallId === 'string') {
      finishThought();
      // Assistant prose before a tool is process output, not the final answer.
      if (text && update.sessionUpdate === 'tool_call') {
        const id = `kimi-process-${nextId++}`;
        emitActivity(acc, emit, { id, kind: 'reasoning', phase: 'commentary', name: I18n.t('执行过程'), detail: text, status: 'done' });
        if (acc.activities?.some(item => item.id === id)) { text = ''; emit('text_replace', ''); }
      }
      const prior = acc.activities?.find(item => item.id === update.toolCallId) || {};
      if (kimiToolSubagent(update, acc, emit)) return;
      const blocks = Array.isArray(update.content) ? update.content : [];
      const detail = blocks.filter(item => item.type === 'content' && item.content?.type === 'text').map(item => item.content.text).join('\n');
      emitActivity(acc, emit, { ...prior, id: update.toolCallId, kind: update.kind === 'execute' ? 'command' : prior.kind || 'tool',
        name: update.title || prior.name || I18n.t('工具'), detail: detail || prior.detail || '',
        status: update.status === 'completed' ? 'done' : update.status === 'failed' ? 'error' : prior.status || 'running',
        files: blocks.filter(item => item.type === 'diff' && typeof item.path === 'string').map(item => item.path) });
    }
  }
  const decoder = new StringDecoder('utf8');
  child.stdout.on('data', chunk => {
    if (closed) return;
    pulse(); bytes += chunk.length;
    if (bytes > 8 * 1024 * 1024) { fail(I18n.t('Kimi 输出超过大小上限')); void close(); return; }
    buffer += decoder.write(chunk);
    let newline;
    while (!closed && (newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      try { receive(JSON.parse(line.replace(/^\uFEFF/, ''))); } catch { fail(I18n.t('Kimi 返回了无效协议数据')); void close(); }
    }
  });
  child.stderr.on('data', chunk => { if (!closed) diagnostics.push(chunk); });
  child.stdin.on('error', () => fail(I18n.t('Kimi 输入通道已关闭')));
  child.on('error', () => fail(I18n.t('无法启动 Kimi Code')));
  child.on('close', code => {
    if (processExited) return;
    processExited = true;
    if (!closed && code !== 0) fail(I18n.t('Kimi 连接已结束'));
    if (!closed) {
      buffer += decoder.end();
      if (buffer.trim()) { try { receive(JSON.parse(buffer.replace(/^\uFEFF/, ''))); } catch { fail(I18n.t('Kimi 返回了无效协议数据')); } }
    }
    closed = true; clearTimeout(timer);
    if (pending.size) fail(I18n.t('Kimi 连接已结束'));
  });
  let closing;
  function close() {
    if (closing) return closing;
    closing = (async () => {
      clearTimeout(timer);
      const alreadyClosed = closed; closed = true;
      for (const [requestId, input] of inputs) {
        if (!aborted) deferredInputs.push({ requestId, questions: input.questions, status: 'deferred' });
        removeInput(requestId, aborted ? 'cancelled' : 'deferred');
      }
      if (alreadyClosed) { child.stdin.destroy(); return; }
      fail(I18n.t('Kimi 连接已关闭'));
      const cleanup = await terminateTree(child.pid, { spawnProcess, killProcess: (pid, signal) => {
        if (pid === child.pid) child.kill(signal); else process.kill(pid, signal);
      } });
      if (['root', 'unconfirmed'].includes(cleanup?.scope)) acc.cleanupWarning = I18n.t('未确认所有子进程已退出，请检查系统任务管理器');
      child.stdin.destroy();
    })();
    return closing;
  }
  pulse();
  const promise = (async () => {
    let result;
    try {
      await request('initialize', { protocolVersion: 1, clientInfo: { name: 'chorus', version: require('../../../package.json').version }, clientCapabilities: {} });
      let session = await request('session/new', { cwd: workspace, mcpServers: [] });
      sessionId = session?.sessionId;
      if (typeof sessionId !== 'string' || !sessionId) throw new Error(I18n.t('Kimi 未创建会话'));
      if (bot.model) session = await request('session/set_config_option', { sessionId, configId: 'model', value: bot.model });
      if (bot.reasoningEffort) {
        const option = session.configOptions?.find(item => item.id === 'thinking');
        const values = (option?.options || []).flatMap(item => item.options || [item]).map(item => item.value);
        if (!values.includes(bot.reasoningEffort)) throw new Error(I18n.t('当前 Kimi CLI 未提供所选推理档位；请更新原生 Kimi Code，或选择其支持的开启/关闭/默认'));
        const configured = await request('session/set_config_option', { sessionId, configId: 'thinking', value: bot.reasoningEffort });
        if (configured?.configOptions?.find(item => item.id === 'thinking')?.currentValue !== bot.reasoningEffort) throw new Error(I18n.t('Kimi 未应用所选推理程度'));
      }
      await request('session/set_config_option', { sessionId, configId: 'mode', value: 'yolo' });
      const outcome = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] });
      finishThought();
      if (aborted) throw new Error(I18n.t('Kimi 会话已取消'));
      if (failure) throw new Error(failure);
      if (inputs.size) throw new Error(I18n.t('Kimi 未完成本轮回复'));
      if (outcome?.stopReason !== 'end_turn') throw new Error(outcome?.stopReason === 'cancelled' ? I18n.t('Kimi 会话已取消') : I18n.t('Kimi 未完成本轮回复'));
      if (!text.trim()) throw new Error(I18n.t('Kimi 未返回最终回复'));
      emit('final_answer', true);
      result = { text, activities: acc.activities || [], aborted: false, error: null };
    } catch (error) {
      const detail = aborted ? null : safeText([error.message, diagnostics.text()].filter(Boolean).join('\n'), 20000);
      if (detail) emit('error', detail);
      result = { text, activities: acc.activities || [], aborted, error: detail };
    } finally { settled = true; await close(); }
    return { ...result, ...(deferredInputs.length ? { deferredInputs } : {}), ...(acc.cleanupWarning ? { cleanupWarning: acc.cleanupWarning } : {}) };
  })();
  return { promise, respondInput, onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async cancel() { if (settled) return close(); aborted = true; if (sessionId && !closed) { try { write({ method: 'session/cancel', params: { sessionId } }); } catch {} } await close(); } };
}

module.exports = { runKimiAcp };
