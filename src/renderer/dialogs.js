'use strict';

// HTML dialog stays in the renderer focus tree; requests are shown one at a
// time and always settle on Escape/cancel as well as explicit button clicks.
(() => {
  const queue = [];
  let active = null;
  const dialog = document.createElement('dialog');
  dialog.id = 'appDialog';
  dialog.className = 'app-dialog';
  dialog.setAttribute('aria-labelledby', 'appDialogTitle');
  dialog.setAttribute('aria-describedby', 'appDialogMessage');
  dialog.innerHTML = '<h2 id="appDialogTitle"></h2><p id="appDialogMessage"></p>' +
    '<div class="modal-actions"><div class="spacer"></div>' +
    I18n.t('<button id="appDialogCancel" class="ghost-btn" type="button">取消</button>') +
    I18n.t('<button id="appDialogAccept" class="primary-btn" type="button">确认</button></div>');
  document.body.appendChild(dialog);
  const cancel = dialog.querySelector('#appDialogCancel');
  const accept = dialog.querySelector('#appDialogAccept');

  function next() {
    if (active || !queue.length) return;
    active = queue.shift();
    active.returnFocus = document.activeElement;
    if (typeof active.returnFocus.selectionStart === 'number') {
      active.selection = [active.returnFocus.selectionStart, active.returnFocus.selectionEnd];
    }
    const confirmation = active.confirm;
    I18n.write(dialog.querySelector('#appDialogTitle'), () => confirmation ? I18n.t('请确认') : I18n.t('提示'));
    dialog.querySelector('#appDialogMessage').textContent = active.message;
    cancel.hidden = !active.confirm;
    I18n.write(accept, () => confirmation ? I18n.t('确认') : I18n.t('知道了'));
    dialog.showModal();
    (active.confirm ? cancel : accept).focus();
  }

  function settle(value) {
    if (!active) return;
    const request = active;
    active = null;
    dialog.close();
    if (request.returnFocus?.isConnected && request.returnFocus.getClientRects().length) {
      request.returnFocus.focus({ preventScroll: true });
      if (request.selection && request.returnFocus.setSelectionRange) {
        request.returnFocus.setSelectionRange(...request.selection);
      }
    }
    request.resolve(value);
    queueMicrotask(next);
  }

  cancel.addEventListener('click', () => settle(false));
  accept.addEventListener('click', () => settle(true));
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); settle(false); });
  dialog.addEventListener('keydown', (event) => event.stopPropagation());
  const ask = (message, confirm) => new Promise((resolve) => {
    queue.push({ message: String(message), confirm, resolve }); next();
  });
  window.AppDialog = {
    alert: (message) => ask(message, false),
    confirm: (message) => ask(message, true),
    isOpen: () => dialog.open,
  };
})();
