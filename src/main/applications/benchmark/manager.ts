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
 * 测评集与测评运行的存储层。
 *
 * 目录布局（全部位于 benchmark 应用自己的数据目录下）：
 *   datasets/<datasetId>/            解压后的测评集（dataset.json + tracks/…）
 *   datasets/<datasetId>/benchmark-meta.json   导入元信息
 *   runs/<runId>/run.json            运行记录（用例状态与得分）
 *   runs/<runId>/cases/<key>/        每个用例的工作空间与日志
 *   tmp/import-*                     导入解压的临时目录
 *   tmp/download-*                   下载中的压缩包
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Readable } from 'stream';
import AdmZip from 'adm-zip';
import { extract as extractTar } from 'tar';
import { logger } from '../../utils/logger.js';
import { toErrorMessage } from '../../../common/utils/error.js';
import { t } from './locale/index.js';
import { BenchmarkRunner, type CasePlanItem, type RunnerCallbacks } from './engine.js';
import {
    BenchmarkDataError,
    parseDatasetManifest,
    parseTrackManifest,
    resolveCaseSpec,
    slugify,
    summarizeCases,
    toSafeDirName,
    type CaseRunState,
    type CaseSpec,
    type BenchmarkSummary,
    type DatasetManifest,
    type InstalledBenchmarkSummary,
    type DatasetTrackRef,
    type DownloadState,
    type ParseDatasetManifestOptions,
    type RunListItem,
    type RunRecord,
    type RunStatus
} from './common.js';
import { downloadStateKey, findLocalDatasetByName } from './catalog-common.js';

const META_FILE = 'benchmark-meta.json';
const RUN_FILE = 'run.json';
/** 工作空间占用的缓存时长：已结束的轮次基本不再变化，缓存可以长一点 */
const RUN_USAGE_TTL_MS = 5 * 60_000;
/** 扫盘并发上限：再高对机械盘没有收益，反而拖慢单次 readdir/stat */
const MEASURE_CONCURRENCY = 32;
/** 下载体积上限：防止清单或镜像给出异常大的文件把磁盘写满 */
const DOWNLOAD_MAX_BYTES = 4 * 1024 * 1024 * 1024;
/** 传输停滞上限：连续这么久没有任何字节推进就判定连接假死（0 = 不检测） */
const DOWNLOAD_STALL_TIMEOUT_MS = 60_000;
const DEFAULT_DOWNLOAD_EXTENSION = '.zip';

interface ScannedDataset {
    manifest: DatasetManifest;
    tracks: Array<{
        id: string;
        name: string;
        description: string;
        dir: string;
        cases: Array<{ caseId: string; dir: string; spec: CaseSpec }>;
    }>;
}

/**
 * 递归量一个目录的占用字节数。
 *
 * 目录不存在按 0 算；单个文件/子目录在统计途中被删掉（用例清理工作空间时会这样）就跳过，
 * 统计本身不该因为这种竞态失败。
 *
 * 并发是有意的：一轮的 cases 目录常有十几万文件，串行 stat 实测要一分多钟，
 * 限并发下能压到十分之一。并发数不拉太高，否则机械盘上的寻道反而更慢。
 */
async function measureDirectoryBytes(root: string): Promise<number> {
    let total = 0;
    let active = 0;
    const waiting: Array<() => void> = [];
    /** 同一时刻最多 MEASURE_CONCURRENCY 个 FS 操作在跑 */
    const withSlot = async <T>(task: () => Promise<T>): Promise<T> => {
        if (active < MEASURE_CONCURRENCY) active += 1;
        else await new Promise<void>((resolve) => waiting.push(resolve));
        try {
            return await task();
        } finally {
            const next = waiting.shift();
            // 名额直接转交给排队的调用方，active 不变
            if (next) next();
            else active -= 1;
        }
    };
    const walk = async (dir: string): Promise<void> => {
        const entries = await withSlot(async () => {
            try {
                return await fs.promises.readdir(dir, { withFileTypes: true });
            } catch {
                return [] as fs.Dirent[];
            }
        });
        // 大目录一次铺开会堆出几十万个 Promise，分批推进入即可，并发由 withSlot 兜住
        for (let i = 0; i < entries.length; i += MEASURE_CONCURRENCY) {
            await Promise.all(
                entries.slice(i, i + MEASURE_CONCURRENCY).map(async (entry) => {
                    const full = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        await walk(full);
                        return;
                    }
                    if (!entry.isFile()) return;
                    const size = await withSlot(async () => {
                        try {
                            return (await fs.promises.stat(full)).size;
                        } catch {
                            // 竞态：文件刚被清理掉，跳过即可
                            return 0;
                        }
                    });
                    total += size;
                })
            );
        }
    };
    await walk(root);
    return total;
}

export class BenchmarkManager {
    private readonly datasetsDir: string;
    private readonly runsDir: string;
    private readonly tmpDir: string;
    private readonly runner = new BenchmarkRunner();
    private readonly listeners = new Set<() => void>();
    private readonly downloadListeners = new Set<() => void>();
    private readonly activeRuns = new Set<string>();
    /** 测评集下载进度，按清单 id 保留最近一次状态（完成/失败也保留，供界面展示） */
    private readonly downloads = new Map<string, DownloadState>();
    private notifyTimer: NodeJS.Timeout | null = null;
    private downloadNotifyTimer: NodeJS.Timeout | null = null;
    /** runId → 工作空间占用的短期缓存，避免界面每次局部刷新都重扫一遍 */
    private readonly runUsageCache = new Map<string, { bytes: number; at: number }>();
    /** 正在扫描中的轮次：界面在扫描期间反复刷新时复用同一个 Promise，不重复遍历目录 */
    private readonly usageInFlight = new Map<string, Promise<number>>();

