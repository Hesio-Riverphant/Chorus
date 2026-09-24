'use strict';
const I18n = require('../../shared/i18n');
const { emitActivity } = require('./activities');
const { normalizeEffort, normalizeExecutionMode } = require('../../shared/reasoning');

// Public source contract audit, 2026-09-24. No installed CLI or live model run
// was used to validate these contracts. Registry/launcher owns capability gates.
const EXTRA_CONTRACTS = {
  pi: {
    noPersistence: 'documented',
    noPersistenceFlag: '--no-session',
    outputMode: 'text',
    stdin: 'unverified',
    resume: '--session <path|id> (not used with app-only history)',
    json: 'JSON mode exists; event schema unverified, so this adapter uses final text only.',
    permissions: 'No OS sandbox verified; --tools is an application tool allowlist, not a filesystem sandbox.',
    sources: [
      'https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/cli/args.ts',
      'https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/modes/print-mode.ts',
    ],
    evidence: [
      '--print, -p: Non-interactive mode: process prompt and exit',
      "--no-session: Don't save session (ephemeral)",
      '--model <pattern>: Model pattern or ID (supports provider/id and optional :<thinking>)',
      'Print text mode writes only final assistant text blocks; error/aborted returns exit code 1.',
      'Arguments after -- still treat a leading @ as a file reference.',
    ],
  },
  opencode: {
    noPersistence: 'unverified',
    historyNotice: I18n.t('OpenCode 会在原生目录保存会话。'),
    template: 'opencode run --format json [--model provider/model] [--session id]',
    stdin: 'verified-source',
    outputMode: 'ndjson',
    json: '{type,timestamp,sessionID,part}; text uses part.text at completion; tool_use uses completed/error part.state; step_finish includes part; error uses error.data.message.',
    sources: ['https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/cli/cmd/run.ts'],
    evidence: [
      'Noninteractive input reads Bun.stdin.text(); session creation calls sdk.session.create().',
      'No no-persistence run option found in the inspected command builder.',
      'run calls share(), which may share a session when existing configuration enables auto sharing.',
      'Permission requests auto-reject unless auto/yolo/dangerously-skip-permissions is enabled.',
    ],
  },
  hermes: {
    noPersistence: 'unverified',
    historyNotice: I18n.t('Hermes 会在原生目录保存会话。'),
    template: 'hermes -z <prompt> [--model model] [--resume id]',
    stdin: 'unverified',
    outputMode: 'text',
    json: 'The inspected -z path emits final text only; optional usage-file writes JSON to disk, not an event stream.',
    sources: [
      'https://raw.githubusercontent.com/NousResearch/hermes-agent/main/hermes_cli/main.py',
      'https://raw.githubusercontent.com/NousResearch/hermes-agent/main/hermes_cli/oneshot.py',
    ],
    evidence: [
      'run_oneshot returns final content and creates a SQLite session store.',
      'Oneshot explicitly enables HERMES_YOLO_MODE and accepts hooks.',
      'No no-save flag was verified; session/memory cleanup is performed after the turn.',
    ],
  },
};

function piArgs(bot, _sessionId, prompt) {
  normalizeExecutionMode('pi', bot.executionMode);
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.includes('\0')) {
    throw new Error(I18n.t('Pi 提示词必须为非空文本且不能包含 NUL'));
  }
  if (bot.permissionMode === 'workspace') throw new Error(I18n.t('Pi 尚无已核实的工作区写入隔离，请为该成员选择只读或全权限'));
  const args = ['--print', '--mode', 'text', '--no-session', '--no-extensions'];
  if (bot.permissionMode !== 'full') args.push('--tools', 'read,grep,find,ls');
  if (bot.model) args.push('--model', bot.model);
  const effort = normalizeEffort('pi', bot.reasoningEffort, bot.model);
  if (effort) args.push('--thinking', effort);
  // Pi's parser interprets leading @ as @file even after --. A leading newline
  // keeps mentions as literal prompt text and prevents accidental file reads.
  args.push('--', prompt.startsWith('@') ? '\n' + prompt : prompt);
  return args;
}

