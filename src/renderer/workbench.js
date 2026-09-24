'use strict';

// The workbench owns pane layout and ephemeral tool tabs. Existing room/chat
// state remains owned by the chat modules; terminals and browser sessions live
// only until their tab closes or the application exits.
window.WorkbenchUI = (() => {
  const tabs = new Map(), selected = new Map(), bottomSelected = new Map();
  let layout = { sidebarWidth: 236, dockWidth: 430, bottomHeight: 240, sidebarCollapsed: false, dockOpen: false, bottomOpen: false, dockMaximized: false };
  let area, top, dock, body, bottom, sidePane, initialized = false, saveTimer, frame, lastScope, menu;
  const node = (tag, className, text) => { const item = document.createElement(tag); if (className) item.className = className; if (text != null) I18n.label(item, text); return item; };
  const byId = id => document.getElementById(id);
  const findRoom = id => state.rooms.find(room => room.id === id);
  const projectKey = room => String(room?.cwd || state.settings.defaultCwd || state.defaultCwd || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const scope = () => currentRoom()?.id || '';
  const request = (operation, payload = {}) => window.api.workbench({ ...payload, operation });
  const icons = {
    sidebar: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/>',
    dock: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M15 4v16"/>',
    terminal: '<path d="m5 7 4 4-4 4m7 0h7"/><rect x="2" y="3" width="20" height="18" rx="3"/>',
    expand: '<path d="M14 4h6v6m0-6-7 7M10 20H4v-6m0 6 7-7"/>',
    plus: '<path d="M12 5v14M5 12h14"/>', close: '<path d="m6 6 12 12M6 18 18 6"/>',
    file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6"/>',
    browser: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18"/>',
    chat: '<path d="M21 11a9 9 0 0 1-9 9 10 10 0 0 1-4-.8L3 21l1.8-5A9 9 0 1 1 21 11Z"/>',
    changes: '<path d="M6 4v13m12-10v13M6 9c7 0 12-3 12-5"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="4" r="2"/>',
    agent: '<rect x="5" y="7" width="14" height="13" rx="4"/><path d="M12 3v4M9 12h.1M15 12h.1M9 16h6"/>',
  };
  function symbol(name) { const span = node('span', 'wb-icon'); span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.file}</svg>`; return span; }
  function button(label, icon, callback, className = 'wb-button') {
    const result = node('button', className); result.type = 'button'; I18n.label(result, label, 'title'); I18n.attr(result, 'aria-label', () => label);
    if (icon) result.append(symbol(icon)); else I18n.label(result, label);
    result.addEventListener('click', event => { Promise.resolve(callback(event)).catch(showError); }); return result;
  }
  function showError(error) { return AppDialog.alert(error?.message || String(error)); }
  function saveLayout() { clearTimeout(saveTimer); saveTimer = setTimeout(() => request('layout:save', { layout }).catch(showError), 180); }
  function active(location = 'side') { return tabs.get((location === 'bottom' ? bottomSelected : selected).get(scope())); }
  function owned(location) { return [...tabs.values()].filter(tab => tab.scope === scope() && tab.location === location); }

  async function init() {
    if (initialized || !byId('sideChatPane') || !window.api.workbench) return;
    initialized = true; sidePane = byId('sideChatPane');
    area = node('section', 'wb-area'); area.id = 'workbenchArea';
    top = node('div', 'wb-top'); top.id = 'workbenchTop';
    const main = byId('main'); main.before(area); top.append(main); area.append(top);
    dock = node('aside', 'wb-dock'); dock.id = 'workbenchDock'; I18n.attr(dock, 'aria-label', () => I18n.t('侧边工作台'));
    const heading = node('header', 'wb-tab-header'); const tabStrip = node('div', 'wb-tabs'); tabStrip.id = 'workbenchTabs'; tabStrip.setAttribute('role', 'tablist');
    heading.append(tabStrip, button(I18n.live(() => I18n.t('新建标签')), 'plus', event => openMenu(event.currentTarget)), button(I18n.live(() => I18n.t('收起侧边工作台')), 'close', () => toggleDock(false)));
    body = node('div', 'wb-body'); body.id = 'workbenchBody'; body.append(sidePane);
    dock.append(heading, body);
    top.append(splitter('dockWidth', 'vertical', -1), dock);
    bottom = node('section', 'wb-bottom'); bottom.id = 'workbenchBottom'; I18n.attr(bottom, 'aria-label', () => I18n.t('底部终端'));
    const bottomHead = node('header', 'wb-tab-header'); const bottomTabs = node('div', 'wb-tabs'); bottomTabs.id = 'workbenchBottomTabs'; bottomTabs.setAttribute('role', 'tablist');
    bottomHead.append(bottomTabs, button(I18n.live(() => I18n.t('新建底部终端')), 'plus', () => openTerminal('bottom')), button(I18n.live(() => I18n.t('收起底部终端')), 'close', () => toggleBottom(false)));
    bottom.append(bottomHead, node('div', 'wb-bottom-body')); area.append(splitter('bottomHeight', 'horizontal', -1), bottom);
    byId('sidebar').after(splitter('sidebarWidth', 'vertical', 1));
    const sidebarToggle = button(I18n.live(() => I18n.t('收起或展开左侧栏')), 'sidebar', () => { layout.sidebarCollapsed = !layout.sidebarCollapsed; render(); saveLayout(); });
    sidebarToggle.id = 'workbenchSidebarToggle'; byId('topbar').prepend(sidebarToggle);
    const controls = node('div', 'wb-controls'); controls.id = 'workbenchControls';
    const maximize = button(I18n.live(() => I18n.t('放大或还原侧边工作台')), 'expand', () => { layout.dockOpen = true; layout.dockMaximized = !layout.dockMaximized; render(); saveLayout(); }); maximize.id = 'workbenchMaximize';
    const terminal = button(I18n.live(() => I18n.t('打开或收起底部终端')), 'terminal', () => toggleBottom()); terminal.id = 'workbenchTerminalToggle';
    const toggle = button(I18n.live(() => I18n.t('打开或收起侧边工作台')), 'dock', () => toggleDock()); toggle.id = 'workbenchDockToggle';
    heading.insertBefore(maximize, tabStrip.nextSibling);
    controls.append(terminal, toggle); byId('topbar').append(controls);
    const preview = node('div', 'wb-main-preview'); preview.id = 'workbenchMainPreview';
    const previewToggle = button(I18n.live(() => I18n.t('查看主会话')), 'chat', () => {
      const open = byId('main').classList.toggle('wb-preview-open'); previewToggle.setAttribute('aria-expanded', String(open));
    }); previewToggle.id = 'workbenchPreviewToggle'; previewToggle.setAttribute('aria-expanded', 'false');
    preview.append(previewToggle, node('span', 'wb-preview-title'));
    top.prepend(preview);
    const previewClose = button(I18n.live(() => I18n.t('收起主会话预览')), 'close', () => { byId('main').classList.remove('wb-preview-open'); previewToggle.setAttribute('aria-expanded', 'false'); }); previewClose.id = 'workbenchPreviewClose'; byId('topbar').append(previewClose);
    menu = node('div', 'wb-new-menu'); menu.hidden = true; menu.id = 'workbenchNewMenu'; menu.setAttribute('role', 'menu'); document.body.append(menu);
    document.addEventListener('pointerdown', event => { if (!menu.hidden && !menu.contains(event.target) && !event.target.closest('#workbenchDock .wb-tab-header')) closeMenu(); });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') closeMenu();
      if ((event.ctrlKey || event.metaKey) && event.key === '`') { event.preventDefault(); toggleBottom().catch(showError); }
      if ((event.ctrlKey || event.metaKey) && event.altKey && event.key.toLowerCase() === 'b') { event.preventDefault(); layout.sidebarCollapsed = !layout.sidebarCollapsed; render(); saveLayout(); }
    });
    window.api.onWorkbench(handleEvent);
    const observer = new ResizeObserver(scheduleBounds); observer.observe(area); observer.observe(byId('sidebar'));
    new MutationObserver(scheduleBounds).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['hidden', 'open', 'class'] });
    window.addEventListener('resize', () => { render(); scheduleBounds(); });
    document.addEventListener('visibilitychange', scheduleBounds);
    try { layout = { ...layout, ...await request('layout:get') }; } catch (error) { showError(error); }
    sync();
  }

  function splitter(key, orientation, direction) {
    const result = node('div', `wb-splitter wb-splitter-${orientation}`); result.dataset.size = key;
    result.tabIndex = 0; result.setAttribute('role', 'separator'); result.setAttribute('aria-orientation', orientation);
    I18n.attr(result, 'aria-label', () => ({ sidebarWidth: I18n.t('调整左侧栏宽度'), dockWidth: I18n.t('调整侧边工作台宽度'), bottomHeight: I18n.t('调整底部终端高度') })[key]);
    let drag;
    const apply = value => { layout[key] = clampSize(key, value); render(); };
    result.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault(); drag = { start: orientation === 'vertical' ? event.clientX : event.clientY, value: layout[key] };
      result.setPointerCapture(event.pointerId); document.body.classList.add('wb-resizing'); scheduleBounds();
    });
    result.addEventListener('pointermove', event => { if (drag) apply(drag.value + direction * ((orientation === 'vertical' ? event.clientX : event.clientY) - drag.start)); });
    const stop = () => { if (!drag) return; drag = null; document.body.classList.remove('wb-resizing'); saveLayout(); scheduleBounds(); };
    result.addEventListener('pointerup', stop); result.addEventListener('lostpointercapture', stop); result.addEventListener('pointercancel', stop);
    result.addEventListener('keydown', event => {
      const delta = { ArrowLeft: -16, ArrowRight: 16, ArrowUp: -16, ArrowDown: 16 }[event.key];
      if (delta == null) return; event.preventDefault(); apply(layout[key] + delta * direction); saveLayout();
    });
    return result;
  }

  function clampSize(key, value) {
    const width = window.innerWidth, height = window.innerHeight;
    if (key === 'sidebarWidth') return Math.max(160, Math.min(480, width - (layout.dockOpen && !layout.dockMaximized ? 580 : 380), value));
    if (key === 'dockWidth') return Math.max(280, Math.min(1400, width - (layout.sidebarCollapsed ? 0 : clampSize('sidebarWidth', layout.sidebarWidth)) - 280, value));
    return Math.max(120, Math.min(900, height - 280, value));
  }

  function render() {
    if (!initialized) return;
    const app = byId('app');
    app.classList.add('has-workbench'); app.classList.toggle('wb-sidebar-collapsed', layout.sidebarCollapsed);
    app.classList.toggle('wb-dock-open', layout.dockOpen); app.classList.toggle('wb-bottom-open', layout.bottomOpen);
    app.classList.toggle('wb-dock-maximized', layout.dockOpen && layout.dockMaximized);
    app.style.setProperty('--wb-sidebar-width', `${clampSize('sidebarWidth', layout.sidebarWidth)}px`);
    app.style.setProperty('--wb-dock-width', `${clampSize('dockWidth', layout.dockWidth)}px`);
    app.style.setProperty('--wb-bottom-height', `${clampSize('bottomHeight', layout.bottomHeight)}px`);
    dock.hidden = !layout.dockOpen; bottom.hidden = !layout.bottomOpen;
    byId('workbenchSidebarToggle').setAttribute('aria-expanded', String(!layout.sidebarCollapsed));
    byId('workbenchDockToggle').setAttribute('aria-expanded', String(layout.dockOpen));
    byId('workbenchTerminalToggle').setAttribute('aria-expanded', String(layout.bottomOpen));
    byId('workbenchMaximize').setAttribute('aria-pressed', String(layout.dockMaximized));
    I18n.write(byId('workbenchMainPreview').querySelector('.wb-preview-title'), () => currentRoom()?.name || I18n.t('主会话'));
    const controlHost = layout.dockOpen && layout.dockMaximized ? byId('workbenchMainPreview') : byId('topbar');
    if (byId('workbenchControls').parentElement !== controlHost) controlHost.append(byId('workbenchControls'));
    const chosen = active(); dock.dataset.kind = chosen?.kind || 'empty';
    renderTabs('side'); renderTabs('bottom');
    for (const tab of tabs.values()) {
      if (tab.element) tab.element.hidden = tab.scope !== scope() || active(tab.location)?.id !== tab.id;
    }
    if (chosen?.kind === 'chat') {
      if (SideChatUI.getRoom()?.id !== chosen.roomId) SideChatUI.open(chosen.roomId);
    }
    renderEmpty('side'); renderEmpty('bottom'); scheduleBounds();
  }

  function renderTabs(location) {
    const list = byId(location === 'bottom' ? 'workbenchBottomTabs' : 'workbenchTabs'); const scroll = list.scrollLeft; list.replaceChildren();
    for (const tab of owned(location)) {
      const item = node('div', 'wb-tab' + (active(location)?.id === tab.id ? ' active' : ''));
      const choose = button(tab.title, null, () => select(tab.id), 'wb-tab-select'); choose.setAttribute('role', 'tab');
      choose.setAttribute('aria-selected', String(active(location)?.id === tab.id)); choose.title = tab.path || tab.title;
      choose.replaceChildren(symbol(tab.kind === 'files' ? 'file' : tab.kind), node('span', '', tab.title));
      const close = button(I18n.live(() => I18n.tpl`关闭 ${tab.title}`), 'close', () => closeTab(tab.id), 'wb-tab-close');
      item.append(choose, close); list.append(item);
    }
    list.scrollLeft = scroll;
  }

  function renderEmpty(location) {
    const host = location === 'bottom' ? bottom.querySelector('.wb-bottom-body') : body;
    let empty = host.querySelector(':scope > .wb-empty');
    if (!empty) {
      empty = node('div', 'wb-empty'); host.append(empty);
      if (location === 'bottom') {
        const launch = button(I18n.live(() => I18n.t('新建终端')), 'terminal', () => openTerminal('bottom'), 'wb-launch');
        launch.append(node('span', '', I18n.live(() => I18n.t('新建终端')))); empty.append(launch);
      }
      else for (const [kind, title] of [['files', I18n.live(() => I18n.t('项目文件'))], ['chat', I18n.live(() => I18n.t('侧边聊天'))], ['browser', I18n.live(() => I18n.t('浏览器'))], ['terminal', I18n.live(() => I18n.t('终端'))], ['changes', I18n.live(() => I18n.t('修改的文件'))]]) {
        const launch = button(title, kind === 'files' ? 'file' : kind, () => openKind(kind), 'wb-launch'); launch.append(node('span', '', title)); empty.append(launch);
      }
    }
    empty.hidden = !!active(location);
  }

  function addTab(kind, title, location = 'side', options = {}) {
    if (!scope()) throw new Error(I18n.t('请先选择房间'));
    if (tabs.size >= 24) throw new Error(I18n.t('最多打开 24 个工作台标签，请先关闭不再使用的标签'));
    const id = `wb-${crypto.randomUUID()}`;
    const tab = { id, kind, title, location, scope: scope(), roomId: scope(), projectKey: projectKey(currentRoom()), ...options };
    tabs.set(id, tab);
    if (kind !== 'chat') { tab.element = node('section', `wb-content wb-${kind}`); tab.element.dataset.tabId = id; (location === 'bottom' ? bottom.querySelector('.wb-bottom-body') : body).append(tab.element); }
    select(id); return tab;
  }

  function select(id) {
    const tab = tabs.get(id); if (!tab || tab.scope !== scope()) return;
    (tab.location === 'bottom' ? bottomSelected : selected).set(scope(), id);
    if (tab.location === 'bottom') layout.bottomOpen = true; else layout.dockOpen = true;
    render(); saveLayout();
    if (tab.term) requestAnimationFrame(() => { tab.fit.fit(); tab.term.focus(); });
  }

  async function closeTab(id) {
    const tab = tabs.get(id); if (!tab) return;
    tabs.delete(id); tab.closed = true; tab.version = (tab.version || 0) + 1;
    const map = tab.location === 'bottom' ? bottomSelected : selected;
    if (map.get(tab.scope) === id) map.set(tab.scope, [...tabs.values()].find(item => item.scope === tab.scope && item.location === tab.location)?.id);
    tab.element?.remove();
    if (tab.kind === 'chat' && SideChatUI.getRoom()?.id === tab.roomId) SideChatUI.close();
    render();
    if (tab.kind === 'terminal') { tab.term?.dispose(); await request('terminal:close', { id }); }
    if (tab.kind === 'browser') await request('browser:close', { id });
  }

  function toggleDock(value = !layout.dockOpen) { layout.dockOpen = value; if (!value) byId('main').classList.remove('wb-preview-open'); render(); saveLayout(); }
  async function toggleBottom(value = !layout.bottomOpen) {
    layout.bottomOpen = value; render(); saveLayout();
    if (value && !owned('bottom').length) await openTerminal('bottom');
  }
  function closeMenu() { if (menu) { menu.hidden = true; scheduleBounds(); } }
  function openMenu(anchor) {
    menu.replaceChildren();
    for (const [kind, title] of [['files', I18n.live(() => I18n.t('项目文件'))], ['chat', I18n.live(() => I18n.t('侧边聊天'))], ['browser', I18n.live(() => I18n.t('浏览器'))], ['terminal', I18n.live(() => I18n.t('终端'))], ['changes', I18n.live(() => I18n.t('修改的文件'))]]) {
      const item = button(title, kind === 'files' ? 'file' : kind, () => { closeMenu(); return openKind(kind); }, 'wb-menu-item');
      item.append(node('span', '', title)); item.setAttribute('role', 'menuitem'); menu.append(item);
    }
    const bounds = anchor.getBoundingClientRect(); menu.style.right = `${Math.max(8, innerWidth - bounds.right)}px`; menu.style.top = `${bounds.bottom + 6}px`;
    menu.hidden = false; menu.querySelector('button')?.focus(); scheduleBounds();
  }
  function openKind(kind) {
    if (kind === 'chat') return SideChatUI.create(scope());
    if (kind === 'terminal') return openTerminal('side');
    if (kind === 'browser') return openBrowser();
    return openFiles(kind === 'changes');
  }

  async function openTerminal(location = 'side') {
    if (!window.Terminal || !window.FitAddon) throw new Error(I18n.t('终端组件未加载，请检查应用安装是否完整'));
    const tab = addTab('terminal', I18n.live(() => I18n.t('终端')), location);
    const status = node('div', 'wb-terminal-status', I18n.live(() => I18n.t('正在启动终端…'))); const host = node('div', 'wb-terminal-host');
    tab.element.append(status, host); tab.status = status;
    tab.term = new window.Terminal({ cursorBlink: true, scrollback: 3000, fontSize: 13, fontFamily: 'Cascadia Mono, Consolas, monospace',
      theme: terminalTheme(), allowProposedApi: false });
    tab.fit = new window.FitAddon.FitAddon(); tab.term.loadAddon(tab.fit); tab.term.open(host); tab.fit.fit();
    tab.term.onData(data => {
      for (let index = 0; index < data.length; index += 65536) request('terminal:write', { id: tab.id, data: data.slice(index, index + 65536) }).catch(error => { status.textContent = error.message; });
    });
    tab.term.onResize(size => { if (tab.ready) request('terminal:resize', { id: tab.id, ...size }).catch(error => { status.textContent = error.message; }); });
    try {
      const result = await request('terminal:create', { id: tab.id, roomId: tab.roomId, cols: tab.term.cols, rows: tab.term.rows });
      if (tab.closed) { await request('terminal:close', { id: tab.id }); return; }
      tab.ready = true; tab.title = result.name; status.textContent = result.cwd; status.title = result.cwd;
      await request('terminal:ready', { id: tab.id }); render(); tab.term.focus();
    } catch (error) { if (!tab.closed) { I18n.write(status, () => I18n.tpl`终端启动失败：${error.message}`); tab.term.writeln(I18n.t('\r\n请关闭此标签后重试。')); } }
    return tab.id;
  }
  function terminalTheme() {
    const style = getComputedStyle(document.documentElement);
    return { background: style.getPropertyValue('--bg').trim() || '#f7f7f8', foreground: style.getPropertyValue('--text').trim() || '#1f2329',
      cursor: style.getPropertyValue('--accent').trim() || '#2563eb', selectionBackground: '#7f9ccc55' };
  }

  async function openBrowser() {
    const tab = addTab('browser', I18n.live(() => I18n.t('浏览器')));
    const bar = node('form', 'wb-browser-bar'); const back = button(I18n.live(() => I18n.t('后退')), null, () => request('browser:action', { id: tab.id, action: 'back' })); back.textContent = '←';
    const forward = button(I18n.live(() => I18n.t('前进')), null, () => request('browser:action', { id: tab.id, action: 'forward' })); forward.textContent = '→';
    const reload = button(I18n.live(() => I18n.t('刷新页面')), null, () => request('browser:action', { id: tab.id, action: tab.loading ? 'stop' : 'reload' })); reload.textContent = '↻';
    const address = node('input', 'wb-browser-address'); address.type = 'url'; I18n.write(address, () => I18n.t('输入 https:// 网址'), 'placeholder'); I18n.attr(address, 'aria-label', () => I18n.t('浏览器网址'));
    const external = button(I18n.live(() => I18n.t('在系统浏览器打开')), null, () => request('browser:external', { url: address.value })); external.textContent = '↗';
    bar.append(back, forward, reload, address, external);
    const notice = node('div', 'wb-browser-notice', I18n.live(() => I18n.t('独立浏览器 · 输入网址开始浏览')));
    const viewport = node('div', 'wb-browser-viewport'); I18n.attr(viewport, 'aria-label', () => I18n.t('网页内容'));
    tab.element.append(bar, notice, viewport); Object.assign(tab, { address, notice, viewport, back, forward, reload });
    bar.addEventListener('submit', event => {
      event.preventDefault(); tab.hasUrl = true;
      request('browser:navigate', { id: tab.id, url: address.value }).catch(error => { notice.textContent = error.message; }); scheduleBounds();
    });
    try { await request('browser:create', { id: tab.id }); tab.ready = true; if (tab.closed) await request('browser:close', { id: tab.id }); else { scheduleBounds(); address.focus(); } }
    catch (error) { I18n.write(notice, () => I18n.tpl`浏览器启动失败：${error.message}`); }
    return tab.id;
  }

  async function openFiles(changesOnly = false) {
    const tab = addTab(changesOnly ? 'changes' : 'files', I18n.live(() => changesOnly ? I18n.t('修改的文件') : I18n.t('项目文件')));
    const toolbar = node('div', 'wb-file-toolbar');
    const pathLabel = node('span', 'wb-path-label', I18n.live(() => I18n.t('项目目录'))); const refresh = button(I18n.live(() => I18n.t('刷新')), null, () => loadFiles(tab));
    toolbar.append(pathLabel, refresh, button(I18n.live(() => I18n.t('选择文件')), null, async () => { const file = await request('files:pick', { roomId: tab.roomId }); if (file && !tab.closed) await displayFile(tab, file.path); }));
    const list = node('div', 'wb-file-list'); const content = node('div', 'wb-file-content');
    tab.element.append(toolbar, list, content); Object.assign(tab, { pathLabel, list, content, directory: '.', changesOnly });
    await loadFiles(tab); return tab.id;
  }

  async function openActivityFile(roomId, path) {
    if (!initialized || !findRoom(roomId)) return;
    const tab = addTab('files', I18n.live(() => path.split(/[\\/]/).pop() || I18n.t('被编辑文件')), 'side', { roomId, scope: findRoom(roomId).parentRoomId || roomId });
    tab.content = node('div', 'wb-file-content'); tab.element.append(tab.content);
    // Existing IPC resolves real paths and confines reads to this room's project.
    await displayFile(tab, path);
    return tab.id;
  }

  async function loadFiles(tab) {
    const generation = tab.version = (tab.version || 0) + 1;
    I18n.write(tab.list, () => I18n.t('正在读取…'));
    try {
      const result = await request(tab.changesOnly ? 'files:changes' : 'files:list', { roomId: tab.roomId, path: tab.directory });
      if (tab.closed || generation !== tab.version) return;
      tab.pathLabel.textContent = result.path || result.cwd; tab.pathLabel.title = result.cwd; tab.list.replaceChildren();
      if (!tab.changesOnly && result.path) {
        const parent = result.path.split(/[\\/]/).slice(0, -1).join('/');
        tab.list.append(button(I18n.live(() => I18n.t('↑ 上一级')), null, () => { tab.directory = parent || '.'; return loadFiles(tab); }, 'wb-file-entry'));
      }
      for (const item of result.entries) {
        const label = `${item.directory ? '▱ ' : ''}${item.name || item.path}${item.status ? ` · ${item.status.trim()}` : ''}`;
        const entry = button(label, null, () => {
          if (item.directory) { tab.directory = item.path; return loadFiles(tab); }
          return displayFile(tab, item.path, tab.changesOnly);
        }, 'wb-file-entry'); entry.title = item.path; tab.list.append(entry);
      }
      if (!result.entries.length) tab.list.append(node('p', 'hint', I18n.live(() => tab.changesOnly ? I18n.t('当前项目没有未提交修改。') : I18n.t('此目录为空。'))));
      if (result.truncated) tab.list.append(node('p', 'hint', I18n.live(() => I18n.t('条目较多，当前显示部分结果；可进入子目录继续查看。'))));
    } catch (error) { if (!tab.closed && generation === tab.version) tab.list.textContent = error.message; }
  }

  async function displayFile(tab, path, diff = false) {
    const generation = tab.fileVersion = (tab.fileVersion || 0) + 1;
    I18n.write(tab.content, () => I18n.t('正在读取文件…')); tab.path = path;
    try {
      const result = await request(diff ? 'files:diff' : 'files:read', { roomId: tab.roomId, path });
      if (tab.closed || generation !== tab.fileVersion) return;
      tab.content.replaceChildren();
      const actions = node('div', 'wb-file-actions'); actions.append(node('strong', '', path));
      const selectOpen = node('select', 'wb-open-select'); I18n.attr(selectOpen, 'aria-label', () => I18n.t('打开文件的方式'));
      for (const [value, title] of [['', I18n.live(() => I18n.t('打开…'))], ['default', I18n.live(() => I18n.t('默认应用'))], ['choose', I18n.live(() => I18n.t('选择应用…'))], ['reveal', I18n.live(() => I18n.t('打开所在文件夹'))]]) { const option = node('option', '', title); option.value = value; selectOpen.append(option); }
      selectOpen.addEventListener('change', () => { const action = selectOpen.value; selectOpen.value = ''; if (action) request('files:open', { roomId: tab.roomId, path, action }).catch(showError); });
      actions.append(selectOpen);
      if (!diff) actions.append(button(I18n.live(() => I18n.t('查看差异')), null, () => displayFile(tab, path, true)));
      else actions.append(button(I18n.live(() => I18n.t('查看文件')), null, () => displayFile(tab, path, false)));
      const text = node('pre', diff ? 'wb-code wb-diff' : 'wb-code');
      if (diff) {
        const lines = result.text.split('\n');
        for (const line of lines.slice(0, 10000)) { const row = node('div', line.startsWith('+') ? 'wb-line-add' : line.startsWith('-') ? 'wb-line-remove' : line.startsWith('@@') ? 'wb-line-hunk' : '', line || ' '); text.append(row); }
        if (lines.length > 10000) text.append(node('p', 'hint', I18n.live(() => I18n.t('差异超过 10,000 行，当前显示前 10,000 行；请使用外部应用继续审阅。'))));
      }
      else text.textContent = result.text;
      tab.content.append(actions, text);
    } catch (error) {
      if (tab.closed || generation !== tab.fileVersion) return;
      tab.content.replaceChildren(node('p', 'wb-notice', error.message), button(I18n.live(() => I18n.t('使用默认应用打开')), null, () => request('files:open', { roomId: tab.roomId, path, action: 'default' })));
    }
  }

  function chatOpened(roomId) {
    if (!initialized) return;
    const room = findRoom(roomId); if (!room) return;
    let tab = [...tabs.values()].find(item => item.kind === 'chat' && item.roomId === roomId);
    if (!tab) tab = addTab('chat', room.name, 'side', { roomId, scope: room.parentRoomId || scope() });
    else select(tab.id);
  }
  function chatClosed(roomId) {
    const tab = [...tabs.values()].find(item => item.kind === 'chat' && item.roomId === roomId);
    if (tab) { tabs.delete(tab.id); selected.delete(tab.scope); render(); }
  }

  function openAgentDetail(payload) {
    const existing = [...tabs.values()].find(tab => tab.kind === 'agent' && tab.payload?.activity?.id === payload.activity.id && tab.payload.roomId === payload.roomId);
    const tab = existing || addTab('agent', I18n.live(() => payload.activity.name || I18n.t('子代理'))); tab.payload = payload;
    paintAgent(tab); select(tab.id); return tab.id;
  }
  function paintAgent(tab) {
    const { activity, botName } = tab.payload, info = activity.subagent || {};
    I18n.write(tab, () => activity.name || I18n.t('子代理'), 'title'); tab.element.replaceChildren();
    const heading = node('header', 'wb-agent-heading'); heading.append(symbol('agent'), node('h3', '', tab.title));
    const status = { running: I18n.t('运行中'), done: I18n.t('已完成'), error: I18n.t('执行失败'), aborted: I18n.t('已停止') }[activity.status] || activity.status || '';
    heading.append(node('span', 'wb-agent-status', status));
    const details = node('dl', 'wb-agent-meta');
    for (const [label, value] of [[I18n.t('派发成员'), botName], ['Agent', info.cliType], [I18n.t('模型'), info.model], [I18n.t('推理程度'), info.reasoningEffort], [I18n.t('子代理'), info.agentId], [I18n.t('父代理'), info.parentAgentId]]) {
      if (value) details.append(node('dt', '', label), node('dd', '', value));
    }
    tab.element.append(heading, details, node('h4', '', I18n.live(() => I18n.t('任务'))), node('pre', 'wb-agent-text', I18n.live(() => info.task || activity.summary || I18n.t('原生 Agent 尚未返回任务正文'))),
      node('h4', '', I18n.live(() => I18n.t('输出'))), node('pre', 'wb-agent-text', I18n.live(() => info.output || activity.detail || I18n.t('等待原生 Agent 返回输出…'))));
    if (info.outputTruncated) tab.element.append(node('p', 'hint', I18n.live(() => I18n.t('输出较长，当前显示原生事件已提供的部分内容。'))));
  }
  function refreshAgentDetails() {
    for (const tab of tabs.values()) {
      if (tab.kind !== 'agent') continue;
      const message = (state.dataByRoom[tab.payload.roomId] || []).find(item => item.id === tab.payload.messageId);
      const activity = message?.activities?.find(item => item.id === tab.payload.activity.id);
      if (activity) { tab.payload.activity = activity; paintAgent(tab); }
    }
  }

  function handleEvent(event) {
    const tab = tabs.get(event.id); if (!tab) return;
    if (event.kind === 'terminal-data') tab.term.write(event.data, () => request('terminal:ack', { id: tab.id, length: event.data.length }).catch(() => {}));
    if (event.kind === 'terminal-exit') { tab.ready = false; I18n.write(tab.status, () => I18n.tpl`终端已退出 · 状态 ${event.exitCode}`); tab.term.writeln(I18n.tpl`\r\n[进程已退出：${event.exitCode}]`); }
    if (event.kind === 'browser-state') {
      tab.loading = event.loading;
      if (document.activeElement !== tab.address && event.url) tab.address.value = event.url;
      I18n.write(tab, () => event.title || I18n.t('浏览器'), 'title'); I18n.write(tab.notice, () => event.error || (event.loading ? I18n.t('正在加载…') : event.url || I18n.t('输入网址开始浏览')));
      tab.back.disabled = !event.canBack; tab.forward.disabled = !event.canForward; tab.reload.textContent = event.loading ? '×' : '↻';
      renderTabs('side'); scheduleBounds();
    }
  }

  function scheduleBounds() {
    if (frame || !initialized) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      const covered = document.hidden || !!document.querySelector('.modal-backdrop:not([hidden]), dialog[open], #popMenu:not([hidden]), #workbenchNewMenu:not([hidden])') || document.body.classList.contains('wb-resizing') || byId('main').classList.contains('wb-preview-open');
      for (const tab of tabs.values()) {
        if (tab.kind === 'terminal' && tab.term && !tab.element.hidden && (tab.location === 'bottom' ? layout.bottomOpen : layout.dockOpen)) {
          tab.term.options.theme = terminalTheme(); try { tab.fit.fit(); } catch { /* Closing a terminal disposes its renderer before queued layout frames. */ }
        }
        if (tab.kind !== 'browser' || !tab.ready) continue;
        const rect = tab.viewport.getBoundingClientRect();
        const visible = !covered && tab.hasUrl && tab.scope === scope() && active()?.id === tab.id && layout.dockOpen;
        const bounds = { x: rect.x, y: rect.y, width: rect.width, height: rect.height, visible: !!visible };
        const key = JSON.stringify(bounds); if (tab.lastBounds === key) continue; tab.lastBounds = key;
        request('browser:bounds', { id: tab.id, ...bounds }).catch(error => { if (!tab.closed) tab.notice.textContent = error.message; });
      }
    });
  }

  function sync() {
    if (!initialized) return;
    if (lastScope !== scope()) { lastScope = scope(); byId('main').classList.remove('wb-preview-open'); }
    for (const tab of [...tabs.values()]) {
      const room = findRoom(tab.roomId);
      if (!room || room.archivedAt) { closeTab(tab.id).catch(showError); continue; }
      if (['files', 'changes', 'terminal', 'browser'].includes(tab.kind) && tab.projectKey !== projectKey(room)) { closeTab(tab.id).catch(showError); continue; }
      if (tab.kind === 'chat') tab.title = room.name;
    }
    render(); refreshAgentDetails();
  }
  function showConversation(roomId) {
    if (!initialized) return;
    if (roomId === state.currentRoomId && layout.dockMaximized && layout.dockOpen) {
      byId('main').classList.add('wb-preview-open'); byId('workbenchPreviewToggle').setAttribute('aria-expanded', 'true'); scheduleBounds();
    }
  }
  return { init, sync, chatOpened, chatClosed, openAgentDetail, refreshAgentDetails, openTerminal, openBrowser, openFiles, openActivityFile, closeTab, toggleDock, toggleBottom, showConversation };
})();
window.WorkBenchUI = window.WorkbenchUI;
