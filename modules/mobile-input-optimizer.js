/** Mobile edit containment and focus tracking. Native focus and resizing stay untouched. */

const LOG = '[PerfOpt/InputOpt]';
const STYLE_ID = 'perf-opt-input-v1';
const EDITING_ATTR = 'data-perf-editing';

export class MobileInputOptimizer {
    constructor() {
        this.active = false;

        /** @type {HTMLStyleElement|null} */
        this._styleEl = null;

        /** @type {Function|null} */
        this._onFocusIn = null;
        /** @type {Function|null} */
        this._onFocusOut = null;


        /** @type {WeakSet<HTMLElement>} Patched focus elements */
        this._patched = new WeakSet();


        /** @type {Map<HTMLElement, number>} Edit unmark timers */
        this._unmarkTimers = new Map();
    }

    // ================================================================
    // Public API
    // ================================================================

    enable() {
        if (this.active) return;
        if (!this._isMobile()) {
            console.log(`${LOG} Desktop detected, skipping`);
            return;
        }

        this._injectCSS();
        this._setupEditDetector();
        // Native textarea resizing remains synchronous; the old observer only scheduled empty frames.

        this.active = true;
        console.log(`${LOG} Enabled`);
    }

    disable() {
        if (!this.active) return;
        this._removeCSS();
        this._removeEditDetector();
        this._clearAllTimers();
        this.active = false;
    }

    // ================================================================
    // Detection
    // ================================================================

    /** @private */
    _isMobile() {
        return 'ontouchstart' in window
            || navigator.maxTouchPoints > 0
            || window.innerWidth <= 1000
            || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    }

    // ================================================================
    // Edit-Mode CSS
    // ================================================================

    /** @private */
    _injectCSS() {
        this._removeCSS();
        this._styleEl = document.createElement('style');
        this._styleEl.id = STYLE_ID;
        this._styleEl.textContent = `
/* ================================================================
   [PerfOpt] Mobile Input Optimizer
   ================================================================ */

@media screen and (max-width: 1000px) {

    /* ── Edit textarea smoothness ────────────────────────────────
       Prevent layout thrashing during auto-resize */
    #send_textarea,
    .mes textarea {
        contain: inline-size;
    }

    /* ── Message being edited ────────────────────────────────────
       Relax ALL containment so edit UI renders without restriction.
       Overrides virtualizer dehydration + keyboard freeze containment. */
    .mes[${EDITING_ATTR}="1"] {
        contain: none !important;
        content-visibility: visible !important;
        overflow: visible !important;
        height: auto !important;
        min-height: auto !important;
    }

    /* ── Force-show children of editing message ──────────────────
       Overrides virtualizer's dehydration rule. */
    .mes[${EDITING_ATTR}="1"][data-perf-dehydrated] > * {
        display: initial !important;
    }

    /* ── Smooth scroll to edited message ─────────────────────────  */
    .mes[${EDITING_ATTR}="1"] {
        scroll-margin-top: 20px;
        scroll-margin-bottom: 20px;
    }
}
`;
        document.head.appendChild(this._styleEl);
    }

    /** @private */
    _removeCSS() {
        if (this._styleEl) {
            this._styleEl.remove();
            this._styleEl = null;
        }
    }

    // ================================================================
    // Edit Mode Detection
    // ================================================================

    /**
     * @private
     * Detect edit mode by monitoring focus on textareas inside .mes.
     * When a textarea inside a message gets focus:
     *   1. Remove dehydration if present (virtualizer)
     *   2. Mark message with EDITING_ATTR for CSS relaxation
     * When focus leaves:
     *   1. Wait briefly (user might refocus)
     *   2. Unmark message
     */
    _setupEditDetector() {
        this._onFocusIn = (e) => {
            const el = e.target;
            if (!el) return;

            // Detect edit mode: textarea inside a message element
            if (el.tagName === 'TEXTAREA' || el.isContentEditable) {
                const mes = el.closest('.mes');
                if (mes) {
                    this._markForEditing(mes);
                }
            }
        };

        this._onFocusOut = (e) => {
            const el = e.target;
            if (!el) return;

            if (el.tagName === 'TEXTAREA' || el.isContentEditable) {
                const mes = el.closest('.mes');
                if (mes) {
                    // Delay unmark — user might refocus (e.g., after keyboard dismiss)
                    this._scheduleUnmark(mes);
                }
            }
        };

        document.addEventListener('focusin', this._onFocusIn, { passive: true });
        document.addEventListener('focusout', this._onFocusOut, { passive: true });
    }

    /** @private */
    _removeEditDetector() {
        if (this._onFocusIn) {
            document.removeEventListener('focusin', this._onFocusIn);
            this._onFocusIn = null;
        }
        if (this._onFocusOut) {
            document.removeEventListener('focusout', this._onFocusOut);
            this._onFocusOut = null;
        }

        // Clean up all editing markers
        document.querySelectorAll(`[${EDITING_ATTR}]`).forEach(el => {
            el.removeAttribute(EDITING_ATTR);
        });
    }

    /**
     * @private
     * Mark a message element for editing mode.
     * @param {HTMLElement} mes
     */
    _markForEditing(mes) {
        // Cancel any pending unmark
        const timer = this._unmarkTimers.get(mes);
        if (timer) {
            clearTimeout(timer);
            this._unmarkTimers.delete(mes);
        }

        // Already marked
        if (mes.hasAttribute(EDITING_ATTR)) return;

        // Remove virtualizer dehydration if present
        if (mes.hasAttribute('data-perf-dehydrated')) {
            mes.removeAttribute('data-perf-dehydrated');
            mes.removeAttribute('data-perf-height');
            mes.style.height = '';
            mes.style.minHeight = '';
            mes.style.overflow = '';
            mes.style.contentVisibility = '';
        }

        // Mark for editing (activates CSS relaxation)
        mes.setAttribute(EDITING_ATTR, '1');
    }

    /**
     * @private
     * Schedule unmarking a message after a delay.
     * This handles the case where focus briefly leaves and returns.
     * @param {HTMLElement} mes
     */
    _scheduleUnmark(mes) {
        // Cancel existing timer for this message
        const existing = this._unmarkTimers.get(mes);
        if (existing) clearTimeout(existing);

        const timer = setTimeout(() => {
            this._unmarkTimers.delete(mes);

            // Only unmark if no textarea inside this message has focus
            const activeEl = document.activeElement;
            if (activeEl?.closest?.('.mes') === mes) return;

            // Check if edit buttons are still visible (edit not yet saved)
            if (mes.querySelector('.edit_textarea, .reasoning_edit_textarea')) return;

            mes.removeAttribute(EDITING_ATTR);
        }, 500);

        this._unmarkTimers.set(mes, timer);
    }

    // ================================================================
    // Cleanup
    // ================================================================

    /** @private */
    _clearAllTimers() {
        for (const timer of this._unmarkTimers.values()) {
            clearTimeout(timer);
        }
        this._unmarkTimers.clear();
    }
}
