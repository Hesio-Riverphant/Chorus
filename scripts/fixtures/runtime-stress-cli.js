'use strict';

// Controlled offline CLI. It never inspects native Agent configuration or credentials.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const [role, mode, inheritedId] = process.argv.slice(2);
const id = inheritedId || randomUUID();
const file = suffix => path.join(process.cwd(), `${id}-${suffix}`);
fs.writeFileSync(file(`${role}.pid`), String(process.pid));
const heartbeat = setInterval(() => {}, 1000);
// Last-resort bound if the runner is interrupted. Normal tests finish in seconds.
const deadline = setTimeout(() => process.exit(98), 30000);
function exit(code) { clearInterval(heartbeat); clearTimeout(deadline); process.exit(code); }

if (role === 'grandchild') {
  process.on('message', message => { if (message === 'finish') exit(0); });
  process.send('ready');
} else {
  const childRole = role === 'parent' ? 'child' : 'grandchild';
  const child = spawn(process.execPath, [__filename, childRole, mode, id], {
    cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  let finishing = false, releasePoll;
  child.on('error', error => { process.stderr.write(`fixture spawn: ${error.message}\n`); exit(97); });
  function finish() {
    if (finishing) return;
    finishing = true; clearInterval(releasePoll);
    child.once('exit', () => {
      if (role === 'child') { exit(0); return; }
      const marker = path.join(process.cwd(), `${mode}.failed-once`);
      if (/^fail(?:429|503)$/.test(mode) && !fs.existsSync(marker)) {
        fs.writeFileSync(marker, 'failed');
        process.stderr.write(`HTTP ${mode.slice(4)} fixture provider failure\n`, () => exit(1));
      } else process.stdout.write(JSON.stringify({ text: `completed:${mode}` }) + '\n', () => exit(0));
    });
    if (child.connected) child.send('finish');
    else exit(96);
  }
  child.on('message', message => {
    if (message !== 'ready') return;
    if (role === 'child') { process.send('ready'); return; }
    const pids = ['parent', 'child', 'grandchild'].map(name => Number(fs.readFileSync(file(`${name}.pid`), 'utf8')));
    fs.writeFileSync(file('ready.json'), JSON.stringify({ id, pids, mode }));
    process.stdout.write(JSON.stringify({ text: `ready:${mode}\n` }) + '\n');
    if (mode.startsWith('fail')) { finish(); return; }
    releasePoll = setInterval(() => { if (fs.existsSync(file('release'))) finish(); }, 5);
  });
  if (role === 'child') process.on('message', message => { if (message === 'finish') finish(); });
  else process.stdin.resume();
}
