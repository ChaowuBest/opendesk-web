/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import { extract as extractTar } from 'tar';
import {
    validateOpenDeskPluginDirectory,
    validateOpenDeskPluginPackage,
    type ValidatedOpenDeskPluginPackage
} from '../../../../../packages/plugin-sdk/src/package.js';
import { getOpendeskDirectory } from '../../../utils/setting.js';
import { logger } from '../../../utils/logger.js';
import { getPlatform } from '../../../../platforms/base.js';
import type { PluginPlatform } from '../../../../../packages/plugin-sdk/src/index.js';
import { discoverPlugins, verifyPluginRecord, type PluginVerification } from '../discovery/discovery.js';
import { resolvePluginEntry } from '../discovery/loader.js';
import { readPluginManifest } from '../discovery/manifest.js';
import { computePluginIntegrity } from '../discovery/integrity.js';
import { defaultNpmRunner, installPluginDependencies } from './dependencies.js';
import { getPluginManagerConfig, getRuntimePluginDirectories } from './config.js';
import {
    ensurePluginDirectories,
    getBuiltinPluginsDirectory,
    getPluginCacheDirectory,
    getPluginsDirectory,
    getPluginStagingDirectory,
    getPluginTrashDirectory
} from './paths.js';
import {
    getPluginRecord,
    listPluginRecords,
    removePluginRecord,
    upsertPluginRecord,
    type PluginRegistryRecord
} from './registry.js';
import { classifyPluginInstallError, type PluginInstallResult, type PluginInstallStage } from './errors.js';

export { resolveNpmInvocation, type NpmInvocation } from './dependencies.js';

export interface PluginInstallOptions {
    configDirectory?: string;
    runNpm?: (args: string[], cwd: string) => Promise<void>;
    fetch?: typeof globalThis.fetch;
}

type PluginArchiveFormat = 'tgz' | 'zip';

function pluginArchiveFormat(spec: string): PluginArchiveFormat | undefined {
    const value = spec.split(/[?#]/, 1)[0] ?? spec;
    const lowerCaseValue = value.toLowerCase();
    if (lowerCaseValue.endsWith('.zip')) return 'zip';
    if (lowerCaseValue.endsWith('.tgz') || lowerCaseValue.endsWith('.tar.gz')) return 'tgz';
    return undefined;
}

function isPluginRoot(directory: string): boolean {
    return (
        fs.existsSync(path.join(directory, 'opendesk.plugin.json')) ||
        fs.existsSync(path.join(directory, 'package.json')) ||
        fs.existsSync(path.join(directory, 'index.js')) ||
        fs.existsSync(path.join(directory, 'index.mjs')) ||
        fs.existsSync(path.join(directory, 'index.cjs'))
    );
}

function assertSafeArchiveEntry(destinationRoot: string, entryName: string): void {
    const entryPath = path.resolve(destinationRoot, entryName);
    if (entryPath !== destinationRoot && !entryPath.startsWith(`${destinationRoot}${path.sep}`)) {
        throw new Error('plugin.install_archive_unsafe_path');
    }
}

function findExtractedPluginRoot(destinationRoot: string): string {
    if (isPluginRoot(destinationRoot)) return destinationRoot;
    const children = fs
        .readdirSync(destinationRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'));
    if (children.length === 1) {
        const nested = path.join(destinationRoot, children[0].name);
        if (isPluginRoot(nested)) return nested;
    }
    throw new Error('plugin.install_archive_root_not_found');
}

async function extractPluginArchive(
    archivePath: string,
    destination: string,
    format: PluginArchiveFormat
): Promise<string> {
    const destinationRoot = path.resolve(destination);
    if (format === 'zip') {
        const archive = new AdmZip(archivePath);
        for (const entry of archive.getEntries()) {
            assertSafeArchiveEntry(destinationRoot, entry.entryName);
        }
        archive.extractAllTo(destinationRoot, true);
    } else {
        await extractTar({
            file: archivePath,
            cwd: destinationRoot,
            strict: true,
            preservePaths: false,
            filter: (entryName) => {
                assertSafeArchiveEntry(destinationRoot, entryName);
                return true;
            }
        });
    }
    return findExtractedPluginRoot(destinationRoot);
}

function copyPluginContents(sourceDirectory: string, destinationDirectory: string): void {
    for (const entry of fs.readdirSync(sourceDirectory)) {
        fs.cpSync(path.join(sourceDirectory, entry), path.join(destinationDirectory, entry), {
            recursive: true,
            force: false,
            errorOnExist: true
        });
    }
}

async function downloadPluginArchive(
    spec: string,
    destination: string,
    format: PluginArchiveFormat,
    fetchArchive: (input: string) => Promise<Response>
): Promise<string> {
    const response = await fetchArchive(spec);
    if (!response.ok) throw new Error(`plugin.install_archive_download_failed:${response.status}`);
    const archivePath = path.join(destination, `plugin.${format}`);
    fs.writeFileSync(archivePath, Buffer.from(await response.arrayBuffer()));
    return archivePath;
}

export interface SetPluginEnabledOptions {
    configDirectory?: string;
    externalPaths?: readonly string[];
    pluginDirectories?: readonly string[];
    builtinDirectory?: string;
}

function readJson(file: string): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
}

function installedPackageName(stagingDirectory: string): string {
    const packageJson = readJson(path.join(stagingDirectory, 'package.json'));
    const dependencies = packageJson.dependencies;
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
        throw new Error('plugin.install_package_not_found');
    }
    const names = Object.keys(dependencies);
    if (names.length !== 1) throw new Error('plugin.install_package_ambiguous');
    return names[0];
}

function packageDirectory(prefix: string, packageName: string): string {
    return path.join(prefix, 'node_modules', ...packageName.split('/'));
}

function relativeManagedPath(pluginId: string, packageName: string): string {
    return path.join(pluginId, 'node_modules', ...packageName.split('/'));
}

function directManagedPath(pluginId: string): string {
    return pluginId;
}

function directPluginDirectory(spec: string): string | undefined {
    const resolved = path.resolve(spec);
    return fs.existsSync(resolved) && fs.statSync(resolved).isDirectory() ? resolved : undefined;
}

function assertSafePluginId(id: string): void {
    if (!/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(id)) throw new Error('plugin.install_invalid_id');
}

const MOVE_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

function waitForMoveRetry(delay: number): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, delay);
        timer.unref?.();
    });
}

