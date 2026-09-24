'use strict';
const PricingUI = (() => {
  let host, profiles = [], original = {};
  const catalogs = new Map();
  const pendingCatalogs = new Map();
  function loadCatalog(cli, refresh) {
    if (!pendingCatalogs.has(cli)) {
      pendingCatalogs.set(cli, window.api.listModels(cli, refresh).then(result => {
        catalogs.set(cli, result); return result;
      }).finally(() => pendingCatalogs.delete(cli)));
    }
    return pendingCatalogs.get(cli);
  }
  const node = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text != null) I18n.label(el, text); return el; };
  function field(parent, label, key, value, type = 'text') {
    const wrap = node('label', 'field'), input = node('input'); input.type = type; input.dataset.price = key; input.value = value ?? '';
    if (type === 'number') { input.min = '0'; input.step = 'any'; }
    wrap.append(node('span', '', label), input); parent.append(wrap); return input;
  }
  function rateFields(parent, values) {
    const grid = node('div', 'field-grid'); parent.append(grid);
    field(grid, I18n.t('输入缓存未命中 $ / 1M tokens'), 'inputPerMillion', values.inputPerMillion, 'number');
    const cached = field(grid, I18n.t('输入缓存命中 $ / 1M tokens'), 'cachedInputPerMillion', values.cachedInputPerMillion, 'number'); I18n.write(cached, () => I18n.t('留空按未命中单价'), 'placeholder');
    field(grid, I18n.t('输出 $ / 1M tokens'), 'outputPerMillion', values.outputPerMillion, 'number');
  }
  function showCard(group, card) {
    for (const item of group.querySelectorAll('[data-pricing-card]')) item.hidden = item !== card;
    for (const item of group.querySelectorAll('[data-pricing-card]')) item.refreshModelSelector?.();
  }
  function modelField(parent, cli, value = '') {
    const label = node('label', 'field'), row = node('div', 'row-inline'), select = node('select');
    select.className = 'pricing-model-select'; I18n.attr(select, 'aria-label', () => I18n.t('计价模型'));
    const input = node('input'); input.dataset.price = 'model'; input.value = value; I18n.write(input, () => I18n.t('填写完整模型 ID'), 'placeholder');
    const refresh = node('button', 'ghost-btn', I18n.live(() => I18n.t('获取模型列表'))); refresh.type = 'button';
    const notice = node('small', 'hint'); notice.setAttribute('role', 'status');
    let customSelected = false;
    const render = () => {
      const group = parent.closest('.pricing-agent');
      const configured = [...(group?.querySelectorAll('[data-price="model"]') || [])].map(item => item.value.trim()).filter(Boolean);
      const models = [...new Map([...configured.map(id => ({ id })), ...(catalogs.get(cli)?.models || [])].map(model => [model.id, model])).values()];
      const selected = input.value;
      select.replaceChildren();
      for (const model of [{ id: '', label: I18n.t('选择模型') }, ...models, { id: '__custom__', label: I18n.t('自定义模型…') }]) {
        const option = node('option', '', model.label || model.id); option.value = model.id; select.append(option);
      }
      select.value = customSelected || selected && !models.some(model => model.id === selected) ? '__custom__' : selected;
      input.hidden = !!selected || select.value !== '__custom__';
    };
    const navigate = model => {
      const group = parent.closest('.pricing-agent');
      const existing = [...group.querySelectorAll('[data-pricing-card]')].find(item => item.querySelector('[data-price="model"]').value.trim() === model);
      if (existing) { render(); showCard(group, existing); return; }
      // Choosing a different model navigates to its own draft, never renames a tariff.
      if (input.value.trim()) { render(); showCard(group, addCard(group, { model })); return; }
      input.value = model; customSelected = !model; showCard(group, parent);
    };
    select.onchange = () => {
      const choice = select.value;
      if (!choice) { render(); return; }
      navigate(choice === '__custom__' ? '' : choice);
      if (choice === '__custom__') parent.closest('.pricing-agent').querySelector('[data-pricing-card]:not([hidden])').editCustomModel();
      const current = parent.closest('.pricing-agent').querySelector('[data-pricing-card]:not([hidden]) [data-price="model"]');
      if (current && !current.hidden) current.focus();
    };
    input.onchange = () => {
      const model = input.value.trim(), group = parent.closest('.pricing-agent');
      if (model && !/^[A-Za-z0-9][A-Za-z0-9_./:@+\[\]-]{0,199}$/.test(model)) return;
      const existing = [...group.querySelectorAll('[data-pricing-card]')].find(item => item !== parent && item.querySelector('[data-price="model"]').value.trim() === model);
      if (existing) { input.value = ''; showCard(group, existing); }
      else { input.value = model; customSelected = !model; showCard(group, parent); }
    };
    parent.refreshModelSelector = render;
    parent.editCustomModel = () => { customSelected = true; render(); input.focus(); };
    const load = async force => {
      refresh.disabled = true; I18n.write(notice, () => I18n.t('正在读取模型…'));
      try {
        const result = await loadCatalog(cli, force); render();
        I18n.write(notice, () => result.notice || I18n.t('模型目录来自当前 Agent 配置。'));
      } catch { I18n.write(notice, () => I18n.t('读取模型失败，可重试或填写自定义模型。')); }
      finally { refresh.disabled = false; }
    };
    refresh.onclick = () => load(true);
    row.append(select, refresh); label.append(node('span', '', I18n.live(() => I18n.t('计价模型'))), row, input, notice); parent.append(label); render();
    if (!catalogs.has(cli)) void load(false);
  }
  function readCard(card) {
    const val = key => card.querySelector(`[data-price="${key}"]`);
    const rate = container => Object.fromEntries(['inputPerMillion', 'cachedInputPerMillion', 'outputPerMillion'].map(key => {
      const text = container.querySelector(`[data-price="${key}"]`).value;
      return [key, text === '' ? key === 'cachedInputPerMillion' ? null : undefined : Number(text)];
    }));
    const tariff = { model: val('model').value.trim(), enabled: val('enabled').checked, ...rate(card.querySelector('.pricing-peak')) };
    if (val('offPeakEnabled').checked) {
      tariff.offPeak = { enabled: true, ...rate(card.querySelector('.pricing-low')) }; tariff.timeZone = val('timeZone').value.trim();
      tariff.peakPeriods = [...card.querySelectorAll('.pricing-period')].map(period => ({
        days: [...period.querySelectorAll('.pricing-days input:checked')].map(input => Number(input.value)),
        start: period.querySelector('[data-price="start"]').value, end: period.querySelector('[data-price="end"]').value,
      }));
    }
    return tariff;
  }
  async function copyPrices(group, card) {
    let tariff;
    try { tariff = AgentPricing.normalizeTariff(readCard(card)); }
    catch (error) { await AppDialog.alert(error.message); return; }
    const panel = node('div', 'pricing-copy');
    const previous = card.querySelector('.pricing-copy'); if (previous) { previous.remove(); return; }
    panel.append(node('strong', '', I18n.live(() => I18n.t('复制到其他模型'))));
    const targets = node('div', 'pricing-copy-targets'); panel.append(targets);
    const known = [...new Set([...(catalogs.get(group.dataset.cli)?.models || []).map(item => item.id),
      ...[...group.querySelectorAll('[data-price="model"]')].map(input => input.value.trim())])].filter(id => id && id !== tariff.model);
    for (const id of known) {
      const label = node('label', 'inline-check'), input = node('input'); input.type = 'checkbox'; input.value = id;
      label.append(input, node('span', '', id)); targets.append(label);
    }
    const custom = field(panel, I18n.t('其他模型 ID（逗号或空格分隔）'), 'copyModels', '', 'text');
    I18n.write(custom, () => I18n.t('多个模型以逗号或空格分隔'), 'placeholder');
    panel.append(node('p', 'hint', I18n.live(() => I18n.t('复制包含三类单价、空闲价格和时段。已有模型的价格会被替换，保存设置后生效。'))));
    const status = node('p', 'hint'), apply = node('button', 'ghost-btn', I18n.live(() => I18n.t('复制价格表'))); apply.type = 'button';
    apply.onclick = () => {
      const ids = [...new Set([...targets.querySelectorAll('input:checked')].map(input => input.value).concat(custom.value.split(/[\s,，]+/).filter(Boolean)))].filter(id => id !== tariff.model);
      try {
        if (!ids.length) throw new Error(I18n.t('请至少选择一个目标模型'));
        const source = AgentPricing.normalizeTariff(readCard(card));
        const copies = ids.filter(model => model !== source.model).map(model => AgentPricing.normalizeTariff({ ...source, model }));
        const existing = [...group.querySelectorAll('[data-pricing-card]')];
        if (new Set([...existing.map(item => item.querySelector('[data-price="model"]').value.trim()), ...ids]).size > 100) throw new Error(I18n.t('每个 Agent 最多配置 100 个模型'));
        for (const copy of copies) {
          const old = existing.filter(item => item.querySelector('[data-price="model"]').value.trim() === copy.model);
          const added = addCard(group, copy);
          if (old.length) { old[0].before(added); for (const item of old) item.remove(); }
        }
        showCard(group, card);
        panel.remove();
      } catch (error) { status.textContent = error.message; }
    };
    panel.append(apply, status); card.append(panel);
  }
  function addPeriod(host, period) {
    const row = node('div', 'pricing-period');
    const days = node('div', 'pricing-days'); days.setAttribute('role', 'group'); I18n.attr(days, 'aria-label', () => I18n.t('高峰星期'));
    for (const day of [1, 2, 3, 4, 5, 6, 0]) {
      const label = node('label', 'inline-check'), input = node('input'); input.type = 'checkbox'; input.value = day; input.checked = period.days.includes(day);
      label.append(input, node('span', '', I18n.live(() => [I18n.t('日'), I18n.t('一'), I18n.t('二'), I18n.t('三'), I18n.t('四'), I18n.t('五'), I18n.t('六')][day]))); days.append(label);
    }
    row.append(days); const clock = node('div', 'row-inline'); row.append(clock);
    field(clock, I18n.t('高峰开始（含）'), 'start', period.start, 'time'); field(clock, I18n.t('高峰结束（不含）'), 'end', period.end, 'time');
    const remove = node('button', 'ghost-btn', I18n.live(() => I18n.t('移除此时段'))); remove.type = 'button'; remove.onclick = () => row.remove(); clock.append(remove); host.append(row);
  }
  function addCard(group, tariff = {}) {
    const card = node('section', 'pricing-card'); card.dataset.pricingCard = 'true';
    card.dataset.pricingDraft = String(tariff.inputPerMillion == null && tariff.outputPerMillion == null);
    const title = node('div', 'row-inline'), enabled = node('input'); enabled.type = 'checkbox'; enabled.dataset.price = 'enabled'; enabled.checked = tariff.enabled !== false;
    const label = node('label', 'inline-check'); label.append(enabled, node('span', '', I18n.live(() => I18n.t('启用模型计价')))); title.append(label);
    const remove = node('button', 'ghost-btn danger', I18n.live(() => I18n.t('删除此单价'))); remove.type = 'button';
    remove.onclick = () => { card.remove(); const next = group.querySelector('[data-pricing-card]'); if (next) showCard(group, next); };
    title.append(remove); card.append(title);
    modelField(card, group.dataset.cli, tariff.model);
    const peak = node('div', 'pricing-peak'); peak.append(node('strong', '', I18n.live(() => I18n.t('常规 / 高峰价格')))); rateFields(peak, tariff); card.append(peak);
    const lowLabel = node('label', 'inline-check'), lowToggle = node('input'); lowToggle.type = 'checkbox'; lowToggle.dataset.price = 'offPeakEnabled'; lowToggle.checked = !!tariff.offPeak?.enabled;
    lowLabel.append(lowToggle, node('span', '', I18n.live(() => I18n.t('设置空闲价格')))); card.append(lowLabel);
    const schedule = node('div', 'pricing-schedule'); schedule.hidden = !lowToggle.checked; lowToggle.onchange = () => { schedule.hidden = !lowToggle.checked; };
    const low = node('div', 'pricing-low'); low.append(node('strong', '', I18n.live(() => I18n.t('空闲价格')))); rateFields(low, tariff.offPeak || {}); schedule.append(low);
    schedule.append(node('h4', '', I18n.live(() => I18n.t('时段规则：高峰时段以外自动使用空闲价格'))));
    field(schedule, I18n.t('服务商计价时区'), 'timeZone', tariff.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone);
    schedule.append(node('p', 'hint', I18n.live(() => I18n.t('所选星期与时段使用高峰价格，其余时间使用空闲价格。跨午夜时段延续到次日结束时间。'))));
    const periods = node('div', 'pricing-periods'); schedule.append(periods);
    for (const period of tariff.peakPeriods || AgentPricing.DEFAULT_PERIODS) addPeriod(periods, period);
    const add = node('button', 'ghost-btn', I18n.live(() => I18n.t('添加高峰时段'))); add.type = 'button'; add.onclick = () => addPeriod(periods, { days: [1, 2, 3, 4, 5], start: '09:00', end: '12:00' }); schedule.append(add);
    card.append(schedule);
    const copy = node('button', 'ghost-btn', I18n.live(() => I18n.t('复制到其他模型…'))); copy.type = 'button'; copy.onclick = () => copyPrices(group, card); card.append(copy);
    group.querySelector('.pricing-cards').append(card);
    card.hidden = group.querySelectorAll('[data-pricing-card]').length > 1;
    for (const item of group.querySelectorAll('[data-pricing-card]')) item.refreshModelSelector?.();
    return card;
  }
  function open(value, available, bots = []) {
    const selectedModels = new Map([...host?.querySelectorAll('.pricing-agent') || []].map(group => [group.dataset.cli,
      group.querySelector('[data-pricing-card]:not([hidden]) [data-price="model"]')?.value]));
    original = structuredClone(value); profiles = available; host = document.getElementById('agentPricingEditor'); host.replaceChildren();
    const select = node('select'); select.id = 'pricingAgent'; I18n.attr(select, 'aria-label', () => I18n.t('计价 Agent'));
    const ids = [...new Set([...profiles.filter(p => p.enabled !== false).map(p => p.id), ...Object.keys(value)])];
    const label = node('label', 'field'); label.append(node('span', '', 'Agent'), select); host.append(label);
    for (const cli of ids) {
      const option = node('option', '', profiles.find(p => p.id === cli)?.label || cli); option.value = cli; select.append(option);
      const group = node('div', 'pricing-agent'); group.dataset.cli = cli;
      const cards = node('div', 'pricing-cards'); group.append(cards); host.append(group);
      for (const tariff of value[cli] || []) addCard(group, tariff);
      const selected = [...group.querySelectorAll('[data-pricing-card]')].find(card => card.querySelector('[data-price="model"]').value === selectedModels.get(cli));
      if (selected) showCard(group, selected);
      const add = node('button', 'ghost-btn', I18n.live(() => I18n.t('添加模型单价'))); add.type = 'button';
      add.onclick = () => {
        const blank = [...group.querySelectorAll('[data-pricing-card]')].find(item => !item.querySelector('[data-price="model"]').value.trim());
        const card = blank || addCard(group); showCard(group, card); card.editCustomModel();
      };
      group.append(add);
    }
    select.onchange = () => { for (const group of host.querySelectorAll('.pricing-agent')) group.hidden = group.dataset.cli !== select.value; }; select.onchange();
    if (!ids.length) host.append(node('p', 'hint', I18n.live(() => I18n.t('请先在 Agent 接入中启用一个 Agent。'))));
    if (!Object.keys(value).length && bots.some(bot => bot.pricing?.enabled)) host.append(node('p', 'hint', I18n.live(() => I18n.t('请在这里确认 Agent 的统一单价；历史消息保留原计价依据。'))));
  }
  function read() {
    const result = {};
    for (const group of host?.querySelectorAll('.pricing-agent') || []) {
      const tariffs = [];
      for (const card of group.querySelectorAll('[data-pricing-card]')) {
        const tariff = readCard(card), { model, enabled } = tariff;
        // Merely browsing an unconfigured model creates no persisted price entry.
        if (card.dataset.pricingDraft === 'true' && !card.querySelector('.pricing-peak [data-price="inputPerMillion"]').value &&
            !card.querySelector('.pricing-peak [data-price="outputPerMillion"]').value &&
            !card.querySelector('.pricing-peak [data-price="cachedInputPerMillion"]').value && !tariff.offPeak) continue;
        if (!enabled) {
          try { tariffs.push(AgentPricing.normalizeTariff(tariff)); }
          catch {
            const prior = original[group.dataset.cli]?.find(item => item.model === model);
            if (prior) tariffs.push({ ...prior, enabled: false });
          }
          continue;
        }
        tariffs.push(tariff);
      }
      if (tariffs.length) result[group.dataset.cli] = tariffs;
    }
    return AgentPricing.normalizeAgentPricing(result);
  }
  function commit(value) { original = structuredClone(value || {}); }
  return { open, read, commit };
})();
