/** Explicit read/write batching. Never cache synchronous jQuery geometry or replace scrollTo. */
export class DOMScheduler {
    constructor() {
        this._reads = [];
        this._writes = [];
        this._frame = null;
        this._flushing = false;
    }
    read(fn) { this._reads.push(fn); this._schedule(); }
    write(fn) { this._writes.push(fn); this._schedule(); }
    _schedule() {
        if (this._frame !== null || this._flushing) return;
        this._frame = requestAnimationFrame(() => this._flush());
    }
    _flush() {
        this._frame = null;
        this._flushing = true;
        const run = queue => {
            for (const fn of queue) {
                try { fn(); } catch (error) { console.warn('[PerfOptimizer/Scheduler]', error); }
            }
        };
        run(this._reads.splice(0));
        run(this._writes.splice(0));
        this._flushing = false;
        if (this._reads.length || this._writes.length) this._schedule();
    }
    clear() {
        if (this._frame !== null) cancelAnimationFrame(this._frame);
        this._frame = null;
        this._reads.length = this._writes.length = 0;
    }
}

export class FrameOptimizer {
    constructor() { this.active = false; this.scheduler = new DOMScheduler(); }
    enable() { this.active = true; }
    disable() { this.active = false; }
    getScheduler() { return this.scheduler; }
}