async function moveToTrash(source: string, configDirectory: string): Promise<void> {
    if (!fs.existsSync(source)) return;
    const trash = path.join(getPluginTrashDirectory(configDirectory), `${path.basename(source)}-${Date.now()}`);
    for (let attempt = 0; ; attempt += 1) {
        try {
            await fs.promises.rename(source, trash);
            return;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (!code || !MOVE_RETRY_CODES.has(code) || attempt >= 4) throw error;
            await waitForMoveRetry(50 * 2 ** attempt);
        }
    }
}

export async function installPlugin(spec: string, options: PluginInstallOptions = {}): Promise<PluginInstallResult> {
    const configDirectory = options.configDirectory ?? getOpendeskDirectory();
    ensurePluginDirectories(configDirectory);
    const stagingDirectory = fs.mkdtempSync(path.join(getPluginStagingDirectory(configDirectory), 'install-'));
    const runNpm =
        options.runNpm ??
        ((args: string[], cwd: string) => defaultNpmRunner(args, cwd, getPluginCacheDirectory(configDirectory)));
    let stage: PluginInstallStage = 'install';
    let temporarySourceDirectory: string | undefined;
    try {
        const sourceDirectory = directPluginDirectory(spec);
        const archiveFormat = sourceDirectory ? undefined : pluginArchiveFormat(spec);
        let validated: ValidatedOpenDeskPluginPackage;
        let pluginDirectory: string;
        let managedPath: string;
        if (sourceDirectory || archiveFormat) {
            stage = 'validate';
            let extractedDirectory = sourceDirectory;
            if (archiveFormat) {
                stage = 'install';
                temporarySourceDirectory = fs.mkdtempSync(
                    path.join(getPluginStagingDirectory(configDirectory), 'archive-')
                );
                const extractionDirectory = path.join(temporarySourceDirectory, 'contents');
                fs.mkdirSync(extractionDirectory);
                const resolvedSpec = path.resolve(spec);
                const archivePath = fs.existsSync(resolvedSpec)
                    ? resolvedSpec
                    : await downloadPluginArchive(
                          spec,
                          temporarySourceDirectory,
                          archiveFormat,
                          options.fetch ?? ((input) => getPlatform().fetch(input))
                      );
                extractedDirectory = await extractPluginArchive(archivePath, extractionDirectory, archiveFormat);
                stage = 'validate';
            }
            if (!extractedDirectory) throw new Error('plugin.install_archive_root_not_found');
            validateOpenDeskPluginDirectory(extractedDirectory);
            stage = 'commit';
            pluginDirectory = stagingDirectory;
            copyPluginContents(extractedDirectory, pluginDirectory);
            stage = 'validate';
            validated = validateOpenDeskPluginDirectory(pluginDirectory);
            stage = 'install';
            await installPluginDependencies(pluginDirectory, runNpm);
            stage = 'validate';
            managedPath = directManagedPath(validated.id);
        } else {
            fs.writeFileSync(
                path.join(stagingDirectory, 'package.json'),
                `${JSON.stringify({ name: 'opendesk-plugin-staging', private: true, version: '1.0.0' }, null, 2)}\n`,
                'utf-8'
            );
            const args = [
                'install',
                '--prefix',
                stagingDirectory,
                '--save-exact',
                '--install-links=true',
                '--no-bin-links',
                '--omit=dev',
                '--no-optional',
                '--audit=false',
                '--ignore-scripts',
                spec
            ];
            await runNpm(args, stagingDirectory);

            stage = 'resolve';
            const packageName = installedPackageName(stagingDirectory);
            pluginDirectory = packageDirectory(stagingDirectory, packageName);
            stage = 'validate';
            validated = validateOpenDeskPluginPackage(pluginDirectory);
            managedPath = relativeManagedPath(validated.id, packageName);
        }
        assertSafePluginId(validated.id);
        const builtin = discoverPlugins({ configDirectory }).candidates.find(
            (candidate) => candidate.source === 'builtin' && candidate.id === validated.id
        );
        if (builtin) throw new Error(`plugin.install_builtin_conflict:${validated.id}`);
        stage = 'commit';
        const integrity = computePluginIntegrity(pluginDirectory);
        const destination = path.join(getPluginsDirectory(configDirectory), validated.id);
        await moveToTrash(destination, configDirectory);
        fs.renameSync(stagingDirectory, destination);

        const previous = getPluginRecord(validated.id, configDirectory);
        const record: PluginRegistryRecord = {
            id: validated.id,
            source: 'local',
            path: managedPath,
            spec,
            enabled: previous?.enabled ?? true,
            installedAt: new Date().toISOString(),
            integrity,
            options: previous?.options ?? {},
            grantedCapabilities: previous?.grantedCapabilities
        };
        upsertPluginRecord(record, configDirectory);
        logger.info(`Installed plugin: ${validated.id}`);
        return { success: true, id: validated.id };
    } catch (error) {
        if (fs.existsSync(stagingDirectory)) fs.rmSync(stagingDirectory, { recursive: true, force: true });
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Plugin install failed: ${spec}`, error);
        return {
            success: false,
            error: message,
            errorCode: classifyPluginInstallError(error, stage)
        };
    } finally {
        if (temporarySourceDirectory && fs.existsSync(temporarySourceDirectory)) {
            fs.rmSync(temporarySourceDirectory, { recursive: true, force: true });
        }
    }
}

export async function uninstallPlugin(
    id: string,
    configDirectory: string = getOpendeskDirectory()
): Promise<{ success: boolean; error?: string }> {
    const pluginsRoot = path.resolve(getPluginsDirectory(configDirectory));
    const record = getPluginRecord(id, configDirectory);
    let target: string | undefined;
    if (record && record.source !== 'builtin' && !path.isAbsolute(record.path)) {
        // Registry records for plugins inside the plugins directory always start
        // with the container entry (directory or single plugin file).
        target = path.resolve(pluginsRoot, record.path.split(/[\\/]/)[0]);
        if (!target.startsWith(`${pluginsRoot}${path.sep}`)) {
            return { success: false, error: 'plugin.uninstall_invalid_path' };
        }
    } else {
        const candidate = discoverPlugins({ configDirectory }).candidates.find((entry) => entry.id === id);
        if (!candidate) return { success: false, error: `Plugin not found: ${id}` };
        if (candidate.source === 'builtin') return { success: false, error: 'plugin.uninstall_builtin' };
        if (candidate.source === 'external') return { success: false, error: 'plugin.uninstall_external' };
        const spec = path.resolve(candidate.spec);
        if (!spec.startsWith(`${pluginsRoot}${path.sep}`)) {
            return { success: false, error: 'plugin.uninstall_external' };
        }
        target = spec;
    }
    try {
        ensurePluginDirectories(configDirectory);
        await moveToTrash(target, configDirectory);
        removePluginRecord(id, configDirectory);
        return { success: true };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Plugin uninstall failed: ${id}`, error);
        return { success: false, error: message };
    }
}

