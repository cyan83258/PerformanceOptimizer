/**
 * SillyTavern Performance Optimizer Extension
 *
 * Orchestrates multiple optimization modules to improve UI performance:
 *
 *   - CSS Optimizer:        Disables expensive visual effects (blur, shadow, animations)
 *   - Settings Optimizer:   Applies optimal power_user settings (fast_ui_mode, etc.)
 *   - DOM Optimizer:        Lazy loading, content-visibility, MutationObserver
 *   - Scroll Optimizer:     Scroll containment, prompt manager optimization
 *   - Chat Virtualizer:     Virtual scrolling for chat messages
 *   - Prompt Optimizer:     Debounced prompt manager rendering, sortable throttling
 *   - Background Optimizer: Auto-resize/WebP conversion for background images
 *   - Avatar Cache:         In-memory blob URL caching for avatar images
 *   - Frame Optimizer:      Layout thrashing prevention, DOM read/write batching
 *   - Network Batcher:      GET request caching and deduplication
 *   - Mobile Keyboard:      Prevents layout thrashing on virtual keyboard open/close (v4)
 *   - Mobile Layout:        Stabilizes dvh/vh heights, CSS containment
 *   - Mobile Touch:         Tap delay removal, scroll optimization (v2)
 *   - Mobile Render:        Panel hibernation, GPU promotion, idle cleanup
 *   - Mobile Input:         Edit-mode optimization, textarea resize batching
 *   - Message Content:      CSS containment, lazy images, long message collapsing
 *
 * Each module can be toggled independently from the extension settings panel.
 *
 * @version 4.0.0
 */

const MODULE_NAME = 'SillyTavern-PerformanceOptimizer';
const LOG_PREFIX = '[PerfOptimizer]';

// ===================================================================
// Default Settings
// ===================================================================

const DEFAULT_SETTINGS = {
    enabled: true,
    cssOptimizer: {
        enabled: true,
        disableBlur: true,
        disableShadows: true,
        reduceAnimations: true,
        disableTextEffects: true,
    },
    settingsOptimizer: {
        enabled: true,
    },
    domOptimizer: {
        enabled: true,
    },
    scrollOptimizer: {
        enabled: true,
    },
    chatVirtualizer: {
        enabled: true,
        bufferSize: 2,
        alwaysVisibleTail: 3,
    },
    promptOptimizer: {
        enabled: true,
    },
    bgOptimizer: {
        enabled: true,
    },
    avatarCache: {
        enabled: true,
    },
    frameOptimizer: {
        enabled: true,
    },
    networkBatcher: {
        enabled: true,
    },
    mobileKeyboard: {
        enabled: true,
    },
    mobileLayout: {
        enabled: true,
    },
    mobileTouch: {
        enabled: true,
    },
    mobileRender: {
        enabled: true,
    },
    mobileInput: {
        enabled: true,
    },
    messageContent: {
        enabled: true,
        collapseThresholdPx: 600,
    },
};

// ===================================================================
// Context Helpers
// ===================================================================

/** @returns {object} SillyTavern context */
function getContext() {
    return SillyTavern.getContext();
}

/** Resolve a module URL relative to this script's location. */
function moduleUrl(path) {
    return new URL(path, import.meta.url).href;
}

// ===================================================================
// Module Instances
// ===================================================================

/** @type {import('./modules/css-optimizer.js').CSSOptimizer|null} */
let cssOptimizer = null;
/** @type {import('./modules/settings-optimizer.js').SettingsOptimizer|null} */
let settingsOptimizer = null;
/** @type {import('./modules/dom-optimizer.js').DOMOptimizer|null} */
let domOptimizer = null;
/** @type {import('./modules/scroll-optimizer.js').ScrollOptimizer|null} */
let scrollOptimizer = null;
/** @type {import('./modules/chat-virtualizer.js').ChatVirtualizer|null} */
let chatVirtualizer = null;
/** @type {import('./modules/prompt-optimizer.js').PromptOptimizer|null} */
let promptOptimizer = null;
/** @type {import('./modules/bg-optimizer.js').BackgroundOptimizer|null} */
let bgOptimizer = null;
/** @type {import('./modules/avatar-cache.js').AvatarCache|null} */
let avatarCache = null;
/** @type {import('./modules/frame-optimizer.js').FrameOptimizer|null} */
let frameOptimizer = null;
/** @type {import('./modules/network-batcher.js').NetworkBatcher|null} */
let networkBatcher = null;
/** @type {import('./modules/mobile-keyboard-optimizer.js').MobileKeyboardOptimizer|null} */
let mobileKeyboard = null;
/** @type {import('./modules/mobile-layout-stabilizer.js').MobileLayoutStabilizer|null} */
let mobileLayout = null;
/** @type {import('./modules/mobile-touch-optimizer.js').MobileTouchOptimizer|null} */
let mobileTouch = null;
/** @type {import('./modules/mobile-render-optimizer.js').MobileRenderOptimizer|null} */
let mobileRender = null;
/** @type {import('./modules/mobile-input-optimizer.js').MobileInputOptimizer|null} */
let mobileInput = null;
/** @type {import('./modules/message-content-optimizer.js').MessageContentOptimizer|null} */
let messageContentOptimizer = null;

// ===================================================================
// Settings Management
// ===================================================================

/**
 * Load extension settings, initializing defaults if needed.
 * Handles migration from v1 settings (adds new module defaults).
 * @returns {object} Current settings
 */
function loadSettings() {
    const ctx = getContext();
    if (!ctx.extensionSettings[MODULE_NAME]) {
        ctx.extensionSettings[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
        ctx.saveSettingsDebounced();
    } else {
        // Migration: add new module defaults if missing
        const s = ctx.extensionSettings[MODULE_NAME];
        let migrated = false;
        for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
            if (!(key in s)) {
                s[key] = structuredClone(value);
                migrated = true;
            } else if (typeof value === 'object' && value !== null && typeof s[key] === 'object') {
                // Merge missing sub-keys for existing modules
                for (const [subKey, subValue] of Object.entries(value)) {
                    if (!(subKey in s[key])) {
                        s[key][subKey] = structuredClone(subValue);
                        migrated = true;
                    }
                }
            }
        }
        if (migrated) ctx.saveSettingsDebounced();
    }
    return ctx.extensionSettings[MODULE_NAME];
}

