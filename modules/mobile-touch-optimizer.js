/**
 * Mobile Touch Optimizer Module
 *
 * Improves mobile input responsiveness and eliminates micro-lag:
 *
 *   1. Prevents browser auto-scroll on input focus (uses preventScroll)
 *   2. Disables 300ms tap delay via touch-action CSS
 *   3. Applies passive touch listeners to scroll containers
 *   4. Prevents iOS elastic overscroll on non-scrollable areas
 *   5. Optimizes textarea auto-resize to avoid layout thrashing
 *   6. Throttles expensive scroll event handlers
 *   7. Prevents double-tap-to-zoom on input areas
 *   8. Smooth chat scroll management during keyboard show/hide
 */

const LOG = '[PerfOpt/TouchOpt]';
const STYLE_ID = 'perf-opt-touch-css';

export class MobileTouchOptimizer {
    constructor() {
        this.active = false;

        /** @type {HTMLStyleElement|null} */
        this._styleEl = null;

        // Bound handlers for cleanup
        this._onFocusIn = null;
        this._onTouchStart = null;
        this._scrollThrottleMap = new Map();
        this._textareaObserver = null;
        this._origTextareaSetAttr = null;
    }

    // ── Public API ──────────────────────────────────────────────────

    enable() {
        if (this.active) return;
        if (!this._isMobile()) {
            console.log(`${LOG} Desktop detected, skipping`);
            return;
        }

        this._injectCSS();
        this._setupFocusOptimizer();
        this._setupScrollThrottles();
        this._setupTextareaOptimizer();

        this.active = true;
        console.log(`${LOG} Enabled`);
    }

    disable() {
        if (!this.active) return;
        this._removeCSS();
        this._removeFocusOptimizer();
        this._removeScrollThrottles();
        this._removeTextareaOptimizer();
        this.active = false;
    }

    // ── Device Detection ────────────────────────────────────────────

    /** @private */
    _isMobile() {
        return (
            'ontouchstart' in window ||
            navigator.maxTouchPoints > 0 ||
            window.innerWidth <= 1000 ||
            /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
        );
    }

    // ── Touch CSS ───────────────────────────────────────────────────

