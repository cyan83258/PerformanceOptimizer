/**
 * Mobile Layout Stabilizer Module
 *
 * ROOT CAUSE: mobile-styles.css uses 100dvh/100vh in 16+ places.
 * When the virtual keyboard opens, dvh shrinks → ALL these elements
 * recalculate height → massive layout thrashing.
 *
 * This module eliminates the root cause by:
 *   1. Capturing the full viewport height ONCE on page load
 *   2. Injecting CSS that overrides every dvh/vh reference with
 *      stable CSS custom properties (--stable-h, --stable-h-XX)
 *   3. Applying CSS containment on layout-critical containers
 *   4. Promoting key elements to GPU compositor layers
 *   5. Only updating the stable height on orientation change
 *
 * This means when the keyboard opens, ZERO layout recalculation
 * happens on background, panels, drawers, etc.
 */

const LOG = '[PerfOpt/LayoutStab]';
const STYLE_ID = 'perf-opt-layout-stab';

export class MobileLayoutStabilizer {
    constructor() {
        this.active = false;

        /** @type {number} Stable full-screen height in px */
        this._stableHeight = 0;

        /** @type {HTMLStyleElement|null} */
        this._styleEl = null;

        /** @type {Function|null} */
        this._orientHandler = null;

        /** @type {number|null} */
        this._orientTimer = null;
    }

    // ── Public API ──────────────────────────────────────────────────

    enable() {
        if (this.active) return;
        if (!this._isMobile()) {
            console.log(`${LOG} Desktop detected, skipping`);
            return;
        }

        this._stableHeight = this._measureFullHeight();
        this._setCSSVars();
        this._injectStableCSS();
        this._bindOrientationChange();

        this.active = true;
        console.log(`${LOG} Enabled (stable height: ${this._stableHeight}px)`);
    }

    disable() {
        if (!this.active) return;
        this._unbindOrientationChange();
        this._removeCSS();
        this._removeCSSVars();
        if (this._orientTimer) {
            clearTimeout(this._orientTimer);
            this._orientTimer = null;
        }
        this.active = false;
    }

    /** @returns {number} The current stable viewport height */
    get stableHeight() {
        return this._stableHeight;
    }

    // ── Measurement ─────────────────────────────────────────────────

    /** @private */
    _isMobile() {
        return (
            'ontouchstart' in window ||
            navigator.maxTouchPoints > 0 ||
            window.innerWidth <= 1000 ||
            /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
        );
    }

    /**
     * @private
     * Get the full viewport height (large viewport = no keyboard).
     * Uses window.screen.height as a sanity-check upper bound.
     */
    _measureFullHeight() {
        // visualViewport.height is the VISIBLE area (shrinks with keyboard)
        // window.innerHeight also shrinks on some browsers
        // On initial load (no keyboard), both should be the full height
        const vv = window.visualViewport?.height ?? 0;
        const inner = window.innerHeight;
        // Use the larger of the two as the stable reference
        return Math.max(vv, inner);
    }

    // ── CSS Custom Properties ───────────────────────────────────────

    /** @private */
    _setCSSVars() {
        const h = this._stableHeight;
        const root = document.documentElement.style;
        // Main stable height (replaces 100dvh)
        root.setProperty('--stable-h', `${h}px`);
        // Pre-calculated common offsets (replaces calc(100dvh - Xpx))
        root.setProperty('--stable-h-36', `${h - 36}px`);
        root.setProperty('--stable-h-45', `${h - 45}px`);
        root.setProperty('--stable-h-70', `${h - 70}px`);
        root.setProperty('--stable-h-90', `${h - 90}px`);
        // 1% unit (replaces 1dvh)
        root.setProperty('--stable-vh', `${h * 0.01}px`);
    }

    /** @private */
    _removeCSSVars() {
        const root = document.documentElement.style;
        ['--stable-h', '--stable-h-36', '--stable-h-45', '--stable-h-70',
         '--stable-h-90', '--stable-vh', '--keyboard-height'].forEach(
            v => root.removeProperty(v),
        );
    }

    // ── Stable CSS Injection ────────────────────────────────────────

    /**
     * @private
     * Override EVERY dvh/vh height in mobile-styles.css with stable values.
     * Also applies CSS containment and GPU layer promotion.
     */
    _injectStableCSS() {
        this._removeCSS();
        this._styleEl = document.createElement('style');
        this._styleEl.id = STYLE_ID;
        this._styleEl.textContent = this._buildCSS();
        document.head.appendChild(this._styleEl);
    }

    /** @private */
    _removeCSS() {
        if (this._styleEl) {
            this._styleEl.remove();
            this._styleEl = null;
        }
    }

