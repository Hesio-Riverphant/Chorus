'use strict';

// Reusable smoke test: launches the real renderer (with preload), drives the
// key v2 UI paths, and reports pass/fail. Run with:
//   node_modules/electron/dist/electron.exe scripts/smoke.cjs
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow } = require('electron');
const persistence = require('../src/main/store/persistence');
const jsonStore = require('../src/main/store/jsonStore');
// Replace only local model discovery; never inspect personal CLI metadata in UI tests.
require('../src/main/modelCatalog').discoverModels = cliType => ({
  models: [{ id: cliType + '-fixture', label: cliType + ' fixture', source: 'saved-bot' }],
  notice: '离线模型目录样本',
});
const { registerIpc } = require('../src/main/ipc');
const scanner = require('../src/main/skills/skillScanner');
const orchestrator = require('../src/main/orchestrator/orchestrator');

// Isolate all writes in a throwaway data dir so smoke never touches the real
// ./data; reset it each run for determinism.
const SMOKE_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-room-ui-'));
process.env.AR_DATA_DIR = SMOKE_DATA;
const fixture = path.join(SMOKE_DATA, 'fixture.md');
fs.writeFileSync(fixture, '---\nname: smoke-fixture\ndescription: Offline smoke fixture\n---\nTest instructions only.');
require('../src/main/skills/skillDiscovery').scan = async () => ({
  skills: [{ name: 'smoke-fixture', sourcePath: fixture, source: 'test', description: 'Offline fixture' }],
  roots: [{ path: SMOKE_DATA, source: 'fixture', status: 'ok' }], warnings: [], truncated: false,
});
process.on('exit', () => {
  if (persistence.timer) clearInterval(persistence.timer);
  fs.rmSync(SMOKE_DATA, { recursive: true, force: true });
});
const watchdog = setTimeout(() => { console.error('FAIL UI smoke timed out'); app.exit(2); }, 60000);
watchdog.unref();

const results = [];
function check(name, ok) { results.push({ name, ok: !!ok }); }

