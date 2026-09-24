'use strict';

// Protocol counters are optional. A missing/invalid counter is not a measured 0.
const tokenCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const countFields = (record, mapping) => Object.fromEntries(Object.entries(mapping)
  .map(([key, field]) => [key, tokenCount(record?.[field])]).filter(([, value]) => value !== null));

function codexTokenUsage(value) {
  const total = value?.total || {};
  const last = value?.last || {};
  const usage = countFields(total, { inputTokens: 'inputTokens', outputTokens: 'outputTokens',
    tokens: 'totalTokens', cachedInputTokens: 'cachedInputTokens', reasoningTokens: 'reasoningOutputTokens' });
  if (usage.tokens == null && usage.inputTokens != null && usage.outputTokens != null) usage.tokens = usage.inputTokens + usage.outputTokens;
  const inputTokens = tokenCount(last.inputTokens), outputTokens = tokenCount(last.outputTokens);
  const totalTokens = tokenCount(last.totalTokens) ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null);
  const contextUsage = { inputTokens, outputTokens, totalTokens,
    contextWindow: tokenCount(value?.modelContextWindow) || null, source: 'native',
    ...countFields(last, { cachedInputTokens: 'cachedInputTokens' }) };
  return { usage: { ...usage, cliCost: null, cumulative: true }, contextUsage };
}

function claudeContextUsage(usage, contextWindow = null) {
  const input = tokenCount(usage?.input_tokens);
  const outputTokens = tokenCount(usage?.output_tokens);
  // Claude reports uncached, cache-created and cache-read input separately.
  const inputTokens = input === null ? null : input + (tokenCount(usage.cache_read_input_tokens) || 0) +
    (tokenCount(usage.cache_creation_input_tokens) || 0);
  return { inputTokens, outputTokens,
    totalTokens: inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null,
    contextWindow: tokenCount(contextWindow) || null, source: 'native',
    ...countFields(usage, { cachedInputTokens: 'cache_read_input_tokens', cacheCreationInputTokens: 'cache_creation_input_tokens' }) };
}

module.exports = { tokenCount, codexTokenUsage, claudeContextUsage };
