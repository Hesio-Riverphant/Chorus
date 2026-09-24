'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
// Some agent hosts run Electron as Node. Clear that flag only for this child.
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), ['scripts/smoke.cjs'], {
  cwd: path.join(__dirname, '..'), env, windowsHide: true, stdio: 'inherit',
});
child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code === 0 ? 0 : 1; });
