/** Deduplicate only plain, same-origin static GETs. HTTP caching stays with the browser. */
export class NetworkBatcher {
    constructor() {
        this.active = false;
        this._inFlight = new Map();
        this._dedupeHits = 0;
        this._wrapper = null;
        this._originalFetch = null;
    }

    enable() {
        if (this.active) return;
        this.active = true;
        const original = window.fetch;
        const pending = new Map();
        this._inFlight = pending;
        this._originalFetch = original;
        const self = this;
        const wrapper = function(input, init) {
            // Request objects and any options may carry method, auth, headers, abort or cache semantics.
            // Forward them untouched. Never merge caller cancellation signals.
            const key = self.active && self._wrapper === wrapper && init === undefined
                ? self._key(input) : null;
            if (!key) return original.call(this, input, init);
            let promise = pending.get(key);
            if (promise) self._dedupeHits++;
            else {
                if (pending.size >= 32) return original.call(this, input, init);
                promise = Promise.resolve().then(() => original.call(window, input, init));
                pending.set(key, promise);
                // Keep no Response bodies or URLs after the request has settled.
                promise.then(() => pending.delete(key), () => pending.delete(key));
            }
            // Each consumer gets its own body, including the first caller.
            return promise.then(response => response.clone());
        };
        this._wrapper = wrapper;
        window.fetch = wrapper;
    }

    _key(input) {
        if (typeof input !== 'string' && !(input instanceof URL)) return null;
        try {
            const url = new URL(input, document.baseURI);
            if (url.origin !== location.origin || !/^https?:$/.test(url.protocol) || url.username || url.password) return null;
            const path = url.pathname;
            if (!/^(?:\/thumbnail$|\/(?:img|backgrounds|characters|User%20Avatars)\/)/i.test(path)) return null;
            url.hash = '';
            return url.href;
        } catch { return null; }
    }

    disable() {
        this.active = false;
        // Do not remove another extension's wrapper installed after ours.
        if (window.fetch === this._wrapper) window.fetch = this._originalFetch;
        this._wrapper = this._originalFetch = null;
        this._inFlight.clear();
    }

    getStats() {
        return { cachedResponses: 0, inFlightRequests: this._inFlight.size, cacheHits: 0, dedupeHits: this._dedupeHits };
    }
}
