'use strict';

// Room metadata and the second conversation pane share the existing IPC,
// message renderer and composer. Each pane keeps its own room ID and draft.
const RoomUI = {
  visibleRooms() {
    const active = state.rooms.filter((room) => !room.archivedAt);
    const rooms = active.filter((room) => !room.parentRoomId || !active.some((parent) => parent.id === room.parentRoomId));
    return typeof RoomNavigation === 'undefined' ? rooms.sort((a, b) => (b.pinnedAt || 0) - (a.pinnedAt || 0))
      : RoomNavigation.ordered(rooms, state.settings.roomDisplayOrder || []).sort((a, b) => Number(!!b.pinnedAt) - Number(!!a.pinnedAt));
  },
  availableBots(room) {
    const represented = new Set((room?.botIds || []).map((id) => state.bots.find((bot) => bot.id === id)?.sourceBotId).filter(Boolean));
    const available = state.bots.filter((bot) => (!bot.ownerRoomId && !represented.has(bot.id)) || bot.ownerRoomId === room?.id);
    return [...new Map([...available, ...Object.values(room?.memberProfiles || {})].map(bot => [bot.id, bot])).values()];
  },
  ownsMembers(room) { return RoomProfiles.isLocal(room) || !!room && !room.parentRoomId && state.bots.some((bot) => bot.ownerRoomId === room.id); },
  appendSideItems(list, parent) {
    const children = state.rooms.filter((room) => room.parentRoomId === parent.id && !room.archivedAt)
      .sort((a, b) => (b.pinnedAt || 0) - (a.pinnedAt || 0));
    for (const room of children) {
      const item = document.createElement('div'); item.tabIndex = 0; item.dataset.roomId = room.id;
      item.className = 'side-item side-chat-item' + (SideChatUI.getRoom()?.id === room.id ? ' active' : '');
      item.innerHTML = `<span class="side-item-name">${esc(room.name)}</span>` +
        (room.pinnedAt ? I18n.t('<span class="room-pin" title="已置顶">↑</span>') : '') +
        (ACTIVE_RUN.has(runByRoom.get(room.id)?.status) ? I18n.t('<span class="busy-dot" title="运行中"></span>') : '') +
        I18n.t('<button class="row-menu" type="button" title="侧聊操作">⋯</button>');
      item.addEventListener('click', () => SideChatUI.open(room.id));
      item.addEventListener('keydown', (event) => {
        if (event.target === item && ['Enter', ' '].includes(event.key)) { event.preventDefault(); SideChatUI.open(room.id); }
      });
      item.querySelector('.row-menu').addEventListener('click', (event) => {
        event.stopPropagation(); openRoomMenu(event.target, room);
      });
      list.append(item);
    }
  },
  async pin(room) {
    const updated = await window.api.setRoomPinned({ roomId: room.id, pinned: !room.pinnedAt });
    Object.assign(room, updated); renderRooms();
  },
  async rename(room) {
    const result = await textEditor({ title: I18n.t('重命名'), text: room.name, inputLabel: I18n.t('名称'), saveLabel: I18n.t('保存') });
    if (!result) return;
    const updated = await window.api.renameRoom({ roomId: room.id, name: result.text.trim() });
    Object.assign(room, updated); renderRooms(); renderTopbar(); SideChatUI.sync();
  },
};

