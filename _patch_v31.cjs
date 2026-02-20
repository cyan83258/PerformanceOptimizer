const fs = require('fs');
const path = process.argv[2];

let src = fs.readFileSync(path, 'utf8');
const origLen = src.length;

// Normalize to LF for matching
src = src.replace(/\r\n/g, '\n');

let changes = 0;

// 1. Add mobileRender to DEFAULT_SETTINGS (after mobileTouch block)
const ds_old = `    mobileTouch: {\n        enabled: true,\n    },\n};`;
const ds_new = `    mobileTouch: {\n        enabled: true,\n    },\n    mobileRender: {\n        enabled: true,\n    },\n};`;
if (src.includes(ds_old)) {
    src = src.replace(ds_old, ds_new);
    changes++;
    console.log('  [1] Added mobileRender to DEFAULT_SETTINGS');
} else {
    console.log('  [1] SKIP - DEFAULT_SETTINGS pattern not found');
}

// 2. Add module variable (after mobileTouch variable)
const mv_old = `let mobileTouch = null;\n`;
const mv_new = `let mobileTouch = null;\n/** @type {import('./modules/mobile-render-optimizer.js').MobileRenderOptimizer|null} */\nlet mobileRender = null;\n`;
if (src.includes(mv_old) && !src.includes('let mobileRender = null;')) {
    src = src.replace(mv_old, mv_new);
    changes++;
    console.log('  [2] Added mobileRender variable');
} else {
    console.log('  [2] SKIP - variable pattern not found or already exists');
}

// 3. Add import in initModules (after mobileTouchMod line)
const im_old = `        safeImport('./modules/mobile-touch-optimizer.js'),\n    ]) `;
const im_new = `        safeImport('./modules/mobile-touch-optimizer.js'),\n        safeImport('./modules/mobile-render-optimizer.js'),\n    ]) `;
if (src.includes(im_old) && !src.includes("safeImport('./modules/mobile-render-optimizer.js')")) {
    src = src.replace(im_old, im_new);
    changes++;
    console.log('  [3] Added import in initModules');
} else {
    console.log('  [3] SKIP - import pattern not found or already exists');
}

// 4. Update destructuring in initModules (add mobileRenderMod)
const de_old = `        mobileKbMod, mobileLayoutMod, mobileTouchMod,\n    ]`;
const de_new = `        mobileKbMod, mobileLayoutMod, mobileTouchMod,\n        mobileRenderMod,\n    ]`;
if (src.includes(de_old) && !src.includes('mobileRenderMod')) {
    src = src.replace(de_old, de_new);
    changes++;
    console.log('  [4] Added mobileRenderMod to destructuring');
} else {
    console.log('  [4] SKIP - destructuring not found or already exists');
}

// 5. Add constructor (after mobileTouchOptimizer constructor)
const co_old = `    if (mobileTouchMod?.MobileTouchOptimizer) {\n        mobileTouch = new mobileTouchMod.MobileTouchOptimizer();\n    }`;
const co_new = `    if (mobileTouchMod?.MobileTouchOptimizer) {\n        mobileTouch = new mobileTouchMod.MobileTouchOptimizer();\n    }\n    if (mobileRenderMod?.MobileRenderOptimizer) {\n        mobileRender = new mobileRenderMod.MobileRenderOptimizer();\n    }`;
if (src.includes(co_old) && !src.includes('mobileRender = new')) {
    src = src.replace(co_old, co_new);
    changes++;
    console.log('  [5] Added constructor');
} else {
    console.log('  [5] SKIP - constructor pattern not found or already exists');
}

// 6. Add to loaded array (after MobileTouch)
const la_old = `        mobileTouch && 'MobileTouch',`;
const la_new = `        mobileTouch && 'MobileTouch',\n        mobileRender && 'MobileRender',`;
if (src.includes(la_old) && !src.includes("mobileRender && 'MobileRender'")) {
    src = src.replace(la_old, la_new);
    changes++;
    console.log('  [6] Added to loaded array');
} else {
    console.log('  [6] SKIP - loaded array pattern not found or already exists');
}

