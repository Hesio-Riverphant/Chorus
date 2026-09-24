'use strict';
const I18n = require('../../shared/i18n');

const { PermissionMode } = require('../../shared/constants');
const { emitActivity, safeText } = require('./activities');
const { normalizeEffort, normalizeExecutionMode } = require('../../shared/reasoning');
const { claudeSubagent, codexSubagents } = require('./subagents');
const { tokenCount, claudeContextUsage } = require('./tokenUsage');
const { claudeText } = require('./claudeText');

// Per-CLI definitions: how to build arguments and parse NDJSON output.
// Prompt delivery: 'stdin' (preferred, avoids quoting/length limits) or 'arg'.

function permissionFlagsClaude(mode) {
  switch (mode) {
    case PermissionMode.FULL:
      return ['--permission-mode', 'bypassPermissions'];
    case PermissionMode.READ_ONLY:
      // Tool restriction, not an OS sandbox. Explicitly deny MCP tools since
      // a user's native allowlist can otherwise approve a mutating MCP tool.
      return ['--permission-mode', 'dontAsk', '--tools', 'Read,Grep,Glob', '--disallowedTools', 'mcp__*'];
    case PermissionMode.WORKSPACE:
    default:
      // Windows has no OS sandbox; acceptEdits auto-approves file edits.
      return ['--permission-mode', 'acceptEdits'];
  }
}

function claudeArgs(bot, sessionId) {
  let args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--forward-subagent-text'];
  if (bot.executionMode === 'goal') args.push('--input-format', 'stream-json', '--permission-prompts', 'none');
  args = args.concat(normalizeExecutionMode('claude', bot.executionMode) === 'plan'
    ? ['--permission-mode', 'plan', ...(bot.permissionMode === PermissionMode.READ_ONLY
      ? ['--tools', 'Read,Grep,Glob', '--disallowedTools', 'mcp__*'] : [])] : permissionFlagsClaude(bot.permissionMode));
  if (bot.model) args.push('--model', bot.model);
  const effort = normalizeEffort('claude', bot.reasoningEffort, bot.model);
  if (effort) args.push('--effort', effort);
  if (sessionId) args.push('--resume', sessionId);
  return args;
}

function codexArgs(bot, sessionId) {
  normalizeExecutionMode('codex', bot.executionMode);
  // `codex exec resume` has a different flag surface than `codex exec`:
  // it does not accept -s/--sandbox (the resumed thread keeps its original
  // sandbox) and the new prompt must be passed as "-" to be read from stdin.
  let args;
  if (sessionId) {
    args = ['exec', 'resume', sessionId, '-'];
    if (bot.permissionMode === PermissionMode.FULL) {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    }
  } else {
    args = ['exec'];
    if (bot.permissionMode === PermissionMode.FULL) {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    } else if (bot.permissionMode === PermissionMode.READ_ONLY) {
      args.push('-s', 'read-only');
    } else {
      args.push('-s', 'workspace-write');
    }
  }
  if (bot.model) args.push('-m', bot.model);
  const effort = normalizeEffort('codex', bot.reasoningEffort, bot.model);
  if (effort) args.push('-c', `model_reasoning_effort=${effort}`);
  args.push('--json');
  return args;
}

function kimiArgs(bot, sessionId, prompt) {
  if (bot.permissionMode !== PermissionMode.FULL) throw new Error(I18n.t('Kimi 无交互模式会自动执行工具；请在成员设置中选择全权限后重试'));
  let args = ['-p', prompt, '--output-format', 'stream-json'];
  if (bot.model) args.push('-m', bot.model);
  if (sessionId) args.push('-S', sessionId);
  // Kimi Code 0.28.1 print mode is already automatic and rejects --auto.
  return args;
}

function codebuddyArgs(bot, _sessionId, prompt) {
  // https://www.codebuddy.ai/docs/cli/cli-reference (2026-09-24).
  // Source-documented contract; installation/account availability is discovered.
  const args = ['--print', prompt, '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--no-session-persistence'];
  args.push(...permissionFlagsClaude(bot.permissionMode));
  if (bot.model) args.push('--model', bot.model);
  return args;
}

const SPECS = {
  claude: { command: 'claude', promptVia: 'stdin', args: claudeArgs },
  codex: { command: 'codex', promptVia: 'stdin', args: codexArgs },
  kimi: { command: 'kimi', promptVia: 'arg', args: kimiArgs },
  codebuddy: { command: 'codebuddy', promptVia: 'arg', args: codebuddyArgs },
};

