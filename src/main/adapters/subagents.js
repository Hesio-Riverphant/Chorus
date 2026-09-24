'use strict';
const I18n = require('../../shared/i18n');

const { emitActivity, safeText } = require('./activities');
const LIMIT = 100;
const OUTPUT_LIMIT = 16384;
const terminal = new Set(['done', 'error', 'aborted']);
function status(value) {
  if (['completed', 'complete', 'done'].includes(value)) return 'done';
  if (['failed', 'errored', 'notFound', 'error'].includes(value)) return 'error';
  if (['stopped', 'killed', 'shutdown', 'interrupted', 'aborted'].includes(value)) return 'aborted';
  return 'running';
}
function state(acc) {
  if (!acc.subagents) acc.subagents = { agents: new Map(), tasks: new Map() };
  return acc.subagents;
}
function record(acc, emit, key, patch) {
  if (typeof key !== 'string' || !key || key.length > 160) return;
  const store = state(acc);
  if (!store.agents.has(key) && store.agents.size >= LIMIT) return;
  const previous = store.agents.get(key) || { messages: new Map(), output: '', task: '' };
  const next = { ...previous, ...patch };
  next.task = safeText(next.task, 4000);
  next.outputTruncated = previous.outputTruncated || (typeof next.output === 'string' && next.output.length > OUTPUT_LIMIT);
  next.output = safeText(next.output, OUTPUT_LIMIT);
  store.agents.set(key, next);
  emitActivity(acc, emit, { id: `${next.cliType}:subagent:${key}`, kind: 'subagent',
    name: next.name || next.agentId || I18n.t('子代理'), status: next.status || 'running',
    summary: next.task || I18n.t('原生子代理'), detail: next.output,
    subagent: { agentId: next.agentId || key, parentAgentId: next.parentAgentId || '', task: next.task,
      output: next.output, outputTruncated: next.outputTruncated, model: next.model || '',
      reasoningEffort: next.reasoningEffort || '', cliType: next.cliType } });
  return next;
}
function message(acc, emit, key, id, text, delta = false) {
  const agent = state(acc).agents.get(key);
  if (!agent || typeof text !== 'string' || !text) return;
  const messageId = typeof id === 'string' ? id : 'output';
  if (messageId.length > 160) return;
  if (!agent.messages.has(messageId) && agent.messages.size >= LIMIT) return;
  const previous = agent.messages.get(messageId) || '';
  let addition = delta ? text : text.startsWith(previous) ? text.slice(previous.length) : text;
  agent.messages.set(messageId, safeText(delta ? previous + text : text, OUTPUT_LIMIT));
  if (!addition) return;
  if (!previous && agent.output) addition = '\n\n' + addition;
  record(acc, emit, key, { output: agent.output + addition });
}

