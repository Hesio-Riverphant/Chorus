/* Renderer-only appearance helpers; also loadable by Node for deterministic checks. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AgentTheme = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_APPEARANCE = Object.freeze({ mode: 'light', preset: 'graphite', accent: '', background: '', sidebar: '', text: '', fontSize: 14 });
  const PRESETS = Object.freeze({
    graphite: { label: '浅灰', light: ['#f7f7f8', '#f1f2f3', '#3567cf'], dark: ['#202226', '#191b1f', '#88acff'] },
    mist: { label: '雾蓝', light: ['#f4f7f9', '#eef3f7', '#2864a8'], dark: ['#1c2733', '#18222d', '#85baf0'] },
    sage: { label: '鼠尾草', light: ['#f5f7f4', '#eff3ed', '#3b714d'], dark: ['#222b25', '#1c251f', '#91c6a0'] },
    sand: { label: '暖沙', light: ['#faf7f2', '#f5f0e9', '#965427'], dark: ['#2d2722', '#26211c', '#e5b184'] },
  });
  const isColor = value => typeof value === 'string' && /^#[\da-f]{6}$/i.test(value);
  function normalizeAppearance(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return {
      mode: ['system', 'light', 'dark'].includes(source.mode) ? source.mode : DEFAULT_APPEARANCE.mode,
      preset: Object.prototype.hasOwnProperty.call(PRESETS, source.preset) ? source.preset : DEFAULT_APPEARANCE.preset,
      accent: isColor(source.accent) ? source.accent.toLowerCase() : '',
      background: isColor(source.background) ? source.background.toLowerCase() : '',
      sidebar: isColor(source.sidebar) ? source.sidebar.toLowerCase() : '',
      text: isColor(source.text) ? source.text.toLowerCase() : '',
      fontSize: Number.isInteger(source.fontSize) && source.fontSize >= 8 && source.fontSize <= 24 ? source.fontSize : DEFAULT_APPEARANCE.fontSize,
    };
  }
  const rgb = color => [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
  function mix(a, b, amount) {
    const other = rgb(b);
    return '#' + rgb(a).map((v, i) => Math.round(v * (1 - amount) + other[i] * amount).toString(16).padStart(2, '0')).join('');
  }
  function luminance(color) {
    const values = rgb(color).map(value => {
      const c = value / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
  }
  function contrast(a, b) {
    const x = luminance(a), y = luminance(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }
  function readable(surfaces) {
    const score = color => Math.min(...surfaces.map(surface => contrast(color, surface)));
    return score('#000000') >= score('#ffffff') ? '#000000' : '#ffffff';
  }
  function ensureContrast(color, surfaces, target = 4.5) {
    const end = readable(surfaces);
    for (let step = 0; step <= 100; step++) {
      const candidate = mix(color, end, step / 100);
      if (surfaces.every(surface => contrast(candidate, surface) >= target)) return candidate;
    }
    return end;
  }
  function resolveTheme(value, systemDark = false) {
    const appearance = normalizeAppearance(value);
    const mode = appearance.mode === 'system' ? (systemDark ? 'dark' : 'light') : appearance.mode;
    const palette = PRESETS[appearance.preset][mode];
    const bg = appearance.background || palette[0];
    const sidebar = appearance.sidebar || palette[1];
    const fill = appearance.accent || palette[2];
    // All reading surfaces stay close to the selected color, including custom midtones.
    const baseText = readable([bg]);
    const opposite = baseText === '#000000' ? '#ffffff' : '#000000';
    const panel = mix(bg, opposite, 0.10);
    const raised = mix(bg, opposite, 0.18);
    const surfaces = [bg, panel, raised];
    const text = ensureContrast(appearance.text || mix(baseText, bg, 0.10), surfaces);
    const muted = ensureContrast(mix(text, bg, 0.28), surfaces);
    // Keep tinted surfaces on the same luminance side so one text color remains readable.
    const soft = mix(panel, fill, 0.06);
    surfaces.push(soft);
    const accent = ensureContrast(fill, surfaces);
    const sideBase = readable([sidebar]);
    const sideSurface = amount => {
      const candidate = mix(sidebar, sideBase, amount);
      return contrast(sideBase, candidate) >= 4.5 ? candidate :
        mix(sidebar, sideBase === '#ffffff' ? '#000000' : '#ffffff', amount);
    };
    const sideHover = sideSurface(0.06);
    const sideActive = sideSurface(0.10);
    const sideSurfaces = [sidebar, sideHover, sideActive];
    const sideText = ensureContrast(appearance.text || mix(sideBase, sidebar, 0.10), sideSurfaces);
    const dangerSoft = mix(panel, '#dc2626', 0.05);
    const danger = ensureContrast('#dc2626', [...surfaces, dangerSoft]);
    const variables = {
      '--bg': bg, '--panel': panel, '--raised': raised, '--border': mix(bg, baseText, 0.14),
      '--text': ensureContrast(text, [...surfaces, dangerSoft]), '--text-2': ensureContrast(muted, [...surfaces, dangerSoft]),
      '--accent': accent, '--accent-fill': fill, '--accent-on': readable([fill]),
      '--accent-hover': mix(fill, readable([fill]), 0.08), '--accent-hover-on': readable([mix(fill, readable([fill]), 0.08)]),
      '--accent-soft': soft, '--accent-border': mix(panel, accent, 0.40),
      '--danger': danger, '--danger-soft': dangerSoft, '--danger-border': mix(panel, danger, 0.38),
      '--danger-on': readable([danger]), '--danger-hover': mix(danger, readable([danger]), 0.08),
      '--danger-hover-on': readable([mix(danger, readable([danger]), 0.08)]), '--ok': ensureContrast('#16803c', surfaces),
      '--mine': soft, '--code': raised, '--system': panel,
      '--sidebar': sidebar, '--sidebar-text': sideText,
      '--sidebar-muted': ensureContrast(mix(sideText, sidebar, 0.22), sideSurfaces),
      '--sidebar-border': mix(sidebar, sideBase, 0.12), '--sidebar-hover': sideHover, '--sidebar-active': sideActive,
      '--sidebar-accent': ensureContrast(fill, sideSurfaces),
      '--logo-bg': raised, '--logo-filter': readable([raised]) === '#ffffff' ? 'invert(1)' : 'none',
      '--backdrop': 'rgba(0, 0, 0, 0.48)', '--shadow': '0 6px 24px rgba(0, 0, 0, 0.22)',
      '--ui-font-size': `${appearance.fontSize}px`,
    };
    return { appearance, mode, colorScheme: baseText === '#ffffff' ? 'dark' : 'light', variables };
  }
  function applyTheme(value, options = {}) {
    const target = options.root || (typeof document === 'object' ? document.documentElement : null);
    const dark = typeof options.systemDark === 'boolean' ? options.systemDark :
      (typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches);
    const theme = resolveTheme(value, dark);
    if (target) {
      for (const [name, color] of Object.entries(theme.variables)) target.style.setProperty(name, color);
      target.style.colorScheme = theme.colorScheme;
      target.dataset.theme = theme.mode;
      target.dataset.themePreset = theme.appearance.preset;
    }
    return theme;
  }
  function watchSystemTheme(getAppearance, options = {}) {
    const media = options.media || (typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null);
    const update = () => {
      const theme = applyTheme(getAppearance(), { ...options, systemDark: !!media?.matches });
      if (typeof options.onChange === 'function') options.onChange(theme);
    };
    update();
    if (media?.addEventListener) media.addEventListener('change', update);
    else if (media?.addListener) media.addListener(update);
    return () => {
      if (media?.removeEventListener) media.removeEventListener('change', update);
      else if (media?.removeListener) media.removeListener(update);
    };
  }
  return { DEFAULT_APPEARANCE, PRESETS, isColor, normalizeAppearance, resolveTheme, applyTheme, watchSystemTheme, contrast };
});
