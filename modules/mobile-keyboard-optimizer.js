/**
 * Mobile Keyboard Optimizer Module
 *
 * On mobile devices, opening/closing the virtual keyboard causes the viewport
 * to resize, which triggers:
 *   1. All dvh/vh-based heights to recalculate (100dvh changes)
 *   2. position:fixed elements to reposition
 *   3. Backdrop-filter blur to re-render on resized elements
 *   4. Chat container to reflow all visible messages
 *   5. Background image to resize
 *
 * This module fixes the lag by:
 *   - Detecting keyboard open/close via visualViewport API
 *   - Freezing layout-critical CSS properties during keyboard transitions
 *   - Preventing scroll jumps during viewport resize
 *   - Setting CSS custom property --stable-vh for stable height reference
 *   - Temporarily disabling transitions/animations during keyboard events
 *   - Suppressing unnecessary resize handlers during keyboard show/hide
 */

const LOG = '[PerfOptimizer/MobileKB]';
const STYLE_ID = 'perf-optimizer-mobile-kb-css';
const FREEZE_STYLE_ID = 'perf-optimizer-mobile-kb-freeze';

export class MobileKeyboardOptimizer {
    constructor() {
        /** @type {boolean} */
        this.active = false;
        /** @type {boolean} */
        this._keyboardVisible = false;
        /** @type {number} Height before keyboard opened */
        this._stableViewportHeight = 0;
        /** @type {number} Width (stable, doesn't change with keyboard) */
        this._stableViewportWidth = 0;
        /** @type {Function|null} */
        this._viewportHandler = null;
        /** @type {Function|null} */
        this._focusHandler = null;
        /** @type {Function|null} */
        this._blurHandler = null;
        /** @type {Function|null} */
        this._resizeHandler = null;
        /** @type {number|null} */
        this._unfreezeTimer = null;
        /** @type {number|null} */
        this._scrollRestoreTimer = null;
        /** @type {HTMLStyleElement|null} */
        this._baseStyleEl = null;
        /** @type {HTMLStyleElement|null} */
        this._freezeStyleEl = null;
    }

    /** Enable mobile keyboard optimizations. */
    enable() {
        // Only activate on mobile/touch devices
        if (!this._isMobileDevice()) {
            console.log(`${LOG} Not a mobile device, skipping`);
            return;
        }

        this._stableViewportHeight = window.visualViewport?.height || window.innerHeight;
        this._stableViewportWidth = window.visualViewport?.width || window.innerWidth;

        this._injectBaseCSS();
        this._setupVisualViewportListener();
        this._setupFocusListeners();
        this._setupResizeGuard();
        this._setStableVH();

        this.active = true;
        console.log(`${LOG} Enabled (viewport: ${this._stableViewportWidth}x${this._stableViewportHeight})`);
    }

    /** Disable and clean up. */
    disable() {
        this._removeVisualViewportListener();
        this._removeFocusListeners();
        this._removeResizeGuard();

        if (this._baseStyleEl) {
            this._baseStyleEl.remove();
            this._baseStyleEl = null;
        }
        this._unfreeze();

        if (this._unfreezeTimer) {
            clearTimeout(this._unfreezeTimer);
            this._unfreezeTimer = null;
        }
        if (this._scrollRestoreTimer) {
            clearTimeout(this._scrollRestoreTimer);
            this._scrollRestoreTimer = null;
        }

        // Remove CSS custom property
        document.documentElement.style.removeProperty('--stable-vh');
        document.documentElement.style.removeProperty('--stable-viewport-height');
        document.documentElement.style.removeProperty('--keyboard-offset');

        this.active = false;
    }

    // ---------------------------------------------------------------
    // Device Detection
    // ---------------------------------------------------------------

    /** @private */
    _isMobileDevice() {
        return (
            'ontouchstart' in window ||
            navigator.maxTouchPoints > 0 ||
            window.innerWidth <= 1000 || // SillyTavern's mobile breakpoint
            /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
        );
    }

    // ---------------------------------------------------------------
    // Stable Viewport Height
    // ---------------------------------------------------------------

    /** @private Set --stable-vh CSS custom property */
    _setStableVH() {
        const vh = this._stableViewportHeight * 0.01;
        document.documentElement.style.setProperty('--stable-vh', `${vh}px`);
        document.documentElement.style.setProperty('--stable-viewport-height', `${this._stableViewportHeight}px`);
        document.documentElement.style.setProperty('--keyboard-offset', '0px');
    }

