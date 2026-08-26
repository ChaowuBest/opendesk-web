/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

'use strict';
/**
 * Dual-ABI setup for better-sqlite3.
 *
 * better-sqlite3 is compiled by npm install for the system Node.js ABI.
 * Electron embeds its own Node.js with a different ABI.
 * Both need to coexist in the same node_modules during development.
 *
 * Strategy:
 *   1. Save the system Node.js binary → lib/binding/node-v{sysAbi}-{platform}-{arch}/
 *   2. Run electron-rebuild → build/Release/ is overwritten with Electron ABI binary
 *   3. Save the Electron binary   → lib/binding/node-v{electronAbi}-{platform}-{arch}/
 *   4. Delete build/Release/      → bindings falls through to lib/binding/ per runtime ABI
 *
 * At runtime, the `bindings` library resolves the path using process.versions.modules,
 * so each runtime automatically picks up the correct binary.
 *
 * Run via: node scripts/setup-native-modules.cjs
 * Hooked as postinstall — skips automatically in production (no electron-rebuild present).
 */

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const projectRoot = path.join(__dirname, '..');
const pkg = path.join(projectRoot, 'node_modules', 'better-sqlite3');
const buildRelease = path.join(pkg, 'build', 'Release', 'better_sqlite3.node');

function bindingDir(abi) {
    return path.join(pkg, 'lib', 'binding', `node-v${abi}-${process.platform}-${process.arch}`);
}

function saveBinary(abi) {
    const dir = bindingDir(abi);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(buildRelease, path.join(dir, 'better_sqlite3.node'));
    console.log(`[setup] Saved binary ABI ${abi} → lib/binding/node-v${abi}-${process.platform}-${process.arch}/`);
}

/**
 * Delete build/Release binary with retry to handle Windows file locks
 * (antivirus, Explorer thumbnail, etc. can briefly hold the file open).
 * Failure is downgraded to a warning — the worst case is bindings resolves
 * build/Release on first load instead of lib/binding/, which still works.
 */
function unlinkBuildRelease() {
    const maxRetries = 3;
    for (let i = 0; i < maxRetries; i++) {
        try {
            fs.unlinkSync(buildRelease);
            return;
        } catch (e) {
            if (i < maxRetries - 1 && (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES')) {
                // Brief sync pause via Atomics — avoids adding a dep for sleep
                try {
                    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
                } catch (_) {
                    /* noop */
                }
            } else {
                console.warn(
                    `[setup] Warning: could not delete build/Release binary (${e.code ?? e.message}). bindings fallback will still work.`
                );
                return;
            }
        }
    }
}

// Skip if electron is not installed (production install or CLI-only environment)
try {
    require.resolve('electron');
} catch (e) {
    console.log('[setup] electron not found, skipping dual-ABI setup');
    process.exit(0);
}

// Skip if electron-rebuild is not installed (same guard)
let rebuildModulePath;
try {
    rebuildModulePath = require.resolve('@electron/rebuild/lib/rebuild');
} catch (e) {
    try {
        rebuildModulePath = require.resolve('electron-rebuild/lib/rebuild');
    } catch (_) {
        console.log('[setup] electron-rebuild not found, skipping dual-ABI setup');
        process.exit(0);
    }
}

// Step 0: Patch @electron/node-gyp to support Visual Studio 2026 (version 18.x)
//
// @electron/node-gyp (archived Oct 2025) only recognises VS 2017/2019/2022.
// VS 2026 ships versionMajor 18, which the bundled find-visualstudio.js treats
// as "unsupported", causing electron-rebuild to fail.
//
// Upstream tracking: https://github.com/electron/rebuild/issues/1224
// TODO: Remove this patch once @electron/rebuild ships with node-gyp ≥ 12.1.0
(function patchElectronNodeGyp() {
    const findVsPath = path.join(projectRoot, 'node_modules', '@electron', 'node-gyp', 'lib', 'find-visualstudio.js');
    if (!fs.existsSync(findVsPath)) return;

    let src = fs.readFileSync(findVsPath, 'utf8');
    if (src.includes('versionYear = 2026')) return; // already patched

    const patches = [
        // getVersionInfo: recognise versionMajor 18 → 2026
        [
            /if \(ret\.versionMajor === 17\) \{\s*ret\.versionYear = 2022\s*return ret\s*\}/,
            (m) => m + `\n    if (ret.versionMajor === 18) {\n      ret.versionYear = 2026\n      return ret\n    }`
        ],
        // getToolset: map 2026 → v145
        [
            /else if \(versionYear === 2022\) \{\s*return 'v143'\s*\}/,
            (m) => m + ` else if (versionYear === 2026) {\n      return 'v145'\n    }`
        ],
        // supportedYears arrays: [2019, 2022] → [2019, 2022, 2026]
        [/\[2019, 2022\]/g, '[2019, 2022, 2026]']
    ];

    let patched = false;
    for (const [re, replacement] of patches) {
        const next = src.replace(re, replacement);
        if (next !== src) {
            patched = true;
            src = next;
        }
    }

    if (patched) {
        fs.writeFileSync(findVsPath, src, 'utf8');
        console.log('[setup] Patched @electron/node-gyp to support Visual Studio 2026');
    }
})();

function getElectronVersion() {
    const electronPkgPath = require.resolve('electron/package.json');
    return require(electronPkgPath).version;
}

async function rebuildForElectron() {
    const { rebuild } = require(rebuildModulePath);
    const electronVersion = getElectronVersion();

    console.log(`[setup] Rebuilding better-sqlite3 for Electron ${electronVersion}`);
    await rebuild({
        buildPath: projectRoot,
        electronVersion,
        arch: process.arch,
        extraModules: ['better-sqlite3'],
        onlyModules: null,
        force: true,
        types: ['prod', 'optional'],
        projectRootPath: projectRoot
    });
}

async function main() {
    // Step 1: Save system Node.js binary
    if (!fs.existsSync(buildRelease)) {
        console.warn('[setup] better-sqlite3 binary not found, skipping dual-ABI setup');
        process.exit(0);
    }

    const sysAbi = process.versions.modules;
    saveBinary(sysAbi);

    // Step 2: Run electron-rebuild through its CJS API to avoid the CLI's yargs/yargs ESM issue on Node.js 26.
    try {
        await rebuildForElectron();
    } catch (e) {
        console.warn('[setup] electron-rebuild failed, skipping Electron ABI setup:', e.message);
        process.exit(0);
    }

    // Step 3: Get Electron ABI and save binary
    let electronAbi;
    try {
        const electronPath = require('electron');
        const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
        electronAbi = execFileSync(electronPath, ['-e', 'process.stdout.write(process.versions.modules)'], { env })
            .toString()
            .trim();
        saveBinary(electronAbi);
    } catch (e) {
        console.warn('[setup] Could not save Electron binary:', e.message);
        process.exit(0);
    }

    // Step 4: Remove build/Release so bindings falls through to lib/binding/ per ABI
    unlinkBuildRelease();
    console.log(`[setup] Done. System Node.js ABI=${sysAbi}, Electron ABI=${electronAbi}`);
}

main().catch((e) => {
    console.warn('[setup] dual-ABI setup failed, skipping:', e.message);
    process.exit(0);
});
