/**
 * Background Image Optimizer Module
 *
 * SillyTavern backgrounds can be 2-5+ MB PNG files at high resolution.
 * This module intercepts background image changes and:
 *   1. Resizes to viewport dimensions (no point rendering 2560px on a 1920px screen)
 *   2. Converts to WebP for smaller memory footprint
 *   3. Caches the optimized version to avoid re-processing
 *
 * Uses OffscreenCanvas (or fallback Canvas) for processing.
 * Original files are never modified.
 */

const LOG = '[PerfOptimizer/BgOpt]';

export class BackgroundOptimizer {
    constructor() {
        /** @type {boolean} */
        this.active = false;
        /** @type {MutationObserver|null} */
        this._bgObserver = null;
        /** @type {Map<string, string>} url -> optimized blob URL */
        this._cache = new Map();
        /** @type {string|null} currently active blob URL */
        this._currentBlobUrl = null;
        /** @type {boolean} processing lock */
        this._processing = false;
    }

    /** Enable background optimization. */
    enable() {
        this._observeBackground();
        // Process current background immediately
        this._processCurrentBackground();
        this.active = true;
        console.log(`${LOG} Enabled`);
    }

    /** Disable and clean up cached blob URLs. */
    disable() {
        if (this._bgObserver) {
            this._bgObserver.disconnect();
            this._bgObserver = null;
        }
        this._restoreOriginalBackground();
        this._clearCache();
        this.active = false;
    }

    // ---------------------------------------------------------------
    // Background Observation
    // ---------------------------------------------------------------

    /** @private Watch #bg1 for background-image style changes */
    _observeBackground() {
        const bg1 = document.getElementById('bg1');
        if (!bg1) {
            console.warn(`${LOG} #bg1 element not found`);
            return;
        }

        this._bgObserver = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                if (mutation.type === 'attributes' && mutation.attributeName === 'style') {
                    // Delay slightly to let SillyTavern finish setting the background
                    setTimeout(() => this._processCurrentBackground(), 100);
                }
            }
        });

        this._bgObserver.observe(bg1, {
            attributes: true,
            attributeFilter: ['style'],
        });
    }

    // ---------------------------------------------------------------
    // Processing
    // ---------------------------------------------------------------

    /** @private Process the current background image */
    async _processCurrentBackground() {
        if (this._processing) return;

        const bg1 = document.getElementById('bg1');
        if (!bg1) return;

        const bgImage = bg1.style.backgroundImage;
        if (!bgImage || bgImage === 'none') return;

        // Extract URL from css background-image
        const urlMatch = bgImage.match(/url\(["']?([^"')]+)["']?\)/);
        if (!urlMatch) return;

        const originalUrl = urlMatch[1];

        // Skip already-optimized blob URLs
        if (originalUrl.startsWith('blob:')) return;

        // Check cache
        if (this._cache.has(originalUrl)) {
            const cachedUrl = this._cache.get(originalUrl);
            bg1.style.backgroundImage = `url("${cachedUrl}")`;
            this._currentBlobUrl = cachedUrl;
            return;
        }

        this._processing = true;

        try {
            const optimizedUrl = await this._optimizeImage(originalUrl);
            if (optimizedUrl && this.active) {
                this._cache.set(originalUrl, optimizedUrl);
                // Store original URL for restoration
                if (!bg1.dataset.perfOriginalBg) {
                    bg1.dataset.perfOriginalBg = bgImage;
                }
                bg1.style.backgroundImage = `url("${optimizedUrl}")`;
                this._currentBlobUrl = optimizedUrl;
                console.log(`${LOG} Background optimized`);
            }
        } catch (e) {
            console.warn(`${LOG} Failed to optimize background:`, e);
        } finally {
            this._processing = false;
        }
    }

    /**
     * @private
     * Optimize an image: resize to viewport and convert to WebP.
     * @param {string} url - Original image URL
     * @returns {Promise<string|null>} Blob URL of optimized image, or null
     */
    async _optimizeImage(url) {
        // Load image
        const img = await this._loadImage(url);
        if (!img) return null;

        // Calculate target dimensions (match viewport, with DPR consideration capped at 1)
        const targetWidth = window.innerWidth;
        const targetHeight = window.innerHeight;

        // Only optimize if image is significantly larger than viewport
        if (img.naturalWidth <= targetWidth * 1.1 && img.naturalHeight <= targetHeight * 1.1) {
            console.log(`${LOG} Image already near viewport size, skipping`);
            return null;
        }

        // Calculate resize dimensions maintaining aspect ratio
        const scale = Math.max(
            targetWidth / img.naturalWidth,
            targetHeight / img.naturalHeight,
        );
        const newWidth = Math.round(img.naturalWidth * scale);
        const newHeight = Math.round(img.naturalHeight * scale);

        // Use canvas to resize
        const canvas = document.createElement('canvas');
        canvas.width = newWidth;
        canvas.height = newHeight;

        const ctx = canvas.getContext('2d');
        if (!ctx) return null;

        // High quality resize
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, newWidth, newHeight);

        // Convert to WebP blob (better compression, native browser support)
        const blob = await new Promise((resolve) => {
            canvas.toBlob(resolve, 'image/webp', 0.85);
        });

        if (!blob) return null;

        const originalSize = await this._estimateOriginalSize(url);
        const newSize = blob.size;
        const savings = originalSize > 0
            ? `${Math.round((1 - newSize / originalSize) * 100)}% smaller`
            : `${(newSize / 1024).toFixed(0)}KB`;

        console.log(
            `${LOG} Resized ${img.naturalWidth}x${img.naturalHeight} -> ${newWidth}x${newHeight}, ${savings}`,
        );

        return URL.createObjectURL(blob);
    }

    /**
     * @private
     * Load an image element from URL.
     * @param {string} url
     * @returns {Promise<HTMLImageElement|null>}
     */
    _loadImage(url) {
        return new Promise((resolve) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => resolve(img);
            img.onerror = () => resolve(null);
            img.src = url;
        });
    }

    /**
     * @private
     * Try to estimate the original file size via HEAD request.
     * @param {string} url
     * @returns {Promise<number>} Size in bytes, or 0 if unknown
     */
    async _estimateOriginalSize(url) {
        try {
            const resp = await fetch(url, { method: 'HEAD' });
            const len = resp.headers.get('content-length');
            return len ? parseInt(len, 10) : 0;
        } catch {
            return 0;
        }
    }

    /** @private Restore original background */
    _restoreOriginalBackground() {
        const bg1 = document.getElementById('bg1');
        if (bg1 && bg1.dataset.perfOriginalBg) {
            bg1.style.backgroundImage = bg1.dataset.perfOriginalBg;
            delete bg1.dataset.perfOriginalBg;
        }
    }

    /** @private Revoke all cached blob URLs */
    _clearCache() {
        for (const blobUrl of this._cache.values()) {
            try { URL.revokeObjectURL(blobUrl); } catch (_) { /* ignore */ }
        }
        this._cache.clear();
        this._currentBlobUrl = null;
    }
}