// ---------- parsers: emit(type, payload) ----------

function parseClaude(line, emit, acc) {
  let o;
  try { o = JSON.parse(line); } catch (_) { return; }

  if (claudeSubagent(o, acc, emit)) return;
  claudeText(o, acc, emit);

  if (o.type === 'system' && o.session_id) emit('session', o.session_id);

  // Partial stream events and the final assistant envelope describe the same
  // request. Merge snapshots by message id, never add them a second time.
  const event = o.type === 'stream_event' ? o.event : null;
  if (event?.type === 'message_start') {
    acc.usageMessageId = event.message?.id;
    acc.usageModel = event.message?.model || null;
  }
  const usageMessage = o.type === 'assistant' ? o.message : event?.type === 'message_start' ? event.message :
    event?.type === 'message_delta' ? { id: acc.usageMessageId, model: acc.usageModel, usage: event.usage } : null;
  if (usageMessage?.usage) {
    acc.cum = acc.cum || { in: 0, cacheCreate: 0, cacheRead: 0, out: 0 };
    acc.messageUsage = acc.messageUsage || new Map();
    const prior = acc.messageUsage.get(usageMessage.id) || {};
    const u = { ...prior, ...Object.fromEntries(Object.entries(usageMessage.usage).filter(([, value]) => tokenCount(value) !== null)) };
    if (tokenCount(u.input_tokens) !== null) acc.claudeInputReported = true;
    if (tokenCount(u.output_tokens) !== null) acc.claudeOutputReported = true;
    if (Number.isFinite(u.cache_read_input_tokens)) acc.cacheReadReported = true;
    if (Number.isFinite(u.cache_creation_input_tokens)) acc.cacheCreateReported = true;
    for (const [key, field] of Object.entries({ in: 'input_tokens', cacheCreate: 'cache_creation_input_tokens', cacheRead: 'cache_read_input_tokens', out: 'output_tokens' })) {
      acc.cum[key] += (u[field] || 0) - (prior[field] || 0);
    }
    if (usageMessage.id) acc.messageUsage.set(usageMessage.id, u);
    acc.lastModelUsage = u;
    acc.lastModel = usageMessage.model || acc.lastModel;
    acc.contextUsage = claudeContextUsage(u);
    emit('context_usage', acc.contextUsage);
    emit('usage', {
      ...(acc.claudeInputReported ? { inputTokens: acc.cum.in + acc.cum.cacheCreate + acc.cum.cacheRead } : {}),
      ...(acc.claudeOutputReported ? { outputTokens: acc.cum.out } : {}),
      ...(acc.claudeInputReported && acc.claudeOutputReported ? { tokens: acc.cum.in + acc.cum.cacheCreate + acc.cum.cacheRead + acc.cum.out } : {}),
      ...(acc.cacheReadReported ? { cachedInputTokens: acc.cum.cacheRead } : {}),
      ...(acc.cacheCreateReported ? { cacheCreationInputTokens: acc.cum.cacheCreate } : {}), cumulative: true,
    });
  }

  if (o.type === 'stream_event') {
    const e = o.event;
    if (e && e.type === 'message_start') acc.activityMessage = e.message && e.message.id;
    if (e && e.type === 'content_block_start') {
      const block = e.content_block || {};
      if (block.type === 'tool_use' && !['Agent', 'Task'].includes(block.name)) {
        emitActivity(acc, emit, { id: block.id, kind: 'tool', name: block.name,
          status: 'running', summary: I18n.tpl`调用 ${block.name || I18n.t('工具')}`, detail: '' });
      } else if (block.type === 'thinking') {
        acc.thinkingActivity = `${acc.activityMessage || 'claude'}:thinking:${e.index}`;
        emitActivity(acc, emit, { id: acc.thinkingActivity, kind: 'reasoning', name: I18n.t('思考'),
          status: 'running', summary: I18n.t('思考'), detail: block.thinking || '' });
      }
    }
    if (e && e.type === 'content_block_delta' && e.delta && e.delta.type === 'thinking_delta' && acc.thinkingActivity) {
      const previous = (acc.activities || []).find((item) => item.id === acc.thinkingActivity);
      if (previous) emitActivity(acc, emit, { ...previous, detail: previous.detail + (e.delta.thinking || '') });
    }
    if (e && e.type === 'content_block_stop' && acc.thinkingActivity) {
      const previous = (acc.activities || []).find((item) => item.id === acc.thinkingActivity);
      if (previous) emitActivity(acc, emit, { ...previous, status: 'done' });
      acc.thinkingActivity = null;
    }
  }

  if ((o.type === 'assistant' || o.type === 'user') && o.message && Array.isArray(o.message.content)) {
    for (const block of o.message.content) {
      if (block.type === 'tool_use' && !['Agent', 'Task'].includes(block.name)) {
        const command = block.input && typeof block.input.command === 'string' ? block.input.command : '';
        emitActivity(acc, emit, { id: block.id, kind: command ? 'command' : 'tool', name: block.name,
          status: 'running', summary: I18n.tpl`调用 ${block.name || I18n.t('工具')}`, detail: command,
          ...(['Edit', 'Write', 'MultiEdit'].includes(block.name) && typeof block.input?.file_path === 'string' ? { files: [block.input.file_path] } : {}) });
      } else if (block.type === 'tool_result') {
        if (acc.subagents?.agents.has(block.tool_use_id)) continue;
        const previous = (acc.activities || []).find((item) => item.id === block.tool_use_id);
        const output = typeof block.content === 'string' ? block.content : '';
        emitActivity(acc, emit, { ...previous, id: block.tool_use_id, kind: previous ? previous.kind : 'tool',
          name: previous ? previous.name : I18n.t('工具'), status: block.is_error ? 'error' : 'done',
          summary: block.is_error ? I18n.t('工具执行失败') : I18n.t('工具执行完成'),
          detail: previous && previous.kind === 'command' ? [previous.detail, output].filter(Boolean).join('\n') : output });
      } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
        emitActivity(acc, emit, { id: `${o.message.id || 'claude'}:thinking:${o.message.content.indexOf(block)}`,
          kind: 'reasoning', name: I18n.t('思考'), status: 'done', summary: I18n.t('思考'), detail: block.thinking });
      }
    }
  }

  if (o.type === 'result') {
    acc.sessionId = o.session_id || acc.sessionId;
    if (o.is_error) emit('error', o.error || o.result || o.subtype || 'Claude Code error');

    const ru = Object.fromEntries(Object.entries(o.usage || {}).filter(([, value]) => tokenCount(value) !== null));
    // modelUsage is cumulative by model; only its window is usable here.
    // Never turn cumulative result usage into a current-context percentage.
    const window = tokenCount(o.modelUsage?.[acc.lastModel]?.contextWindow);
    if (acc.lastModelUsage && window) {
      acc.contextUsage = claudeContextUsage(acc.lastModelUsage, window);
      emit('context_usage', acc.contextUsage);
    }
    let inputTokens;
    let outputTokens;
    if (acc.cum && (acc.cum.in || acc.cum.cacheCreate || acc.cum.cacheRead || acc.cum.out)) {
      inputTokens = acc.cum.in + acc.cum.cacheCreate + acc.cum.cacheRead;
      outputTokens = acc.cum.out;
    } else {
      inputTokens = (ru.input_tokens || 0) + (ru.cache_read_input_tokens || 0) + (ru.cache_creation_input_tokens || 0);
      outputTokens = ru.output_tokens || 0;
    }
    inputTokens = Math.max(inputTokens, (ru.input_tokens || 0) + (ru.cache_read_input_tokens || 0) + (ru.cache_creation_input_tokens || 0));
    outputTokens = Math.max(outputTokens, ru.output_tokens || 0);
    // Never undercount the CLI's own reported totals.
    if (ru.total_tokens && ru.total_tokens > inputTokens + outputTokens) {
      outputTokens = ru.total_tokens - inputTokens;
    }
    emit('usage', {
      ...(acc.claudeInputReported || tokenCount(ru.input_tokens) !== null ? { inputTokens } : {}),
      ...(acc.claudeOutputReported || tokenCount(ru.output_tokens) !== null ? { outputTokens } : {}),
      ...(((acc.claudeInputReported || tokenCount(ru.input_tokens) !== null) && (acc.claudeOutputReported || tokenCount(ru.output_tokens) !== null)) ? { tokens: inputTokens + outputTokens } : {}),
      ...((acc.cacheReadReported || Number.isFinite(ru.cache_read_input_tokens)) ? { cachedInputTokens: Math.max(acc.cum?.cacheRead || 0, ru.cache_read_input_tokens || 0) } : {}),
      ...((acc.cacheCreateReported || Number.isFinite(ru.cache_creation_input_tokens)) ? { cacheCreationInputTokens: Math.max(acc.cum?.cacheCreate || 0, ru.cache_creation_input_tokens || 0) } : {}),
      // Raw CLI-reported cost; the orchestrator decides per costMode whether to use it.
      cliCost: typeof o.total_cost_usd === 'number' ? o.total_cost_usd : null,
      apiCost: Number.isFinite(o.usage?.cost) && o.usage.cost >= 0 ? o.usage.cost : null,
      cumulative: !!acc.cum,
    });
    emit('done', { stopReason: o.subtype });
  }
}

