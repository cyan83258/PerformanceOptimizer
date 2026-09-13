/** Reversible scroll containment without event interception or DOM observers. */
export class ScrollOptimizer {
    constructor() { this.active = false; this._styleEl = null; }
    enable() {
        if (this.active) return;
        this.active = true;
        this._styleEl = document.createElement('style');
        this._styleEl.textContent = `
            #chat, .completion_prompt_manager_list, #sheld, .drawer-content, .popup-content {
                overscroll-behavior: contain;
            }
        `;
        document.head.appendChild(this._styleEl);
    }
    disable() {
        this.active = false;
        this._styleEl?.remove();
        this._styleEl = null;
    }
}
