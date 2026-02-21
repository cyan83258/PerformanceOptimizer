/**
 * Mobile Keyboard Optimizer v4
 *
 * Eliminates keyboard open/close lag through adaptive freeze layers.
 *
 * v4 improvements over v3:
 *   - Faster timing: STABLE_MS 250→100ms, FOCUS_TIMEOUT 600→350ms
 *   - Smart skip: No freeze when switching inputs with keyboard already open
 *   - Relaxed containment: layout+style instead of strict (allows edit UI)
 *   - Single-frame unfreeze: No nested rAF delays
 *   - Refreeze cooldown: Prevents rapid freeze/unfreeze cycling
 *   - Better focusout: Uses relatedTarget + rAF fallback
 *
 * Layer 1 — Focus Pre-Freeze
 *   Detects focusin/focusout on keyboard-triggering elements.
 *   Applies freeze BEFORE keyboard starts animating.
 *   SKIPS freeze when keyboard is already open (input-to-input switch).
 *
 * Layer 2 — Resize Suppression
 *   Capture-phase window.resize blocks propagation during freeze.
 *   Prevents SillyTavern's 5+ resize handlers from running.
 *
 * Layer 3 — CSS Freeze (class-toggled, permanent stylesheet)
 *   body.perf-kb-freeze activates transition/animation/containment rules.
 *   Relaxed containment (layout+style) so edit UIs can render.
 *   No inject/remove overhead — just class toggle.
 *
 * Stability-based unfreeze:
 *   Viewport must be stable for 100ms (down from 250ms).
 *   Single rAF unfreeze (down from nested double rAF).
 *
 * Coordinates with other modules via:
 *   - body.perf-kb-freeze  (freeze active)
 *   - body.perf-kb-open    (keyboard visible)
 *   - CSS var --perf-kb-h   (keyboard height in px)
 *   - CustomEvent 'perf-keyboard-state' on document
 *
 * @version 4.0.0
 */

const LOG = '[PerfOpt/MobileKB]';
const STYLE_ID = 'perf-opt-kb-v4';
const FREEZE_CLASS = 'perf-kb-freeze';
const OPEN_CLASS = 'perf-kb-open';

/** Minimum viewport shrink to consider keyboard open (px). */
const KB_THRESHOLD = 80;

/** Viewport must be stable for this long to unfreeze (ms). */
const STABLE_MS = 100;

/** Safety net — never freeze longer than this (ms). */
const MAX_FREEZE_MS = 800;

/** Maximum time to wait for keyboard after focus event (ms). */
const FOCUS_TIMEOUT_MS = 350;

/** Minimum gap between unfreeze and next freeze (ms). */
const REFREEZE_COOLDOWN_MS = 60;

/** Selector for elements that trigger the virtual keyboard. */
const KB_INPUT = [
    'textarea',
    'input[type="text"]',
    'input[type="search"]',
    'input[type="url"]',
    'input[type="email"]',
    'input[type="password"]',
    'input:not([type])',
    '[contenteditable="true"]',
].join(',');

/**
 * Ancestor selectors for UI panels/drawers/popups.
 * Inputs inside these containers should NOT trigger a layout freeze,
 * because the freeze CSS (containment, content-visibility) can cause
 * menus and panels to visually close or break.
 *
 * Only #send_textarea and textareas inside #chat should trigger freeze.
 */
const PANEL_ANCESTORS = [
    '#right-nav-panel',
    '#left-nav-panel',
    '.drawer-content',
    '.popup',
    '.popup-content',
    '#character_popup',
    '#world_popup',
    '#floatingPrompt',
    '#cfgConfig',
    '#shadow_popup',
    '.shadow_popup',
    '#extensions_settings',
    '#extensions_settings2',
    '#movingDivs',
].join(',');

