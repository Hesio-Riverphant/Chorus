'use strict';
const I18n = require('../../shared/i18n');
const { normalizeTariff, selectRates } = require('../../shared/agentPricing');

// Preserve the invocation-start tariff; provider per-request billing can differ.
function calculateCost(bot, usage, inputTokens, outputTokens, costMode = 'none', at = Date.now(), agentPricing = {}) {
  const model = bot.model || usage.model;
  // A provider-reported API cost is authoritative and remains visible regardless
  // of the optional CLI-cost display setting or local tariff configuration.
  if (Number.isFinite(usage.apiCost) && usage.apiCost >= 0) {
    return { cost: usage.apiCost, estimated: false, costSource: 'api' };
  }
  let tariff;
  try {
    const saved = agentPricing[bot.cliType]?.find(item => item.enabled && item.model === model);
    if (saved) tariff = normalizeTariff(saved);
  } catch { /* Invalid legacy settings are not a billable price. */ }
  if (tariff) {
    const { tier, rates } = selectRates(tariff, at);
    const pricing = { cliType: bot.cliType, model, tier, at, inputPerMillion: rates.inputPerMillion,
      cachedInputPerMillion: rates.cachedInputPerMillion, outputPerMillion: rates.outputPerMillion,
      ...(tariff.offPeak?.enabled ? { timeZone: tariff.timeZone, peakPeriods: tariff.peakPeriods } : {}) };
    const result = { estimated: true, costSource: 'agent_pricing', pricing };
    const valid = n => Number.isSafeInteger(n) && n >= 0;
    if (!valid(usage.inputTokens) || !valid(usage.outputTokens)) return { ...result, cost: null, reason: I18n.t('原生未返回完整输入/输出用量，无法计价') };
    const cached = usage.cachedInputTokens;
    if (cached != null && (!valid(cached) || cached > inputTokens)) return { ...result, cost: null, reason: I18n.t('原生缓存用量与总输入不一致，无法计价') };
    const cachePrice = rates.cachedInputPerMillion ?? rates.inputPerMillion;
    if (cachePrice !== rates.inputPerMillion && !valid(cached)) return { ...result, cost: null, reason: I18n.t('原生未返回缓存命中用量，无法按缓存单价计价') };
    const hit = valid(cached) ? cached : 0;
    const cost = ((inputTokens - hit) * rates.inputPerMillion + hit * cachePrice + outputTokens * rates.outputPerMillion) / 1e6;
    return { ...result, cost: Number.isFinite(cost) && cost >= 0 ? cost : null };
  }
  if (costMode === 'cli') {
    if (Number.isFinite(usage.cliCost) && usage.cliCost >= 0) return { cost: usage.cliCost, estimated: true, costSource: 'cli' };
  }
  return { cost: null, estimated: true, costSource: 'none' };
}
module.exports = { calculateCost };
