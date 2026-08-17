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

import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { parsePluginManifest } from '../src/main/applications/pluginmgr/discovery/manifest.js';

const MANIFEST_FILENAME = 'opendesk.plugin.json';

export interface BuildBuiltinPluginsOptions {
    sourceDirectory?: string;
    outputDirectory?: string;
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

function copyPluginSources(sourceDirectory: string, outputDirectory: string): void {
    fs.cpSync(sourceDirectory, outputDirectory, {
        recursive: true,
        filter(source) {
            const relative = path.relative(sourceDirectory, source);
            if (!relative) return true;
            const first = relative.split(path.sep)[0];
            return first !== 'node_modules' && first !== '.git' && first !== 'dist';
        }
    });
}

function buildBuiltinPlugin(
    sourceDirectory: string,
    outputRoot: string,
    knownIds: Set<string>
): BuiltinPluginBuildResult {
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

    const pluginOutputDirectory = path.join(outputRoot, manifest.id);
    copyPluginSources(sourceDirectory, pluginOutputDirectory);
    const outputEntry = path.resolve(pluginOutputDirectory, manifest.entry);
    return {
        id: manifest.id,
        sourceDirectory,
        outputDirectory: pluginOutputDirectory,
        entry: outputEntry
    };
}

export async function buildBuiltinPlugins(
    options: BuildBuiltinPluginsOptions = {}
): Promise<BuiltinPluginBuildResult[]> {
    const sourceDirectory = path.resolve(options.sourceDirectory ?? 'resources/plugins');
    const outputDirectory = path.resolve(options.outputDirectory ?? 'dist/plugins');
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
        results.push(await buildBuiltinPlugin(pluginDirectory, outputDirectory, knownIds));
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