// ─────────────────────────────────────────────────────────────────
// Freeze CSS — activated solely by body class toggle.
// v4: Relaxed containment (layout+style, not strict/paint) so
//     edit textareas and other dynamic UI can render during freeze.
// ─────────────────────────────────────────────────────────────────
const FREEZE_CSS = `
/* === PerfOptimizer: Keyboard Freeze v4 === */

/* Prevent browser-fixes.js fixFunkyPositioning from setting
   position:fixed on <html> (causes 2 forced layouts per resize). */
html.${FREEZE_CLASS} {
    position: static !important;
}

/* Disable transitions & animations on major layout containers. */
body.${FREEZE_CLASS} #bg1,
body.${FREEZE_CLASS} #bg_custom,
body.${FREEZE_CLASS} #sheld,
body.${FREEZE_CLASS} #top-bar,
body.${FREEZE_CLASS} #top-settings-holder,
body.${FREEZE_CLASS} .drawer-content,
body.${FREEZE_CLASS} #left-nav-panel,
body.${FREEZE_CLASS} #right-nav-panel,
body.${FREEZE_CLASS} #floatingPrompt,
body.${FREEZE_CLASS} #cfgConfig,
body.${FREEZE_CLASS} #send_form,
body.${FREEZE_CLASS} #form_sheld,
body.${FREEZE_CLASS} .scrollableInner,
body.${FREEZE_CLASS} #character_popup,
body.${FREEZE_CLASS} #world_popup,
body.${FREEZE_CLASS} .popup,
body.${FREEZE_CLASS} .popup-content,
body.${FREEZE_CLASS} .mes,
body.${FREEZE_CLASS} #chat {
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    animation-duration: 0s !important;
    animation-delay: 0s !important;
}

/* Remove expensive backdrop-filter during transition. */
body.${FREEZE_CLASS} #send_form,
body.${FREEZE_CLASS} .drawer-content,
body.${FREEZE_CLASS} #left-nav-panel,
body.${FREEZE_CLASS} #right-nav-panel,
body.${FREEZE_CLASS} #top-bar,
body.${FREEZE_CLASS} #top-settings-holder,
body.${FREEZE_CLASS} .popup,
body.${FREEZE_CLASS} .popup-content {
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
}

/* Relaxed containment — layout+style only.
   Only applied to #chat and #form_sheld (the actual chat area).
   v3/v4.0 applied contain to #sheld which broke drawers/panels
   opening inside it. v4.1 scopes containment to chat-only elements. */
body.${FREEZE_CLASS} #chat {
    contain: layout style;
    overflow-anchor: none !important;
}
body.${FREEZE_CLASS} #form_sheld {
    contain: layout style;
}

/* Hide closed panels entirely during transition. */
body.${FREEZE_CLASS} .drawer:not(.openDrawer) > .drawer-content,
body.${FREEZE_CLASS} #right-nav-panel:not(.openDrawer),
body.${FREEZE_CLASS} #left-nav-panel:not(.openDrawer) {
    content-visibility: hidden !important;
}

/* Ensure OPEN panels/drawers are NEVER affected by freeze containment.
   This prevents the "menu closes when tapping input" bug. */
body.${FREEZE_CLASS} .drawer.openDrawer > .drawer-content,
body.${FREEZE_CLASS} #right-nav-panel.openDrawer,
body.${FREEZE_CLASS} #left-nav-panel.openDrawer,
body.${FREEZE_CLASS} .popup,
body.${FREEZE_CLASS} .popup-content,
body.${FREEZE_CLASS} .shadow_popup {
    contain: none !important;
    content-visibility: visible !important;
}

/* Ensure messages being edited can render even during freeze. */
body.${FREEZE_CLASS} .mes[data-perf-editing="1"] {
    contain: none !important;
    content-visibility: visible !important;
}
`.trim();

// ─────────────────────────────────────────────────────────────────

