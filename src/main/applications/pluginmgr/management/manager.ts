/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import { extract as extractTar } from 'tar';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
    validateOpenDeskPluginDirectory,
    validateOpenDeskPluginPackage,
    type ValidatedOpenDeskPluginPackage
} from '../../../../../packages/plugin-sdk/src/package.js';
import { getOpendeskDirectory } from '../../../utils/setting.js';
import { logger } from '../../../utils/logger.js';
import { getPlatform } from '../../../../platforms/base.js';
import type { PluginPlatform } from '../../../../../packages/plugin-sdk/src/index.js';
import {
    discoverPlugins,
    resolvePluginRecordPath,
    verifyPluginRecord,
    type PluginVerification
} from '../discovery/discovery.js';
import { resolvePluginEntry } from '../discovery/loader.js';
import { readPluginManifest } from '../discovery/manifest.js';
import { computePluginIntegrity } from '../discovery/integrity.js';
import { defaultNpmRunner, installPluginDependencies } from './dependencies.js';
import {
    ensurePluginDirectories,
    getPluginCacheDirectory,
    getPluginDataDirectory,
    getPluginRecordRoot,
    getPluginsDirectory,
    getPluginStagingDirectory,
    getPluginTrashDirectory,
    toPluginRecordPath
} from './paths.js';
import {
    getPluginRecord,
    isStalePluginRecord,
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
    /**
     * 远程归档包下载进度（字节）。
     *
     * total 来自响应的 content-length；服务端没给长度时为 null，此时只能显示「已下载多少」。
     * 本地目录 / 本地归档包 / npm 源都不会回调。
     */
    onDownloadProgress?: (receivedBytes: number, totalBytes: number | null) => void;
    /**
     * 落盘前的最后一道校验：插件已经下载/解压到暂存目录、还没注册进 `plugins/` 之前调用。
     *
     * 抛错即中止安装——磁盘上不会留下这一版，已安装的旧版本保持原样。市场安装用它核对
     * 「市场条目 vs 包内清单」：对不上时宁可整单失败，也不要装进一个与上架信息不符的包。
     */
    verifyStaged?: (staged: { id: string; directory: string }) => void;
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

/**
 * 下载远程插件归档包。
 *
 * 边下边写到临时目录：归档包可能几十兆，先整包读进内存既费内存又没法显示进度。
 * 进度按响应体分块回调，调用方（插件市场）据此更新界面。
 */
async function downloadPluginArchive(
    spec: string,
    destination: string,
    format: PluginArchiveFormat,
    fetchArchive: (input: string) => Promise<Response>,
    onProgress?: (receivedBytes: number, totalBytes: number | null) => void
): Promise<string> {
    const response = await fetchArchive(spec);
    if (!response.ok) {
        // 取消未消费的响应体，连接立刻回到连接池；重试安装不会等 GC 才释放
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`plugin.install_archive_download_failed:${response.status}`);
    }
    const archivePath = path.join(destination, `plugin.${format}`);
    // content-length 是「传输编码之后」的字节数：响应被 gzip / br 压缩时它和解压后的流长度对不上，
    // 拿它算进度会一路冲到 100% 还继续涨（并让「末块优先发」退化成每块都发）。这种响应只能报
    // 「已下载多少」，界面退化成不定进度条
    const contentEncoding = (response.headers.get('content-encoding') ?? 'identity').trim().toLowerCase();
    const declaredSize = Number(response.headers.get('content-length'));
    const totalBytes =
        (contentEncoding === '' || contentEncoding === 'identity') && Number.isFinite(declaredSize) && declaredSize > 0
            ? declaredSize
            : null;
    if (!response.body) {
        fs.writeFileSync(archivePath, Buffer.from(await response.arrayBuffer()));
        onProgress?.(fs.statSync(archivePath).size, totalBytes);
        return archivePath;
    }
    let receivedBytes = 0;
    onProgress?.(0, totalBytes);
    try {
        await pipeline(
            Readable.fromWeb(response.body as never),
            new Transform({
                transform(chunk: Buffer, _encoding, callback) {
                    receivedBytes += chunk.length;
                    onProgress?.(receivedBytes, totalBytes);
                    callback(null, chunk);
                }
            }),
            fs.createWriteStream(archivePath)
        );
    } catch (error) {
        // 半截归档包留在临时目录里没有意义，下次安装也不会复用。删不掉（Windows 上句柄
        // 偶尔还没释放）也不能盖掉真正的失败原因，否则用户只看到一句删除失败
        try {
            fs.rmSync(archivePath, { force: true });
        } catch {
            /* 清理失败忽略：临时目录随安装流程一起回收 */
        }
        throw error;
    }
    return archivePath;
}