/** @returns {object} Current settings (never null) */
function getSettings() {
    return getContext().extensionSettings[MODULE_NAME] || DEFAULT_SETTINGS;
}

/** Persist current settings via SillyTavern's debounced save. */
function saveSettings() {
    getContext().saveSettingsDebounced();
}

// ===================================================================
// Module Loading
// ===================================================================

/**
 * Dynamically import a module with error handling.
 * @param {string} path - Relative module path
 * @returns {Promise<object|null>} Module exports or null on failure
 */
async function safeImport(path) {
    try {
        return await import(moduleUrl(path));
    } catch (e) {
        console.error(`${LOG_PREFIX} Failed to load ${path}:`, e);
        return null;
    }
}

/**
 * Load and instantiate all optimizer modules in parallel.
 */
async function initModules() {
    const [
        cssMod, settingsMod, domMod, scrollMod,
        chatVirtMod, promptMod, bgMod, avatarMod, frameMod, netMod,
        mobileKbMod, mobileLayoutMod, mobileTouchMod,
        mobileRenderMod, mobileInputMod, msgContentMod,
    ] = await Promise.all([
        safeImport('./modules/css-optimizer.js'),
        safeImport('./modules/settings-optimizer.js'),
        safeImport('./modules/dom-optimizer.js'),
        safeImport('./modules/scroll-optimizer.js'),
        safeImport('./modules/chat-virtualizer.js'),
        safeImport('./modules/prompt-optimizer.js'),
        safeImport('./modules/bg-optimizer.js'),
        safeImport('./modules/avatar-cache.js'),
        safeImport('./modules/frame-optimizer.js'),
        safeImport('./modules/network-batcher.js'),
        safeImport('./modules/mobile-keyboard-optimizer.js'),
        safeImport('./modules/mobile-layout-stabilizer.js'),
        safeImport('./modules/mobile-touch-optimizer.js'),
        safeImport('./modules/mobile-render-optimizer.js'),
        safeImport('./modules/mobile-input-optimizer.js'),
        safeImport('./modules/message-content-optimizer.js'),
    ]);

    if (cssMod?.CSSOptimizer) {
        cssOptimizer = new cssMod.CSSOptimizer();
    }
    if (settingsMod?.SettingsOptimizer) {
        settingsOptimizer = new settingsMod.SettingsOptimizer(getContext);
    }
    if (domMod?.DOMOptimizer) {
        domOptimizer = new domMod.DOMOptimizer();
    }
    if (scrollMod?.ScrollOptimizer) {
        scrollOptimizer = new scrollMod.ScrollOptimizer();
    }
    if (chatVirtMod?.ChatVirtualizer) {
        chatVirtualizer = new chatVirtMod.ChatVirtualizer();
    }
    if (promptMod?.PromptOptimizer) {
        promptOptimizer = new promptMod.PromptOptimizer();
    }
    if (bgMod?.BackgroundOptimizer) {
        bgOptimizer = new bgMod.BackgroundOptimizer();
    }
    if (avatarMod?.AvatarCache) {
        avatarCache = new avatarMod.AvatarCache();
    }
    if (frameMod?.FrameOptimizer) {
        frameOptimizer = new frameMod.FrameOptimizer();
    }
    if (netMod?.NetworkBatcher) {
        networkBatcher = new netMod.NetworkBatcher();
    }
    if (mobileKbMod?.MobileKeyboardOptimizer) {
        mobileKeyboard = new mobileKbMod.MobileKeyboardOptimizer();
    }
    if (mobileLayoutMod?.MobileLayoutStabilizer) {
        mobileLayout = new mobileLayoutMod.MobileLayoutStabilizer();
    }
    if (mobileTouchMod?.MobileTouchOptimizer) {
        mobileTouch = new mobileTouchMod.MobileTouchOptimizer();
    }
    if (mobileRenderMod?.MobileRenderOptimizer) {
        mobileRender = new mobileRenderMod.MobileRenderOptimizer();
    }
    if (mobileInputMod?.MobileInputOptimizer) {
        mobileInput = new mobileInputMod.MobileInputOptimizer();
    }
    if (msgContentMod?.MessageContentOptimizer) {
        messageContentOptimizer = new msgContentMod.MessageContentOptimizer();
    }

    const loaded = [
        cssOptimizer && 'CSS',
        settingsOptimizer && 'Settings',
        domOptimizer && 'DOM',
        scrollOptimizer && 'Scroll',
        chatVirtualizer && 'ChatVirt',
        promptOptimizer && 'PromptOpt',
        bgOptimizer && 'BgOpt',
        avatarCache && 'AvatarCache',
        frameOptimizer && 'FrameOpt',
        networkBatcher && 'NetBatch',
        mobileKeyboard && 'MobileKB',
        mobileLayout && 'MobileLayout',
        mobileTouch && 'MobileTouch',
        mobileRender && 'MobileRender',
        mobileInput && 'MobileInput',
        messageContentOptimizer && 'MsgContent',
    ].filter(Boolean);

    console.log(`${LOG_PREFIX} Modules loaded: ${loaded.join(', ')}`);
}

// ===================================================================
// Optimization Control
// ===================================================================

