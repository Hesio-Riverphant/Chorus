'use strict';
const { spawn } = require('node:child_process');

// Covers descendants that remain in the owned process tree/group. It cannot
// contain a child that deliberately detaches into a different process group.
function terminateTree(pid, { spawnProcess = spawn, killProcess = process.kill, platform = process.platform, timeoutMs = 5000 } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve({ scope: 'none' });
  const killRoot = () => {
    try { killProcess(pid, 'SIGKILL'); return { scope: 'root' }; }
    catch (error) { return { scope: 'unconfirmed', code: error.code || 'UNKNOWN' }; }
  };
  if (platform !== 'win32') {
    try { killProcess(-pid, 'SIGKILL'); return Promise.resolve({ scope: 'tree' }); }
    catch { return Promise.resolve(killRoot()); }
  }
  return new Promise(resolve => {
    let killer, timer, done = false;
    const finish = failed => {
      if (done) return;
      done = true; clearTimeout(timer);
      resolve(failed ? killRoot() : { scope: 'tree' });
    };
    try { killer = spawnProcess('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); }
    catch { finish(true); return; }
    timer = setTimeout(() => { try { killer.kill(); } catch {} finish(true); }, timeoutMs);
    killer.once('close', code => finish(code !== 0));
    killer.once('error', () => finish(true));
  });
}
module.exports = { terminateTree };