export function listInstalledPlugins(configDirectory?: string): PluginRegistryRecord[] {
    return listPluginRecords(configDirectory);
}

/**
 * 对外展示口径的插件列表：registry 记录与 discovery 候选合并，与 GUI 插件
 * 管理页（PluginMgrApplication.list）保持一致，内置、本地散装与外部路径
 * 插件均可见。平台不匹配的插件（如鸿蒙专属插件）不出现在列表中。
 */
export function listVisiblePlugins(
    options: {
        configDirectory?: string;
        externalPaths?: readonly string[];
        pluginDirectories?: readonly string[];
    } = {}
): PluginRegistryRecord[] {
    const resolvedConfigDirectory = options.configDirectory ?? getOpendeskDirectory();
    const records = listPluginRecords(resolvedConfigDirectory);
    const discovery = discoverPlugins({
        configDirectory: resolvedConfigDirectory,
        // 未显式传入时与 GUI 口径对齐：读取 settings.json 的 externalPaths 与
        // 运行时注册的插件目录（CLI --plugins-directory 等）。
        externalPaths: options.externalPaths ?? getPluginManagerConfig().externalPaths,
        pluginDirectories: options.pluginDirectories ?? getRuntimePluginDirectories()
    });
    const candidatesById = new Map(discovery.candidates.map((candidate) => [candidate.id, candidate]));
    const merged = new Map(records.map((record) => [record.id, record]));
    for (const candidate of discovery.candidates) {
        if (merged.has(candidate.id)) continue;
        merged.set(candidate.id, {
            id: candidate.id,
            source: candidate.source,
            path: candidate.spec,
            enabled: true,
            options: candidate.options ?? {},
            grantedCapabilities: candidate.grantedCapabilities
        });
    }
    // 展示路径与 GUI 列表对齐（candidate?.spec ?? record?.path）：registry 记录
    // （启停/安装策略会写相对路径）优先采用 discovery 的绝对 spec，未被
    // discovery 覆盖的记录（如被禁用插件）按来源解析为绝对路径。
    const platformFiltered: PluginRegistryRecord[] = [];
    for (const [id, record] of merged) {
        const candidate = candidatesById.get(id);
        const displayRecord = candidate
            ? { ...record, path: candidate.spec }
            : {
                  ...record,
                  path: path.isAbsolute(record.path)
                      ? record.path
                      : path.resolve(
                            record.source === 'builtin'
                                ? getBuiltinPluginsDirectory()
                                : getPluginsDirectory(resolvedConfigDirectory),
                            record.path
                        )
              };
        // 平台过滤与 GUI 列表对齐：对所有条目生效（含 registry 记录），
        // 清单缺失或损坏时保持展示。
        try {
            const spec = candidate?.spec ?? displayRecord.path;
            const resolved = resolvePluginEntry(spec, resolvedConfigDirectory);
            const manifest = readPluginManifest(resolved.entry, resolved.rootDir);
            if (manifest?.platforms?.length && !manifest.platforms.includes(process.platform as PluginPlatform)) {
                continue;
            }
        } catch {
            // keep displaying
        }
        platformFiltered.push(displayRecord);
    }
    return platformFiltered.sort((a, b) => a.id.localeCompare(b.id));
}

