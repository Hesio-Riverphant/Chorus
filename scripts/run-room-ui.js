'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'convoke-pane-ui-'));
const env = { ...process.env, AR_ROOM_UI_DATA_DIR: dir };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), ['scripts/run-room-checks.cjs'], {
  cwd: path.join(__dirname, '..'), env, stdio: 'inherit', windowsHide: true,
});
let failed = false;
child.on('error', (error) => { failed = true; console.error(error.message); });
child.on('close', (code) => {
  fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }, (error) => {
    if (error) console.error(`Fixture cleanup failed: ${error.message}`);
    process.exitCode = !failed && !error && code === 0 ? 0 : 1;
  });
});
