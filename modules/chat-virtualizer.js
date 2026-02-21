/**
 * Chat Virtualizer Module v2.1
 *
 * Virtual scrolling for #chat - only viewport-adjacent messages stay hydrated.
 * Off-screen messages are collapsed to fixed-height placeholders.
 *
 * v2.1 fixes over v2:
 *   - Accurate height reading: temporarily overrides content-visibility:auto
 *     before reading offsetHeight so off-screen messages report real heights
 *   - Robust scroll-to-bottom: multiple retry mechanisms to survive async
 *     layout recalculation and content-visibility reflow
 *   - Small chat handling: scrolls to bottom even for chats < bulkLoadThreshold
 *
 * v2 improvements over v1:
 *   1. Instant bulk dehydration on chat load
 *      - Phase-separated DOM reads (heights) then writes (dehydration)
 *      - Eliminates the "render-everything-first" stall
 *   2. CSS-driven child hiding
 *      - `.mes[data-perf-dehydrated] > *` rule handles visibility
 *      - No per-child JS iteration needed in dehydrate/hydrate
 *   3. Bulk load detection via MutationObserver
 *      - Detects when >=15 messages are added within 150ms
 *      - Triggers bulk dehydration after scroll position settles
 *   4. Scroll direction tracking for future directional prefetch
 *   5. Concurrent-safe processing (guards against re-entrant calls)
 *
 * How dehydration works:
 *   - Set `data-perf-dehydrated="1"` attribute on .mes element
 *   - CSS rule `.mes[data-perf-dehydrated] > * { display: none }` hides children
 *   - `content-visibility: hidden` tells the browser to skip rendering
 *   - Fixed height preserves scroll position accuracy
 *
 * How hydration works:
 *   - Remove `data-perf-dehydrated` attribute
 *   - CSS automatically restores child visibility
 *   - Clear inline height/overflow
 */

/** @typedef {{ bufferSize: number, alwaysVisibleTail: number, bulkLoadThreshold: number }} VirtualizerOptions */

const DEFAULT_OPTIONS = {
    /** Extra messages to keep hydrated above/below viewport */
    bufferSize: 2,
    /** Always keep the last N messages hydrated */
    alwaysVisibleTail: 3,
    /** Minimum messages added in a batch to trigger bulk dehydration */
    bulkLoadThreshold: 15,
};

const DEHYDRATED_ATTR = 'data-perf-dehydrated';
const HEIGHT_ATTR = 'data-perf-height';

/**
 * Temporary <style> tag ID used to override content-visibility during height reads.
 * @type {string}
 */
const CV_OVERRIDE_ID = 'perf-cv-override';

export class ChatVirtualizer {
    /**
     * @param {Partial<VirtualizerOptions>} [options]
     */
    constructor(options) {
        /** @type {boolean} */
        this.active = false;
        /** @type {VirtualizerOptions} */
        this.options = { ...DEFAULT_OPTIONS, ...options };

        /** @type {IntersectionObserver|null} */
        this._observer = null;
        /** @type {MutationObserver|null} */
        this._mutationObserver = null;
        /** @type {HTMLElement|null} */
        this._chatContainer = null;
        /** @type {Set<Element>} Messages currently in/near viewport */
        this._visibleSet = new Set();

        /** @type {number|null} */
        this._dehydrateTimer = null;
        /** @type {number|null} */
        this._bulkTimer = null;
        /** @type {number|null} */
        this._initialTimer = null;

        /** @type {Function|null} */
        this._scrollHandler = null;
        /** @type {number} 1 = down, -1 = up */
        this._scrollDirection = 1;
        /** @type {number} */
        this._lastScrollTop = 0;

        /** @type {boolean} Guard against re-entrant bulk processing */
        this._processingBulk = false;

        /** @type {number[]} Active scroll-retry timer IDs */
        this._scrollRetryTimers = [];
    }

    // ==================================================================
    // Public API
    // ==================================================================

