/** Native rendering virtualization. Message DOM, search and selection stay intact. */
const STYLE_ID = 'perf-chat-virtualizer';
const NEAR = 'perf-viewport-near';

export class ChatVirtualizer {
    constructor(options = {}) {
        this.active = false;
        this.options = { bufferSize: 2, alwaysVisibleTail: 3, ...options };
        this._observer = null;
        this._mutationObserver = null;
        this._chatContainer = null;
        this._styleEl = null;
    }

    enable() {
        if (this.active || !CSS.supports('content-visibility', 'auto')) return;
        const chat = document.getElementById('chat');
        if (!chat) return;
        this._chatContainer = chat;
        this.active = true;
        this._styleEl = document.createElement('style');
        this._styleEl.id = STYLE_ID;
        const tail = Math.min(30, Math.max(1, Math.floor(Number(this.options.alwaysVisibleTail) || 3)));
        this._styleEl.textContent = `
            #chat.perf-native-virtual > .mes {
                content-visibility: auto;
                contain-intrinsic-block-size: auto 250px;
            }
            #chat.perf-native-virtual > .mes:is(.${NEAR}, .last_mes, :focus-within, [data-perf-editing], :nth-last-child(-n+${tail})),
            #chat.perf-native-virtual > .mes:has(.edit_textarea, .reasoning_edit_textarea) {
                content-visibility: visible !important;
            }
            @media print { #chat.perf-native-virtual > .mes { content-visibility: visible !important; } }
        `;
        document.head.appendChild(this._styleEl);
        chat.classList.add('perf-native-virtual');
        if (typeof IntersectionObserver === 'function') {
            const buffer = Math.min(10, Math.max(0, Number(this.options.bufferSize) || 0)) * 250;
            this._observer = new IntersectionObserver(entries => {
                if (!this.active) return;
                for (const entry of entries) {
                    if (entry.target.parentElement === chat) entry.target.classList.toggle(NEAR, entry.isIntersecting);
                }
            }, { root: chat, rootMargin: `${buffer}px 0px` });
            for (const mes of chat.children) this._observe(mes);
            this._mutationObserver = new MutationObserver(records => {
                if (!this.active) return;
                for (const record of records) {
                    for (const node of record.removedNodes) {
                        if (node.nodeType !== 1) continue;
                        this._observer.unobserve(node);
                        node.classList.remove(NEAR);
                    }
                    for (const node of record.addedNodes) this._observe(node);
                }
            });
            this._mutationObserver.observe(chat, { childList: true });
        }
    }

    _observe(node) {
        if (node.nodeType === 1 && node.classList.contains('mes')) this._observer?.observe(node);
    }

    disable() {
        this.active = false;
        this._observer?.disconnect();
        this._mutationObserver?.disconnect();
        this._observer = this._mutationObserver = null;
        this._chatContainer?.classList.remove('perf-native-virtual');
        for (const mes of this._chatContainer?.querySelectorAll(`.${NEAR}`) || []) mes.classList.remove(NEAR);
        this._styleEl?.remove();
        this._styleEl = null;
        this._chatContainer = null;
    }

    update(options) {
        const next = { ...this.options, ...options };
        if (Object.keys(next).every(key => next[key] === this.options[key])) return;
        const active = this.active;
        if (active) this.disable();
        this.options = next;
        if (active) this.enable();
    }

    // Explicit full-render escape hatch for integrations such as screenshots.
    rehydrateAll() { this._chatContainer?.classList.remove('perf-native-virtual'); }
    refresh() { if (this.active) this._chatContainer?.classList.add('perf-native-virtual'); }
    // Only an explicit caller may move the user's reading position.
    scrollToBottom() {
        if (this.active && this._chatContainer) this._chatContainer.scrollTop = this._chatContainer.scrollHeight;
    }
}
