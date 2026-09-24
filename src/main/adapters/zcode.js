'use strict';
const I18n = require('../../shared/i18n');
const { emitActivity } = require('./activities');
const { tokenCount } = require('./tokenUsage');

function args(bot, _session, prompt) {
  if (bot.model) throw new Error(I18n.t('ZCode 当前接入仅支持原生默认模型，请在原生 CLI 中选择模型'));
  if (bot.permissionMode !== 'full') throw new Error(I18n.t('ZCode 当前接入未验证严格只读或工作区权限，请明确选择全权限后使用'));
  return ['--prompt', prompt, '--output-format', 'stream-json', '--mode', 'yolo', '--no-browser'];
}
function processText(acc, emit) {
  if (!acc.pendingText) return;
  const id = `zcode-process-${acc.processIndex = (acc.processIndex || 0) + 1}`;
  emitActivity(acc, emit, { id, kind: 'reasoning', phase: 'commentary', name: I18n.t('执行过程'), detail: acc.pendingText, status: 'done' });
  if (acc.activities?.some(item => item.id === id)) { acc.pendingText = ''; emit('text_replace', ''); }
  else acc.retainedProcess = acc.pendingText;
}
function parse(line, emit, acc) {
  let item; try { item = JSON.parse(line); } catch { return; }
  if (!item || typeof item !== 'object' || acc.zcodeResult) return;
  const data = item.payload || {};
  if (item.type === 'model.streaming') {
    if (data.kind === 'text_delta' && typeof data.delta === 'string') {
      acc.pendingText = (acc.pendingText || '') + data.delta; emit('text', data.delta);
    } else if (data.kind === 'reasoning_delta' && typeof data.delta === 'string') {
      const id = `zcode-thought-${data.partId || data.assistantMessageId || item.turnId || 'turn'}`;
      const previous = acc.activities?.find(value => value.id === id);
      emitActivity(acc, emit, { id, kind: 'reasoning', name: I18n.t('思考'), detail: (previous?.detail || '') + data.delta, status: data.done ? 'done' : 'running' });
    }
  } else if (item.type === 'tool.updated' && typeof data.toolCallId === 'string') {
    const previous = acc.activities?.find(value => value.id === data.toolCallId) || {};
    if (['scheduled', 'started'].includes(data.kind)) processText(acc, emit);
    const error = data.kind === 'error' || data.result?.success === false;
    emitActivity(acc, emit, { ...previous, id: data.toolCallId, kind: 'tool', name: data.toolName || previous.name || I18n.t('工具'),
      status: error ? 'error' : data.kind === 'result' ? 'done' : 'running',
      detail: data.error?.message || data.result?.error?.message || data.result?.content || data.stdoutTail || previous.detail || '' });
  } else if (item.type === 'turn.failed') {
    acc.zcodeFailed = true; emit('error', data.error?.message || I18n.t('ZCode 运行失败'));
  } else if (item.type === 'result') {
    if (acc.zcodeFailed || typeof item.response !== 'string') { emit('error', I18n.t('ZCode 未返回成功结果')); return; }
    acc.zcodeResult = true;
    const usage = item.usage;
    if (usage?.source === 'provider' && tokenCount(usage.inputTokens) !== null && tokenCount(usage.outputTokens) !== null) {
      const measured = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cumulative: true };
      for (const [target, source] of [['tokens', 'totalTokens'], ['cachedInputTokens', 'cacheReadTokens'], ['cacheCreationInputTokens', 'cacheWriteTokens'], ['reasoningTokens', 'reasoningTokens']]) {
        if (tokenCount(usage[source]) !== null) measured[target] = usage[source];
      }
      emit('usage', measured);
    }
    if (tokenCount(item.projection?.contextUsed) !== null) emit('context_usage', {
      totalTokens: item.projection.contextUsed, contextWindow: tokenCount(item.projection.contextWindow) || null, source: 'native',
    });
    for (const activity of acc.activities || []) if (activity.kind === 'reasoning' && activity.status === 'running') emitActivity(acc, emit, { ...activity, status: 'done' });
    emit('text_replace', [acc.retainedProcess, item.response].filter(Boolean).join('\n'));
    emit('final_answer', true);
  }
}
module.exports = { spec: { command: 'zcode', promptVia: 'arg', outputMode: 'ndjson', args }, parse };