    /**
     * @private
     * Build the complete override CSS.
     * Each rule directly counters a specific dvh/vh usage in mobile-styles.css.
     */
    _buildCSS() {
        return `
/* ================================================================
   [PerfOpt] Mobile Layout Stabilizer
   Replaces all dvh/vh heights with stable px-based CSS vars.
   Applies containment and GPU promotion for zero-reflow layout.
   ================================================================ */

@media screen and (max-width: 1000px) {

    /* ── Background (mobile-styles.css L226-227) ──────────────────
       Original: height: 100dvh !important
       Problem:  Resizes with keyboard → background repaints */
    #bg1,
    #bg_custom {
        height: var(--stable-h) !important;
        contain: size layout style paint;
    }

    /* ── Drawers (mobile-styles.css L192-193) ─────────────────────
       Original: max-height: calc(100dvh - 45px)
       Problem:  Shrinks with keyboard → drawer reflows */
    .drawer-content {
        max-height: var(--stable-h-45) !important;
    }

    /* ── Sheld container (mobile-styles.css L527-528) ─────────────
       Original: height: calc(100dvh - 36px)
       Problem:  Main container resizes → chat + input reflow */
    #sheld {
        height: var(--stable-h-36) !important;
        contain: layout style;
    }

    /* ── PWA sheld adjustment ─────────────────────────────────────
       Preserves PWA safe-area padding behavior */
    body.PWA #sheld {
        height: var(--stable-h-36) !important;
    }

    /* ── Nav panels (mobile-styles.css L308-309) ──────────────────
       Original: height: calc(100dvh - 45px)
       Problem:  ALL panels resize even when hidden */
    #right-nav-panel,
    #left-nav-panel,
    #floatingPrompt,
    #cfgConfig,
    #logprobsViewer,
    #movingDivs > div {
        height: var(--stable-h-45) !important;
    }

    /* ── Scrollable inner (mobile-styles.css L425-426) ────────────
       Original: max-height: calc(100dvh - 90px) */
    .scrollableInner {
        max-height: var(--stable-h-90) !important;
    }

    /* ── Popups & drawers (mobile-styles.css L557-558, L560-561) ──
       Original: height/max-height: calc(100dvh - 70px) */
    #character_popup,
    #world_popup,
    #left-nav-panel,
    #right-nav-panel,
    .drawer-content {
        max-height: var(--stable-h-70) !important;
    }

    /* Only apply height to popup/panel elements that use it */
    #character_popup,
    #world_popup {
        height: var(--stable-h-70) !important;
    }

    /* ── Waifu mode (mobile-styles.css L396, L416-417) ────────────
       Original: height: 100vh / max-height: calc(60dvh - 60px) */
    body.waifuMode .expression-holder {
        height: var(--stable-h) !important;
    }
    body.waifuMode .zoomed_avatar {
        max-height: calc(var(--stable-h) * 0.6 - 60px) !important;
    }

    /* ── CSS Containment ──────────────────────────────────────────
       Isolate layout recalculation to specific containers */
    #chat {
        contain: content;
        -webkit-overflow-scrolling: touch;
    }

    #form_sheld {
        contain: layout style;
    }

    #send_form {
        contain: layout style;
    }

    body {
        /* Prevent iOS rubber-band scroll on body during keyboard */
        overscroll-behavior: none;
    }
}
`;
    }

    // ── Orientation Change ──────────────────────────────────────────

    /** @private */
    _bindOrientationChange() {
        this._orientHandler = () => {
            // Wait for orientation animation to complete before re-measuring
            if (this._orientTimer) clearTimeout(this._orientTimer);
            this._orientTimer = setTimeout(() => {
                this._stableHeight = this._measureFullHeight();
                this._setCSSVars();
                // Re-inject CSS (vars are in :root, but just in case)
                if (this._styleEl) {
                    this._styleEl.textContent = this._buildCSS();
                }
                console.log(`${LOG} Orientation changed, new height: ${this._stableHeight}px`);
                this._orientTimer = null;
            }, 500);
        };

        // Use both events for maximum compatibility
        window.addEventListener('orientationchange', this._orientHandler, { passive: true });
        // Screen orientation API (modern browsers)
        screen.orientation?.addEventListener('change', this._orientHandler, { passive: true });
    }

    /** @private */
    _unbindOrientationChange() {
        if (this._orientHandler) {
            window.removeEventListener('orientationchange', this._orientHandler);
            screen.orientation?.removeEventListener('change', this._orientHandler);
            this._orientHandler = null;
        }
    }
}
