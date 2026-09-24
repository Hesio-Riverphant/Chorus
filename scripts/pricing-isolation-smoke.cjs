'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-pricing-'));
app.setPath('userData', dir);
const scripts = ['src/shared/i18n-catalog.js', 'src/shared/i18n-main-catalog.js', 'src/shared/i18n.js', 'src/renderer/i18n-ui.js', 'src/shared/agentPricing.js', 'src/renderer/pricing-ui.js'];
const html = '<meta charset="utf-8"><div id="agentPricingEditor"></div>' + scripts.map(file => `<script src="${pathToFileURL(path.resolve(__dirname, '..', file))}"></script>`).join('');
fs.writeFileSync(path.join(dir, 'index.html'), html);
app.on('will-quit', () => fs.rmSync(dir, { recursive: true, force: true }));
const timeout = setTimeout(() => app.exit(2), 30000); timeout.unref();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  await win.loadFile(path.join(dir, 'index.html'));
  const results = await win.webContents.executeJavaScript(`(async () => {
    const results = [], check = (name, ok) => results.push({ name, ok: !!ok });
    window.api = { listModels: async () => ({ models: ['a','b','c','d'].map(id => ({ id, label: id })) }) };
    window.AppDialog = { alert: async message => { throw new Error(message); } };
    const fixture = { claude: ['a','b','c'].map((model, index) => ({ model, enabled: true, inputPerMillion: index+1, cachedInputPerMillion: 0, outputPerMillion: index+11 })) };
    fixture.codex = [{ ...fixture.claude[0], inputPerMillion: 77 }];
    const open = async () => { PricingUI.open(fixture, [{ id: 'claude', label: 'Claude' }]); await new Promise(r => setTimeout(r, 20)); };
    const visible = () => document.querySelector('.pricing-agent:not([hidden]) [data-pricing-card]:not([hidden])');
    const choose = id => { const select = visible().querySelector('.pricing-model-select'); select.value = id; select.dispatchEvent(new Event('change')); };
    for (const language of ['zh-CN', 'en']) {
      I18n.setLanguage(language); await open(); choose('a');
      const before = JSON.stringify(PricingUI.read()); choose('b');
      let after; try { after = JSON.stringify(PricingUI.read()); } catch (error) { after = error.message; }
      check(language + ': selecting another model preserves all tariffs', after === before);
      check(language + ': only selected model card is shown', document.querySelectorAll('.pricing-agent:not([hidden]) [data-pricing-card]:not([hidden])').length === 1 && visible().querySelector('[data-price="model"]').value === 'b');
      if (after !== before) continue;
      visible().querySelector('[data-price="inputPerMillion"]').value = '99';
      let read = PricingUI.read().claude;
      check(language + ': manual edits affect selected model only', read.find(x=>x.model==='a').inputPerMillion === 1 && read.find(x=>x.model==='b').inputPerMillion === 99 && read.find(x=>x.model==='c').inputPerMillion === 3);
      choose('a');
      const copy = async targets => {
        const card = visible(); const button = [...card.querySelectorAll('button')].find(x => x.textContent === I18n.t('复制到其他模型…')); if (!button) throw new Error('Missing copy button: ' + card.innerHTML); button.click();
        const panel = card.querySelector('.pricing-copy');
        for (const input of panel.querySelectorAll('.pricing-copy-targets input')) input.checked = targets.includes(input.value);
        panel.querySelector('button').click();
      };
      await copy(['b']); read = PricingUI.read().claude;
      check(language + ': copy replaces only checked target without duplicate', read.length === 3 && read.filter(x=>x.model==='b').length === 1 && read.find(x=>x.model==='b').inputPerMillion === 1 && read.find(x=>x.model==='c').inputPerMillion === 3);
      choose('b'); check(language + ': copied model navigation shows its sole card', visible().querySelector('[data-price="model"]').value === 'b' && document.querySelectorAll('.pricing-agent:not([hidden]) [data-pricing-card]:not([hidden])').length === 1);
      choose('a'); await copy(['b']);
      check(language + ': repeat copy is idempotent', PricingUI.read().claude.length === 3);
      choose('d');
      check(language + ': unconfigured model has no inherited rates', visible().querySelector('[data-price="inputPerMillion"]').value === '');
      choose('a');
      check(language + ': browsing empty model does not persist unfinished tariff', PricingUI.read().claude.length === 3);
      choose('b');
      const saved = PricingUI.read();
      check(language + ': same model in another Agent stays isolated', saved.codex[0].inputPerMillion === 77);
      PricingUI.open(saved, [{ id: 'claude', label: 'Claude' }]);
      check(language + ': reopening preserves independent values and selected model', JSON.stringify(PricingUI.read()) === JSON.stringify(saved) && visible().querySelector('[data-price="model"]').value === 'b');
      const first = visible(); first.querySelector('[data-price="inputPerMillion"]').value = ''; first.querySelector('[data-price="cachedInputPerMillion"]').value = ''; first.querySelector('[data-price="outputPerMillion"]').value = '';
      let rejected = false; try { PricingUI.read(); } catch { rejected = true; }
      check(language + ': clearing saved required prices is rejected rather than silently deleting tariff', rejected);
      check(language + ': no untranslated model controls', language !== 'en' || !/[\u3400-\u9fff]/.test(document.querySelector('#agentPricingEditor').textContent));
    }
    return results;
  })()`);
  for (const result of results) console.log((result.ok ? 'PASS ' : 'FAIL ') + result.name);
  console.log(results.filter(x => x.ok).length + '/' + results.length + ' checks passed');
  app.exit(results.every(x => x.ok) ? 0 : 1);
}).catch(error => { console.error(error); app.exit(2); });

