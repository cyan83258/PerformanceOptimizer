/** CSS follows rebuilt prompt lists automatically; sortable and measurements remain native. */
export class PromptOptimizer {
    constructor() { this.active = false; this._styleEl = null; }
    enable() {
        if (this.active) return;
        this.active = true;
        this._styleEl = document.createElement('style');
        this._styleEl.textContent = `
            .completion_prompt_manager_list .completion_prompt_manager_popup_entry {
                content-visibility: auto;
                contain-intrinsic-block-size: auto 40px;
            }
            .completion_prompt_manager_list:has(.ui-sortable-helper) .completion_prompt_manager_popup_entry,
            .completion_prompt_manager_list .completion_prompt_manager_popup_entry:focus-within {
                content-visibility: visible;
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
