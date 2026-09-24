'use strict';
const I18n = require('../../shared/i18n');

const zcode = require('./zcode');
const { emitActivity } = require('./activities');

function geminiArgs(bot) {
  const args = ['--output-format', 'stream-json', '--approval-mode', bot.permissionMode === 'full' ? 'yolo' : bot.permissionMode === 'workspace' ? 'auto_edit' : 'plan'];
  if (bot.model) args.push('--model', bot.model);
  return args;
}
function qwenArgs(bot, _session, prompt) {
  const args = ['--prompt', prompt, '--output-format', 'stream-json', '--approval-mode', bot.permissionMode === 'full' ? 'yolo' : bot.permissionMode === 'workspace' ? 'auto-edit' : 'plan'];
  if (bot.model) args.push('--model', bot.model);
  return args;
}
function copilotArgs(bot, _session, prompt) {
  if (bot.permissionMode === 'workspace') throw new Error(I18n.t('Copilot 接入尚未验证工作区隔离，请选择只读或全权限'));
  const args = ['--prompt', prompt, '--silent', '--no-remote', '--no-remote-export'];
  if (bot.model) args.push('--model', bot.model);
  if (bot.permissionMode === 'full') args.push('--allow-all');
  else args.push('--available-tools', 'view', '--allow-tool', 'read', '--deny-tool', 'write', '--deny-tool', 'shell', '--deny-tool', 'memory');
  return args;
}
function cursorArgs(bot) {
  if (bot.permissionMode === 'workspace') throw new Error(I18n.t('Cursor 接入尚未验证双平台工作区隔离，请选择只读或全权限'));
  const args = ['--print', '--output-format', 'stream-json'];
  if (bot.model) args.push('--model', bot.model);
  if (bot.permissionMode === 'full') args.push('--force');
  else args.push('--mode', 'ask');
  return args;
}
function droidArgs(bot) {
  const args = ['exec', '--output-format', 'json'];
  if (bot.model) args.push('--model', bot.model);
  if (bot.permissionMode === 'full') args.push('--skip-permissions-unsafe');
  else if (bot.permissionMode === 'workspace') args.push('--auto', 'low');
  return args;
}
function moveProcess(acc, emit, prefix) {
  if (!acc.pendingText) return;
  const id = `${prefix}-${acc.processIndex = (acc.processIndex || 0) + 1}`;
  emitActivity(acc, emit, { id, kind: 'reasoning', phase: 'commentary',
    name: I18n.t('执行过程'), detail: acc.pendingText, status: 'done' });
  if (acc.activities?.some(item => item.id === id)) { acc.pendingText = ''; emit('text_replace', ''); }
  else acc.retainedProcess = acc.pendingText;
}
function parseGemini(line, emit, acc) {
  let item; try { item = JSON.parse(line); } catch { return; }
  if (item.type === 'message' && item.role === 'assistant' && typeof item.content === 'string') {
    acc.pendingText = (acc.pendingText || '') + item.content; emit('text', item.content);
  } else if (item.type === 'tool_use') {
    moveProcess(acc, emit, 'gemini-process');
    emitActivity(acc, emit, { id: item.tool_id, kind: 'tool', name: item.tool_name, status: 'running', detail: '' });
  } else if (item.type === 'tool_result') {
    const previous = acc.activities?.find(value => value.id === item.tool_id) || {};
    emitActivity(acc, emit, { ...previous, id: item.tool_id, kind: 'tool', name: previous.name || I18n.t('工具'),
      status: item.status === 'error' ? 'error' : 'done', detail: item.output || item.error?.message || '' });
  } else if (item.type === 'error' && item.severity === 'error' || item.type === 'result' && item.status === 'error') {
    emit('error', item.error?.message || item.message || I18n.t('Gemini 运行失败'));
  } else if (item.type === 'result' && item.status === 'success') {
    const stats = item.stats || {};
    if ([stats.input_tokens, stats.output_tokens].every(value => Number.isSafeInteger(value) && value >= 0)) {
      emit('usage', { inputTokens: stats.input_tokens, outputTokens: stats.output_tokens, tokens: stats.input_tokens + stats.output_tokens,
        ...(Number.isSafeInteger(stats.cached) && stats.cached >= 0 && stats.cached <= stats.input_tokens ? { cachedInputTokens: stats.cached } : {}), cumulative: true });
    }
    emit('final_answer', true);
  }
}
function parseQwen(line, emit, acc) {
  let item; try { item = JSON.parse(line); } catch { return; }
  if (item.parent_tool_use_id) return;
  const blocks = Array.isArray(item.message?.content) ? item.message.content : [];
  if (item.type === 'assistant') {
    const content = blocks.filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('');
    if (content) { acc.pendingText = (acc.pendingText || '') + content; emit('text', content); }
    for (const block of blocks) {
      if (block.type === 'tool_use') {
        moveProcess(acc, emit, 'qwen-process');
        emitActivity(acc, emit, { id: block.id, kind: 'tool', name: block.name, status: 'running', detail: '' });
      } else if (block.type === 'thinking') emitActivity(acc, emit, { id: `qwen-thought-${item.uuid || acc.processIndex || 0}`, kind: 'reasoning', name: I18n.t('思考'), status: 'done', detail: block.thinking || '' });
    }
  } else if (item.type === 'user') {
    for (const block of blocks.filter(value => value.type === 'tool_result')) {
      const previous = acc.activities?.find(value => value.id === block.tool_use_id) || {};
      const detail = typeof block.content === 'string' ? block.content : Array.isArray(block.content) ? block.content.filter(part => part.type === 'text').map(part => part.text).join('\n') : '';
      emitActivity(acc, emit, { ...previous, id: block.tool_use_id, kind: 'tool', name: previous.name || I18n.t('工具'), status: block.is_error ? 'error' : 'done', detail });
    }
  } else if (item.type === 'result') {
    const usage = item.usage || {};
    if ([usage.input_tokens, usage.output_tokens].every(value => Number.isSafeInteger(value) && value >= 0)) {
      emit('usage', { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, tokens: usage.input_tokens + usage.output_tokens,
        ...(Number.isSafeInteger(usage.cache_read_input_tokens) && usage.cache_read_input_tokens >= 0 && usage.cache_read_input_tokens <= usage.input_tokens
          ? { cachedInputTokens: usage.cache_read_input_tokens } : {}), cumulative: true });
    }
    if (item.is_error) emit('error', item.error?.message || item.result || I18n.t('Qwen Code 运行失败'));
    else {
      if (typeof item.result === 'string') {
        acc.pendingText = [acc.retainedProcess, item.result].filter(Boolean).join('\n');
        emit('text_replace', acc.pendingText);
      }
      emit('final_answer', true);
    }
  }
}

