/**
 * Chat Virtualizer Module
 *
 * Implements virtual scrolling for the chat container (#chat).
 * Only messages within the visible viewport (plus a configurable buffer)
 * are fully rendered in the DOM. Off-screen messages are collapsed to
 * lightweight placeholders that preserve their height, keeping the
 * scrollbar accurate.
 *
 * This dramatically reduces DOM node count and reflow/repaint cost
 * in chats with hundreds of messages.
 *
 * Strategy:
 *   - Uses IntersectionObserver (efficient, no scroll-event overhead)
 *   - Messages entering the viewport are "hydrated" (display restored)
 *   - Messages leaving the buffer zone are "dehydrated" (children hidden,
 *     fixed height placeholder shown)
 *   - The last N messages are always kept hydrated (for context & UX)
 *   - Currently active/editing messages are never dehydrated
 */

/** @typedef {{ bufferSize: number, alwaysVisibleTail: number }} VirtualizerOptions */

const DEFAULT_OPTIONS = {
    /** Number of extra messages to keep hydrated above/below viewport */
    bufferSize: 5,
    /** Always keep the last N messages hydrated */
    alwaysVisibleTail: 10,
};

const DEHYDRATED_ATTR = 'data-perf-dehydrated';
const HEIGHT_ATTR = 'data-perf-height';

export class ChatVirtualizer {
    /**
     * @param {Partial<VirtualizerOptions>} [options]
     */
    constructor(options) {
        /** @type {boolean} */
        this.active = false;
        /** @type {VirtualizerOptions} */
        this.options = { ...DEFAULT_OPTIONS, ...options };
        /** @type {IntersectionObserver|null} */
        this._observer = null;
        /** @type {MutationObserver|null} */
        this._mutationObserver = null;
        /** @type {HTMLElement|null} */
        this._chatContainer = null;
        /** @type {Set<Element>} Messages currently in/near viewport */
        this._visibleSet = new Set();
    }

    /** Enable virtualization. */
    enable() {
        this._chatContainer = document.getElementById('chat');
        if (!this._chatContainer) {
            console.warn('[PerfOptimizer/ChatVirt] #chat not found');
            return;
        }

        this._setupIntersectionObserver();
        this._setupMutationObserver();
        this._processExistingMessages();
        this.active = true;
        console.log('[PerfOptimizer/ChatVirt] Enabled');
    }

    /** Disable virtualization and rehydrate all messages. */
    disable() {
        if (this._observer) {
            this._observer.disconnect();
            this._observer = null;
        }
        if (this._mutationObserver) {
            this._mutationObserver.disconnect();
            this._mutationObserver = null;
        }
        this._rehydrateAll();
        this._visibleSet.clear();
        this.active = false;
    }

    /**
     * Update options.
     * @param {Partial<VirtualizerOptions>} options
     */
    update(options) {
        this.options = { ...this.options, ...options };
        // Rebuild observer with new rootMargin
        if (this.active) {
            this.disable();
            this.enable();
        }
    }

    /**
     * Force rehydrate all messages (e.g., before printing or export).
     */
    rehydrateAll() {
        this._rehydrateAll();
    }

    // ---------------------------------------------------------------
    // IntersectionObserver
    // ---------------------------------------------------------------

    /** @private */
    _setupIntersectionObserver() {
        // Buffer zone: bufferSize * estimated message height
        const bufferPx = this.options.bufferSize * 250;

        this._observer = new IntersectionObserver(
            (entries) => this._onIntersection(entries),
            {
                root: this._chatContainer,
                rootMargin: `${bufferPx}px 0px ${bufferPx}px 0px`,
                threshold: 0,
            },
        );

        // Observe all existing .mes elements
        const messages = this._chatContainer.querySelectorAll('.mes');
        for (const mes of messages) {
            this._observer.observe(mes);
        }
    }

