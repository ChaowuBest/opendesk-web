/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { logger } from '../../../utils/logger.js';
import type {
    OpenDeskPlugin,
    PluginCapability,
    PluginStaticResources
} from '../../../../../packages/plugin-sdk/src/index.js';
import {
    applyPluginManifest,
    loadPluginResources,
    readPluginManifest,
    readStaticOnlyPluginManifest,
    type PluginManifest
} from './manifest.js';

const INDEX_FILES = ['index.js', 'index.mjs', 'index.cjs'];
const RUNNABLE_ENTRY_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

export interface PluginCandidate {
    spec: string;
    origin: string;
    options?: Record<string, unknown>;
    grantedCapabilities?: PluginCapability[];
    integrity?: string;
}

export interface LoadedPlugin {
    plugin: OpenDeskPlugin;
    manifest?: PluginManifest;
    entry: string;
    rootDir: string;
    resources: PluginStaticResources;
    candidate: PluginCandidate;
}

export interface ResolvePluginEntryOptions {
    requireDeclaration?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isPathInside(root: string, target: string): boolean {
    const normalizedRoot = path.resolve(root);
    const normalizedTarget = path.resolve(target);
    return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`);
}

function extractExportPath(value: unknown): string | undefined {
    if (typeof value === 'string') return value;
    if (!isRecord(value)) return undefined;
    if (typeof value.import === 'string') return value.import;
    if (typeof value.default === 'string') return value.default;
    return undefined;
}

function readPackageJson(directory: string): Record<string, unknown> | undefined {
    const file = path.join(directory, 'package.json');
    if (!fs.existsSync(file)) return undefined;
    try {
        return JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
    } catch {
        return undefined;
    }
}

function resolveStandaloneManifestEntry(directory: string): string | undefined {
    const manifestPath = path.join(directory, 'opendesk.plugin.json');
    if (!fs.existsSync(manifestPath)) return undefined;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as unknown;
    if (!isRecord(manifest) || typeof manifest.entry !== 'string') return undefined;
    return path.resolve(directory, manifest.entry);
}

function resolveDeclaredEntry(directory: string, packageJson: Record<string, unknown>): string | undefined {
    const opendesk = packageJson.opendesk;
    if (isRecord(opendesk) && typeof opendesk.plugin === 'string') {
        return path.resolve(directory, opendesk.plugin);
    }

    const exportsField = packageJson.exports;
    if (isRecord(exportsField)) {
        const exported = extractExportPath(exportsField['./opendesk']);
        if (exported) return path.resolve(directory, exported);
    }
    return undefined;
}

/**
 * 解析插件入口。目录插件没有可运行入口但带根级清单时返回 undefined：
 * 这是纯静态插件（如语言包，只贡献 resources.locales 等声明资源），
 * 由 loadPlugin 跳过动态 import，从清单合成最小插件对象。
 */
export function resolvePluginEntry(
    spec: string,
    baseDirectory: string,
    options: ResolvePluginEntryOptions = {}
): { entry: string; rootDir: string } | undefined {
    const target = path.isAbsolute(spec) ? spec : path.resolve(baseDirectory, spec);
    if (!fs.existsSync(target)) throw new Error('plugin.entry_not_found');

    const stat = fs.statSync(target);
    if (!stat.isDirectory()) {
        if (!RUNNABLE_ENTRY_EXTENSIONS.has(path.extname(target).toLowerCase())) {
            throw new Error('plugin.entry_typescript_unsupported');
        }
        return { entry: target, rootDir: path.dirname(target) };
    }

    const packageJson = readPackageJson(target);
    const declared =
        resolveStandaloneManifestEntry(target) ?? (packageJson ? resolveDeclaredEntry(target, packageJson) : undefined);
    if (declared) {
        if (!isPathInside(target, declared)) throw new Error('plugin.entry_outside_root');
        if (!fs.existsSync(declared)) throw new Error('plugin.entry_not_found');
        if (!RUNNABLE_ENTRY_EXTENSIONS.has(path.extname(declared).toLowerCase())) {
            throw new Error('plugin.entry_typescript_unsupported');
        }
        return { entry: declared, rootDir: target };
    }

    // 纯静态插件：带清单（根级 opendesk.plugin.json 或 package.json#opendesk）但未声明
    // 入口、也没有可运行的 index 文件（语言包等只声明 resources.* 的贡献）。
    // 清单形态口径与 readStaticOnlyPluginManifest 一致。该检查必须在 requireDeclaration
    // 之前——内置候选一律带 requireDeclaration，语言包正是以纯静态形态随宿主分发的。
    const hasIndexEntry = INDEX_FILES.some((filename) => fs.existsSync(path.join(target, filename)));
    const hasStaticManifest =
        fs.existsSync(path.join(target, 'opendesk.plugin.json')) ||
        (packageJson !== undefined && isRecord(packageJson.opendesk));
    if (!hasIndexEntry && hasStaticManifest) return undefined;

    if (options.requireDeclaration) throw new Error('plugin.entry_not_declared');

    for (const filename of INDEX_FILES) {
        const entry = path.join(target, filename);
        if (fs.existsSync(entry)) return { entry, rootDir: target };
    }
    throw new Error('plugin.entry_not_found');
}

function readPluginExport(module: Record<string, unknown>): OpenDeskPlugin {
    const value = module.default ?? module.plugin;
    if (!isRecord(value)) throw new Error('plugin.invalid_module');
    if (typeof value.id !== 'string' || typeof value.setup !== 'function') {
        throw new Error('plugin.invalid_module');
    }
    return value as unknown as OpenDeskPlugin;
}

export async function loadPlugin(
    candidate: PluginCandidate,
    baseDirectory: string,
    options: ResolvePluginEntryOptions = {}
): Promise<LoadedPlugin> {
    const resolved = resolvePluginEntry(candidate.spec, baseDirectory, options);
    // 纯静态插件：无入口文件但有根级清单，合成最小插件对象，不执行任何插件代码
    if (!resolved) {
        const rootDir = path.isAbsolute(candidate.spec) ? candidate.spec : path.resolve(baseDirectory, candidate.spec);
        const manifest = readStaticOnlyPluginManifest(rootDir);
        if (!manifest?.id) throw new Error('plugin.manifest_invalid_id');
        logger.info(`Loading static-only OpenDesk plugin: ${candidate.origin}`);
        const resources = loadPluginResources(manifest, rootDir);
        const plugin = applyPluginManifest({ id: manifest.id, setup: async () => undefined }, manifest);
        return {
            plugin,
            manifest,
            entry: '',
            rootDir,
            resources,
            candidate
        };
    }
    const manifest = readPluginManifest(resolved.entry, resolved.rootDir);
    const resources = loadPluginResources(manifest, resolved.rootDir);
    const entry = resolved.entry;
    const url = `${pathToFileURL(entry).href}?opendesk=${Date.now()}`;
    logger.info(`Loading OpenDesk plugin: ${candidate.origin}`);
    const module = (await import(url)) as Record<string, unknown>;
    return {
        plugin: applyPluginManifest(readPluginExport(module), manifest),
        manifest,
        entry,
        rootDir: resolved.rootDir,
        resources,
        candidate
    };
}
