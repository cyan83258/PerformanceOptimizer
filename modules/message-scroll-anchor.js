/** Preserve a message, not an obsolete scrollTop, during a mobile edit/delete. */
const ACTION = '.mes_edit, .mes_edit_delete, .mes_edit_done, .mes_edit_cancel, .mes_delete';

export class MessageScrollAnchor {
    constructor() {
        this._state = null;
        this._frame = null;
        this._timer = null;
        this._chat = null;
    }

    enable() {
        if (this._chat) return;
        const chat = document.getElementById('chat');
        if (!chat) return;
        this._chat = chat;
        this._capture = event => {
            const button = event.target.closest?.(ACTION);
            const mes = button?.closest('.mes');
            if (!mes || mes.parentElement !== chat) { this._stop(); return; }
            // pointerdown precedes focus/keyboard layout changes; click also covers keyboard activation.
            if (event.type === 'click' && this._state?.message === mes && this._state.button === button) return;
            this._stop();
            const offset = mes.getBoundingClientRect().top - chat.getBoundingClientRect().top;
            this._state = {
                message: mes, button, offset,
                previous: mes.previousElementSibling?.matches('.mes') ? mes.previousElementSibling : null,
                next: mes.nextElementSibling?.matches('.mes') ? mes.nextElementSibling : null,
                committed: false,
            };
            this._timer = setTimeout(() => this._stop(), 30000); // May wait for a delete confirmation.
        };
        this._cancel = () => this._stop();
        this._mutations = new MutationObserver(records => {
            const state = this._state;
            if (!state) return;
            // A full chat switch must never restore a position from the previous chat.
            if (![state.message, state.previous, state.next].some(node => node?.parentElement === chat)) {
                this._stop();
                return;
            }
            const changed = state.message.parentElement !== chat || records.some(record =>
                record.type === 'childList' && (state.message === record.target || state.message.contains(record.target)));
            if (changed && !state.committed) {
                state.committed = true;
                clearTimeout(this._timer);
                this._timer = setTimeout(() => this._stop(), 1200);
                this._resize.observe(chat);
                for (const node of [state.message, state.previous, state.next]) if (node?.parentElement === chat) this._resize.observe(node);
            }
            if (state.committed) this._schedule();
        });
        this._resize = new ResizeObserver(() => this._schedule());
        this._viewport = () => this._schedule();
        chat.addEventListener('pointerdown', this._capture, true);
        chat.addEventListener('click', this._capture, true);
        chat.addEventListener('touchmove', this._cancel, { passive: true });
        chat.addEventListener('wheel', this._cancel, { passive: true });
        chat.addEventListener('scroll', this._viewport, { passive: true });
        this._key = event => {
            if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) this._stop();
        };
        chat.addEventListener('keydown', this._key, true);
        this._mutations.observe(chat, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
        window.visualViewport?.addEventListener('resize', this._viewport, { passive: true });
    }

    _schedule() {
        if (!this._state?.committed || this._frame !== null) return;
        this._frame = requestAnimationFrame(() => {
            this._frame = null;
            const state = this._state;
            const chat = this._chat;
            if (!state?.committed || !chat?.isConnected) return;
            const message = [state.message, state.next, state.previous].find(node => node?.parentElement === chat);
            if (!message) { this._stop(); return; }
            // After deleting a message, keep its surviving neighbour visible at the same place.
            const desired = message === state.message ? state.offset : Math.max(0, state.offset);
            const delta = message.getBoundingClientRect().top - chat.getBoundingClientRect().top - desired;
            if (Math.abs(delta) > 1) chat.scrollTop += delta;
        });
    }

    _stop() {
        this._state = null;
        clearTimeout(this._timer);
        this._timer = null;
        if (this._frame !== null) cancelAnimationFrame(this._frame);
        this._frame = null;
        this._resize?.disconnect();
    }

    disable() {
        this._stop();
        this._mutations?.disconnect();
        const chat = this._chat;
        if (!chat) return;
        chat.removeEventListener('pointerdown', this._capture, true);
        chat.removeEventListener('click', this._capture, true);
        chat.removeEventListener('touchmove', this._cancel);
        chat.removeEventListener('wheel', this._cancel);
        chat.removeEventListener('scroll', this._viewport);
        chat.removeEventListener('keydown', this._key, true);
        window.visualViewport?.removeEventListener('resize', this._viewport);
        this._chat = null;
    }
}
