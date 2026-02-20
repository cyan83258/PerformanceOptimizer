/**
 * Prompt Manager Optimizer Module
 *
 * The default PromptManager rebuilds ALL entries on every render via innerHTML
 * and re-initializes jQuery .sortable() each time. With 100+ prompts this
 * causes visible jank.
 *
 * This module:
 *   1. Debounces rapid consecutive re-renders (e.g., toggling prompts quickly)
 *   2. Applies content-visibility to individual prompt entries
 *   3. Throttles jQuery sortable re-initialization
 *   4. Monitors the prompt list for changes and re-applies optimizations
 */

const LOG = '[PerfOptimizer/PromptOpt]';

export class PromptOptimizer {
    constructor() {
        /** @type {boolean} */
        this.active = false;
        /** @type {MutationObserver|null} */
        this._listObserver = null;
        /** @type {MutationObserver|null} */
        this._scanObserver = null;
        /** @type {number|null} */
        this._debounceTimer = null;
        /** @type {Function[]} */
        this._cleanupFns = [];
        /** @type {WeakSet<Element>} */
        this._optimizedEntries = new WeakSet();
        /** @type {boolean} */
        this._sortablePatched = false;
    }

    /** Enable prompt manager optimizations. */
    enable() {
        this._attachToList();
        this._patchSortableInit();
        this.active = true;
        console.log(`${LOG} Enabled`);
    }

    /** Disable and clean up. */
    disable() {
        if (this._listObserver) {
            this._listObserver.disconnect();
            this._listObserver = null;
        }
        if (this._scanObserver) {
            this._scanObserver.disconnect();
            this._scanObserver = null;
        }
        if (this._debounceTimer) {
            clearTimeout(this._debounceTimer);
            this._debounceTimer = null;
        }
        this._restoreSortable();
        for (const fn of this._cleanupFns) {
            try { fn(); } catch (_) { /* ignore */ }
        }
        this._cleanupFns = [];
        this._optimizedEntries = new WeakSet();
        this.active = false;
    }

    // ---------------------------------------------------------------
    // List Attachment
    // ---------------------------------------------------------------

    /** @private */
    _attachToList() {
        const list = document.querySelector('.completion_prompt_manager_list');
        if (list) {
            this._watchList(list);
            this._optimizeEntries(list);
        } else {
            // List may not exist yet — watch for it
            this._scanForList();
        }
    }

    /** @private Watch body for the prompt list to appear */
    _scanForList() {
        if (this._scanObserver) this._scanObserver.disconnect();

        this._scanObserver = new MutationObserver(() => {
            const list = document.querySelector('.completion_prompt_manager_list');
            if (list) {
                this._scanObserver.disconnect();
                this._scanObserver = null;
                this._watchList(list);
                this._optimizeEntries(list);
            }
        });

        this._scanObserver.observe(document.body, {
            childList: true,
            subtree: true,
        });
        this._cleanupFns.push(() => this._scanObserver?.disconnect());
    }

    /**
     * @private
     * Watch the prompt list for child changes (re-renders).
     * @param {HTMLElement} list
     */
    _watchList(list) {
        if (this._listObserver) this._listObserver.disconnect();

        this._listObserver = new MutationObserver(() => {
            // Debounce: PromptManager sometimes does rapid re-renders
            if (this._debounceTimer) clearTimeout(this._debounceTimer);
            this._debounceTimer = setTimeout(() => {
                this._debounceTimer = null;
                this._optimizeEntries(list);
            }, 50);
        });

        this._listObserver.observe(list, {
            childList: true,
            subtree: false, // only direct child changes
        });
    }

    // ---------------------------------------------------------------
    // Entry Optimization
    // ---------------------------------------------------------------

    /**
     * @private
     * Apply CSS containment and content-visibility to each prompt entry.
     * @param {HTMLElement} list
     */
    _optimizeEntries(list) {
        requestAnimationFrame(() => {
            const entries = list.querySelectorAll('.completion_prompt_manager_popup_entry');
            let optimized = 0;

            for (const entry of entries) {
                if (this._optimizedEntries.has(entry)) continue;
                this._optimizedEntries.add(entry);

                // content-visibility: skip rendering for off-screen entries
                entry.style.contentVisibility = 'auto';
                entry.style.containIntrinsicSize = 'auto 40px';

                // CSS containment: isolate layout recalculations
                entry.style.contain = 'layout style';

                optimized++;
            }

            if (optimized > 0) {
                console.log(`${LOG} Optimized ${optimized} prompt entries (total: ${entries.length})`);
            }
        });
    }

    // ---------------------------------------------------------------
    // Sortable Throttling
    // ---------------------------------------------------------------

    /**
     * @private
     * Patch jQuery.fn.sortable to throttle re-initialization.
     * The PromptManager calls .sortable() on every render, which destroys
     * and recreates drag handlers for all entries.
     */
    _patchSortableInit() {
        if (this._sortablePatched) return;
        if (!$.fn.sortable) return;

        const originalSortable = $.fn.sortable;
        const self = this;
        let lastInitTime = 0;
        const MIN_INTERVAL = 300; // ms between sortable re-inits

        $.fn.sortable = function (...args) {
            // Only throttle initialization calls (no args = init, or object arg = options)
            const isInit = args.length === 0 ||
                (args.length === 1 && typeof args[0] === 'object');

            if (isInit && this.hasClass('completion_prompt_manager_list')) {
                const now = Date.now();
                if (now - lastInitTime < MIN_INTERVAL) {
                    // Skip this re-init, too soon
                    return this;
                }
                lastInitTime = now;
            }

            return originalSortable.apply(this, args);
        };

        this._originalSortable = originalSortable;
        this._sortablePatched = true;
    }

    /** @private Restore original sortable */
    _restoreSortable() {
        if (this._sortablePatched && this._originalSortable) {
            $.fn.sortable = this._originalSortable;
            this._sortablePatched = false;
            this._originalSortable = null;
        }
    }
}
