'use strict';
const NavigationI18n = typeof module !== 'undefined' && module.exports ? require('../shared/i18n') : I18n;

// Keep grouping and ordering independent of DOM rendering so moving a room can
// only change its display position, never its project or conversation settings.
const RoomNavigation = (() => {
  function pathKey(value) {
    const text = String(value || '').replace(/\\/g, '/');
    const windows = /^[a-z]:($|\/)/i.test(text) || text.startsWith('//');
    const prefix = text.startsWith('//') ? '//' : /^[a-z]:($|\/)/i.test(text) ? text.slice(0, 2) + '/' : text.startsWith('/') ? '/' : '';
    const segments = [];
    for (const part of text.slice(prefix.length).split('/')) {
      if (!part || part === '.') continue;
      if (part === '..' && segments.length && segments.at(-1) !== '..') segments.pop();
      else if (part !== '..' || !prefix) segments.push(part);
    }
    const key = prefix + segments.join('/');
    return windows ? key.toLowerCase() : key;
  }
  function ordered(rooms, ids = []) {
    if (!Array.isArray(ids)) ids = [];
    const rank = new Map(ids.map((id, index) => [id, index]));
    return [...rooms].sort((a, b) => (rank.get(a.id) ?? ids.length) - (rank.get(b.id) ?? ids.length));
  }
  function groups(rooms, settings = {}, defaultCwd = '') {
    const active = ordered(rooms.filter(room => !room.archivedAt), settings.roomDisplayOrder || []);
    const ids = new Set(active.map(room => room.id));
    const roots = active.filter(room => !room.parentRoomId || !ids.has(room.parentRoomId));
    const projectKeys = [...new Set(rooms.filter(room => !room.archivedAt && !room.pinnedAt &&
      (!room.parentRoomId || !ids.has(room.parentRoomId))).map(room =>
      `project:${pathKey(room.cwd || settings.defaultCwd || defaultCwd)}`))];
    const pinned = { id: 'pinned', label: NavigationI18n.t('置顶'), path: '', entries: [] };
    const projects = new Map();
    const append = (group, room, depth, orderGroup) => {
      group.entries.push({ room, depth, orderGroup });
      for (const child of active.filter(item => item.parentRoomId === room.id && !item.pinnedAt)) {
        group.entries.push({ room: child, depth: depth + 1, orderGroup: `parent:${room.id}` });
      }
    };
    for (const room of active.filter(item => item.pinnedAt)) append(pinned, room, 0, 'pinned');
    for (const room of roots.filter(item => !item.pinnedAt)) {
      const cwd = room.cwd || settings.defaultCwd || defaultCwd;
      const key = `project:${pathKey(cwd)}`;
      if (!projects.has(key)) projects.set(key, {
        id: key, path: cwd, label: settings.projectDisplayNames?.[key] || cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || cwd || NavigationI18n.t('工作区'), entries: [],
      });
      append(projects.get(key), room, 0, key);
    }
    const pinnedProjects = new Set(settings.pinnedProjects || []);
    const sorted = projectKeys.map(key => projects.get(key)).filter(Boolean).sort((a, b) => Number(pinnedProjects.has(b.id)) - Number(pinnedProjects.has(a.id)));
    return [...(pinned.entries.length ? [pinned] : []), ...sorted];
  }
  function move(rooms, settings, defaultCwd, from, target, after = false) {
    const entries = groups(rooms, settings, defaultCwd).flatMap(group => group.entries);
    const source = entries.find(entry => entry.room.id === from), destination = entries.find(entry => entry.room.id === target);
    if (!source || !destination || source.orderGroup !== destination.orderGroup || from === target) return null;
    const ids = ordered(rooms, settings.roomDisplayOrder || []).map(room => room.id).filter(id => id !== from);
    ids.splice(ids.indexOf(target) + (after ? 1 : 0), 0, from);
    return ids;
  }
  return { pathKey, ordered, groups, move };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = RoomNavigation;

const NavigationUI = (() => {
  let gesture = null, saving = false, writeQueue = Promise.resolve();
  const svg = (name) => `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">${name === 'pin'
    ? '<path d="m7 3 6 0-1 5 3 3v1H5v-1l3-3-1-5Zm3 9v5"/>'
    : '<path d="M2.5 6V4.5h5l2 2h8v9h-15V6Z"/>'}</svg>`;
  const currentGroups = () => RoomNavigation.groups(state.rooms, state.settings, state.defaultCwd);
  const collapsedGroups = () => Array.isArray(state.settings.navigationCollapsedGroups) ? state.settings.navigationCollapsedGroups : [];
  const open = room => room.parentRoomId && state.rooms.some(parent => parent.id === room.parentRoomId && !parent.archivedAt)
    ? SideChatUI.open(room.id) : switchRoom(room.id);

  function persist(patch) {
    const previous = Object.fromEntries(Object.keys(patch).map(key => [key, state.settings[key]]));
    Object.assign(state.settings, patch);
    const pending = writeQueue.catch(() => {}).then(() => window.api.saveNavigation(patch));
    writeQueue = pending;
    return pending.catch(error => {
      for (const key of Object.keys(patch)) if (state.settings[key] === patch[key]) state.settings[key] = previous[key];
      render();
      AppDialog.alert(error.message || NavigationI18n.t('显示设置保存失败，请重试'));
      throw error;
    });
  }

  async function reorder(from, to, after = false) {
    const ids = RoomNavigation.move(state.rooms, state.settings, state.defaultCwd, from, to, after);
    if (!ids || ids.join('\0') === RoomNavigation.ordered(state.rooms, state.settings.roomDisplayOrder).map(room => room.id).join('\0')) return;
    saving = true;
    try { const pending = persist({ roomDisplayOrder: ids }); render(); await pending; }
    catch { /* persist restores state and reports the failure */ }
    finally { saving = false; render(); }
  }

  function itemFor(entry) {
    const { room, depth, orderGroup } = entry;
    const item = document.createElement('div');
    item.className = 'side-item room-nav-item' + (depth ? ' side-chat-item' : '') +
      ((room.id === state.currentRoomId || SideChatUI.getRoom()?.id === room.id) ? ' active' : '');
    item.tabIndex = 0; item.dataset.roomId = room.id; item.dataset.orderGroup = orderGroup;
    NavigationI18n.write(item, () => NavigationI18n.tpl`${room.name}\n${WorkspaceUI.path(room)}\n拖动或 Alt + ↑ / ↓ 调整同组显示顺序`, 'title');
    item.setAttribute('aria-label', room.name); item.setAttribute('aria-grabbed', 'false');
    item.innerHTML = `<span class="side-item-name">${esc(room.name)}</span>` +
      (ACTIVE_RUN.has(runByRoom.get(room.id)?.status) ? NavigationI18n.t('<span class="busy-dot" title="运行中"></span>') : '') +
      NavigationI18n.t('<button class="row-menu" type="button" title="房间操作" aria-label="房间操作">⋯</button>');
    item.addEventListener('click', event => {
      if (item.dataset.dragged) { event.preventDefault(); return; }
      open(room);
    });
    item.querySelector('.row-menu').addEventListener('click', event => {
      event.stopPropagation(); openRoomMenu(event.currentTarget, room);
    });
    item.addEventListener('contextmenu', event => {
      event.preventDefault();
      if (gesture) cancelGesture();
      item.focus();
      openRoomMenu({ getBoundingClientRect: () => ({ left: event.clientX, top: event.clientY, bottom: event.clientY }) }, room);
    });
    item.addEventListener('keydown', async event => {
      if (event.target !== item) return;
      if (['Enter', ' '].includes(event.key)) { event.preventDefault(); open(room); }
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); openRoomMenu(item, room); }
      if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key) && !saving) {
        event.preventDefault();
        const peers = currentGroups().flatMap(group => group.entries).filter(peer => peer.orderGroup === orderGroup);
        const index = peers.findIndex(peer => peer.room.id === room.id), down = event.key === 'ArrowDown';
        const target = peers[index + (down ? 1 : -1)];
        if (target) { await reorder(room.id, target.room.id, down); document.querySelector(`[data-room-id="${CSS.escape(room.id)}"]`)?.focus(); }
      }
    });
    item.addEventListener('pointerdown', event => beginGesture(event, item));
    return item;
  }

  function render() {
    if (gesture) return;
    const list = document.querySelector('#roomList'); if (!list) return;
    const scroll = list.closest('.side-section'), previousScroll = scroll?.scrollTop;
    list.replaceChildren();
    const collapsed = new Set(collapsedGroups());
    for (const group of currentGroups()) {
      const section = document.createElement('section'); section.className = 'room-nav-group'; section.dataset.groupId = group.id;
      const header = document.createElement('button'); header.type = 'button'; header.className = 'room-nav-group-toggle';
      header.setAttribute('aria-expanded', String(!collapsed.has(group.id)));
      NavigationI18n.write(header, () => group.path || NavigationI18n.t('置顶房间'), 'title');
      header.innerHTML = svg(group.id === 'pinned' ? 'pin' : 'folder') +
        `<span class="room-nav-group-label">${esc(group.label)}</span><span class="room-nav-count">${group.entries.length}</span><span class="room-nav-chevron" aria-hidden="true">⌄</span>`;
      const content = document.createElement('div'); content.className = 'room-nav-group-content'; content.hidden = collapsed.has(group.id);
      if (group.path) {
        const path = document.createElement('div'); path.className = 'room-nav-project-path'; path.textContent = group.path; path.title = group.path; content.append(path);
      }
      for (const entry of group.entries) content.append(itemFor(entry));
      header.addEventListener('click', () => {
        const next = new Set(collapsedGroups());
        if (next.has(group.id)) next.delete(group.id); else next.add(group.id);
        persist({ navigationCollapsedGroups: [...next] }).catch(() => {});
        render();
      });
      const heading = document.createElement('div'); heading.className = 'room-nav-heading'; heading.append(header);
      if (group.id !== 'pinned') {
        const create = document.createElement('button'); create.type = 'button'; create.className = 'project-create icon-btn';
        create.textContent = '✎'; NavigationI18n.write(create, () => NavigationI18n.t('在此项目中新建房间'), 'title'); NavigationI18n.attr(create, 'aria-label', () => NavigationI18n.tpl`在项目 ${group.label} 中新建房间`);
        create.addEventListener('click', () => openRoomNew(group.path));
        const menu = document.createElement('button'); menu.type = 'button'; menu.className = 'project-menu icon-btn';
        menu.textContent = '⋯'; NavigationI18n.write(menu, () => NavigationI18n.t('项目操作'), 'title'); NavigationI18n.attr(menu, 'aria-label', () => NavigationI18n.tpl`项目 ${group.label} 操作`);
        menu.addEventListener('click', () => projectMenu(menu, group));
        header.addEventListener('contextmenu', event => { event.preventDefault(); projectMenu(header, group); });
        heading.append(menu, create);
      }
      section.append(heading, content); list.append(section);
    }
    if (scroll) scroll.scrollTop = previousScroll;
  }

  async function renameProject(group) {
    const result = await textEditor({ title: NavigationI18n.t('重命名项目'), text: group.label, description: NavigationI18n.t('仅修改侧栏显示名称，工作目录保持不变。'), inputLabel: NavigationI18n.t('项目名称（最多 120 字）'), singleLine: true });
    if (!result) return;
    const name = result.text.trim();
    if (!name || name.length > 120 || /[\x00-\x1f]/.test(name)) return AppDialog.alert(NavigationI18n.t('请输入 1–120 字的单行名称'));
    await persist({ projectDisplayNames: { ...state.settings.projectDisplayNames, [group.id]: name } }); render();
  }

  function projectRoomIds(group) {
    return state.rooms.filter(room => RoomNavigation.pathKey(WorkspaceUI.path(room)) === RoomNavigation.pathKey(group.path)).map(room => room.id);
  }

  async function projectAction(group, action) {
    const roomIds = projectRoomIds(group);
    if (!roomIds.length) return;
    const text = action === 'delete'
      ? NavigationI18n.tpl`永久删除项目「${group.label}」中的 ${roomIds.length} 个房间（包括侧聊与已归档房间）、消息和聊天归档？此操作不可恢复。磁盘项目文件保留。`
      : NavigationI18n.tpl`归档项目「${group.label}」中的 ${roomIds.length} 个房间（包括侧聊）？全部聊天与设置保留，可在历史中恢复。磁盘项目文件保留。`;
    if (!await AppDialog.confirm(text)) return;
    try { await window.api.projectRooms({ roomIds, action }); }
    finally { await reloadFromMain(); }
  }

  function projectMenu(anchor, group) {
    const pinned = new Set(state.settings.pinnedProjects || []);
    openPopMenu(anchor, [
      { label: pinned.has(group.id) ? NavigationI18n.t('取消置顶项目') : NavigationI18n.t('置顶项目'), onClick: async () => {
        if (pinned.has(group.id)) pinned.delete(group.id); else pinned.add(group.id);
        await persist({ pinnedProjects: [...pinned] }); render();
      } },
      { label: NavigationI18n.t('在资源管理器打开'), onClick: () => window.api.openRoomDirectory(group.entries[0].room.id) },
      { label: NavigationI18n.t('重命名项目'), onClick: () => renameProject(group) },
      { label: NavigationI18n.t('归档当前项目下的房间'), onClick: () => projectAction(group, 'archive') },
      { label: NavigationI18n.t('移除项目…'), onClick: () => openPopMenu(anchor, [
        { label: NavigationI18n.t('归档房间并移除项目'), onClick: () => projectAction(group, 'archive') },
        { label: NavigationI18n.t('永久删除项目下的房间…'), danger: true, onClick: () => projectAction(group, 'delete') },
      ]) },
    ]);
  }

  async function moveRoom(room) {
    const directory = await window.api.pickFolder(WorkspaceUI.path(room));
    if (!directory) return;
    if (!await AppDialog.confirm(NavigationI18n.tpl`将「${room.name}」移动到项目 ${directory}？会修改房间及其侧聊的工作目录；聊天与成员保留，磁盘文件不会移动。`)) return;
    await window.api.saveRoom({ id: room.id, cwd: directory });
    await reloadFromMain();
  }

  function cancelGesture() { gesture?.cleanup(); }

  function beginGesture(event, item) {
    if (saving || gesture || event.button !== 0 || event.isPrimary === false || event.target.closest('button')) return;
    delete item.dataset.dragged;
    const list = item.closest('#roomList'), scroller = list.closest('.side-section') || list;
    const start = { id: event.pointerId, x: event.clientX, y: event.clientY, touch: event.pointerType === 'touch' };
    let dragging = false, timer, frame, target, after = false, x = event.clientX, y = event.clientY, scrolling = false, previousY = y;
    const clearMarker = () => { target?.classList.remove('room-drop-before', 'room-drop-after'); target = null; };
    const locate = () => {
      clearMarker();
      const bounds = scroller.getBoundingClientRect();
      if (x < bounds.left || x > bounds.right) return;
      const pointed = document.elementFromPoint(x, Math.max(bounds.top + 1, Math.min(bounds.bottom - 1, y)))?.closest('.room-nav-item');
      if (!pointed || pointed === item || pointed.dataset.orderGroup !== item.dataset.orderGroup) return;
      target = pointed;
      const rect = target.getBoundingClientRect(); after = y >= rect.top + rect.height / 2;
      target.classList.add(after ? 'room-drop-after' : 'room-drop-before');
    };
    const scroll = () => {
      if (!dragging) return;
      const rect = scroller.getBoundingClientRect();
      const delta = y < rect.top + 32 ? (y - rect.top - 32) / 3 : y > rect.bottom - 32 ? (y - rect.bottom + 32) / 3 : 0;
      if (delta) { scroller.scrollTop += Math.max(-12, Math.min(12, delta)); locate(); }
      frame = requestAnimationFrame(scroll);
    };
    const cleanup = () => {
      clearTimeout(timer); cancelAnimationFrame(frame); clearMarker();
      document.removeEventListener('pointermove', move, true); document.removeEventListener('pointerup', release, true);
      document.removeEventListener('pointercancel', cancel, true); document.removeEventListener('keydown', escape, true);
      window.removeEventListener('blur', cancel);
      item.removeEventListener('lostpointercapture', cancel);
      gesture = null; item.classList.remove('room-dragging'); list.classList.remove('room-reordering'); item.setAttribute('aria-grabbed', 'false');
      if (item.hasPointerCapture(start.id)) item.releasePointerCapture(start.id);
    };
    const begin = () => {
      clearTimeout(timer); dragging = true; item.dataset.dragged = 'true';
      item.classList.add('room-dragging'); list.classList.add('room-reordering'); item.setAttribute('aria-grabbed', 'true');
      locate(); frame = requestAnimationFrame(scroll);
    };
    const move = event => {
      if (event.pointerId !== start.id) return;
      x = event.clientX; y = event.clientY;
      const distance = Math.hypot(x - start.x, y - start.y);
      if (start.touch && !dragging && (scrolling || distance >= 8)) {
        clearTimeout(timer); scrolling = true; item.dataset.dragged = 'true'; scroller.scrollTop -= y - previousY; previousY = y; event.preventDefault(); return;
      }
      if (!dragging && distance >= 5) begin();
      if (dragging) { event.preventDefault(); locate(); }
    };
    const release = event => {
      if (event.pointerId !== start.id) return;
      x = event.clientX; y = event.clientY; if (dragging) locate();
      const destination = target?.dataset.roomId, insertAfter = after, moved = dragging;
      cleanup();
      // The click generated by pointerup must be suppressed before re-render.
      setTimeout(() => { if (moved && destination) reorder(item.dataset.roomId, destination, insertAfter); else render(); }, 0);
    };
    const cancel = event => { if (event.pointerId != null && event.pointerId !== start.id) return; cleanup(); render(); };
    const escape = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cleanup(); render(); } };
    gesture = { cleanup };
    document.addEventListener('pointermove', move, true); document.addEventListener('pointerup', release, true);
    document.addEventListener('pointercancel', cancel, true); document.addEventListener('keydown', escape, true); window.addEventListener('blur', cancel);
    item.addEventListener('lostpointercapture', cancel); item.setPointerCapture(start.id);
    if (start.touch) timer = setTimeout(begin, 350); else { event.preventDefault(); item.focus(); }
  }

  function wireSettings() {
    const scan = document.querySelector('.scan-details');
    if (scan && scan.tagName !== 'DETAILS') {
      const add = scan.querySelector('#skillAddRoot');
      const details = document.createElement('details'); details.className = 'scan-details'; details.id = 'skillScanDetails';
      const summary = document.createElement('summary'); NavigationI18n.write(summary, () => NavigationI18n.t('来源目录与扫描结果')); details.append(summary);
      for (const child of [...scan.childNodes]) if (child !== add) details.append(child);
      scan.replaceWith(details); if (add) details.after(add);
    }
    const input = document.querySelector('#s_catchup');
    if (input) {
      const label = input.closest('label'); NavigationI18n.write(label.querySelector('span'), () => NavigationI18n.t('本轮附带的最近历史条数'));
      if (!document.querySelector('#catchupHelp')) {
        const hint = document.createElement('small'); hint.id = 'catchupHelp'; hint.className = 'hint';
        NavigationI18n.write(hint, () => NavigationI18n.t('默认 20：从本轮消息前最近 20 条记录中补入有效且对该成员可见的内容，并附带本轮对话。0 仅附带本轮；更高值增加上下文与输入 Token，全部记录仍保存在本地。'));
        input.setAttribute('aria-describedby', hint.id); label.append(hint);
      }
    }
  }
  return { render, wireSettings, moveRoom, cancelGesture, isInteracting: () => !!gesture };
})();
