(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./i18n') : root.I18n);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BotProfile = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (I18n) {
  'use strict';

  const ROLE_PRESETS = Object.freeze([
    { value: '协作者', label: '协作者', persona: '你是协作者：理解目标、补充有依据的观点，与其他成员协商并推进任务。' },
    { value: '主持人', label: '主持人', persona: '你是讨论引导者：引导讨论、归纳分歧、必要时点名其他成员，并在讨论收敛时给出结论。' },
    { value: '执行者', label: '执行者', persona: '你是执行者：专注把方案落地，给出可执行步骤与代码，并主动指出实现风险。' },
    { value: '审查者', label: '审查者', persona: '你是审查者：核查事实、需求和实现，指出有依据的问题、风险及验证方法。' },
    { value: '研究者', label: '研究者', persona: '你是研究者：收集并比较证据，区分事实、推断和未知，提出可核实的结论。' },
  ].map(Object.freeze));
  const MAX_AVATAR_BYTES = 256 * 1024;

  function getDefaultPersona(role, customRole = false) {
    if (customRole) return '';
    const preset = ROLE_PRESETS.find((item) => item.value === role);
    return preset ? preset.persona : '';
  }

  function record(value) { return value && typeof value === 'object' && !Array.isArray(value); }

  function normalizeAvatar(avatar) {
    if (avatar == null) return null;
    if (!record(avatar)) throw new Error(I18n.t('头像格式无效'));
    if (avatar.type === 'provider' && typeof avatar.provider === 'string' && /^(?:claude|codex|kimi|codebuddy|gemini|qwen|copilot|cursor|droid|zcode|pi|opencode|hermes|custom_[a-f0-9]{32})$/.test(avatar.provider)) {
      return { type: 'provider', provider: avatar.provider };
    }
    if (avatar.type === 'text' && typeof avatar.text === 'string' &&
        avatar.text.trim() && Array.from(avatar.text.trim()).length <= 8 && !/[\x00-\x1f\x7f]/.test(avatar.text)) {
      return { type: 'text', text: avatar.text.trim() };
    }
    if (avatar.type === 'image' && typeof avatar.dataUrl === 'string') {
      const match = avatar.dataUrl.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
      if (match && match[2].length % 4 === 0 && match[2].length <= Math.ceil(MAX_AVATAR_BYTES / 3) * 4) {
        const bytes = typeof Buffer !== 'undefined' ? Buffer.from(match[2], 'base64')
          : Uint8Array.from(atob(match[2]), (char) => char.charCodeAt(0));
        const prefix = (...values) => values.every((value, index) => bytes[index] === value);
        const valid = match[1] === 'png' ? prefix(137, 80, 78, 71, 13, 10, 26, 10)
          : match[1] === 'jpeg' ? prefix(255, 216, 255)
            : prefix(82, 73, 70, 70) && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80;
        if (valid && bytes.length <= MAX_AVATAR_BYTES) return { type: 'image', dataUrl: avatar.dataUrl };
      }
    }
    throw new Error(I18n.t('头像须为预置图标、1–8 字文字，或不超过 256 KB 的 PNG/JPEG/WebP 图片'));
  }

  function isModelIdentifier(value) {
    return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_./:@+\[\]-]{0,199}$/.test(value);
  }

  function normalizeRates(value) {
    if (!record(value) || ![value.inputPerMillion, value.outputPerMillion].every(price =>
      typeof price === 'number' && Number.isFinite(price) && price >= 0)) {
      throw new Error(I18n.t('请输入有限非负输入、输出单价'));
    }
    const rates = { inputPerMillion: value.inputPerMillion, outputPerMillion: value.outputPerMillion };
    for (const key of ['cacheReadPerMillion', 'cacheWritePerMillion']) {
      if (value[key] === undefined) continue;
      if (value[key] !== null && !(typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0)) {
        throw new Error(I18n.t('缓存单价须留空或填写有限非负数'));
      }
      rates[key] = value[key];
    }
    return rates;
  }

  function normalizePricing(value) {
    if (!record(value) || typeof value.enabled !== 'boolean' || typeof value.model !== 'string') {
      throw new Error(I18n.t('成员单价须包含启用状态及模型'));
    }
    const pricing = { enabled: value.enabled, model: value.model, ...normalizeRates(value) };
    if (value.offPeak != null) {
      const tier = value.offPeak;
      const time = text => typeof text === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(text);
      if (!record(tier) || typeof tier.enabled !== 'boolean' || !['auto', 'peak', 'offPeak'].includes(tier.mode) ||
          !time(tier.start) || !time(tier.end) || tier.start === tier.end || typeof tier.timeZone !== 'string' || !tier.timeZone.trim()) {
        throw new Error(I18n.t('请设置有效峰谷模式、时区和不相同的开始/结束时间'));
      }
      try { new Intl.DateTimeFormat('en', { timeZone: tier.timeZone }).format(0); }
      catch { throw new Error(I18n.t('计价时区无效，请填写如 Asia/Shanghai 或 UTC')); }
      pricing.offPeak = { enabled: tier.enabled, mode: tier.mode, timeZone: tier.timeZone,
        start: tier.start, end: tier.end, ...normalizeRates(tier) };
    }
    return pricing;
  }

  function normalizeBotProfile(bot) {
    if (!record(bot)) throw new Error(I18n.t('成员配置无效'));
    const next = { ...bot };
    if (next.model !== undefined && (typeof next.model !== 'string' || (next.model !== '' && !isModelIdentifier(next.model)))) {
      throw new Error(I18n.t('模型标识无效，请选择模型或填写有效标识'));
    }
    if (next.cliType === 'zcode' && next.model) throw new Error(I18n.t('ZCode 当前接入仅支持原生默认模型，请在原生 CLI 中选择模型'));
    if (next.role === undefined) next.role = '';
    if (typeof next.role !== 'string') throw new Error(I18n.t('成员角色必须为文字'));
    if (next.customRole !== undefined && typeof next.customRole !== 'boolean') throw new Error(I18n.t('角色类型无效'));
    if (next.persona === undefined) next.persona = '';
    if (typeof next.persona !== 'string') throw new Error(I18n.t('角色指令必须为文字'));
    if (next.avatar !== undefined) next.avatar = normalizeAvatar(next.avatar);
    if (next.pricing != null) {
      next.pricing = normalizePricing(next.pricing);
    }
    return next;
  }

  return { ROLE_PRESETS, MAX_AVATAR_BYTES, getDefaultPersona, normalizeAvatar, normalizeBotProfile, normalizePricing, isModelIdentifier };
});