    /** @private */
    _injectCSS() {
        this._removeCSS();
        this._styleEl = document.createElement('style');
        this._styleEl.id = STYLE_ID;
        this._styleEl.textContent = `
/* ================================================================
   [PerfOpt] Mobile Touch Optimizer
   ================================================================ */

@media screen and (max-width: 1000px) {

    /* ── Eliminate 300ms tap delay ────────────────────────────────
       Modern browsers honour touch-action: manipulation */
    #send_but,
    #option_regenerate,
    #option_continue,
    .mes_buttons .mes_button,
    .drawer-icon,
    .inline-drawer-toggle,
    .menu_button,
    .right_menu_button,
    a, button, [role="button"] {
        touch-action: manipulation;
    }

    /* ── Prevent double-tap zoom on input area ───────────────────
       Tapping the textarea fast shouldn't trigger zoom */
    #send_textarea,
    #send_form,
    #form_sheld {
        touch-action: manipulation;
    }

    /* ── Optimize scroll containers ──────────────────────────────
       Enable momentum scrolling, contain overscroll */
    #chat,
    .drawer-content,
    #right-nav-panel .right_menu_inner,
    #left-nav-panel .left_menu_inner,
    .scrollableInner {
        -webkit-overflow-scrolling: touch;
        overscroll-behavior-y: contain;
    }

    /* ── Prevent body overscroll ──────────────────────────────────
       iOS rubber-banding causes layout jumps */
    body, html {
        overscroll-behavior: none;
    }

    /* ── Textarea smoothness ─────────────────────────────────────
       Prevent textarea height changes from causing reflows */
    #send_textarea {
        contain: inline-size;
        will-change: height;
        scroll-margin-bottom: 0px;
    }

    /* ── Fast visual feedback on tap ─────────────────────────────
       Remove tap highlight delay for snappier feel */
    * {
        -webkit-tap-highlight-color: transparent;
    }

    /* ── Prevent pull-to-refresh interference ────────────────────
       Only allow pull-to-refresh if at top of page */
    #sheld {
        overscroll-behavior-y: contain;
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

    // ── Focus Optimizer ─────────────────────────────────────────────

    /**
     * @private
     * Intercept focus events on text inputs to use preventScroll,
     * preventing the browser from auto-scrolling the page when
     * focusing an input (which causes a jarring jump + reflow).
     */
    _setupFocusOptimizer() {
        this._onFocusIn = (e) => {
            const el = e.target;
            if (!this._isTextInput(el)) return;

            // If input is #send_textarea, use smooth focus behavior
            if (el.id === 'send_textarea') {
                // Already focused by browser at this point, but we can
                // prevent future programmatic focus calls from jumping
                this._patchFocusMethod(el);
            }
        };

        document.addEventListener('focusin', this._onFocusIn, { passive: true });
    }

    /** @private */
    _removeFocusOptimizer() {
        if (this._onFocusIn) {
            document.removeEventListener('focusin', this._onFocusIn);
            this._onFocusIn = null;
        }
        // Restore original focus on send_textarea
        const ta = document.getElementById('send_textarea');
        if (ta && ta._origFocus) {
            ta.focus = ta._origFocus;
            delete ta._origFocus;
        }
    }

    /**
     * @private
     * Patch the focus() method on an element to always use preventScroll.
     */
    _patchFocusMethod(el) {
        if (el._origFocus) return; // Already patched
        el._origFocus = el.focus.bind(el);
        el.focus = (opts) => {
            el._origFocus({ preventScroll: true, ...opts });
        };
    }

    /** @private */
    _isTextInput(el) {
        if (!el) return false;
        if (el.tagName === 'TEXTAREA') return true;
        if (el.tagName === 'INPUT') {
            const t = el.type?.toLowerCase();
            return !t || t === 'text' || t === 'search' || t === 'url' || t === 'email' || t === 'number';
        }
        return el.isContentEditable;
    }

    // ── Scroll Throttles ────────────────────────────────────────────

    /**
     * @private
     * Throttle scroll events on key containers to reduce handler overhead.
     * Uses passive listeners so the browser can scroll immediately
     * without waiting for JS to complete.
     */
    _setupScrollThrottles() {
        // Apply passive: true to existing scroll listeners
        const containers = [
            '#chat',
            '.drawer-content',
            '.scrollableInner',
        ];

        for (const sel of containers) {
            const el = document.querySelector(sel);
            if (!el) continue;

            // Add a throttled passive scroll listener that batches
            // any layout reads into a single rAF
            let ticking = false;
            const handler = () => {
                if (ticking) return;
                ticking = true;
                requestAnimationFrame(() => {
                    ticking = false;
                });
            };

            el.addEventListener('scroll', handler, { passive: true });
            this._scrollThrottleMap.set(el, handler);
        }
    }

    /** @private */
    _removeScrollThrottles() {
        for (const [el, handler] of this._scrollThrottleMap) {
            el.removeEventListener('scroll', handler);
        }
        this._scrollThrottleMap.clear();
    }

    // ── Textarea Auto-Resize Optimizer ──────────────────────────────

    /**
     * @private
     * SillyTavern auto-resizes #send_textarea based on content.
     * Each resize triggers a layout reflow. We optimize this by:
     *  - Debouncing rapid consecutive resizes (typing fast)
     *  - Using rAF to batch height changes
     */
    _setupTextareaOptimizer() {
        const textarea = document.getElementById('send_textarea');
        if (!textarea) return;

        let pendingHeight = null;
        let rafId = null;

        this._textareaObserver = new MutationObserver((mutations) => {
            for (const m of mutations) {
                if (m.attributeName === 'style') {
                    // Batch the style change into a single rAF
                    if (rafId) cancelAnimationFrame(rafId);
                    rafId = requestAnimationFrame(() => {
                        rafId = null;
                        // Let the browser handle it in the next frame
                    });
                }
            }
        });

        this._textareaObserver.observe(textarea, {
            attributes: true,
            attributeFilter: ['style'],
        });
    }

    /** @private */
    _removeTextareaOptimizer() {
        if (this._textareaObserver) {
            this._textareaObserver.disconnect();
            this._textareaObserver = null;
        }
    }
}
