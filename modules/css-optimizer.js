/**
 * CSS Performance Optimizer Module
 *
 * Dynamically injects CSS overrides to disable expensive visual effects.
 * Each optimization category can be toggled independently.
 *
 * Categories:
 *   - disableBlur: backdrop-filter removal (biggest perf win)
 *   - disableShadows: box-shadow & drop-shadow reduction
 *   - reduceAnimations: transition/animation minimization
 *   - disableTextEffects: text-shadow removal
 */

const STYLE_ID = 'perf-optimizer-dynamic-css';

/**
 * @typedef {Object} CSSOptions
 * @property {boolean} disableBlur
 * @property {boolean} disableShadows
 * @property {boolean} reduceAnimations
 * @property {boolean} disableTextEffects
 */

const DEFAULT_OPTIONS = {
    disableBlur: true,
    disableShadows: true,
    reduceAnimations: true,
    disableTextEffects: true,
};

export class CSSOptimizer {
    constructor() {
        /** @type {boolean} */
        this.active = false;
        /** @type {CSSOptions} */
        this.options = { ...DEFAULT_OPTIONS };
    }

    /**
     * Enable CSS optimizations.
     * @param {Partial<CSSOptions>} [options] - Override specific options
     */
    enable(options) {
        if (options) {
            this.options = { ...this.options, ...options };
        }
        this._inject();
        this.active = true;
    }

    /** Disable all CSS optimizations and remove injected styles. */
    disable() {
        this._remove();
        this.active = false;
    }

    /**
     * Update options and re-inject if currently active.
     * @param {Partial<CSSOptions>} options
     */
    update(options) {
        this.options = { ...this.options, ...options };
        if (this.active) {
            this._inject();
        }
    }

    /** @returns {CSSOptions} Copy of current options */
    getOptions() {
        return { ...this.options };
    }

    /** @private Inject or replace the dynamic style element */
    _inject() {
        this._remove();
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = this._buildCSS();
        document.head.appendChild(style);
    }

    /** @private Remove the dynamic style element */
    _remove() {
        const existing = document.getElementById(STYLE_ID);
        if (existing) existing.remove();
    }

    /**
     * @private
     * Build CSS string from current options.
     * @returns {string}
     */
    _buildCSS() {
        const sections = ['/* [Performance Optimizer] Dynamic CSS Overrides */'];

        if (this.options.disableBlur) {
            sections.push(CSS_BLUR);
        }

        if (this.options.disableShadows) {
            sections.push(CSS_SHADOWS);
        }

        if (this.options.reduceAnimations) {
            sections.push(CSS_ANIMATIONS);
        }

        if (this.options.disableTextEffects) {
            sections.push(CSS_TEXT_EFFECTS);
        }

        return sections.join('\n\n');
    }
}

/* ===================================================================
 * CSS Templates
 * Separated for readability and maintainability.
 * =================================================================== */

const CSS_BLUR = `
/* --- Blur Effects Disabled ---
 * backdrop-filter is the #1 cause of scroll jank.
 * Each backdrop-filter creates a new compositor layer and
 * requires blurring all pixels behind the element every frame. */
* {
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
}`;

const CSS_SHADOWS = `
/* --- Shadow Effects Minimized ---
 * box-shadow and drop-shadow require per-frame blurred shape rendering.
 * Disable on frequently repainted UI elements. */
.mes,
.inline-drawer,
.drawer-content,
.popup,
.popup-content,
.completion_prompt_manager_popup_entry,
#top-bar,
#form_create,
.range-block,
.list-group-item,
.character_select,
.group_select,
.bogus_folder_select {
    box-shadow: none !important;
}
.mes_block,
.drawer-content,
#top-bar,
.completion_prompt_manager_popup_entry {
    filter: none !important;
}`;

const CSS_ANIMATIONS = `
/* --- Animations & Transitions Minimized ---
 * Reduce transition durations on heavy UI elements.
 * Full disable only under prefers-reduced-motion. */
.mes,
.inline-drawer,
.inline-drawer-content,
.drawer-content,
.popup,
#sheld,
#top-bar,
.completion_prompt_manager_popup_entry,
.character_select,
.group_select {
    transition-duration: 0.02s !important;
    transition-delay: 0s !important;
}
@media (prefers-reduced-motion: reduce) {
    * {
        animation-duration: 0.01s !important;
        transition-duration: 0.01s !important;
    }
}`;

const CSS_TEXT_EFFECTS = `
/* --- Text Effects Disabled ---
 * text-shadow causes per-glyph blur rendering on repaint. */
body,
#chat .mes .mes_text,
.mes_text,
#sheld,
#top-bar {
    text-shadow: none !important;
}`;
