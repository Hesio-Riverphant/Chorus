'use strict';
const I18n = require('../../shared/i18n');

const { spawn } = require('child_process');
const { Buffer } = require('node:buffer');
const { StringDecoder } = require('string_decoder');
const { SPECS, PARSERS } = require('./cliSpecs');
const { EXTRA_SPECS, EXTRA_PARSERS } = require('./extraCliSpecs');
const { MAINSTREAM_SPECS, MAINSTREAM_PARSERS } = require('./mainstreamCliSpecs');
const { requireAppOnly, requireEnabled } = require('../cliRegistry');
const { resolveExecutable } = require('./resolveExecutable');
const { locateCliExecutable } = require('../cliDiscovery');
const { RoomEvent } = require('../../shared/constants');
const { isModelIdentifier } = require('../../shared/botProfile');
const { safeText } = require('./activities');
const { normalizeExecutionMode } = require('../../shared/reasoning');

const { terminateTree } = require('./processTree');
function killTree(pid) { return terminateTree(pid, { spawnProcess: spawn }); }

// User-defined launch contracts preserve literal argv and native credentials.
function customSpec(profile) {
  if (!profile || profile.builtin) return null;
  return { command: profile.command, promptVia: profile.promptMode, outputMode: profile.outputMode === 'text' ? 'text' : 'ndjson',
    args(bot, _sessionId, prompt) {
      const args = [...profile.args, ...profile.historyArgs];
      if (bot.model && !args.includes('{model}')) throw new Error(I18n.t('此接入参数未配置独立的 {model}；请在接入设置中添加该占位符，或选择默认模型'));
      if (args.includes('{model}') && !bot.model) throw new Error(I18n.t('此 CLI 配置包含 {model}，请先为成员填写模型'));
      return args.map(value => value === '{prompt}' ? prompt : value === '{model}' ? bot.model : value);
    } };
}
function parseCustom(chunk, emit, acc) {
  // JSONL supports the explicit public text/delta/error protocol. Other
  // structured protocols need their own adapter; never report silent success.
  let value;
  try { value = JSON.parse(chunk); } catch (_) { emit('text', chunk); return; }
  if (!value || typeof value !== 'object') { emit('text', chunk); return; }
  if (value.type === 'error' || value.error) emit('error', value.message || value.error?.message || String(value.error));
  else if (typeof value.text === 'string') emit('text', value.text);
  else if (typeof value.delta === 'string') emit('text', value.delta);
}

// Run one bot turn. Returns { promise, onEvent, cancel }.
function runBot(options) {
  const { bot, probe = false, cliSettings = {}, nativeArgs = [] } = options;
  if (bot.cliType === 'kimi') return runKimiBot(options);
  if (bot.cliType !== 'codex' || probe && !['plan', 'goal'].includes(bot.executionMode) && !options.nativeConfig) return runCliBot(options);
  if (!probe) requireEnabled(bot.cliType, cliSettings);
  requireAppOnly(bot.cliType, cliSettings);
  normalizeExecutionMode(bot.cliType, bot.executionMode);
  if (!Array.isArray(nativeArgs) || nativeArgs.length) throw new Error(I18n.t('Codex 原生扩展必须通过能力配置传入'));
  // Chat needs the same authoritative last-request/window events as plan.
  // No silent exec fallback: older servers must report an actionable failure.
  return require('./codexPlanAdapter').runCodexNative({ ...options, nativeConfig: options.nativeConfig || {} });
}

