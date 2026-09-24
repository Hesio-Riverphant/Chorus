(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./i18n') : root.I18n);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AgentPricing = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (I18n) {
  'use strict';
  const record = value => value && typeof value === 'object' && !Array.isArray(value);
  const DEFAULT_PERIODS = [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '12:00' },
    { days: [1, 2, 3, 4, 5], start: '14:00', end: '18:00' }];
  function rates(value) {
    const out = {};
    for (const key of ['inputPerMillion', 'cachedInputPerMillion', 'outputPerMillion']) {
      const price = value?.[key];
      if (key === 'cachedInputPerMillion' && price == null) { out[key] = null; continue; }
      if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) throw new Error(I18n.t('单价须填写有限非负数；缓存命中单价可留空'));
      out[key] = price;
    }
    return out;
  }
  function normalizeTariff(value) {
    if (!record(value) || typeof value.enabled !== 'boolean' || typeof value.model !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9_./:@+\[\]-]{0,199}$/.test(value.model)) throw new Error(I18n.t('请选择计价模型并设置启用状态'));
    const out = { enabled: value.enabled, model: value.model, ...rates(value) };
    if (value.offPeak?.enabled) {
      const time = text => typeof text === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(text);
      if (typeof value.timeZone !== 'string' || !value.timeZone.trim()) throw new Error(I18n.t('请填写服务商计价时区'));
      try { new Intl.DateTimeFormat('en', { timeZone: value.timeZone }).format(0); } catch { throw new Error(I18n.t('计价时区无效')); }
      if (!Array.isArray(value.peakPeriods) || !value.peakPeriods.length || value.peakPeriods.length > 28) throw new Error(I18n.t('请配置 1–28 个高峰时段'));
      out.timeZone = value.timeZone;
      out.peakPeriods = value.peakPeriods.map(period => {
        if (!record(period) || !Array.isArray(period.days) || !period.days.length || period.days.length > 7 ||
            period.days.some(day => !Number.isInteger(day) || day < 0 || day > 6) ||
            !time(period.start) || !time(period.end) || period.start === period.end) throw new Error(I18n.t('请设置高峰星期和有效起止时间'));
        return { days: [...new Set(period.days)].sort(), start: period.start, end: period.end };
      });
      out.offPeak = { enabled: true, ...rates(value.offPeak) };
    }
    return out;
  }
  function normalizeAgentPricing(value = {}) {
    if (!record(value) || Object.keys(value).length > 64) throw new Error(I18n.t('Agent 计价配置无效'));
    const out = {};
    for (const [cli, tariffs] of Object.entries(value)) {
      if (!/^[a-z][a-z0-9_-]{0,79}$/.test(cli) || !Array.isArray(tariffs) || tariffs.length > 100) throw new Error(I18n.t('Agent 计价配置无效'));
      const models = new Set();
      out[cli] = tariffs.map(tariff => {
        const normalized = normalizeTariff(tariff);
        if (models.has(normalized.model)) throw new Error(I18n.t('同一 Agent 的计价模型不能重复'));
        models.add(normalized.model); return normalized;
      });
    }
    return out;
  }
  function selectRates(tariff, at) {
    if (!tariff.offPeak?.enabled) return { tier: 'standard', rates: tariff };
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tariff.timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
    const read = type => parts.find(part => part.type === type).value;
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(read('weekday'));
    const clock = read('hour') + ':' + read('minute');
    const peak = tariff.peakPeriods.some(period => period.start < period.end
      ? period.days.includes(day) && clock >= period.start && clock < period.end
      : period.days.includes(day) && clock >= period.start || period.days.includes((day + 6) % 7) && clock < period.end);
    return { tier: peak ? 'peak' : 'offPeak', rates: peak ? tariff : tariff.offPeak };
  }
  return { DEFAULT_PERIODS, normalizeTariff, normalizeAgentPricing, selectRates };
});
