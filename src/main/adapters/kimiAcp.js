'use strict';
const I18n = require('../../shared/i18n');

const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { resolveExecutable } = require('./resolveExecutable');
const { locateCliExecutable } = require('../cliDiscovery');
const { safeText, emitActivity } = require('./activities');

// Official Kimi ACP configOptions contract. Session overrides never rewrite
// config.toml or credentials. Older releases expose only on/off; reject a
// missing effort before prompting because 0.28.1 treats unknown levels as off.
function runKimiAcp({ bot, prompt, workspace, cliSettings = {}, noBytesTimeoutMs = 90000,
  spawnProcess = spawn, executable: suppliedExecutable }) {
  if (bot.permissionMode !== 'full') throw new Error(I18n.t('Kimi 会话需显式选择全权限'));
  const executable = suppliedExecutable || resolveExecutable(locateCliExecutable('kimi', cliSettings) || 'kimi');
  const child = spawnProcess(executable.command, [...executable.argsPrefix, 'acp'], {
    cwd: workspace, shell: false, windowsHide: true, detached: process.platform !== 'win32',
    env: { ...process.env, KIMI_DISABLE_TELEMETRY: '1', KIMI_CODE_NO_AUTO_UPDATE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map(), listeners = new Set(), acc = {};
  let nextId = 0, sessionId, text = '', thought = '', thoughtId = 0, buffer = '', bytes = 0;
  let aborted = false, closed = false, failure = null, timer;
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
    timer = setTimeout(() => { fail(I18n.t('Kimi 等待响应超时')); void close(); }, Math.max(1000, noBytesTimeoutMs));
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
      // Auto mode was explicitly selected. Unexpected interactive requests are
      // rejected, including questions, rather than silently granting access.
      if (message.method === 'session/request_permission') {
        write({ id: message.id, result: { outcome: { outcome: 'cancelled' } } });
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
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      try { receive(JSON.parse(line)); } catch { fail(I18n.t('Kimi 返回了无效协议数据')); }
    }
  });
  child.stderr.on('data', () => {});
  child.stdin.on('error', () => fail(I18n.t('Kimi 输入通道已关闭')));
  child.on('error', () => fail(I18n.t('无法启动 Kimi Code')));
  child.on('close', () => { closed = true; fail(I18n.t('Kimi 连接已结束')); });
  let closing;
  function close() {
    if (closing) return closing;
    closing = (async () => {
      clearTimeout(timer);
      if (closed) return;
      closed = true; fail(I18n.t('Kimi 连接已关闭'));
      if (process.platform === 'win32' && Number.isInteger(child.pid)) {
        await new Promise(resolve => {
          const killer = spawnProcess('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          const deadline = setTimeout(() => { killer.kill(); child.kill(); resolve(); }, 5000);
          const done = () => { clearTimeout(deadline); resolve(); };
          killer.once('close', done); killer.once('error', () => { child.kill(); done(); });
        });
      } else if (process.platform !== 'win32' && Number.isInteger(child.pid)) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      } else child.kill();
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
      const option = session.configOptions?.find(item => item.id === 'thinking');
      const values = (option?.options || []).flatMap(item => item.options || [item]).map(item => item.value);
      if (!values.includes(bot.reasoningEffort)) throw new Error(I18n.t('当前 Kimi CLI 未提供所选推理档位；请更新原生 Kimi Code，或选择其支持的开启/关闭/默认'));
      const configured = await request('session/set_config_option', { sessionId, configId: 'thinking', value: bot.reasoningEffort });
      if (configured?.configOptions?.find(item => item.id === 'thinking')?.currentValue !== bot.reasoningEffort) throw new Error(I18n.t('Kimi 未应用所选推理程度'));
      await request('session/set_config_option', { sessionId, configId: 'mode', value: 'auto' });
      const outcome = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] });
      finishThought();
      if (outcome?.stopReason !== 'end_turn') throw new Error(outcome?.stopReason === 'cancelled' ? I18n.t('Kimi 会话已取消') : I18n.t('Kimi 未完成本轮回复'));
      if (!text.trim()) throw new Error(I18n.t('Kimi 未返回最终回复'));
      emit('final_answer', true);
      result = { text, activities: acc.activities || [], aborted: false, error: null };
    } catch (error) {
      const detail = aborted ? null : safeText(error.message);
      if (detail) emit('error', detail);
      result = { text, activities: acc.activities || [], aborted, error: detail };
    } finally { await close(); }
    return result;
  })();
  return { promise, onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async cancel() { aborted = true; if (sessionId && !closed) { try { write({ method: 'session/cancel', params: { sessionId } }); } catch {} } await close(); } };
}

module.exports = { runKimiAcp };