// 7. Add to applyOptimizations (after mobileTouch section)
const ap_old = `    // Mobile Touch Optimizer\n    if (mobileTouch) {\n        if (settings.mobileTouch.enabled) {\n            mobileTouch.enable();\n        } else {\n            mobileTouch.disable();\n        }\n    }\n\n    console.log`;
const ap_new = `    // Mobile Touch Optimizer\n    if (mobileTouch) {\n        if (settings.mobileTouch.enabled) {\n            mobileTouch.enable();\n        } else {\n            mobileTouch.disable();\n        }\n    }\n\n    // Mobile Render Optimizer\n    if (mobileRender) {\n        if (settings.mobileRender.enabled) {\n            mobileRender.enable();\n        } else {\n            mobileRender.disable();\n        }\n    }\n\n    console.log`;
if (src.includes(ap_old) && !src.includes('mobileRender.enable()')) {
    src = src.replace(ap_old, ap_new);
    changes++;
    console.log('  [7] Added to applyOptimizations');
} else {
    console.log('  [7] SKIP - applyOptimizations pattern not found or already exists');
}

// 8. Add to disableAll (after mobileTouch?.disable())
const da_old = `    mobileTouch?.disable();\n}`;
const da_new = `    mobileTouch?.disable();\n    mobileRender?.disable();\n}`;
if (src.includes(da_old) && !src.includes('mobileRender?.disable()')) {
    src = src.replace(da_old, da_new);
    changes++;
    console.log('  [8] Added to disableAll');
} else {
    console.log('  [8] SKIP - disableAll pattern not found or already exists');
}

// 9. Add UI toggle (after mobiletouch section closing div)
const ui_old = `                <!-- Mobile Touch Optimizer -->\n                <div class="perf-opt-section" id="perf_opt_mobiletouch_section">\n                    <div class="perf-opt-toggle">\n                        <label for="perf_opt_mobiletouch">\n                            <b>\uD83E\uDD1F \uBAA8\uBC14\uC77C \uD130\uCE58 \uCD5C\uC801\uD654</b>\n                        </label>\n                        <input type="checkbox" id="perf_opt_mobiletouch" \${checked(settings.mobileTouch.enabled)} />\n                    </div>\n                    <div class="perf-opt-subtitle">\uD0ED \uB51C\uB808\uC774 \uC81C\uAC70, \uC2A4\uD06C\uB864 \uCD5C\uC801\uD654, \uC785\uB825 \uBC18\uC751\uC131\uC744 \uAC1C\uC120\uD569\uB2C8\uB2E4</div>\n                </div>`;
const ui_new = `                <!-- Mobile Touch Optimizer -->\n                <div class="perf-opt-section" id="perf_opt_mobiletouch_section">\n                    <div class="perf-opt-toggle">\n                        <label for="perf_opt_mobiletouch">\n                            <b>\uD83E\uDD1F \uBAA8\uBC14\uC77C \uD130\uCE58 \uCD5C\uC801\uD654</b>\n                        </label>\n                        <input type="checkbox" id="perf_opt_mobiletouch" \${checked(settings.mobileTouch.enabled)} />\n                    </div>\n                    <div class="perf-opt-subtitle">\uD0ED \uB51C\uB808\uC774 \uC81C\uAC70, \uC2A4\uD06C\uB864 \uCD5C\uC801\uD654, \uC785\uB825 \uBC18\uC751\uC131\uC744 \uAC1C\uC120\uD569\uB2C8\uB2E4</div>\n                </div>\n\n                <!-- Mobile Render Optimizer -->\n                <div class="perf-opt-section" id="perf_opt_mobilerender_section">\n                    <div class="perf-opt-toggle">\n                        <label for="perf_opt_mobilerender">\n                            <b>\uD83D\uDDA5\uFE0F \uBAA8\uBC14\uC77C \uB80C\uB354\uB9C1 \uCD5C\uC801\uD654</b>\n                        </label>\n                        <input type="checkbox" id="perf_opt_mobilerender" \${checked(settings.mobileRender.enabled)} />\n                    </div>\n                    <div class="perf-opt-subtitle">GPU \uAC00\uC18D, \uD328\uB110 \uD788\uBE44\uB124\uC774\uC158, \uB808\uC774\uC544\uC6C3 \uC4F0\uB85C\uD2C0\uB9C1\uC73C\uB85C \uB9C8\uC774\uD06C\uB85C\uB809\uC744 \uC81C\uAC70\uD569\uB2C8\uB2E4</div>\n                </div>`;