/** Apply all optimizations based on current settings. */
function applyOptimizations() {
    const settings = getSettings();

    if (!settings.enabled) {
        disableAll();
        return;
    }

    // CSS Optimizer
    if (cssOptimizer) {
        if (settings.cssOptimizer.enabled) {
            cssOptimizer.enable(settings.cssOptimizer);
        } else {
            cssOptimizer.disable();
        }
    }

    // Settings Optimizer
    if (settingsOptimizer) {
        if (settings.settingsOptimizer.enabled) {
            settingsOptimizer.enable();
        } else {
            settingsOptimizer.disable();
        }
    }

    // DOM Optimizer
    if (domOptimizer) {
        if (settings.domOptimizer.enabled) {
            domOptimizer.enable();
        } else {
            domOptimizer.disable();
        }
    }

    // Scroll Optimizer
    if (scrollOptimizer) {
        if (settings.scrollOptimizer.enabled) {
            scrollOptimizer.enable();
        } else {
            scrollOptimizer.disable();
        }
    }

    // Chat Virtualizer
    if (chatVirtualizer) {
        if (settings.chatVirtualizer.enabled) {
            chatVirtualizer.update({
                bufferSize: settings.chatVirtualizer.bufferSize,
                alwaysVisibleTail: settings.chatVirtualizer.alwaysVisibleTail,
            });
            chatVirtualizer.enable();
        } else {
            chatVirtualizer.disable();
        }
    }

    // Prompt Optimizer
    if (promptOptimizer) {
        if (settings.promptOptimizer.enabled) {
            promptOptimizer.enable();
        } else {
            promptOptimizer.disable();
        }
    }

    // Background Optimizer
    if (bgOptimizer) {
        if (settings.bgOptimizer.enabled) {
            bgOptimizer.enable();
        } else {
            bgOptimizer.disable();
        }
    }

    // Avatar Cache
    if (avatarCache) {
        if (settings.avatarCache.enabled) {
            avatarCache.enable();
        } else {
            avatarCache.disable();
        }
    }

    // Frame Optimizer
    if (frameOptimizer) {
        if (settings.frameOptimizer.enabled) {
            frameOptimizer.enable();
        } else {
            frameOptimizer.disable();
        }
    }

    // Network Batcher
    if (networkBatcher) {
        if (settings.networkBatcher.enabled) {
            networkBatcher.enable();
        } else {
            networkBatcher.disable();
        }
    }

    // Mobile Keyboard Optimizer
    if (mobileKeyboard) {
        if (settings.mobileKeyboard.enabled) {
            mobileKeyboard.enable();
        } else {
            mobileKeyboard.disable();
        }
    }

    // Mobile Layout Stabilizer
    if (mobileLayout) {
        if (settings.mobileLayout.enabled) {
            mobileLayout.enable();
        } else {
            mobileLayout.disable();
        }
    }

    // Mobile Touch Optimizer
    if (mobileTouch) {
        if (settings.mobileTouch.enabled) {
            mobileTouch.enable();
        } else {
            mobileTouch.disable();
        }
    }

    // Mobile Render Optimizer
    if (mobileRender) {
        if (settings.mobileRender.enabled) {
            mobileRender.enable();
        } else {
            mobileRender.disable();
        }
    }

    // Mobile Input Optimizer
    if (mobileInput) {
        if (settings.mobileInput.enabled) {
            mobileInput.enable();
        } else {
            mobileInput.disable();
        }
    }

    // Message Content Optimizer
    if (messageContentOptimizer) {
        if (settings.messageContent.enabled) {
            messageContentOptimizer.update({
                collapseThresholdPx: settings.messageContent.collapseThresholdPx,
            });
            messageContentOptimizer.enable();
        } else {
            messageContentOptimizer.disable();
        }
    }

    console.log(`${LOG_PREFIX} Optimizations applied.`);
}

/** Disable all optimizer modules. */
function disableAll() {
    cssOptimizer?.disable();
    settingsOptimizer?.disable();
    domOptimizer?.disable();
    scrollOptimizer?.disable();
    chatVirtualizer?.disable();
    promptOptimizer?.disable();
    bgOptimizer?.disable();
    avatarCache?.disable();
    frameOptimizer?.disable();
    networkBatcher?.disable();
    mobileKeyboard?.disable();
    mobileLayout?.disable();
    mobileTouch?.disable();
    mobileRender?.disable();
    mobileInput?.disable();
    messageContentOptimizer?.disable();
}

// ===================================================================
// UI: Settings Panel
// ===================================================================

