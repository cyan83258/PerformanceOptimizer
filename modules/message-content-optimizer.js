/**
 * Message Content Optimizer Module v1
 *
 * Reduces rendering cost of visible (hydrated) messages:
 *
 *   1. CSS Containment
 *      - `contain: layout style` on .mes isolates each message's layout
 *      - Changes inside one message don't trigger reflow of siblings
 *
 *   2. Lazy Image Loading
 *      - `loading="lazy"` + `decoding="async"` on images in .mes_text
 *      - Off-screen images don't block the main thread
 *
 *   3. Long Message Collapsing
 *      - Messages taller than collapseThresholdPx are truncated with
 *        a gradient mask and toggle button (펼치기/접기)
 *      - Dramatically reduces layout/paint area for 20k+ token messages
 *
 * Integrations:
 *   - Automatically processes newly added messages (MutationObserver)
 *   - Detects virtualizer rehydration events and processes restored messages
 *   - Skips dehydrated messages (heights unreliable when children hidden)
 *
 * @version 1.0.0
 */

const COLLAPSED_ATTR = 'data-perf-collapsed';
const COLLAPSE_BTN_CLASS = 'perf-collapse-toggle';

const DEFAULT_OPTIONS = {
    /** Apply CSS containment to .mes elements */
    containment: true,
    /** Convert images to lazy loading */
    lazyImages: true,
    /** Collapse messages taller than this (px). 0 = disabled */
    collapseThresholdPx: 600,
};

export class MessageContentOptimizer {
    /**
     * @param {Partial<typeof DEFAULT_OPTIONS>} [options]
     */
    constructor(options) {
        /** @type {boolean} */
        this.active = false;
        this.options = { ...DEFAULT_OPTIONS, ...options };

        /** @type {HTMLStyleElement|null} */
        this._styleEl = null;
        /** @type {MutationObserver|null} */
        this._childObserver = null;
        /** @type {MutationObserver|null} */
        this._rehydrateObserver = null;
        /** @type {HTMLElement|null} */
        this._chatContainer = null;
    }

    // ==================================================================
    // Public API
    // ==================================================================

    enable() {
        if (this.active) return;

        this._chatContainer = document.getElementById('chat');
        if (!this._chatContainer) {
            console.warn('[PerfOptimizer/MsgContent] #chat not found');
            return;
        }

        this._injectStyles();
        this._processAllMessages();
        this._setupObservers();

        this.active = true;
        console.log('[PerfOptimizer/MsgContent] v1 enabled');
    }

    disable() {
        this.active = false;

        this._childObserver?.disconnect();
        this._childObserver = null;
        this._rehydrateObserver?.disconnect();
        this._rehydrateObserver = null;

        this._removeStyles();
        this._uncollapseAll();
        this._restoreLazyImages();

        this._chatContainer = null;
    }

    /**
     * Update options at runtime.
     * @param {Partial<typeof DEFAULT_OPTIONS>} options
     */
    update(options) {
        this.options = { ...this.options, ...options };
        if (this.active) {
            this.disable();
            this.enable();
        }
    }

    // ==================================================================
    // CSS Containment & Styles
    // ==================================================================

    /** @private */
    _injectStyles() {
        // Remove old style if re-enabling
        document.getElementById('perf-msg-content-optimizer')?.remove();

        this._styleEl = document.createElement('style');
        this._styleEl.id = 'perf-msg-content-optimizer';

        const rules = [];

        if (this.options.containment) {
            rules.push(`
                #chat .mes {
                    contain: layout style;
                }
                #chat .mes .mes_text {
                    contain: layout style;
                }
            `);
        }

        if (this.options.collapseThresholdPx > 0) {
            rules.push(`
                #chat .mes[${COLLAPSED_ATTR}] .mes_text {
                    max-height: ${this.options.collapseThresholdPx}px !important;
                    overflow: hidden !important;
                    -webkit-mask-image: linear-gradient(to bottom, black 60%, transparent 100%);
                    mask-image: linear-gradient(to bottom, black 60%, transparent 100%);
                }
                .${COLLAPSE_BTN_CLASS} {
                    display: block;
                    width: 100%;
                    padding: 8px 0;
                    margin-top: 2px;
                    border: 1px solid rgba(255,255,255,0.15);
                    background: rgba(128,128,128,0.15);
                    color: var(--SmartThemeEmColor, #ccc);
                    font-size: 0.85em;
                    cursor: pointer;
                    border-radius: 4px;
                    text-align: center;
                    opacity: 0.85;
                    transition: opacity 0.15s;
                }
                .${COLLAPSE_BTN_CLASS}:hover {
                    opacity: 1;
                    background: rgba(128,128,128,0.25);
                }
            `);
        }

        this._styleEl.textContent = rules.join('\n');
        document.head.appendChild(this._styleEl);
    }

    /** @private */
    _removeStyles() {
        this._styleEl?.remove();
        this._styleEl = null;
    }

    // ==================================================================
    // Message Processing
    // ==================================================================

    /** @private Process all existing non-dehydrated messages. */
    _processAllMessages() {
        if (!this._chatContainer) return;
        for (const mes of this._chatContainer.querySelectorAll('.mes:not([data-perf-dehydrated])')) {
            this._processMessage(mes);
        }
    }

