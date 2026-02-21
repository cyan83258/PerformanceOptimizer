/**
 * Mobile Input Optimizer Module
 *
 * Eliminates lag when entering message edit mode and interacting with
 * textareas on mobile devices.
 *
 * Problems addressed:
 *   1. Tapping "edit" on a message causes layout thrashing as the edit
 *      textarea appears and the virtual keyboard opens simultaneously.
 *   2. SillyTavern's textarea auto-resize triggers forced reflows.
 *   3. Programmatic focus calls cause unwanted scroll jumps.
 *   4. Dehydrated messages (from chat virtualizer) can't be edited.
 *
 * Optimizations:
 *   1. Edit Mode Detection
 *      - Detects focus on textareas inside .mes elements
 *      - Marks the message with data-perf-editing for CSS relaxation
 *      - Removes dehydration barriers so edit UI can render
 *
 *   2. Focus Management
 *      - Patches focus() to use preventScroll on textareas
 *      - Prevents browser auto-scroll that causes layout shifts
 *
 *   3. Textarea Resize Batching
 *      - Batches rapid textarea style changes into single rAF
 *      - Reduces layout thrashing during fast typing
 *
 *   4. Edit-Specific CSS
 *      - Relaxes containment on messages being edited
 *      - Ensures content-visibility doesn't block edit textareas
 *
 * @version 1.0.0
 */

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

        /** @type {MutationObserver|null} */
        this._resizeObserver = null;
        /** @type {MutationObserver|null} */
        this._chatObserver = null;

        /** @type {WeakSet<HTMLElement>} Patched focus elements */
        this._patched = new WeakSet();

        /** @type {number|null} */
        this._resizeRafId = null;

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
        this._setupTextareaResizeBatcher();

        this.active = true;
        console.log(`${LOG} Enabled`);
    }

    disable() {
        if (!this.active) return;
        this._removeCSS();
        this._removeEditDetector();
        this._removeTextareaResizeBatcher();
        this._restoreAllFocus();
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
     *   3. Patch focus to use preventScroll
     * When focus leaves:
     *   1. Wait briefly (user might refocus)
     *   2. Unmark message
     */
    _setupEditDetector() {
        this._onFocusIn = (e) => {
            const el = e.target;
            if (!el) return;

            // Patch focus on any textarea to use preventScroll
            if (el.tagName === 'TEXTAREA') {
                this._patchFocus(el);
            }

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
            const editBtns = mes.querySelector('.mes_edit_buttons');
            if (editBtns && editBtns.style.display !== 'none') return;

            mes.removeAttribute(EDITING_ATTR);
        }, 500);

        this._unmarkTimers.set(mes, timer);
    }

    // ================================================================
    // Focus Patching (preventScroll)
    // ================================================================

    /**
     * @private
     * Patch an element's focus() to always use preventScroll.
     * Prevents the browser from auto-scrolling when focusing inputs,
     * which causes jarring layout shifts on mobile.
     * @param {HTMLElement} el
     */
    _patchFocus(el) {
        if (this._patched.has(el)) return;
        this._patched.add(el);

        const orig = el.focus.bind(el);
        el._origFocus = orig;
        el.focus = (opts) => {
            orig({ preventScroll: true, ...opts });
        };
    }

    /** @private Restore original focus on known elements. */
    _restoreAllFocus() {
        // Restore #send_textarea
        const send = document.getElementById('send_textarea');
        if (send?._origFocus) {
            send.focus = send._origFocus;
            delete send._origFocus;
        }
        // Restore any still-in-DOM edit textareas
        document.querySelectorAll('.mes textarea').forEach(el => {
            if (el._origFocus) {
                el.focus = el._origFocus;
                delete el._origFocus;
            }
        });
    }

    // ================================================================
    // Textarea Resize Batching
    // ================================================================

    /**
     * @private
     * SillyTavern sets textarea height via JS on every input event.
     * Each height change is an inline style mutation that can trigger
     * a forced reflow if followed by a layout read.
     *
     * We observe style mutations on textareas and ensure any pending
     * layout is batched into a single animation frame, preventing
     * the read-write-read-write pattern that causes layout thrashing.
     */
    _setupTextareaResizeBatcher() {
        this._resizeObserver = new MutationObserver((mutations) => {
            for (const m of mutations) {
                if (m.attributeName !== 'style') continue;
                if (m.target.tagName !== 'TEXTAREA') continue;

                // Coalesce into a single rAF to batch the layout
                if (!this._resizeRafId) {
                    this._resizeRafId = requestAnimationFrame(() => {
                        this._resizeRafId = null;
                    });
                }
            }
        });

        // Observe #send_textarea
        const sendTA = document.getElementById('send_textarea');
        if (sendTA) {
            this._resizeObserver.observe(sendTA, {
                attributes: true,
                attributeFilter: ['style'],
            });
        }

        // Watch for dynamically-added edit textareas in #chat
        const chat = document.getElementById('chat');
        if (chat) {
            this._chatObserver = new MutationObserver((mutations) => {
                for (const m of mutations) {
                    for (const node of m.addedNodes) {
                        if (node.nodeType !== Node.ELEMENT_NODE) continue;
                        const ta = node.tagName === 'TEXTAREA'
                            ? node
                            : node.querySelector?.('textarea');
                        if (ta) {
                            this._resizeObserver.observe(ta, {
                                attributes: true,
                                attributeFilter: ['style'],
                            });
                        }
                    }
                }
            });
            this._chatObserver.observe(chat, { childList: true, subtree: true });
        }
    }

    /** @private */
    _removeTextareaResizeBatcher() {
        if (this._resizeObserver) {
            this._resizeObserver.disconnect();
            this._resizeObserver = null;
        }
        if (this._chatObserver) {
            this._chatObserver.disconnect();
            this._chatObserver = null;
        }
        if (this._resizeRafId) {
            cancelAnimationFrame(this._resizeRafId);
            this._resizeRafId = null;
        }
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
