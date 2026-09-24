'use strict';
const { estimateTokens } = require('../shared/util');
const { buildPrompt, selectTranscript } = require('./orchestrator/transcript');
const { tokenCount } = require('./adapters/tokenUsage');

function contextUsage(room, bot, members, messages, catchup = 20, historyTokenBudget = 0) {
  const selected = selectTranscript(messages, bot, members, { catchupMessages: catchup, historyTokenBudget });
  const latest = [...messages].reverse().find(message => !message.supersededBy && message.authorId === bot.id && message.authorType === 'bot');
  const prompt = buildPrompt(bot, selected.messages, members, room, []);
  const empty = buildPrompt(bot, [], members, room, []);
  const native = latest?.contextUsage;
  return { botId: bot.id, name: bot.name, model: bot.model || '',
    nextInputEstimate: estimateTokens(prompt), roomOverheadEstimate: estimateTokens(empty), historyMessages: selected.historyMessages,
    historyTokenEstimate: selected.historyTokenEstimate, omittedHistoryMessages: selected.omittedHistoryMessages,
    historyTokenBudget: selected.historyTokenBudget,
    lastInputTokens: tokenCount(latest?.usage?.inputTokens), lastOutputTokens: tokenCount(latest?.usage?.outputTokens),
    lastInputEstimated: latest?.usage?.inputEstimated ?? null,
    cachedInputTokens: tokenCount(latest?.usage?.cachedInputTokens),
    currentTokens: tokenCount(native?.totalTokens), contextWindow: tokenCount(native?.contextWindow) || null,
    currentInputTokens: tokenCount(native?.inputTokens), currentCachedInputTokens: tokenCount(native?.cachedInputTokens),
    currentScope: native ? 'last_model_request' : null,
    source: native ? 'native' : 'estimate', updatedAt: latest?.createdAt ?? null };
}

module.exports = { contextUsage };