/** Create and inject the extension settings panel into SillyTavern's UI. */
function createSettingsPanel() {
    const settings = getSettings();

    const checked = (val) => val ? 'checked' : '';

    const html = `
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>Performance Optimizer</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <div class="perf-opt-panel" id="perf-opt-panel">

                <!-- Master Toggle -->
                <div class="perf-opt-toggle">
                    <label for="perf_opt_enabled">
                        <b>\u{1F680} \uC804\uCCB4 \uCD5C\uC801\uD654 \uD65C\uC131\uD654</b>
                    </label>
                    <input type="checkbox" id="perf_opt_enabled" ${checked(settings.enabled)} />
                </div>
                <hr />

                <!-- CSS Optimizer -->
                <div class="perf-opt-section" id="perf_opt_css_section">
                    <div class="perf-opt-toggle">
                        <label for="perf_opt_css">
                            <b>\u{1F3A8} CSS \uCD5C\uC801\uD654</b>
                        </label>
                        <input type="checkbox" id="perf_opt_css" ${checked(settings.cssOptimizer.enabled)} />
                    </div>
                    <div class="perf-opt-subtitle">\uC2DC\uAC01 \uD6A8\uACFC\uB97C \uBE44\uD65C\uC131\uD654\uD558\uC5EC \uB80C\uB354\uB9C1 \uC131\uB2A5\uC744 \uD5A5\uC0C1\uD569\uB2C8\uB2E4</div>
                    <div class="perf-opt-toggle">
                        <label for="perf_opt_blur">\uBE14\uB7EC(Blur) \uD6A8\uACFC \uBE44\uD65C\uC131\uD654</label>
                        <input type="checkbox" id="perf_opt_blur" ${checked(settings.cssOptimizer.disableBlur)} />
                    </div>
                    <div class="perf-opt-toggle">
                        <label for="perf_opt_shadows">\uADF8\uB9BC\uC790(Shadow) \uD6A8\uACFC \uBE44\uD65C\uC131\uD654</label>
                        <input type="checkbox" id="perf_opt_shadows" ${checked(settings.cssOptimizer.disableShadows)} />
                    </div>
                    <div class="perf-opt-toggle">
                        <label for="perf_opt_animations">\uC560\uB2C8\uBA54\uC774\uC158/\uD2B8\uB79C\uC9C0\uC158 \uCD5C\uC18C\uD654</label>
                        <input type="checkbox" id="perf_opt_animations" ${checked(settings.cssOptimizer.reduceAnimations)} />
                    </div>
                    <div class="perf-opt-toggle">
                        <label for="perf_opt_text_effects">\uD14D\uC2A4\uD2B8 \uD6A8\uACFC \uBE44\uD65C\uC131\uD654</label>
                        <input type="checkbox" id="perf_opt_text_effects" ${checked(settings.cssOptimizer.disableTextEffects)} />
                    </div>
                </div>

                <!-- Settings Optimizer -->
                <div class="perf-opt-section" id="perf_opt_settings_section">
                    <div class="perf-opt-toggle">
                        <label for="perf_opt_settings">
                            <b>\u2699\uFE0F \uC124\uC815 \uC790\uB3D9 \uCD5C\uC801\uD654</b>
                        </label>
                        <input type="checkbox" id="perf_opt_settings" ${checked(settings.settingsOptimizer.enabled)} />
                    </div>
                    <div class="perf-opt-subtitle">Fast UI \uBAA8\uB4DC, \uBE14\uB7EC \uAC15\uB3C4 0, \uBAA8\uC158 \uAC10\uC18C\uB97C \uC790\uB3D9 \uC801\uC6A9\uD569\uB2C8\uB2E4</div>
                </div>

                <!-- DOM Optimizer -->
                <div class="perf-opt-section" id="perf_opt_dom_section">
                    <div class="perf-opt-toggle">
                        <label for="perf_opt_dom">
                            <b>\u{1F4C4} DOM \uCD5C\uC801\uD654</b>
                        </label>
                        <input type="checkbox" id="perf_opt_dom" ${checked(settings.domOptimizer.enabled)} />
                    </div>
                    <div class="perf-opt-subtitle">\uC774\uBBF8\uC9C0 \uC9C0\uC5F0 \uB85C\uB529, \uD654\uBA74 \uBC16 \uBA54\uC2DC\uC9C0 \uCD5C\uC801\uD654\uB97C \uC218\uD589\uD569\uB2C8\uB2E4</div>
                </div>

                <!-- Scroll Optimizer -->
                <div class="perf-opt-section" id="perf_opt_scroll_section">
                    <div class="perf-opt-toggle">
                        <label for="perf_opt_scroll">
                            <b>\u{1F4DC} \uC2A4\uD06C\uB864 \uCD5C\uC801\uD654</b>
                        </label>
                        <input type="checkbox" id="perf_opt_scroll" ${checked(settings.scrollOptimizer.enabled)} />
                    </div>
                    <div class="perf-opt-subtitle">\uC2A4\uD06C\uB864 \uCEE8\uD14C\uC774\uB108 \uBC0F \uD504\uB86C\uD504\uD2B8 \uB9E4\uB2C8\uC800 \uC2A4\uD06C\uB864\uC744 \uAC1C\uC120\uD569\uB2C8\uB2E4</div>
                </div>

                <!-- Chat Virtualizer -->
                <div class="perf-opt-section" id="perf_opt_chatvirt_section">
                    <div class="perf-opt-toggle">
                        <label for="perf_opt_chatvirt">
                            <b>\u{1F4AC} \uCC44\uD305 \uAC00\uC0C1\uD654</b>
                        </label>
                        <input type="checkbox" id="perf_opt_chatvirt" ${checked(settings.chatVirtualizer.enabled)} />
                    </div>
                    <div class="perf-opt-subtitle">\uD654\uBA74 \uBC16 \uBA54\uC2DC\uC9C0\uB97C \uC228\uACA8 DOM \uBD80\uD558\uB97C \uB300\uD3ED \uC904\uC785\uB2C8\uB2E4</div>

                    <div style="display:flex; flex-direction:column; align-items:stretch; gap:2px; margin:8px 0; padding:4px; border:1px solid rgba(255,255,255,0.1); border-radius:4px;">
                        <small style="opacity:0.8;">\uD56D\uC0C1 \uD65C\uC131 \uBA54\uC2DC\uC9C0 \uC218 (\uD558\uB2E8): <strong id="perf_opt_chatvirt_tail_display">${settings.chatVirtualizer.alwaysVisibleTail}</strong></small>
                        <input type="range" id="perf_opt_chatvirt_tail" min="1" max="30" step="1" value="${settings.chatVirtualizer.alwaysVisibleTail}" style="display:block !important; width:100% !important; height:20px !important; cursor:pointer;" />
                    </div>

                    <div style="display:flex; flex-direction:column; align-items:stretch; gap:2px; margin:8px 0; padding:4px; border:1px solid rgba(255,255,255,0.1); border-radius:4px;">
                        <small style="opacity:0.8;">\uBC84\uD37C \uBA54\uC2DC\uC9C0 \uC218 (\uC0C1/\uD558): <strong id="perf_opt_chatvirt_buffer_display">${settings.chatVirtualizer.bufferSize}</strong></small>
                        <input type="range" id="perf_opt_chatvirt_buffer" min="0" max="10" step="1" value="${settings.chatVirtualizer.bufferSize}" style="display:block !important; width:100% !important; height:20px !important; cursor:pointer;" />
                    </div>

                    <div class="perf-opt-subtitle" style="font-size:0.78em; opacity:0.7">\uBA54\uC2DC\uC9C0\uAC00 \uAE38\uBA74(2\uB9CC \uD1A0\uD070+) \uAC12\uC744 \uB0AE\uCD94\uC138\uC694. \uAE30\uBCF8: \uD65C\uC131 3 / \uBC84\uD37C 2</div>
                </div>

                <!-- Prompt Optimizer -->
                <div class="perf-opt-section" id="perf_opt_promptopt_section">
                    <div class="perf-opt-toggle">
                        <label for="perf_opt_promptopt">
                            <b>\u{1F4CB} \uD504\uB86C\uD504\uD2B8 \uB9E4\uB2C8\uC800 \uCD5C\uC801\uD654</b>
                        </label>
                        <input type="checkbox" id="perf_opt_promptopt" ${checked(settings.promptOptimizer.enabled)} />
                    </div>
                    <div class="perf-opt-subtitle">\uB80C\uB354\uB9C1 \uB514\uBC14\uC6B4\uC2A4 \uBC0F Sortable \uC4F0\uB85C\uD2C0\uB9C1\uC744 \uC801\uC6A9\uD569\uB2C8\uB2E4</div>
                </div>

                <!-- Background Optimizer -->
                <div class="perf-opt-section" id="perf_opt_bgopt_section">
                    <div class="perf-opt-toggle">
                        <label for="perf_opt_bgopt">
                            <b>\u{1F5BC}\uFE0F \uBC30\uACBD \uC774\uBBF8\uC9C0 \uCD5C\uC801\uD654</b>
                        </label>
                        <input type="checkbox" id="perf_opt_bgopt" ${checked(settings.bgOptimizer.enabled)} />
                    </div>
                    <div class="perf-opt-subtitle">\uBC30\uACBD\uC744 \uBDF0\uD3EC\uD2B8 \uD06C\uAE30\uB85C \uB9AC\uC0AC\uC774\uC988 + WebP \uBCC0\uD658\uD569\uB2C8\uB2E4</div>
                </div>

                <!-- Avatar Cache -->
                <div class="perf-opt-section" id="perf_opt_avatar_section">
                    <div class="perf-opt-toggle">
                        <label for="perf_opt_avatar">
                            <b>\u{1F464} \uC544\uBC14\uD0C0 \uCE90\uC2DC</b>
                        </label>
                        <input type="checkbox" id="perf_opt_avatar" ${checked(settings.avatarCache.enabled)} />
                    </div>
                    <div class="perf-opt-subtitle">\uC544\uBC14\uD0C0 \uC774\uBBF8\uC9C0\uB97C \uBA54\uBAA8\uB9AC\uC5D0 \uCE90\uC2F1\uD558\uC5EC \uC911\uBCF5 \uC694\uCCAD\uC744 \uC81C\uAC70\uD569\uB2C8\uB2E4</div>
                </div>

                <!-- Frame Optimizer -->
                <div class="perf-opt-section" id="perf_opt_frame_section">
                    <div class="perf-opt-toggle">
                        <label for="perf_opt_frame">
                            <b>\u{1F3AC} \uD504\uB808\uC784 \uCD5C\uC801\uD654</b>
                        </label>
                        <input type="checkbox" id="perf_opt_frame" ${checked(settings.frameOptimizer.enabled)} />
                    </div>
                    <div class="perf-opt-subtitle">Layout Thrashing \uBC29\uC9C0, DOM \uC77D\uAE30/\uC4F0\uAE30 \uBC30\uCE6D\uC744 \uC218\uD589\uD569\uB2C8\uB2E4</div>
                </div>

                <!-- Network Batcher -->
                <div class="perf-opt-section" id="perf_opt_net_section">
                    <div class="perf-opt-toggle">
                        <label for="perf_opt_net">
                            <b>\u{1F310} \uB124\uD2B8\uC6CC\uD06C \uCD5C\uC801\uD654</b>
                        </label>
                        <input type="checkbox" id="perf_opt_net" ${checked(settings.networkBatcher.enabled)} />
                    </div>
                    <div class="perf-opt-subtitle">GET \uC694\uCCAD \uCE90\uC2F1 \uBC0F \uC911\uBCF5 \uC694\uCCAD \uC81C\uAC70\uB97C \uC218\uD589\uD569\uB2C8\uB2E4</div>
                </div>


                <!-- Mobile Keyboard Optimizer -->
                <div class="perf-opt-section" id="perf_opt_mobilekb_section">
                    <div class="perf-opt-toggle">
                        <label for="perf_opt_mobilekb">
                            <b>\u{1F4F1} \uBAA8\uBC14\uC77C \uD0A4\uBCF4\uB4DC \uCD5C\uC801\uD654</b>
                        </label>
                        <input type="checkbox" id="perf_opt_mobilekb" ${checked(settings.mobileKeyboard.enabled)} />
                    </div>
                    <div class="perf-opt-subtitle">\uD0A4\uBCF4\uB4DC \uC5F4\uAE30/\uB2EB\uAE30 \uC2DC \uB808\uC774\uC544\uC6C3 \uC7AC\uACC4\uC0B0\uC744 \uBC29\uC9C0\uD569\uB2C8\uB2E4 (v4: \uC18D\uB3C4 \uAC1C\uC120)</div>
                </div>


                <!-- Mobile Layout Stabilizer -->
                <div class="perf-opt-section" id="perf_opt_mobilelayout_section">
                    <div class="perf-opt-toggle">
                        <label for="perf_opt_mobilelayout">
                            <b>\u{1F4D0} \uBAA8\uBC14\uC77C \uB808\uC774\uC544\uC6C3 \uC548\uC815\uD654</b>
                        </label>
                        <input type="checkbox" id="perf_opt_mobilelayout" ${checked(settings.mobileLayout.enabled)} />
                    </div>
                    <div class="perf-opt-subtitle">dvh/vh \uB192\uC774\uB97C \uACE0\uC815\uD558\uC5EC \uD0A4\uBCF4\uB4DC\uC5D0 \uC758\uD55C \uB808\uC774\uC544\uC6C3 \uC7AC\uACC4\uC0B0\uC744 \uC6D0\uCC9C \uCC28\uB2E8\uD569\uB2C8\uB2E4</div>
                </div>

                <!-- Mobile Touch Optimizer -->
                <div class="perf-opt-section" id="perf_opt_mobiletouch_section">
                    <div class="perf-opt-toggle">
                        <label for="perf_opt_mobiletouch">
                            <b>\u{1F91F} \uBAA8\uBC14\uC77C \uD130\uCE58 \uCD5C\uC801\uD654</b>
                        </label>
                        <input type="checkbox" id="perf_opt_mobiletouch" ${checked(settings.mobileTouch.enabled)} />
                    </div>
                    <div class="perf-opt-subtitle">\uD0ED \uB51C\uB808\uC774 \uC81C\uAC70, \uC2A4\uD06C\uB864 \uCD5C\uC801\uD654, \uC785\uB825 \uBC18\uC751\uC131\uC744 \uAC1C\uC120\uD569\uB2C8\uB2E4</div>
                </div>

                <!-- Mobile Render Optimizer -->
                <div class="perf-opt-section" id="perf_opt_mobilerender_section">
                    <div class="perf-opt-toggle">
                        <label for="perf_opt_mobilerender">
                            <b>\u{1F3AC} \uBAA8\uBC14\uC77C \uB80C\uB354\uB9C1 \uCD5C\uC801\uD654</b>
                        </label>
                        <input type="checkbox" id="perf_opt_mobilerender" ${checked(settings.mobileRender.enabled)} />
                    </div>
                    <div class="perf-opt-subtitle">\uD328\uB110 \uD558\uC774\uBC84\uB124\uC774\uC158, GPU \uB808\uC774\uC5B4 \uC2B9\uACA9, \uC720\uD734 \uC2DC DOM \uC815\uB9AC\uB97C \uC218\uD589\uD569\uB2C8\uB2E4</div>
                </div>

                <!-- Mobile Input Optimizer -->
                <div class="perf-opt-section" id="perf_opt_mobileinput_section">
                    <div class="perf-opt-toggle">
                        <label for="perf_opt_mobileinput">
                            <b>\u270F\uFE0F \uBAA8\uBC14\uC77C \uC785\uB825 \uCD5C\uC801\uD654</b>
                        </label>
                        <input type="checkbox" id="perf_opt_mobileinput" ${checked(settings.mobileInput.enabled)} />
                    </div>
                    <div class="perf-opt-subtitle">\uCC44\uD305 \uC218\uC815 \uC9C4\uC785 \uC2DC \uB809 \uBC29\uC9C0, \uD14D\uC2A4\uD2B8 \uC785\uB825 \uCD5C\uC801\uD654\uB97C \uC218\uD589\uD569\uB2C8\uB2E4</div>
                </div>

                <!-- Message Content Optimizer -->
                <div class="perf-opt-section" id="perf_opt_msgcontent_section">
                    <div class="perf-opt-toggle">
                        <label for="perf_opt_msgcontent">
                            <b>\u{1F4E6} \uBA54\uC2DC\uC9C0 \uCF58\uD150\uCE20 \uCD5C\uC801\uD654</b>
                        </label>
                        <input type="checkbox" id="perf_opt_msgcontent" ${checked(settings.messageContent.enabled)} />
                    </div>
                    <div class="perf-opt-subtitle">\uAE34 \uBA54\uC2DC\uC9C0 \uC811\uAE30, CSS \uACA9\uB9AC, \uC774\uBBF8\uC9C0 \uC9C0\uC5F0\uB85C\uB529\uC73C\uB85C \uBC84\uD37C\uB9C1\uC744 \uC904\uC785\uB2C8\uB2E4</div>

                    <div style="display:flex; flex-direction:column; align-items:stretch; gap:2px; margin:8px 0; padding:4px; border:1px solid rgba(255,255,255,0.1); border-radius:4px;">
                        <small style="opacity:0.8;">\uC811\uAE30 \uAE30\uC900 \uB192\uC774 (px): <strong id="perf_opt_msgcontent_threshold_display">${settings.messageContent.collapseThresholdPx}</strong></small>
                        <input type="range" id="perf_opt_msgcontent_threshold" min="0" max="3000" step="100" value="${settings.messageContent.collapseThresholdPx}" style="display:block !important; width:100% !important; height:20px !important; cursor:pointer;" />
                    </div>

                    <div class="perf-opt-subtitle" style="font-size:0.78em; opacity:0.7">0\uC73C\uB85C \uC124\uC815\uD558\uBA74 \uC811\uAE30 \uBE44\uD65C\uC131\uD654. \uAE30\uBCF8: 600px</div>
                </div>

                <hr />

                <!-- Status -->
                <div class="perf-opt-status" id="perf_opt_status">
                    \uC0C1\uD0DC: \uCD08\uAE30\uD654 \uC911...
                </div>

                <!-- Buttons -->
                <div class="perf-opt-btn-row">
                    <input type="button" class="menu_button" id="perf_opt_apply"
                        value="\uC9C0\uAE08 \uC801\uC6A9" />
                    <input type="button" class="menu_button" id="perf_opt_reset"
                        value="\uC124\uC815 \uCD08\uAE30\uD654" />
                </div>

            </div>
        </div>
    </div>`;

    $('#extensions_settings2').append(html);
    bindEvents();
    updateSectionStates();
    updateStatus();
}

