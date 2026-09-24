'use strict';
const { calculateCost } = require('./pricing');

// Every adapter emits an invocation-total snapshot. Missing counters stay unknown;
// transcript estimates never enter dispatch decisions.
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
function reportedUsage(usage = {}, bot, at, prices) {
  const input = usage.inputEstimated ? null : count(usage.inputTokens);
  const output = usage.outputEstimated ? null : count(usage.outputTokens);
  const total = usage.inputEstimated || usage.outputEstimated ? null : count(usage.tokens);
  const tokens = total ?? (input !== null && output !== null ? count(input + output) : null);
  const monetary = calculateCost(bot, { ...usage, inputTokens: input, outputTokens: output }, input, output, 'cli', at, prices);
  return { tokens, cost: monetary.cost, costSource: monetary.costSource };
}
function summary(entries, limits) {
  let reportedTokens = 0, reportedCost = 0, unknownTokenCalls = 0, unknownCostCalls = 0;
  for (const usage of entries) {
    if (count(usage.tokens) === null) unknownTokenCalls++;
    else reportedTokens = Math.min(Number.MAX_SAFE_INTEGER, reportedTokens + usage.tokens);
    if (!Number.isFinite(usage.cost) || usage.cost < 0) unknownCostCalls++;
    else reportedCost = Math.min(Number.MAX_VALUE, reportedCost + usage.cost);
  }
  return { ...limits, reportedTokens, reportedCost, unknownTokenCalls, unknownCostCalls };
}
module.exports = { reportedUsage, summary };