function parseCursor(line, emit, acc) {
  let item; try { item = JSON.parse(line); } catch { return; }
  if (item.type === 'assistant') {
    const blocks = Array.isArray(item.message?.content) ? item.message.content : [];
    const content = blocks.filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('');
    if (content) { acc.cursorMessages = true; acc.pendingText = (acc.pendingText || '') + content; emit('text', content); }
  } else if (item.type === 'tool_call') {
    const call = item.tool_call || {}, entries = Object.entries(call);
    const [kind, raw] = entries[0] || ['tool', {}];
    const data = raw && typeof raw === 'object' ? raw : {};
    const previous = acc.activities?.find(value => value.id === item.call_id) || {};
    if (item.subtype === 'started') moveProcess(acc, emit, 'cursor-process');
    const result = data.result || {};
    emitActivity(acc, emit, { ...previous, id: item.call_id, kind: 'tool', name: data.name || kind,
      status: item.subtype === 'completed' ? result.error ? 'error' : 'done' : 'running',
      detail: typeof result.success?.content === 'string' ? result.success.content : typeof result.error?.message === 'string' ? result.error.message : '',
      ...(typeof data.args?.path === 'string' ? { files: [data.args.path] } : {}) });
  } else if (item.type === 'result') {
    if (item.is_error || item.subtype !== 'success') { emit('error', item.error?.message || I18n.t('Cursor 运行失败')); return; }
    // Cursor's terminal result concatenates process and final prose. The last
    // assistant segment is already displayed; replaying result duplicates it.
    if (!acc.cursorMessages && typeof item.result === 'string') emit('text', item.result);
    emit('final_answer', true);
  }
}

function parseDroid(chunk, emit, acc) {
  if (!chunk || acc.droidComplete || acc.droidRejected) return;
  acc.droidJson = (acc.droidJson || '') + chunk;
  if (Buffer.byteLength(acc.droidJson) > 4 * 1024 * 1024) {
    acc.droidRejected = true; acc.droidJson = ''; emit('error', I18n.t('Droid 结果超过大小上限')); return;
  }
  let result; try { result = JSON.parse(acc.droidJson); } catch { return; }
  acc.droidComplete = true; acc.droidJson = '';
  if (result?.type !== 'result' || result.is_error || result.subtype !== 'success' || typeof result.result !== 'string') {
    emit('error', result?.error?.message || I18n.t('Droid 未返回成功结果')); return;
  }
  emit('text', result.result); emit('final_answer', true);
}
const MAINSTREAM_SPECS = {
  zcode: zcode.spec,
  gemini: { command: 'gemini', promptVia: 'stdin', outputMode: 'ndjson', args: geminiArgs, env: () => ({ GEMINI_TELEMETRY_ENABLED: 'false' }) },
  qwen: { command: 'qwen', promptVia: 'arg', outputMode: 'ndjson', args: qwenArgs },
  copilot: { command: 'copilot', promptVia: 'arg', outputMode: 'text', args: copilotArgs },
  cursor: { command: 'agent', promptVia: 'stdin', outputMode: 'ndjson', args: cursorArgs },
  droid: { command: 'droid', promptVia: 'stdin', outputMode: 'text', args: droidArgs },
};
const MAINSTREAM_PARSERS = { zcode: zcode.parse, gemini: parseGemini, qwen: parseQwen, cursor: parseCursor, droid: parseDroid, copilot: (text, emit) => { if (text) emit('text', text); } };
module.exports = { MAINSTREAM_SPECS, MAINSTREAM_PARSERS };
