/**
 * Mobile Keyboard Optimizer v3
 *
 * Eliminates keyboard open/close lag through three defense layers:
 *
 * Layer 1 — Focus Pre-Freeze
 *   Listens for focusin on keyboard-triggering elements (textarea, input).
 *   Applies freeze CSS BEFORE the keyboard starts animating.
 *   This prevents the very first resize from causing layout thrashing.
 *
 * Layer 2 — Resize Suppression
 *   Capture-phase window.resize listener blocks ALL resize propagation
 *   while freeze is active.  This stops all 5 ST resize handlers
 *   (power-user.js, browser-fixes.js, AutoComplete, expressions, QuickReply)
 *   from running expensive operations during keyboard transition.
 *
 * Layer 3 — CSS Freeze (class-toggled, permanent stylesheet)
 *   A permanent <style> block whose rules activate only when
 *   body.perf-kb-freeze is present.  No inject/remove overhead.
 *   Disables transitions, animations, backdrop-filter on laggy elements.
 *   Also prevents browser-fixes.js fixFunkyPositioning from reflowing
 *   <html> by locking position: static !important.
 *
 * Stability-based unfreeze:
 *   Instead of a fixed 280ms timeout, waits until the viewport height has
 *   remained stable for 250ms.  Adapts automatically to device speed.
 *
 * Coordinates with other modules via:
 *   - body.perf-kb-freeze  (transitioning — CSS rules activate)
 *   - body.perf-kb-open    (keyboard visible)
 *   - CSS var --perf-kb-h  (keyboard height in px)
 *   - CustomEvent 'perf-keyboard-state' on document
 */

const LOG = '[PerfOpt/MobileKB]';
const STYLE_ID = 'perf-opt-kb-v3';
const FREEZE_CLASS = 'perf-kb-freeze';
const OPEN_CLASS = 'perf-kb-open';

/** Minimum viewport shrink to consider keyboard open (px). */
const KB_THRESHOLD = 100;

/** Viewport must be stable for this long to unfreeze (ms). */
const STABLE_MS = 250;

/** Safety net — never freeze longer than this (ms). */
const MAX_FREEZE_MS = 2000;

/** Maximum time to wait for keyboard after focus event (ms). */
const FOCUS_TIMEOUT_MS = 600;

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

// ─────────────────────────────────────────────────────────────────
// Permanent freeze CSS — activated solely by body class toggle.
// No <style> inject/remove (which itself causes style recalc).
// Targets SPECIFIC lag-causing elements (never uses * selector).
// ─────────────────────────────────────────────────────────────────
const FREEZE_CSS = `
/* === PerfOptimizer: Keyboard Freeze (active when body.${FREEZE_CLASS}) === */

/* Prevent browser-fixes.js fixFunkyPositioning from setting position:fixed
   on <html>, which causes 2 forced layout recalculations per resize event. */
html.${FREEZE_CLASS} {
    position: static !important;
}

/* Disable transitions & animations on all major layout containers.
   This list covers every element that has CSS transitions in ST. */
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

/* Strict containment during transition — browser skips child layout. */
body.${FREEZE_CLASS} #sheld {
    contain: strict;
}
body.${FREEZE_CLASS} #chat {
    contain: layout style paint;
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
`.trim();

// ─────────────────────────────────────────────────────────────────

export class MobileKeyboardOptimizer {
    constructor() {
        this.active = false;

        /** @type {boolean} Freeze CSS currently active */
        this._frozen = false;
        /** @type {boolean} Keyboard currently visible */
        this._kbOpen = false;

        /** @type {number} Full viewport height (no keyboard) */
        this._fullH = 0;
        /** @type {number} Last recorded viewport height */
        this._lastH = 0;

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
        console.log(`${LOG} v3 enabled (viewport: ${this._fullH}px)`);
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

    // ================================================================
    // Layer 1 — Focus Pre-Freeze
    // ================================================================

    /** @private */
    _bindFocusEvents() {
        this._onFocusIn = (e) => {
            const el = e.target;
            if (!el?.matches?.(KB_INPUT)) return;

            // Keyboard is about to open — pre-freeze
            if (!this._kbOpen && !this._frozen) {
                this._freeze('focus-prewarm');
                // Safety: unfreeze if keyboard never opens
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

            // Keyboard will close — pre-freeze
            if (this._kbOpen && !this._frozen) {
                this._freeze('focus-blur');
            }
        };

        document.addEventListener('focusin', this._onFocusIn, { passive: true });
        document.addEventListener('focusout', this._onFocusOut, { passive: true });
    }

    // ================================================================
    // Layer 2 — Resize Suppression
    // ================================================================

    /**
     * @private
     * Capture-phase guard.  Fires before ANY other resize handler.
     * While frozen, prevents all 5 ST resize handlers from running.
     */
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

            if (!this._frozen) {
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
     * Each viewport change resets the timer.  Only when stable for
     * STABLE_MS do we consider the transition finished and unfreeze.
     */
    _resetStableTimer() {
        clearTimeout(this._stableTimer);
        this._stableTimer = setTimeout(() => {
            this._stableTimer = null;
            this._onTransitionStable();
        }, STABLE_MS);
    }

    /** @private */
    _onTransitionStable() {
        this._saveScrollPos();

        // Unfreeze at a clean paint boundary
        requestAnimationFrame(() => {
            this._unfreeze();
            // One more frame to let layout settle then restore scroll
            requestAnimationFrame(() => {
                this._restoreScrollPos();
            });
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

    /** @private Remove freeze. */
    _unfreeze() {
        if (!this._frozen) return;
        this._frozen = false;

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