    /**
     * @private
     * Process a single message: lazy images + collapse check.
     * Skips dehydrated messages (children hidden, heights unreliable).
     * @param {HTMLElement} mes
     */
    _processMessage(mes) {
        if (mes.hasAttribute('data-perf-dehydrated')) return;

        if (this.options.lazyImages) {
            this._applyLazyImages(mes);
        }
        if (this.options.collapseThresholdPx > 0) {
            this._collapseIfLong(mes);
        }
    }

    // ==================================================================
    // Lazy Images
    // ==================================================================

    /** @private */
    _applyLazyImages(mes) {
        const mesText = mes.querySelector('.mes_text');
        if (!mesText) return;

        for (const img of mesText.querySelectorAll('img:not([loading="lazy"])')) {
            img.loading = 'lazy';
            img.decoding = 'async';
        }
    }

    /** @private */
    _restoreLazyImages() {
        if (!this._chatContainer) return;
        for (const img of this._chatContainer.querySelectorAll('.mes_text img[loading="lazy"]')) {
            img.removeAttribute('loading');
            img.removeAttribute('decoding');
        }
    }

    // ==================================================================
    // Long Message Collapsing
    // ==================================================================

    /**
     * @private
     * Collapse a message if its text content exceeds the threshold.
     * Respects user expand/collapse choices — once expanded, stays expanded.
     * @param {HTMLElement} mes
     */
    _collapseIfLong(mes) {
        // Skip if already collapsed or user already expanded (button exists)
        if (mes.hasAttribute(COLLAPSED_ATTR)) return;
        if (mes.querySelector(`.${COLLAPSE_BTN_CLASS}`)) return;
        // Skip if being edited
        if (mes.querySelector('.mes_edit_buttons:not([style*="display: none"])')) return;

        const mesText = mes.querySelector('.mes_text');
        if (!mesText) return;

        const naturalHeight = mesText.scrollHeight;
        if (naturalHeight <= this.options.collapseThresholdPx) return;

        // Mark collapsed
        mes.setAttribute(COLLAPSED_ATTR, '1');

        // Create toggle button
        const btn = document.createElement('button');
        btn.className = COLLAPSE_BTN_CLASS;
        const ratio = Math.round(naturalHeight / this.options.collapseThresholdPx);
        btn.textContent = `\u25BC \uD3BC\uCE58\uAE30 (${ratio}x \uAE38\uC774)`;
        btn.addEventListener('click', () => this._toggleCollapse(mes, btn));

        // Insert after .mes_text
        mesText.parentNode.insertBefore(btn, mesText.nextSibling);
    }

    /**
     * @private
     * Toggle collapse/expand state on a message.
     * @param {HTMLElement} mes
     * @param {HTMLButtonElement} btn
     */
    _toggleCollapse(mes, btn) {
        if (mes.hasAttribute(COLLAPSED_ATTR)) {
            mes.removeAttribute(COLLAPSED_ATTR);
            btn.textContent = '\u25B2 \uC811\uAE30';
        } else {
            mes.setAttribute(COLLAPSED_ATTR, '1');
            const mesText = mes.querySelector('.mes_text');
            if (mesText) {
                const ratio = Math.round(mesText.scrollHeight / this.options.collapseThresholdPx);
                btn.textContent = `\u25BC \uD3BC\uCE58\uAE30 (${ratio}x \uAE38\uC774)`;
            }
        }
    }

    /** @private Remove all collapse state and buttons. */
    _uncollapseAll() {
        if (!this._chatContainer) return;
        for (const mes of this._chatContainer.querySelectorAll(`[${COLLAPSED_ATTR}]`)) {
            mes.removeAttribute(COLLAPSED_ATTR);
        }
        for (const btn of this._chatContainer.querySelectorAll(`.${COLLAPSE_BTN_CLASS}`)) {
            btn.remove();
        }
    }

    // ==================================================================
    // Observers
    // ==================================================================

    /** @private */
    _setupObservers() {
        // Observer 1: New .mes elements added to #chat (direct children)
        this._childObserver = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType === Node.ELEMENT_NODE && node.classList?.contains('mes')) {
                        // Delay one frame so SillyTavern populates message content
                        requestAnimationFrame(() => {
                            if (this.active) this._processMessage(node);
                        });
                    }
                }
            }
        });
        this._childObserver.observe(this._chatContainer, { childList: true });

        // Observer 2: Detect when virtualizer rehydrates messages
        // (data-perf-dehydrated removed → process the restored message)
        this._rehydrateObserver = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                const mes = mutation.target;
                if (!mes.classList?.contains('mes')) continue;
                if (mes.hasAttribute('data-perf-dehydrated')) continue;
                // Message just rehydrated — process it
                requestAnimationFrame(() => {
                    if (this.active) this._processMessage(mes);
                });
            }
        });
        this._rehydrateObserver.observe(this._chatContainer, {
            attributes: true,
            attributeFilter: ['data-perf-dehydrated'],
            subtree: true,
        });
    }
}
