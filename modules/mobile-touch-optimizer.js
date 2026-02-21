/**
 * Mobile Touch Optimizer Module v2
 *
 * Improves mobile touch responsiveness through CSS-driven optimizations.
 *
 * v2 changes from v1:
 *   - Removed dead MutationObserver on textarea style changes (did nothing)
 *   - Removed dead scroll throttle handlers (added overhead without benefit)
 *   - Added overscroll prevention on touch to prevent iOS rubber-band effect
 *   - Added edit button touch-action for message edit buttons
 *   - Cleaner CSS with hover transition disabling
 *
 * Optimizations:
 *   1. Eliminates 300ms tap delay via touch-action: manipulation
 *   2. Enables momentum scrolling with overscroll containment
 *   3. Prevents double-tap-to-zoom on input areas
 *   4. Prevents pull-to-refresh interference with #sheld
 *   5. Prevents iOS elastic overscroll on non-scrollable areas
 *   6. Disables hover-triggered transitions (irrelevant on touch)
 *   7. Removes tap highlight delay for instant visual feedback
 *
 * @version 2.0.0
 */

const LOG = '[PerfOpt/TouchOpt]';
const STYLE_ID = 'perf-opt-touch-css-v2';

export class MobileTouchOptimizer {
    constructor() {
        this.active = false;

        /** @type {HTMLStyleElement|null} */
        this._styleEl = null;

        /** @type {Function|null} */
        this._onTouchStart = null;
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
        this._setupOverscrollPrevention();

        this.active = true;
        console.log(`${LOG} v2 Enabled`);
    }

    disable() {
        if (!this.active) return;
        this._removeCSS();
        this._removeOverscrollPrevention();
        this.active = false;
    }

    // ================================================================
    // Detection
    // ================================================================

    /** @private */
    _isMobile() {
        return (
            'ontouchstart' in window ||
            navigator.maxTouchPoints > 0 ||
            window.innerWidth <= 1000 ||
            /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
        );
    }

    // ================================================================
    // CSS Optimizations
    // ================================================================

    /** @private */
    _injectCSS() {
        this._removeCSS();
        this._styleEl = document.createElement('style');
        this._styleEl.id = STYLE_ID;
        this._styleEl.textContent = `
/* ================================================================
   [PerfOpt] Mobile Touch Optimizer v2
   ================================================================ */

@media screen and (max-width: 1000px) {

    /* ── Eliminate 300ms tap delay ────────────────────────────────
       touch-action: manipulation removes the delay while keeping
       pinch-zoom and panning available. */
    #send_but,
    #option_regenerate,
    #option_continue,
    .mes_buttons .mes_button,
    .mes_edit_buttons button,
    .drawer-icon,
    .inline-drawer-toggle,
    .menu_button,
    .right_menu_button,
    a, button, [role="button"] {
        touch-action: manipulation;
    }

    /* ── Input area touch optimization ────────────────────────────
       Prevents double-tap zoom on textarea area. */
    #send_textarea,
    #send_form,
    #form_sheld,
    .mes textarea {
        touch-action: manipulation;
    }

    /* ── Momentum scroll + overscroll containment ────────────────
       Smooth native scrolling, prevents scroll chaining. */
    #chat,
    .drawer-content,
    #right-nav-panel .right_menu_inner,
    #left-nav-panel .left_menu_inner,
    .scrollableInner {
        -webkit-overflow-scrolling: touch;
        overscroll-behavior-y: contain;
    }

    /* ── Prevent body overscroll ──────────────────────────────────
       Stops iOS rubber-banding on body which causes layout jumps. */
    body, html {
        overscroll-behavior: none;
    }

    /* ── Remove tap highlight ────────────────────────────────────
       Instant visual feedback, no highlight flash. */
    * {
        -webkit-tap-highlight-color: transparent;
    }

    /* ── Container overscroll containment ─────────────────────── */
    #sheld {
        overscroll-behavior-y: contain;
    }

    /* ── Disable hover transitions on touch devices ──────────────
       Hover effects are meaningless on touch and add overhead. */
    @media (hover: none) and (pointer: coarse) {
        .mes:hover,
        .menu_button:hover,
        .right_menu_button:hover,
        .list-group-item:hover {
            transition-duration: 0s !important;
        }
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
        // Remove v1 style if present (upgrade path)
        document.getElementById('perf-opt-touch-css')?.remove();
    }

    // ================================================================
    // Overscroll Prevention
    // ================================================================

    /**
     * @private
     * Prevent iOS elastic overscroll at the boundaries of scroll containers.
     * When a scrollable element is at the very top or bottom, a touch-scroll
     * would trigger the iOS rubber-band effect on the parent, causing a
     * visual bounce and layout recalculation.
     *
     * This nudges scrollTop by 1px when at the boundary so the browser
     * sees the element as "scrolled" and keeps the scroll internal.
     */
    _setupOverscrollPrevention() {
        this._onTouchStart = (e) => {
            const el = e.target.closest(
                '#chat, .drawer-content, .scrollableInner, .popup-content',
            );
            if (!el) return;

            if (el.scrollTop <= 0) {
                el.scrollTop = 1;
            } else if (el.scrollTop + el.clientHeight >= el.scrollHeight) {
                el.scrollTop = el.scrollHeight - el.clientHeight - 1;
            }
        };

        document.addEventListener('touchstart', this._onTouchStart, { passive: true });
    }

    /** @private */
    _removeOverscrollPrevention() {
        if (this._onTouchStart) {
            document.removeEventListener('touchstart', this._onTouchStart);
            this._onTouchStart = null;
        }
    }
}
