'use strict';

// Appearance previews are window-local until Settings is saved.
window.AppearanceUI = (() => {
  let saved = AgentTheme.normalizeAppearance();
  let draft = null;
  let wired = false;
  const fields = { background: 'appearanceBackground', sidebar: 'appearanceSidebar', accent: 'appearanceAccent', text: 'appearanceText' };
  const swatches = {
    background: ['#f7f7f8', '#f4f7f9', '#f5f7f4', '#faf7f2', '#f8f4f8', '#202226', '#1c2733', '#222b25'],
    sidebar: ['#f1f2f3', '#eef3f7', '#eff3ed', '#f5f0e9', '#f3edf4', '#191b1f', '#18222d', '#1c251f'],
    accent: ['#3567cf', '#2864a8', '#3b714d', '#965427', '#8755bc', '#b04668', '#147b80', '#545b68'],
    text: ['#25272b', '#354455', '#394c3d', '#5b473b', '#574266', '#713f4f', '#dee4ee', '#f5f5f5'],
  };
  const byId = id => document.getElementById(id);
  const current = () => draft || saved;
  function syncPickers(theme = AgentTheme.applyTheme(current())) {
    const values = { background: '--bg', sidebar: '--sidebar', accent: '--accent-fill', text: '--text' };
    for (const [key, id] of Object.entries(fields)) {
      const color = current()[key] || theme.variables[values[key]];
      byId(id + 'Color').value = color;
      for (const button of byId(id + 'Swatches').querySelectorAll('button')) {
        button.setAttribute('aria-pressed', String(button.dataset.color === color));
      }
    }
    for (const button of byId('appearancePresets').querySelectorAll('button')) {
      const palette = AgentTheme.PRESETS[button.dataset.preset][theme.mode];
      button.style.setProperty('--swatch-background', palette[0]);
      button.style.setProperty('--swatch-sidebar', palette[1]);
      button.setAttribute('aria-pressed', String(button.dataset.preset === current().preset));
    }
  }
  function fill(value) {
    byId('appearanceMode').value = value.mode;
    byId('appearancePreset').value = value.preset;
    byId('appearanceFontSize').value = String(value.fontSize);
    for (const [key, id] of Object.entries(fields)) { byId(id).value = value[key]; byId(id).removeAttribute('aria-invalid'); }
    byId('appearanceError').hidden = true;
    syncPickers();
  }
  function read() {
    const value = { mode: byId('appearanceMode').value, preset: byId('appearancePreset').value, fontSize: Number(byId('appearanceFontSize').value) };
    const invalid = [];
    const invalidSize = !Number.isInteger(value.fontSize) || value.fontSize < 8 || value.fontSize > 24;
    byId('appearanceFontSize').setAttribute('aria-invalid', String(invalidSize));
    if (invalidSize) invalid.push('appearanceFontSize');
    for (const [key, id] of Object.entries(fields)) {
      value[key] = byId(id).value.trim();
      const bad = !!value[key] && !AgentTheme.isColor(value[key]);
      byId(id).setAttribute('aria-invalid', String(bad));
      if (bad) invalid.push(id);
    }
    const error = byId('appearanceError');
    error.hidden = invalid.length === 0;
    I18n.write(error, () => invalidSize ? I18n.t('字号请填写 8–24 之间的整数。') : invalid.length ? I18n.t('颜色请填写 # 加六位十六进制数字，或留空使用预设。') : '');
    return invalid.length ? null : AgentTheme.normalizeAppearance(value);
  }
  function preview() {
    const value = read();
    if (!value) return;
    draft = value;
    syncPickers();
  }
  function setSaved(value) {
    saved = AgentTheme.normalizeAppearance(value);
    if (!draft) AgentTheme.applyTheme(saved);
  }
  function cancel() { draft = null; AgentTheme.applyTheme(saved); }
  function open(value) { setSaved(value); draft = { ...saved }; fill(draft); }
  function commit(value) { draft = null; setSaved(value); }
  function selectPreset(preset) {
    byId('appearancePreset').value = preset;
    for (const id of Object.values(fields)) byId(id).value = '';
    preview();
  }
  function wire() {
    if (wired) return;
    wired = true;
    byId('appearanceMode').addEventListener('change', preview);
    byId('appearanceFontSize').addEventListener('change', preview);
    byId('appearancePreset').addEventListener('change', () => selectPreset(byId('appearancePreset').value));
    for (const [preset, palette] of Object.entries(AgentTheme.PRESETS)) {
      const button = document.createElement('button'); button.type = 'button';
      button.className = 'appearance-preset'; button.dataset.preset = preset;
      const swatch = document.createElement('span'); swatch.className = 'appearance-swatch'; swatch.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span'); I18n.write(label, () => I18n.t(palette.label)); button.append(swatch, label);
      button.addEventListener('click', () => selectPreset(preset));
      byId('appearancePresets').append(button);
    }
    for (const [key, id] of Object.entries(fields)) {
      for (const color of swatches[key]) {
        const button = document.createElement('button'); button.type = 'button';
        button.className = 'appearance-color-swatch'; button.dataset.color = color;
        button.style.backgroundColor = color;
        button.title = color; I18n.attr(button, 'aria-label', () => I18n.tpl`选用 ${color}`);
        button.addEventListener('click', () => { byId(id).value = color; preview(); });
        byId(id + 'Swatches').append(button);
      }
      byId(id + 'Reset').addEventListener('click', () => { byId(id).value = ''; preview(); });
      byId(id).addEventListener('input', preview);
      byId(id + 'Color').addEventListener('input', () => {
        byId(id).value = byId(id + 'Color').value;
        preview();
      });
    }
    byId('appearanceReset').addEventListener('click', () => {
      draft = { ...AgentTheme.DEFAULT_APPEARANCE }; fill(draft);
    });
    AgentTheme.watchSystemTheme(current, { onChange: theme => { if (draft) syncPickers(theme); } });
  }
  AgentTheme.applyTheme(saved);
  return { open, read, commit, cancel, setSaved, wire };
})();
