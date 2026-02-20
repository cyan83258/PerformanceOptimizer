/**
 * Settings Optimizer Module
 *
 * Applies optimal power_user settings for UI performance:
 *   - fast_ui_mode: true   (disables many visual effects in SillyTavern)
 *   - blur_strength: 0     (eliminates blur processing)
 *   - reduced_motion: true  (reduces animation overhead)
 *
 * Monitors for theme changes and re-applies settings automatically,
 * preventing themes from overriding performance-critical values.
 */

/** Settings to apply for optimal performance */
const OPTIMAL_SETTINGS = {
    fast_ui_mode: true,
    blur_strength: 0,
    reduced_motion: true,
};

export class SettingsOptimizer {
    /**
     * @param {Function} getContextFn - Returns the SillyTavern context object
     */
    constructor(getContextFn) {
        this._getContext = getContextFn;
        /** @type {Object|null} Saved original values for revert */
        this._originalValues = null;
        /** @type {Function|null} Event handler reference for cleanup */
        this._eventHandler = null;
        /** @type {boolean} Guard against recursive apply */
        this._isApplying = false;
        /** @type {boolean} */
        this.active = false;
    }

    /** Apply optimal settings and start watching for theme overrides. */
    enable() {
        this._applySettings();
        this._startWatching();
        this.active = true;
    }

    /** Stop watching. Applied settings persist (already saved). */
    disable() {
        this._stopWatching();
        this.active = false;
    }

    /** Revert to the original setting values captured before optimization. */
    revert() {
        if (!this._originalValues) return;

        const ctx = this._getContext();
        const powerUser = ctx.powerUserSettings;
        if (!powerUser) return;

        for (const [key, value] of Object.entries(this._originalValues)) {
            powerUser[key] = value;
        }
        ctx.saveSettingsDebounced();
        this._originalValues = null;
    }

    /** Force re-apply optimal settings now. */
    applyNow() {
        this._applySettings();
    }

    /**
     * @private
     * Apply the optimal settings to power_user and save.
     */
    _applySettings() {
        if (this._isApplying) return;
        this._isApplying = true;

        try {
            const ctx = this._getContext();
            const powerUser = ctx.powerUserSettings;
            if (!powerUser) {
                console.warn('[PerfOptimizer/Settings] powerUserSettings not available');
                return;
            }

            // Save original values (first time only)
            if (!this._originalValues) {
                this._originalValues = {};
                for (const key of Object.keys(OPTIMAL_SETTINGS)) {
                    this._originalValues[key] = powerUser[key];
                }
            }

            // Apply optimal values
            let changed = false;
            for (const [key, value] of Object.entries(OPTIMAL_SETTINGS)) {
                if (powerUser[key] !== value) {
                    powerUser[key] = value;
                    changed = true;
                }
            }

            if (changed) {
                ctx.saveSettingsDebounced();
                this._syncUI();
                console.log('[PerfOptimizer/Settings] Applied:', OPTIMAL_SETTINGS);
            }
        } finally {
            // Hold the guard for 500ms to prevent re-entry from debounced save events
            setTimeout(() => { this._isApplying = false; }, 500);
        }
    }

    /**
     * @private
     * Update SillyTavern's own UI controls to reflect applied values.
     */
    _syncUI() {
        try {
            const fastUi = document.getElementById('fast_ui_mode');
            if (fastUi) fastUi.checked = true;

            const blurSlider = document.getElementById('blur_strength');
            if (blurSlider) {
                blurSlider.value = 0;
                const counter = document.getElementById('blur_strength_counter');
                if (counter) counter.textContent = '0';
            }

            const reducedMotion = document.getElementById('reduced_motion');
            if (reducedMotion) reducedMotion.checked = true;
        } catch (_) {
            // UI elements may not exist yet
        }
    }

    /**
     * @private
     * Watch for settings/theme changes that might override our values.
     */
    _startWatching() {
        const ctx = this._getContext();
        if (!ctx.eventSource || !ctx.eventTypes) return;

        this._eventHandler = () => {
            if (this.active) {
                // Delay slightly to let the theme finish applying its values
                setTimeout(() => this._applySettings(), 150);
            }
        };

        ctx.eventSource.on(ctx.eventTypes.SETTINGS_UPDATED, this._eventHandler);
    }

    /** @private Remove event listener. */
    _stopWatching() {
        if (!this._eventHandler) return;
        try {
            const ctx = this._getContext();
            if (ctx.eventSource && ctx.eventTypes) {
                ctx.eventSource.off(ctx.eventTypes.SETTINGS_UPDATED, this._eventHandler);
            }
        } catch (_) { /* ignore */ }
        this._eventHandler = null;
    }
}
