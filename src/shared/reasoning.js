(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./i18n') : root.I18n);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Reasoning = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (I18n) {
  'use strict';
  // CLI contracts: claude --help; Codex config schema/model metadata;
  // Pi packages/coding-agent/src/cli/args.ts. Models may accept a subset.
  const LEVELS = Object.freeze({
    claude: ['low', 'medium', 'high', 'xhigh', 'max'],
    codex: ['low', 'medium', 'high', 'xhigh'],
    kimi: ['off', 'on', 'low', 'medium', 'high', 'xhigh', 'max'],
    pi: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  });
  const LABELS = { off: '关闭', on: '开启', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高', ultra: '极高' };
  function isEffort(value) { return typeof value === 'string' && /^[a-z][a-z0-9_-]{0,23}$/.test(value); }
  function levelsFor(cliType, model = '', models = []) {
    if (cliType === 'claude' && /(?:^|[-/])haiku(?:$|[-\[])/i.test(model)) return [];
    const item = models.find(item => item.id === model);
    if (cliType === 'kimi') return Array.isArray(item?.reasoningLevels) ? [...item.reasoningLevels] : ['off', 'on'];
    if (cliType === 'codex' && Array.isArray(item?.reasoningLevels) && item.reasoningLevels.length) return [...item.reasoningLevels];
    return [...(LEVELS[cliType] || [])];
  }
  function normalizeEffort(cliType, value, model = '') {
    if (value == null || value === '') return '';
    if (!isEffort(value)) throw new Error(I18n.t('推理程度无效'));
    // Codex accepts model-advertised values, which can grow independently of
    // this application; syntax is bounded and never passed through a shell.
    if (cliType === 'codex') return value;
    // Kimi validates the selected level against its live ACP session before
    // sending any prompt. Model aliases and supported efforts are native data.
    if (cliType === 'kimi' && LEVELS.kimi.includes(value)) return value;
    if (!levelsFor(cliType, model).includes(value)) throw new Error(I18n.t('此 Agent 或模型不支持所选推理程度，请选择默认'));
    return value;
  }
  function normalizeExecutionMode(cliType, value) {
    if (value == null || value === '' || value === 'chat') return 'chat';
    if (value === 'plan' && ['claude', 'codex'].includes(cliType)) return 'plan';
    if (value === 'goal' && ['claude', 'codex'].includes(cliType)) return 'goal';
    throw new Error(value === 'goal' ? I18n.t('此 Agent 暂不支持原生目标模式，请选择 Claude Code 或 Codex') : I18n.t('此 Agent 暂不支持原生计划模式，请选择 Claude Code 或 Codex'));
  }
  return { LEVELS, LABELS, isEffort, levelsFor, normalizeEffort, normalizeExecutionMode };
});
