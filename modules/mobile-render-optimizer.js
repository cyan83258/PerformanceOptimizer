/** Touch transitions only: no whitespace deletion or permanent GPU layer allocation. */
export class MobileRenderOptimizer {
    constructor() { this.active = false; this._styleEl = null; }
    enable() {
        if (this.active) return;
        this.active = true;
        this._styleEl = document.createElement('style');
        this._styleEl.textContent = `
            @media (max-width: 1000px) and (hover: none) and (pointer: coarse) {
                #chat .mes, .menu_button, .list-group-item { transition-duration: 0.01s !important; }
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
