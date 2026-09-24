const test = require('node:test');
const assert = require('node:assert/strict');
const theme = require('../src/shared/appearance');

test('appearance defaults and malformed persisted values normalize safely', () => {
  assert.deepEqual(theme.normalizeAppearance(null), theme.DEFAULT_APPEARANCE);
  assert.deepEqual(theme.normalizeAppearance({ mode: 'bad', preset: '__proto__', background: 'url(x)', sidebar: '#abc', accent: '#ABCDEF' }), {
    ...theme.DEFAULT_APPEARANCE, accent: '#abcdef',
  });
  assert.equal(theme.resolveTheme({}).variables['--bg'], '#f7f7f8');
  assert.equal(theme.resolveTheme({}).variables['--sidebar'], '#f1f2f3');
});

test('light presets use adjacent near-white surfaces', () => {
  for (const preset of Object.keys(theme.PRESETS)) {
    const v = theme.resolveTheme({ mode: 'light', preset }).variables;
    for (const surface of ['--bg', '--sidebar']) assert.ok(theme.contrast('#000000', v[surface]) >= 18);
    assert.ok(theme.contrast(v['--bg'], v['--sidebar']) < 1.1);
  }
});

test('UI font size is bounded and valid custom text colors apply to both areas', () => {
  for (const fontSize of [null, '16', NaN, 7, 25, 14.5]) {
    assert.equal(theme.normalizeAppearance({ fontSize }).fontSize, 14);
  }
  for (const fontSize of [8, 9, 10, 11, 12, 14, 17, 20, 21, 24]) {
    assert.equal(theme.resolveTheme({ fontSize }).variables['--ui-font-size'], `${fontSize}px`);
  }
  const v = theme.resolveTheme({ text: '#354455' }).variables;
  assert.equal(v['--text'], '#354455');
  assert.equal(v['--sidebar-text'], '#354455');
  assert.equal(theme.normalizeAppearance({ text: '#ABCDEF' }).text, '#abcdef');
  assert.equal(theme.normalizeAppearance({ text: 'inherit' }).text, '');
});

test('presets and custom colors produce readable foregrounds across all used surfaces', () => {
  const scenarios = [];
  for (const preset of Object.keys(theme.PRESETS)) {
    for (const mode of ['light', 'dark']) scenarios.push({ preset, mode });
  }
  const colors = ['#000000', '#ffffff', '#ffff00', '#0000ff', '#ff0000', '#777777', '#888888', '#00ff00', '#ff00ff', '#00ffff'];
  for (const background of colors) for (const accent of colors) scenarios.push({ background, accent, sidebar: background });
  for (const background of colors) for (const text of colors) scenarios.push({ background, text, sidebar: background });
  for (const scenario of scenarios) {
    const v = theme.resolveTheme(scenario).variables;
    for (const foreground of ['--text', '--text-2']) {
      for (const surface of ['--bg', '--panel', '--raised', '--mine', '--code', '--system', '--danger-soft']) {
        assert.ok(theme.contrast(v[foreground], v[surface]) >= 4.5, JSON.stringify({ scenario, foreground, surface, contrast: theme.contrast(v[foreground], v[surface]) }));
      }
    }
    for (const surface of ['--bg', '--panel', '--raised', '--accent-soft']) {
      assert.ok(theme.contrast(v['--accent'], v[surface]) >= 4.5);
    }
    for (const foreground of ['--sidebar-text', '--sidebar-muted', '--sidebar-accent']) {
      for (const surface of ['--sidebar', '--sidebar-hover', '--sidebar-active']) {
        assert.ok(theme.contrast(v[foreground], v[surface]) >= 4.5, JSON.stringify({ scenario, foreground, surface }));
      }
    }
    for (const [fg, bg] of [['--accent-on', '--accent-fill'], ['--accent-hover-on', '--accent-hover'], ['--danger-on', '--danger'], ['--danger-hover-on', '--danger-hover']]) {
      assert.ok(theme.contrast(v[fg], v[bg]) >= 4.5);
    }
  }
});

test('explicit custom colors survive mode changes and preset palettes differ', () => {
  const overrides = { background: '#224466', sidebar: '#ccaa66', accent: '#ccee33' };
  for (const mode of ['light', 'dark']) {
    const v = theme.resolveTheme({ ...overrides, mode }).variables;
    assert.equal(v['--bg'], overrides.background);
    assert.equal(v['--sidebar'], overrides.sidebar);
    assert.equal(v['--accent-fill'], overrides.accent);
  }
  assert.notEqual(theme.resolveTheme({ mode: 'light' }).variables['--bg'], theme.resolveTheme({ mode: 'dark' }).variables['--bg']);
});

test('system mode responds live, fixed mode remains fixed, listener is disposable', () => {
  const properties = new Map();
  const root = { dataset: {}, style: { setProperty: (key, value) => properties.set(key, value) } };
  let listener, removed;
  const media = { matches: false, addEventListener: (type, fn) => { assert.equal(type, 'change'); listener = fn; }, removeEventListener: (type, fn) => { removed = fn; } };
  let appearance = { mode: 'system' };
  const dispose = theme.watchSystemTheme(() => appearance, { root, media });
  assert.equal(root.dataset.theme, 'light');
  assert.equal(properties.get('--bg'), '#f7f7f8');
  media.matches = true;
  listener();
  assert.equal(root.dataset.theme, 'dark');
  assert.equal(root.style.colorScheme, 'dark');
  appearance = { mode: 'light' };
  listener();
  assert.equal(root.dataset.theme, 'light');
  dispose();
  assert.equal(removed, listener);
});