async function run() {
  await persistence.init(app);
  check('首次使用由用户选择 Agent 接入', persistence.getSettings().enabledCliIds.length === 0);
  persistence.saveSettings({ enabledCliIds: ['claude', 'codex', 'pi', 'kimi'] });
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  registerIpc(win, persistence);
  require('../src/main/workbench').registerWorkbench(win, persistence);
  win.webContents.on('console-message', (event) => {
    if (['warning', 'error'].includes(event.level)) console.error('[renderer]', event.message);
  });

  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 700));

  const report = await win.webContents.executeJavaScript(`(async function () {
    try {
    window.__caught = [];
    window.__unhandled = [];
    window.addEventListener('unhandledrejection', (event) => window.__unhandled.push(String(event.reason?.stack || event.reason)));
    window.onerror = (m, s, l, c, e) => window.__caught.push((e && e.stack) || String(m));
    const out = { __err: null, __caught: null };
    const $ = (s) => document.querySelector(s);
    const fire = (el, ev) => el.dispatchEvent(new Event(ev, { bubbles: true }));
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // Actual on-screen visibility (the hidden attribute can be overridden by
    // display utilities, which is the bug we're guarding against).
    const vis = (s) => getComputedStyle($(s)).display !== 'none';
    const sideNames = () => [...document.querySelectorAll('#roomList .side-item-name')].map((e) => e.textContent);
    const memberNames = () => [...document.querySelectorAll('#botList .side-item-name')].map((e) => e.textContent);

    // 1. static composer/sidebar elements
    out.addRoom = !!$('#addRoom');
    out.addBot = !!$('#addBot');
    out.settingsBtn = !!$('#settingsBtn');
    out.actionBtn = $('#actionBtn') && $('#actionBtn').textContent === '发送';
    out.toolbar = $('.composer-toolbar') ? $('.composer-toolbar').children.length >= 3 : false;
    out.routeSeg = document.querySelectorAll('#routeSeg .seg-btn').length === 2;
    out.mentionBoxExists = !!$('#mentionBox');
    out.noModalAtStart = !vis('#roomModal') && !vis('#botModal') && !vis('#settingsModal');

    // 2. new-room modal opens
    $('#addRoom').click();
    out.roomHidden = $('#roomModal').hidden;
    out.roomModalOpens = vis('#roomModal');
    out.roomHasMembers = document.querySelectorAll('#r_members .member-check').length >= 1;
    out.roomHasModRadios = document.querySelectorAll('#r_members .mod-radio').length >= 1;
    $('#roomModal').querySelector('[data-close]').click();
    out.roomModalCloses = !vis('#roomModal');

    // 3. settings + every tab
    $('#settingsBtn').click();
    out.settingsHidden = $('#settingsModal').hidden;
    out.settingsOpens = vis('#settingsModal');
    out.tabs = {};
    document.querySelectorAll('.settings-tab').forEach((t) => {
      t.click();
      const panel = document.querySelector('.settings-panel[data-panel="' + t.dataset.tab + '"]');
      out.tabs[t.dataset.tab] = panel && panel.hidden === false;
    });

    // 4. global pricing retains CLI reports; per-model custom prices live on bots
    const setRadio = (val) => {
      const r = document.querySelector('input[name="costMode"][value="' + val + '"]');
      r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true }));
    };
    setRadio('cli');
    out.cliPricingAvailable = !!document.querySelector('input[name="costMode"][value="cli"]');
    out.noGlobalCustom = !document.querySelector('input[name="costMode"][value="custom"]');
    setRadio('none');
    out.noneHidesCostBudget = !$('#s_costWrap') && !$('#s_tokens');
    $('#settingsModal').querySelector('[data-close]').click();

    // 5. mention autocomplete
    const ta = $('#input');
    ta.value = '@';
    ta.setSelectionRange(1, 1);
    fire(ta, 'input');
    out.mentionOpens = $('#mentionBox').hidden === false &&
      document.querySelectorAll('.mention-item').length >= 1;
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    out.mentionNav = document.querySelectorAll('.mention-item.active').length === 1;
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    out.mentionCloses = $('#mentionBox').hidden === true;

    // 6. only one modal at a time; global Escape dismisses the topmost
    $('#addBot').click();
    out.addMemberOpens = vis('#addMemberModal');
    $('#settingsBtn').click();
    out.singleModal = vis('#settingsModal') && !vis('#addMemberModal') &&
      !vis('#botModal') && !vis('#roomModal');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    out.escapeCloses = !vis('#settingsModal');

    // 7. NEW ROOM regression: save must close the modal and switch immediately.
    const allPick = () => document.querySelectorAll('#r_members .member-check');
    const setPicked = (pred) => {
      allPick().forEach((c, i) => {
        const want = pred(i);
        if (c.checked !== want) { c.checked = want; fire(c, 'change'); }
      });
    };
    const nameA = '冒烟房间A' + Date.now();
    $('#addRoom').click();
    $('#r_name').value = nameA;
    setPicked((i) => i === 0); // room A: only the first global bot
    out.roomAOneMember = document.querySelectorAll('#r_members .mod-radio:not([disabled])').length === 1;
    $('#roomSaveBtn').click();
    await sleep(300);
    out.newRoomCloses = !vis('#roomModal');
    out.newRoomSwitches = $('#roomName').textContent === nameA &&
      document.querySelector('#roomList .side-item.active .side-item-name').textContent === nameA;
    out.roomAMembers = memberNames().length === 1;
    out.roomAMemberName = memberNames()[0] || '';

    // 8. duplicate name -> inline error, modal stays open
    $('#addRoom').click();
    $('#r_name').value = nameA;
    setPicked((i) => i === 0);
    $('#roomSaveBtn').click();
    await sleep(300);
    out.dupRejected = vis('#roomModal') && !$('#r_error').hidden && /同名/.test($('#r_error').textContent);
    $('#roomModal').querySelector('[data-close]').click();

    // 9. room independence: room B gets a different single member
    $('#addRoom').click();
    const globalBotCount = allPick().length;
    $('#roomModal').querySelector('[data-close]').click();
    let roomBIndependent = true;
    if (globalBotCount >= 2) {
      const nameB = '冒烟房间B' + Date.now();
      $('#addRoom').click();
      $('#r_name').value = nameB;
      setPicked((i) => i === 1); // room B: only the second global bot
      $('#roomSaveBtn').click();
      await sleep(300);
      const roomBMember = memberNames()[0] || '';
      const bNameOk = $('#roomName').textContent === nameB;
      const bOne = memberNames().length === 1;
      const bDiff = roomBMember !== out.roomAMemberName;
      // switch back to room A and confirm its own members are restored
      const itemA = [...document.querySelectorAll('#roomList .side-item')].find(
        (it) => it.querySelector('.side-item-name').textContent === nameA);
      itemA && itemA.click();
      await sleep(150);
      const aRestored = memberNames().length === 1 && memberNames()[0] === out.roomAMemberName;
      roomBIndependent = bNameOk && bOne && bDiff && aRestored;
    }
    out.roomBIndependent = roomBIndependent;

    // 10. add-member modal lists candidates (skill-library tests arrive later)
    $('#addBot').click();
    await sleep(200);
    out.addMemberLists = vis('#addMemberModal');
    $('#addMemberModal').querySelector('[data-close]').click();

    // 11. skill import + slash selector end-to-end
    $('#settingsBtn').click();
    document.querySelector('.settings-tab[data-tab="skills"]').click();
    await sleep(500); // discover + imported lists load
    const firstImport = document.querySelector('#skillDiscover .sk-btn');
    if (firstImport) {
      firstImport.click();
      out.skillImportOpens = !document.querySelector('#skillImportModal') && !AppDialog.isOpen();
      await sleep(600);
      out.skillSourceHiddenAfterRegister = !document.querySelector('#skillDiscover .sk-btn');
    }
    out.skillImported = document.querySelectorAll('#skillReferences .skill-row').length >= 1;
    $('#settingsModal').querySelector('[data-close]').click();
    const ta2 = $('#input');
    ta2.value = '/';
    ta2.setSelectionRange(1, 1);
    fire(ta2, 'input');
    out.slashOpens = $('#slashBox').hidden === false &&
      document.querySelectorAll('#slashBox .mention-item').length >= 1;
    ta2.value = '';
    fire(ta2, 'input');

    // 12. history tab: room selector lists rooms, current count renders
    $('#settingsBtn').click();
    document.querySelector('.settings-tab[data-tab="history"]').click();
    await sleep(300);
    out.historyRooms = document.querySelectorAll('#histRoom option').length >= 1;
    out.historyCountShown = $('#histCurrentCount').textContent !== '';
    $('#settingsModal').querySelector('[data-close]').click();

    out.__caught = window.__caught.slice(0, 4);
    return out;
    } catch (e) { return { __err: (e && e.stack) || String(e) }; } })()`);

  if (report.__err) {
    console.log('PAGE ERROR:\n' + report.__err);
    try {
      fs.writeFileSync(
        path.join(__dirname, '..', 'logs', 'smoke-result.json'),
        JSON.stringify({ error: report.__err }, null, 2));
    } catch (_) { /* ignore */ }
    app.exit(2);
  }

  // Regression: a BOM-prefixed JSON file (Notepad / PowerShell Out-File) must
  // still parse, otherwise rooms/bots silently fall back to empty and are lost.
  const bomFile = path.join(SMOKE_DATA, 'bom-test.json');
  fs.writeFileSync(bomFile, '\uFEFF' + JSON.stringify({ ok: true }));
  const bomTolerant = jsonStore.readJson(bomFile, {}).ok === true;
  fs.rmSync(bomFile, { force: true });

  // Archive / restore roundtrip on the real persistence (per-room history).
  const arcRoomId = persistence.listRooms()[0] && persistence.listRooms()[0].id;
  let archiveRoundtrip = false;
  if (arcRoomId) {
    const seedMsg = {
      id: 'msg_smoke_arc_seed', roomId: arcRoomId, authorType: 'human',
      authorId: 'owner', text: '冒烟归档种子消息', status: 'done',
      roundId: null, createdAt: Date.now(),
    };
    persistence.addMessage(arcRoomId, seedMsg);
    const summary = persistence.archiveCurrent(arcRoomId);
    const archivedOk = summary && summary.count >= 1 &&
      persistence.getMessages(arcRoomId).length === 0 &&
      persistence.listArchives(arcRoomId).length === 1;
    const restoredCount = persistence.restoreArchive(arcRoomId, summary.id);
    archiveRoundtrip = archivedOk &&
      persistence.getMessages(arcRoomId).some((m) => m.id === seedMsg.id) &&
      restoredCount >= 1 && persistence.listArchives(arcRoomId).length === 0;
  }

  check('侧栏/输入区关键元素', report.addRoom && report.addBot && report.settingsBtn &&
    report.mentionBoxExists && report.routeSeg);
  check('JSON 文件容忍 BOM（防房间表被读空）', bomTolerant);
  check('归档当前 → 清空 → 恢复（按房间）', archiveRoundtrip);
  check('发送按钮默认态', report.actionBtn);
  check('启动时无弹窗遮挡', report.noModalAtStart);
  check('输入区工具行', report.toolbar);
  check('新建房间弹窗（含成员与主持人单选）', report.roomModalOpens && report.roomHasMembers &&
    report.roomHasModRadios && report.roomModalCloses);
  check('设置弹窗打开', report.settingsOpens);
  check('设置全部分组可切换',
    ['guard', 'pricing', 'skills', 'history', 'general', 'data', 'about'].every((k) => report.tabs[k]));
  check('计价保留CLI自报且自定义单价移至Bot配置',
    report.cliPricingAvailable && report.noGlobalCustom);
  check('@ 补全弹出/键盘导航/关闭',
    report.mentionOpens && report.mentionNav && report.mentionCloses);
  check('添加成员弹窗可打开/列出候选', report.addMemberOpens && report.addMemberLists);
  check('技能可登记原生引用并在设置中列出', report.skillImportOpens && report.skillImported && report.skillSourceHiddenAfterRegister);
  check('输入 “/” 弹出可用技能选择', report.slashOpens);
  check('记录页列出房间并显示当前条数', report.historyRooms && report.historyCountShown);
  check('同一时刻仅一个弹窗 / 全局 Esc 关闭',
    report.singleModal && report.escapeCloses);
  check('新建房间保存后立即关闭并切换（核心回归）',
    report.newRoomCloses && report.newRoomSwitches && report.roomAMembers && report.roomAOneMember);
  check('房间重名被内联拒绝', report.dupRejected);
  check('房间成员相互独立、切换后恢复', report.roomBIndependent);

  await require('./desktop-checks.cjs')({ win, persistence, check });
  await require('./cli-checks.cjs')({ win, persistence, check });
  await require('./pricing-ui-checks.cjs')({ win, persistence, check });
  await require('./chorus-ui-checks.cjs')({ win, persistence, check });
  await require('./skill-source-ui-checks.cjs')({ win, persistence, check });
  await require('./history-ui-checks.cjs')({ win, persistence, check });

  const runtimeErrors = await win.webContents.executeJavaScript('({errors:window.__caught || [], rejections:window.__unhandled || []})');
  check('真实界面操作无未处理脚本异常', !runtimeErrors.errors.length && !runtimeErrors.rejections.length);
  if (runtimeErrors.errors.length || runtimeErrors.rejections.length) console.log('UI errors:', JSON.stringify(runtimeErrors));

  // A renderer reload must preserve the running state and the stop action.
  const activeRoom = persistence.listRooms()[0].id;
  const activeRun = { id: 'run_smoke', roomId: activeRoom, status: 'running', wave: 0,
    calls: 1, tokens: 0, cost: 0, stopping: false, active: new Set(), roundId: 'round_smoke' };
  orchestrator.runs.set(activeRoom, activeRun);
  const reloaded = new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  win.webContents.reload();
  await reloaded;
  await new Promise((resolve) => setTimeout(resolve, 200));
  check('刷新后仍显示停止按钮', await win.webContents.executeJavaScript(
    'document.querySelector("#actionBtn").textContent === "停止"'));
  orchestrator.runs.delete(activeRoom);

  const sendPreserved = await win.webContents.executeJavaScript(`(async () => {
    await reloadFromMain();
    const input = document.querySelector('#input');
    input.value = 'Keep this draft after rejection';
    state.currentRoomId = 'missing_room';
    try { await doSend(); } catch (_) {}
    return input.value === 'Keep this draft after rejection';
  })()`);
  check('发送失败保留草稿', sendPreserved);

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  try {
    fs.writeFileSync(
      path.join(__dirname, '..', 'logs', 'smoke-result.json'),
      JSON.stringify({ passed: results.length - failed, total: results.length, results, report }, null, 2)
    );
  } catch (_) { /* ignore */ }
  app.exit(failed ? 1 : 0);
}

app.whenReady().then(run).catch((err) => {
  console.error(err);
  app.exit(2);
});