export class MobileKeyboardOptimizer {
    constructor() {
        this.active = false;

        /** @type {boolean} Freeze currently active */
        this._frozen = false;
        /** @type {boolean} Keyboard currently visible */
        this._kbOpen = false;

        /** @type {number} Full viewport height (no keyboard) */
        this._fullH = 0;
        /** @type {number} Last recorded viewport height */
        this._lastH = 0;
        /** @type {number} Timestamp of last unfreeze */
        this._lastUnfreezeTime = 0;

        // Timers
        /** @type {number|null} */ this._stableTimer = null;
        /** @type {number|null} */ this._safetyTimer = null;
        /** @type {number|null} */ this._focusTimer = null;
        /** @type {number|null} */ this._rafId = null;

        /** @type {number} Saved chat scroll position */
        this._scrollPos = 0;

        /** @type {HTMLStyleElement|null} */
        this._styleEl = null;

        // Bound handler refs for cleanup
        /** @type {Function|null} */ this._onVVResize = null;
        /** @type {Function|null} */ this._onResizeCapture = null;
        /** @type {Function|null} */ this._onFocusIn = null;
        /** @type {Function|null} */ this._onFocusOut = null;

        /** @type {Set<Function>} State change subscribers */
        this._listeners = new Set();
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

        this._fullH = this._measureHeight();
        this._lastH = this._fullH;

        this._injectPermanentCSS();
        this._bindFocusEvents();
        this._bindVisualViewport();
        this._bindResizeGuard();

        this.active = true;
        console.log(`${LOG} v4 enabled (viewport: ${this._fullH}px)`);
    }

    disable() {
        this._unbindAll();
        this._unfreeze();
        this._removePermanentCSS();
        this._clearAllTimers();
        this._kbOpen = false;
        document.body?.classList.remove(OPEN_CLASS);
        document.documentElement?.classList.remove(FREEZE_CLASS);
        this.active = false;
    }

    /** Subscribe to state changes. Returns unsubscribe function. */
    onStateChange(fn) {
        this._listeners.add(fn);
        return () => this._listeners.delete(fn);
    }

    /** @returns {boolean} */
    get isKeyboardVisible() { return this._kbOpen; }

