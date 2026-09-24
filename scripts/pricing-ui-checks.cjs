'use strict';
module.exports = async function pricingChecks({ win, persistence, check }) {
  const page = (fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
  const wait = async fn => { for (let i = 0; i < 80; i++) { if (await fn()) return true; await new Promise(r => setTimeout(r, 30)); } return false; };
  await page(() => { closeAllModals(); openSettings('pricing'); });
  const cli = await page(() => document.querySelector('#pricingAgent').value);
  check('settings offers per-Agent model pricing with weekly multiple peak periods', await page(() => {
    const group = document.querySelector('.pricing-agent:not([hidden])'); group.querySelector(':scope > button').click();
    const card = group.querySelector('[data-pricing-card]');
    const set = (key, value) => { card.querySelector(`[data-price="${key}"]`).value = value; };
    set('model', 'fixture-model'); set('inputPerMillion', '10'); set('cachedInputPerMillion', '0'); set('outputPerMillion', '20');
    const low = card.querySelector('[data-price="offPeakEnabled"]'); low.checked = true; low.dispatchEvent(new Event('change'));
    set('timeZone', 'Asia/Shanghai');
    for (const [key, value] of [['inputPerMillion', '5'], ['cachedInputPerMillion', '0.5'], ['outputPerMillion', '10']]) card.querySelector(`.pricing-low [data-price="${key}"]`).value = value;
    return card.querySelectorAll('.pricing-period').length === 2 && !card.querySelector('.pricing-schedule').hidden;
  }));
  await page(() => document.querySelector('#settingsApplyBtn').click());
  check('Apply persists real settings and keeps pricing page open', await wait(async () => {
    const saved = persistence.getSettings().agentPricing?.[cli]?.[0];
    return saved?.cachedInputPerMillion === 0 && saved.offPeak?.cachedInputPerMillion === 0.5 && saved.peakPeriods.length === 2 && await page(() => !document.querySelector('#settingsModal').hidden && !document.querySelector('[data-panel="pricing"]').hidden);
  }));
  await page(() => { closeAllModals(); openSettings('pricing'); });
  check('reopening restores Agent tariff and invalid timezone is rejected', await page(() => {
    const card = document.querySelector('[data-pricing-card]');
    const restored = card.querySelector('[data-price="cachedInputPerMillion"]').value === '0';
    card.querySelector('[data-price="timeZone"]').value = 'invalid/zone';
    try { PricingUI.read(); return false; } catch (error) { return restored && error.message.includes('时区'); }
  }));
  check('disabling idle prices bypasses unfinished schedule fields', await page(() => {
    const card = document.querySelector('[data-pricing-card]');
    card.querySelector('[data-price="offPeakEnabled"]').checked = false;
    const prices = PricingUI.read(); return !Object.values(prices)[0][0].offPeak;
  }));
  check('pricing model selector reads real bridge catalog and supports custom models', await page(async () => {
    const card = document.querySelector('[data-pricing-card]');
    const refresh = [...card.querySelectorAll('button')].find(button => button.textContent === '获取模型列表'); refresh.click();
    for (let i = 0; i < 80 && refresh.disabled; i++) await new Promise(resolve => setTimeout(resolve, 20));
    const select = card.querySelector('.pricing-model-select');
    const available = [...select.options].find(option => option.value.endsWith('-fixture'));
    if (!available) return false;
    const before = JSON.stringify(PricingUI.read());
    select.value = available.value; select.dispatchEvent(new Event('change'));
    const selectedCard = card.closest('.pricing-agent').querySelector('[data-pricing-card]:not([hidden])');
    const selected = selectedCard.querySelector('[data-price="model"]').value === available.value &&
      selectedCard.querySelector('[data-price="inputPerMillion"]').value === '';
    const currentSelect = selectedCard.querySelector('.pricing-model-select');
    currentSelect.value = '__custom__'; currentSelect.dispatchEvent(new Event('change'));
    const customCard = card.closest('.pricing-agent').querySelector('[data-pricing-card]:not([hidden])');
    const input = customCard.querySelector('[data-price="model"]');
    const customVisible = !input.hidden; input.value = 'fixture-model'; input.dispatchEvent(new Event('change'));
    return selected && customVisible && !card.hidden && JSON.stringify(PricingUI.read()) === before;
  }));
  check('one tariff copies to multiple models including all three rates', await page(() => {
    const card = document.querySelector('[data-pricing-card]');
    [...card.querySelectorAll('button')].find(button => button.textContent === '复制到其他模型…').click();
    const panel = card.querySelector('.pricing-copy');
    panel.querySelector('[data-price="copyModels"]').value = 'copy-one, copy-two'; panel.querySelector('button').click();
    const values = Object.values(PricingUI.read())[0];
    return ['copy-one', 'copy-two'].every(model => values.some(value => value.model === model && value.inputPerMillion === 10 && value.cachedInputPerMillion === 0 && value.outputPerMillion === 20));
  }));
  check('invalid copy target leaves all tariffs unchanged', await page(() => {
    const before = JSON.stringify(PricingUI.read()), card = document.querySelector('[data-pricing-card]');
    [...card.querySelectorAll('button')].find(button => button.textContent === '复制到其他模型…').click();
    const panel = card.querySelector('.pricing-copy'); panel.querySelector('[data-price="copyModels"]').value = 'valid-one, bad$target'; panel.querySelector('button').click();
    const unchanged = before === JSON.stringify(PricingUI.read()); panel.remove(); return unchanged;
  }));
  check('disabled complete tariff copies remain configured while unfinished disabled cards are ignored', await page(() => {
    const card = document.querySelector('[data-pricing-card]'); card.querySelector('[data-price="enabled"]').checked = false;
    [...card.querySelectorAll('button')].find(button => button.textContent === '复制到其他模型…').click();
    const panel = card.querySelector('.pricing-copy'); panel.querySelector('[data-price="copyModels"]').value = 'disabled-copy'; panel.querySelector('button').click();
    const group = card.closest('.pricing-agent'); group.querySelector(':scope > button').click();
    group.querySelector('[data-pricing-card]:last-child [data-price="enabled"]').checked = false;
    const values = Object.values(PricingUI.read())[0];
    return values.some(value => value.model === 'disabled-copy' && !value.enabled && value.inputPerMillion === 10) && !values.some(value => !value.model);
  }));
  await page(() => document.querySelector('#settingsSaveBtn').click());
  check('Save persists settings and closes the modal', await wait(() => page(() => document.querySelector('#settingsModal').hidden)));
  check('usage display distinguishes estimates, missing counters and current tariff', await page(() =>
    usageText({ inputTokens: 12, inputEstimated: true, outputTokens: undefined }).includes('↑≈12 ↓未知') &&
    usageText({ inputTokens: 0, outputTokens: 0, cost: 0, estimated: true }, { pricing: { tier: 'offPeak' } }).includes('空闲价') &&
    usageText({ inputTokens: 0, outputTokens: 0, cost: null }, { reason: '缺少缓存用量' }).includes('缺少缓存用量')));
};
