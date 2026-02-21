/**
 * Scroll Optimizer Module
 *
 * Optimizes scroll performance for SillyTavern's UI:
 *   - Injects CSS for scroll containment and touch optimization
 *   - Optimizes the prompt manager list (content-visibility on entries)
 *   - Adds overscroll-behavior: contain to prevent scroll chaining
 *
 * Does NOT patch addEventListener (too risky for drag-and-drop).
 */

const STYLE_ID = 'perf-optimizer-scroll-css';

export class ScrollOptimizer {
    constructor() {
        /** @type {boolean} */
        this.active = false;
        /** @type {HTMLStyleElement|null} */
        this._styleEl = null;
        /** @type {MutationObserver|null} */
        this._promptListObserver = null;
        /** @type {Array<Function>} */
        this._cleanupFns = [];
    }

    /** Enable scroll optimizations. */
    enable() {
        this._injectScrollCSS();
        this._optimizePromptManager();
        this._optimizeScrollContainers();
        this.active = true;
    }

    /** Disable scroll optimizations and clean up. */
    disable() {
        if (this._styleEl) {
            this._styleEl.remove();
            this._styleEl = null;
        }
        if (this._promptListObserver) {
            this._promptListObserver.disconnect();
            this._promptListObserver = null;
        }
        for (const fn of this._cleanupFns) {
            try { fn(); } catch (_) { /* ignore */ }
        }
        this._cleanupFns = [];
        this.active = false;
    }

    /**
     * @private
     * Inject CSS rules for scroll performance.
     */
    _injectScrollCSS() {
        if (this._styleEl) this._styleEl.remove();

        this._styleEl = document.createElement('style');
        this._styleEl.id = STYLE_ID;
        this._styleEl.textContent = `
/* [Performance Optimizer] Scroll Optimizations */

/* Touch scrolling optimization */
#chat,
.completion_prompt_manager_list {
    -webkit-overflow-scrolling: touch;
    touch-action: pan-y;
}

/* Prompt manager entries: CSS containment to isolate repaints */
.completion_prompt_manager_popup_entry {
    contain: layout style;
}`;
        document.head.appendChild(this._styleEl);
    }

    /**
     * @private
     * Optimize the prompt manager list.
     * The prompt manager re-renders all 100+ entries on every toggle.
     * Apply content-visibility to each entry so the browser skips
     * rendering off-screen entries.
     */
    _optimizePromptManager() {
        if (this._promptListObserver) {
            this._promptListObserver.disconnect();
        }

        const optimizeEntries = () => {
            requestAnimationFrame(() => {
                const entries = document.querySelectorAll(
                    '.completion_prompt_manager_popup_entry:not([data-perf-scroll])'
                );
                for (const entry of entries) {
                    entry.style.contentVisibility = 'auto';
                    entry.style.containIntrinsicSize = 'auto 40px';
                    entry.dataset.perfScroll = '1';
                }
            });
        };

        // Observe the prompt manager list for re-renders
        this._promptListObserver = new MutationObserver(optimizeEntries);

        // The list may not exist yet; try now and also watch for it
        const list = document.querySelector('.completion_prompt_manager_list');
        if (list) {
            this._promptListObserver.observe(list, {
                childList: true,
                subtree: true,
            });
            optimizeEntries();
        } else {
            // Watch for the list to appear
            const bodyObserver = new MutationObserver(() => {
                const list = document.querySelector('.completion_prompt_manager_list');
                if (list) {
                    bodyObserver.disconnect();
                    this._promptListObserver.observe(list, {
                        childList: true,
                        subtree: true,
                    });
                    optimizeEntries();
                }
            });
            bodyObserver.observe(document.body, { childList: true, subtree: true });
            this._cleanupFns.push(() => bodyObserver.disconnect());
        }
    }

    /**
     * @private
     * Add scroll containment properties to key containers.
     */
    _optimizeScrollContainers() {
        const selectors = [
            '#chat',
            '.completion_prompt_manager_list',
            '#sheld',
            '.drawer-content',
            '.popup-content',
        ];

        for (const selector of selectors) {
            const el = document.querySelector(selector);
            if (!el) continue;

            const origOverscroll = el.style.overscrollBehavior;
            el.style.overscrollBehavior = 'contain';

            this._cleanupFns.push(() => {
                el.style.overscrollBehavior = origOverscroll || '';
            });
        }
    }
}
