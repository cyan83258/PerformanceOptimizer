/**
 * Mobile Keyboard Optimizer Module (v2 - Rewritten)
 *
 * ROOT CAUSE: On mobile, opening/closing the virtual keyboard resizes the
 * viewport, which triggers massive layout recalculation across all elements
 * using dvh/vh units, position:fixed, and backdrop-filter.
 *
 * This module:
 *   1. Detects keyboard open/close via visualViewport API
 *   2. Applies targeted CSS freeze on SPECIFIC elements (not * selector)
 *   3. Suppresses resize events during keyboard transition
 *   4. Preserves chat scroll position across keyboard transitions
 *   5. Publishes keyboard state for other modules to consume
 *
 * Cooperates with:
 *   - MobileLayoutStabilizer (handles dvh replacement)
 *   - MobileTouchOptimizer (handles input UX)
 */

const LOG = '[PerfOpt/MobileKB]';
const FREEZE_ID = 'perf-opt-kb-freeze';

/** @typedef {'closed'|'opening'|'open'|'closing'} KeyboardState */

export class MobileKeyboardOptimizer {
    constructor() {
        this.active = false;

        /** @type {KeyboardState} */
        this.state = 'closed';

        /** @type {number} Full viewport height (no keyboard) */
        this._fullHeight = 0;

        /** @type {number} Current keyboard height estimate */
        this.keyboardHeight = 0;

        /** @type {Set<Function>} Subscribers to keyboard state changes */
        this._listeners = new Set();

        // Bound handlers for cleanup
        this._onVVResize = null;
        this._onResizeCapture = null;
        this._rafId = null;
        this._unfreezeTimer = null;
        this._chatScrollPos = 0;

        /** @type {HTMLStyleElement|null} */
        this._freezeEl = null;
    }

    // ── Public API ──────────────────────────────────────────────────

    enable() {
        if (this.active) return;
        if (!this._isMobile()) {
            console.log(`${LOG} Desktop detected, skipping`);
            return;
        }

        this._fullHeight = window.visualViewport?.height ?? window.innerHeight;
        this._bindVisualViewport();
        this._bindResizeGuard();

        this.active = true;
        console.log(`${LOG} Enabled (viewport ${this._fullHeight}px)`);
    }

    disable() {
        if (!this.active) return;
        this._unbindVisualViewport();
        this._unbindResizeGuard();
        this._clearTimers();
        this._removeFreezeCSS();
        this.state = 'closed';
        this.keyboardHeight = 0;
        this.active = false;
    }

    /** Subscribe to keyboard state changes. Returns unsubscribe function. */
    onStateChange(fn) {
        this._listeners.add(fn);
        return () => this._listeners.delete(fn);
    }