    /** Enable virtualization. */
    enable() {
        if (this.active) return;

        this._chatContainer = document.getElementById('chat');
        if (!this._chatContainer) {
            console.warn('[PerfOptimizer/ChatVirt] #chat not found');
            return;
        }

        this._setupIntersectionObserver();
        this._setupMutationObserver();
        this._setupScrollTracker();

        // IMPORTANT: Delay initial processing so SillyTavern's own
        // scrollChatToBottom() can finish first. If we dehydrate immediately,
        // message heights change before the scroll-to-bottom completes,
        // leaving the user stranded at the top of the chat.
        this._initialTimer = setTimeout(() => {
            this._initialTimer = null;
            this._processExisting();
        }, 1500);

        this.active = true;
        console.log('[PerfOptimizer/ChatVirt] v2.1 enabled');
    }

    /** Disable virtualization and rehydrate all messages. */
    disable() {
        this._observer?.disconnect();
        this._observer = null;

        this._mutationObserver?.disconnect();
        this._mutationObserver = null;

        if (this._scrollHandler && this._chatContainer) {
            this._chatContainer.removeEventListener('scroll', this._scrollHandler);
        }
        this._scrollHandler = null;

        clearTimeout(this._dehydrateTimer);
        clearTimeout(this._bulkTimer);
        clearTimeout(this._initialTimer);
        this._dehydrateTimer = null;
        this._bulkTimer = null;
        this._initialTimer = null;

        // Cancel any pending scroll retries
        this._cancelScrollRetries();

        this._rehydrateAll();
        this._visibleSet.clear();
        this.active = false;
    }

    /**
     * Update options at runtime.
     * @param {Partial<VirtualizerOptions>} options
     */
    update(options) {
        this.options = { ...this.options, ...options };
        if (this.active) {
            this.disable();
            this.enable();
        }
    }

    /** Force rehydrate all messages (e.g., before export). */
    rehydrateAll() {
        this._rehydrateAll();
    }

    // ==================================================================
    // Scroll Direction Tracking
    // ==================================================================

    /** @private */
    _setupScrollTracker() {
        this._lastScrollTop = this._chatContainer.scrollTop;
        this._scrollHandler = () => {
            const top = this._chatContainer.scrollTop;
            this._scrollDirection = top >= this._lastScrollTop ? 1 : -1;
            this._lastScrollTop = top;
        };
        this._chatContainer.addEventListener('scroll', this._scrollHandler, { passive: true });
    }

    // ==================================================================
    // IntersectionObserver
    // ==================================================================

    /** @private */
    _setupIntersectionObserver() {
        const bufferPx = this.options.bufferSize * 250;

        this._observer = new IntersectionObserver(
            (entries) => this._onIntersection(entries),
            {
                root: this._chatContainer,
                rootMargin: `${bufferPx}px 0px ${bufferPx}px 0px`,
                threshold: 0,
            },
        );

        for (const mes of this._chatContainer.querySelectorAll('.mes')) {
            this._observer.observe(mes);
        }
    }

    /**
     * @private
     * @param {IntersectionObserverEntry[]} entries
     */
    _onIntersection(entries) {
        for (const entry of entries) {
            if (entry.isIntersecting) {
                this._visibleSet.add(entry.target);
                this._hydrate(entry.target);
            } else {
                this._visibleSet.delete(entry.target);
            }
        }
        this._scheduleDehydration();
    }

    /** @private Debounced to prevent flicker during fast scrolling. */
    _scheduleDehydration() {
        if (this._dehydrateTimer) return;
        this._dehydrateTimer = setTimeout(() => {
            this._dehydrateTimer = null;
            this._dehydrateOffscreen();
        }, 200);
    }

    // ==================================================================
    // MutationObserver - detects new messages & bulk chat loads
    // ==================================================================

