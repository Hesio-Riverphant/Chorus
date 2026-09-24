'use strict';
// Explicit opt-in: two real native model calls; all application data is isolated.
if (!process.argv.includes('--live')) throw new Error('Pass --live for actual Claude/Codex model requests.');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'convoke-feedback-live-'));
const workspace = path.join(fixture, 'workspace');
fs.mkdirSync(workspace);
fs.writeFileSync(path.join(workspace, 'proof.txt'), 'CONVOKE_FEEDBACK_PROOF_20260924');
process.env.AR_DATA_DIR = path.join(fixture, 'data');
const persistence = require('../src/main/store/persistence');
const orchestrator = require('../src/main/orchestrator/orchestrator');
const { contextUsage } = require('../src/main/contextUsage');
const only = process.argv.find(arg => arg.startsWith('--only='))?.slice(7);
const codexModel = process.argv.find(arg => arg.startsWith('--codex-model='))?.slice(14) || 'gpt-6-luna';

(async () => {
  try {
    await persistence.init({ isPackaged: false, getPath: () => fixture });
    persistence.saveSettings({ enabledCliIds: ['claude', 'codex'], maxCliCallsPerRun: 1, noBytesTimeoutMs: 60000 });
    const results = [];
    for (const [cliType, model] of [['claude', 'haiku'], ['codex', codexModel]].filter(([cliType]) => !only || only === cliType)) {
      const bot = persistence.saveBot({ name: `${cliType} proof`, cliType, model, enabled: true,
        role: '验证员', customRole: true, persona: 'Only perform the requested isolated read-only verification.',
        permissionMode: 'read_only', reasoningEffort: cliType === 'codex' ? 'low' : '' });
      const room = persistence.saveRoom({ name: `${cliType} live proof`, cwd: workspace, botIds: [bot.id], moderatorBotId: bot.id,
        routingMode: 'moderator', speakMode: 'sequential' });
      const events = [];
      orchestrator.setEmitter(event => { events.push(event.kind); });
      const timer = setTimeout(() => orchestrator.stop(room.id), 120000);
      try {
        await orchestrator.handleHuman(room.id,
          'This is an isolated read-only application verification. First briefly say you are reading the proof file. Use a local read tool or read-only command exactly once to read ./proof.txt in the current directory. Then give a short final answer containing the exact marker from that file. Do not modify files, inspect other directories, read credentials, invoke MCP tools, contact external services, or delegate.');
      } finally { clearTimeout(timer); }
      const messages = persistence.getMessages(room.id);
      const reply = messages.findLast(message => message.authorType === 'bot');
      const stats = contextUsage(room, bot, [bot], messages);
      const result = { cliType, model, status: reply?.status, markerReturned: reply?.text?.includes('CONVOKE_FEEDBACK_PROOF_20260924'),
        usage: reply?.usage, context: stats,
        activityKinds: (reply?.activities || []).map(a => ({ kind: a.kind, phase: a.phase, status: a.status })),
        finalAnswer: reply?.finalAnswer, error: reply?.error || null, updateEvents: events.filter(kind => kind === 'message_update').length };
      console.log(JSON.stringify(result)); results.push(result);
      assert.equal(reply?.status, 'done'); assert.equal(result.markerReturned, true);
      assert.equal(reply.usage.inputEstimated, false); assert.equal(reply.usage.outputEstimated, false);
      assert.ok(stats.currentTokens > 0); assert.equal(stats.source, 'native');
      assert.ok((reply.activities || []).some(a => ['tool', 'command'].includes(a.kind)));
    }
    persistence.flushSync();
    console.log(JSON.stringify({ passed: true, nativeReplies: results.length, source: 'actual model calls through orchestrator',
      applicationSessionLinks: Object.keys(persistence.getSessions()).length }));
  } finally {
    await orchestrator.stopAll(); clearInterval(persistence.timer);
    assert.equal(path.dirname(fixture), os.tmpdir());
    assert.ok(path.basename(fixture).startsWith('convoke-feedback-live-'));
    fs.rmSync(fixture, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
