import { DOMOptimizer } from './dom-optimizer.js';

/** Browser image caching plus avatar loading hints, without duplicate fetches or blobs. */
export class AvatarCache extends DOMOptimizer {
    constructor() {
        super({ imageSelector: '.avatar img', marker: 'avatar' });
    }
    // Compatibility API: the native HTTP cache is deliberately not cleared.
    clearCache() {}
    getStats() { return { cachedAvatars: 0, pendingFetches: 0 }; }
}
