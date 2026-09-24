'use strict';
const ConversationI18n = typeof module !== 'undefined' && module.exports ? require('../shared/i18n') : I18n;
const searchableContent = typeof module !== 'undefined' && module.exports ? require('../shared/messageContent') : MessageContent;

// Pure transcript queries also run in Node tests. Search never changes history.
const ConversationQueries = {
  search(rooms, dataByRoom, query, limit = 100) {
    const needle = String(query || '').trim().toLocaleLowerCase();
    if (!needle) return [];
    const hits = [];
    for (const room of rooms) for (const message of dataByRoom[room.id] || []) {
      const text = searchableContent.publicText(message), index = text.toLocaleLowerCase().indexOf(needle);
      if (index < 0) continue;
      hits.push({ roomId: room.id, roomName: room.name, archived: !!room.archivedAt, messageId: message.id,
        processMatch: !String(message.text || '').toLocaleLowerCase().includes(needle),
        createdAt: message.createdAt, excerpt: (index > 35 ? '…' : '') + text.slice(Math.max(0, index - 35), index + needle.length + 90) });
    }
    return hits.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, limit);
  },
  timing(message, live, now = Date.now()) {
    const run = live && live.roundId === message.id ? live : message.roundRun;
    if (!run || !Number.isFinite(run.startedAt)) return { label: ConversationI18n.t('历史轮次 · 耗时未记录'), active: false };
    const active = ['running', 'stopping'].includes(run.status);
    const end = active ? now : run.endedAt;
    const seconds = Number.isFinite(end) ? Math.floor(Math.max(0, end - run.startedAt) / 1000) : null;
    const elapsed = seconds === null ? ConversationI18n.t('未记录完整耗时') : ConversationI18n.tpl`用时 ${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    const limitStatus = { auto_turns: ConversationI18n.t('自动接力轮次已用完'), calls: ConversationI18n.t('本轮调用次数已用完'), tokens: ConversationI18n.t('已达 Token 软上限'), cost: ConversationI18n.t('已达费用软上限') }[run.stopReason] || ConversationI18n.t('已停止自动派发');
    const status = { running: ConversationI18n.t('运行中'), stopping: ConversationI18n.t('正在停止'), stopped: ConversationI18n.t('已取消'), done: ConversationI18n.t('已结束'), error: ConversationI18n.t('失败'), budget: limitStatus, interrupted: ConversationI18n.t('意外中断') }[run.status] || run.status;
    return { label: `${elapsed} · ${status}`, active };
  },
  processState(roundId, list, autoCollapse, override) {
    const replies = list.filter(message => message.roundId === roundId && message.authorType === 'bot' && !message.supersededBy);
    const hasOutput = replies.some(message => message.activities?.length > 0);
    const finalAvailable = replies.some(message => message.finalAnswer || message.status === 'done' && message.text?.trim());
    const executing = replies.some(message => message.status === 'streaming' && !message.finalAnswer);
    const canCollapse = hasOutput && finalAvailable && !executing;
    return { canCollapse, open: !canCollapse || (typeof override === 'boolean' ? override : autoCollapse === false) };
  },
};
if (typeof module !== 'undefined' && module.exports) module.exports = ConversationQueries;

const ConversationUI = (() => {
  const expanded = new Map();
  let searchDialog, searchInput, results, timer, searchVersion = 0;
  const node = (tag, cls, text) => { const el = document.createElement(tag); el.className = cls || ''; if (text != null) ConversationI18n.label(el, text); return el; };
  const key = (roomId, roundId) => `${roomId}:${roundId}`;
  const transcript = roomId => roomId === state.currentRoomId ? document.querySelector('#messages')
    : roomId === SideChatUI.getRoom()?.id ? document.querySelector('#sideChatMessages') : null;

  function showMessage(roomId, messageId, revealProcess = false) {
    const room = state.rooms.find(item => item.id === roomId); if (!room) return;
    const message = messages(roomId).find(item => item.id === messageId);
    if (revealProcess && message?.roundId) expanded.set(key(roomId, message.roundId), true);
    if (room.parentRoomId && !room.archivedAt && state.rooms.some(item => item.id === room.parentRoomId && !item.archivedAt)) SideChatUI.open(roomId);
    else switchRoom(roomId);
    // Archived side chats are displayed as a read-only main transcript.
    if (room.archivedAt && state.currentRoomId !== roomId) {
      state.currentRoomId = roomId; composer.switchRoom(roomId); renderTopbar(); renderBots(); syncComposer(); renderMessages();
    }
    window.WorkbenchUI?.showConversation(roomId);
    requestAnimationFrame(() => {
      const target = transcript(roomId)?.querySelector(`[data-msg-id="${CSS.escape(messageId)}"]`);
      if (!target) return;
      target.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'center' });
      target.classList.add('message-search-target'); target.tabIndex = -1; target.focus({ preventScroll: true });
      setTimeout(() => target.classList.remove('message-search-target'), 2200);
    });
  }

  function decorate(wrap, roomId) {
    wrap.querySelector('.input-node-rail')?.remove();
    const list = messages(roomId), human = list.filter(message => message.authorType === 'human');
    const byId = new Map(list.map(message => [message.id, message]));
    const rows = new Map([...wrap.querySelectorAll('[data-msg-id]')].map(row => [row.dataset.msgId, row]));
    const timings = new Map([...wrap.querySelectorAll('[data-round-timing]')].map(row => [row.dataset.roundTiming, row]));
    const rail = node('nav', 'input-node-rail'); ConversationI18n.attr(rail, 'aria-label', () => ConversationI18n.t('用户输入节点'));
    for (const [index, message] of human.entries()) {
      const button = node('button', 'input-node', '—'); button.type = 'button';
      ConversationI18n.write(button, () => `${index + 1}. ${message.text || ConversationI18n.t('(空消息)')}`, 'title'); ConversationI18n.attr(button, 'aria-label', () => ConversationI18n.tpl`跳转到第 ${index + 1} 次输入：${String(message.text || '').slice(0, 100)}`);
      button.addEventListener('click', () => showMessage(roomId, message.id)); rail.append(button);
      const row = rows.get(message.id);
      if (!row) continue;
      let timing = timings.get(message.id);
      if (!timing) {
        timing = node('button', 'round-timing'); timing.type = 'button'; timing.dataset.roundTiming = message.id;
        timing.addEventListener('click', () => {
          if (timing.disabled) return;
          const id = key(roomId, message.id); expanded.set(id, timing.getAttribute('aria-expanded') !== 'true');
          decorate(wrap, roomId);
        }); row.after(timing);
      }
      const process = ConversationQueries.processState(message.id, list, state.settings.autoCollapseProcess, expanded.get(key(roomId, message.id)));
      const label = node('span', 'round-timing-label', ConversationQueries.timing(message, runByRoom.get(roomId)).label);
      const chevron = node('span', 'round-timing-chevron'); chevron.setAttribute('aria-hidden', 'true');
      timing.replaceChildren(label, chevron); timing.disabled = !process.canCollapse;
      timing.setAttribute('aria-expanded', String(process.open)); ConversationI18n.write(timing, () => process.canCollapse ? ConversationI18n.t('展开或收起执行过程；最终结论始终保留') : ConversationI18n.t('执行中始终展示过程输出；工具和思考可独立展开'), 'title');
    }
    if (human.length) wrap.prepend(rail);
    for (const row of rows.values()) {
      const message = byId.get(row.dataset.msgId);
      const process = ConversationQueries.processState(message?.roundId, list, state.settings.autoCollapseProcess, expanded.get(key(roomId, message?.roundId)));
      row.classList.toggle('round-process-collapsed', !!message?.roundId && byId.has(message.roundId) && !process.open);
    }
  }

  function refreshTimings() {
    for (const roomId of [state.currentRoomId, SideChatUI.getRoom()?.id].filter(Boolean)) {
      const wrap = transcript(roomId); if (!wrap) continue;
      const byId = new Map(messages(roomId).map(message => [message.id, message]));
      for (const timing of wrap.querySelectorAll('[data-round-timing]')) {
        const message = byId.get(timing.dataset.roundTiming); if (!message) continue;
        const label = timing.querySelector('.round-timing-label');
        if (label) label.textContent = ConversationQueries.timing(message, runByRoom.get(roomId)).label;
      }
    }
  }

  function event(e) {
    if (['message_add', 'message_update', 'run_update'].includes(e.kind)) {
      const wrap = transcript(e.roomId); if (wrap) decorate(wrap, e.roomId);
    }
  }

  async function renderSearch() {
    const version = ++searchVersion, query = searchInput.value.trim();
    results.replaceChildren();
    if (!query) { window.api.cancelArchiveSearch(); results.append(node('p', 'hint', ConversationI18n.live(() => ConversationI18n.t('输入会话内容，搜索所有房间及聊天归档')))); return; }
    const live = ConversationQueries.search(state.rooms, state.dataByRoom, query);
    const paint = (archived = [], warnings = [], pending = false) => {
      const hits = [...live, ...archived].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 100);
      results.replaceChildren();
      if (!hits.length && !pending) results.append(node('p', 'hint', ConversationI18n.live(() => warnings.length ? ConversationI18n.t('已读取内容中没有匹配消息；部分归档未搜索') : ConversationI18n.t('未找到匹配消息'))));
      for (const hit of hits) {
        const button = node('button', 'conversation-search-result'); button.type = 'button';
        button.append(node('strong', '', ConversationI18n.live(() => hit.roomName + (hit.archiveId ? ConversationI18n.t(' · 聊天归档') : hit.archived ? ConversationI18n.t(' · 已归档房间') : ''))), node('span', '', hit.excerpt));
        button.addEventListener('click', () => {
          searchDialog.close();
          if (hit.archiveId) viewArchive(hit.roomId, hit.archiveId, hit.messageId);
          else showMessage(hit.roomId, hit.messageId, hit.processMatch);
        }); results.append(button);
      }
      if (pending) results.append(node('p', 'hint', ConversationI18n.live(() => ConversationI18n.t('正在搜索聊天归档…'))));
      for (const warning of warnings) results.append(node('p', 'hint', warning));
      if (hits.length === 100) results.append(node('p', 'hint', ConversationI18n.live(() => ConversationI18n.t('显示最新 100 条匹配消息，请输入更具体的内容缩小范围。'))));
    };
    paint([], [], true);
    try {
      const archived = await window.api.searchArchives(query);
      if (version !== searchVersion || query !== searchInput.value.trim() || archived.cancelled) return;
      paint(archived.hits, archived.warnings);
    } catch (error) {
      if (version !== searchVersion) return;
      paint([], [ConversationI18n.tpl`聊天归档搜索未完成：${error.message || error}；当前房间记录仍可搜索`]);
    }
  }

  function openSearch() {
    if (document.querySelector('dialog[open]') && !searchDialog.open) return;
    if (!searchDialog.open) searchDialog.showModal();
    renderSearch(); searchInput.focus(); searchInput.select();
  }

  function wire() {
    const button = node('button', 'icon-btn conversation-search-open'); button.id = 'conversationSearchOpen'; button.type = 'button';
    ConversationI18n.write(button, () => ConversationI18n.t('查找会话（Ctrl+K）'), 'title'); ConversationI18n.attr(button, 'aria-label', () => ConversationI18n.t('查找会话'));
    button.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg>';
    document.querySelector('.side-head').append(button); button.addEventListener('click', openSearch);
    searchDialog = node('dialog', 'app-dialog conversation-search'); searchDialog.id = 'conversationSearchDialog'; ConversationI18n.attr(searchDialog, 'aria-label', () => ConversationI18n.t('查找会话'));
    const header = node('div', 'conversation-search-header');
    searchInput = node('input'); searchInput.type = 'search'; searchInput.maxLength = 2000; ConversationI18n.write(searchInput, () => ConversationI18n.t('搜索会话内容'), 'placeholder'); ConversationI18n.attr(searchInput, 'aria-label', () => ConversationI18n.t('搜索会话内容'));
    const close = node('button', 'ghost-btn', ConversationI18n.live(() => ConversationI18n.t('关闭'))); close.type = 'button'; close.addEventListener('click', () => searchDialog.close());
    header.append(searchInput, close); results = node('div', 'conversation-search-results'); results.setAttribute('aria-live', 'polite');
    searchDialog.append(header, results); document.body.append(searchDialog);
    searchInput.addEventListener('input', () => { ++searchVersion; window.api.cancelArchiveSearch(); results.replaceChildren(); clearTimeout(timer); timer = setTimeout(renderSearch, 180); });
    searchDialog.addEventListener('close', () => { ++searchVersion; clearTimeout(timer); window.api.cancelArchiveSearch(); });
    searchDialog.addEventListener('keydown', async event => {
      event.stopPropagation();
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); const buttons = [...results.querySelectorAll('button')];
        const index = buttons.indexOf(document.activeElement), next = index + (event.key === 'ArrowDown' ? 1 : -1);
        (buttons[(next + buttons.length) % buttons.length] || searchInput).focus();
      }
      if (event.key === 'Enter' && document.activeElement === searchInput) {
        event.preventDefault(); clearTimeout(timer); const query = searchInput.value.trim(); await renderSearch();
        if (query === searchInput.value.trim() && searchDialog.open) results.querySelector('button')?.click();
      }
    });
    document.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'k') { event.preventDefault(); openSearch(); }
    });
    setInterval(refreshTimings, 1000);
  }
  return { decorate, event, wire, showMessage, openSearch };
})();