    // ---------------------------------------------------------------
    // Base CSS Injection
    // ---------------------------------------------------------------

    /** @private Inject always-active mobile CSS optimizations */
    _injectBaseCSS() {
        if (this._baseStyleEl) this._baseStyleEl.remove();

        this._baseStyleEl = document.createElement('style');
        this._baseStyleEl.id = STYLE_ID;
        this._baseStyleEl.textContent = `
/* [Performance Optimizer] Mobile Keyboard - Base Optimizations */

/* Use GPU-accelerated transforms for send_form positioning */
#send_form {
    will-change: transform;
    transform: translateZ(0);
}

/* Prevent browser auto-scroll on input focus */
#send_textarea {
    scroll-margin-bottom: 0px;
}

/* Optimize chat container for mobile scroll */
#chat {
    will-change: scroll-position;
    -webkit-overflow-scrolling: touch;
}

/* Stable height: prevent #sheld and backgrounds from resizing with keyboard */
@media screen and (max-width: 1000px) {
    #bg1,
    #bg_custom {
        height: var(--stable-viewport-height, 100dvh) !important;
    }
}`;
        document.head.appendChild(this._baseStyleEl);
    }

    // ---------------------------------------------------------------
    // Freeze/Unfreeze During Keyboard Transition
    // ---------------------------------------------------------------

    /**
     * @private
     * Freeze the layout during keyboard open/close transition.
     * Temporarily disables transitions, animations, and layout-triggering updates.
     */
    _freeze() {
        if (this._freezeStyleEl) return;

        this._freezeStyleEl = document.createElement('style');
        this._freezeStyleEl.id = FREEZE_STYLE_ID;
        this._freezeStyleEl.textContent = `
/* [Performance Optimizer] Mobile Keyboard - Freeze During Transition */

/* Kill ALL transitions and animations during keyboard resize */
*, *::before, *::after {
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    animation-duration: 0s !important;
    animation-delay: 0s !important;
}

/* Prevent backdrop-filter recalculation during resize */
#send_form,
.drawer-content,
#top-bar,
#top-settings-holder,
.popup,
.popup-content {
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
}

/* Prevent background resize during keyboard show/hide */
#bg1, #bg_custom {
    transition: none !important;
}`;
        document.head.appendChild(this._freezeStyleEl);
    }

    /** @private Remove the freeze stylesheet */
    _unfreeze() {
        if (this._freezeStyleEl) {
            this._freezeStyleEl.remove();
            this._freezeStyleEl = null;
        }
    }

    // ---------------------------------------------------------------
    // VisualViewport API Listener
    // ---------------------------------------------------------------

    /** @private */
    _setupVisualViewportListener() {
        if (!window.visualViewport) return;

        this._viewportHandler = () => {
            this._handleViewportChange();
        };

        window.visualViewport.addEventListener('resize', this._viewportHandler, { passive: true });
    }

    /** @private */
    _removeVisualViewportListener() {
        if (this._viewportHandler && window.visualViewport) {
            window.visualViewport.removeEventListener('resize', this._viewportHandler);
            this._viewportHandler = null;
        }
    }

    /**
     * @private
     * Handle viewport size changes (keyboard open/close).
     */
    _handleViewportChange() {
        const vv = window.visualViewport;
        if (!vv) return;

        const currentHeight = vv.height;
        const heightDiff = this._stableViewportHeight - currentHeight;
        const isKeyboard = heightDiff > 100; // >100px diff = keyboard

        if (isKeyboard && !this._keyboardVisible) {
            // Keyboard opening
            this._onKeyboardOpen(heightDiff);
        } else if (!isKeyboard && this._keyboardVisible) {
            // Keyboard closing
            this._onKeyboardClose();
        }

        // Update keyboard offset for CSS
        document.documentElement.style.setProperty(
            '--keyboard-offset',
            `${Math.max(0, heightDiff)}px`,
        );
    }

    /**
     * @private
     * Called when the virtual keyboard opens.
     * @param {number} keyboardHeight
     */
    _onKeyboardOpen(keyboardHeight) {
        this._keyboardVisible = true;

        // Save chat scroll position before freeze
        const chat = document.getElementById('chat');
        const scrollBefore = chat?.scrollTop;

        // Freeze layout
        this._freeze();

        // Restore scroll position (keyboard open can cause jump)
        if (chat && scrollBefore != null) {
            this._scrollRestoreTimer = setTimeout(() => {
                chat.scrollTop = scrollBefore;
                this._scrollRestoreTimer = null;
            }, 50);
        }

        // Unfreeze after keyboard animation completes (~300ms typical)
        this._scheduleUnfreeze(350);

        console.debug(`${LOG} Keyboard opened (height: ~${keyboardHeight}px)`);
    }