export interface SetPluginEnabledOptions {
    configDirectory?: string;
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
                          options.fetch ?? ((input) => getPlatform().fetch(input)),
                          options.onDownloadProgress
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
        if (isBuiltinPluginId(validated.id, configDirectory)) {
            throw new Error(`plugin.install_builtin_conflict:${validated.id}`);
        }
        // 覆盖安装沿用旧记录的启停/选项/授权；上一版被内置插件顶掉时也保留用户的选择
        const previous = getPluginRecord(validated.id, configDirectory);
        // 落盘前的最后一道校验（市场安装用来核对上架信息与包内清单）：抛错就整单失败，
        // 此时 destination 还没被挪走，旧版本原样留在磁盘上
        options.verifyStaged?.({ id: validated.id, directory: pluginDirectory });
        stage = 'commit';
        const integrity = computePluginIntegrity(pluginDirectory);
        const destination = path.join(getPluginsDirectory(configDirectory), validated.id);
        await moveToTrash(destination, configDirectory);
        fs.renameSync(stagingDirectory, destination);

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

export interface UninstallPluginOptions {
    configDirectory?: string;
    /**
     * 是否同时删除插件的私有数据目录（`plugins/.pluginmgr/data/<id>`）。
     * 默认 false：保留数据，重新安装同一插件 id 后可继续使用。
     */
    removeData?: boolean;
}

export type UninstallTargetResolution = { ok: true; target: string } | { ok: false; error: string };

/**
 * 解析卸载要删除的磁盘目标，或在不能卸载时给出拒绝原因。
 *
 * 单独暴露出来是为了让宿主在**释放插件运行实例之前**先做检查：内置与附加插件目录里的
 * 插件、以及已不存在的插件都不该被 deactivate，否则会白白拆掉一个正在运行的内置渠道
 * 插件再装回来。
 */
export function resolveUninstallTarget(
    id: string,
    configDirectory: string = getOpendeskDirectory()
): UninstallTargetResolution {
    const pluginsRoot = path.resolve(getPluginsDirectory(configDirectory));
    const record = getPluginRecord(id, configDirectory);
    // 内置记录（含附加插件目录）与运行状态无关：即使插件当前被禁用，也不该报「找不到插件」
    if (record?.source === 'builtin') return { ok: false, error: 'plugin.uninstall_builtin' };
    if (record && !path.isAbsolute(record.path)) {
        // Registry records for plugins inside the plugins directory always start
        // with the container entry (directory or single plugin file).
        const target = path.resolve(pluginsRoot, record.path.split(/[\\/]/)[0]);
        if (!target.startsWith(`${pluginsRoot}${path.sep}`)) {
            return { ok: false, error: 'plugin.uninstall_invalid_path' };
        }
        return { ok: true, target };
    }
    const candidate = discoverPlugins({ configDirectory }).candidates.find((entry) => entry.id === id);
    if (!candidate) return { ok: false, error: `Plugin not found: ${id}` };
    if (candidate.source === 'builtin') return { ok: false, error: 'plugin.uninstall_builtin' };
    const spec = path.resolve(candidate.spec);
    if (!spec.startsWith(`${pluginsRoot}${path.sep}`)) {
        return { ok: false, error: 'plugin.uninstall_invalid_path' };
    }
    return { ok: true, target: spec };
}

export async function uninstallPlugin(
    id: string,
    configDirectoryOrOptions: string | UninstallPluginOptions = getOpendeskDirectory()
): Promise<{ success: boolean; error?: string }> {
    const options =
        typeof configDirectoryOrOptions === 'string'
            ? { configDirectory: configDirectoryOrOptions }
            : configDirectoryOrOptions;
    const configDirectory = options.configDirectory ?? getOpendeskDirectory();
    const resolution = resolveUninstallTarget(id, configDirectory);
    if (!resolution.ok) return { success: false, error: resolution.error };
    try {
        ensurePluginDirectories(configDirectory);
        await moveToTrash(resolution.target, configDirectory);
        // 数据目录按插件 id 拼接（不是磁盘容器目录名，两者未必一致）
        if (options.removeData) removePluginDataDirectory(id, configDirectory);
        removePluginRecord(id, configDirectory);
        return { success: true };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Plugin uninstall failed: ${id}`, error);
        return { success: false, error: message };
    }
}

/**
 * 删除插件私有数据目录。
 *
 * 数据目录不进回收站：它只是插件的运行态数据，没有代码可恢复的价值；而 `moveToTrash`
 * 用 `<basename>-<timestamp>` 命名，插件目录与数据目录 basename 相同时会在同一毫秒撞名，
 * 导致卸载"半成功"（代码目录已进 trash、数据目录报错、注册表记录残留）。
 *
 * `maxRetries` 走 Node 内置的 EPERM/EBUSY 重试：插件的 sqlite、缓存文件常被刚释放的
 * MCP 子进程短暂占用，一次失败就放弃会让"已删除数据"的提示变成谎报。
 *
 * 重试后仍失败只记录警告：此时插件代码目录已经移走，把已完成卸载判为失败会让运行时、
 * 磁盘与注册表三者不一致，用户也无法重试。
 */
function removePluginDataDirectory(pluginId: string, configDirectory: string): void {
    const directory = getPluginDataDirectory(pluginId, configDirectory);
    try {
        fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
        logger.warn(`Plugin data directory removal failed: ${pluginId}`, error);
    }
}

export function listInstalledPlugins(configDirectory?: string): PluginRegistryRecord[] {
    return listPluginRecords(configDirectory);
}

/**
 * 展示口径的插件记录：比 registry 多一个「启停由清单固定」标记。
 * CLI/TUI 列表据此标明固定启停的原因，与 GUI 插件中心的系统标记保持一致。
 */
export interface VisiblePluginRecord extends PluginRegistryRecord {
    system?: boolean;
}

/**
 * 该 id 是否已经被内置级插件占用（默认内置目录 + 附加插件目录）。
 *
 * 内置插件的 ID 具有最高优先级：同 ID 的本地/市场插件装上去也只会被盖掉，因此一律拒绝安装。
 * 被禁用的内置插件不在发现结果里，所以再看一眼注册表记录；但只在记录指向的插件仍在磁盘上时
 * 才算冲突——附加目录撤掉后留下的残留记录不该永久堵住同名插件的安装。
 *
 * 安装流程与插件市场的下载前预检共用这一判定，避免「市场显示能装、装完才报冲突」。
 */
export function isBuiltinPluginId(id: string, configDirectory: string = getOpendeskDirectory()): boolean {
    const record = getPluginRecord(id, configDirectory);
    if (record?.source === 'builtin' && fs.existsSync(resolvePluginRecordPath(record, configDirectory))) return true;
    return discoverPlugins({ configDirectory }).candidates.some(
        (candidate) => candidate.source === 'builtin' && candidate.id === id
    );
}

/**
 * 对外展示口径的插件列表：registry 记录与 discovery 候选合并，与 GUI 插件
 * 管理页（PluginMgrApplication.list）保持一致，内置、附加插件目录与本地散装
 * 插件均可见。平台不匹配的插件（如鸿蒙专属插件）不出现在列表中。
 */
export function listVisiblePlugins(options: { configDirectory?: string } = {}): VisiblePluginRecord[] {
    const resolvedConfigDirectory = options.configDirectory ?? getOpendeskDirectory();
    const records = listPluginRecords(resolvedConfigDirectory);
    const discovery = discoverPlugins({ configDirectory: resolvedConfigDirectory });
    const candidatesById = new Map(discovery.candidates.map((candidate) => [candidate.id, candidate]));
    const merged = new Map<string, VisiblePluginRecord>(
        records
            // 与 pluginmgr 列表同口径：记录指向的插件已经不在磁盘上（不再内置、目录被删、
            // 外部目录被撤）时不再展示——那是一个既不能启用也不能卸载的幽灵条目。
            .filter((record) => !isStalePluginRecord(record, resolvedConfigDirectory))
            .map((record) => [record.id, record])
    );
    for (const candidate of discovery.candidates) {
        if (merged.has(candidate.id)) continue;
        merged.set(candidate.id, {
            id: candidate.id,
            source: candidate.source,
            path: candidate.spec,
            enabled: candidate.enabled,
            system: candidate.system,
            options: candidate.options ?? {},
            grantedCapabilities: candidate.grantedCapabilities
        });
    }
    // 展示路径与 GUI 列表对齐（candidate?.spec ?? record?.path）：registry 记录
    // （启停/安装策略会写相对路径）优先采用 discovery 的绝对 spec，未被
    // discovery 覆盖的记录（如被禁用插件）按来源解析为绝对路径。
    // 启停状态同样以 discovery 为准：清单固定启停（system）的内置插件不采信 registry。
    const platformFiltered: VisiblePluginRecord[] = [];
    for (const [id, record] of merged) {
        const candidate = candidatesById.get(id);
        // 有候选时整条记录都采用 discovery 口径（来源、路径、启停、system）：只取部分字段
        // 会出现「路径指向内置目录、来源却写着 local」这类自相矛盾的展示。
        const displayRecord = candidate
            ? {
                  ...record,
                  source: candidate.source,
                  path: candidate.spec,
                  enabled: candidate.enabled,
                  system: candidate.system
              }
            : { ...record, path: resolvePluginRecordPath(record, resolvedConfigDirectory) };
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

/**
 * 插件是否由清单固定启停（内置插件在清单里声明了 `system: true`）。
 *
 * 固定后 pluginmgr 不再允许切换开关，实际状态直接沿用清单里的 `enabled`：
 * `true`（或缺省）恒启用，`false` 恒禁用。
 */
export function isPluginEnabledFixed(id: string, options: SetPluginEnabledOptions = {}): boolean {
    const candidate = discoverPlugins({ configDirectory: options.configDirectory }).candidates.find(
        (entry) => entry.id === id
    );
    return candidate?.system === true;
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
    // 一次发现同时给出「能否改开关」与「候选记录」：清单固定启停的插件写注册表也不会生效
    //（发现阶段始终以清单为准），直接拒绝，避免留下「注册表说启用、运行时仍然禁用」的假状态。
    const candidate = discoverPlugins({ configDirectory: resolvedConfigDirectory }).candidates.find(
        (entry) => entry.id === id
    );
    if (candidate?.system) return false;
    let record = getPluginRecord(id, resolvedConfigDirectory);
    if (!record) {
        if (!candidate) return false;
        record = {
            id,
            source: candidate.source,
            path: toPluginRecordPath(candidate.spec, getPluginRecordRoot(candidate.source, resolvedConfigDirectory)),
            enabled: true,
            options: candidate.options ?? {},
            grantedCapabilities: candidate.grantedCapabilities
        };
    }
    upsertPluginRecord({ ...record, enabled }, resolvedConfigDirectory);
    return true;
}

export function verifyInstalledPlugin(id: string, configDirectory?: string): PluginVerification | undefined {
    const record = getPluginRecord(id, configDirectory);
    return record ? verifyPluginRecord(record, configDirectory) : undefined;
}