    /** @private */
    _setupMutationObserver() {
        let pendingCount = 0;

        this._mutationObserver = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType === Node.ELEMENT_NODE && node.classList?.contains('mes')) {
                        this._observer?.observe(node);
                        pendingCount++;
                    }
                }
            }

            if (pendingCount > 0) {
                clearTimeout(this._bulkTimer);
                const count = pendingCount;
                this._bulkTimer = setTimeout(() => {
                    if (count >= this.options.bulkLoadThreshold) {
                        this._onBulkLoad();
                    } else {
                        this._trimOnNewMessage();
                    }
                    pendingCount = 0;
                }, 150);
            }
        });

        this._mutationObserver.observe(this._chatContainer, { childList: true });
    }

    /**
     * @private
     * Called when a bulk load of messages is detected.
     * Waits two frames for ST's scrollChatToBottom to settle,
     * then dehydrates and scrolls to bottom.
     */
    _onBulkLoad() {
        if (this._processingBulk) return;
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                this._bulkDehydrate();
                this._forceScrollToBottom();
            });
        });
    }

    // ==================================================================
    // Auto-Trim: Dehydrate excess top messages on new arrivals
    // ==================================================================

    /**
     * @private
     * Called after normal (non-bulk) message additions.
     * Enforces the hydration budget by dehydrating oldest messages from
     * the top. Budget = alwaysVisibleTail + bufferSize * 2.
     */
    _trimOnNewMessage() {
        if (!this._chatContainer || this._processingBulk) return;

        const messages = this._chatContainer.querySelectorAll('.mes');
        const total = messages.length;
        const maxHydrated = this.options.alwaysVisibleTail + this.options.bufferSize * 2;

        if (total <= maxHydrated) return;

        // Count currently hydrated messages
        let hydratedCount = 0;
        for (const mes of messages) {
            if (!mes.hasAttribute(DEHYDRATED_ATTR)) hydratedCount++;
        }

        let excess = hydratedCount - maxHydrated;
        if (excess <= 0) return;

        // Dehydrate from the top, skipping visible/editing messages
        let trimmed = 0;
        for (const mes of messages) {
            if (excess <= 0) break;
            if (mes.hasAttribute(DEHYDRATED_ATTR)) continue;
            if (mes.classList.contains('last_mes')) continue;
            if (this._visibleSet.has(mes)) continue;
            if (mes.querySelector('.mes_edit_buttons:not([style*="display: none"])')) continue;

            this._dehydrate(mes);
            excess--;
            trimmed++;
        }

        if (trimmed > 0) {
            console.log(`[PerfOptimizer/ChatVirt] Auto-trimmed ${trimmed} top messages`);
        }
    }

    // ==================================================================
    // Initial Processing
    // ==================================================================

    /** @private Handle messages already in the DOM when module enables. */
    _processExisting() {
        const messages = this._chatContainer.querySelectorAll('.mes');
        console.log(`[PerfOptimizer/ChatVirt] _processExisting: ${messages.length} messages found`);

        if (messages.length >= this.options.bulkLoadThreshold) {
            this._bulkDehydrate();
        } else if (messages.length > 0) {
            // Small chat: mark tail as visible
            const tailStart = Math.max(0, messages.length - this.options.alwaysVisibleTail);
            for (let i = tailStart; i < messages.length; i++) {
                this._visibleSet.add(messages[i]);
            }
        }

        // Always scroll to bottom on initial load to match SillyTavern behavior
        if (messages.length > 0) {
            this._forceScrollToBottom();
        }
    }

    // ==================================================================
    // Bulk Dehydration (KEY v2 OPTIMIZATION)
    // ==================================================================

    /**
     * @private
     * Dehydrate all off-screen messages in two phases:
     *   Phase 0: Override content-visibility:auto to get accurate heights
     *   Phase 1: Batch-read all heights (single forced layout)
     *   Phase 2: Batch-write attributes & styles (no layout triggers)
     *   Phase 3: Remove override
     *
     * The content-visibility override is critical: without it, the browser
     * returns contain-intrinsic-size (200px) instead of real heights for
     * off-screen messages, causing incorrect scrollHeight after dehydration.
     */
    _bulkDehydrate() {
        if (this._processingBulk) return;
        this._processingBulk = true;

        try {
            const messages = this._chatContainer.querySelectorAll('.mes');
            const total = messages.length;

            if (total <= this.options.alwaysVisibleTail) {
                return;
            }

            // Calculate how many bottom messages to keep hydrated
            const containerH = this._chatContainer.clientHeight || window.innerHeight;
            const visibleEstimate = Math.ceil(containerH / 150);
            const keepCount = Math.max(
                visibleEstimate + this.options.bufferSize * 2,
                this.options.alwaysVisibleTail,
            );
            const dehydrateEnd = Math.max(0, total - keepCount);

            if (dehydrateEnd === 0) return;

            // Phase 0: Override content-visibility:auto from CSS & DOM optimizer
            // so that offsetHeight returns REAL rendered heights, not placeholder
            // estimates from contain-intrinsic-size.
            let cvOverride = document.getElementById(CV_OVERRIDE_ID);
            if (!cvOverride) {
                cvOverride = document.createElement('style');
                cvOverride.id = CV_OVERRIDE_ID;
            }
            cvOverride.textContent = '.mes:not([data-perf-dehydrated]) { content-visibility: visible !important; }';
            document.head.appendChild(cvOverride);

            // Phase 1: Batch-read heights (forces ONE layout reflow with real heights)
            const heights = new Array(dehydrateEnd);
            for (let i = 0; i < dehydrateEnd; i++) {
                heights[i] = messages[i].offsetHeight;
            }

            // Remove override before writing (dehydrated messages get content-visibility:hidden)
            cvOverride.remove();

            // Phase 2: Batch-write dehydration (pure writes, no layout triggers)
            let dehydratedCount = 0;
            for (let i = 0; i < dehydrateEnd; i++) {
                const mes = messages[i];
                if (mes.hasAttribute(DEHYDRATED_ATTR)) continue;

                mes.setAttribute(DEHYDRATED_ATTR, '1');
                mes.setAttribute(HEIGHT_ATTR, String(heights[i]));
                mes.style.height = heights[i] + 'px';
                mes.style.minHeight = heights[i] + 'px';
                mes.style.overflow = 'hidden';
                mes.style.contentVisibility = 'hidden';
                dehydratedCount++;
            }

            // Update visible set to only include kept messages
            this._visibleSet.clear();
            for (let i = dehydrateEnd; i < total; i++) {
                this._visibleSet.add(messages[i]);
            }

            console.log(`[PerfOptimizer/ChatVirt] Bulk dehydrated ${dehydratedCount}/${total} messages (kept ${keepCount})`);
        } finally {
            this._processingBulk = false;
        }
    }

    // ==================================================================
    // Per-Message Dehydrate / Hydrate
    // ==================================================================

    /**
     * @private
     * Dehydrate individual off-screen messages (ongoing scroll management).
     */
    _dehydrateOffscreen() {
        if (!this._chatContainer || this._processingBulk) return;

        const messages = this._chatContainer.querySelectorAll('.mes');
        const total = messages.length;
        const tailStart = Math.max(0, total - this.options.alwaysVisibleTail);

        for (let i = 0; i < total; i++) {
            const mes = messages[i];

            // Skip: visible, tail, last message, or being edited
            if (this._visibleSet.has(mes)) continue;
            if (i >= tailStart) continue;
            if (mes.classList.contains('last_mes')) continue;
            if (mes.querySelector('.mes_edit_buttons:not([style*="display: none"])')) continue;

            this._dehydrate(mes);
        }
    }

    /**
     * @private
     * Collapse a single message to a fixed-height placeholder.
     * CSS rule handles child hiding via attribute selector.
     * @param {HTMLElement} mes
     */
    _dehydrate(mes) {
        if (mes.hasAttribute(DEHYDRATED_ATTR)) return;

        const height = mes.offsetHeight;
        mes.setAttribute(DEHYDRATED_ATTR, '1');
        mes.setAttribute(HEIGHT_ATTR, String(height));
        mes.style.height = height + 'px';
        mes.style.minHeight = height + 'px';
        mes.style.overflow = 'hidden';
        mes.style.contentVisibility = 'hidden';
    }

    /**
     * @private
     * Restore a dehydrated message to fully rendered state.
     * CSS rule restores child visibility when attribute is removed.
     * @param {HTMLElement} mes
     */
    _hydrate(mes) {
        if (!mes.hasAttribute(DEHYDRATED_ATTR)) return;

        mes.removeAttribute(DEHYDRATED_ATTR);
        mes.removeAttribute(HEIGHT_ATTR);
        mes.style.height = '';
        mes.style.minHeight = '';
        mes.style.overflow = '';
        mes.style.contentVisibility = '';
    }

    /**
     * @private
     * Rehydrate all dehydrated messages (used on disable).
     */
    _rehydrateAll() {
        if (!this._chatContainer) return;
        for (const mes of this._chatContainer.querySelectorAll(`[${DEHYDRATED_ATTR}]`)) {
            this._hydrate(mes);
        }
    }

    // ==================================================================
    // Scroll Position Helpers
    // ==================================================================

    /**
     * @private
     * Check if the chat container is scrolled to (or near) the bottom.
     * "Near bottom" means within 150px of the end, which accounts for
     * minor rendering differences.
     * @returns {boolean}
     */
    _isAtBottom() {
        if (!this._chatContainer) return true;
        const { scrollTop, scrollHeight, clientHeight } = this._chatContainer;
        return scrollHeight - scrollTop - clientHeight < 150;
    }

    /**
     * @private
     * Scroll the chat container to the very bottom.
     * Uses instant scroll (no smooth animation) to avoid visible lag.
     */
    _scrollToBottom() {
        if (!this._chatContainer) return;
        this._chatContainer.scrollTop = this._chatContainer.scrollHeight;
    }

    /**
     * @private
     * Cancel all pending scroll retry timers.
     */
    _cancelScrollRetries() {
        for (const id of this._scrollRetryTimers) {
            clearTimeout(id);
        }
        this._scrollRetryTimers = [];
    }

    /**
     * @private
     * Aggressively scroll to the bottom using multiple retry mechanisms.
     *
     * After bulk dehydration, content-visibility changes can cause
     * async layout recalculation. A single scrollTop assignment may not
     * survive these recalculations. This method retries with multiple
     * timing strategies to ensure the scroll position sticks.
     */
    _forceScrollToBottom() {
        if (!this._chatContainer) return;
        this._cancelScrollRetries();

        const doScroll = () => {
            if (!this._chatContainer) return;
            this._chatContainer.scrollTop = this._chatContainer.scrollHeight;
        };

        // Strategy 1: Immediate (handles case where layout is already stable)
        doScroll();

        // Strategy 2: Microtask (after current JS but before rendering)
        Promise.resolve().then(doScroll);

        // Strategy 3: Next animation frame (after browser has processed pending styles)
        requestAnimationFrame(() => {
            doScroll();
            // Strategy 4: Frame after that (browser may need 2 frames for content-visibility)
            requestAnimationFrame(doScroll);
        });

        // Strategy 5-7: Delayed fallbacks for async content-visibility reflow
        // content-visibility: hidden -> the browser may defer size recalculation
        const delays = [50, 200, 500];
        for (const ms of delays) {
            const id = setTimeout(() => {
                doScroll();
                // Remove this timer from tracking
                const idx = this._scrollRetryTimers.indexOf(id);
                if (idx !== -1) this._scrollRetryTimers.splice(idx, 1);
            }, ms);
            this._scrollRetryTimers.push(id);
        }

        // Strategy 8: Use scrollIntoView on the last message as ultimate fallback
        const lastRetryId = setTimeout(() => {
            if (!this._chatContainer) return;
            const lastMes = this._chatContainer.querySelector('.mes:last-child');
            if (lastMes) {
                lastMes.scrollIntoView({ block: 'end', behavior: 'instant' });
            }
            doScroll(); // One more try after scrollIntoView
            console.log(`[PerfOptimizer/ChatVirt] forceScrollToBottom complete, scrollTop=${this._chatContainer.scrollTop}, scrollHeight=${this._chatContainer.scrollHeight}`);
        }, 800);
        this._scrollRetryTimers.push(lastRetryId);
    }
}
