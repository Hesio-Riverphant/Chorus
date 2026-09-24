'use strict';

const NativeCapabilitiesUI = (() => {
  let managementGeneration = 0;
  const $ = id => document.getElementById(id);
  const copy = value => JSON.parse(JSON.stringify(value));
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function defaults() { return { mode: 'inherit', mcp: [], plugins: [] }; }
  function inherited(items) {
    return { mode: 'selected', mcp: items.filter(item => item.kind === 'mcp' && item.enabled && item.selectable !== false).map(item => item.id),
      plugins: items.filter(item => item.kind === 'plugin' && item.enabled).map(item => item.id) };
  }
  function checked(item, choice) {
    if (choice.mode === 'inherit') return item.enabled;
    if (item.pluginId) return choice.plugins.includes(item.pluginId);
    return choice[item.kind === 'plugin' ? 'plugins' : 'mcp'].includes(item.id);
  }
  function renderList(host, items, choice, onChange) {
    const missing = choice.mode === 'selected' ? ['mcp', 'plugins'].flatMap(key => choice[key]
      .filter(id => !items.some(item => item.id === id && item.kind === (key === 'plugins' ? 'plugin' : 'mcp')))
      .map(id => ({ id, name: id, kind: key === 'plugins' ? 'plugin' : 'mcp', missing: true }))) : [];
    const displayed = [...items, ...missing];
    host.innerHTML = ['plugin', 'mcp'].map(kind => {
      const entries = displayed.filter(item => item.kind === kind);
      if (!entries.length) return '';
      return `<section class="native-capability-group"><h4>${kind === 'plugin' ? I18n.t('插件') : 'MCP'}</h4>${entries.map(item => {
        const key = kind === 'plugin' ? 'plugins' : 'mcp';
        const unavailable = item.enableSupported === false;
        const status = item.missing ? I18n.t('暂不在清单中；会提示并继续回答，可更新清单或取消选择') : item.pluginId ? I18n.tpl`跟随插件 ${item.pluginId.split('@')[0]}` : unavailable ? I18n.t('原生已禁用；可保留选择，需在原生 Agent 启用后更新，普通回答不受影响') :
          item.status === 'ready' ? I18n.tpl`上次更新时已连接${item.toolCount != null ? I18n.tpl` · ${item.toolCount} 个工具` : ''}` : item.status === 'unavailable' ? I18n.t('上次更新未连接，请检查原生 Agent 的登录和授权') : item.enabled ? I18n.t('原生已配置') : I18n.t('可为此成员启用');
        return `<label class="native-capability"><span><b>${escape(item.name)}</b><small>${escape(status)}</small></span><input type="checkbox" role="switch" data-kind="${key}" value="${escape(item.id)}"${checked(item, choice) ? ' checked' : ''}${item.selectable === false ? ' disabled' : ''}/></label>`;
      }).join('')}</section>`;
    }).join('') || I18n.t('<p class="native-empty">此目录尚未发现可管理的扩展。</p>');
    host.querySelectorAll('input').forEach(input => input.addEventListener('change', () => {
      if (choice.mode === 'inherit') Object.assign(choice, inherited(items));
      const set = new Set(choice[input.dataset.kind]); input.checked ? set.add(input.value) : set.delete(input.value);
      choice[input.dataset.kind] = [...set]; onChange();
    }));
  }
  function statusText(result) {
    if (result.refreshError) return result.refreshError;
    if (result.unsupported) return result.notice;
    const date = result.scannedAt ? new Date(result.scannedAt).toLocaleString(I18n.language) : '';
    return [result.notice, I18n.tpl`${result.items.length} 项${date ? I18n.tpl` · 更新于 ${date}` : ''}`].filter(Boolean).join(' · ');
  }
  async function manage({ host, bots = [], rooms = [], roomId, settings = {}, cliProfiles, onSaved = () => {}, onManageNative = null }) {
    const management = ++managementGeneration;
    host.innerHTML = I18n.t('<p class="hint">正在读取 Agent…</p>');
    const profiles = cliProfiles || await window.api.listCliProfiles();
    if (management !== managementGeneration) return;
    const available = profiles.filter(profile => profile.enabled || bots.some(bot => bot.cliType === profile.id));
    if (!available.length) { host.innerHTML = I18n.t('<p class="native-empty">请先在 Agent 接入中启用 Agent。</p>'); return; }
    // A side configuration is only exposed when opening settings from that side.
    rooms = rooms.filter(room => !room.archivedAt && (!RoomProfiles.isLocal(room) || room.id === roomId));
    host.innerHTML = I18n.t('<p class="hint native-management-intro">设置 Agent 默认配置，或选择房间及成员单独覆盖。房间覆盖只影响该房间；侧聊保留创建时的配置。</p><nav class="native-agent-tabs" aria-label="选择 Agent"></nav><div class="native-management-body"></div>');
    const nav = host.querySelector('nav'), body = host.querySelector('.native-management-body');
    let currentRequest = 0;
    const drafts = new Map();
    const showAgent = async (cliType, selectedRoomId = '', selectedBotId = '') => {
      const request = ++currentRequest;
      nav.querySelectorAll('button').forEach(button => button.classList.toggle('active', button.dataset.cli === cliType));
      const matchingRooms = rooms.filter(room => RoomProfiles.members(room, bots, settings).some(bot => bot.cliType === cliType));
      const room = matchingRooms.find(item => item.id === selectedRoomId);
      const candidates = room ? RoomProfiles.members(room, bots, settings).filter(bot => bot.cliType === cliType) : [];
      const bot = candidates.find(item => item.id === selectedBotId) || candidates[0];
      const key = `${cliType}:${room?.id || ''}:${bot?.id || ''}`;
      const savedChoice = room ? room.memberCapabilities?.[bot.id] : settings.agentCapabilities?.[cliType];
      const baseChoice = room && RoomProfiles.isLocal(room) ? room.memberProfiles?.[bot.id]?.nativeCapabilities : settings.agentCapabilities?.[cliType];
      const draft = (drafts.get(key)?.dirty ? drafts.get(key) : null) || { mode: room && !savedChoice ? 'default' : (savedChoice?.mode || 'inherit'), choice: copy(savedChoice || baseChoice || defaults()), dirty: false };
      drafts.set(key, draft);
      const choice = draft.choice;
      const directory = room ? (RoomProfiles.isLocal(room) ? room.cwd : bot.cwd || room.cwd) || '' : settings.defaultCwd || '';
      body.innerHTML = I18n.html`<div class="native-management-toolbar"><div class="native-member-picker"><label>查找房间<input type="search" class="native-room-search" placeholder="搜索房间名称或目录" aria-label="搜索房间" autocomplete="off"/></label><label>房间<select class="native-room-choice" aria-label="配置范围"><option value="">Agent 默认配置（所有普通房间）</option>${matchingRooms.map(item => `<option value="${escape(item.id)}">${escape(item.name)}</option>`).join('')}</select></label>${room ? I18n.t('<label>查找成员<input type="search" class="native-member-search" placeholder="搜索此房间成员" aria-label="搜索此房间成员" autocomplete="off"/></label><label>成员<select class="native-member-choice" aria-label="当前房间成员"></select></label><span class="hint native-member-results" role="status"></span>') : ''}</div><button type="button" class="ghost-btn native-refresh">更新</button></div><p class="hint native-selected-member">${room ? I18n.tpl`${escape(room.name)} / ${escape(bot.name)} · 仅此房间生效` : I18n.t('Agent 默认配置 · 未单独覆盖的普通房间成员跟随此配置')}</p><p class="hint native-workspace" title="${escape(directory)}">${escape(directory || I18n.t('使用默认工作目录'))}</p><label class="native-choice-label">使用方式<select class="native-mode">${room ? `<option value="default">${RoomProfiles.isLocal(room) ? I18n.t('沿用侧聊快照配置') : I18n.t('跟随 Agent 默认配置')}</option>` : ''}<option value="inherit">沿用原生配置</option><option value="selected">自定义选择</option></select></label><p class="hint native-status" role="status"></p><div class="native-inventory"></div><p class="hint native-scope">修改在下次运行时生效。原生框架禁用或不支持覆盖的扩展需要在原生 Agent 中启用。</p><button type="button" class="ghost-btn native-open-terminal">在内置终端管理原生扩展…</button><footer class="native-save-row"><span class="hint native-save-status" role="status"></span><button type="button" class="primary-btn native-save" disabled>${room ? I18n.t('保存此房间成员') : I18n.t('保存 Agent 默认配置')}</button></footer>`;
      const roomSearch = body.querySelector('.native-room-search'), roomChoice = body.querySelector('.native-room-choice');
      roomSearch.addEventListener('input', () => {
        const terms = roomSearch.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
        const matches = matchingRooms.filter(item => terms.every(term => [item.name, item.cwd].join(' ').toLowerCase().includes(term)));
        roomChoice.innerHTML = I18n.t('<option value="">Agent 默认配置（所有普通房间）</option>') + matches.map(item => `<option value="${escape(item.id)}">${escape(item.name)}</option>`).join('');
        roomChoice.value = room?.id || '';
        if (room && !matches.some(item => item.id === room.id)) {
          const placeholder = document.createElement('option'); placeholder.value = '__choose__'; placeholder.disabled = true; I18n.write(placeholder, () => I18n.t('选择匹配的房间')); roomChoice.prepend(placeholder); roomChoice.value = '__choose__';
        }
      });
      roomChoice.value = room?.id || '';
      body.querySelector('.native-room-choice').addEventListener('change', event => showAgent(cliType, event.target.value));
      const nativeTerminal = body.querySelector('.native-open-terminal');
      nativeTerminal.hidden = typeof onManageNative !== 'function';
      nativeTerminal.addEventListener('click', () => onManageNative({ cliType, roomId: room?.id, cwd: directory }));
      const mode = body.querySelector('.native-mode'), list = body.querySelector('.native-inventory'), status = body.querySelector('.native-status');
      const save = body.querySelector('.native-save'), saveStatus = body.querySelector('.native-save-status'), refresh = body.querySelector('.native-refresh');
      if (room) {
        const search = body.querySelector('.native-member-search'), memberChoice = body.querySelector('.native-member-choice');
        const filterMembers = () => {
          const terms = search.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
          const matches = candidates.filter(item => terms.every(term => item.name.toLowerCase().includes(term)));
          memberChoice.innerHTML = matches.length ? matches.map(item => `<option value="${escape(item.id)}">${escape(item.name)}</option>`).join('') : I18n.t('<option value="" disabled>没有匹配的成员</option>');
          memberChoice.value = bot.id; memberChoice.disabled = matches.length === 0;
          I18n.write(body.querySelector('.native-member-results'), () => search.value.trim() ? I18n.tpl`${matches.length} 个匹配成员` : '');
        };
        search.addEventListener('input', filterMembers); filterMembers();
        memberChoice.addEventListener('change', event => showAgent(cliType, room.id, event.target.value));
      }
      let items = [], busy = false, loaded = false;
      const update = () => {
        mode.value = draft.mode;
        renderList(list, items, choice, () => { draft.mode = 'selected'; draft.dirty = true; update(); });
        save.disabled = !draft.dirty || busy || !loaded;
        I18n.write(saveStatus, () => draft.dirty ? I18n.t('尚未保存') : '');
      };
      const read = async shouldRefresh => {
        busy = true; refresh.disabled = true; mode.disabled = true; save.disabled = true;
        I18n.write(status, () => shouldRefresh ? I18n.t('正在更新扩展…') : I18n.t('正在读取扩展…'));
        try {
          const result = await window.api.discoverNativeCapabilities({ cliType, roomId: room?.id, cwd: directory, refresh: shouldRefresh });
          if (management !== managementGeneration || request !== currentRequest) return;
          items = result.items; loaded = !result.unsupported && !result.truncated;
          status.textContent = statusText(result);
        } catch (error) { if (request === currentRequest) status.textContent = error.message; }
        finally { if (request === currentRequest && management === managementGeneration) {
          busy = false; refresh.disabled = false; mode.disabled = !loaded; update();
        } }
      };
      mode.addEventListener('change', () => {
        draft.mode = mode.value;
        if (draft.mode === 'default') Object.assign(choice, copy(baseChoice || defaults()));
        else if (draft.mode === 'selected' && choice.mode === 'inherit') Object.assign(choice, inherited(items));
        else choice.mode = draft.mode;
        draft.dirty = true; update();
      });
      refresh.addEventListener('click', () => read(true));
      save.addEventListener('click', async () => {
        busy = true; save.disabled = true; refresh.disabled = true; mode.disabled = true; list.inert = true;
        try {
          const fresh = await window.api.getInitial();
          if (room) {
            const current = fresh.rooms.find(item => item.id === room.id);
            if (!current?.botIds.includes(bot.id)) throw new Error(I18n.t('房间或成员已变化，请重新打开设置'));
            const memberCapabilities = { ...current.memberCapabilities };
            if (draft.mode === 'default') delete memberCapabilities[bot.id]; else memberCapabilities[bot.id] = copy(choice);
            Object.assign(room, await window.api.saveRoom({ id: room.id, memberCapabilities }));
          } else {
            settings = await window.api.saveSettings({ agentCapabilities: { ...fresh.settings.agentCapabilities, [cliType]: copy(choice) } });
          }
          await onSaved(); draft.dirty = false;
          if (management === managementGeneration && request === currentRequest) { update(); I18n.write(saveStatus, () => I18n.t('已保存，下次运行生效')); }
        } catch (error) { if (request === currentRequest) saveStatus.textContent = error.message; }
        finally { if (request === currentRequest && management === managementGeneration) {
          busy = false; save.disabled = !draft.dirty || !loaded; refresh.disabled = false; mode.disabled = !loaded; list.inert = false;
        } }
      });
      await read(false);
    };
    available.forEach(profile => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'native-agent-tab';
      button.dataset.cli = profile.id; button.textContent = profile.label || profile.name || profile.id;
      button.addEventListener('click', () => showAgent(profile.id)); nav.append(button);
    });
    const initialRoom = rooms.find(room => room.id === roomId);
    const initialBot = RoomProfiles.members(initialRoom, bots, settings)[0];
    await showAgent(initialBot?.cliType || available[0].id, RoomProfiles.isLocal(initialRoom) ? roomId : '');
  }
  function closeManagement() { managementGeneration++; }
  return { manage, closeManagement };
})();
