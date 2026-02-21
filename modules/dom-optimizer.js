/**
 * DOM Optimizer Module
 *
 * Optimizes DOM performance using browser APIs:
 *   - MutationObserver: auto-optimize newly added elements
 *   - Image lazy loading: adds loading="lazy" and decoding="async"
 *   - Content visibility: applies content-visibility to off-screen messages
 *
 * All optimizations are non-destructive and can be disabled cleanly.
 */

export class DOMOptimizer {
    constructor() {
        /** @type {boolean} */
        this.active = false;
        /** @type {MutationObserver|null} */
        this._mutationObserver = null;
        /** @type {WeakSet<Element>} Track already-optimized elements */
        this._optimizedElements = new WeakSet();
    }

    /** Enable DOM optimizations. */
    enable() {
        this._optimizeExistingElements();
        this._setupMutationObserver();
        this.active = true;
    }

    /** Disable DOM optimizations. */
    disable() {
        if (this._mutationObserver) {
            this._mutationObserver.disconnect();
            this._mutationObserver = null;
        }
        this.active = false;
    }

    /**
     * @private
     * Watch for new DOM elements and optimize them automatically.
     */
    _setupMutationObserver() {
        if (this._mutationObserver) {
            this._mutationObserver.disconnect();
        }

        let pendingFrame = false;
        const pendingNodes = [];

        this._mutationObserver = new MutationObserver((mutations) => {
            // Collect added nodes
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        pendingNodes.push(node);
                    }
                }
            }

            // Batch process in a single rAF to avoid layout thrashing
            if (!pendingFrame && pendingNodes.length > 0) {
                pendingFrame = true;
                requestAnimationFrame(() => {
                    const nodes = pendingNodes.splice(0, pendingNodes.length);
                    for (const node of nodes) {
                        this._optimizeElement(node);
                    }
                    pendingFrame = false;
                });
            }
        });

        // Observe at the highest meaningful level
        const target = document.getElementById('sheld') || document.body;
        this._mutationObserver.observe(target, {
            childList: true,
            subtree: true,
        });
    }

    /**
     * @private
     * Apply optimizations to all elements currently in the DOM.
     */
    _optimizeExistingElements() {
        // Images: add lazy loading
        const images = document.querySelectorAll('img:not([loading])');
        for (const img of images) {
            img.loading = 'lazy';
            img.decoding = 'async';
        }

        // Messages: ensure content-visibility
        const messages = document.querySelectorAll('.mes');
        for (const mes of messages) {
            this._optimizeMessageElement(mes);
        }
    }

    /**
     * @private
     * Optimize a single element and relevant children.
     * @param {Element} element
     */
    _optimizeElement(element) {
        if (this._optimizedElements.has(element)) return;
        this._optimizedElements.add(element);

        // Message elements
        if (element.classList?.contains('mes')) {
            this._optimizeMessageElement(element);
        }

        // Images within the element
        const images = element.querySelectorAll?.('img:not([loading])');
        if (images) {
            for (const img of images) {
                img.loading = 'lazy';
                img.decoding = 'async';
            }
        }
    }

    /**
     * @private
     * Apply message-specific optimizations.
     * @param {Element} element
     */
    _optimizeMessageElement(element) {
        if (this._optimizedElements.has(element)) return;
        this._optimizedElements.add(element);

        // Note: content-visibility is handled by CSS rule in style.css
        // and managed directly by ChatVirtualizer when active.
        // Do NOT set inline content-visibility here as it conflicts
        // with the virtualizer's height reading during bulk dehydration.
    }
}
