/** Batched image hints, scoped to chat. No geometry reads or global rescans. */
export class DOMOptimizer {
    constructor({ imageSelector = 'img', marker = 'dom' } = {}) {
        this._imageSelector = imageSelector;
        this._marker = marker;
        this.active = false;
        this._mutationObserver = null;
        this._frame = null;
        this._pending = new Set();
        this._images = new Set();
    }

    enable() {
        if (this.active) return;
        const chat = document.getElementById('chat');
        if (!chat) return;
        this.active = true;
        this._optimizeElement(chat);
        this._mutationObserver = new MutationObserver(records => {
            for (const record of records) {
                for (const node of record.addedNodes) if (node.nodeType === 1) this._pending.add(node);
                // Removed images must not be retained across chat changes.
                for (const node of record.removedNodes) {
                    if (node.nodeType !== 1) continue;
                    this._restoreTree(node);
                }
            }
            if (this._frame !== null || !this._pending.size) return;
            this._frame = requestAnimationFrame(() => {
                this._frame = null;
                const nodes = this._pending;
                this._pending = new Set();
                if (!this.active) return;
                for (const node of nodes) {
                    if (!chat.contains(node)) continue;
                    let parent = node.parentElement;
                    while (parent && !nodes.has(parent)) parent = parent.parentElement;
                    if (!parent) this._optimizeElement(node);
                }
            });
        });
        this._mutationObserver.observe(chat, { childList: true, subtree: true });
    }

    _optimizeElement(node) {
        if (node.matches('img')) this._image(node);
        for (const img of node.querySelectorAll('img')) this._image(img);
    }

    _image(img) {
        if (!img.matches(this._imageSelector)) return;
        // Record only attributes owned by this module; preserve explicit eager/decoding settings.
        for (const [name, value] of [['loading', 'lazy'], ['decoding', 'async']]) {
            if (img.hasAttribute(name)) continue;
            img.setAttribute(name, value);
            img.setAttribute(`data-perf-${this._marker}-${name}`, value);
            this._images.add(img);
        }
    }

    _restore(img) {
        for (const name of ['loading', 'decoding']) {
            const marker = `data-perf-${this._marker}-${name}`;
            if (!img.hasAttribute(marker)) continue;
            if (img.getAttribute(name) === img.getAttribute(marker)) img.removeAttribute(name);
            img.removeAttribute(marker);
        }
        this._images.delete(img);
    }

    _restoreTree(node) {
        if (this._images.has(node)) this._restore(node);
        for (const img of node.querySelectorAll(`img[data-perf-${this._marker}-loading], img[data-perf-${this._marker}-decoding]`)) this._restore(img);
    }

    disable() {
        this.active = false;
        this._mutationObserver?.disconnect();
        this._mutationObserver = null;
        if (this._frame !== null) cancelAnimationFrame(this._frame);
        this._frame = null;
        this._pending.clear();
        for (const img of this._images) this._restore(img);
    }
}
