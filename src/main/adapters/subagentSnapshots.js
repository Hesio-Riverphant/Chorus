'use strict';

const { emitActivity, safeText } = require('./activities');
const { isCliId } = require('../cliRegistry');

// App JSONL v1 uses ordered snapshots, not inferred prose or replayed deltas.
// Each invocation owns this map; a provider cannot update another invocation.
function subagentSnapshot(event, acc, emit) {
  if (event?.type !== 'subagent') return false;
  const id = event.id;
  const fields = { name: 100, task: 4000, output: 65536, parentAgentId: 96, model: 100, reasoningEffort: 24 };
  const valid = event.version === 1 && isCliId(acc.cliType) && typeof id === 'string' &&
    /^[A-Za-z0-9_.:-]{1,96}$/.test(id) && Number.isSafeInteger(event.sequence) && event.sequence >= 0 &&
    ['running', 'done', 'error', 'aborted'].includes(event.status) &&
    Object.entries(fields).every(([key, max]) => event[key] === undefined || typeof event[key] === 'string' && event[key].length <= max);
  if (!valid) {
    emit('error', 'Invalid subagent event: expected the Chorus JSONL v1 snapshot contract');
    return true;
  }
  acc.childSnapshots ||= new Map();
  const previous = acc.childSnapshots.get(id);
  if (previous && event.sequence <= previous.sequence) return true;
  if (previous && previous.status !== 'running') return true;
  if (!previous && acc.childSnapshots.size >= 100) {
    emit('error', 'Subagent event limit exceeded (100 per invocation)');
    return true;
  }
  const patch = Object.fromEntries(Object.keys(fields).filter(key => event[key] !== undefined).map(key => [key, safeText(event[key], key === 'output' ? 16384 : fields[key])]));
  const next = { ...previous, ...patch, sequence: event.sequence, status: event.status,
    outputTruncated: previous?.outputTruncated || typeof event.output === 'string' && event.output.length > 16384 };
  acc.childSnapshots.set(id, next);
  emitActivity(acc, emit, { id: `${acc.cliType}:subagent:${id}`, kind: 'subagent',
    name: next.name || id, status: next.status, summary: next.task || '', detail: next.output || '',
    subagent: { agentId: id, parentAgentId: next.parentAgentId || '', cliType: acc.cliType,
      task: next.task || '', output: next.output || '', model: next.model || '',
      reasoningEffort: next.reasoningEffort || '', outputTruncated: !!next.outputTruncated } });
  return true;
}

module.exports = { subagentSnapshot };
