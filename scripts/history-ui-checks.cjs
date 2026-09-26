'use strict';
module.exports = async function historyChecks({ win, persistence, check }) {
  const page = (fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
  const room = persistence.saveRoom({ name: 'History search fixture', botIds: [] });
  const message = { id: 'history_archive_jump', roomId: room.id, authorType: 'human', authorId: 'owner', text: 'unique-history-search-fixture', status: 'done', createdAt: Date.now() };
  persistence.addMessage(room.id, message);
  const archive = persistence.archiveCurrent(room.id);
  const archivedRoom = persistence.saveRoom({ name: 'Archived room fixture', botIds: [] });
  persistence.setRoomArchived(archivedRoom.id, true);
  check('history defaults to all rooms and lists chat archives with their actual room', await page(async () => {
    await reloadFromMain(); closeAllModals(); openSettings('history'); await loadHistoryTab();
    return document.querySelector('#histRoom').value === '' && ['histArchive', 'histClear', 'histExport'].every(id => document.getElementById(id).disabled)
      && document.querySelector('#histArchiveList').textContent.includes('History search fixture');
  }));
  const failedRoom = persistence.saveRoom({ name: 'Unreadable archive fixture', botIds: [] });
  const laterRoom = persistence.saveRoom({ name: 'Later healthy archive fixture', botIds: [] });
  persistence.addMessage(laterRoom.id, { ...message, id: 'later_archive_message', roomId: laterRoom.id });
  persistence.archiveCurrent(laterRoom.id);
  const fs = require('node:fs'), path = require('node:path');
  const brokenDirectory = path.join(persistence.getDataPath(), 'archives', failedRoom.id);
  const brokenArchive = path.join(brokenDirectory, 'broken_fixture.json');
  fs.mkdirSync(brokenDirectory, { recursive: true }); fs.writeFileSync(brokenArchive, '{broken');
  try {
    check('one corrupt room archive reports its error while earlier and later healthy archives remain visible', await page(async () => {
      await reloadFromMain(); await loadHistoryTab();
      const list = document.querySelector('#histArchiveList');
      return list.textContent.includes('History search fixture') && list.textContent.includes('Later healthy archive fixture') &&
        list.querySelector('.history-archive-warning')?.textContent.includes('Unreadable archive fixture') && list.textContent.includes('JSON_INVALID');
    }));
    check('archive read warning translates without altering the room name or native error', await page(() => {
      I18n.setLanguage('en'); const text = document.querySelector('.history-archive-warning')?.textContent;
      const good = text?.includes('Unreadable archive fixture: Could not read chat archives:') && text.includes('JSON_INVALID');
      I18n.setLanguage('zh-CN'); return good;
    }));
  } finally { fs.unlinkSync(brokenArchive); }
  const listArchives = persistence.listArchives;
  let rejectOld, requested;
  const waiting = new Promise(resolve => { requested = resolve; });
  persistence.listArchives = function (roomId) {
    if (roomId === failedRoom.id) return new Promise((_resolve, reject) => { rejectOld = reject; requested(); });
    return listArchives.call(this, roomId);
  };
  try {
    await page(() => { document.querySelector('#histRoom').value = ''; window.historyPendingFixture = renderHistory(); });
    await waiting;
    await page(async roomId => { document.querySelector('#histRoom').value = roomId; await renderHistory(); }, room.id);
    rejectOld(new Error('stale archive failure fixture'));
    check('late archive failure cannot overwrite a newer selected-room result', await page(async () => {
      await window.historyPendingFixture; delete window.historyPendingFixture;
      const list = document.querySelector('#histArchiveList');
      return list.textContent.includes('History search fixture') && !list.textContent.includes('Later healthy archive fixture') && !list.querySelector('.history-archive-warning');
    }));
  } finally { persistence.listArchives = listArchives; }
  check('history room search filters active rooms and safely resets unmatched selection', await page(async (roomId, archivedId) => {
    const search = document.querySelector('#histRoomSearch'), select = document.querySelector('#histRoom');
    search.value = 'History search fixture'; search.dispatchEvent(new Event('input'));
    const filtered = select.options.length === 2 && select.options[1].value === roomId;
    select.value = roomId; await renderHistory();
    const enabled = !document.querySelector('#histClear').disabled;
    search.value = 'Archived room fixture'; search.dispatchEvent(new Event('input'));
    const archived = select.options.length === 1 && ![...select.options].some(option => option.value === archivedId);
    const reset = select.value === '' && document.querySelector('#histClear').disabled;
    search.value = ''; search.dispatchEvent(new Event('input')); await renderHistory();
    return filtered && enabled && archived && reset;
  }, room.id, archivedRoom.id));
  check('all-room action handlers reject synthetic clicks without asking or writing', await page(async () => {
    const confirm = AppDialog.confirm; let calls = 0;
    AppDialog.confirm = async () => { calls++; return false; };
    try {
      for (const id of ['histArchive', 'histClear', 'histExport']) document.getElementById(id).dispatchEvent(new Event('click'));
      await new Promise(resolve => setTimeout(resolve, 50)); return calls === 0;
    } finally { AppDialog.confirm = confirm; }
  }));
  check('history search reuses archive worker and opens exact archived message', await page(async messageId => {
    document.querySelector('#histSearch').click();
    const dialog = document.querySelector('#conversationSearchDialog'), input = dialog.querySelector('input');
    input.value = 'unique-history-search-fixture'; input.dispatchEvent(new Event('input'));
    for (let i = 0; i < 150 && !dialog.querySelector('.conversation-search-result'); i++) await new Promise(resolve => setTimeout(resolve, 20));
    const result = dialog.querySelector('.conversation-search-result'); if (!result) return false;
    result.click();
    for (let i = 0; i < 100 && document.querySelector('#archiveViewerModal').hidden; i++) await new Promise(resolve => setTimeout(resolve, 20));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const target = document.querySelector(`[data-archive-message-id="${messageId}"]`);
    const good = !dialog.open && !document.querySelector('#archiveViewerModal').hidden && target?.classList.contains('message-search-target');
    closeAllModals(); return good;
  }, message.id));
  check('about executable is full read-only selectable wrapping text', await page(() => {
    openSettings('about');
    const el = document.querySelector('#aboutExecutable');
    const good = el.tagName === 'DIV' && !el.isContentEditable && el.textContent.length > 0 && getComputedStyle(el).overflowWrap === 'anywhere'
      && el.scrollWidth <= el.clientWidth + 1;
    closeAllModals(); return good;
  }));
  check('history added UI translates to English without changing room names', await page(async () => {
    I18n.setLanguage('en'); openSettings('history'); await loadHistoryTab();
    const good = document.querySelector('#histRoomSearch').placeholder === 'Search room names'
      && document.querySelector('#histRoom').options[0].textContent === 'All rooms'
      && document.querySelector('#histSearch').textContent === 'Search all rooms and archives'
      && document.querySelector('#histArchiveList').textContent.includes('History search fixture');
    I18n.setLanguage('zh-CN'); closeAllModals(); return good;
  }));
};
