'use strict';

// Render the real UI offscreen and capture a PNG. Uses the real data dir for
// an authentic view but performs no interaction. Output path via AR_SHOT_OUT.
//   electron scripts/ui-shot.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const persistence = require('../src/main/store/persistence');
const { registerIpc } = require('../src/main/ipc');

app.whenReady().then(async () => {
  await persistence.init(app);

  const win = new BrowserWindow({
    width: 1180,
    height: 840,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  registerIpc(win, persistence);

  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 1200));

  // Install global error traps before doing anything.
  await win.webContents.executeJavaScript(
    "window.__errs=[];" +
    "window.addEventListener('error',e=>window.__errs.push('ERROR '+(e.error&&e.error.stack||e.message)));" +
    "window.addEventListener('unhandledrejection',e=>window.__errs.push('REJECT '+(e.reason&&e.reason.stack||e.reason)));",
  );

  const scene = process.env.AR_SHOT_SCENE || 'main';
  if (scene === 'diag') {
    // Exercise the common paths: switch rooms, open/close modals, open settings.
    const rooms = await win.webContents.executeJavaScript('state.rooms.map(r=>r.id)');
    for (const rid of rooms) {
      await win.webContents.executeJavaScript(`switchRoom(${JSON.stringify(rid)})`);
    }
    await win.webContents.executeJavaScript('openSettings()');
    await new Promise((r) => setTimeout(r, 300));
    await win.webContents.executeJavaScript("hideModal('settingsModal')");
    await win.webContents.executeJavaScript('openBotNew()');
    await new Promise((r) => setTimeout(r, 200));
    await win.webContents.executeJavaScript("hideModal('botModal')");
    await win.webContents.executeJavaScript('openRoomNew()');
    await new Promise((r) => setTimeout(r, 200));
    await win.webContents.executeJavaScript("hideModal('roomModal')");
    await new Promise((r) => setTimeout(r, 300));
    const errs = await win.webContents.executeJavaScript('window.__errs');
    console.log('=== captured errors ===');
    console.log(errs.length ? errs.join('\n---\n') : '(none)');
  } else if (scene === 'settings') {
    await win.webContents.executeJavaScript('openSettings()');
  } else if (scene === 'bot') {
    await win.webContents.executeJavaScript('openBotNew()');
  } else if (scene === 'room') {
    await win.webContents.executeJavaScript('openRoomNew()');
  } else if (scene === 'mention') {
    await win.webContents.executeJavaScript(
      "(()=>{const ta=document.getElementById('input');ta.value='@';ta.selectionStart=ta.selectionEnd=1;ta.dispatchEvent(new Event('input',{bubbles:true}));})()",
    );
  } else if (scene === 'skills') {
    await win.webContents.executeJavaScript(
      "openSettings();switchSettingsTab('skills')",
    );
    await new Promise((r) => setTimeout(r, 1000));
  } else if (scene === 'slash') {
    await win.webContents.executeJavaScript(
      "(()=>{const ta=document.getElementById('input');ta.value='/';ta.selectionStart=ta.selectionEnd=1;ta.dispatchEvent(new Event('input',{bubbles:true}));})()",
    );
  } else if (scene === 'history') {
    await win.webContents.executeJavaScript(
      "openSettings();switchSettingsTab('history')",
    );
    await new Promise((r) => setTimeout(r, 800));
  }
  await new Promise((r) => setTimeout(r, 600));

  if (scene !== 'diag') {
    const img = await win.webContents.capturePage();
    const out = process.env.AR_SHOT_OUT || path.join(__dirname, '..', 'workspace', `ui-shot-${scene}.png`);
    fs.writeFileSync(out, img.toPNG());
    console.log('wrote', out);
  }
  app.exit(0);
}).catch((err) => {
  console.error(err);
  app.exit(2);
});