if (src.includes(ui_old) && !src.includes('perf_opt_mobilerender_section')) {
    src = src.replace(ui_old, ui_new);
    changes++;
    console.log('  [9] Added UI toggle');
} else {
    console.log('  [9] SKIP - UI pattern not found or already exists');
}

// 10. Add event binding (after mobiletouch toggle binding)
const eb_old = `    // Mobile Touch Optimizer toggle\n    $('#perf_opt_mobiletouch').on('change', function () {\n        getSettings().mobileTouch.enabled = this.checked;\n        saveSettings();\n        applyOptimizations();\n        updateStatus();\n    });\n\n    // Apply button`;
const eb_new = `    // Mobile Touch Optimizer toggle\n    $('#perf_opt_mobiletouch').on('change', function () {\n        getSettings().mobileTouch.enabled = this.checked;\n        saveSettings();\n        applyOptimizations();\n        updateStatus();\n    });\n\n    // Mobile Render Optimizer toggle\n    $('#perf_opt_mobilerender').on('change', function () {\n        getSettings().mobileRender.enabled = this.checked;\n        saveSettings();\n        applyOptimizations();\n        updateStatus();\n    });\n\n    // Apply button`;
if (src.includes(eb_old) && !src.includes("$('#perf_opt_mobilerender')")) {
    src = src.replace(eb_old, eb_new);
    changes++;
    console.log('  [10] Added event binding');
} else {
    console.log('  [10] SKIP - event binding not found or already exists');
}

// 11. Add to syncUIFromSettings (after mobiletouch line)
const sy_old = `    $('#perf_opt_mobiletouch').prop('checked', s.mobileTouch.enabled);\n}`;
const sy_new = `    $('#perf_opt_mobiletouch').prop('checked', s.mobileTouch.enabled);\n    $('#perf_opt_mobilerender').prop('checked', s.mobileRender.enabled);\n}`;
if (src.includes(sy_old) && !src.includes("perf_opt_mobilerender').prop")) {
    src = src.replace(sy_old, sy_new);
    changes++;
    console.log('  [11] Added to syncUIFromSettings');
} else {
    console.log('  [11] SKIP - syncUI not found or already exists');
}

// 12. Add to updateSectionStates (after mobiletouch section)
const us_old = `        '#perf_opt_mobiletouch_section',\n    ];`;
const us_new = `        '#perf_opt_mobiletouch_section',\n        '#perf_opt_mobilerender_section',\n    ];`;
if (src.includes(us_old) && !src.includes('perf_opt_mobilerender_section')) {
    src = src.replace(us_old, us_new);
    changes++;
    console.log('  [12] Added to updateSectionStates');
} else {
    console.log('  [12] SKIP - updateSectionStates not found or already exists');
}

// 13. Add to updateStatus (after mobileTouch push)
const st_old = `    if (settings.mobileTouch.enabled) parts.push('\\uBAA8\\uBC14\\uC77C\\uD130\\uCE58');`;
const st_new = `    if (settings.mobileTouch.enabled) parts.push('\\uBAA8\\uBC14\\uC77C\\uD130\\uCE58');\n    if (settings.mobileRender.enabled) parts.push('\\uBAA8\\uBC14\\uC77C\\uB80C\\uB354\\uB9C1');`;
if (src.includes(st_old) && !src.includes('\uBAA8\uBC14\uC77C\uB80C\uB354\uB9C1')) {
    src = src.replace(st_old, st_new);
    changes++;
    console.log('  [13] Added to updateStatus');
} else {
    console.log('  [13] SKIP - updateStatus not found or already exists');
}

// 14. Update version to v3.1.0
src = src.replace(/v3\.0\.0/g, 'v3.1.0');
console.log('  [14] Updated version to v3.1.0');

// Convert back to CRLF
src = src.replace(/\n/g, '\r\n');

fs.writeFileSync(path, src, 'utf8');
console.log(`\nDone: ${changes} patches applied. ${origLen} -> ${src.length} bytes`);