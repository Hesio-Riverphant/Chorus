'use strict';

// Run after the renderer is ready in the isolated Electron harness. CLI and
// skill discovery boundaries must already be replaced by the harness.
module.exports = async function navigationChecks({ win, persistence, check }) {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dataDir = path.resolve(persistence.getDataPath());
  const relative = path.relative(os.tmpdir(), dataDir);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(dataDir).startsWith('convoke-')) {
    throw new Error('Navigation checks require an isolated convoke-* directory under the system temp directory');
  }
  const page = (fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`)
    .catch(error => { throw new Error(`${error.message}\nNavigation check: ${fn.toString().slice(0, 1600)}`); });
  const settle = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms));
  const waitUntil = async fn => {
    for (let attempt = 0; attempt < 100; attempt++) { if (await fn()) return true; await settle(25); }
    return false;
  };
  const waitFor = (fn, ...args) => waitUntil(() => page(fn, ...args));
  const savedSettings = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
  const savedRooms = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'rooms.json'), 'utf8'));
  const rowPoint = async (id, bottom = false) => {
    const point = await page((roomId, bottom) => {
      const row = document.querySelector(`#roomList [data-room-id="${CSS.escape(roomId)}"]`);
      if (!row) throw new Error('Missing navigation row: ' + roomId);
      row.scrollIntoView({ block: 'nearest' }); row.focus();
      const rect = row.getBoundingClientRect();
      return { x: Math.round(rect.left + Math.min(60, rect.width / 3)), y: Math.round(bottom ? rect.bottom - 5 : rect.top + rect.height / 2) };
    }, id, bottom);
    await settle(); return point;
  };
  const mouse = (type, point, button = 'left') => win.webContents.sendInputEvent({ type, ...point,
    ...(type === 'mouseMove' ? {} : { button, clickCount: 1 }) });
  const key = (keyCode, modifiers = []) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  };

  const cwdA = path.join(dataDir, 'navigation-project-a'), cwdB = path.join(dataDir, 'navigation-project-b');
  const a = persistence.saveRoom({ name: 'Navigation A', cwd: cwdA });
  const b = persistence.saveRoom({ name: 'Navigation B', cwd: cwdA });
  const c = persistence.saveRoom({ name: 'Navigation C', cwd: cwdA });
  const other = persistence.saveRoom({ name: 'Navigation other project', cwd: cwdB });
  const pin = persistence.saveRoom({ name: 'Navigation pinned', cwd: cwdB });
  persistence.setRoomPinned(pin.id, true);
  const side = persistence.createSideChat(a.id);
  await page(async id => { closeAllModals(); closePopMenu(); await reloadFromMain(); switchRoom(id); }, a.id);

  const groups = await page(ids => ids.map(id => {
    const row = document.querySelector(`#roomList [data-room-id="${CSS.escape(id)}"]`);
    const group = row?.closest('.room-nav-group');
    return { key: group?.dataset.groupId, path: group?.querySelector('.room-nav-project-path')?.textContent,
      nested: row?.classList.contains('side-chat-item') };
  }), [a.id, b.id, c.id, other.id, side.id, pin.id]);
  check('真实导航按相同项目目录分组，侧聊嵌套，置顶独立分类',
    groups[0].key === groups[1].key && groups[1].key === groups[2].key && groups[0].key !== groups[3].key &&
    groups[0].path === cwdA && groups[4].key === groups[0].key && groups[4].nested && groups[5].key === 'pinned');
  const projectKey = groups[0].key;
  if (!projectKey) throw new Error('Project navigation integration is missing');

  const toggle = groupKey => page(key => document.querySelector(`.room-nav-group[data-group-id="${CSS.escape(key)}"] .room-nav-group-toggle`).click(), groupKey);
  const collapsed = groupKey => page(key => {
    const group = document.querySelector(`.room-nav-group[data-group-id="${CSS.escape(key)}"]`);
    return group.querySelector('.room-nav-group-toggle').getAttribute('aria-expanded') === 'false' && group.querySelector('.room-nav-group-content').hidden;
  }, groupKey);
  await toggle(projectKey);
  const projectSaved = await waitUntil(() => savedSettings().navigationCollapsedGroups?.includes(projectKey));
  await page(async () => reloadFromMain());
  check('项目分类收起经 IPC 写入磁盘，重新加载后仍收起', projectSaved && await collapsed(projectKey));
  await toggle(projectKey);
  check('项目分类再次点击展开且移除持久化折叠状态', await waitUntil(() => !savedSettings().navigationCollapsedGroups?.includes(projectKey)) && !await collapsed(projectKey));
  await toggle('pinned');
  const pinnedSaved = await waitUntil(() => savedSettings().navigationCollapsedGroups?.includes('pinned'));
  await page(async () => reloadFromMain());
  check('置顶分类收起并在重新加载后保留', pinnedSaved && await collapsed('pinned'));
  await toggle('pinned');
  check('置顶分类再次点击恢复房间列表', await waitUntil(() => !savedSettings().navigationCollapsedGroups?.includes('pinned')) && !await collapsed('pinned'));

  await page(id => document.querySelector(`#roomList [data-room-id="${CSS.escape(id)}"] .row-menu`).click(), b.id);
  const menuLabels = await page(() => [...document.querySelectorAll('#popMenu .pop-item')].map(item => item.textContent));
  await page(() => closePopMenu());
  const contextPoint = await rowPoint(b.id);
  mouse('mouseMove', contextPoint); mouse('mouseDown', contextPoint, 'right'); mouse('mouseUp', contextPoint, 'right');
  const contextOpened = await waitFor(() => !document.querySelector('#popMenu').hidden);
  const contextLabels = await page(() => [...document.querySelectorAll('#popMenu .pop-item')].map(item => item.textContent));
  check('真实鼠标右键与三个点菜单的操作完全一致', contextOpened && menuLabels.length >= 6 && JSON.stringify(contextLabels) === JSON.stringify(menuLabels));
  await page(() => closePopMenu());

  const snapshot = JSON.stringify(persistence.rooms.map(room => ({ ...room })));
  const peerIds = [a.id, b.id, c.id];
  const projectOrder = () => page(ids => [...document.querySelectorAll('#roomList .room-nav-item')].map(row => row.dataset.roomId).filter(id => ids.includes(id)), peerIds);
  const orderFromDisk = () => (savedSettings().roomDisplayOrder || []).filter(id => peerIds.includes(id));
  const points = await page((from, to) => {
    const source = document.querySelector(`#roomList [data-room-id="${CSS.escape(from)}"]`);
    const target = document.querySelector(`#roomList [data-room-id="${CSS.escape(to)}"]`);
    target.scrollIntoView({ block: 'nearest' }); source.scrollIntoView({ block: 'nearest' });
    source.focus();
    const first = source.getBoundingClientRect(), second = target.getBoundingClientRect();
    return [{ x: Math.round(first.left + 60), y: Math.round(first.top + first.height / 2) },
      { x: Math.round(second.left + 60), y: Math.round(second.bottom - 5) }];
  }, b.id, c.id);
  mouse('mouseMove', points[0]); mouse('mouseDown', points[0]); await settle(25);
  mouse('mouseMove', { x: points[0].x, y: points[0].y + 7 }); await settle(25);
  mouse('mouseMove', points[1]); await settle(40); mouse('mouseUp', points[1]);
  const dragSaved = await waitUntil(() => JSON.stringify(orderFromDisk()) === JSON.stringify([a.id, c.id, b.id]));
  check('真实鼠标跨行拖动保存房间显示顺序', dragSaved && JSON.stringify(await projectOrder()) === JSON.stringify([a.id, c.id, b.id]));
  check('拖动松手结束交互且不会误打开房间设置', await page(() => !NavigationUI.isInteracting() && document.querySelector('#roomModal').hidden));

  await rowPoint(b.id); key('Up', ['alt']);
  const keyboardSaved = await waitUntil(() => JSON.stringify(orderFromDisk()) === JSON.stringify([a.id, b.id, c.id]));
  check('真实 Alt+上箭头调整顺序并写入磁盘', keyboardSaved && JSON.stringify(await projectOrder()) === JSON.stringify([a.id, b.id, c.id]));
  check('房间排序只影响显示，目录、成员、置顶和原房间记录保持一致', JSON.stringify(persistence.rooms.map(room => ({ ...room }))) === snapshot);
  await page(async () => reloadFromMain());
  check('重新加载后保留房间显示顺序', JSON.stringify(await projectOrder()) === JSON.stringify(orderFromDisk()));

  await page(id => document.querySelector(`#roomList [data-room-id="${CSS.escape(id)}"]`).click(), side.id);
  const sideOpened = await waitFor(id => SideChatUI.getRoom()?.id === id && !!document.querySelector('#sideChatTitle'), side.id);
  const parentBefore = JSON.stringify(persistence.rooms.find(room => room.id === a.id));
  await page(() => document.querySelector('#sideChatTitle').click());
  check('点击侧聊名称打开该侧聊房间设置', sideOpened && await page(id => !document.querySelector('#roomModal').hidden && state.editingRoomId === id && document.querySelector('#r_cwd').disabled, side.id));
  await page(() => {
    document.querySelector('#r_name').value = 'Navigation side renamed'; document.querySelector('#roomSaveBtn').click();
  });
  const renamed = await waitFor(id => state.rooms.find(room => room.id === id)?.name === 'Navigation side renamed' &&
    document.querySelector('#roomModal').hidden && document.querySelector('#sideChatTitle').textContent === 'Navigation side renamed', side.id);
  check('侧聊标题设置保存到侧聊且主房间不受影响', renamed && savedRooms().find(room => room.id === side.id)?.name === 'Navigation side renamed' &&
    JSON.stringify(persistence.rooms.find(room => room.id === a.id)) === parentBefore);

  await page(() => { document.querySelector('#settingsBtn').click(); document.querySelector('.settings-tab[data-tab="skills"]').click(); });
  check('技能扫描日志可折叠且来源目录管理始终可见', await page(() => {
    const details = document.querySelector('#skillScanDetails'), add = document.querySelector('#skillAddRoot');
    return details?.tagName === 'DETAILS' && !!details.querySelector('summary') && !details.open &&
      !!document.querySelector('#skillRoots') && !details.contains(document.querySelector('#skillRoots')) &&
      !!details.querySelector('#skillScanStatus') && !!add && !details.contains(add) && !add.hidden;
  }));
  await page(() => document.querySelector('#skillScanDetails summary').click());
  check('技能扫描详情可以展开并再次收起', await page(() => {
    const details = document.querySelector('#skillScanDetails'), expanded = details.open;
    details.querySelector('summary').click(); return expanded && !details.open;
  }));
  await page(() => document.querySelector('.settings-tab[data-tab="guard"]').click());
  check('历史条数说明区分输入窗口、当前对话与本地完整记录', await page(() => {
    const input = document.querySelector('#s_catchup'), help = document.querySelector('#catchupHelp');
    return input.closest('label').querySelector('span').textContent === '本轮附带的最近历史条数' &&
      input.getAttribute('aria-describedby') === 'catchupHelp' && ['20', '0', '本轮', 'Token', '保存在本地'].every(text => help.textContent.includes(text));
  }));
  await page(() => closeAllModals());
};