function opencodeArgs(bot) {
  normalizeExecutionMode('opencode', bot.executionMode);
  const args = ['run', '--format', 'json'];
  if (bot.model) args.push('--model', bot.model);
  return args;
}
function opencodeEnv(bot, probe) {
  const permission = probe ? { '*': 'deny' } : bot.permissionMode === 'full' ? { '*': 'allow' }
    : { '*': 'deny', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow',
      ...(bot.permissionMode === 'workspace' ? { edit: 'allow', external_directory: 'deny' } : {}) };
  // Per-child overlay disables public auto-sharing and preserves native account
  // configuration; it does not rewrite the user's OpenCode config file.
  return { OPENCODE_CONFIG_CONTENT: JSON.stringify({ share: 'disabled', permission }), OPENCODE_DISABLE_AUTOUPDATE: 'true' };
}
function hermesArgs(bot, _sessionId, prompt) {
  normalizeExecutionMode('hermes', bot.executionMode);
  if (bot.permissionMode === 'workspace') throw new Error(I18n.t('Hermes 单次模式没有工作区写入隔离；请选择只读（仅聊天）或全权限'));
  const args = ['-z', prompt];
  if (bot.model) args.push('--model', bot.model);
  // Hermes oneshot bypasses approvals. The clarify-only toolset provides a
  // usable chat-only/read-only invocation without exposing execution tools.
  if (bot.permissionMode !== 'full') args.push('--toolsets', 'clarify');
  return args;
}
const EXTRA_SPECS = {
  pi: { command: 'pi', promptVia: 'arg', outputMode: 'text', requiresShellFree: true, args: piArgs },
  opencode: { command: 'opencode', promptVia: 'stdin', outputMode: 'ndjson', args: opencodeArgs, env: opencodeEnv },
  hermes: { command: 'hermes', promptVia: 'arg', outputMode: 'text', requiresShellFree: true, args: hermesArgs },
};

function parseOpenCode(line, emit, acc) {
  let item;
  try { item = JSON.parse(line); } catch (_) { return; }
  const part = item.part || {};
  if (item.type === 'text' && typeof part.text === 'string') emit('text', part.text);
  if (item.type === 'reasoning' && typeof part.text === 'string') emitActivity(acc, emit, { id: part.id, kind: 'reasoning', name: I18n.t('思考'), status: 'done', detail: part.text });
  if (item.type === 'tool_use') emitActivity(acc, emit, { id: part.id, kind: 'tool', name: part.tool || I18n.t('工具'),
    status: part.state?.status === 'error' ? 'error' : 'done', detail: part.state?.output || part.state?.error || '' });
  if (item.type === 'error') emit('error', item.error?.data?.message || item.error?.message || I18n.t('OpenCode 运行失败'));
  if (item.type === 'step_finish') {
    const tokens = part.tokens || {};
    acc.openUsage ||= { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0, reasoningTokens: 0, cliCost: 0 };
    const count = value => Number.isFinite(value) && value >= 0 ? value : 0;
    acc.openUsage.inputTokens += count(tokens.input) + count(tokens.cache?.read) + count(tokens.cache?.write);
    acc.openUsage.outputTokens += count(tokens.output);
    acc.openUsage.cachedInputTokens += count(tokens.cache?.read);
    acc.openUsage.cacheCreationInputTokens += count(tokens.cache?.write);
    acc.openUsage.reasoningTokens += count(tokens.reasoning);
    acc.openUsage.cliCost += count(part.cost);
    emit('usage', { ...acc.openUsage, tokens: acc.openUsage.inputTokens + acc.openUsage.outputTokens, cumulative: true });
  }
}

// For outputMode=text the launcher must pass decoded raw chunks, preserving
// spaces/newlines. NDJSON line trimming would damage Markdown/code output.
function parsePiText(chunk, emit) {
  if (typeof chunk === 'string' && chunk) emit('text', chunk);
}

const EXTRA_PARSERS = { pi: parsePiText, hermes: parsePiText, opencode: parseOpenCode };

module.exports = { EXTRA_SPECS, EXTRA_PARSERS, EXTRA_CONTRACTS };
