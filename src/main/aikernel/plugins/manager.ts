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

/**
 * Plugin manager: handles install, uninstall, discovery, and loading of
 * OpenClaw-compatible channel plugins.
 */

import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import module from 'module';
import { getAppDirectory } from '../../utils/setting.js';
import { logger } from '../../utils/logger.js';
import { ensureOpenClawShim } from './openclaw/shim.js';
import { createPluginApi } from './openclaw/api.js';
import type {
    PluginManifest,
    PluginInstallRecord,
    PluginEntry,
    ChannelPlugin,
} from './types.js';

// ── Constants ────────────────────────────────────────────────────────────────

const EXTENSIONS_DIR_NAME = 'extensions';
const PLUGIN_MANIFEST = 'openclaw.plugin.json';
const INSTALLS_FILE = 'plugins.json';

// ── Path Helpers ─────────────────────────────────────────────────────────────

function getExtensionsDir(): string {
    const dir = path.join(getAppDirectory(), EXTENSIONS_DIR_NAME);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

function getInstallsFilePath(): string {
    return path.join(getExtensionsDir(), INSTALLS_FILE);
}

// ── Install Records Persistence ──────────────────────────────────────────────

function loadInstallRecords(): PluginInstallRecord[] {
    const filePath = getInstallsFilePath();
    if (!fs.existsSync(filePath)) return [];
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
        return [];
    }
}

function saveInstallRecords(records: PluginInstallRecord[]): void {
    fs.writeFileSync(getInstallsFilePath(), JSON.stringify(records, null, 2), 'utf-8');
}

// ── npm Operations ───────────────────────────────────────────────────────────

function ensureExtensionPackageJson(): void {
    const pkgPath = path.join(getExtensionsDir(), 'package.json');
    if (!fs.existsSync(pkgPath)) {
        fs.writeFileSync(pkgPath, JSON.stringify({
            name: 'opendesk-extensions',
            private: true,
            version: '1.0.0',
            description: 'OpenDesk plugin extensions',
            type: 'module',
            dependencies: {
                zod: '^3.22.0',
            },
        }, null, 2), 'utf-8');
    }
}

// ── Public API: Install / Uninstall ──────────────────────────────────────────

/**
 * Check if a string is a valid URL (http or https)
 */
function isUrl(spec: string): boolean {
    try {
        const url = new URL(spec);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
}

/**
 * Download a file from URL to a local path using curl (more reliable for various network conditions)
 */
function downloadFile(url: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        try {
            // Use curl for downloading - it handles redirects, proxies, and various network conditions better
            execSync(`curl -L -o "${destPath}" "${url}"`, {
                stdio: 'pipe',
                timeout: 300000, // 5 minutes
            });

            // Verify the file was downloaded
            if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
                resolve();
            } else {
                reject(new Error('Downloaded file is empty or missing'));
            }
        } catch (err: any) {
            const message = err?.stderr?.toString() || err?.message || String(err);
            reject(new Error(`Download failed: ${message}`));
        }
    });
}

/**
 * Extract package name from a .tgz file by reading its package.json
 */
