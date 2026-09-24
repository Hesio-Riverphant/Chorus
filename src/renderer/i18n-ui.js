'use strict';

(() => {
  const bindings = new WeakMap(), elements = new Set();
  const released = new FinalizationRegistry(reference => elements.delete(reference));
  const track = element => {
    const reference = new WeakRef(element); elements.add(reference); released.register(element, reference);
  };
  const translate = I18n.t;
  const escapeAttribute = value => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  // HTML comes only from tagged, source-owned literals. Values interpolated into
  // these templates are appended afterwards and never examined here.
  I18n.t = source => {
    const text = String(source ?? '');
    if (!text.includes('<')) return translate(text);
    let translatedContainer = false;
    const marked = text.replace(/<(option)([^>]*)>([^<>]+)<\/option>/g, (whole, tag, attrs, value) => /[\u3400-\u9fff]/.test(value)
      ? '<option' + attrs + ' data-i18n="' + escapeAttribute(value) + '">' + value + '</option>' : whole);
    return marked.split(/(<[^>]*>)/g).map(part => {
      if (part.startsWith('<')) {
        translatedContainer = part.startsWith('<option') && part.includes('data-i18n=');
        const attributes = {};
        for (const match of part.matchAll(/(title|placeholder|aria-label|data-placeholder)="([^"]*)"/g)) {
          if (/[\u3400-\u9fff]/.test(match[2])) attributes[match[1]] = match[2];
        }
        const result = translate(part);
        return Object.keys(attributes).length ? result.replace(/(\/?>)$/, ' data-i18n-attrs="' + escapeAttribute(JSON.stringify(attributes)) + '"$1') : result;
      }
      return /[\u3400-\u9fff]/.test(part) ? translatedContainer ? translate(part) : '<span data-i18n="' + escapeAttribute(part) + '">' + translate(part) + '</span>' : part;
    }).join('');
  };
  I18n.html = (parts, ...values) => parts.map((part,index) => I18n.t(part) + (index < values.length ? String(values[index] ?? '') : '')).join('');
  // Explicit setter bindings recompute only the application's source expression.
  // They never search for or replace words inside existing DOM or user input.
  I18n.write = (element, read, property = 'textContent') => {
    if (!element) return '';
    const value = String(read() ?? ''); element[property] = value;
    let entries = bindings.get(element); if (!entries) { bindings.set(element, entries = new Map()); track(element); }
    entries.set(property, { read, value }); return value;
  };
  I18n.attr = (element, name, read) => {
    const value = String(read() ?? ''); element.setAttribute(name, value);
    let entries = bindings.get(element); if (!entries) { bindings.set(element, entries = new Map()); track(element); }
    entries.set('@' + name, { read, value }); return value;
  };
  I18n.live = read => ({ toString: () => String(read()), [Symbol.toPrimitive]: () => String(read()) });
  I18n.label = (element, value, property = 'textContent') => {
    if (value && typeof value === 'object') return I18n.write(element, () => value, property);
    element[property] = String(value ?? '');
  };
  I18n.applyStatic = (root = document) => {
    for (const element of root.querySelectorAll('[data-i18n]')) element.textContent = I18n.phrase(element.dataset.i18n);
    for (const element of root.querySelectorAll('[data-i18n-attrs]')) {
      for (const [name, source] of Object.entries(JSON.parse(element.dataset.i18nAttrs))) element.setAttribute(name, I18n.phrase(source));
    }
    document.documentElement.lang = I18n.language;
  };
  I18n.onChange(() => {
    I18n.applyStatic();
    for (const reference of elements) {
      const element = reference.deref();
      if (!element?.isConnected) { elements.delete(reference); continue; }
      const entries = bindings.get(element);
      for (const [property, entry] of entries) {
        const attribute = property.startsWith('@');
        const current = attribute ? element.getAttribute(property.slice(1)) : element[property];
        // A native event or another component may have replaced a status since
        // it was created. Its new content owns the node; do not restore a stale label.
        if (current !== entry.value) { entries.delete(property); continue; }
        entry.value = String(entry.read() ?? '');
        if (attribute) element.setAttribute(property.slice(1), entry.value);
        else element[property] = entry.value;
      }
    }
  });
  document.addEventListener('DOMContentLoaded', () => I18n.applyStatic());
})();
