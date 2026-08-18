/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import AdmZip from 'adm-zip';
import { extract as extractTar } from 'tar';
import {
    validateOpenDeskPluginDirectory,
    validateOpenDeskPluginPackage,
    type ValidatedOpenDeskPluginPackage
} from '../../../../../packages/plugin-sdk/src/package.js';
import { getOpendeskDirectory } from '../../../utils/setting.js';
import { logger } from '../../../utils/logger.js';
import { buildChildProcessEnv } from '../../../utils/shellExec.js';
import { discoverPlugins, verifyPluginRecord, type PluginVerification } from '../discovery/discovery.js';
import { computePluginIntegrity } from '../discovery/integrity.js';
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

const execFileAsync = promisify(execFile);

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
    fetchArchive: typeof globalThis.fetch
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

export interface NpmInvocation {
    executable: string;
    args: string[];
}

function environmentValue(environment: NodeJS.ProcessEnv, names: string[]): string | undefined {
    for (const name of names) {
        const value = environment[name];
        if (value) return value;
    }
    return undefined;
}

function executableOnPath(name: string, directories: string[], requireExecutable: boolean): string | undefined {
    for (const directory of directories) {
        const candidate = path.join(directory, name);
        try {
            if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) continue;
            if (requireExecutable) fs.accessSync(candidate, fs.constants.X_OK);
            return candidate;
        } catch {
            continue;
        }
    }
    return undefined;
}

type PluginManagerPlatform = NodeJS.Platform | 'openharmony';

function environmentPathDirectories(platform: PluginManagerPlatform, environment: NodeJS.ProcessEnv): string[] {
    const pathValue = environmentValue(environment, ['Path', 'PATH']) ?? '';
    const separator = platform === 'win32' ? ';' : ':';
    const directories = pathValue
        .split(separator)
        .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
        .filter(Boolean);
    if (platform !== 'win32') directories.push('/bin', '/usr/bin', '/usr/local/bin');
    if (platform === 'darwin') directories.push('/opt/homebrew/bin');
    if (platform === 'openharmony') directories.push('/data/service/hnp/bin');
    return [...new Set(directories)];
}

export function resolveNpmInvocation(
    args: string[],
    platform: PluginManagerPlatform = process.platform,
    environment: NodeJS.ProcessEnv = process.env
): NpmInvocation {
    const pathDirectories = environmentPathDirectories(platform, environment);
    if (platform !== 'win32') {
        const executable = executableOnPath('npm', pathDirectories, true);
        if (!executable) throw new Error('plugin.install_npm_cli_not_found');
        return { executable, args };
    }

    const configuredNpmCli = environment.npm_execpath;
    const npmCliCandidates = [
        configuredNpmCli,
        ...pathDirectories.map((directory) => path.join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js'))
    ].filter((candidate): candidate is string => Boolean(candidate));
    const npmCli = npmCliCandidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    const configuredNode = environment.npm_node_execpath;
    const nodeExecutable =
        (configuredNode && fs.existsSync(configuredNode) && fs.statSync(configuredNode).isFile()
            ? configuredNode
            : undefined) ?? executableOnPath('node.exe', pathDirectories, false);
    if (!npmCli || !nodeExecutable) throw new Error('plugin.install_npm_cli_not_found');
    return {
        executable: nodeExecutable,
        args: [npmCli, ...args]
    };
}

async function defaultNpmRunner(args: string[], cwd: string, cacheDirectory: string): Promise<void> {
    const invocation = resolveNpmInvocation(args);
    const npmrcPath = path.join(cwd, '.npmrc');
    fs.mkdirSync(path.join(cwd, 'node_modules'), { recursive: true });
    fs.mkdirSync(cacheDirectory, { recursive: true });
    fs.writeFileSync(npmrcPath, '', 'utf-8');
    try {
        await execFileAsync(invocation.executable, invocation.args, {
            cwd,
            timeout: 180_000,
            maxBuffer: 10 * 1024 * 1024,
            env: buildChildProcessEnv({
                ...process.env,
                npm_config_userconfig: npmrcPath,
                npm_config_cache: cacheDirectory,
                npm_config_fund: 'false',
                npm_config_audit: 'false'
            })
        });
    } finally {
        fs.rmSync(npmrcPath, { force: true });
    }
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

const ARCHIVE_RUNTIME_DEPENDENCY_INSTALL_ARGS = [
    'install',
    '--save-exact',
    '--install-links=true',
    '--no-bin-links',
    '--omit=dev',
    '--no-optional',
    '--audit=false',
    '--ignore-scripts',
    '--package-lock=false'
];

async function installArchivePluginDependencies(
    pluginDirectory: string,
    runNpm: (args: string[], cwd: string) => Promise<void>
): Promise<void> {
    const packageJsonPath = path.join(pluginDirectory, 'package.json');
    if (!fs.existsSync(packageJsonPath)) return;
    const packageJson = readJson(packageJsonPath);
    const hasRuntimeDependencies = ['dependencies', 'peerDependencies'].some((field) => {
        const value = packageJson[field];
        return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
    });
    if (!hasRuntimeDependencies) return;
    await runNpm([...ARCHIVE_RUNTIME_DEPENDENCY_INSTALL_ARGS], pluginDirectory);
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

async function moveExistingInstallToTrash(pluginId: string, configDirectory: string): Promise<void> {
    const destination = path.join(getPluginsDirectory(configDirectory), pluginId);
    if (!fs.existsSync(destination)) return;
    const trash = path.join(getPluginTrashDirectory(configDirectory), `${pluginId}-${Date.now()}`);
    for (let attempt = 0; ; attempt += 1) {
        try {
            await fs.promises.rename(destination, trash);
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
                          options.fetch ?? globalThis.fetch
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
            if (archiveFormat) {
                stage = 'install';
                await installArchivePluginDependencies(pluginDirectory, runNpm);
                stage = 'validate';
            }
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
        await moveExistingInstallToTrash(validated.id, configDirectory);
        fs.renameSync(stagingDirectory, destination);

        const previous = getPluginRecord(validated.id, configDirectory);
        const record: PluginRegistryRecord = {
            id: validated.id,
            source: 'managed',
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
    const record = getPluginRecord(id, configDirectory);
    if (!record) return { success: false, error: `Plugin not found: ${id}` };
    if (record.source !== 'managed') {
        return { success: false, error: 'plugin.uninstall_unmanaged' };
    }
    try {
        ensurePluginDirectories(configDirectory);
        await moveExistingInstallToTrash(id, configDirectory);
        removePluginRecord(id, configDirectory);
        return { success: true };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Plugin uninstall failed: ${id}`, error);
        return { success: false, error: message };
    }
}

export function listInstalledPlugins(configDirectory?: string): PluginRegistryRecord[] {
    return listPluginRecords(configDirectory).filter((record) => record.source === 'managed');
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