export function setPluginEnabled(
    id: string,
    enabled: boolean,
    configDirectoryOrOptions?: string | SetPluginEnabledOptions
): boolean {
    const options =
        typeof configDirectoryOrOptions === 'string'
            ? { configDirectory: configDirectoryOrOptions }
            : (configDirectoryOrOptions ?? {});
    const resolvedConfigDirectory = options.configDirectory ?? getOpendeskDirectory();
    let record = getPluginRecord(id, resolvedConfigDirectory);
    if (!record) {
        const builtinDirectory = path.resolve(options.builtinDirectory ?? getBuiltinPluginsDirectory());
        const candidate = discoverPlugins({
            configDirectory: resolvedConfigDirectory,
            builtinDirectory,
            externalPaths: options.externalPaths,
            pluginDirectories: options.pluginDirectories
        }).candidates.find((entry) => entry.id === id);
        if (candidate) {
            const root =
                candidate.source === 'builtin'
                    ? builtinDirectory
                    : candidate.source === 'local'
                      ? getPluginsDirectory(resolvedConfigDirectory)
                      : undefined;
            record = {
                id,
                source: candidate.source,
                path: root ? path.relative(root, candidate.spec) : candidate.spec,
                enabled: true,
                options: candidate.options ?? {},
                grantedCapabilities: candidate.grantedCapabilities
            };
        }
    }
    if (!record) return false;
    upsertPluginRecord({ ...record, enabled }, resolvedConfigDirectory);
    return true;
}

export function verifyInstalledPlugin(id: string, configDirectory?: string): PluginVerification | undefined {
    const record = getPluginRecord(id, configDirectory);
    return record ? verifyPluginRecord(record, configDirectory) : undefined;
}
