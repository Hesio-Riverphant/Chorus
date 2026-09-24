'use strict';
const path = require('node:path');
const fs = require('node:fs');

// Set before acquiring Electron's instance lock so every entry shares one store.
// Packaged bootstrap already selects this path or its validated smoke fixture.
function configureAppPaths(app, env = process.env) {
  app.setName('Chorus');
  if (!app.isPackaged) app.setPath('userData', env.AR_DATA_DIR ? path.resolve(env.AR_DATA_DIR) : path.join(app.getPath('appData'), 'agent-room'));
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  app.setPath('userData', fs.realpathSync(app.getPath('userData')));
  // Preserve the installer identity across product renames and group its shortcut.
  if (process.platform === 'win32') app.setAppUserModelId('org.convoke.desktop');
}
module.exports = { configureAppPaths };