    /**
     * @private
     * @param {IntersectionObserverEntry[]} entries
     */
    _onIntersection(entries) {
        for (const entry of entries) {
            if (entry.isIntersecting) {
                this._visibleSet.add(entry.target);
                this._hydrate(entry.target);
            } else {
                this._visibleSet.delete(entry.target);
            }
        }

        // Debounced dehydration pass
        this._scheduleDehydration();
    }

    /** @private Dehydration is debounced to avoid flicker on fast scrolling */
    _scheduleDehydration() {
        if (this._dehydrateTimer) return;
        this._dehydrateTimer = setTimeout(() => {
            this._dehydrateTimer = null;
            this._dehydrateOffscreen();
        }, 200);
    }

    // ---------------------------------------------------------------
    // MutationObserver - watch for new messages
    // ---------------------------------------------------------------

    /** @private */
    _setupMutationObserver() {
        this._mutationObserver = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType === Node.ELEMENT_NODE && node.classList?.contains('mes')) {
                        this._observer?.observe(node);
                    }
                }
            }
        });

        this._mutationObserver.observe(this._chatContainer, {
            childList: true,
        });
    }

    // ---------------------------------------------------------------
    // Hydrate / Dehydrate
    // ---------------------------------------------------------------

    /** @private Process existing messages on startup */
    _processExistingMessages() {
        // Let IntersectionObserver handle initial visibility detection.
        // But ensure tail messages are always visible.
        const messages = this._chatContainer.querySelectorAll('.mes');
        const total = messages.length;
        const tailStart = Math.max(0, total - this.options.alwaysVisibleTail);

        for (let i = tailStart; i < total; i++) {
            this._visibleSet.add(messages[i]);
        }
    }

    /**
     * @private
     * Dehydrate messages that are not in the visible set and not protected.
     */
    _dehydrateOffscreen() {
        if (!this._chatContainer) return;

        const messages = this._chatContainer.querySelectorAll('.mes');
        const total = messages.length;
        const tailStart = Math.max(0, total - this.options.alwaysVisibleTail);

        for (let i = 0; i < total; i++) {
            const mes = messages[i];

            // Skip: in visible set, in tail, being edited, or has active swipe
            if (this._visibleSet.has(mes)) continue;
            if (i >= tailStart) continue;
            if (mes.querySelector('.mes_edit_buttons:not([style*="display: none"])')) continue;
            if (mes.classList.contains('last_mes')) continue;

            this._dehydrate(mes);
        }
    }

    /**
     * @private
     * Collapse a message to a fixed-height placeholder.
     * @param {HTMLElement} mes
     */
    _dehydrate(mes) {
        if (mes.hasAttribute(DEHYDRATED_ATTR)) return;

        // Store current height
        const height = mes.offsetHeight;
        mes.setAttribute(HEIGHT_ATTR, height);
        mes.setAttribute(DEHYDRATED_ATTR, '1');

        // Hide children instead of removing (preserves event handlers)
        for (const child of mes.children) {
            child.style.display = 'none';
        }

        // Set fixed height to preserve scroll position
        mes.style.minHeight = `${height}px`;
        mes.style.height = `${height}px`;
        mes.style.overflow = 'hidden';
        mes.style.contentVisibility = 'hidden';
    }

    /**
     * @private
     * Restore a dehydrated message.
     * @param {HTMLElement} mes
     */
    _hydrate(mes) {
        if (!mes.hasAttribute(DEHYDRATED_ATTR)) return;

        mes.removeAttribute(DEHYDRATED_ATTR);
        mes.removeAttribute(HEIGHT_ATTR);

        // Restore children visibility
        for (const child of mes.children) {
            child.style.display = '';
        }

        // Remove fixed sizing
        mes.style.minHeight = '';
        mes.style.height = '';
        mes.style.overflow = '';
        mes.style.contentVisibility = '';
    }

    /**
     * @private
     * Rehydrate all dehydrated messages.
     */
    _rehydrateAll() {
        if (!this._chatContainer) return;
        const dehydrated = this._chatContainer.querySelectorAll(`[${DEHYDRATED_ATTR}]`);
        for (const mes of dehydrated) {
            this._hydrate(mes);
        }
    }
}
