import { DOMScheduler } from './frame-optimizer.js';
const BUTTON = 'perf-collapse-toggle';
const ATTR = 'data-perf-collapsed';

/** Only measure visible, completed messages. Native virtualization handles the rest. */
export class MessageContentOptimizer {
    constructor(options = {}) {
        this.active = false;
        this.options = { collapseThresholdPx: 600, ...options };
        this._scheduler = new DOMScheduler();
        this._pending = new Set();
        this._visible = new Set();
        this._queued = false;
        this._generation = 0;
        this._chatContainer = null;
        this._observer = null;
        this._mutations = null;
        this._styleEl = null;
        this.useBatching = () => true;
    }
    enable() {
        if (this.active) return;
        const chat = document.getElementById('chat');
        if (!chat) return;
        this._chatContainer = chat;
        this.active = true;
        this._styleEl = document.createElement('style');
        this._styleEl.textContent = `
            #chat > .mes { contain: style; }
            #chat > .mes[${ATTR}]:not(.last_mes):not(:has(.edit_textarea, .reasoning_edit_textarea)) .mes_text {
                max-height: ${this.options.collapseThresholdPx}px !important;
                overflow: hidden !important;
            }
            #chat .${BUTTON} {
                display: block; width: 100%; padding: 8px; margin-top: 4px;
                color: inherit; background: var(--SmartThemeBlurTintColor, #333);
                border: 1px solid var(--SmartThemeBorderColor, #888); border-radius: 4px; cursor: pointer;
            }
        `;
        document.head.appendChild(this._styleEl);
        if (this.options.collapseThresholdPx <= 0 || typeof IntersectionObserver !== 'function') return;
        this._observer = new IntersectionObserver(entries => {
            if (!this.active) return;
            for (const { target, isIntersecting } of entries) {
                if (target.parentElement !== chat) continue;
                if (isIntersecting) { this._visible.add(target); this._queue(target); }
                else this._visible.delete(target);
            }
        }, { root: chat });
        for (const mes of chat.children) if (mes.matches('.mes')) this._observer.observe(mes);
        this._mutations = new MutationObserver(records => {
            for (const record of records) {
                if (record.target === chat && record.type === 'childList') {
                    for (const node of record.removedNodes) {
                        if (node.nodeType !== 1) continue;
                        this._observer.unobserve(node);
                        this._visible.delete(node);
                        this._pending.delete(node);
                        this._reset(node);
                    }
                    for (const node of record.addedNodes) {
                        if (node.nodeType === 1 && node.matches('.mes')) this._observer.observe(node);
                    }
                }
                const element = record.target.nodeType === 1 ? record.target : record.target.parentElement;
                const mes = element?.closest('.mes');
                if (mes && this._visible.has(mes)) this._queue(mes);
            }
        });
        this._mutations.observe(chat, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] });
        this._onLoad = event => {
            const mes = event.target.closest?.('.mes');
            if (this._visible.has(mes)) this._queue(mes);
        };
        chat.addEventListener('load', this._onLoad, true);
    }
    _queue(mes) {
        if (mes.classList.contains('last_mes')) return;
        this._pending.add(mes);
        if (this._queued) return;
        this._queued = true;
        const generation = this._generation;
        this._scheduler.read(() => {
            this._queued = false;
            const pending = [...this._pending];
            this._pending.clear();
            if (!this.active || generation !== this._generation) return;
            const measurements = [];
            for (const node of pending) {
                if (!this._eligible(node)) continue;
                const height = node.querySelector('.mes_text')?.scrollHeight || 0;
                if (height > this.options.collapseThresholdPx) {
                    if (this.useBatching()) measurements.push([node, height]);
                    else this._collapse(node, height);
                }
            }
            if (measurements.length) this._scheduler.write(() => {
                if (!this.active || generation !== this._generation) return;
                for (const [node, height] of measurements) if (this._eligible(node)) this._collapse(node, height);
            });
        });
    }
    _eligible(mes) {
        return mes.parentElement === this._chatContainer && this._visible.has(mes)
            && !mes.classList.contains('last_mes') && !mes.matches(':focus-within')
            && !mes.querySelector(`.${BUTTON}, .edit_textarea, .reasoning_edit_textarea`);
    }
    _collapse(mes, height) {
        const text = mes.querySelector('.mes_text');
        if (!text) return;
        mes.setAttribute(ATTR, '1');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = BUTTON;
        button.textContent = `▼ 펼치기 (${Math.round(height / this.options.collapseThresholdPx)}× 길이)`;
        button.setAttribute('aria-expanded', 'false');
        button.addEventListener('click', () => {
            const collapsed = mes.toggleAttribute(ATTR);
            button.textContent = collapsed ? '▼ 펼치기' : '▲ 접기';
            button.setAttribute('aria-expanded', String(!collapsed));
        });
        text.after(button);
    }
    _reset(mes) {
        mes.removeAttribute(ATTR);
        mes.querySelectorAll(`.${BUTTON}`).forEach(button => button.remove());
    }
    disable() {
        this.active = false;
        this._generation++;
        this._observer?.disconnect();
        this._mutations?.disconnect();
        this._observer = this._mutations = null;
        this._scheduler.clear();
        this._pending.clear();
        this._visible.clear();
        this._queued = false;
        if (this._onLoad) this._chatContainer?.removeEventListener('load', this._onLoad, true);
        this._onLoad = null;
        for (const mes of this._chatContainer?.querySelectorAll('.mes') || []) this._reset(mes);
        this._styleEl?.remove();
        this._styleEl = this._chatContainer = null;
    }
    update(options) {
        const number = Number(options.collapseThresholdPx ?? this.options.collapseThresholdPx);
        const threshold = Number.isFinite(number) ? Math.min(10000, Math.max(0, number)) : 600;
        if (threshold === this.options.collapseThresholdPx) return;
        const active = this.active;
        if (active) this.disable();
        this.options.collapseThresholdPx = threshold;
        if (active) this.enable();
    }
}
