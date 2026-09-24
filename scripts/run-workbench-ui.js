'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'convoke-workbench-ui-'));
const env = { ...process.env, AR_WORKBENCH_UI_DATA_DIR: directory };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), ['scripts/workbench-checks.cjs'], {
  cwd: path.resolve(__dirname, '..'), env, windowsHide: true, stdio: 'inherit',
});
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('close', code => {
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith('convoke-workbench-ui-')) throw new Error('Invalid workbench fixture directory');
  fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }, error => {
    if (error) console.error(`Workbench fixture cleanup failed: ${error.message}`);
    process.exitCode = code === 0 && !error ? 0 : 1;
  });
});