function extractPackageNameFromTgz(tgzPath: string): string | null {
    try {
        // Use npm pack to extract and read package.json
        const tempDir = fs.mkdtempSync(path.join(path.dirname(tgzPath), 'tgz-extract-'));
        try {
            execSync(`tar -xzf "${tgzPath}" -C "${tempDir}"`, { stdio: 'pipe' });

            // The extracted content is usually in a 'package/' directory
            const packageDir = path.join(tempDir, 'package');
            const pkgJsonPath = path.join(packageDir, 'package.json');

            if (fs.existsSync(pkgJsonPath)) {
                const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
                return pkgJson.name || null;
            }

            // Check if files are directly in tempDir (no package/ subdirectory)
            const directPkgJsonPath = path.join(tempDir, 'package.json');
            if (fs.existsSync(directPkgJsonPath)) {
                const pkgJson = JSON.parse(fs.readFileSync(directPkgJsonPath, 'utf-8'));
                return pkgJson.name || null;
            }
        } finally {
            // Cleanup temp directory
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    } catch (err) {
        logger.warn(`Failed to extract package name from tgz: ${err}`);
    }
    return null;
}

/**
 * Install a plugin from an npm spec (e.g. `@ynhcj/xiaoyi@latest`) or a URL to a .tgz file.
 */
export async function installPlugin(npmSpecOrUrl: string): Promise<{ success: boolean; id?: string; error?: string }> {
    const extensionsDir = getExtensionsDir();
    logger.info(`Extensions directory: ${extensionsDir}`);
    ensureExtensionPackageJson();

    // Check if the input is a URL
    const isUrlInstall = isUrl(npmSpecOrUrl);

    try {
        if (isUrlInstall) {
            logger.info(`Installing plugin from URL: ${npmSpecOrUrl}`);

            // Download the .tgz file
            const tempTgzPath = path.join(extensionsDir, `temp-${Date.now()}.tgz`);
            try {
                await downloadFile(npmSpecOrUrl, tempTgzPath);
                logger.info(`Downloaded plugin package to: ${tempTgzPath}`);
            } catch (downloadErr: any) {
                return { success: false, error: `Failed to download plugin: ${downloadErr.message}` };
            }

            // Install from local file
            try {
                execSync(`npm install --prefix "${extensionsDir}" "${tempTgzPath}" --save`, {
                    cwd: extensionsDir,
                    stdio: 'inherit',
                    timeout: 180000,
                    env: { ...process.env, npm_config_fund: 'false' },
                });
            } catch (npmErr: any) {
                const errMsg = npmErr?.message || String(npmErr);
                logger.error(`npm install failed: ${errMsg}`);
                return { success: false, error: `npm install failed: ${errMsg}` };
            } finally {
                // Cleanup the temp file
                if (fs.existsSync(tempTgzPath)) {
                    fs.unlinkSync(tempTgzPath);
                }
            }

            // Try to extract package name from the tgz (before cleanup)
            let pkgName = extractPackageNameFromTgz(tempTgzPath);

            // If we couldn't extract the name, try to find it in node_modules
            if (!pkgName) {
                // Look for newly installed packages in node_modules
                const nodeModulesDir = path.join(extensionsDir, 'node_modules');
                if (fs.existsSync(nodeModulesDir)) {
                    const entries = fs.readdirSync(nodeModulesDir).filter(e => !e.startsWith('.'));
                    if (entries.length === 1) {
                        pkgName = entries[0];
                    } else if (entries.length > 1) {
                        // Multiple packages - check package.json for the latest dependency
                        const pkgJsonPath = path.join(extensionsDir, 'package.json');
                        if (fs.existsSync(pkgJsonPath)) {
                            const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
                            const deps = pkgJson.dependencies || {};
                            // Find the most recently added dependency
                            for (const dep of Object.keys(deps)) {
                                if (!dep.startsWith('@types') && fs.existsSync(path.join(nodeModulesDir, dep))) {
                                    pkgName = dep;
                                    break;
                                }
                            }
                        }
                    }
                }
            }

            if (!pkgName) {
                return { success: false, error: 'Could not determine package name from downloaded archive' };
            }

            // Ensure the openclaw shim is in place
            ensureOpenClawShim(extensionsDir);

            // Try to find the plugin manifest
            const pluginDir = path.join(extensionsDir, 'node_modules', pkgName);
            let manifest: PluginManifest = { id: pkgName };
            const manifestPath = path.join(pluginDir, PLUGIN_MANIFEST);
            if (fs.existsSync(manifestPath)) {
                try {
                    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
                } catch {
                    logger.warn(`Failed to parse ${PLUGIN_MANIFEST} for ${pkgName}`);
                }
            }

            // Also check the npm package.json for additional info
            const npmPkgPath = path.join(pluginDir, 'package.json');
            if (fs.existsSync(npmPkgPath)) {
                const npmPkg = JSON.parse(fs.readFileSync(npmPkgPath, 'utf-8'));
                if (!manifest.name) manifest.name = npmPkg.description || pkgName;
                if (!manifest.version) manifest.version = npmPkg.version;
            }

            // Save install record
            const records = loadInstallRecords();
            const existingIdx = records.findIndex(r => r.id === (manifest.id || pkgName));
            const record: PluginInstallRecord = {
                id: manifest.id || pkgName,
                npmSpec: npmSpecOrUrl,
                installedAt: new Date().toISOString(),
                enabled: true,
                source: 'url',
                path: pluginDir,
                url: npmSpecOrUrl,
            };

            if (existingIdx >= 0) {
                records[existingIdx] = record;
            } else {
                records.push(record);
            }
            saveInstallRecords(records);

            logger.info(`Plugin installed: ${manifest.id || pkgName}`);
            return { success: true, id: manifest.id || pkgName };
        } else {
            // Original npm spec installation logic
            logger.info(`Installing plugin: ${npmSpecOrUrl}`);
            logger.info(`Extensions directory: ${extensionsDir}`);

            // Determine the package name early so we can verify installation
            const pkgName = extractPackageName(npmSpecOrUrl);
            if (!pkgName) {
                return { success: false, error: `Could not determine package name from spec: ${npmSpecOrUrl}` };
            }

            // Install the npm package
            // Use --prefix to force npm to use the extensions directory as the
            // project root, preventing it from walking up the directory tree and
            // installing into a parent node_modules.
            try {
                execSync(`npm install --prefix "${extensionsDir}" ${npmSpecOrUrl} --save`, {
                    cwd: extensionsDir,
                    stdio: 'inherit',
                    timeout: 180000,
                    env: { ...process.env, npm_config_fund: 'false' },
                });
            } catch (npmErr: any) {
                const errMsg = npmErr?.message || String(npmErr);
                logger.error(`npm install failed: ${errMsg}`);
                return { success: false, error: `npm install failed: ${errMsg}` };
            }

            // Verify the package was actually installed
            const pluginDir = path.join(extensionsDir, 'node_modules', pkgName);
            if (!fs.existsSync(pluginDir)) {
                logger.error(`npm install completed but package directory not found: ${pluginDir}`);
                return { success: false, error: `Package directory not found after install. npm may have installed to a different location. Check that no parent directory contains a package.json that could confuse npm.` };
            }

            // Ensure the openclaw shim is in place
            ensureOpenClawShim(extensionsDir);
            let manifest: PluginManifest = { id: pkgName };
            const manifestPath = path.join(pluginDir, PLUGIN_MANIFEST);
            if (fs.existsSync(manifestPath)) {
                try {
                    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
                } catch {
                    logger.warn(`Failed to parse ${PLUGIN_MANIFEST} for ${pkgName}`);
                }
            }

            // Also check the npm package.json for additional info
            const npmPkgPath = path.join(pluginDir, 'package.json');
            if (fs.existsSync(npmPkgPath)) {
                const npmPkg = JSON.parse(fs.readFileSync(npmPkgPath, 'utf-8'));
                if (!manifest.name) manifest.name = npmPkg.description || pkgName;
                if (!manifest.version) manifest.version = npmPkg.version;
            }

            // Save install record
            const records = loadInstallRecords();
            const existingIdx = records.findIndex(r => r.id === (manifest.id || pkgName));
            const record: PluginInstallRecord = {
                id: manifest.id || pkgName,
                npmSpec: npmSpecOrUrl,
                installedAt: new Date().toISOString(),
                enabled: true,
                source: 'npm',
                path: pluginDir,
            };

            if (existingIdx >= 0) {
                records[existingIdx] = record;
            } else {
                records.push(record);
            }
            saveInstallRecords(records);

            logger.info(`Plugin installed: ${manifest.id || pkgName}`);
            return { success: true, id: manifest.id || pkgName };
        }
    } catch (err: any) {
        const message = err?.stderr?.toString() || err?.message || String(err);
        logger.error(`Plugin install failed: ${message}`);
        return { success: false, error: message };
    }
}

/**
 * Uninstall a plugin by its id or npm package name.
 */
export async function uninstallPlugin(pluginId: string): Promise<{ success: boolean; error?: string }> {
    const extensionsDir = getExtensionsDir();
    const records = loadInstallRecords();
    const record = records.find(r => r.id === pluginId || r.npmSpec.startsWith(pluginId));

    if (!record) {
        return { success: false, error: `Plugin not found: ${pluginId}` };
    }

    try {
        const pkgName = extractPackageName(record.npmSpec) || pluginId;
        execSync(`npm uninstall --prefix "${extensionsDir}" ${pkgName}`, {
            cwd: extensionsDir,
            stdio: 'pipe',
            timeout: 60000,
        });

        const updatedRecords = records.filter(r => r.id !== record.id);
        saveInstallRecords(updatedRecords);

        logger.info(`Plugin uninstalled: ${pluginId}`);
        return { success: true };
    } catch (err: any) {
        const message = err?.stderr?.toString() || err?.message || String(err);
        logger.error(`Plugin uninstall failed: ${message}`);
        return { success: false, error: message };
    }
}

// ── Public API: Query & State ────────────────────────────────────────────────

/**
 * List installed plugins.
 */
export function listInstalledPlugins(): PluginInstallRecord[] {
    return loadInstallRecords();
}

/**
 * Enable or disable a plugin.
 */
export function setPluginEnabled(pluginId: string, enabled: boolean): boolean {
    const records = loadInstallRecords();
    const record = records.find(r => r.id === pluginId);
    if (!record) return false;
    record.enabled = enabled;
    saveInstallRecords(records);
    return true;
}

// ── Public API: Loading ──────────────────────────────────────────────────────

/**
 * Load all enabled plugins and return their entries.
 * Channel plugins are extracted and returned separately.
 */
export async function loadPlugins(): Promise<PluginEntry[]> {
    const records = loadInstallRecords();
    const enabledRecords = records.filter(r => r.enabled);
    const entries: PluginEntry[] = [];

    // Make sure the shim is in place
    ensureOpenClawShim(getExtensionsDir());

    for (const record of enabledRecords) {
        try {
            const entry = await loadSinglePlugin(record);
            if (entry) entries.push(entry);
        } catch (err: any) {
            logger.error(`Failed to load plugin ${record.id}: ${err?.message || err}`);
        }
    }

    return entries;
}

// ── Internal: Plugin Loading ─────────────────────────────────────────────────

/**
 * Resolve the entry point for a plugin.
 * Checks package.json openclaw.extensions, then main/module/exports, then index.{ts,js}.
 */
function resolvePluginEntryPoint(pluginDir: string): string | null {
    const pkgJsonPath = path.join(pluginDir, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) return null;

    let pkgJson: any;
    try { pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8')); } catch { return null; }

    // openclaw.extensions field (e.g., ["./index.ts"])
    const extensions = pkgJson?.openclaw?.extensions;
    if (Array.isArray(extensions) && extensions.length > 0) {
        const entry = path.join(pluginDir, extensions[0]);
        if (fs.existsSync(entry)) return entry;
    }

    // Standard Node.js resolution: exports -> module -> main
    if (pkgJson.exports) {
        const root = typeof pkgJson.exports === 'string' ? pkgJson.exports
            : pkgJson.exports['.']?.import || pkgJson.exports['.']?.default || pkgJson.exports['.'];
        if (typeof root === 'string') {
            const entry = path.join(pluginDir, root);
            if (fs.existsSync(entry)) return entry;
        }
    }
    for (const field of ['module', 'main']) {
        if (pkgJson[field]) {
            const entry = path.join(pluginDir, pkgJson[field]);
            if (fs.existsSync(entry)) return entry;
        }
    }

    // Fallback: index.ts or index.js
    for (const name of ['index.ts', 'index.js']) {
        const entry = path.join(pluginDir, name);
        if (fs.existsSync(entry)) return entry;
    }
    return null;
}

/**
 * Compile a TypeScript plugin entry to a single ESM JavaScript bundle using esbuild.
 * Returns the path to the compiled .mjs file, or null if compilation failed.
 */
async function compileTypeScriptPlugin(entryPoint: string, pluginDir: string): Promise<string | null> {
    const compiledPath = path.join(pluginDir, '.opendesk-compiled.mjs');

    // Use cached compilation if source hasn't changed
    if (fs.existsSync(compiledPath)) {
        try {
            const compiledMtime = fs.statSync(compiledPath).mtimeMs;
            const sourceMtime = fs.statSync(entryPoint).mtimeMs;
            if (compiledMtime > sourceMtime) {
                return compiledPath;
            }
        } catch { /* recompile */ }
    }

    // Collect plugin's own dependencies to mark as external
    const pkgJsonPath = path.join(pluginDir, 'package.json');
    const externalPackages: string[] = ['openclaw', 'openclaw/*'];
    try {
        const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
        for (const depField of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
            if (pkgJson[depField]) {
                externalPackages.push(...Object.keys(pkgJson[depField]));
            }
        }
    } catch { /* best effort */ }

    // Try dynamic import of esbuild
    try {
        const esbuild = await import('esbuild');
        await esbuild.build({
            entryPoints: [entryPoint],
            outfile: compiledPath,
            bundle: true,
            format: 'esm',
            platform: 'node',
            target: 'node20',
            external: externalPackages,
            logLevel: 'silent',
        });
        logger.info(`Compiled TypeScript plugin: ${entryPoint}`);
        return compiledPath;
    } catch (err: any) {
        logger.warn(`esbuild API not available (${err?.message}), trying npx esbuild...`);
    }

    // Fallback: use npx esbuild CLI
    try {
        const externals = externalPackages.map(p => `--external:${p}`).join(' ');
        execSync(
            `npx esbuild "${entryPoint}" --bundle --format=esm --platform=node --target=node20 ${externals} --outfile="${compiledPath}"`,
            { stdio: 'pipe', timeout: 30000 },
        );
        logger.info(`Compiled TypeScript plugin via CLI: ${entryPoint}`);
        return compiledPath;
    } catch (err: any) {
        logger.error(`Failed to compile TypeScript plugin: ${err?.message || err}`);
    }

    return null;
}

async function loadSinglePlugin(record: PluginInstallRecord): Promise<PluginEntry | null> {
    const extensionsDir = getExtensionsDir();
    const pkgName = extractPackageName(record.npmSpec) || record.id;
    const pluginDir = path.join(extensionsDir, 'node_modules', pkgName);

    if (!fs.existsSync(pluginDir)) {
        logger.warn(`Plugin directory not found: ${pluginDir}`);
        return null;
    }

    // Load manifest
    let manifest: PluginManifest = { id: record.id };
    const manifestPath = path.join(pluginDir, PLUGIN_MANIFEST);
    if (fs.existsSync(manifestPath)) {
        try {
            manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        } catch { /* use defaults */ }
    }

    // Resolve and load the plugin module
    let pluginModule: any;
    const entryPoint = resolvePluginEntryPoint(pluginDir);
    const isTypeScript = entryPoint?.endsWith('.ts');

    if (isTypeScript && entryPoint) {
        // TypeScript plugins: compile to JS first, then import
        const compiledPath = await compileTypeScriptPlugin(entryPoint, pluginDir);
        const importTarget = compiledPath || entryPoint;

        try {
            const fileUrl = 'file://' + importTarget;
            pluginModule = await import(fileUrl);
            if (pluginModule && pluginModule.default) {
                pluginModule = pluginModule.default;
            }
            logger.info(`Loaded TypeScript plugin: ${pkgName} (${importTarget})`);
        } catch (err: any) {
            logger.error(`Failed to import TypeScript plugin ${pkgName}: ${err?.message || err}`);
            return null;
        }
    } else {
        // JavaScript plugins: use createRequire
        const require = module.createRequire(path.join(extensionsDir, 'package.json'));
        try {
            pluginModule = require(pkgName);
            if (pluginModule && pluginModule.default) {
                pluginModule = pluginModule.default;
            }
        } catch (err: any) {
            logger.error(`Failed to require plugin ${pkgName}: ${err?.message || err}`);
            return null;
        }
    }

    const entry: PluginEntry = {
        id: manifest.id || record.id,
        manifest,
        installRecord: record,
        module: pluginModule,
    };

    // Execute the plugin's register function with our API shim
    let channelPlugin: ChannelPlugin | null = null;
    const api = createPluginApi(entry, (cp: ChannelPlugin) => {
        channelPlugin = cp;
    });

    try {
        if (typeof pluginModule === 'function') {
            await pluginModule(api);
        } else if (typeof pluginModule?.register === 'function') {
            await pluginModule.register(api);
        } else {
            logger.warn(`Plugin ${record.id} does not export a register function`);
        }
    } catch (err: any) {
        logger.error(`Plugin ${record.id} registration failed: ${err?.message || err}`);
    }

    if (channelPlugin) {
        entry.channelPlugin = channelPlugin;
    }

    return entry;
}

// ── Internal: Utilities ──────────────────────────────────────────────────────

/**
 * Delete the generated openclaw shim and regenerate it.
 * Useful for debugging when the shim gets out of date.
 */
export function resetOpenClawShim(): { success: boolean; error?: string } {
    try {
        const extensionsDir = getExtensionsDir();
        const shimDir = path.join(extensionsDir, 'node_modules', 'openclaw');
        if (fs.existsSync(shimDir)) {
            fs.rmSync(shimDir, { recursive: true, force: true });
            logger.info(`已删除 openclaw shim: ${shimDir}`);
        }
        ensureOpenClawShim(extensionsDir);
        logger.info('openclaw shim 已重新生成');
        return { success: true };
    } catch (err: any) {
        const message = err?.message || String(err);
        logger.error(`重置 openclaw shim 失败: ${message}`);
        return { success: false, error: message };
    }
}

function extractPackageName(npmSpec: string): string | null {
    // Handle specs like @scope/name@version, name@version, @scope/name, name
    const match = npmSpec.match(/^(@[^@/]+\/[^@/]+|[^@/]+)(?:@.*)?$/);
    return match ? match[1] : null;
}