    /**
     * @private
     * Called when the virtual keyboard closes.
     */
    _onKeyboardClose() {
        this._keyboardVisible = false;

        // Save scroll position
        const chat = document.getElementById('chat');
        const scrollBefore = chat?.scrollTop;

        // Freeze during close transition
        this._freeze();

        // Update stable height (orientation may have changed)
        this._stableViewportHeight = window.visualViewport?.height || window.innerHeight;
        this._setStableVH();

        // Restore scroll
        if (chat && scrollBefore != null) {
            this._scrollRestoreTimer = setTimeout(() => {
                chat.scrollTop = scrollBefore;
                this._scrollRestoreTimer = null;
            }, 50);
        }

        // Unfreeze after close animation
        this._scheduleUnfreeze(350);

        console.debug(`${LOG} Keyboard closed`);
    }

    /**
     * @private
     * Schedule unfreeze with cancellation of previous timer.
     * @param {number} ms
     */
    _scheduleUnfreeze(ms) {
        if (this._unfreezeTimer) {
            clearTimeout(this._unfreezeTimer);
        }
        this._unfreezeTimer = setTimeout(() => {
            this._unfreeze();
            this._unfreezeTimer = null;
        }, ms);
    }

    // ---------------------------------------------------------------
    // Focus/Blur Listeners (Fallback for no visualViewport)
    // ---------------------------------------------------------------

    /** @private */
    _setupFocusListeners() {
        this._focusHandler = (e) => {
            if (this._isTextInput(e.target)) {
                // Slight delay to catch the keyboard opening
                setTimeout(() => {
                    if (!this._keyboardVisible) {
                        const heightDiff = this._stableViewportHeight - (window.visualViewport?.height || window.innerHeight);
                        if (heightDiff > 100) {
                            this._onKeyboardOpen(heightDiff);
                        }
                    }
                }, 100);
            }
        };

        this._blurHandler = (e) => {
            if (this._isTextInput(e.target)) {
                // Delay to allow for focus switch between inputs
                setTimeout(() => {
                    const active = document.activeElement;
                    if (!this._isTextInput(active)) {
                        if (this._keyboardVisible) {
                            this._onKeyboardClose();
                        }
                    }
                }, 150);
            }
        };

        document.addEventListener('focusin', this._focusHandler, { passive: true });
        document.addEventListener('focusout', this._blurHandler, { passive: true });
    }

    /** @private */
    _removeFocusListeners() {
        if (this._focusHandler) {
            document.removeEventListener('focusin', this._focusHandler);
            this._focusHandler = null;
        }
        if (this._blurHandler) {
            document.removeEventListener('focusout', this._blurHandler);
            this._blurHandler = null;
        }
    }

    /**
     * @private
     * @param {Element|null} el
     * @returns {boolean}
     */
    _isTextInput(el) {
        if (!el) return false;
        const tag = el.tagName;
        if (tag === 'TEXTAREA') return true;
        if (tag === 'INPUT') {
            const type = el.type?.toLowerCase();
            return !type || type === 'text' || type === 'search' || type === 'url' || type === 'email' || type === 'number';
        }
        return el.isContentEditable;
    }

    // ---------------------------------------------------------------
    // Resize Guard
    // ---------------------------------------------------------------

    /**
     * @private
     * Intercept window resize events during keyboard transitions.
     * Prevents SillyTavern's resize handler from running expensive
     * operations while the keyboard is animating.
     */
    _setupResizeGuard() {
        this._resizeHandler = (e) => {
            if (this._keyboardVisible || this._unfreezeTimer) {
                // We're in a keyboard transition - suppress
                e.stopImmediatePropagation();
            }
        };

        // Add with highest priority (capture phase)
        window.addEventListener('resize', this._resizeHandler, { capture: true });
    }

    /** @private */
    _removeResizeGuard() {
        if (this._resizeHandler) {
            window.removeEventListener('resize', this._resizeHandler, { capture: true });
            this._resizeHandler = null;
        }
    }
}