const SideChatUI = (() => {
  let pane, editor, transcript, popup, draft, selectedRoomId = null, completion = null;
  let creating = false;
  const openByParent = new Map();
  const findRoom = (id) => state.rooms.find((room) => room.id === id);
  const getRoom = () => findRoom(selectedRoomId);
  const el = (id) => pane.querySelector('#' + id);

  function wire() {
    pane = document.createElement('aside'); pane.id = 'sideChatPane'; pane.hidden = true;
    I18n.attr(pane, 'aria-label', () => I18n.t('侧边聊天'));
    pane.innerHTML = I18n.html`<header class="side-chat-header">
      <div class="room-heading">
      <div class="side-chat-title-row"><button id="sideChatTitle" type="button" title="侧聊房间设置"></button>
      <select id="sideChatSelect" aria-label="选择侧边聊天" title="切换侧边聊天"></select></div>
      <button id="sideChatWorkspace" type="button" class="workspace-chip">工作目录</button>
      </div>
      <button id="sideChatAdd" class="icon-btn" title="新建侧边聊天" aria-label="新建侧边聊天">＋</button>
      <button id="sideChatMenu" class="icon-btn" title="侧聊操作" aria-label="侧聊操作">⋯</button>
      <button id="sideChatClose" class="icon-btn" title="收起侧边聊天" aria-label="收起侧边聊天">×</button>
    </header>
    <div class="side-chat-members" id="sideChatMembers"></div>
    <div class="side-chat-messages" id="sideChatMessages" aria-label="侧聊消息"></div>
    <div class="side-chat-composer">
      <div id="sideChatStatus" class="run-status" hidden></div>
      <div id="sideChatMode" class="composer-mode-bar" aria-live="polite" hidden></div>
      <div class="composer-toolbar">
        <select id="sideChatRouting" aria-label="侧聊接收者"><option value="moderator">仅主持人</option><option value="all">全体</option></select>
        <select id="sideChatSpeak" aria-label="侧聊发言方式"><option value="parallel">自由并行</option><option value="sequential">顺序发言</option><option value="host">主持人点名</option></select>
      </div>
      <div class="composer-row"><div class="input-wrap">
        <div id="sideChatCompletion" class="mention-box" hidden></div>
        <div id="sideChatInput" contenteditable="true" role="textbox" aria-multiline="true" aria-label="侧聊消息输入" data-placeholder="独立对话；@ 选择成员，/ 选择命令与技能"></div>
      </div><button id="sideChatSend" class="send-btn">发送</button></div>
    </div>`;
    $('#app').appendChild(pane);
    editor = el('sideChatInput'); transcript = el('sideChatMessages'); popup = el('sideChatCompletion');
    draft = new RoomComposer(editor);
    const openButton = document.createElement('button'); openButton.id = 'sideChatOpen'; openButton.type = 'button';
    openButton.className = 'ghost-btn'; I18n.write(openButton, () => I18n.t('侧边聊天')); I18n.write(openButton, () => I18n.t('发起或继续独立的侧边聊天'), 'title');
    $('#topbar').appendChild(openButton);
    openButton.addEventListener('click', () => {
      const room = currentRoom(); if (!room) return;
      const children = state.rooms.filter((child) => child.parentRoomId === room.id && !child.archivedAt);
      if (!children.length) return create(room.id);
      openPopMenu(openButton, [
        { label: I18n.t('新建侧边聊天'), onClick: () => create(room.id) },
        ...children.map((child) => ({ label: child.name, onClick: () => open(child.id) })),
      ]);
    });
    el('sideChatSelect').addEventListener('change', () => open(el('sideChatSelect').value));
    el('sideChatTitle').addEventListener('click', () => { if (getRoom()) openRoomEdit(getRoom()); });
    el('sideChatAdd').addEventListener('click', () => create(getRoom()?.parentRoomId));
    el('sideChatClose').addEventListener('click', close);
    el('sideChatMenu').addEventListener('click', () => { if (getRoom()) openRoomMenu(el('sideChatMenu'), getRoom()); });
    el('sideChatRouting').addEventListener('change', () => saveConfig({ routingMode: el('sideChatRouting').value }));
    el('sideChatSpeak').addEventListener('change', () => saveConfig({ speakMode: el('sideChatSpeak').value }));
    el('sideChatSend').addEventListener('click', sendOrStop);
    editor.addEventListener('input', () => { resize(); if (!draft.composing) detectCompletion(); ComposerModeUI.sync(); });
    editor.addEventListener('compositionend', detectCompletion);
    editor.addEventListener('keydown', (event) => {
      if (event.isComposing || draft.composing || event.keyCode === 229) return;
      if (completion && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        if (event.key === 'Escape') return closeCompletion();
        if (event.key === 'Enter' || event.key === 'Tab') return choose(completion.items[completion.index]);
        completion.index = (completion.index + (event.key === 'ArrowDown' ? 1 : -1) + completion.items.length) % completion.items.length;
        return renderCompletion();
      }
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendOrStop(); }
      if (event.key === 'Escape') {
        event.stopPropagation();
        if (ACTIVE_RUN.has(runByRoom.get(selectedRoomId)?.status)) window.api.stopRun(selectedRoomId);
      }
    });
    document.addEventListener('pointerdown', (event) => {
      if (!pane.contains(event.target)) closeCompletion();
    });
  }

  async function create(parentRoomId) {
    if (!parentRoomId || creating) return;
    creating = true;
    try {
      const room = await window.api.createSideChat({ roomId: parentRoomId });
      await reloadFromMain(); open(room.id);
    } finally { creating = false; }
  }

  function open(roomId) {
    const room = findRoom(roomId);
    if (!room || room.archivedAt || !room.parentRoomId) return;
    const parent = findRoom(room.parentRoomId);
    if (!parent || parent.archivedAt) { switchRoom(room.id); return; }
    openByParent.set(parent.id, room.id);
    if (state.currentRoomId !== parent.id) switchRoom(parent.id);
    sync(); renderRooms(); window.WorkbenchUI?.chatOpened(roomId); editor.focus();
  }

  function close() {
    const previousRoomId = selectedRoomId;
    const parentId = getRoom()?.parentRoomId;
    if (parentId) openByParent.delete(parentId);
    selectedRoomId = null; draft.switchRoom(null); closeCompletion();
    pane.hidden = true; $('#app').classList.remove('has-side-chat');
    window.WorkbenchUI?.chatClosed(previousRoomId);
    renderRooms(); $('#sideChatOpen')?.focus();
  }

  function sync() {
    if (!pane) return;
    const parent = currentRoom();
    const target = findRoom(openByParent.get(parent?.id));
    const room = target && !target.archivedAt && target.parentRoomId === parent?.id ? target : null;
    $('#sideChatOpen').disabled = !parent || !!parent.archivedAt || !!parent.parentRoomId;
    const changed = selectedRoomId !== (room?.id || null);
    selectedRoomId = room?.id || null; pane.hidden = !room;
    $('#app').classList.toggle('has-side-chat', !!room);
    if (changed) { draft.switchRoom(selectedRoomId); closeCompletion(); resize(); }
    if (!room) return;
    el('sideChatTitle').textContent = room.name;
    I18n.attr(el('sideChatTitle'), 'aria-label', () => I18n.tpl`${room.name}，房间设置`);
    const select = el('sideChatSelect'); select.replaceChildren();
    for (const child of state.rooms.filter((item) => item.parentRoomId === parent.id && !item.archivedAt)) {
      const option = document.createElement('option'); option.value = child.id; option.textContent = child.name; select.append(option);
    }
    select.value = room.id;
    WorkspaceUI.render(el('sideChatWorkspace'), room);
    renderMembers(); syncControls();
    if (changed) renderMessages();
  }

  function renderMembers() {
    const room = getRoom(); if (!room) return;
    const list = el('sideChatMembers'); list.replaceChildren();
    for (const bot of roomMembers(room)) {
      const button = document.createElement('button'); button.className = 'side-chat-member'; button.type = 'button';
      button.innerHTML = avatarHtml(bot) + `<span>${esc(bot.name)}</span>`;
      I18n.write(button, () => `${bot.name}${room.moderatorBotId === bot.id ? I18n.t(' · 主持人') : ''} · ${bot.model || I18n.t('默认模型')}`, 'title');
      button.addEventListener('click', () => openBotEdit(bot, room.id)); list.append(button);
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'icon-btn';
      remove.textContent = '×'; I18n.write(remove, () => I18n.tpl`移出侧聊：${bot.name}`, 'title'); remove.setAttribute('aria-label', remove.title);
      remove.addEventListener('click', () => removeMember(room, bot).catch(error => AppDialog.alert(error.message))); list.append(remove);
    }
    const add = document.createElement('button'); add.className = 'icon-btn'; add.textContent = '＋'; I18n.write(add, () => I18n.t('配置侧聊成员'), 'title');
    I18n.attr(add, 'aria-label', () => I18n.t('配置侧聊成员')); add.addEventListener('click', () => openAddMember(room.id)); list.append(add);
    const extensions = document.createElement('button'); extensions.type = 'button'; extensions.className = 'ghost-btn';
    I18n.write(extensions, () => I18n.t('MCP 与插件')); I18n.write(extensions, () => I18n.t('仅配置此侧聊的成员扩展'), 'title');
    extensions.addEventListener('click', () => openSettings('extensions', room.id)); list.append(extensions);
  }

  function syncControls() {
    const room = getRoom(); if (!room) return;
    const run = runByRoom.get(room.id), active = ACTIVE_RUN.has(run?.status);
    el('sideChatRouting').value = room.routingMode; el('sideChatSpeak').value = room.speakMode;
    el('sideChatRouting').disabled = active; el('sideChatSpeak').disabled = active;
    const send = el('sideChatSend'); I18n.write(send, () => active ? I18n.t('停止') : I18n.t('发送'));
    send.classList.toggle('stop-btn', active); send.disabled = sendingRooms.has(room.id) && !active;
    el('sideChatStatus').hidden = !active;
    I18n.write(el('sideChatStatus'), () => active ? I18n.tpl`${run.status === 'stopping' ? I18n.t('正在停止…') : I18n.t('运行中')} · ${run.calls || 0} 次调用` : '');
    ComposerModeUI.sync();
  }

  async function saveConfig(patch) {
    const room = getRoom(); if (!room) return;
    try { Object.assign(room, await window.api.saveRoom({ ...room, ...patch })); }
    finally { syncControls(); }
  }

  async function sendOrStop() {
    const roomId = selectedRoomId;
    if (!roomId) return;
    if (ACTIVE_RUN.has(runByRoom.get(roomId)?.status)) return window.api.stopRun(roomId);
    let text = draft.value.trim();
    if (!text || sendingRooms.has(roomId)) return;
    if (await RoomCommands.intercept(text, roomId, draft)) return;
    const prepared = ComposerModeUI.prepare(roomId, text, draft);
    text = prepared.text;
    if (!text) return;
    sendingRooms.set(roomId, text); syncControls(); syncMessageActions();
    try { await window.api.sendHuman({ roomId, text, mode: prepared.mode }); }
    finally { sendingRooms.delete(roomId); syncControls(); syncMessageActions(); }
  }

  function renderMessages(mode = 'bottom') {
    if (!pane || !selectedRoomId) return;
    const follow = mode === 'bottom' || nearBottom(transcript), previousTop = transcript.scrollTop;
    const expanded = new Set([...transcript.querySelectorAll('details[open]')].map((detail) =>
      `${detail.closest('[data-msg-id]')?.dataset.msgId}:${detail.dataset.activityId || detail.className}`));
    transcript.replaceChildren();
    if (!messages(selectedRoomId).length) WorkspaceUI.empty(transcript, true);
    for (const message of messages(selectedRoomId)) {
      const row = bubbleEl(message);
      for (const detail of row.querySelectorAll('details')) detail.open = expanded.has(`${message.id}:${detail.dataset.activityId || detail.className}`);
      transcript.append(row);
    }
    ConversationUI.decorate(transcript, selectedRoomId);
    transcript.scrollTop = follow ? transcript.scrollHeight : previousTop;
    if (typeof NativeInputUI !== 'undefined') NativeInputUI.render(selectedRoomId);
  }

  function handleEvent(event) {
    if (!pane) return;
    if (event.kind === 'message_add' && event.message.authorType === 'human' && sendingRooms.get(event.roomId) === event.message.text) {
      draft.clearSent(event.roomId, event.message.text); resize();
    }
    if (event.roomId !== selectedRoomId) return;
    if (event.kind === 'message_delta') {
      const message = messages(event.roomId).find((item) => item.id === event.id);
      const row = transcript.querySelector(`[data-msg-id="${CSS.escape(event.id)}"]`);
      if (!message || !row) return;
      const follow = nearBottom(transcript);
      const text = row.querySelector('.bubble-text'); if (text) text.innerHTML = formatMessage(message.text);
      if (follow) transcript.scrollTop = transcript.scrollHeight;
    } else if (event.kind === 'message_update') {
      const message = messages(event.roomId).find(item => item.id === event.id);
      const row = [...transcript.querySelectorAll('[data-msg-id]')].find(item => item.dataset.msgId === event.id);
      const follow = nearBottom(transcript);
      if (!message || !patchStreamingMessage(row, message)) renderMessages('smart');
      else if (follow) transcript.scrollTop = transcript.scrollHeight;
    } else if (event.kind === 'message_add') renderMessages('smart');
    else if (event.kind === 'run_update') syncControls();
  }

  function closeCompletion() { completion = null; if (popup) popup.hidden = true; }
  function detectCompletion() {
    const end = draft.selection()[0];
    const slash = ComposerSlash.detect(draft.value, end);
    const mention = draft.value.slice(0, end).match(/(?:^|\s)@([^\s@/]*)$/);
    if (!slash && !mention) return closeCompletion();
    const type = slash ? 'skill' : 'mention';
    const items = slash ? ComposerSlash.items(selectedRoomId, slash.query)
      : [{ name: I18n.language === 'en' ? 'all' : '全体' }, ...roomMembers(getRoom())].filter(item => item.name.toLowerCase().includes(mention[1].toLowerCase()));
    if (!items.length) return closeCompletion();
    completion = { type, start: slash ? slash.start : end - mention[1].length - 1, end, items, index: 0, roomId: selectedRoomId };
    renderCompletion();
  }

  function renderCompletion() {
    popup.replaceChildren();
    for (const [index, item] of completion.items.entries()) {
      const button = document.createElement('button'); button.type = 'button';
      button.className = 'mention-item' + (index === completion.index ? ' active' : '');
      const label = document.createElement('span'); label.className = 'm-name';
      label.textContent = `${completion.type === 'mention' ? '@' : '/'}${item.name}`; button.append(label);
      if (completion.type === 'skill' && !item.command) {
        const source = document.createElement('small'); source.className = 'm-source';
        source.textContent = (item.sourceRoots || [skillSourceRoot(item.sourcePath)]).join(' · ');
        source.title = (item.sourcePaths || []).join(' · '); label.append(source);
      }
      if (item.description) { const hint = document.createElement('span'); hint.className = 'm-role'; hint.textContent = item.description.slice(0, 60); button.append(hint); }
      button.addEventListener('mousedown', (event) => event.preventDefault());
      button.addEventListener('click', () => choose(item)); popup.append(button);
    }
    popup.hidden = false;
  }

  async function choose(item) {
    const chosen = completion; if (!chosen || chosen.roomId !== selectedRoomId) return closeCompletion();
    closeCompletion();
    if (chosen.type === 'skill' && typeof window.chooseComposerSlash === 'function') {
      await window.chooseComposerSlash(item, { roomId: selectedRoomId, composer: draft, start: chosen.start, end: chosen.end });
    } else draft.replaceToken(chosen.start, chosen.end, chosen.type, item.name);
    if (!item.command) editor.focus();
    resize();
  }

  function resize() { editor.style.height = 'auto'; editor.style.height = Math.min(editor.scrollHeight, 200) + 'px'; }
  return { wire, open, create, close, sync, getRoom, handleEvent,
    get composer() { return draft; },
    refreshMessages(roomId) { if (roomId === selectedRoomId) renderMessages('smart'); },
    refresh() { sync(); if (selectedRoomId) renderMessages('smart'); },
    insertText(roomId, text) {
      if (findRoom(roomId)?.parentRoomId) open(roomId);
      if (selectedRoomId !== roomId) return false;
      draft.focus(); draft.select(draft.value.length); draft.insertText((draft.value ? '\n' : '') + text); resize(); return true;
    },
  };
})();