function runKimiBot(options) {
  if (options.probe) throw new Error(I18n.t('Kimi 连接测试请使用无工具提供商测试'));
  // Reject unsafe saved permissions before any native Agent starts.
  SPECS.kimi.args(options.bot, null, options.prompt);
  requireEnabled('kimi', options.cliSettings || {});
  const controller = new AbortController();
  const listeners = new Set(); let handle;
  const promise = (async () => {
    try {
      const model = await require('../kimiNative').resolveKimiModel(options.bot.model, options.cliSettings, controller.signal);
      if (controller.signal.aborted) return { text: '', error: null, aborted: true };
      handle = options.bot.reasoningEffort
        ? require('./kimiAcp').runKimiAcp({ ...options, bot: { ...options.bot, model } })
        : runCliBot({ ...options, bot: { ...options.bot, model } });
      handle.onEvent((type, data) => { for (const listener of listeners) { try { listener(type, data); } catch { /* isolate listeners */ } } });
      return await handle.promise;
    } catch (error) {
      const detail = controller.signal.aborted ? null : error.message;
      if (detail) for (const listener of listeners) { try { listener(RoomEvent.ERROR, detail); } catch { /* isolate listeners */ } }
      return { text: '', error: detail, aborted: controller.signal.aborted };
    }
  })();
  return { promise, onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async cancel() { controller.abort(); await handle?.cancel(); } };
}

