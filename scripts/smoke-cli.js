'use strict';

// Opt-in paid integration: node scripts/smoke-cli.js --live
// Synthetic room records only. No native session is resumed.
if (!process.argv.includes('--live')) {
  console.error('This check calls your native Claude Code and Codex accounts. Pass --live explicitly.');
  process.exitCode = 2;
} else {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const { randomUUID } = require('node:crypto');
  const { safeText } = require('../src/main/adapters/activities');
  const persistence = require('../src/main/store/persistence');
  const orchestrator = require('../src/main/orchestrator/orchestrator');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'convoke-live-room-'));
  const workspace = path.join(root, 'workspace');
  const previousDataDir = process.env.AR_DATA_DIR;
  process.env.AR_DATA_DIR = path.join(root, 'data');
  let timer;
  let timedOut = false;
  (async () => {
    try {
      fs.mkdirSync(workspace);
      // Normal Codex exec requires a repository. No commits or remotes.
      execFileSync('git', ['init', '--quiet', workspace], { windowsHide: true, stdio: 'pipe' });
      await persistence.init({ isPackaged: false });
      persistence.saveSettings({ enabledCliIds: ['claude', 'codex'], maxAutoTurns: 0, catchupMessages: 20 });
      const room = persistence.saveRoom({ ...persistence.listRooms()[0], cwd: workspace });
      for (const bot of persistence.listBots()) persistence.saveBot({ ...bot,
        name: bot.cliType === 'claude' ? 'ClaudeVerifier' : 'CodexVerifier', role: '', customRole: true, persona: '',
        permissionMode: 'read_only', model: bot.cliType === 'claude' ? 'haiku' : '', reasoningEffort: '',
      });
      timer = setTimeout(() => { timedOut = true; orchestrator.stopAll().catch(() => {}); }, 240000);
      const marker = 'CONVOKE_' + randomUUID().replace(/-/g, '');
      for (let round = 1; round <= 2; round++) {
        const prompt = round === 1
          ? 'Synthetic connection and context test. The verification marker is ' + marker + '. Reply with exactly that marker.'
          : 'Synthetic context replay test. Reply with the exact verification marker from the previous human message.';
        await orchestrator.handleHuman(room.id, '@ClaudeVerifier @CodexVerifier ' + prompt +
          ' Do not use tools, read files, run commands, or mention another member.');
        const human = persistence.getMessages(room.id).filter(message => message.authorType === 'human').at(-1);
        const replies = persistence.getMessages(room.id).filter(message => message.authorType === 'bot' && message.roundId === human.id);
        const summary = { round, replies: replies.map(message => ({
          cli: persistence.listBots().find(bot => bot.id === message.authorId)?.cliType,
          status: message.status, markerReceived: message.text.includes(marker),
          usage: message.usage, contextUsage: message.contextUsage || null,
          error: message.error ? safeText(message.error) : null,
        })) };
        console.log(JSON.stringify(summary));
        if (timedOut || replies.length !== 2 || summary.replies.some(reply =>
          reply.status !== 'done' || !reply.markerReceived || !(reply.usage?.tokens > 0) || !(reply.contextUsage?.totalTokens > 0))) {
          throw new Error('Round ' + round + ' did not complete the two verified replies');
        }
      }
      persistence.flushSync();
      const disk = JSON.parse(fs.readFileSync(path.join(process.env.AR_DATA_DIR, 'messages', room.id + '.json'), 'utf8'));
      const applicationSessionLinks = Object.keys(persistence.sessions).length;
      if (disk.filter(message => message.authorType === 'bot').length !== 4 || applicationSessionLinks !== 0) {
        throw new Error('Application transcript or native-session isolation check failed');
      }
      console.log(JSON.stringify({ passed: true, rounds: 2, persistedReplies: 4, applicationSessionLinks }));
    } catch (error) {
      console.error(safeText(error.message)); process.exitCode = 1;
    } finally {
      clearTimeout(timer);
      await orchestrator.stopAll();
      clearInterval(persistence.timer);
      if (previousDataDir === undefined) delete process.env.AR_DATA_DIR;
      else process.env.AR_DATA_DIR = previousDataDir;
      // Only this exact mkdtemp fixture belongs to this invocation.
      try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
      catch (error) { console.error('Fixture cleanup failed: ' + safeText(error.message)); process.exitCode = 1; }
    }
  })();
}