function parseCodex(line, emit, acc) {
  let o;
  try { o = JSON.parse(line); } catch (_) { return; }
  const t = String(o.type || '');

  if (t === 'session_configured' && o.session_id) emit('session', o.session_id);
  if (t === 'thread.started' && o.thread_id) emit('session', o.thread_id);

  if (['item.started', 'item.updated', 'item.completed'].includes(t) && o.item) {
    const item = o.item;
    if (codexSubagents(item, acc, emit)) return;
    const status = item.status === 'failed' || item.error || (typeof item.exit_code === 'number' && item.exit_code !== 0)
      ? 'error' : t === 'item.completed' || item.status === 'completed' ? 'done' : 'running';
    if (item.type === 'command_execution') {
      emitActivity(acc, emit, { id: item.id, kind: 'command', name: I18n.t('命令'), status,
        summary: safeText(item.command || I18n.t('执行命令'), 240),
        detail: [item.command, item.aggregated_output].filter((text) => typeof text === 'string').join('\n') });
    } else if (item.type === 'mcp_tool_call' || item.type === 'tool_call') {
      emitActivity(acc, emit, { id: item.id, kind: 'tool', name: item.tool || item.name || I18n.t('工具'), status,
        summary: [item.server, item.tool || item.name].filter((text) => typeof text === 'string').join(' / '),
        detail: item.error && typeof item.error.message === 'string' ? item.error.message : '' });
    } else if (item.type === 'reasoning') {
      emitActivity(acc, emit, { id: item.id, kind: 'reasoning', name: I18n.t('思考'), status,
        summary: I18n.t('思考'), detail: typeof item.text === 'string' ? item.text : '' });
    }
  }

  if (t === 'item.started' && o.item && o.item.type === 'agent_message') {
    acc.agentMessageId = o.item.id;
    acc.fullText = '';
  }

  if ((t === 'item.updated' || t === 'item.completed') && o.item && o.item.type === 'agent_message') {
    if (o.item.id && o.item.id !== acc.agentMessageId) {
      acc.agentMessageId = o.item.id;
      acc.fullText = '';
    }
    const text = typeof o.item.text === 'string' ? o.item.text : '';
    const prev = acc.fullText || '';
    if (text.startsWith(prev)) emit('text', text.slice(prev.length));
    else { acc.fullText = ''; emit('text', text); }
    acc.fullText = text;
  }

  if (t === 'item.delta' && o.delta) {
    const d = o.delta;
    if ((d.type === 'agent_message_delta' || d.type === 'output_text_delta') && typeof d.text === 'string') {
      emit('text', d.text);
      acc.fullText = (acc.fullText || '') + d.text;
    }
  }

  if (t === 'item' && o.item && o.item.type === 'agent_message' && typeof o.item.text === 'string') {
    if (!acc.fullText) { acc.fullText = o.item.text; emit('text', o.item.text); }
  }

  // Incremental usage is a snapshot of the current turn; completed turns add
  // to the invocation total without counting the incremental snapshot twice.
  if (t === 'turn.completed' || t === 'turn.completed.incremental') {
    const u = o.usage || {};
    const inT = tokenCount(u.inputTokens ?? u.input_tokens);
    const outT = tokenCount(u.outputTokens ?? u.output_tokens);
    const totT = tokenCount(u.totalTokens ?? u.total_tokens);
    if (inT === null && outT === null && totT === null) return;
    acc.cx = acc.cx || { in: 0, out: 0 };
    acc.cxCompleted = acc.cxCompleted || { in: 0, out: 0 };
    const cached = tokenCount(u.cachedInputTokens ?? u.cached_input_tokens);
    if (cached !== null) { acc.cx.cached = Math.max(acc.cx.cached || 0, cached); acc.cxCacheReported = true; }
    if (inT !== null) acc.cxInputReported = true;
    if (outT !== null) acc.cxOutputReported = true;
    acc.cx.in = Math.max(acc.cx.in, inT || 0);
    acc.cx.out = Math.max(acc.cx.out, outT || 0);
    acc.cx.tot = Math.max(acc.cx.tot || 0, totT || 0);
    const turnOutput = Math.max(acc.cx.out, (acc.cx.tot || 0) - acc.cx.in);
    const inputTokens = acc.cxCompleted.in + acc.cx.in;
    const outputTokens = acc.cxCompleted.out + turnOutput;
    emit('usage', {
      ...(acc.cxInputReported ? { inputTokens } : {}),
      ...(acc.cxOutputReported ? { outputTokens } : {}),
      ...(acc.cxInputReported && acc.cxOutputReported ? { tokens: inputTokens + outputTokens } : {}),
      ...(acc.cxCacheReported ? { cachedInputTokens: (acc.cxCompleted.cached || 0) + (acc.cx.cached || 0) } : {}),
      cliCost: null,
      cumulative: true,
    });
    if (t === 'turn.completed') {
      acc.cxCompleted = { in: inputTokens, out: outputTokens, cached: (acc.cxCompleted.cached || 0) + (acc.cx.cached || 0) };
      acc.cx = { in: 0, out: 0, tot: 0 };
    }
  }

  if (t === 'error') emit('error', o.message || (o.error && o.error.message) || 'Codex error');
  if (t === 'turn.failed') emit('error', o.message || (o.error && o.error.message) || 'Codex turn failed');
}

