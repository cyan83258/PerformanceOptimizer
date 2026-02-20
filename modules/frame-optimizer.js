/**
 * Frame Optimizer Module (Layout Thrashing Prevention)
 *
 * In SillyTavern, many UI updates interleave DOM reads and writes,
 * causing the browser to perform forced synchronous layouts ("layout thrashing").
 *
 * This module:
 *   1. Provides a batched read/write scheduler using requestAnimationFrame
 *   2. Patches frequently-called jQuery methods to batch DOM writes
 *   3. Coalesces rapid consecutive DOM mutations into single rAF frames
 *   4. Provides utilities for other modules to schedule batched operations
 *
 * The scheduler groups all reads before writes within each animation frame,
 * preventing the read-write-read-write pattern that triggers forced layouts.
 */

const LOG = '[PerfOptimizer/FrameOpt]';

/**
 * DOM Read/Write Scheduler.
 * Batches operations to prevent layout thrashing.
 */
class DOMScheduler {
    constructor() {
        /** @type {Function[]} */
        this._reads = [];
        /** @type {Function[]} */
        this._writes = [];
        /** @type {boolean} */
        this._scheduled = false;
    }

    /**
     * Schedule a DOM read operation.
     * @param {Function} fn
     */
    read(fn) {
        this._reads.push(fn);
        this._schedule();
    }

    /**
     * Schedule a DOM write operation.
     * @param {Function} fn
     */
    write(fn) {
        this._writes.push(fn);
        this._schedule();
    }

    /** @private */
    _schedule() {
        if (this._scheduled) return;
        this._scheduled = true;
        requestAnimationFrame(() => this._flush());
    }

    /** @private Execute all batched reads then writes */
    _flush() {
        this._scheduled = false;

        // Execute all reads first
        const reads = this._reads.splice(0, this._reads.length);
        for (const fn of reads) {
            try { fn(); } catch (e) { console.warn(`${LOG} Read error:`, e); }
        }

        // Then all writes
        const writes = this._writes.splice(0, this._writes.length);
        for (const fn of writes) {
            try { fn(); } catch (e) { console.warn(`${LOG} Write error:`, e); }
        }

        // If new items were added during flush, schedule another frame
        if (this._reads.length > 0 || this._writes.length > 0) {
            this._schedule();
        }
    }
}

export class FrameOptimizer {
    constructor() {
        /** @type {boolean} */
        this.active = false;
        /** @type {DOMScheduler} */
        this.scheduler = new DOMScheduler();
        /** @type {Function|null} */
        this._originalScrollTo = null;
        /** @type {Map<string, { original: Function, throttled: Function }>} */
        this._patchedMethods = new Map();
    }

    /** Enable frame optimizations. */
    enable() {
        this._patchScrollTo();
        this._patchFrequentOperations();
        this.active = true;
        console.log(`${LOG} Enabled`);
    }

    /** Disable and restore all patches. */
    disable() {
        this._restoreScrollTo();
        this._restoreFrequentOperations();
        this.active = false;
    }

    /**
     * Get the scheduler for external use by other modules.
     * @returns {DOMScheduler}
     */
    getScheduler() {
        return this.scheduler;
    }

    // ---------------------------------------------------------------
    // ScrollTo Optimization
    // ---------------------------------------------------------------

    /**
     * @private
     * Patch Element.prototype.scrollTo to batch calls within the same frame.
     * SillyTavern sometimes calls scrollTo multiple times in rapid succession.
     */
    _patchScrollTo() {
        const chat = document.getElementById('chat');
        if (!chat) return;

        this._originalScrollTo = chat.scrollTo.bind(chat);
        let pendingScroll = null;
        let rafId = null;

        chat.scrollTo = (...args) => {
            pendingScroll = args;
            if (rafId === null) {
                rafId = requestAnimationFrame(() => {
                    rafId = null;
                    if (pendingScroll) {
                        this._originalScrollTo(...pendingScroll);
                        pendingScroll = null;
                    }
                });
            }
        };
    }

    /** @private */
    _restoreScrollTo() {
        if (this._originalScrollTo) {
            const chat = document.getElementById('chat');
            if (chat) {
                chat.scrollTo = Element.prototype.scrollTo.bind(chat);
            }
            this._originalScrollTo = null;
        }
    }

    // ---------------------------------------------------------------
    // Frequent Operation Throttling
    // ---------------------------------------------------------------

    /**
     * @private
     * Throttle jQuery offset/height/width calls that trigger forced layouts.
     * These are called frequently during message rendering and scroll handling.
     */
    _patchFrequentOperations() {
        if (!$ || !$.fn) return;

        // Throttle .offset() calls - each one triggers a layout
        this._throttleJQueryMethod('offset', 16); // ~1 frame at 60fps

        // Throttle .outerHeight() / .outerWidth() - also trigger layout
        this._throttleJQueryMethod('outerHeight', 16);
        this._throttleJQueryMethod('outerWidth', 16);
    }

    /**
     * @private
     * Throttle a jQuery method with a cache that expires each frame.
     * @param {string} methodName
     * @param {number} ttl - Cache TTL in ms
     */
    _throttleJQueryMethod(methodName, ttl) {
        const original = $.fn[methodName];
        if (!original) return;

        const cache = new WeakMap();

        $.fn[methodName] = function (...args) {
            // Only cache read calls (no arguments = getter)
            if (args.length > 0 || this.length !== 1) {
                return original.apply(this, args);
            }

            const el = this[0];
            if (!el) return original.apply(this, args);

            const cached = cache.get(el);
            const now = performance.now();

            if (cached && now - cached.time < ttl) {
                return cached.value;
            }

            const value = original.apply(this, args);
            cache.set(el, { value, time: now });
            return value;
        };

        this._patchedMethods.set(methodName, {
            original,
            throttled: $.fn[methodName],
        });
    }

    /** @private Restore all patched jQuery methods */
    _restoreFrequentOperations() {
        for (const [name, { original }] of this._patchedMethods) {
            if ($.fn[name]) {
                $.fn[name] = original;
            }
        }
        this._patchedMethods.clear();
    }
}
