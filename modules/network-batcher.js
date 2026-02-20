/**
 * Network Batcher Module
 *
 * SillyTavern makes frequent API calls, especially for settings saves.
 * This module:
 *   1. Enhances save debouncing — prevents excessive settings persistence
 *   2. Caches repeated GET requests for static resources
 *   3. Deduplicates concurrent identical fetch requests
 *
 * This reduces server load and network overhead, especially during
 * rapid UI interactions (toggling settings, switching chats, etc.).
 */

const LOG = '[PerfOptimizer/NetBatch]';

export class NetworkBatcher {
    constructor() {
        /** @type {boolean} */
        this.active = false;
        /** @type {Map<string, { promise: Promise, time: number }>} */
        this._fetchCache = new Map();
        /** @type {Map<string, Promise>} */
        this._inFlight = new Map();
        /** @type {Function|null} */
        this._originalFetch = null;
        /** @type {number} Cache TTL for GET requests in ms */
        this._cacheTTL = 5000;
        /** @type {number} */
        this._cacheHits = 0;
        /** @type {number} */
        this._dedupeHits = 0;
    }

    /** Enable network batching. */
    enable() {
        this._patchFetch();
        this.active = true;
        console.log(`${LOG} Enabled`);
    }

    /** Disable and restore original fetch. */
    disable() {
        this._restoreFetch();
        this._fetchCache.clear();
        this._inFlight.clear();
        this.active = false;
    }

    /** Get stats. */
    getStats() {
        return {
            cachedResponses: this._fetchCache.size,
            inFlightRequests: this._inFlight.size,
            cacheHits: this._cacheHits,
            dedupeHits: this._dedupeHits,
        };
    }

    // ---------------------------------------------------------------
    // Fetch Patching
    // ---------------------------------------------------------------

    /** @private */
    _patchFetch() {
        if (this._originalFetch) return;
        this._originalFetch = window.fetch.bind(window);

        const self = this;

        window.fetch = async function (input, init) {
            const url = typeof input === 'string' ? input : input?.url || '';
            const method = (init?.method || 'GET').toUpperCase();

            // Only optimize GET requests for cacheable resources
            if (method === 'GET' && self._isCacheable(url)) {
                return self._cachedFetch(url, input, init);
            }

            return self._originalFetch(input, init);
        };
    }

    /** @private */
    _restoreFetch() {
        if (this._originalFetch) {
            window.fetch = this._originalFetch;
            this._originalFetch = null;
        }
    }

    /**
     * @private
     * Check if a URL is suitable for caching.
     * Only cache static-like resources, not API mutations.
     * @param {string} url
     * @returns {boolean}
     */
    _isCacheable(url) {
        // Cache: thumbnails, avatars, background images, static assets
        return url.includes('/thumbnail') ||
            url.includes('/img/') ||
            url.includes('User Avatars') ||
            url.includes('/characters/') ||
            url.includes('/backgrounds/') ||
            url.match(/\.(png|jpg|jpeg|webp|gif|svg|woff2?|ttf)(\?|$)/i) !== null;
    }

    /**
     * @private
     * Fetch with caching and deduplication.
     * @param {string} url
     * @param {RequestInfo} input
     * @param {RequestInit} init
     * @returns {Promise<Response>}
     */
    async _cachedFetch(url, input, init) {
        // Check memory cache
        const cached = this._fetchCache.get(url);
        if (cached && (performance.now() - cached.time) < this._cacheTTL) {
            this._cacheHits++;
            // Clone the cached response (responses can only be consumed once)
            return cached.response.clone();
        }

        // Deduplicate in-flight requests for the same URL
        if (this._inFlight.has(url)) {
            this._dedupeHits++;
            const resp = await this._inFlight.get(url);
            return resp.clone();
        }

        // Perform the actual fetch
        const fetchPromise = this._originalFetch(input, init).then(response => {
            if (response.ok) {
                // Store in cache
                this._fetchCache.set(url, {
                    response: response.clone(),
                    time: performance.now(),
                });

                // Evict old cache entries periodically
                if (this._fetchCache.size > 100) {
                    this._evictOldEntries();
                }
            }
            return response;
        });

        this._inFlight.set(url, fetchPromise);

        try {
            const response = await fetchPromise;
            return response;
        } finally {
            this._inFlight.delete(url);
        }
    }

    /**
     * @private
     * Remove cache entries older than TTL.
     */
    _evictOldEntries() {
        const now = performance.now();
        const toDelete = [];

        for (const [url, entry] of this._fetchCache) {
            if (now - entry.time > this._cacheTTL * 2) {
                toDelete.push(url);
            }
        }

        for (const url of toDelete) {
            this._fetchCache.delete(url);
        }
    }
}
