'use strict';

// Translation is explicitly invoked at application-owned text boundaries.
// Interpolated names, paths, messages and native output are passed through intact.
(function(root, factory) {
  const api = factory(typeof module === 'object' && module.exports
    ? { ...require('./i18n-catalog'), ...require('./i18n-main-catalog') }
    : { ...root.I18nCatalog, ...root.I18nMainCatalog });
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.I18n = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(catalog) {
  let locale = 'zh-CN';
  const listeners = new Set(), missing = new Set();
  const normalize = value => value === 'en' ? 'en' : 'zh-CN';
  function phrase(source) {
    source = String(source ?? '');
    if (locale !== 'en' || !/[\u3400-\u9fff]/.test(source)) return source;
    const key = source.trim();
    if (Object.hasOwn(catalog, key)) return source.slice(0, source.indexOf(key)) + catalog[key] + source.slice(source.indexOf(key) + key.length);
    missing.add(key); return source;
  }
  function t(source) {
    return String(source ?? '').split(/(<[^>]*>)/g).map(part => part.startsWith('<')
      ? part.replace(/((?:title|placeholder|aria-label|data-placeholder)=")([^"]*)(")/g, (_, before, text, after) => before + phrase(text) + after)
      : phrase(part)).join('');
  }
  function parts(strings, values = []) {
    const key = strings.map((part, index) => part + (index < values.length ? `{${index}}` : '')).join('');
    if (locale === 'en' && Object.hasOwn(catalog, key)) return catalog[key].replace(/\{(\d+)\}/g, (_, index) => String(values[Number(index)] ?? ''));
    return strings.map((part, index) => t(part) + (index < values.length ? String(values[index] ?? '') : '')).join('');
  }
  function tpl(strings, ...values) { return parts(strings, values); }
  function setLanguage(value) {
    const next = normalize(value), changed = next !== locale; locale = next;
    if (changed) for (const listener of listeners) listener(next);
    return locale;
  }
  return { t, tpl, parts, html: tpl, phrase, setLanguage, normalize, get language() { return locale; },
    onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    getMissing() { return [...missing]; }, clearMissing() { missing.clear(); } };
});