    /** @returns {boolean} */
    get isKeyboardVisible() {
        return this.state === 'open' || this.state === 'opening';
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

    // ── VisualViewport Listener ─────────────────────────────────────

    /** @private */
    _bindVisualViewport() {
        const vv = window.visualViewport;
        if (!vv) return;

        // Use a single rAF-throttled handler for minimum overhead
        this._onVVResize = () => {
            if (this._rafId) return; // Already scheduled
            this._rafId = requestAnimationFrame(() => {
                this._rafId = null;
                this._processViewportChange();
            });
        };

        vv.addEventListener('resize', this._onVVResize, { passive: true });
    }

    /** @private */
    _unbindVisualViewport() {
        if (this._onVVResize) {
            window.visualViewport?.removeEventListener('resize', this._onVVResize);
            this._onVVResize = null;
        }
        if (this._rafId) {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
        }
    }

    // ── Viewport Change Processing ──────────────────────────────────

    /** @private */
    _processViewportChange() {
        const vv = window.visualViewport;
        if (!vv) return;

        const current = vv.height;
        const diff = this._fullHeight - current;
        const kbThreshold = 100; // Keyboard is >100px

        if (diff > kbThreshold) {
            // Keyboard is visible
            this.keyboardHeight = diff;

            if (this.state === 'closed') {
                this._onKeyboardOpening();
            } else if (this.state === 'opening') {
                // Still animating — update height, keep freeze
                this._updateKeyboardOffset();
            }
            // If already 'open', just update offset silently
            if (this.state === 'open') {
                this._updateKeyboardOffset();
            }
        } else {
            // Keyboard is hidden
            if (this.state === 'open' || this.state === 'opening') {
                this._onKeyboardClosing();
            }
        }
    }

    /** @private */
    _onKeyboardOpening() {
        this._saveScrollPos();
        this._setState('opening');
        this._injectFreezeCSS();
        this._updateKeyboardOffset();

        // Transition to 'open' after animation settles
        this._scheduleUnfreeze(280, () => {
            this._restoreScrollPos();
            this._setState('open');
        });
    }

    /** @private */
    _onKeyboardClosing() {
        this._saveScrollPos();
        this._setState('closing');
        this._injectFreezeCSS();

        // Update full height (orientation might have changed while kb was open)
        this._scheduleUnfreeze(280, () => {
            this._fullHeight = window.visualViewport?.height ?? window.innerHeight;
            this.keyboardHeight = 0;
            this._updateKeyboardOffset();
            this._restoreScrollPos();
            this._setState('closed');
        });
    }

    /** @private */
    _setState(newState) {
        if (this.state === newState) return;
        this.state = newState;
        for (const fn of this._listeners) {
            try { fn(newState, this.keyboardHeight); } catch (_) { /* ignore */ }
        }
    }

    /** @private */
    _updateKeyboardOffset() {
        document.documentElement.style.setProperty(
            '--keyboard-height', `${this.keyboardHeight}px`,
        );
    }

    // ── Scroll Position Preservation ────────────────────────────────

    /** @private */
    _saveScrollPos() {
        const chat = document.getElementById('chat');
        if (chat) this._chatScrollPos = chat.scrollTop;
    }

    /** @private */
    _restoreScrollPos() {
        const chat = document.getElementById('chat');
        if (chat && this._chatScrollPos > 0) {
            chat.scrollTop = this._chatScrollPos;
        }
    }

    // ── Targeted Freeze CSS ─────────────────────────────────────────

    /**
     * @private
     * Inject freeze CSS targeting ONLY the elements that cause lag.
     * Much faster than the previous `* { transition: 0s }` approach.
     */
    _injectFreezeCSS() {
        if (this._freezeEl) return;
        this._freezeEl = document.createElement('style');
        this._freezeEl.id = FREEZE_ID;
        this._freezeEl.textContent = `
/* [PerfOpt] Keyboard transition freeze - targets specific laggy elements */
#bg1, #bg_custom,
#sheld,
#top-bar, #top-settings-holder,
.drawer-content,
#left-nav-panel, #right-nav-panel,
#floatingPrompt, #cfgConfig,
#send_form, #form_sheld,
.scrollableInner,
#character_popup, #world_popup {
    transition: none !important;
    animation: none !important;
}
#send_form,
.drawer-content,
#left-nav-panel, #right-nav-panel,
#top-bar, #top-settings-holder,
.popup, .popup-content {
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
}
#chat {
    overflow-anchor: none !important;
}`;
        document.head.appendChild(this._freezeEl);
    }

    /** @private */
    _removeFreezeCSS() {
        if (this._freezeEl) {
            this._freezeEl.remove();
            this._freezeEl = null;
        }
    }

    // ── Resize Event Guard ──────────────────────────────────────────

    /**
     * @private
     * Intercept resize events during keyboard transition to prevent
     * SillyTavern's power-user.js handler from running expensive
     * operations (adjustAutocomplete, setHotswaps, zoom reporting).
     *
     * Uses capture phase to fire before jQuery handlers.
     * Only suppresses during 'opening' and 'closing' states.
     */
    _bindResizeGuard() {
        this._onResizeCapture = (e) => {
            if (this.state === 'opening' || this.state === 'closing') {
                e.stopImmediatePropagation();
            }
        };
        window.addEventListener('resize', this._onResizeCapture, true);
    }

    /** @private */
    _unbindResizeGuard() {
        if (this._onResizeCapture) {
            window.removeEventListener('resize', this._onResizeCapture, true);
            this._onResizeCapture = null;
        }
    }

    // ── Timers ──────────────────────────────────────────────────────

    /**
     * @private
     * @param {number} ms
     * @param {Function} callback
     */
    _scheduleUnfreeze(ms, callback) {
        this._clearTimers();
        this._unfreezeTimer = setTimeout(() => {
            this._removeFreezeCSS();
            this._unfreezeTimer = null;
            callback?.();
        }, ms);
    }

    /** @private */
    _clearTimers() {
        if (this._unfreezeTimer) {
            clearTimeout(this._unfreezeTimer);
            this._unfreezeTimer = null;
        }
        if (this._rafId) {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
        }
    }
}
