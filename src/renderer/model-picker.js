'use strict';

window.ModelPicker = (() => {
  let version = 0;
  let wired = false;
  let revision = 0;
  let catalog = { models: [] };
  const byId = id => document.getElementById(id);
  function option(value, label) {
    const node = document.createElement('option'); node.value = value; I18n.label(node, label);
    return node;
  }
  function render(models, selected, keepCustom = false) {
    const select = byId('f_modelSelect');
    select.replaceChildren(option('', I18n.live(() => I18n.t('默认模型'))));
    for (const model of models) select.appendChild(option(model.id, model.label || model.id));
    if (catalog.customAllowed !== false || selected) select.appendChild(option('__custom__', I18n.live(() => I18n.t('自定义模型…'))));
    select.value = keepCustom ? '__custom__' : !selected ? '' : models.some(model => model.id === selected) ? selected : '__custom__';
    byId('f_model').hidden = select.value !== '__custom__';
    const hint = byId('f_modelHelp');
    if (hint) { hint.hidden = select.value !== '__custom__'; I18n.write(hint, () => catalog.customHint || I18n.t('填写当前 Agent 支持的完整模型 ID。')); }
    if (byId('f_modelRemove')) byId('f_modelRemove').hidden = !models.some(model => model.id === selected && model.source === 'saved-bot');
  }
  function renderReasoning(selected = byId('f_reasoningEffort')?.value || '') {
    const field = byId('f_reasoningEffort');
    if (!field) return;
    const cli = byId('f_cliType').value;
    const model = byId('f_model').value.trim();
    const levels = Reasoning.levelsFor(cli, model, catalog.models || []);
    field.replaceChildren(option('', I18n.live(() => I18n.t('默认'))));
    for (const level of levels) field.appendChild(option(level, `${I18n.t(Reasoning.LABELS[level] || level)} (${level})`));
    if (selected && !levels.includes(selected)) {
      // Preserve a saved value long enough to display and fix it, rather than
      // silently erasing an existing member's setting on open or refresh.
      const unavailable = option(selected, I18n.live(() => I18n.tpl`${selected} · 请重新选择`)); unavailable.disabled = true; field.append(unavailable);
    }
    field.value = selected;
    field.disabled = !levels.length;
    const notice = byId('f_reasoningNotice');
    if (notice) I18n.write(notice, () => catalog.models?.find(item => item.id === model)?.reasoningNotice || (levels.length
      ? cli === 'kimi' ? I18n.t('推理设置用于实际会话；连接测试只验证模型连接。') : I18n.t('使用所选模型支持的推理程度；可通过测试连接验证。')
      : I18n.t('此 Agent 或模型暂不支持设置推理程度。')));
    const mode = byId('f_executionMode');
      if (mode) { mode.disabled = !['claude', 'codex'].includes(cli); if (mode.disabled) mode.value = 'chat'; }
  }
  async function load(cliType, selected = '', effort = '', executionMode = 'chat', refresh = false) {
    const request = ++version;
    const initialRevision = revision;
    catalog = { models: [] };
    byId('f_model').value = selected;
    if (byId('f_executionMode')) byId('f_executionMode').value = 'chat';
    render([], selected); renderReasoning(effort);
    I18n.write(byId('f_modelNotice'), () => I18n.t('正在读取模型…'));
    byId('f_modelRefresh').disabled = true;
    try {
      const result = await window.api.listModels(cliType, refresh);
      if (request !== version || cliType !== byId('f_cliType').value) return;
      catalog = result;
      render(result.models || [], byId('f_model').value, revision !== initialRevision && byId('f_modelSelect').value === '__custom__');
      renderReasoning();
      I18n.write(byId('f_modelNotice'), () => result.notice || I18n.t('模型可用性以“测试连接”为准。'));
    } catch (_) {
      if (request === version) I18n.write(byId('f_modelNotice'), () => I18n.t('模型暂不可读取，仍可使用默认模型或填写自定义模型。'));
    } finally { if (request === version) byId('f_modelRefresh').disabled = false; }
  }
  function values() {
    return { reasoningEffort: byId('f_reasoningEffort')?.value || '', executionMode: 'chat' };
  }
  function validate() {
    const value = byId('f_model').value.trim();
    if (byId('f_modelSelect').value === '__custom__' && !value) throw new Error(I18n.t('请填写自定义模型 ID，或选择默认模型'));
    if (value && !BotProfile.isModelIdentifier(value)) throw new Error(I18n.t('模型 ID 格式无效，请填写当前 Agent 支持的模型名称'));
    const selected = values();
    Reasoning.normalizeEffort(byId('f_cliType').value, selected.reasoningEffort, value);
    Reasoning.normalizeExecutionMode(byId('f_cliType').value, selected.executionMode);
  }
  function wire() {
    if (wired) return;
    wired = true;
    const remove = document.createElement('button');
    remove.id = 'f_modelRemove'; remove.type = 'button'; remove.className = 'ghost-btn'; I18n.write(remove, () => I18n.t('移除候选')); remove.hidden = true;
    I18n.write(remove, () => I18n.t('从自定义候选中移除；保存成员后采用重新选择的模型'), 'title');
    byId('f_modelRefresh').after(remove);
    remove.addEventListener('click', async () => {
      const cliType = byId('f_cliType').value, model = byId('f_model').value.trim();
      if (!catalog.models.some(item => item.id === model && item.source === 'saved-bot')) return;
      remove.disabled = true;
      try {
        await window.api.hideModelCandidate({ cliType, model });
        if (byId('f_cliType').value === cliType) await load(cliType);
      } catch (error) { I18n.write(byId('f_modelNotice'), () => I18n.t('移除候选失败，请重试。')); }
      finally { remove.disabled = false; }
    });
    byId('f_modelSelect').addEventListener('change', () => {
      revision += 1;
      const value = byId('f_modelSelect').value;
      byId('f_model').value = value === '__custom__' ? '' : value;
      render(catalog.models || [], byId('f_model').value, value === '__custom__');
      renderReasoning('');
      if (value === '__custom__') byId('f_model').focus();
    });
    byId('f_model').addEventListener('input', () => { revision += 1; renderReasoning(''); });
    byId('f_cliType').addEventListener('change', () => load(byId('f_cliType').value));
    byId('f_modelRefresh').addEventListener('click', () => load(byId('f_cliType').value, byId('f_model').value, values().reasoningEffort, values().executionMode, true));
  }
  return { load, wire, validate, values };
})();
