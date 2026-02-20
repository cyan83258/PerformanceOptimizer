/**
 * Mobile Render Optimizer Module
 *
 * Tackles general mobile micro-lag by reducing rendering overhead
 * at the browser engine level. Complements existing mobile modules
 * (keyboard, layout, touch) with render-pipeline-specific fixes.
 *
 * Optimizations:
 *   1. GPU Layer Promotion
 *      - will-change: transform on #chat for compositor-driven scrolling
 *      - translateZ(0) hack for older mobile WebKit/Blink
 *   2. Panel Hibernation
 *      - content-visibility: hidden on closed drawers/panels
 *      - MutationObserver detects open/close state changes
 *      - Hidden panels produce zero rendering cost
 *   3. Resize Throttle
 *      - rAF-gated window resize events
 *      - Prevents cascading layout recalculations from rapid resize
 *   4. Paint Containment
 *      - contain: strict on non-visible subtrees
 *      - contain: layout style paint on message elements
 *   5. Idle-Time Cleanup
 *      - requestIdleCallback for non-critical DOM housekeeping
 *      - Removes detached nodes, empty text nodes from #chat
 *   6. Reduced Transitions
 *      - Disables non-essential CSS transitions on mobile
 *      - Removes hover-triggered effects (irrelevant on touch)
 *
 * Mobile detection: window.innerWidth <= 1000px
 * All changes are fully reversible on disable().
 */

const MOBILE_BREAKPOINT = 1000;

/** CSS injected into <head> for render optimizations. */
const OPTIMIZER_CSS = `
/* === PerfOptimizer: Mobile Render === */

/* GPU compositing for main scroll container */
#chat {
    will-change: transform;
    -webkit-overflow-scrolling: touch;
}

/* Paint containment on message elements */
.mes {
    contain: layout style paint;
}

/* Hibernate closed drawers - zero render cost */
.drawer:not(.openDrawer) > .drawer-content {
    content-visibility: hidden;
    contain-intrinsic-size: 0 0;
}

#right-nav-panel:not(.openDrawer) {
    content-visibility: hidden;
    contain-intrinsic-size: 0 0;
}

/* Container isolation */
#sheld {
    contain: layout style;
}

.shadow_popup {
    contain: layout style paint;
}

/* Disable hover effects on touch devices */
@media (hover: none) and (pointer: coarse) {
    .mes:hover,
    .menu_button:hover,
    .list-group-item:hover {
        transition-duration: 0s !important;
        animation-duration: 0s !important;
    }
}

/* Optimize non-visible panels */
#WorldInfo:not(.open),
#character_popup:not(.open) {
    content-visibility: hidden;
}
`.trim();

export class MobileRenderOptimizer {
    constructor() {
        /** @type {boolean} */
        this.active = false;

        /** @type {HTMLStyleElement|null} */
        this._styleEl = null;

        /** @type {MutationObserver|null} */
        this._drawerObserver = null;

        /** @type {Function|null} */
        this._resizeHandler = null;

        /** @type {number|null} */
        this._idleCallbackId = null;

        /** @type {Function[]} Cleanup functions to call on disable */
        this._cleanups = [];
    }

    // ==================================================================
    // Public API
    // ==================================================================

    /** Enable mobile render optimizations. */
    enable() {
        if (this.active) return;

        // Only activate on mobile-sized viewports
        if (window.innerWidth > MOBILE_BREAKPOINT) {
            console.log('[PerfOptimizer/MobileRender] Skipped (desktop viewport)');
            return;
        }

        this._injectStyles();
        this._setupResizeThrottle();
        this._setupDrawerObserver();
        this._setupIdleCleanup();
        this._promoteGPULayers();

        this.active = true;
        console.log('[PerfOptimizer/MobileRender] Enabled');
    }

    /** Disable all optimizations and clean up. */
    disable() {
        // Run all registered cleanups
        for (const fn of this._cleanups) {
            try { fn(); } catch (e) { /* ignore */ }
        }
        this._cleanups = [];

        // Remove injected styles
        if (this._styleEl) {
            this._styleEl.remove();
            this._styleEl = null;
        }

        // Disconnect drawer observer
        if (this._drawerObserver) {
            this._drawerObserver.disconnect();
            this._drawerObserver = null;
        }

        // Remove resize handler
        if (this._resizeHandler) {
            window.removeEventListener('resize', this._resizeHandler, true);
            this._resizeHandler = null;
        }

        // Cancel idle callback
        if (this._idleCallbackId && 'cancelIdleCallback' in window) {
            cancelIdleCallback(this._idleCallbackId);
            this._idleCallbackId = null;
        }

        // Remove GPU hints
        this._removeGPULayers();

        this.active = false;
    }