function parseKimi(line, emit, acc) {
  let o;
  try { o = JSON.parse(line); } catch (_) { return; }
  const t = String(o.type || '');

  // Kimi Code 0.28.1 emits OpenAI-shaped transcript records, not deltas.
  // Its print protocol omits token usage; never synthesize zero usage.
  if (o.role === 'assistant') {
    const calls = Array.isArray(o.tool_calls) ? o.tool_calls : [];
    if (typeof o.content === 'string' && o.content) {
      if (calls.length) emitActivity(acc, emit, { id: `kimi-commentary-${acc.kimiMessage = (acc.kimiMessage || 0) + 1}`,
        kind: 'reasoning', phase: 'commentary', name: I18n.t('执行过程'), status: 'done', detail: o.content });
      else emit('text', o.content);
    }
    for (const call of calls) {
      let input = {};
      try { input = JSON.parse(call.function?.arguments || '{}'); } catch { /* display only validated public fields */ }
      const command = typeof input.command === 'string' ? input.command : '';
      emitActivity(acc, emit, { id: call.id, kind: command ? 'command' : 'tool', name: call.function?.name || I18n.t('工具'),
        status: 'running', detail: command });
    }
    return;
  }
  if (o.role === 'tool') {
    const previous = acc.activities?.find(item => item.id === o.tool_call_id);
    emitActivity(acc, emit, { ...previous, id: o.tool_call_id, kind: previous?.kind || 'tool', name: previous?.name || I18n.t('工具'),
      status: 'done', detail: [previous?.kind === 'command' ? previous.detail : '', typeof o.content === 'string' ? o.content : ''].filter(Boolean).join('\n') });
    return;
  }

  if (o.session_id) emit('session', o.session_id);

  const deltaText = o.text != null ? o.text : (o.delta && o.delta.text);
  if (typeof deltaText === 'string' && /delta/i.test(t)) emit('text', deltaText);
  else if (typeof deltaText === 'string' && typeof o.text === 'string' && /message/i.test(t)) emit('text', o.text);

  if (/result|done|completed/.test(t)) {
    const u = o.usage || {};
    const inputTokens = tokenCount(u.input_tokens);
    const outputTokens = tokenCount(u.output_tokens);
    if (inputTokens !== null || outputTokens !== null) emit('usage', {
      ...(inputTokens !== null ? { inputTokens } : {}),
      ...(outputTokens !== null ? { outputTokens } : {}),
      ...(inputTokens !== null && outputTokens !== null ? { tokens: inputTokens + outputTokens } : {}),
      cliCost: null,
      apiCost: Number.isFinite(u.cost) && u.cost >= 0 ? u.cost : null,
      cumulative: false,
    });
    emit('done', {});
  }
  if (/error/.test(t)) emit('error', o.message || o.error || 'Kimi error');
}

const PARSERS = { claude: parseClaude, codebuddy: parseClaude, codex: parseCodex, kimi: parseKimi };

module.exports = { SPECS, PARSERS };