// Only consume Claude's explicit subagent envelopes. These texts must never be
// emitted as the parent bot's answer or participate in room mention routing.
function claudeSubagent(o, acc, emit) {
  const store = state(acc);
  if (o.type === 'system' && ['task_started', 'task_updated', 'task_notification'].includes(o.subtype)) {
    const taskId = typeof o.task_id === 'string' ? o.task_id : '';
    const key = store.tasks.get(taskId) || o.tool_use_id || taskId;
    const previous = store.agents.get(key);
    if (o.subtype === 'task_started' && o.task_type !== 'local_agent' && !o.subagent_type && !previous) return false;
    if (o.subtype !== 'task_started' && !previous) return false;
    if (taskId && store.tasks.size < LIMIT) store.tasks.set(taskId, key);
    const patch = o.patch || {};
    record(acc, emit, key, { cliType: 'claude', agentId: taskId || previous?.agentId || key,
      parentAgentId: typeof o.owned_by_subagent === 'string' ? o.owned_by_subagent : previous?.parentAgentId || '',
      name: o.description || patch.description || previous?.name || o.subagent_type,
      task: o.prompt || previous?.task || o.description || '',
      status: status(o.status || patch.status || previous?.status),
      ...(o.summary || patch.error ? { output: previous?.output || o.summary || patch.error } : {}) });
    return true;
  }
  const parent = typeof o.parent_tool_use_id === 'string' && o.parent_tool_use_id;
  const blocks = Array.isArray(o.message?.content) ? o.message.content : [];
  for (const block of blocks) {
    if (block.type === 'tool_use' && ['Agent', 'Task'].includes(block.name)) {
      const input = block.input || {};
      record(acc, emit, block.id, { cliType: 'claude', agentId: block.id, parentAgentId: store.agents.get(parent)?.agentId || parent || '',
        name: input.name || input.description || input.subagent_type || I18n.t('子代理'), task: input.prompt || input.description || '',
        model: input.model || '', status: 'running' });
    } else if (block.type === 'tool_result' && store.agents.has(block.tool_use_id)) {
      const text = typeof block.content === 'string' ? block.content : Array.isArray(block.content)
        ? block.content.filter(part => part?.type === 'text').map(part => part.text).join('\n') : '';
      const previous = store.agents.get(block.tool_use_id);
      record(acc, emit, block.tool_use_id, { status: block.is_error ? 'error' : terminal.has(previous.status) ? previous.status : 'done',
        output: previous.output || text });
    }
  }
  if (!parent) return false;
  if (!store.agents.has(parent)) record(acc, emit, parent, { cliType: 'claude', agentId: parent, name: I18n.t('子代理'), status: 'running' });
  if (o.type === 'stream_event') {
    const e = o.event || {};
    if (e.type === 'message_start') record(acc, emit, parent, { currentMessage: e.message?.id, model: e.message?.model || '' });
    if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
      message(acc, emit, parent, store.agents.get(parent)?.currentMessage, e.delta.text, true);
    }
  } else if (o.type === 'assistant') {
    if (o.message?.model) record(acc, emit, parent, { model: o.message.model });
    message(acc, emit, parent, o.message?.id, blocks.filter(block => block.type === 'text').map(block => block.text).join('\n'));
  }
  return true;
}

function codexSubagents(item, acc, emit) {
  if (!item || !['collabAgentToolCall', 'collab_tool_call'].includes(item.type)) return false;
  const receivers = item.receiverThreadIds || item.receiver_thread_ids || [];
  const receivedStates = item.agentsStates || item.agents_states;
  const states = receivedStates && typeof receivedStates === 'object' && !Array.isArray(receivedStates) ? receivedStates : {};
  const ids = [...new Set([...(Array.isArray(receivers) ? receivers : []), ...Object.keys(states)])];
  const parentAgentId = item.senderThreadId || item.sender_thread_id || '';
  for (const id of ids.slice(0, LIMIT)) {
    const previous = state(acc).agents.get(id);
    // A completed spawn tool only means dispatch completed, not that its child did.
    const agentState = states[id];
    record(acc, emit, id, { cliType: 'codex', agentId: id, parentAgentId,
      name: previous?.name || id, task: previous?.task || item.prompt || '',
      model: item.model || previous?.model || '', reasoningEffort: item.reasoningEffort || previous?.reasoningEffort || '',
      status: agentState ? status(agentState.status) : previous?.status || 'running',
      ...(typeof agentState?.message === 'string' ? { output: agentState.message } : {}) });
  }
  return true;
}

function codexChildEvent(method, params, acc, emit) {
  const key = params.threadId;
  if (!state(acc).agents.has(key)) return false;
  if (method === 'item/agentMessage/delta') message(acc, emit, key, params.itemId, params.delta, true);
  else if (method === 'item/completed') {
    if (params.item?.type === 'agentMessage') message(acc, emit, key, params.item.id, params.item.text);
    else codexSubagents(params.item, acc, emit);
  } else if (method === 'item/started') codexSubagents(params.item, acc, emit);
  else if (method === 'turn/completed') record(acc, emit, key, { status: status(params.turn?.status) });
  return true;
}

module.exports = { claudeSubagent, codexSubagents, codexChildEvent };
