'use strict';

// Opt-in live integration check: uses the existing native Codex account.
// All fixtures/config overrides are temporary; this does not install extensions.
if (!process.argv.includes('--live')) throw new Error('This check makes a native model request; pass --live explicitly.');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { CodexRpc } = require('../src/main/adapters/codexRpc');
const { runCodexNative } = require('../src/main/adapters/codexPlanAdapter');
const references = require('../src/main/skills/skillReferences');
const { buildPrompt } = require('../src/main/orchestrator/transcript');
const { safeText } = require('../src/main/adapters/activities');

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'convoke-native-smoke-'));
const workspace = path.join(fixtureRoot, 'workspace');
const skillPath = path.join(workspace, '.agents', 'skills', 'convoke-proof');
const appData = path.join(fixtureRoot, 'app-data');
const skillMarker = `CONVOKE_SKILL_${randomUUID().replace(/-/g, '')}`;
const mcpMarker = `CONVOKE_MCP_${randomUUID().replace(/-/g, '')}`;
fs.mkdirSync(skillPath, { recursive: true });
fs.mkdirSync(appData, { recursive: true });
fs.writeFileSync(path.join(skillPath, 'SKILL.md'), `---\nname: convoke-proof\ndescription: Synthetic Convoke integration proof. Use only for the explicit verification request.\n---\n\nFor the verification request, include the exact marker ${skillMarker} in your reply. Read-only verification: do not modify files.\n`);
const mcpScript = path.join(fixtureRoot, 'mcp.cjs');
fs.writeFileSync(mcpScript, `const readline=require('node:readline');const input=readline.createInterface({input:process.stdin});input.on('line',line=>{let request;try{request=JSON.parse(line);}catch{return;}if(request.id==null)return;let result;switch(request.method){case 'initialize':result={protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'convoke-proof',version:'1.0.0'}};break;case 'ping':result={};break;case 'tools/list':result={tools:[{name:'proof_echo',description:'Return the synthetic integration proof marker.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}}]};break;case 'tools/call':result={content:[{type:'text',text:${JSON.stringify(mcpMarker)}}],isError:false};break;default:process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'Unknown method'}})+'\\n');return;}process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');});\n`);

(async () => {
  let metadata;
  try {
    metadata = new CodexRpc({ cwd: workspace });
    await metadata.initialize();
    const skills = await metadata.request('skills/list', { cwds: [workspace], forceReload: true });
    const skillDiscovered = (skills.data || []).some(group => (group.skills || []).some(skill => skill.name === 'convoke-proof'));
    if (!skillDiscovered) throw new Error('Synthetic native Skill was not discovered');
    const installed = await metadata.request('plugin/installed', { cwds: [workspace] });
    const plugins = Object.fromEntries((installed.marketplaces || []).flatMap(m => m.plugins || [])
      .filter(plugin => plugin.installed).map(plugin => [plugin.id, { enabled: false }]));
    const mcp = Object.create(null);
    let cursor;
    for (let page = 0; page < 8; page++) {
      const inventory = await metadata.request('mcpServerStatus/list', { cursor, detail: 'toolsAndAuthOnly', limit: 64 });
      for (const server of inventory.data || []) if (!server.pluginId) mcp[server.name] = { enabled: false };
      cursor = inventory.nextCursor;
      if (!cursor) break;
    }
    if (cursor) throw new Error('Native MCP inventory was truncated');
    await metadata.close(); metadata = null;
    mcp.convoke_proof = { command: process.execPath, args: [mcpScript], enabled: true };
    references.register(appData, { name: 'convoke-proof', alias: 'convoke-proof', sourcePath: skillPath, cliTypes: ['codex'] });
    const ref = references.resolve(appData, { alias: 'convoke-proof', cliType: 'codex' });
    const bot = { id: 'proof', name: 'Verifier', cliType: 'codex', role: 'custom', customRole: '', executionMode: 'default', reasoningEffort: 'low', permissionMode: 'read_only' };
    const prompt = buildPrompt(bot, [{ authorType: 'human', text: 'This is a synthetic integration test. Use the named native Skill and read its source file. Call only the convoke_proof MCP proof_echo tool once. Then reply with the exact Skill verification marker and the exact MCP result marker. Do not modify files, inspect any other directory, search externally, invoke other tools, or read credentials.' }], [bot], {}, [ref]);
    let ephemeral = false;
    let mcpToolCompleted = false;
    const run = runCodexNative({ bot, prompt, workspace, noBytesTimeoutMs: 90000,
      rpcFactory(options) {
        const rpc = new CodexRpc(options);
        const request = rpc.request.bind(rpc);
        rpc.request = async (method, params, timeout) => {
          const result = await request(method, method === 'thread/start' ? { ...params, config: { mcp_servers: mcp, plugins } } : params, timeout);
          if (method === 'thread/start') ephemeral = result.thread.ephemeral === true && result.thread.path == null;
          return result;
        };
        return rpc;
      } });
    run.onEvent((type, value) => {
      if (type === 'activity' && value.name === 'proof_echo' && value.status === 'done') mcpToolCompleted = true;
    });
    const result = await run.promise;
    const summary = { skillDiscovered, skillReferenceRegistered: ref.mode === 'reference', skillMarkerSeen: result.text.includes(skillMarker),
      mcpToolCompleted, mcpMarkerSeen: result.text.includes(mcpMarker), ephemeral, error: result.error, aborted: result.aborted,
      nativeHistorySession: result.sessionId, usage: result.usage, contextUsage: result.contextUsage };
    console.log(JSON.stringify(summary, null, 2));
    if (result.error || !ephemeral || !summary.skillMarkerSeen || !summary.mcpMarkerSeen || !mcpToolCompleted) process.exitCode = 1;
  } catch (error) { console.error(safeText(error.message)); process.exitCode = 1; }
  finally {
    if (metadata) await metadata.close();
    // This exact mkdtemp directory contains only this script's own fixtures.
    fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
})();
