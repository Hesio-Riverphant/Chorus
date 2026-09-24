'use strict';

// A small contenteditable boundary: only text and non-editable mention/skill
// spans enter this document. History and drafts belong to individual rooms.
class RoomComposer {
  constructor(element) {
    this.element = element;
    this.rooms = new Map();
    this.roomId = null;
    this.composing = false;
    this.restoring = false;
    // Textarea-compatible test/accessibility integration at the DOM boundary.
    Object.defineProperties(element, {
      value: { get: () => this.value, set: (text) => { this.value = text; } },
      selectionStart: { get: () => this.selection()[0] },
      selectionEnd: { get: () => this.selection()[1] },
    });
    element.setSelectionRange = (start, end) => this.select(start, end);
    element.addEventListener('compositionstart', () => { this.composing = true; });
    element.addEventListener('compositionend', () => {
      this.composing = false;
      this.record();
    });
    element.addEventListener('input', () => { if (!this.composing) this.record(); });
    element.addEventListener('beforeinput', (event) => {
      if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
        event.preventDefault();
        this.undo(event.inputType === 'historyRedo');
      } else if (event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak') {
        event.preventDefault();
        this.insertText('\n');
      } else if (!this.composing && /^delete/.test(event.inputType)) {
        this.expandTokenSelection(event.inputType.includes('Backward') ? -1 : 1);
      } else if (/^format/.test(event.inputType)) {
        event.preventDefault();
      } else if (!this.composing && event.inputType === 'insertText') {
        this.expandTokenSelection();
      }
    });
    element.addEventListener('keydown', (event) => {
      if (this.composing || event.isComposing || event.keyCode === 229) return;
      if ((event.ctrlKey || event.metaKey) && !event.altKey &&
          (event.key.toLowerCase() === 'z' || event.key.toLowerCase() === 'y')) {
        event.preventDefault();
        this.undo(event.shiftKey || event.key.toLowerCase() === 'y');
      }
    });
    element.addEventListener('paste', (event) => {
      event.preventDefault();
      if (!event.clipboardData.types.includes('text/plain')) return;
      this.insertText(event.clipboardData.getData('text/plain'));
    });
    element.addEventListener('drop', (event) => {
      // Never allow arbitrary HTML or file content into the editor.
      event.preventDefault();
      if (!event.dataTransfer.types.includes('text/plain')) return;
      const range = document.caretRangeFromPoint(event.clientX, event.clientY);
      if (range && element.contains(range.startContainer)) {
        const selection = window.getSelection();
        selection.removeAllRanges(); selection.addRange(range);
      }
      this.insertText(event.dataTransfer.getData('text/plain'));
    });
    element.addEventListener('copy', (event) => this.copy(event, false));
    element.addEventListener('cut', (event) => this.copy(event, true));
  }

  get value() { return this.element.textContent.replace(/\u00a0/g, ' '); }
  set value(text) {
    this.element.textContent = text;
    this.select(text.length);
    this.changed();
  }
  get selectionStart() { return this.selection()[0]; }
  focus() { this.element.focus(); }

  selection() {
    const selection = window.getSelection();
    if (!selection.rangeCount || !this.element.contains(selection.anchorNode) ||
        !this.element.contains(selection.focusNode)) return [this.value.length, this.value.length];
    const selected = selection.getRangeAt(0);
    const before = document.createRange();
    before.selectNodeContents(this.element);
    before.setEnd(selected.startContainer, selected.startOffset);
    const start = before.toString().length;
    return [start, start + selected.toString().length];
  }

  point(offset) {
    const walker = document.createTreeWalker(this.element, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (offset <= node.length) {
        const token = node.parentElement.closest('[data-token]');
        if (token) {
          const index = Array.prototype.indexOf.call(token.parentNode.childNodes, token);
          return [token.parentNode, index + (offset > 0 ? 1 : 0)];
        }
        return [node, offset];
      }
      offset -= node.length;
    }
    return [this.element, this.element.childNodes.length];
  }

  select(start, end = start) {
    const range = document.createRange();
    range.setStart(...this.point(start)); range.setEnd(...this.point(end));
    const selection = window.getSelection();
    selection.removeAllRanges(); selection.addRange(range);
  }

  expandTokenSelection(direction = 0) {
    let [start, end] = this.selection();
    let offset = 0;
    for (const node of this.element.childNodes) {
      const length = node.textContent.length;
      if (node.nodeType === Node.ELEMENT_NODE && node.hasAttribute('data-token')) {
        const touches = start === end
          ? (direction < 0 && (start === offset + length ||
              (start === offset + length + 1 && this.value[start - 1] === ' '))) ||
            (direction > 0 && start === offset)
          : start < offset + length && end > offset;
        if (touches) { start = Math.min(start, offset); end = Math.max(end, offset + length); }
      }
      offset += length;
    }
    this.select(start, end);
  }

  insertText(text) {
    this.focus();
    this.expandTokenSelection();
    const range = window.getSelection().getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(String(text).replace(/\r\n?/g, '\n'));
    range.insertNode(node); range.setStartAfter(node); range.collapse(true);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    this.changed();
  }

  replaceToken(start, end, kind, name) {
    this.focus(); this.select(start, end); this.expandTokenSelection();
    const range = window.getSelection().getRangeAt(0);
    range.deleteContents();
    const token = document.createElement('span');
    token.className = 'composer-token'; token.contentEditable = 'false';
    token.dataset.token = kind;
    token.textContent = (kind === 'skill' ? '/' : '@') + name;
    I18n.attr(token, 'aria-label', () => `${kind === 'skill' ? I18n.t('技能') : I18n.t('成员')} ${name}`);
    const trailing = document.createTextNode(' ');
    const fragment = document.createDocumentFragment();
    fragment.append(token, trailing); range.insertNode(fragment);
    range.setStartAfter(trailing); range.collapse(true);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    this.changed();
  }

  copy(event, cut) {
    this.expandTokenSelection();
    const [start, end] = this.selection();
    if (start === end) return;
    event.preventDefault(); event.clipboardData.setData('text/plain', this.value.slice(start, end));
    if (cut) { window.getSelection().getRangeAt(0).deleteContents(); this.changed(); }
  }

  snapshot() { return { html: this.element.innerHTML, selection: this.selection() }; }

  record() {
    if (this.restoring || !this.roomId) return;
    const room = this.rooms.get(this.roomId);
    const snapshot = this.snapshot();
    if (room.history[room.index].html === snapshot.html) return;
    room.history.splice(room.index + 1);
    room.history.push(snapshot);
    if (room.history.length > 100) room.history.shift();
    room.index = room.history.length - 1;
  }

  changed() {
    this.record();
    this.element.dispatchEvent(new Event('input', { bubbles: true }));
  }

  undo(redo = false) {
    const room = this.rooms.get(this.roomId);
    if (!room) return;
    const next = room.index + (redo ? 1 : -1);
    if (next < 0 || next >= room.history.length) return;
    room.index = next;
    this.restore(room.history[next]);
  }

  restore(snapshot) {
    this.restoring = true;
    this.element.innerHTML = snapshot.html;
    this.select(...snapshot.selection);
    this.element.dispatchEvent(new Event('input', { bubbles: true }));
    this.restoring = false;
  }

  switchRoom(roomId) {
    this.record();
    this.roomId = roomId;
    if (!this.rooms.has(roomId)) this.rooms.set(roomId, { index: 0, history: [{ html: '', selection: [0, 0] }] });
    const room = this.rooms.get(roomId);
    this.restore(room.history[room.index]);
  }

  clearSent(roomId, text) {
    if (roomId === this.roomId) {
      if (this.value.trim() === text) this.value = '';
      return;
    }
    const room = this.rooms.get(roomId);
    if (!room) return;
    const div = document.createElement('div'); div.innerHTML = room.history[room.index].html;
    if (div.textContent.trim() === text) {
      room.history.splice(room.index + 1);
      room.history.push({ html: '', selection: [0, 0] });
      room.index = room.history.length - 1;
    }
  }
}

window.RoomComposer = RoomComposer;
