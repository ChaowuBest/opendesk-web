/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at:
 * http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import crypto from 'node:crypto';
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { pathToFileURL } from 'url';
import * as esbuild from 'esbuild';
import { parsePluginManifest } from '../src/main/applications/pluginmgr/discovery/manifest.js';
import { materializeBuiltinPluginZip } from './lib/builtin-plugin-zip.js';
import {
    installPluginDependencies,
    resolveNpmInvocation
} from '../src/main/applications/pluginmgr/management/dependencies.js';
import { HOST_PACKAGE_SPECIFIERS } from '../src/main/applications/pluginmgr/runtime/package-mapping.js';

const MANIFEST_FILENAME = 'opendesk.plugin.json';

const execFileAsync = promisify(execFile);

export interface BuildBuiltinPluginsOptions {
    sourceDirectory?: string;
    outputDirectory?: string;
    runNpm?: (args: string[], cwd: string) => Promise<void>;
}

export interface BuiltinPluginBuildResult {
    id: string;
    sourceDirectory: string;
    outputDirectory: string;
    entry: string;
}

function isPathInside(root: string, target: string): boolean {
    const normalizedRoot = path.resolve(root);
    const normalizedTarget = path.resolve(target);
    return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`);
}

function assertSafeOutputDirectory(sourceDirectory: string, outputDirectory: string): void {
    const resolvedSource = path.resolve(sourceDirectory);
    const resolvedOutput = path.resolve(outputDirectory);
    if (resolvedOutput === path.parse(resolvedOutput).root || resolvedOutput === resolvedSource) {
        throw new Error('plugin.builtin_output_directory_invalid');
    }
}

/**
 * 复制插件源目录到输出目录。
 * - copy 模式（includeNodeModules=true）：整体复制（含 node_modules），产物自包含；
 * - bundle 模式（includeNodeModules=false）：依赖已内联进入口 bundle，跳过 node_modules，
 *   仅携带 manifest、静态资源等非模块文件。
 * node_modules 与 dist 均被 gitignore，不会污染版本库。
 */
function copyPluginSources(
    sourceDirectory: string,
    outputDirectory: string,
    includeNodeModules: boolean,
    excludeRootModuleFiles = false
): void {
    fs.cpSync(sourceDirectory, outputDirectory, {
        recursive: true,
        filter(source) {
            const relative = path.relative(sourceDirectory, source);
            if (!relative) return true;
            const first = relative.split(path.sep)[0];
            if (first === '.git' || first === 'dist') return false;
            if (first === 'node_modules' && !includeNodeModules) return false;
            if (excludeRootModuleFiles && !relative.includes(path.sep) && /\.(?:js|mjs|cjs)$/.test(relative)) {
                return false;
            }
            return true;
        }
    });
}

function validateBuiltinPluginSource(
    sourceDirectory: string,
    knownIds: Set<string>
) {
    const sourceName = path.basename(sourceDirectory);
    const manifestPath = path.join(sourceDirectory, MANIFEST_FILENAME);
    if (!fs.existsSync(manifestPath)) {
        throw new Error(`plugin.builtin_manifest_not_found:${sourceName}`);
    }
    const rawManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as unknown;
    const manifest = parsePluginManifest(rawManifest);
    if (!manifest.id) throw new Error(`plugin.builtin_manifest_id_required:${sourceName}`);
    if (!manifest.entry) throw new Error(`plugin.builtin_manifest_entry_required:${manifest.id}`);
    if (knownIds.has(manifest.id)) throw new Error(`plugin.builtin_duplicate_id:${manifest.id}`);
    knownIds.add(manifest.id);

    const sourceEntry = path.resolve(sourceDirectory, manifest.entry);
    if (!isPathInside(sourceDirectory, sourceEntry)) {
        throw new Error(`plugin.builtin_entry_outside_root:${manifest.id}`);
    }
    if (!fs.existsSync(sourceEntry) || !fs.statSync(sourceEntry).isFile()) {
        throw new Error(`plugin.builtin_entry_not_found:${manifest.id}`);
    }
    if (!['.js', '.mjs', '.cjs'].includes(path.extname(sourceEntry).toLowerCase())) {
        throw new Error(`plugin.builtin_entry_typescript_unsupported:${manifest.id}`);
    }

    return { manifest, sourceEntry };
}

async function buildExpandedBuiltinPlugin(
    sourceDirectory: string,
    outputRoot: string,
    knownIds: Set<string>,
    runNpm: (args: string[], cwd: string) => Promise<void>
): Promise<BuiltinPluginBuildResult> {
    const { manifest, sourceEntry } = validateBuiltinPluginSource(sourceDirectory, knownIds);

    const pluginOutputDirectory = path.join(outputRoot, manifest.id);
    const outputEntry = path.resolve(pluginOutputDirectory, manifest.entry);
    await ensurePluginDependencies(sourceDirectory, runNpm);
    if (shouldBundlePlugin(sourceDirectory)) {
        copyPluginSources(sourceDirectory, pluginOutputDirectory, false, true);
        await bundlePluginEntry(sourceEntry, outputEntry);
    } else {
        copyPluginSources(sourceDirectory, pluginOutputDirectory, true);
    }
    return {
        id: manifest.id,
        sourceDirectory,
        outputDirectory: pluginOutputDirectory,
        entry: outputEntry
    };
}

function buildZipBuiltinPlugin(
    sourceDirectory: string,
    outputRoot: string,
    knownIds: Set<string>
): BuiltinPluginBuildResult {
    const stagingRoot = path.join(path.dirname(outputRoot), `.plugin-build-${process.pid}-${crypto.randomUUID()}`);
    const stagingPlugin = path.join(stagingRoot, path.basename(sourceDirectory));
    fs.mkdirSync(stagingRoot, { recursive: true });
    try {
        const artifact = materializeBuiltinPluginZip(sourceDirectory, stagingPlugin);
        const { manifest } = validateBuiltinPluginSource(stagingPlugin, knownIds);
        if (manifest.id !== artifact.pluginId || manifest.version !== artifact.pluginVersion) {
            throw new Error(`plugin.builtin_artifact_identity_mismatch:${artifact.pluginId}`);
        }
        const pluginOutputDirectory = path.join(outputRoot, manifest.id);
        fs.renameSync(stagingPlugin, pluginOutputDirectory);
        return {
            id: manifest.id,
            sourceDirectory,
            outputDirectory: pluginOutputDirectory,
            entry: path.resolve(pluginOutputDirectory, manifest.entry)
        };
    } finally {
        fs.rmSync(stagingRoot, { recursive: true, force: true });
    }
}

async function buildBuiltinPlugin(
    sourceDirectory: string,
    outputRoot: string,
    knownIds: Set<string>,
    runNpm: (args: string[], cwd: string) => Promise<void>
): Promise<BuiltinPluginBuildResult> {
    const hasExpandedManifest = fs.existsSync(path.join(sourceDirectory, MANIFEST_FILENAME));
    const hasZipManifest = fs.existsSync(path.join(sourceDirectory, 'artifact-manifest.json'));
    if (hasExpandedManifest && hasZipManifest) {
        throw new Error(`plugin.builtin_source_ambiguous:${path.basename(sourceDirectory)}`);
    }
    if (hasZipManifest) return buildZipBuiltinPlugin(sourceDirectory, outputRoot, knownIds);
    if (fs.readdirSync(sourceDirectory).some((name) => name.toLowerCase().endsWith('.zip'))) {
        throw new Error(`plugin.builtin_artifact_missing:${path.basename(sourceDirectory)}`);
    }
    return buildExpandedBuiltinPlugin(sourceDirectory, outputRoot, knownIds, runNpm);
}

async function defaultRunNpm(args: string[], cwd: string): Promise<void> {
    const invocation = resolveNpmInvocation(args);
    await execFileAsync(invocation.executable, invocation.args, {
        cwd,
        timeout: 180_000,
        maxBuffer: 10 * 1024 * 1024
    });
}

/**
 * 确保源插件目录具备运行时依赖：缺 node_modules 时按 package.json 的
 * dependencies/peerDependencies 执行 npm install。依赖变更时删除源目录的
 * node_modules（或手动重新 npm install）即可让下一次构建重新安装。
 */
async function ensurePluginDependencies(
    pluginDirectory: string,
    runNpm: (args: string[], cwd: string) => Promise<void>
): Promise<void> {
    if (fs.existsSync(path.join(pluginDirectory, 'node_modules'))) return;
    await installPluginDependencies(pluginDirectory, runNpm);
}

/**
 * manifest 声明 "bundle": true 的插件会把入口及其依赖内联为单个最小发布文件，
 * 产物不携带 node_modules，运行时也无需解析裸包名。
 */
function shouldBundlePlugin(pluginDirectory: string): boolean {
    const manifestPath = path.join(pluginDirectory, MANIFEST_FILENAME);
    if (!fs.existsSync(manifestPath)) return false;
    const rawManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as { bundle?: unknown };
    return rawManifest.bundle === true;
}

/** 宿主映射包由运行时 package-mapping 兜底解析，bundle 时必须保留为外部引用。 */
function hostExternalPackages(): string[] {
    const packages = new Set<string>();
    for (const specifier of HOST_PACKAGE_SPECIFIERS) {
        const segments = specifier.split('/');
        const name = specifier.startsWith('@') && segments.length >= 2 ? `${segments[0]}/${segments[1]}` : segments[0];
        packages.add(name);
    }
    const external = [...packages];
    for (const name of packages) external.push(`${name}/*`);
    return external;
}

/**
 * bundle 产物是 ESM，但被内联的 CJS 依赖（如 ws）内部仍用 `require('events')`
 * 之类的同步调用访问 Node 内置模块。esbuild 不会把它们改写成静态 import（会改变
 * 求值时机），而是留下 `__require(...)`，在 ESM 下 `require` 未定义就抛
 * `Dynamic require of "..." is not supported`。这里补上模块作用域的 `require`，
 * `__require` 会自动改用它。与 CLI 产物的 banner（见 esbuild.config.ts）同理。
 */
const BUNDLE_BANNER = `import { createRequire as __opendeskCreateRequire } from 'node:module';
const require = __opendeskCreateRequire(import.meta.url);
`;

async function bundlePluginEntry(sourceEntry: string, outputEntry: string): Promise<void> {
    await esbuild.build({
        entryPoints: [sourceEntry],
        bundle: true,
        platform: 'node',
        target: 'node20',
        format: 'esm',
        outfile: outputEntry,
        minify: true,
        treeShaking: true,
        sourcemap: false,
        banner: { js: BUNDLE_BANNER },
        external: hostExternalPackages()
    });
}

export async function buildBuiltinPlugins(
    options: BuildBuiltinPluginsOptions = {}
): Promise<BuiltinPluginBuildResult[]> {
    const sourceDirectory = path.resolve(options.sourceDirectory ?? 'resources/plugins');
    const outputDirectory = path.resolve(options.outputDirectory ?? 'dist/plugins');
    const runNpm = options.runNpm ?? defaultRunNpm;
    assertSafeOutputDirectory(sourceDirectory, outputDirectory);
    fs.rmSync(outputDirectory, { recursive: true, force: true });
    fs.mkdirSync(outputDirectory, { recursive: true });
    if (!fs.existsSync(sourceDirectory)) return [];

    const pluginDirectories = fs
        .readdirSync(sourceDirectory, { withFileTypes: true })
        .filter((entry) => !entry.name.startsWith('.') && entry.isDirectory())
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((entry) => path.join(sourceDirectory, entry.name));
    const knownIds = new Set<string>();
    const results: BuiltinPluginBuildResult[] = [];
    for (const pluginDirectory of pluginDirectories) {
        results.push(await buildBuiltinPlugin(pluginDirectory, outputDirectory, knownIds, runNpm));
    }
    return results;
}

function isMainModule(): boolean {
    const entry = process.argv[1];
    return Boolean(entry) && pathToFileURL(path.resolve(entry)).href === import.meta.url;
}

if (isMainModule()) {
    buildBuiltinPlugins()
        .then((results) => {
            console.log(`Built ${results.length} builtin plugin${results.length === 1 ? '' : 's'}.`);
        })
        .catch((error) => {
            console.error('Failed to build builtin plugins:', error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
        });
}
