'use strict';
const I18n = require('../../shared/i18n');

const denyPermissionRequest = (_contents, _permission, callback) => callback(false);
const denyPermissionCheck = () => false;
function browserUrl(input) {
  if (typeof input !== 'string' || input.length > 8192) throw new Error(I18n.t('网址无效'));
  let url;
  try { url = new URL(input.trim()); } catch { throw new Error(I18n.t('请输入完整的 http:// 或 https:// 网址')); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(I18n.t('仅支持不含账号密码的 HTTP / HTTPS 网址'));
  return url.href;
}

function viewBounds(value, content) {
  const integer = number => Number.isFinite(number) ? Math.round(number) : 0;
  const x = Math.max(0, Math.min(content.width, integer(value.x)));
  const y = Math.max(0, Math.min(content.height, integer(value.y)));
  return { x, y, width: Math.max(0, Math.min(content.width - x, integer(value.width))),
    height: Math.max(0, Math.min(content.height - y, integer(value.height))) };
}

class BrowserService {
  constructor({ win, WebContentsView, emit }) {
    this.win = win; this.View = WebContentsView; this.emit = emit; this.views = new Map(); this.closing = new Map(); this.generation = 0;
    // Electron owns Session objects until process exit. Reuse this bounded set
    // only after clearing the previous tab's identity and stored web content.
    this.slots = Array.from({ length: 6 }, (_, index) => ({ partition: `convoke-browser-slot-${index}`, state: 'free', cleanup: null }));
  }

  async create(id) {
    if (typeof id !== 'string' || !/^[\w-]{1,80}$/.test(id) || this.views.has(id)) throw new Error(I18n.t('浏览器标识无效'));
    const started = this.generation;
    let slot = this.slots.find(item => item.state === 'free');
    while (!slot) {
      const cleaning = this.slots.filter(item => item.state === 'cleaning').map(item => item.cleanup);
      if (!cleaning.length) throw new Error(I18n.t('最多同时打开 6 个浏览器页面，请先关闭一个页面'));
      await Promise.race(cleaning.map(promise => promise.catch(() => {})));
      if (started !== this.generation || this.win.isDestroyed?.()) throw new Error(I18n.t('工作台已重置，请重新打开浏览器'));
      slot = this.slots.find(item => item.state === 'free');
    }
    if (this.views.has(id) || this.closing.has(id)) throw new Error(I18n.t('浏览器标识无效'));
    slot.state = 'active';
    let view;
    try {
      view = new this.View({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
        webSecurity: true, allowRunningInsecureContent: false, partition: slot.partition,
        navigateOnDragDrop: false, safeDialogs: true } });
    } catch (error) { slot.state = 'free'; throw error; }
    const contents = view.webContents;
    const item = { id, view, session: contents.session, slot, url: '', loading: false, error: '', timer: null, visible: false, closed: false };
    this.views.set(id, item);
    this.win.contentView.addChildView(view);
    view.setVisible(false);
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.session.setPermissionRequestHandler(denyPermissionRequest);
    contents.session.setPermissionCheckHandler(denyPermissionCheck);
    item.downloadListener = event => { event.preventDefault(); this.update(item, { error: I18n.t('内置浏览器暂不下载文件，可用系统浏览器打开网址') }); };
    contents.session.on('will-download', item.downloadListener);
    const navigation = (event, url) => {
      try { browserUrl(url || event.url); }
      catch (error) { event.preventDefault(); this.update(item, { error: error.message, loading: false }); }
    };
    contents.on('will-navigate', navigation);
    contents.on('will-redirect', navigation);
    contents.on('did-start-loading', () => {
      this.update(item, { loading: true, error: '' });
      clearTimeout(item.timer);
      item.timer = setTimeout(() => { if (item.closed) return; contents.stop(); this.update(item, { loading: false, error: I18n.t('页面加载超过 30 秒，请重试') }); }, 30000);
    });
    contents.on('did-stop-loading', () => { clearTimeout(item.timer); this.update(item, { loading: false }); });
    contents.on('did-navigate', (_event, url) => this.update(item, { url }));
    contents.on('did-navigate-in-page', (_event, url, mainFrame) => { if (mainFrame) this.update(item, { url }); });
    contents.on('page-title-updated', (_event, title) => this.update(item, { title: String(title).slice(0, 200) }));
    contents.on('did-fail-load', (_event, code, description, _url, mainFrame) => {
      if (mainFrame && code !== -3) { clearTimeout(item.timer); this.update(item, { loading: false, error: I18n.tpl`页面加载失败：${description} (${code})` }); }
    });
    contents.on('render-process-gone', (_event, details) => this.update(item, { loading: false, error: I18n.tpl`页面进程已退出：${details.reason}` }));
    return { id };
  }

  update(item, patch) {
    if (item.closed || item.view.webContents.isDestroyed()) return;
    Object.assign(item, patch);
    const history = item.view.webContents.navigationHistory;
    this.emit({ kind: 'browser-state', id: item.id, url: item.url, title: item.title || I18n.t('浏览器'), loading: item.loading,
      error: item.error, canBack: history.canGoBack(), canForward: history.canGoForward() });
  }

  get(id) { const item = this.views.get(id); if (!item) throw new Error(I18n.t('浏览器页面已关闭')); return item; }

  async navigate(id, input) {
    const item = this.get(id), url = browserUrl(input);
    this.update(item, { url, error: '' });
    // Failures are surfaced through state events as well as the rejected action.
    await item.view.webContents.loadURL(url);
    return { url };
  }

  action(id, action) {
    const contents = this.get(id).view.webContents;
    if (action === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    else if (action === 'forward' && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
    else if (action === 'reload') contents.reload();
    else if (action === 'stop') contents.stop();
    else if (!['back', 'forward'].includes(action)) throw new Error(I18n.t('浏览器操作无效'));
  }

  bounds(id, payload) {
    const item = this.get(id);
    const bounds = viewBounds(payload, this.win.getContentBounds());
    item.view.setBounds(bounds);
    item.visible = payload.visible === true && bounds.width > 0 && bounds.height > 0;
    item.view.setVisible(item.visible);
  }

  close(id) {
    const item = this.views.get(id); if (!item) return this.closing.get(id) || Promise.resolve();
    item.closed = true; clearTimeout(item.timer); this.views.delete(id);
    item.session.removeListener('will-download', item.downloadListener);
    // BrowserWindow may already be torn down when its `closed` event fires.
    if (!this.win.isDestroyed?.()) this.win.contentView.removeChildView(item.view);
    const contents = item.view.webContents;
    const destroyed = !contents || contents.isDestroyed() ? Promise.resolve() : new Promise(resolve => {
      contents.once('destroyed', resolve);
      contents.close({ waitForBeforeUnload: false });
    });
    item.slot.state = 'cleaning';
    const cleanup = (async () => {
      let timer;
      try {
        await Promise.race([
          (async () => {
            await destroyed;
            await Promise.all([item.session.clearStorageData(), item.session.clearCache(), item.session.clearAuthCache()]);
            await item.session.closeAllConnections();
          })(),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(I18n.t('清理超过 10 秒'))), 10000); }),
        ]);
        item.slot.state = 'free';
      } catch (error) {
        // Never lend a slot whose previous tab's identity could remain present.
        item.slot.state = 'blocked';
        throw new Error(I18n.tpl`浏览器会话清理失败，此槽位已隔离：${error.message}`);
      } finally { clearTimeout(timer); item.slot.cleanup = null; this.closing.delete(id); }
    })();
    item.slot.cleanup = cleanup; this.closing.set(id, cleanup); return cleanup;
  }

  dispose() {
    this.generation++;
    const pending = [...this.closing.values()];
    for (const id of this.views.keys()) pending.push(this.close(id));
    return Promise.allSettled(pending);
  }
}

module.exports = { BrowserService, browserUrl, viewBounds };
