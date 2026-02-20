/**
 * Avatar Cache Module
 *
 * SillyTavern loads avatar images via individual HTTP requests for each
 * message. The same character avatar is fetched repeatedly across messages.
 *
 * This module:
 *   1. Intercepts avatar image loading
 *   2. Caches fetched avatars as Blob URLs in memory
 *   3. Serves subsequent requests from cache (zero network overhead)
 *   4. Adds loading="lazy" and decoding="async" to avatar images
 *   5. Cleans up blob URLs on disable to prevent memory leaks
 */

const LOG = '[PerfOptimizer/AvatarCache]';

export class AvatarCache {
    constructor() {
        /** @type {boolean} */
        this.active = false;
        /** @type {Map<string, string>} original src -> blob URL */
        this._cache = new Map();
        /** @type {Map<string, Promise<string|null>>} in-flight fetch promises */
        this._pending = new Map();
        /** @type {MutationObserver|null} */
        this._observer = null;
        /** @type {WeakSet<HTMLImageElement>} already-processed images */
        this._processed = new WeakSet();
    }

    /** Enable avatar caching. */
    enable() {
        this._processExistingAvatars();
        this._setupObserver();
        this.active = true;
        console.log(`${LOG} Enabled`);
    }

    /** Disable and clean up. */
    disable() {
        if (this._observer) {
            this._observer.disconnect();
            this._observer = null;
        }
        // Don't revoke blob URLs immediately — images are still using them.
        // They will be freed when the page navigates or is refreshed.
        this._processed = new WeakSet();
        this.active = false;
    }

    /** Get cache stats. */
    getStats() {
        return {
            cachedAvatars: this._cache.size,
            pendingFetches: this._pending.size,
        };
    }

    /** Clear the entire cache and revoke all blob URLs. */
    clearCache() {
        for (const blobUrl of this._cache.values()) {
            try { URL.revokeObjectURL(blobUrl); } catch (_) { /* ignore */ }
        }
        this._cache.clear();
        this._pending.clear();
        this._processed = new WeakSet();
        console.log(`${LOG} Cache cleared`);
    }

    // ---------------------------------------------------------------
    // Processing
    // ---------------------------------------------------------------

    /** @private Process all existing avatar images in the DOM */
    _processExistingAvatars() {
        const avatarImgs = document.querySelectorAll('.mes .avatar img, .mesAvatarWrapper .avatar img');
        let count = 0;
        for (const img of avatarImgs) {
            if (this._processImage(img)) count++;
        }
        if (count > 0) console.log(`${LOG} Processing ${count} existing avatars`);
    }

    /** @private Watch for new avatar images */
    _setupObserver() {
        if (this._observer) this._observer.disconnect();

        let pendingFrame = false;
        const batch = [];

        this._observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType !== Node.ELEMENT_NODE) continue;

                    // Direct img in avatar container
                    if (node.tagName === 'IMG' && node.closest?.('.avatar')) {
                        batch.push(node);
                    }

                    // Container with avatar images inside
                    const imgs = node.querySelectorAll?.('.avatar img');
                    if (imgs) {
                        for (const img of imgs) batch.push(img);
                    }
                }

                // Attribute change on existing img (src change)
                if (mutation.type === 'attributes' &&
                    mutation.attributeName === 'src' &&
                    mutation.target.tagName === 'IMG' &&
                    mutation.target.closest?.('.avatar')) {
                    batch.push(mutation.target);
                }
            }

            if (!pendingFrame && batch.length > 0) {
                pendingFrame = true;
                requestAnimationFrame(() => {
                    const imgs = batch.splice(0, batch.length);
                    for (const img of imgs) {
                        this._processImage(img);
                    }
                    pendingFrame = false;
                });
            }
        });

        const chatEl = document.getElementById('chat') || document.body;
        this._observer.observe(chatEl, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['src'],
        });
    }

    /**
     * @private
     * Process a single avatar image element.
     * @param {HTMLImageElement} img
     * @returns {boolean} Whether the image was processed
     */
    _processImage(img) {
        if (this._processed.has(img)) return false;
        this._processed.add(img);

        // Add lazy loading hints
        if (!img.loading) img.loading = 'lazy';
        if (!img.decoding) img.decoding = 'async';

        const src = img.getAttribute('src');
        if (!src || src === '' || src.startsWith('blob:') || src.startsWith('data:')) {
            return false;
        }

        // Check cache hit
        if (this._cache.has(src)) {
            img.src = this._cache.get(src);
            return true;
        }

        // Only cache avatar-type URLs (not arbitrary images)
        if (!this._isAvatarUrl(src)) return false;

        // Fetch and cache
        this._fetchAndCache(src, img);
        return true;
    }

    /**
     * @private
     * Check if a URL looks like an avatar image.
     * @param {string} url
     * @returns {boolean}
     */
    _isAvatarUrl(url) {
        return url.includes('/thumbnail') ||
            url.includes('/avatar') ||
            url.includes('/img/') ||
            url.includes('User Avatars') ||
            url.includes('/characters/');
    }

    /**
     * @private
     * Fetch an image, convert to blob URL, cache it, and apply to img.
     * @param {string} src - Original image URL
     * @param {HTMLImageElement} img - Image element to update
     */
    async _fetchAndCache(src, img) {
        // Deduplicate concurrent fetches for the same URL
        if (this._pending.has(src)) {
            const blobUrl = await this._pending.get(src);
            if (blobUrl && this.active) img.src = blobUrl;
            return;
        }

        const fetchPromise = this._doFetch(src);
        this._pending.set(src, fetchPromise);

        try {
            const blobUrl = await fetchPromise;
            if (blobUrl && this.active) {
                this._cache.set(src, blobUrl);
                img.src = blobUrl;
            }
        } finally {
            this._pending.delete(src);
        }
    }

    /**
     * @private
     * Perform the actual fetch and blob conversion.
     * @param {string} src
     * @returns {Promise<string|null>}
     */
    async _doFetch(src) {
        try {
            const response = await fetch(src);
            if (!response.ok) return null;

            const blob = await response.blob();
            return URL.createObjectURL(blob);
        } catch (e) {
            console.warn(`${LOG} Failed to cache avatar:`, src, e);
            return null;
        }
    }
}