// Line-oriented transports remain available for other agents, connection
// probes and offline compatibility tests of older Codex exec event streams.
function runCliBot({ bot, prompt, goalObjective, workspace, priorSessionId, log, noBytesTimeoutMs, inputTimeoutMs, probe = false, cliSettings = {}, nativeArgs = [], nativeConfig = null }) {
  if (!Array.isArray(nativeArgs) || nativeArgs.length > 128 || nativeArgs.some(value => typeof value !== 'string' || /[\x00-\x1f]/.test(value))) throw new Error(I18n.t('Agent 扩展参数无效'));
  if (!probe) requireEnabled(bot.cliType, cliSettings);
  const profile = requireAppOnly(bot.cliType, cliSettings);
  normalizeExecutionMode(bot.cliType, bot.executionMode);
  priorSessionId = null;
  if (probe && bot.cliType === 'zcode') throw new Error(I18n.t('ZCode 暂无已验证的无工具连接测试，请在原生 CLI 中验证连接'));
  if (probe) {
    bot = { ...bot, permissionMode: 'read_only' };
    priorSessionId = null;
  }
  const spec = SPECS[bot.cliType] || EXTRA_SPECS[bot.cliType] || MAINSTREAM_SPECS[bot.cliType] || customSpec(profile);
  const parse = PARSERS[bot.cliType] || EXTRA_PARSERS[bot.cliType] || MAINSTREAM_PARSERS[bot.cliType] || (profile.outputMode === 'text' ? (chunk, emit) => emit('text', chunk) : parseCustom);
  if (!spec) throw new Error(I18n.t('此 CLI 未配置运行方式'));
  // Claude/Codex may be installed as Windows .cmd/.bat wrappers. Their only
  // variable command arguments are identifiers; all free text goes via stdin.
  // Pi receives its prompt as a shell-free argv element.
  let useShell = false;
  if (bot.model != null && bot.model !== '' && !isModelIdentifier(bot.model)) {
    throw new Error(I18n.t('模型名称包含不支持的字符或格式无效'));
  }
  let executable;
  const launchCommand = locateCliExecutable(bot.cliType, cliSettings) || spec.command;
  try { executable = resolveExecutable(launchCommand); }
  catch (error) {
    // Preserve existing custom launch wrappers for identifier-only options.
    // Session-scoped extension paths/JSON must never enter cmd.exe quoting.
    if (!['claude', 'codex'].includes(bot.cliType)) throw error;
    if ([launchCommand, ...nativeArgs].some(value => /[&|<>^%!"\x00-\x1f\x7f]/.test(value))) throw new Error(I18n.t('当前 Agent 启动包装器不能安全传入此扩展路径，请使用不含特殊字符的路径或原生 EXE'));
    useShell = true;
    executable = { command: /[\s()]/.test(launchCommand) ? `"${launchCommand}"` : launchCommand, argsPrefix: [] };
  }
  const command = executable.command;
  const acc = { text: '', sessionId: priorSessionId || null, usage: null };
  const listeners = new Set();
  let protocolError = null;
  let goalProtocol;
  let inputProtocol;
  if (bot.cliType === 'claude' && bot.executionMode === 'goal') {
    goalProtocol = require('./claudeGoal').createClaudeGoal({ prompt, objective: goalObjective,
      write: value => child.stdin.write(value), end: () => child.stdin.end(), emit });
  }

  function parseLine(line) {
    if (goalProtocol || inputProtocol) {
      let value;
      try { value = JSON.parse(line); } catch (_) { return; }
      try { if (inputProtocol?.consume(value)) return; }
      catch (error) { failInput(error); return; }
      if (goalProtocol?.consume(value)) return;
    }
    parse(line, emit, acc);
  }

  function emit(type, payload) {
    if (type === 'session') return;
    if (type === 'text' && typeof payload === 'string') {
      acc.text += payload;
      type = RoomEvent.TEXT_DELTA;
    }
    if (type === 'text_replace' && typeof payload === 'string') acc.text = payload;
    if (type === 'usage') acc.usage = payload;
    if (type === 'final_answer' && payload === true) acc.finalAnswer = true;
    if (type === 'context_usage') acc.contextUsage = payload;
    if (type === RoomEvent.ERROR) {
      payload = safeText(typeof payload === 'string' ? payload : JSON.stringify(payload));
      protocolError = payload;
    }
    // Process exit is the single authoritative completion boundary.
    if (type === RoomEvent.DONE) return;
    for (const fn of listeners) {
      try { fn(type, payload); } catch (_) { /* a UI listener must not break the turn */ }
    }
  }

  let args;
  if (spec.promptVia === 'arg') args = spec.args(bot, priorSessionId, prompt);
  else args = spec.args(bot, priorSessionId);
  if (bot.cliType === 'claude') args.push('--no-session-persistence');
  if (bot.cliType === 'codex') args.push('--ephemeral');
  if (nativeArgs.length) {
    // Claude's repeatable --tools option accumulates entries. A deliberate
    // invocation restriction must replace the base allowlist, not append to it.
    if (bot.cliType === 'claude' && nativeArgs.includes('--tools')) {
      let toolsIndex;
      while ((toolsIndex = args.indexOf('--tools')) >= 0) args.splice(toolsIndex, 2);
    }
    const separator = args.indexOf('--');
    args.splice(separator < 0 ? args.length : separator, 0, ...nativeArgs.map(value => useShell ? `"${value}"` : value));
  }
  if (probe && ['claude', 'codebuddy'].includes(bot.cliType)) {
    const toolsIndex = args.indexOf('--tools');
    if (toolsIndex >= 0) args.splice(toolsIndex, 2);
    // cmd.exe must preserve the explicit empty argument for --tools.
    args.push('--tools', useShell ? '""' : '', '--strict-mcp-config');
  } else if (probe && bot.cliType === 'codex') {
    args.push('--skip-git-repo-check');
  }

  if (probe && bot.cliType === 'pi') {
    const toolsIndex = args.indexOf('--tools');
    if (toolsIndex >= 0) args.splice(toolsIndex, 2);
    args.splice(args.indexOf('--'), 0, '--no-tools');
  }

  if (process.platform === 'win32' && spec.promptVia === 'arg' &&
      [command, ...executable.argsPrefix, ...args].reduce((size, value) => size + value.length * 2 + 3, 0) > 30000) {
    throw new Error(I18n.t('该 CLI 通过命令行接收消息，本轮上下文超过 Windows 长度上限；请减少每次补历史条数或缩短消息'));
  }

  if (profile.historyModeSupport !== 'verified') queueMicrotask(() => emit('history_notice', { mode: 'native', detail: I18n.t('此 Agent 可能同时保存原生聊天记录。') }));

  const child = spawn(command, [...executable.argsPrefix, ...args], {
    cwd: workspace,
    shell: useShell,
    windowsHide: true,
    detached: process.platform !== 'win32',
    env: { ...process.env, ...(spec.env ? spec.env(bot, probe) : {}) },
  });

  let stdoutBuf = '';
  const stdoutDecoder = new StringDecoder('utf8');
  const stderrDecoder = new StringDecoder('utf8');
  let stderrParts = [], stderrDiscarded = false;
  let settled = false;
  let aborted = false;
  let timedOut = false;
  let timer = null, stopping = null, stdoutStarted = false;
  const stopTree = () => stopping ||= killTree(child.pid).then(result => {
    if (['root', 'unconfirmed'].includes(result?.scope)) acc.cleanupWarning = I18n.t('未确认所有子进程已退出，请检查系统任务管理器');
    return result;
  });
  let resolvePromise;
  const promise = new Promise((resolve) => { resolvePromise = resolve; });
  if (bot.cliType === 'claude') inputProtocol = require('./claudeInput').createClaudeInput({ prompt,
    permissionMode: bot.permissionMode, probe, goal: !!goalProtocol, inputTimeoutMs,
    write: value => child.stdin.write(value), end: () => child.stdin.end(), emit,
    onPendingChange: armTimer, onExpire: failInput, onError: failInput });

  function failInput(error) {
    if (settled || aborted || timedOut || stopping) return;
    inputProtocol?.stop({ preserveQuestions: true });
    emit(RoomEvent.ERROR, error.message);
    stopTree().finally(() => finish({ error: protocolError }));
  }

  function armTimer() {
    clearTimeout(timer);
    if (settled || aborted || timedOut || stopping || inputProtocol?.pending) return;
    timer = setTimeout(() => {
      // Mark before killing so the close handler cannot turn a timeout into a
      // successful finish (which would leave the message in a contradictory
      // state with an error string but status "done").
      timedOut = true;
      emit(RoomEvent.ERROR, I18n.t('超时：长时间无输出，已自动停止该 bot'));
      stopTree().finally(() => finish({ error: 'timeout' }));
    }, noBytesTimeoutMs || 90000);
  }
  armTimer();

  child.stdout.on('data', (d) => {
    if (settled || aborted || timedOut || stopping) return;
    armTimer();
    let decoded = stdoutDecoder.write(d);
    if (!stdoutStarted && decoded) { stdoutStarted = true; decoded = decoded.replace(/^\uFEFF/, ''); }
    if (spec.outputMode === 'text') { parse(decoded, emit, acc); return; }
    stdoutBuf += decoded;
    if (Buffer.byteLength(stdoutBuf) > 4 * 1024 * 1024) {
      protocolError = I18n.t('CLI 输出单行超过 4 MB，已停止');
      stopTree().finally(() => finish({ error: protocolError }));
      return;
    }
    let idx;
    while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (line) {
        try { parseLine(line); } catch (_) { /* ignore malformed line */ }
        // Protocol/tool payloads may contain secrets. Persist only event names;
        // normalized activity details have their own bounded/redacted channel.
        if (log) { try {
          const event = JSON.parse(line);
          log(JSON.stringify({ type: safeText(event.type, 80) }));
        } catch (_) { /* malformed/non-JSON output is not safe to persist */ } }
      }
    }
  });

  child.stderr.on('data', (d) => {
    if (settled || aborted || timedOut || stopping) return;
    armTimer();
    const s = stderrDecoder.write(d);
    if (!stderrDiscarded) {
      stderrParts.push(s);
      if (stderrParts.join('').length > 4000) { stderrParts = []; stderrDiscarded = true; }
    }
    // Redact only after decoding and joining chunks: a credential label/value
    // can span arbitrary stderr data events.
  });

  child.on('error', (err) => {
    if (settled || aborted || timedOut || stopping) return;
    emit(RoomEvent.ERROR, I18n.tpl`无法启动 ${spec.command}：${err.message}（请确认该 CLI 已安装并在 PATH 中）`);
    finish({ error: err.message });
  });

  child.on('close', (code) => {
    clearTimeout(timer);
    if (settled) return;
    // Cancellation/timeout closes may race with a final buffered response.
    // Do not replay that response after a terminal decision.
    if (aborted) { stopTree().finally(() => finish({ aborted: true })); return; }
    if (timedOut) { stopTree().finally(() => finish({ error: 'timeout' })); return; }
    if (stopping) { stopping.finally(() => finish({ error: protocolError })); return; }
    const stderrTail = stderrDecoder.end();
    if (!stderrDiscarded) stderrParts.push(stderrTail);
    const tail = stdoutDecoder.end();
    if (spec.outputMode === 'text') parse(tail, emit, acc);
    else stdoutBuf += tail;
    if (stdoutBuf.trim()) {
      try { parseLine(stdoutBuf.trim()); } catch (_) { /* ignore */ }
    }
    if (protocolError) { finish({ error: protocolError }); return; }
    if (code !== 0) {
      const diagnostic = stderrDiscarded ? I18n.tpl`CLI 错误输出过长，已省略；退出码 ${code}` : safeText(stderrParts.join('').trim(), 4000).slice(-500);
      if (log && diagnostic) { try { log(diagnostic); } catch (_) { /* logging must not crash cleanup */ } }
      emit(RoomEvent.ERROR, diagnostic || I18n.tpl`${spec.command} 异常退出（code ${code}）`);
      finish({ error: protocolError || `exit_${code}` });
      return;
    }
    if (goalProtocol && !goalProtocol.resultVerified) {
      emit(RoomEvent.ERROR, I18n.t('Claude 连接已结束，但未确认原生目标的最终状态'));
      finish({ error: protocolError }); return;
    }
    if (inputProtocol && !goalProtocol && !inputProtocol.resultVerified) {
      emit(RoomEvent.ERROR, I18n.t('Claude 未返回完整结果，请重试'));
      finish({ error: protocolError }); return;
    }
    if (['gemini', 'qwen', 'cursor', 'droid'].includes(bot.cliType) && !acc.finalAnswer) {
      emit(RoomEvent.ERROR, I18n.t('CLI 已结束但未返回可识别的回复；请检查输出协议配置'));
      finish({ error: protocolError }); return;
    }
    if (bot.cliType === 'zcode' && !acc.zcodeResult) {
      emit(RoomEvent.ERROR, I18n.t('ZCode 未返回成功结果'));
      finish({ error: protocolError }); return;
    }
    if ((!profile.builtin || ['kimi', 'codebuddy', 'opencode', 'hermes', 'gemini', 'qwen', 'copilot', 'cursor', 'droid', 'zcode'].includes(bot.cliType)) && !acc.text.trim()) {
      emit(RoomEvent.ERROR, I18n.t('CLI 已结束但未返回可识别的回复；请检查输出协议配置'));
      finish({ error: protocolError }); return;
    }
    for (const fn of listeners) {
      try { fn(RoomEvent.DONE, { code }); } catch (_) { /* listener isolation */ }
    }
    finish({});
  });

  // Deliver prompt through stdin for CLIs that support it.
  child.stdin.on('error', (err) => {
    if (!settled && !aborted && !timedOut) {
      emit(RoomEvent.ERROR, I18n.tpl`无法发送提示词：${err.message}`);
      stopTree().finally(() => finish({ error: protocolError }));
    }
  });
  if (spec.promptVia !== 'stdin') child.stdin.end();
  if (spec.promptVia === 'stdin') {
    try {
      if (goalProtocol) goalProtocol.start();
      else if (inputProtocol) inputProtocol.start();
      else { child.stdin.write(prompt); child.stdin.end(); }
    } catch (err) { child.stdin.emit('error', err); }
  }

  function finish(extra) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    inputProtocol?.stop({ preserveQuestions: !!extra?.error && !aborted });
    resolvePromise({
      text: acc.text,
      sessionId: null,
      usage: acc.usage,
      contextUsage: acc.contextUsage || null,
      ...(acc.cleanupWarning ? { cleanupWarning: acc.cleanupWarning } : {}),
      ...(goalProtocol?.goal ? { goal: goalProtocol.goal } : {}),
      ...(inputProtocol?.deferredInputs.length ? { deferredInputs: inputProtocol.deferredInputs } : {}),
      aborted: !!(extra && extra.aborted),
      error: (extra && extra.error) || null,
    });
  }

  function cancel() {
    if (settled) return Promise.resolve();
    aborted = true;
    goalProtocol?.stop();
    inputProtocol?.stop();
    clearTimeout(timer);
    return stopTree().finally(() => finish({ aborted: true }));
  }

  function onEvent(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  return { promise, onEvent, cancel, pid: child.pid,
    ...(inputProtocol ? { respondInput: (requestId, answers) => inputProtocol.respondInput(requestId, answers) } : {}) };
}

module.exports = { runBot, runCliBot, killTree, customSpec, parseCustom };