    /** @returns {number} Current keyboard height in px. */
    get keyboardHeight() {
        return Math.max(0, this._fullH - (window.visualViewport?.height ?? window.innerHeight));
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

    /** @private */
    _measureHeight() {
        const vv = window.visualViewport?.height ?? 0;
        return Math.max(vv, window.innerHeight);
    }

    /**
     * @private
     * Check if an element is inside a settings panel, drawer, or popup.
     * These containers should not trigger a freeze because the freeze CSS
     * (containment changes, content-visibility) can break their layout
     * and cause menus to visually close.
     * @param {Element} el
     * @returns {boolean}
     */
    _isInsidePanel(el) {
        return !!el.closest(PANEL_ANCESTORS);
    }

    // ================================================================
    // Layer 1 — Focus Pre-Freeze (Smart Skip)
    // ================================================================

    /** @private */
    _bindFocusEvents() {
        this._onFocusIn = (e) => {
            const el = e.target;
            if (!el?.matches?.(KB_INPUT)) return;

            // SKIP freeze for inputs inside settings panels/drawers/popups.
            // Freezing layout while interacting with these causes menus to close.
            if (this._isInsidePanel(el)) return;

            // KEY v4 OPTIMIZATION: If keyboard is already open,
            // this is just an input-to-input switch. No freeze needed.
            // The keyboard is not animating, so no reflow occurs.
            if (this._kbOpen) return;

            // Keyboard is about to open — pre-freeze
            if (!this._frozen) {
                // Cooldown: prevent rapid freeze/unfreeze cycling
                if (performance.now() - this._lastUnfreezeTime < REFREEZE_COOLDOWN_MS) return;
                this._freeze('focus-prewarm');

                // Safety: unfreeze if keyboard never opens
                clearTimeout(this._focusTimer);
                this._focusTimer = setTimeout(() => {
                    if (!this._kbOpen && this._frozen) {
                        this._unfreeze();
                    }
                    this._focusTimer = null;
                }, FOCUS_TIMEOUT_MS);
            }
        };

        this._onFocusOut = (e) => {
            const el = e.target;
            if (!el?.matches?.(KB_INPUT)) return;

            // Skip for panel inputs (same reason as focusin)
            if (this._isInsidePanel(el)) return;

            // If focus is moving to another keyboard input, skip.
            // relatedTarget gives us the next focused element.
            const nextEl = e.relatedTarget;
            if (nextEl?.matches?.(KB_INPUT)) return;

            // relatedTarget can be null on some mobile browsers.
            // Use rAF as fallback to verify after focusin fires.
            requestAnimationFrame(() => {
                // Double-check: if activeElement is a keyboard input, skip
                if (document.activeElement?.matches?.(KB_INPUT)) return;

                // Keyboard will close — pre-freeze
                if (this._kbOpen && !this._frozen) {
                    if (performance.now() - this._lastUnfreezeTime < REFREEZE_COOLDOWN_MS) return;
                    this._freeze('focus-blur');
                }
            });
        };

        document.addEventListener('focusin', this._onFocusIn, { passive: true });
        document.addEventListener('focusout', this._onFocusOut, { passive: true });
    }

    // ================================================================
    // Layer 2 — Resize Suppression
    // ================================================================

    /** @private */
    _bindResizeGuard() {
        this._onResizeCapture = (e) => {
            if (this._frozen) {
                e.stopImmediatePropagation();
            }
        };
        window.addEventListener('resize', this._onResizeCapture, true);
    }

    // ================================================================
    // VisualViewport Detection
    // ================================================================

    /** @private */
    _bindVisualViewport() {
        const vv = window.visualViewport;
        if (!vv) return;

        this._onVVResize = () => {
            if (this._rafId) return;
            this._rafId = requestAnimationFrame(() => {
                this._rafId = null;
                this._onViewportChange();
            });
        };

        vv.addEventListener('resize', this._onVVResize, { passive: true });
    }

    /**
     * @private
     * Called (rAF-throttled) when visualViewport.height changes.
     */
    _onViewportChange() {
        const curH = window.visualViewport?.height ?? window.innerHeight;
        const diff = this._fullH - curH;
        const isKB = diff > KB_THRESHOLD;

        // Height is changing — ensure freeze is active
        if (curH !== this._lastH) {
            this._lastH = curH;

            // CRITICAL: Do NOT freeze if the active element is inside a
            // settings panel/drawer/popup. Freezing while a panel input has
            // focus applies containment CSS to #sheld which collapses the
            // panel and makes it "close" visually.
            const activeEl = document.activeElement;
            const inPanel = activeEl && this._isInsidePanel(activeEl);

            if (!this._frozen && !inPanel) {
                this._freeze('viewport-change');
            }

            // Update keyboard height CSS custom property
            document.documentElement.style.setProperty(
                '--perf-kb-h', `${Math.max(0, diff)}px`,
            );

            // Reset stability timer (viewport still changing)
            this._resetStableTimer();
        }

        // Update keyboard open/closed state
        if (isKB !== this._kbOpen) {
            this._kbOpen = isKB;

            if (isKB) {
                document.body?.classList.add(OPEN_CLASS);
            } else {
                document.body?.classList.remove(OPEN_CLASS);
                // Re-measure full height after keyboard fully closes
                this._fullH = this._measureHeight();
            }

            this._notifyListeners();
        }
    }

    // ================================================================
    // Stability-Based Unfreeze
    // ================================================================

    /**
     * @private
     * Each viewport change resets the timer. Only when stable for
     * STABLE_MS do we consider the transition finished.
     */
    _resetStableTimer() {
        clearTimeout(this._stableTimer);
        this._stableTimer = setTimeout(() => {
            this._stableTimer = null;
            this._onStable();
        }, STABLE_MS);
    }

    /**
     * @private
     * v4: Single-frame unfreeze (v3 used nested double rAF = 2 extra frames).
     * Save scroll → unfreeze → restore scroll in one rAF.
     */
    _onStable() {
        this._saveScrollPos();
        requestAnimationFrame(() => {
            this._unfreeze();
            this._restoreScrollPos();
        });
    }

    // ================================================================
    // Freeze / Unfreeze
    // ================================================================

    /** @private Activate freeze CSS via body class toggle. */
    _freeze(reason) {
        if (this._frozen) return;
        this._frozen = true;

        this._saveScrollPos();

        // Toggle class — CSS rules activate instantly, zero inject overhead
        document.body?.classList.add(FREEZE_CLASS);
        document.documentElement?.classList.add(FREEZE_CLASS);

        // Safety net: never freeze indefinitely
        clearTimeout(this._safetyTimer);
        this._safetyTimer = setTimeout(() => {
            if (this._frozen) {
                console.warn(`${LOG} Safety unfreeze after ${MAX_FREEZE_MS}ms`);
                this._unfreeze();
            }
            this._safetyTimer = null;
        }, MAX_FREEZE_MS);
    }

    /** @private Remove freeze and record timestamp. */
    _unfreeze() {
        if (!this._frozen) return;
        this._frozen = false;
        this._lastUnfreezeTime = performance.now();

        document.body?.classList.remove(FREEZE_CLASS);
        document.documentElement?.classList.remove(FREEZE_CLASS);

        clearTimeout(this._safetyTimer);
        clearTimeout(this._focusTimer);
        this._safetyTimer = null;
        this._focusTimer = null;
    }

    // ================================================================
    // Scroll Position Preservation
    // ================================================================

    /** @private */
    _saveScrollPos() {
        const chat = document.getElementById('chat');
        if (chat) this._scrollPos = chat.scrollTop;
    }

    /** @private */
    _restoreScrollPos() {
        const chat = document.getElementById('chat');
        if (chat && this._scrollPos > 0) {
            chat.scrollTop = this._scrollPos;
        }
    }

    // ================================================================
    // Layer 3 — Permanent CSS (class-toggled)
    // ================================================================

    /** @private Inject once, never removed (toggled by class). */
    _injectPermanentCSS() {
        // Remove v3 style if upgrading
        document.getElementById('perf-opt-kb-v3')?.remove();

        if (document.getElementById(STYLE_ID)) return;
        this._styleEl = document.createElement('style');
        this._styleEl.id = STYLE_ID;
        this._styleEl.textContent = FREEZE_CSS;
        document.head.appendChild(this._styleEl);
    }

    /** @private */
    _removePermanentCSS() {
        this._styleEl?.remove();
        this._styleEl = null;
    }

    // ================================================================
    // Cleanup
    // ================================================================

    /** @private */
    _unbindAll() {
        if (this._onVVResize) {
            window.visualViewport?.removeEventListener('resize', this._onVVResize);
            this._onVVResize = null;
        }
        if (this._onResizeCapture) {
            window.removeEventListener('resize', this._onResizeCapture, true);
            this._onResizeCapture = null;
        }
        if (this._onFocusIn) {
            document.removeEventListener('focusin', this._onFocusIn);
            this._onFocusIn = null;
        }
        if (this._onFocusOut) {
            document.removeEventListener('focusout', this._onFocusOut);
            this._onFocusOut = null;
        }
        if (this._rafId) {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
        }
    }

    /** @private */
    _clearAllTimers() {
        clearTimeout(this._stableTimer);
        clearTimeout(this._safetyTimer);
        clearTimeout(this._focusTimer);
        this._stableTimer = null;
        this._safetyTimer = null;
        this._focusTimer = null;
    }

    /** @private Notify subscribers + dispatch CustomEvent. */
    _notifyListeners() {
        const state = this._kbOpen ? 'open' : 'closed';
        const h = this.keyboardHeight;
        for (const fn of this._listeners) {
            try { fn(state, h); } catch (_) { /* ignore */ }
        }
        document.dispatchEvent(new CustomEvent('perf-keyboard-state', {
            detail: { state, height: h },
        }));
    }
}
