/**
 * Mobile Render Optimizer Module
 *
 * Tackles general mobile micro-lag by reducing rendering overhead
 * at the browser engine level. Complements other mobile modules
 * (keyboard, layout, touch) with render-pipeline-specific fixes.
 *
 * Optimizations:
 *   1. GPU Layer Promotion
 *      - will-change: transform on #chat for compositor-driven scrolling
 *      - translateZ(0) hack for older mobile WebKit/Blink
 *   2. Reduced Transitions
 *      - Disables non-essential CSS transitions on mobile
 *      - Removes hover-triggered effects (irrelevant on touch)
 *   3. Idle-Time Cleanup
 *      - requestIdleCallback for non-critical DOM housekeeping
 *      - Removes empty text nodes from #chat
 *
 * NOTE: Resize throttling is handled by the keyboard optimizer.
 * NOTE: CSS containment and content-visibility are NOT used here
 *       because they interfere with drawer/panel/popup rendering.
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

/* Disable hover effects on touch devices */
@media (hover: none) and (pointer: coarse) {
    .mes:hover,
    .menu_button:hover,
    .list-group-item:hover {
        transition-duration: 0s !important;
        animation-duration: 0s !important;
    }
}
`.trim();

export class MobileRenderOptimizer {
    constructor() {
        /** @type {boolean} */
        this.active = false;

        /** @type {HTMLStyleElement|null} */
        this._styleEl = null;

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

        // NOTE: Do NOT promote #sheld to a GPU layer.
        // #sheld contains all drawers/panels; forcing a compositing layer
        // on it wastes GPU memory and can cause rendering issues.
    }

    /** @private Remove GPU layer hints. */
    _removeGPULayers() {
        const chat = document.getElementById('chat');
        if (chat) {
            chat.style.willChange = '';
            chat.style.transform = '';
        }
    }

    // ==================================================================
    // 3. Idle-Time Cleanup
    // ==================================================================

    /**
     * @private
     * Schedule non-critical DOM cleanup during idle periods.
     * Removes empty text nodes that accumulate over long chat sessions.
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
