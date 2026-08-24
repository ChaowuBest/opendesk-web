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
    PluginStaticContributions
} from '../../../../../packages/plugin-sdk/src/index.js';
import { applyPluginManifest, loadPluginContributions, readPluginManifest, type PluginManifest } from './manifest.js';

const INDEX_FILES = ['index.js', 'index.mjs', 'index.cjs'];
const RUNNABLE_ENTRY_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

export const OPENDESK_RUNTIME_VERSION = '0.3.5';

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
    contributions: PluginStaticContributions;
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

export function resolvePluginEntry(
    spec: string,
    baseDirectory: string,
    options: ResolvePluginEntryOptions = {}
): { entry: string; rootDir: string } {
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
    const manifest = readPluginManifest(resolved.entry, resolved.rootDir);
    const contributions = loadPluginContributions(manifest, resolved.rootDir);
    const entry = resolved.entry;
    const url = `${pathToFileURL(entry).href}?opendesk=${Date.now()}`;
    logger.info(`Loading OpenDesk plugin: ${candidate.origin}`);
    const module = (await import(url)) as Record<string, unknown>;
    return {
        plugin: applyPluginManifest(readPluginExport(module), manifest),
        manifest,
        entry,
        rootDir: resolved.rootDir,
        contributions,
        candidate
    };
}
