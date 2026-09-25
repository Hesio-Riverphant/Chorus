'use strict';

const { isCliId } = require('../cliRegistry');

const MAX_ACTIVITIES = 100;

// Activity data comes from external processes. Never persist raw tool inputs,
// signatures, encrypted reasoning or headers; redact common credential forms
// in the small command/output/public-summary fields that we do display.
function safeText(value, limit = 2048) {
  if (typeof value !== 'string') return '';
  const text = value
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[已隐藏凭据]')
    .replace(/\b(?:Bearer|Basic)\s+[^\s"'\\]+/gi, '[已隐藏认证]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|authorization|cookie)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}&\r\n]+)/gi, '$1[已隐藏]')
    .replace(/(--(?:api-key|token|password|secret)\s+)(?:"[^"]*"|'[^']*'|\S+)/gi, '$1[已隐藏]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, '[已隐藏凭据]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[已隐藏]@')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
  return text.length > limit ? text.slice(0, limit - 1) + '…' : text;
}

function normalizeActivity(value) {
  if (!value || typeof value.id !== 'string' || !value.id) return null;
  if (!['tool', 'command', 'reasoning', 'subagent'].includes(value.kind)) return null;
  return {
    id: safeText(value.id, 160), kind: value.kind,
    name: safeText(value.name, 100),
    status: ['running', 'done', 'error', 'aborted'].includes(value.status) || value.kind === 'subagent' && value.status === 'unknown' ? value.status : 'running',
    summary: safeText(value.summary, 240),
    // Public progress messages are the only copy of that text after phase
    // separation. Preserve them through repeated normalization/persistence;
    // the native adapter bounds all message text to 4 MiB per invocation.
    detail: safeText(value.detail, value.kind === 'reasoning' && value.phase === 'commentary' ? 4 * 1024 * 1024 : 2048),
    ...(value.kind === 'reasoning' && value.phase === 'commentary' ? { phase: 'commentary' } : {}),
    ...(Number.isSafeInteger(value.order) && value.order >= 0 ? { order: value.order } : {}),
    ...(Array.isArray(value.files) ? { files: value.files.filter(file => typeof file === 'string' && file.length <= 4096 && !/[\x00-\x1f]/.test(file)).slice(0, 100) } : {}),
    ...(value.kind === 'subagent' && value.subagent ? { subagent: {
      agentId: safeText(value.subagent.agentId, 160), parentAgentId: safeText(value.subagent.parentAgentId, 160),
      task: safeText(value.subagent.task, 4000), output: safeText(value.subagent.output, 16384),
      model: safeText(value.subagent.model, 100), reasoningEffort: safeText(value.subagent.reasoningEffort, 24),
      cliType: isCliId(value.subagent.cliType) ? value.subagent.cliType : '',
      ...(value.subagent.outputKind === 'summary' ? { outputKind: 'summary' } : {}),
      outputTruncated: value.subagent.outputTruncated === true || (typeof value.subagent.output === 'string' && value.subagent.output.length > 16384),
    } } : {}),
  };
}

function upsertActivity(list, value) {
  const activity = normalizeActivity(value);
  if (!activity) return list;
  const next = [...(list || [])];
  const index = next.findIndex((item) => item.id === activity.id);
  if (index >= 0) next[index] = activity;
  else if (next.length < MAX_ACTIVITIES) next.push(activity);
  return next;
}

function emitActivity(acc, emit, value) {
  const previous = acc.activities || [];
  const prior = previous.find(item => item.id === value.id);
  if (!Number.isSafeInteger(value.order)) value = { ...value, order: prior?.order ?? nextActivityOrder(acc) };
  const next = upsertActivity(previous, value);
  acc.activities = next;
  const activity = next.find((item) => item.id === value.id);
  if (activity && JSON.stringify(activity) !== JSON.stringify(previous.find((item) => item.id === value.id))) {
    emit('activity', activity);
  }
}

function nextActivityOrder(acc) { const order = acc.activityOrder || 0; acc.activityOrder = order + 1; return order; }

module.exports = { safeText, normalizeActivity, upsertActivity, emitActivity, nextActivityOrder };
