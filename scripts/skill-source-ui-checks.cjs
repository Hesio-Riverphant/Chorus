'use strict';
module.exports = async function skillSourceChecks({ win, persistence, check }) {
  const fs = require('node:fs'), path = require('node:path');
  const page = (fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
  const source = path.join(persistence.getDataPath(), 'custom-skill-source');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'SKILL.md'), '---\nname: source-fixture\n---\n');
  persistence.saveSettings({ skillScanRoots: [source], skillScanOwners: { [source]: 'claude' } });
  check('custom source removal is accessible across categories and persists without deleting files', await page(async source => {
    closeAllModals(); await reloadFromMain(); openSettings('skills'); await loadSkillLibrary();
    document.querySelector('#skillSourceCategory').value = 'other'; await loadSkillLibrary();
    const roots = document.querySelector('#skillRoots'), status = document.querySelector('#skillScanStatus');
    if (!(roots.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
    const button = roots.querySelector('button'); if (!button || !roots.textContent.includes(source)) return false;
    button.click();
    for (let i = 0; i < 80 && document.querySelector('#skillRescan').disabled; i++) await new Promise(resolve => setTimeout(resolve, 20));
    if (state.skillScanRoots.includes(source) || state.skillScanOwners[source]) return false;
    await saveSettings(false); closeAllModals(); await reloadFromMain(); openSettings('skills'); await loadSkillLibrary();
    const valid = !state.skillScanRoots.includes(source) && !state.skillScanOwners[source] && !roots.textContent.includes(source);
    closeAllModals(); return valid;
  }, source) && fs.existsSync(path.join(source, 'SKILL.md')) &&
    !persistence.getSettings().skillScanRoots.includes(source) && !persistence.getSettings().skillScanOwners[source]);
  check('shared candidate stays visible until same-name references cover every enabled Agent', await page(() => {
    const prior = { external: state.externalSkills, refs: state.skillReferences, profiles: state.cliProfiles };
    try {
      document.querySelector('#skillSearch').value = '';
      state.cliProfiles = [{ id: 'claude', enabled: true }, { id: 'codex', enabled: true }];
      state.externalSkills = [
        { name: 'Repeat', sourcePath: 'D:/fixture/shared', category: 'other' },
        { name: 'Repeat', sourcePath: 'D:/fixture/claude', category: 'claude', nativeCliType: 'claude' },
        { name: 'Repeat', sourcePath: 'D:/fixture/codex', category: 'codex', nativeCliType: 'codex' },
      ];
      state.skillReferences = [{ id: 'fixture', name: 'repeat', alias: 'repeat', sourcePath: 'D:/fixture/registered', cliTypes: ['claude'] }];
      renderSkillLists();
      const rows = document.querySelectorAll('#skillDiscover .skill-row');
      const missingScopeVisible = rows.length === 2 && [...rows].some(row => row.textContent.includes('D:/fixture/shared'));
      state.skillReferences.push({ id: 'second', name: 'Repeat', alias: 'repeat', sourcePath: 'D:/fixture/registered-codex', cliTypes: ['codex'] });
      renderSkillLists();
      return missingScopeVisible && document.querySelectorAll('#skillDiscover .skill-row').length === 0;
    } finally { state.externalSkills = prior.external; state.skillReferences = prior.refs; state.cliProfiles = prior.profiles; renderSkillLists(); }
  }));
  check('custom source guidance has an English translation', await page(() => {
    const prior = I18n.language; I18n.setLanguage('en'); I18n.applyStatic();
    try {
      const panel = document.querySelector('[data-panel="skills"]');
      return panel.textContent.includes('Custom source directories') && panel.textContent.includes('most recently modified SKILL.md');
    } finally { I18n.setLanguage(prior); I18n.applyStatic(); }
  }));
};