    constructor(private readonly dataDirectory: string) {
        this.datasetsDir = path.join(dataDirectory, 'datasets');
        this.runsDir = path.join(dataDirectory, 'runs');
        this.tmpDir = path.join(dataDirectory, 'tmp');
    }

    init(): void {
        for (const dir of [this.datasetsDir, this.runsDir, this.tmpDir]) {
            fs.mkdirSync(dir, { recursive: true });
        }
        this.recoverInterruptedRuns();
        // 清理上次异常退出遗留的导入临时目录
        try {
            for (const entry of fs.readdirSync(this.tmpDir)) {
                fs.rmSync(path.join(this.tmpDir, entry), { recursive: true, force: true });
            }
        } catch (error) {
            logger.warn(`[benchmark] failed to clean temp directory: ${toErrorMessage(error)}`);
        }
    }

    onChange(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /**
     * 下载进度单独一路监听。
     *
     * 进度每隔几百毫秒就变一次，混进 onChange 会让渲染层把整个面板重建一遍
     * （卡片 hover 状态会被打断），所以只通知需要刷进度条的地方。
     */
    onDownloadChange(listener: () => void): () => void {
        this.downloadListeners.add(listener);
        return () => this.downloadListeners.delete(listener);
    }

    // ── 测评集 ─────────────────────────────────────────────────────────────

    listDatasets(): InstalledBenchmarkSummary[] {
        const result: InstalledBenchmarkSummary[] = [];
        for (const entry of this.safeReadDir(this.datasetsDir)) {
            const datasetDir = path.join(this.datasetsDir, entry);
            const metaPath = path.join(datasetDir, META_FILE);
            if (!fs.existsSync(metaPath)) continue;
            try {
                const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as InstalledBenchmarkSummary;
                if (!meta?.id) continue;
                result.push(meta);
            } catch (error) {
                logger.warn(`[benchmark] broken dataset meta ${metaPath}: ${toErrorMessage(error)}`);
            }
        }
        return result.sort((a, b) => b.importedAt - a.importedAt);
    }

    getDataset(datasetId: string): InstalledBenchmarkSummary | null {
        let metaPath: string;
        try {
            metaPath = path.join(this.resolveInside(this.datasetsDir, datasetId), META_FILE);
        } catch {
            // datasetId 来自 renderer，越界路径按「不存在」处理，不要拿它去拼文件路径
            return null;
        }
        if (!fs.existsSync(metaPath)) return null;
        try {
            return JSON.parse(fs.readFileSync(metaPath, 'utf8')) as InstalledBenchmarkSummary;
        } catch {
            return null;
        }
    }

    async importDataset(archivePath: string): Promise<InstalledBenchmarkSummary> {
        return this.installArchive(archivePath, {});
    }

    /** 丢掉所有占用缓存，让下一次查询重新扫盘（只有手动刷新会调） */
    clearRunWorkspaceUsageCache(): void {
        this.runUsageCache.clear();
    }

    /**
     * 某轮运行当前占用的磁盘空间（字节）—— 整个 runs/<runId> 目录的实时大小。
     *
     * 不要改成只统计 cases：界面文案是「已占用 X 磁盘空间」，用户会拿它和目录实际大小对照，
     * 漏掉 run.json 之类的边角文件就会对不上。
     *
     * 逐轮来拿，不要做成「一次返回全部」：单轮耗时跟文件数成正比，十几万文件的轮次
     * 实测要一分多钟（158 GB / 76s），一次全量返回会把整张列表一起拖住，谁先量完谁先显示才好。
     *
     * 已结束的轮次基本不再变化，缓存 5 分钟即可；运行中的轮次不量，见下面的早退分支。
     */
    async getRunWorkspaceUsage(runId: string): Promise<number | null> {
        // 运行中的轮次不扫盘：这种量级的目录要遍历十几秒到一分多钟，会和它自己的 git/编译抢 IO。
        // 返回 null 表示「这轮先不算」，收尾时缓存失效，跑完第一次拿到的就是最终值。
        if (this.readRun(runId)?.status === 'running') return null;
        const cached = this.runUsageCache.get(runId);
        if (cached && Date.now() - cached.at < RUN_USAGE_TTL_MS) return cached.bytes;
        // 同一轮扫描可能要几十秒，界面在这期间会反复刷新；直接复用正在跑的那次，
        // 否则同一个目录会被同时遍历好几遍，把磁盘打满
        const pending = this.usageInFlight.get(runId);
        if (pending) return pending;
        const task = this.measureRunWorkspace(runId);
        this.usageInFlight.set(runId, task);
        try {
            return await task;
        } finally {
            this.usageInFlight.delete(runId);
        }
    }

    private async measureRunWorkspace(runId: string): Promise<number> {
        let runDir: string;
        try {
            runDir = this.resolveInside(this.runsDir, runId);
        } catch {
            return 0;
        }
        const bytes = await measureDirectoryBytes(runDir);
        this.runUsageCache.set(runId, { bytes, at: Date.now() });
        return bytes;
    }

    /** 当前所有下载任务的状态快照（渲染层据此画进度条） */
    listDownloads(): DownloadState[] {
        return [...this.downloads.values()].map((state) => ({ ...state }));
    }

    /**
     * 从清单地址下载测评集并安装。
     *
     * 本地已有同名测评集时按「更新」处理：沿用原 datasetId 覆盖目录，
     * 这样历史测评记录（按 datasetId 关联）不会因为换 id 变成孤儿。
     *
     * @param options.registryName 清单来自哪个 registry：清单项 id 只在同一 registry 内唯一
     */
    async downloadDataset(
        entry: BenchmarkSummary,
        options: { registryName: string; fetchImpl?: typeof fetch; stallTimeoutMs?: number }
    ): Promise<InstalledBenchmarkSummary> {
        const key = downloadStateKey(options.registryName, entry.id);
        const current = this.downloads.get(key);
        if (current && (current.status === 'downloading' || current.status === 'installing')) {
            throw new BenchmarkDataError(t('error.downloadInProgress'));
        }
        const fetchImpl = options.fetchImpl ?? globalThis.fetch;
        const state: DownloadState = {
            registryName: options.registryName,
            catalogId: entry.id,
            status: 'downloading',
            receivedBytes: 0,
            totalBytes: null,
            error: ''
        };
        this.downloads.set(key, state);

        const archivePath = path.join(this.tmpDir, `download-${crypto.randomUUID()}${downloadExtension(entry)}`);
        try {
            await this.downloadArchive(
                entry.downloadUrl,
                archivePath,
                fetchImpl,
                (receivedBytes, totalBytes) => {
                    state.receivedBytes = receivedBytes;
                    state.totalBytes = totalBytes;
                    // 自带节流，进度刷新不会把主进程刷爆
                    this.notifyDownloadsSoon();
                },
                options.stallTimeoutMs
            );
            state.status = 'installing';
            state.receivedBytes = state.totalBytes ?? state.receivedBytes;
            this.notifyDownloadsNow();

            const summary = await this.installArchive(archivePath, { catalog: entry });
            state.status = 'done';
            this.notifyDownloadsNow();
            return summary;
        } catch (error) {
            state.status = 'failed';
            state.error = toErrorMessage(error);
            this.notifyDownloadsNow();
            logger.warn(`[benchmark] download ${entry.id} from ${entry.downloadUrl} failed: ${state.error}`);
            throw error;
        } finally {
            try {
                fs.rmSync(archivePath, { force: true });
            } catch (error) {
                logger.warn(`[benchmark] failed to remove archive ${archivePath}: ${toErrorMessage(error)}`);
            }
        }
    }

    /**
     * 把本地压缩包安装成测评集。
     *
     * @param options.catalog 来自下载清单时，校验包内 dataset.json 的名称与清单一致，
     *   并在本地存在同名测评集时原地覆盖（沿用原 datasetId）。
     */
    private async installArchive(
        archivePath: string,
        options: { catalog?: BenchmarkSummary }
    ): Promise<InstalledBenchmarkSummary> {
        const normalized = archivePath.trim();
        if (!fs.existsSync(normalized)) {
            throw new BenchmarkDataError(t('error.fileNotFound', { file: normalized }));
        }
        const lower = normalized.toLowerCase();
        const isZip = lower.endsWith('.zip');
        const isTar = lower.endsWith('.tar.gz') || lower.endsWith('.tgz') || lower.endsWith('.tar');
        if (!isZip && !isTar) {
            throw new BenchmarkDataError(t('error.unsupportedArchive'));
        }

        const tempRoot = path.join(this.tmpDir, `import-${crypto.randomUUID()}`);
        fs.mkdirSync(tempRoot, { recursive: true });
        try {
            if (isZip) {
                this.extractZip(normalized, tempRoot);
            } else {
                await extractTar({ file: normalized, cwd: tempRoot });
            }

            const datasetRoot = this.findDatasetRoot(tempRoot);
            if (!datasetRoot) {
                throw new BenchmarkDataError(t('error.datasetJsonMissing'));
            }
            // 新装进来的测评集必须是合法 SemVer：放行自由文本版本会让它永远低于清单版本，
            // 每次打开下载中心都提示更新。历史数据只在读取时放行，见 runDataset 处
            const manifest = this.readDatasetManifest(path.join(datasetRoot, 'dataset.json'));
            if (options.catalog && manifest.name.trim().toLowerCase() !== options.catalog.name.trim().toLowerCase()) {
                // 下载地址可能被替换或镜像配错，装进来的东西和清单对不上就不要污染本地测评集
                throw new BenchmarkDataError(
                    t('error.downloadNameMismatch', { expected: options.catalog.name, actual: manifest.name })
                );
            }
            const scanned = this.scanDataset(datasetRoot, manifest);
            const caseCount = scanned.tracks.reduce((sum, track) => sum + track.cases.length, 0);
            if (caseCount === 0) {
                throw new BenchmarkDataError(t('error.caseJsonMissing'));
            }

            // 更新场景：本地已有同名测评集时原地覆盖，并沿用原 datasetId，
            // 否则历史测评记录会指向一个不存在的测评集
            const existing = options.catalog ? findLocalDatasetByName(this.listDatasets(), manifest.name) : null;
            if (existing) {
                const busy = this.listRuns().some((run) => run.datasetId === existing.id && run.status === 'running');
                if (busy) {
                    throw new BenchmarkDataError(t('error.datasetInUse'));
                }
            }
            const id = existing?.id ?? `${slugify(manifest.name)}-${crypto.randomBytes(3).toString('hex')}`;
            const targetDir = path.join(this.datasetsDir, id);
            fs.mkdirSync(path.dirname(targetDir), { recursive: true });

            const summary: InstalledBenchmarkSummary = {
                id,
                name: manifest.name,
                description: manifest.description,
                homepage: manifest.homepage,
                version: manifest.version,
                importedAt: Date.now(),
                caseCount,
                tracks: scanned.tracks.map((track) => ({
                    id: track.id,
                    name: track.name,
                    description: track.description,
                    caseCount: track.cases.length
                }))
            };
            // meta 先写进解压目录再整体换位：rename 之后目录里一定带着 meta，
            // 不会出现「目录已就位、meta 还没落盘」被 listDatasets 当成不存在的中间态
            fs.writeFileSync(
                path.join(datasetRoot, META_FILE),
                JSON.stringify({ ...summary, archiveName: path.basename(normalized) }, null, 2)
            );
            this.replaceDatasetDir(datasetRoot, targetDir);
            this.notifyNow();
            return summary;
        } finally {
            try {
                fs.rmSync(tempRoot, { recursive: true, force: true });
            } catch (error) {
                logger.warn(`[benchmark] failed to remove temp dir ${tempRoot}: ${toErrorMessage(error)}`);
            }
        }
    }

    /**
     * 把解压好的目录换到 datasets/ 下的目标位置。
     *
     * Windows 下目标目录非空时 rename 会失败，所以「更新」必须先挪走旧目录；挪到 tmp 备份
     * 而不是直接删，rename 失败时把旧测评集原样还回去，不让一次失败把已装的测评集弄丢。
     */
    private replaceDatasetDir(sourceDir: string, targetDir: string): void {
        if (!fs.existsSync(targetDir)) {
            fs.renameSync(sourceDir, targetDir);
            return;
        }
        const backupDir = path.join(this.tmpDir, `replace-${crypto.randomUUID()}`);
        fs.renameSync(targetDir, backupDir);
        try {
            fs.renameSync(sourceDir, targetDir);
        } catch (error) {
            fs.renameSync(backupDir, targetDir);
            throw error;
        }
        try {
            fs.rmSync(backupDir, { recursive: true, force: true });
        } catch (error) {
            // 备份残留在 tmp 里不影响使用，下次启动 init() 会清掉
            logger.warn(`[benchmark] failed to remove dataset backup ${backupDir}: ${toErrorMessage(error)}`);
        }
    }

    deleteDataset(datasetId: string): void {
        const datasetDir = this.resolveInside(this.datasetsDir, datasetId);
        if (!fs.existsSync(datasetDir)) {
            throw new BenchmarkDataError(t('error.datasetNotFound'));
        }
        const busy = this.listRuns().some((run) => run.datasetId === datasetId && run.status === 'running');
        if (busy) {
            throw new BenchmarkDataError(t('error.datasetInUse'));
        }
        fs.rmSync(datasetDir, { recursive: true, force: true });
        this.notifyNow();
    }

    // ── 测评运行 ───────────────────────────────────────────────────────────

    listRuns(): RunListItem[] {
        const runs: RunListItem[] = [];
        for (const entry of this.safeReadDir(this.runsDir)) {
            const record = this.readRun(entry);
            if (!record) continue;
            runs.push({
                id: record.id,
                datasetId: record.datasetId,
                datasetName: record.datasetName,
                status: record.status,
                createdAt: record.createdAt,
                startedAt: record.startedAt,
                finishedAt: record.finishedAt,
                runModel: record.runModel,
                verifyModel: record.verifyModel,
                concurrency: record.concurrency,
                summary: record.summary
            });
        }
        return runs.sort((a, b) => b.createdAt - a.createdAt);
    }

    getRun(runId: string): RunRecord | null {
        return this.readRun(runId);
    }

    startRun(options: {
        datasetId: string;
        concurrency: number;
        runModel: string;
        verifyModel: string;
        runModelEffort?: string;
        verifyModelEffort?: string;
        runTimeoutSec?: number | null;
        verifyTimeoutSec?: number | null;
        tracks?: string[];
        /** 只跑这些用例（key = `${trackId}/${caseId}`），用于「重新运行单个用例」 */
        caseKeys?: string[];
        /** 在既有 run 记录内原地重跑指定用例，其余用例的历史结果原样保留 */
        appendToRunId?: string;
    }): string {
        const dataset = this.getDataset(options.datasetId);
        if (!dataset) {
            throw new BenchmarkDataError(t('error.datasetNotFound'));
        }
        const datasetDir = path.join(this.datasetsDir, dataset.id);
        const datasetJsonPath = path.join(datasetDir, 'dataset.json');
        if (!fs.existsSync(datasetJsonPath)) {
            throw new BenchmarkDataError(t('error.datasetInvalidState'));
        }
        // 本地已安装的测评集可能是早期版本装的，版本号未必是 SemVer，读取时放行而不是判定损坏
        const manifest = this.readDatasetManifest(datasetJsonPath, { allowLegacyVersion: true });
        const scanned = this.scanDataset(datasetDir, manifest);
        const allTrackIds = scanned.tracks.map((track) => track.id);
        const requested = Array.isArray(options.tracks) && options.tracks.length > 0 ? options.tracks : allTrackIds;
        const wanted = new Set(requested.filter((id) => allTrackIds.includes(id)));
        if (wanted.size === 0) {
            throw new BenchmarkDataError(t('error.noTrackSelected'));
        }
        const plan: CasePlanItem[] = [];
        const cases: CaseRunState[] = [];
        const onlyCases =
            Array.isArray(options.caseKeys) && options.caseKeys.length > 0 ? new Set(options.caseKeys) : null;
        for (const track of scanned.tracks) {
            if (!wanted.has(track.id)) continue;
            for (const item of track.cases) {
                const key = `${track.id}/${item.caseId}`;
                if (onlyCases && !onlyCases.has(key)) continue;
                plan.push({
                    spec: item.spec,
                    dir: item.dir,
                    trackId: track.id,
                    trackName: track.name,
                    key
                });
                cases.push({
                    key,
                    trackId: track.id,
                    trackName: track.name,
                    caseId: item.caseId,
                    name: item.spec.name,
                    weight: item.spec.weight,
                    status: 'pending',
                    score: null,
                    ratio: null,
                    reason: '',
                    error: '',
                    logError: '',
                    runTaskId: null,
                    verifyTaskId: null,
                    startedAt: null,
                    finishedAt: null,
                    dir: path.join('cases', toSafeDirName(key))
                });
            }
        }
        if (plan.length === 0) {
            throw new BenchmarkDataError(t('error.datasetInvalidState'));
        }

        // 原地重跑：不新建 run 记录，把选中的用例重置回待跑状态追加进原记录，
        // 未选中的用例（历史得分/状态）原样保留
        if (options.appendToRunId) {
            const runId = options.appendToRunId;
            if (this.activeRuns.has(runId)) {
                throw new BenchmarkDataError(t('error.runAlreadyRunning'));
            }
            const existing = this.readRun(runId);
            if (!existing) {
                throw new BenchmarkDataError(t('error.runNotFound'));
            }
            if (existing.datasetId !== dataset.id) {
                throw new BenchmarkDataError(t('error.datasetNotFound'));
            }
            // runId 来自渲染层，拼路径前统一走 resolveInside（与 deleteRun / getRunDirectory 一致）；
            // 必须放在改动记录/登记活动运行之前，否则抛错会留下「状态 running 但没有引擎在跑」的死记录
            const appendRunDir = this.resolveInside(this.runsDir, runId);
            const byKey = new Map(cases.map((item) => [item.key, item]));
            const merged: CaseRunState[] = [];
            for (const item of existing.cases) {
                const fresh = byKey.get(item.key);
                if (fresh) {
                    merged.push(fresh);
                } else {
                    merged.push(item);
                }
            }
            // 用例集可能随测评集更新而变化：计划里有、历史里没有的用例也要补进来
            for (const item of cases) {
                if (!merged.some((entry) => entry.key === item.key)) merged.push(item);
            }
            existing.status = 'running';
            existing.startedAt = existing.startedAt ?? Date.now();
            existing.finishedAt = null;
            existing.runModel = options.runModel;
            existing.verifyModel = options.verifyModel;
            existing.runModelEffort = options.runModelEffort ?? existing.runModelEffort ?? '';
            existing.verifyModelEffort = options.verifyModelEffort ?? existing.verifyModelEffort ?? '';
            existing.runTimeoutSec = options.runTimeoutSec ?? null;
            existing.verifyTimeoutSec = options.verifyTimeoutSec ?? null;
            existing.cases = merged;
            existing.summary = summarizeCases(merged);
            this.writeRun(existing);
            this.activeRuns.add(runId);
            this.notifyNow();

            // 重跑的用例清掉上次的工作空间/日志，从零开始：
            // 否则上次的 result.json 等产物残留会被验证阶段直接采用
            for (const item of plan) {
                try {
                    fs.rmSync(path.join(appendRunDir, 'cases', toSafeDirName(item.key)), {
                        recursive: true,
                        force: true
                    });
                } catch (error) {
                    logger.warn(`[benchmark] failed to clean case dir for rerun ${item.key}: ${toErrorMessage(error)}`);
                }
            }
            const appendCallbacks: RunnerCallbacks = {
                updateCase: (id, key, patch) => this.updateCase(id, key, patch),
                finishRun: (id, status) => this.finishRun(id, this.appendRunStatus(id, status)),
                notify: () => this.notifySoon()
            };
            void this.runner
                .execute({ run: existing, plan, runDir: appendRunDir, callbacks: appendCallbacks })
                .catch((error) => {
                    logger.error(`[benchmark] run ${runId} crashed: ${toErrorMessage(error)}`);
                    this.finishRun(runId, 'failed');
                })
                .finally(() => this.activeRuns.delete(runId));
            return runId;
        }

        const runId = `run-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
        const runDir = path.join(this.runsDir, runId);
        fs.mkdirSync(runDir, { recursive: true });

        const run: RunRecord = {
            id: runId,
            datasetId: dataset.id,
            datasetName: dataset.name,
            createdAt: Date.now(),
            // 记录一落盘就立刻开跑，startedAt 必须在这里写进 run.json：
            // 引擎只是内存里兜底赋值，不会再回写记录
            startedAt: Date.now(),
            finishedAt: null,
            status: 'running',
            concurrency: options.concurrency,
            runModel: options.runModel,
            verifyModel: options.verifyModel,
            runModelEffort: options.runModelEffort ?? '',
            verifyModelEffort: options.verifyModelEffort ?? '',
            runTimeoutSec: options.runTimeoutSec ?? null,
            verifyTimeoutSec: options.verifyTimeoutSec ?? null,
            tracks: allTrackIds.filter((id) => wanted.has(id)),
            cases,
            summary: summarizeCases(cases)
        };
        this.writeRun(run);
        this.activeRuns.add(runId);
        this.notifyNow();

        const callbacks: RunnerCallbacks = {
            updateCase: (id, key, patch) => this.updateCase(id, key, patch),
            finishRun: (id, status) => this.finishRun(id, status),
            notify: () => this.notifySoon()
        };

        void this.runner
            .execute({ run, plan, runDir, callbacks })
            .catch((error) => {
                logger.error(`[benchmark] run ${runId} crashed: ${toErrorMessage(error)}`);
                this.finishRun(runId, 'failed');
            })
            .finally(() => this.activeRuns.delete(runId));

        return runId;
    }

    stopRun(runId: string): void {
        const record = this.readRun(runId);
        if (!record || record.status !== 'running') return;
        // 落盘停止标记：引擎收尾（逐个标记用例、等待任务退出）期间 UI 能显示「正在停止」
        if (!record.stopRequested) {
            record.stopRequested = true;
            this.writeRun(record);
        }
        this.runner.stop(runId);
        this.notifyNow();
    }

    deleteRun(runId: string): void {
        const record = this.readRun(runId);
        if (record?.status === 'running' || this.activeRuns.has(runId)) {
            throw new BenchmarkDataError(t('error.runStillRunning'));
        }
        const runDir = this.resolveInside(this.runsDir, runId);
        if (!fs.existsSync(runDir)) {
            throw new BenchmarkDataError(t('error.runNotFound'));
        }
        fs.rmSync(runDir, { recursive: true, force: true });
        this.notifyNow();
    }

    getRunDirectory(runId: string): string {
        return this.resolveInside(this.runsDir, runId);
    }

    private updateCase(runId: string, key: string, patch: Partial<CaseRunState>): void {
        const run = this.readRun(runId);
        if (!run) return;
        if (!key) {
            run.summary = summarizeCases(run.cases);
            this.writeRun(run);
            return;
        }
        const target = run.cases.find((item) => item.key === key);
        if (!target) return;
        Object.assign(target, patch);
        run.summary = summarizeCases(run.cases);
        this.writeRun(run);
        this.notifySoon();
    }

    private finishRun(runId: string, status: RunStatus): void {
        const run = this.readRun(runId);
        if (!run) return;
        run.status = status;
        run.finishedAt = Date.now();
        delete run.stopRequested;
        run.summary = summarizeCases(run.cases);
        this.writeRun(run);
        this.notifyNow();
        // 收尾后不再写入，占用已经定型：缓存立即失效，下次读取重算一遍拿到最终值
        this.runUsageCache.delete(runId);
    }

    /**
     * 原地重跑只跑了整轮里的一部分用例，引擎按「这次计划里的用例全失败」得出的 failed
     * 不能直接落到整轮记录上：历史里还有跑通的用例时整轮仍算完成（与 resolveRunStatus
     * 的「本轮所有用例都失败才算失败」口径一致）。
     */
    private appendRunStatus(runId: string, status: RunStatus): RunStatus {
        if (status !== 'failed') return status;
        const run = this.readRun(runId);
        if (!run) return status;
        return run.cases.some((item) => item.status === 'done') ? 'completed' : 'failed';
    }

    private readRun(runId: string): RunRecord | null {
        if (!/^[A-Za-z0-9._-]+$/.test(runId)) return null;
        const file = path.join(this.runsDir, runId, RUN_FILE);
        if (!fs.existsSync(file)) return null;
        try {
            return JSON.parse(fs.readFileSync(file, 'utf8')) as RunRecord;
        } catch (error) {
            logger.warn(`[benchmark] broken run file ${file}: ${toErrorMessage(error)}`);
            return null;
        }
    }

    private writeRun(run: RunRecord): void {
        const dir = path.join(this.runsDir, run.id);
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, RUN_FILE);
        const temp = `${file}.tmp`;
        fs.writeFileSync(temp, JSON.stringify(run, null, 2));
        fs.renameSync(temp, file);
    }

    private recoverInterruptedRuns(): void {
        for (const entry of this.safeReadDir(this.runsDir)) {
            const run = this.readRun(entry);
            if (!run || run.status !== 'running') continue;
            run.status = 'stopped';
            run.finishedAt = run.finishedAt ?? Date.now();
            delete run.stopRequested;
            for (const item of run.cases) {
                if (item.status !== 'done' && item.status !== 'failed' && item.status !== 'stopped') {
                    item.status = 'stopped';
                    item.finishedAt = item.finishedAt ?? Date.now();
                }
            }
            run.summary = summarizeCases(run.cases);
            this.writeRun(run);
            logger.info(`[benchmark] run ${run.id} was interrupted by a previous shutdown, marked as stopped`);
        }
    }

    // ── 测评集扫描 ─────────────────────────────────────────────────────────

    private scanDataset(rootDir: string, manifest: DatasetManifest): ScannedDataset {
        const tracksRoot = path.join(rootDir, 'tracks');
        const trackDirs: string[] = [];
        if (fs.existsSync(tracksRoot) && fs.statSync(tracksRoot).isDirectory()) {
            for (const entry of this.safeReadDir(tracksRoot)) {
                const dir = path.join(tracksRoot, entry);
                if (fs.existsSync(path.join(dir, 'track.json'))) trackDirs.push(dir);
            }
        }
        if (trackDirs.length === 0) {
            for (const entry of this.safeReadDir(rootDir)) {
                const dir = path.join(rootDir, entry);
                if (fs.existsSync(path.join(dir, 'track.json'))) trackDirs.push(dir);
            }
        }
        if (trackDirs.length === 0) {
            throw new BenchmarkDataError(t('error.trackJsonMissing'));
        }

        const scanned = trackDirs.map((dir) => this.scanTrack(dir, manifest.tracks));
        // 按 dataset.json 中声明的顺序排列，未声明的追加在后
        const order = new Map<string, number>();
        manifest.tracks.forEach((ref, index) => {
            order.set((ref.id || ref.name).toLowerCase(), index);
            order.set(ref.name.toLowerCase(), index);
        });
        scanned.sort((a, b) => (order.get(a.id.toLowerCase()) ?? 999) - (order.get(b.id.toLowerCase()) ?? 999));

        return { manifest, tracks: scanned };
    }

    private scanTrack(trackDir: string, refs: readonly DatasetTrackRef[]): ScannedDataset['tracks'][number] {
        const id = path.basename(trackDir);
        let trackManifest: ReturnType<typeof parseTrackManifest> = {};
        try {
            trackManifest = parseTrackManifest(JSON.parse(fs.readFileSync(path.join(trackDir, 'track.json'), 'utf8')));
        } catch (error) {
            throw new BenchmarkDataError(t('error.trackJsonBroken', { track: id, reason: toErrorMessage(error) }));
        }

        const ref = refs.find((item) => (item.id || item.name).toLowerCase() === id.toLowerCase());
        const name = trackManifest.name || ref?.name || id;
        const description = trackManifest.description || ref?.description || '';

        const caseDirs: string[] = [];
        const collectCases = (parentDir: string) => {
            for (const entry of this.safeReadDir(parentDir)) {
                const dir = path.join(parentDir, entry);
                try {
                    if (!fs.statSync(dir).isDirectory()) continue;
                } catch {
                    continue;
                }
                if (fs.existsSync(path.join(dir, 'case.json'))) caseDirs.push(dir);
            }
        };
        // 用例目录既可以是 track 下的直接子目录，也可以集中在 track/cases/ 下
        for (const entry of this.safeReadDir(trackDir)) {
            const dir = path.join(trackDir, entry);
            let isDirectory = false;
            try {
                isDirectory = fs.statSync(dir).isDirectory();
            } catch {
                isDirectory = false;
            }
            if (!isDirectory) continue;
            if (fs.existsSync(path.join(dir, 'case.json'))) {
                caseDirs.push(dir);
                continue;
            }
            collectCases(dir);
        }
        caseDirs.sort();

        const cases = caseDirs.map((dir) => {
            const caseId = path.basename(dir);
            let raw: unknown;
            try {
                raw = JSON.parse(fs.readFileSync(path.join(dir, 'case.json'), 'utf8'));
            } catch (error) {
                throw new BenchmarkDataError(
                    t('error.caseJsonBroken', { case: `${id}/${caseId}`, reason: toErrorMessage(error) })
                );
            }
            const spec = resolveCaseSpec(caseId, raw, (relative) => fs.existsSync(path.join(dir, relative)));
            return { caseId, dir, spec };
        });

        return { id, name, description, dir: trackDir, cases };
    }

    // ── 工具方法 ───────────────────────────────────────────────────────────

    /** 读取并校验 dataset.json；JSON 语法错误也要转成可读的本地化错误 */
    private readDatasetManifest(datasetJsonPath: string, options: ParseDatasetManifestOptions = {}): DatasetManifest {
        let raw: unknown;
        try {
            raw = JSON.parse(fs.readFileSync(datasetJsonPath, 'utf8'));
        } catch (error) {
            throw new BenchmarkDataError(t('error.invalidDataset', { reason: toErrorMessage(error) }));
        }
        return parseDatasetManifest(raw, options);
    }

    /** 流式下载到本地文件，边写边回调进度 */
    private async downloadArchive(
        url: string,
        destination: string,
        fetchImpl: typeof fetch,
        onProgress: (receivedBytes: number, totalBytes: number | null) => void,
        stallTimeoutMs = DOWNLOAD_STALL_TIMEOUT_MS
    ): Promise<void> {
        const controller = new AbortController();
        // 停滞看门狗同时罩住「等响应头」和「等数据」两段：连接假死时 for await 会一直等下去，
        // 下载状态就永久停在 downloading，界面既不会失败也重试不了。
        // 每个 chunk 到达即重置计时，超时则 abort 底层请求并以本地化错误拒绝。
        let stallReject: ((error: Error) => void) | undefined;
        const stalled = new Promise<never>((_, reject) => {
            stallReject = reject;
        });
        /** 正在读取的响应流：看门狗触发时要主动销毁，否则下载任务会一直挂在 for-await 上 */
        let activeBody: Readable | null = null;
        let stallTimer: NodeJS.Timeout | undefined;
        const resetStallWatchdog = () => {
            if (stallTimeoutMs <= 0) return;
            clearTimeout(stallTimer);
            stallTimer = setTimeout(() => {
                controller.abort();
                // 假死的连接未必响应 abort（自定义 fetch、已半关闭的 socket 都可能不响应），
                // 只 reject 看门狗 promise 会让下载任务永久挂在 for-await 上，它持有的文件
                // 句柄直到 GC 才被关闭（Node 会报 FileHandle closed during garbage collection）。
                // 主动销毁读取流，让 for-await 抛出、finally 关掉文件句柄。
                activeBody?.destroy(new BenchmarkDataError(t('error.downloadStalled')));
                stallReject?.(new BenchmarkDataError(t('error.downloadStalled')));
            }, stallTimeoutMs);
            stallTimer.unref?.();
        };

        const download = async () => {
            const response = await fetchImpl(url, {
                redirect: 'follow',
                headers: { accept: 'application/octet-stream' },
                signal: controller.signal
            });
            if (!response.ok) {
                throw new BenchmarkDataError(t('error.downloadHttpStatus', { status: response.status }));
            }
            const declaredSize = Number(response.headers.get('content-length'));
            const totalBytes = Number.isFinite(declaredSize) && declaredSize > 0 ? declaredSize : null;
            if (totalBytes && totalBytes > DOWNLOAD_MAX_BYTES) {
                throw new BenchmarkDataError(t('error.downloadTooLarge'));
            }

            fs.mkdirSync(path.dirname(destination), { recursive: true });
            const handle = await fs.promises.open(destination, 'w');
            try {
                if (!response.body) {
                    const buffer = Buffer.from(await response.arrayBuffer());
                    if (buffer.byteLength > DOWNLOAD_MAX_BYTES) {
                        throw new BenchmarkDataError(t('error.downloadTooLarge'));
                    }
                    await handle.write(buffer);
                    onProgress(buffer.byteLength, totalBytes ?? buffer.byteLength);
                    return;
                }
                let receivedBytes = 0;
                const body = Readable.fromWeb(response.body as never);
                activeBody = body;
                try {
                    for await (const chunk of body) {
                        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
                        receivedBytes += buffer.length;
                        if (receivedBytes > DOWNLOAD_MAX_BYTES) {
                            throw new BenchmarkDataError(t('error.downloadTooLarge'));
                        }
                        await handle.write(buffer);
                        resetStallWatchdog();
                        onProgress(receivedBytes, totalBytes);
                    }
                } finally {
                    if (activeBody === body) activeBody = null;
                }
            } finally {
                await handle.close().catch(() => undefined);
            }
        };

        resetStallWatchdog();
        const task = download();
        try {
            await Promise.race([task, stalled]);
        } finally {
            clearTimeout(stallTimer);
            // 看门狗先到时不留下未处理的下载拒绝
            task.catch(() => undefined);
        }
    }

    private extractZip(zipPath: string, targetDir: string): void {
        const zip = new AdmZip(zipPath);
        for (const entry of zip.getEntries()) {
            const entryName = entry.entryName.replaceAll('\\', '/');
            if (!entryName || entryName.startsWith('__MACOSX/')) continue;
            const targetPath = path.join(targetDir, entryName);
            if (!isInside(targetDir, targetPath)) {
                throw new BenchmarkDataError(t('error.archiveIllegalPath', { path: entryName }));
            }
            if (entry.isDirectory) {
                fs.mkdirSync(targetPath, { recursive: true });
                continue;
            }
            fs.mkdirSync(path.dirname(targetPath), { recursive: true });
            fs.writeFileSync(targetPath, entry.getData());
        }
    }

    private findDatasetRoot(dir: string): string | null {
        if (fs.existsSync(path.join(dir, 'dataset.json'))) return dir;
        const children = this.safeReadDir(dir)
            .map((entry) => path.join(dir, entry))
            .filter((child) => {
                try {
                    return fs.statSync(child).isDirectory();
                } catch {
                    return false;
                }
            });
        for (const child of children) {
            if (fs.existsSync(path.join(child, 'dataset.json'))) return child;
        }
        if (children.length === 1) {
            return this.findDatasetRoot(children[0]);
        }
        return null;
    }

    private safeReadDir(dir: string): string[] {
        try {
            return fs.readdirSync(dir);
        } catch {
            return [];
        }
    }

    private resolveInside(baseDir: string, name: string): string {
        const target = path.resolve(baseDir, name);
        if (!isInside(baseDir, target)) {
            throw new BenchmarkDataError(t('error.illegalPath', { path: name }));
        }
        return target;
    }

    private notifyNow(): void {
        const pending = this.notifyTimer;
        this.notifyTimer = null;
        this.flushListeners(this.listeners, pending, 'change');
    }

    private notifySoon(): void {
        this.notifyTimer = this.scheduleFlush(this.notifyTimer, 500, () => this.notifyNow());
    }

    private notifyDownloadsNow(): void {
        const pending = this.downloadNotifyTimer;
        this.downloadNotifyTimer = null;
        this.flushListeners(this.downloadListeners, pending, 'download');
    }

    private notifyDownloadsSoon(): void {
        this.downloadNotifyTimer = this.scheduleFlush(this.downloadNotifyTimer, 400, () => this.notifyDownloadsNow());
    }

    /** 立刻通知一路订阅者，顺带清掉这一路挂起的节流定时器 */
    private flushListeners(listeners: Set<() => void>, pending: NodeJS.Timeout | null, label: string): void {
        if (pending) clearTimeout(pending);
        for (const listener of listeners) {
            try {
                listener();
            } catch (error) {
                logger.warn(`[benchmark] ${label} listener failed: ${toErrorMessage(error)}`);
            }
        }
    }

    /** 节流：同一路通知在 intervalMs 内只发一次 */
    private scheduleFlush(pending: NodeJS.Timeout | null, intervalMs: number, run: () => void): NodeJS.Timeout {
        if (pending) return pending;
        const timer = setTimeout(run, intervalMs);
        // 事件通知只是 UI 刷新节流，不该拖住进程退出（否则 run 未结束时的定时器
        // 会让 Node/jest worker 无法优雅退出）
        timer.unref?.();
        return timer;
    }
}

function isInside(baseDir: string, targetPath: string): boolean {
    const base = path.resolve(baseDir);
    const target = path.resolve(targetPath);
    return target === base || target.startsWith(`${base}${path.sep}`);
}

/** 从下载地址推断压缩包后缀，便于复用按后缀分派的解压逻辑 */
function downloadExtension(entry: BenchmarkSummary): string {
    let pathname: string;
    try {
        pathname = new URL(entry.downloadUrl).pathname;
    } catch {
        return DEFAULT_DOWNLOAD_EXTENSION;
    }
    const lower = pathname.toLowerCase();
    for (const extension of ['.tar.gz', '.tgz', '.tar', '.zip']) {
        if (lower.endsWith(extension)) return extension;
    }
    return DEFAULT_DOWNLOAD_EXTENSION;
}