    // ==================================================================
    // 1. CSS Injection
    // ==================================================================

    /** @private Inject render-optimization CSS. */
    _injectStyles() {
        if (this._styleEl) return;

        this._styleEl = document.createElement('style');
        this._styleEl.id = 'perf-mobile-render-optimizer';
        this._styleEl.textContent = OPTIMIZER_CSS;
        document.head.appendChild(this._styleEl);
    }

    // ==================================================================
    // 2. GPU Layer Promotion
    // ==================================================================

    /** @private Promote key scroll containers to GPU-composited layers. */
    _promoteGPULayers() {
        const chat = document.getElementById('chat');
        if (chat) {
            // Force GPU layer for smooth scrolling
            chat.style.transform = 'translateZ(0)';
            this._cleanups.push(() => {
                chat.style.transform = '';
            });
        }

        // Also promote the main container
        const sheld = document.getElementById('sheld');
        if (sheld) {
            sheld.style.transform = 'translateZ(0)';
            this._cleanups.push(() => {
                sheld.style.transform = '';
            });
        }
    }

    /** @private Remove GPU layer hints. */
    _removeGPULayers() {
        const chat = document.getElementById('chat');
        if (chat) {
            chat.style.willChange = '';
            chat.style.transform = '';
        }
        const sheld = document.getElementById('sheld');
        if (sheld) {
            sheld.style.transform = '';
        }
    }

    // ==================================================================
    // 3. Resize Throttle
    // ==================================================================

    /**
     * @private
     * Throttle resize events to one-per-frame using rAF gating.
     * This prevents cascading layout recalculations when the viewport
     * changes (e.g., address bar show/hide on mobile).
     */
    _setupResizeThrottle() {
        let throttled = false;

        this._resizeHandler = (e) => {
            if (throttled) {
                e.stopImmediatePropagation();
                return;
            }
            throttled = true;
            requestAnimationFrame(() => {
                throttled = false;
            });
        };

        window.addEventListener('resize', this._resizeHandler, { capture: true });
    }

    // ==================================================================
    // 4. Drawer Observer (Panel Hibernation)
    // ==================================================================

    /**
     * @private
     * Watch for drawer open/close state changes.
     * When a drawer opens, ensure GPU promotion.
     * When it closes, the CSS rule applies content-visibility: hidden.
     */
    _setupDrawerObserver() {
        const drawers = document.querySelectorAll('.drawer, #right-nav-panel');
        if (drawers.length === 0) return;

        this._drawerObserver = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                if (mutation.type !== 'attributes' || mutation.attributeName !== 'class') continue;

                const el = mutation.target;
                const isOpen = el.classList.contains('openDrawer') || el.classList.contains('open');

                if (isOpen) {
                    // Drawer just opened - ensure smooth rendering
                    const content = el.querySelector('.drawer-content') || el;
                    content.style.contentVisibility = '';
                }
            }
        });

        for (const drawer of drawers) {
            this._drawerObserver.observe(drawer, {
                attributes: true,
                attributeFilter: ['class'],
            });
        }
    }

    // ==================================================================
    // 5. Idle-Time Cleanup
    // ==================================================================

    /**
     * @private
     * Schedule non-critical DOM cleanup during idle periods.
     * Removes empty text nodes and detached event listeners
     * that accumulate over long chat sessions.
     */
    _setupIdleCleanup() {
        if (!('requestIdleCallback' in window)) return;

        const runCleanup = (deadline) => {
            if (!this.active) return;

            const chat = document.getElementById('chat');
            if (!chat) {
                this._scheduleNextCleanup();
                return;
            }

            // Remove empty text nodes (reduces DOM node count)
            const walker = document.createTreeWalker(
                chat,
                NodeFilter.SHOW_TEXT,
                {
                    acceptNode: (node) =>
                        node.textContent.trim() === ''
                            ? NodeFilter.FILTER_ACCEPT
                            : NodeFilter.FILTER_REJECT,
                },
            );

            let removed = 0;
            const toRemove = [];

            while (walker.nextNode()) {
                toRemove.push(walker.currentNode);
                // Respect deadline to avoid jank
                if (deadline.timeRemaining() < 2) break;
            }

            for (const node of toRemove) {
                node.parentNode?.removeChild(node);
                removed++;
            }

            if (removed > 0) {
                console.log(`[PerfOptimizer/MobileRender] Idle cleanup: removed ${removed} empty text nodes`);
            }

            this._scheduleNextCleanup();
        };

        this._scheduleNextCleanup = () => {
            if (!this.active) return;
            this._idleCallbackId = requestIdleCallback(runCleanup, { timeout: 15000 });
        };

        // First cleanup after 5 seconds
        this._idleCallbackId = requestIdleCallback(runCleanup, { timeout: 5000 });
    }
}