// ===================================================================
// UI: Event Binding
// ===================================================================

/** Bind all settings panel event handlers. */
function bindEvents() {
    // Master toggle
    $('#perf_opt_enabled').on('change', function () {
        getSettings().enabled = this.checked;
        saveSettings();
        applyOptimizations();
        updateSectionStates();
        updateStatus();
    });

    // CSS Optimizer toggle
    $('#perf_opt_css').on('change', function () {
        getSettings().cssOptimizer.enabled = this.checked;
        saveSettings();
        applyOptimizations();
        updateStatus();
    });

    // CSS sub-toggles
    const cssToggles = {
        '#perf_opt_blur': 'disableBlur',
        '#perf_opt_shadows': 'disableShadows',
        '#perf_opt_animations': 'reduceAnimations',
        '#perf_opt_text_effects': 'disableTextEffects',
    };

    for (const [selector, key] of Object.entries(cssToggles)) {
        $(selector).on('change', function () {
            const settings = getSettings();
            settings.cssOptimizer[key] = this.checked;
            saveSettings();
            if (cssOptimizer && settings.cssOptimizer.enabled) {
                cssOptimizer.update(settings.cssOptimizer);
            }
            updateStatus();
        });
    }

    // Settings Optimizer toggle
    $('#perf_opt_settings').on('change', function () {
        getSettings().settingsOptimizer.enabled = this.checked;
        saveSettings();
        applyOptimizations();
        updateStatus();
    });

    // DOM Optimizer toggle
    $('#perf_opt_dom').on('change', function () {
        getSettings().domOptimizer.enabled = this.checked;
        saveSettings();
        applyOptimizations();
        updateStatus();
    });

    // Scroll Optimizer toggle
    $('#perf_opt_scroll').on('change', function () {
        getSettings().scrollOptimizer.enabled = this.checked;
        saveSettings();
        applyOptimizations();
        updateStatus();
    });

    // Chat Virtualizer toggle
    $('#perf_opt_chatvirt').on('change', function () {
        getSettings().chatVirtualizer.enabled = this.checked;
        saveSettings();
        applyOptimizations();
        updateStatus();
    });

    // Chat Virtualizer - alwaysVisibleTail
    $('#perf_opt_chatvirt_tail').on('input', function () {
        $('#perf_opt_chatvirt_tail_display').text(this.value);
    }).on('change', function () {
        const val = Math.max(1, Math.min(30, parseInt(this.value, 10) || 3));
        this.value = val;
        $('#perf_opt_chatvirt_tail_display').text(val);
        getSettings().chatVirtualizer.alwaysVisibleTail = val;
        saveSettings();
        applyOptimizations();
    });

    // Chat Virtualizer - bufferSize
    $('#perf_opt_chatvirt_buffer').on('input', function () {
        $('#perf_opt_chatvirt_buffer_display').text(this.value);
    }).on('change', function () {
        const val = Math.max(0, Math.min(10, parseInt(this.value, 10) || 2));
        this.value = val;
        $('#perf_opt_chatvirt_buffer_display').text(val);
        getSettings().chatVirtualizer.bufferSize = val;
        saveSettings();
        applyOptimizations();
    });

    // Prompt Optimizer toggle
    $('#perf_opt_promptopt').on('change', function () {
        getSettings().promptOptimizer.enabled = this.checked;
        saveSettings();
        applyOptimizations();
        updateStatus();
    });

    // Background Optimizer toggle
    $('#perf_opt_bgopt').on('change', function () {
        getSettings().bgOptimizer.enabled = this.checked;
        saveSettings();
        applyOptimizations();
        updateStatus();
    });

    // Avatar Cache toggle
    $('#perf_opt_avatar').on('change', function () {
        getSettings().avatarCache.enabled = this.checked;
        saveSettings();
        applyOptimizations();
        updateStatus();
    });

    // Frame Optimizer toggle
    $('#perf_opt_frame').on('change', function () {
        getSettings().frameOptimizer.enabled = this.checked;
        saveSettings();
        applyOptimizations();
        updateStatus();
    });

    // Network Batcher toggle
    $('#perf_opt_net').on('change', function () {
        getSettings().networkBatcher.enabled = this.checked;
        saveSettings();
        applyOptimizations();
        updateStatus();
    });

    // Mobile Keyboard Optimizer toggle
    $('#perf_opt_mobilekb').on('change', function () {
        getSettings().mobileKeyboard.enabled = this.checked;
        saveSettings();
        applyOptimizations();
        updateStatus();
    });

    // Mobile Layout Stabilizer toggle
    $('#perf_opt_mobilelayout').on('change', function () {
        getSettings().mobileLayout.enabled = this.checked;
        saveSettings();
        applyOptimizations();
        updateStatus();
    });

    // Mobile Touch Optimizer toggle
    $('#perf_opt_mobiletouch').on('change', function () {
        getSettings().mobileTouch.enabled = this.checked;
        saveSettings();
        applyOptimizations();
        updateStatus();
    });

    // Mobile Render Optimizer toggle
    $('#perf_opt_mobilerender').on('change', function () {
        getSettings().mobileRender.enabled = this.checked;
        saveSettings();
        applyOptimizations();
        updateStatus();
    });

    // Mobile Input Optimizer toggle
    $('#perf_opt_mobileinput').on('change', function () {
        getSettings().mobileInput.enabled = this.checked;
        saveSettings();
        applyOptimizations();
        updateStatus();
    });

    // Message Content Optimizer toggle
    $('#perf_opt_msgcontent').on('change', function () {
        getSettings().messageContent.enabled = this.checked;
        saveSettings();
        applyOptimizations();
        updateStatus();
    });

    // Message Content Optimizer - collapseThresholdPx
    $('#perf_opt_msgcontent_threshold').on('input', function () {
        $('#perf_opt_msgcontent_threshold_display').text(this.value);
    }).on('change', function () {
        const val = Math.max(0, Math.min(3000, parseInt(this.value, 10) || 600));
        this.value = val;
        $('#perf_opt_msgcontent_threshold_display').text(val);
        getSettings().messageContent.collapseThresholdPx = val;
        saveSettings();
        applyOptimizations();
    });

    // Apply button
    $('#perf_opt_apply').on('click', () => {
        applyOptimizations();
        updateStatus();
        toastr.success(
            '\uCD5C\uC801\uD654\uAC00 \uC801\uC6A9\uB418\uC5C8\uC2B5\uB2C8\uB2E4.',
            'Performance Optimizer',
        );
    });

    // Reset button
    $('#perf_opt_reset').on('click', () => {
        const ctx = getContext();
        ctx.extensionSettings[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
        saveSettings();
        syncUIFromSettings();
        applyOptimizations();
        updateSectionStates();
        updateStatus();
        toastr.info(
            '\uC124\uC815\uC774 \uCD08\uAE30\uD654\uB418\uC5C8\uC2B5\uB2C8\uB2E4.',
            'Performance Optimizer',
        );
    });
}

// ===================================================================
// UI: State Sync
// ===================================================================

/** Sync all UI checkboxes from current settings. */
function syncUIFromSettings() {
    const s = getSettings();
    $('#perf_opt_enabled').prop('checked', s.enabled);
    $('#perf_opt_css').prop('checked', s.cssOptimizer.enabled);
    $('#perf_opt_blur').prop('checked', s.cssOptimizer.disableBlur);
    $('#perf_opt_shadows').prop('checked', s.cssOptimizer.disableShadows);
    $('#perf_opt_animations').prop('checked', s.cssOptimizer.reduceAnimations);
    $('#perf_opt_text_effects').prop('checked', s.cssOptimizer.disableTextEffects);
    $('#perf_opt_settings').prop('checked', s.settingsOptimizer.enabled);
    $('#perf_opt_dom').prop('checked', s.domOptimizer.enabled);
    $('#perf_opt_scroll').prop('checked', s.scrollOptimizer.enabled);
    $('#perf_opt_chatvirt').prop('checked', s.chatVirtualizer.enabled);
    $('#perf_opt_chatvirt_tail').val(s.chatVirtualizer.alwaysVisibleTail);
    $('#perf_opt_chatvirt_tail_display').text(s.chatVirtualizer.alwaysVisibleTail);
    $('#perf_opt_chatvirt_buffer').val(s.chatVirtualizer.bufferSize);
    $('#perf_opt_chatvirt_buffer_display').text(s.chatVirtualizer.bufferSize);
    $('#perf_opt_promptopt').prop('checked', s.promptOptimizer.enabled);
    $('#perf_opt_bgopt').prop('checked', s.bgOptimizer.enabled);
    $('#perf_opt_avatar').prop('checked', s.avatarCache.enabled);
    $('#perf_opt_frame').prop('checked', s.frameOptimizer.enabled);
    $('#perf_opt_net').prop('checked', s.networkBatcher.enabled);
    $('#perf_opt_mobilekb').prop('checked', s.mobileKeyboard.enabled);
    $('#perf_opt_mobilelayout').prop('checked', s.mobileLayout.enabled);
    $('#perf_opt_mobiletouch').prop('checked', s.mobileTouch.enabled);
    $('#perf_opt_mobilerender').prop('checked', s.mobileRender.enabled);
    $('#perf_opt_mobileinput').prop('checked', s.mobileInput.enabled);
    $('#perf_opt_msgcontent').prop('checked', s.messageContent.enabled);
    $('#perf_opt_msgcontent_threshold').val(s.messageContent.collapseThresholdPx);
    $('#perf_opt_msgcontent_threshold_display').text(s.messageContent.collapseThresholdPx);
}

/** Enable/disable section UI based on master toggle. */
function updateSectionStates() {
    const enabled = getSettings().enabled;
    const sections = [
        '#perf_opt_css_section',
        '#perf_opt_settings_section',
        '#perf_opt_dom_section',
        '#perf_opt_scroll_section',
        '#perf_opt_chatvirt_section',
        '#perf_opt_promptopt_section',
        '#perf_opt_bgopt_section',
        '#perf_opt_avatar_section',
        '#perf_opt_frame_section',
        '#perf_opt_net_section',
        '#perf_opt_mobilekb_section',
        '#perf_opt_mobilelayout_section',
        '#perf_opt_mobiletouch_section',
        '#perf_opt_mobilerender_section',
        '#perf_opt_mobileinput_section',
        '#perf_opt_msgcontent_section',
    ];
    for (const sel of sections) {
        if (enabled) {
            $(sel).removeClass('disabled');
        } else {
            $(sel).addClass('disabled');
        }
    }
}

/** Update the status text display. */
function updateStatus() {
    const settings = getSettings();

    if (!settings.enabled) {
        $('#perf_opt_status').text('\uC0C1\uD0DC: \uBE44\uD65C\uC131\uD654\uB428');
        return;
    }

    const parts = [];

    if (settings.cssOptimizer.enabled) {
        const cssParts = [];
        if (settings.cssOptimizer.disableBlur) cssParts.push('\uBE14\uB7EC');
        if (settings.cssOptimizer.disableShadows) cssParts.push('\uADF8\uB9BC\uC790');
        if (settings.cssOptimizer.reduceAnimations) cssParts.push('\uC560\uB2C8\uBA54\uC774\uC158');
        if (settings.cssOptimizer.disableTextEffects) cssParts.push('\uD14D\uC2A4\uD2B8');
        parts.push(`CSS(${cssParts.join(', ')})`);
    }
    if (settings.settingsOptimizer.enabled) parts.push('\uC124\uC815');
    if (settings.domOptimizer.enabled) parts.push('DOM');
    if (settings.scrollOptimizer.enabled) parts.push('\uC2A4\uD06C\uB864');
    if (settings.chatVirtualizer.enabled) parts.push('\uCC44\uD305\uAC00\uC0C1\uD654');
    if (settings.promptOptimizer.enabled) parts.push('\uD504\uB86C\uD504\uD2B8');
    if (settings.bgOptimizer.enabled) parts.push('\uBC30\uACBD');
    if (settings.avatarCache.enabled) parts.push('\uC544\uBC14\uD0C0');
    if (settings.frameOptimizer.enabled) parts.push('\uD504\uB808\uC784');
    if (settings.networkBatcher.enabled) parts.push('\uB124\uD2B8\uC6CC\uD06C');
    if (settings.mobileKeyboard.enabled) parts.push('\uBAA8\uBC14\uC77C\uD0A4\uBCF4\uB4DC');
    if (settings.mobileLayout.enabled) parts.push('\uBAA8\uBC14\uC77C\uB808\uC774\uC544\uC6C3');
    if (settings.mobileTouch.enabled) parts.push('\uBAA8\uBC14\uC77C\uD130\uCE58');
    if (settings.mobileRender.enabled) parts.push('\uBAA8\uBC14\uC77C\uB80C\uB354');
    if (settings.mobileInput.enabled) parts.push('\uBAA8\uBC14\uC77C\uC785\uB825');
    if (settings.messageContent.enabled) parts.push('\uBA54\uC2DC\uC9C0\uCF58\uD150\uCE20');

    const text = parts.length > 0
        ? `\uC0C1\uD0DC: \uD65C\uC131\uD654 \u2014 ${parts.join(' | ')}`
        : '\uC0C1\uD0DC: \uBAA8\uB4E0 \uBAA8\uB4C8 \uBE44\uD65C\uC131\uD654\uB428';

    $('#perf_opt_status').text(text);
}

// ===================================================================
// Entry Point
// ===================================================================

jQuery(async () => {
    console.log(`${LOG_PREFIX} Initializing... [BUILD:20260221c]`);

    try {
        // 1. Load/initialize settings
        loadSettings();

        // 2. Create the settings panel UI
        createSettingsPanel();

        // 3. Load optimizer modules
        await initModules();

        // 4. Apply optimizations based on saved settings
        applyOptimizations();

        // 5. Update status display
        updateStatus();

        console.log(`${LOG_PREFIX} Initialized successfully.`);
    } catch (e) {
        console.error(`${LOG_PREFIX} Initialization failed:`, e);
        $('#perf_opt_status').text('\uC0C1\uD0DC: \uCD08\uAE30\uD654 \uC2E4\uD328');
    }
});
