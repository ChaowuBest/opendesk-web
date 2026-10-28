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
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
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
    type DatasetManifest,
    type DatasetSummary,
    type DatasetTrackRef,
    type RunListItem,
    type RunRecord,
    type RunStatus
} from './common.js';

const META_FILE = 'benchmark-meta.json';
const RUN_FILE = 'run.json';

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

export class BenchmarkManager {
    private readonly datasetsDir: string;
    private readonly runsDir: string;
    private readonly tmpDir: string;
    private readonly runner = new BenchmarkRunner();
    private readonly listeners = new Set<() => void>();
    private readonly activeRuns = new Set<string>();
    private notifyTimer: NodeJS.Timeout | null = null;

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

    // ── 测评集 ─────────────────────────────────────────────────────────────

    listDatasets(): DatasetSummary[] {
        const result: DatasetSummary[] = [];
        for (const entry of this.safeReadDir(this.datasetsDir)) {
            const datasetDir = path.join(this.datasetsDir, entry);
            const metaPath = path.join(datasetDir, META_FILE);
            if (!fs.existsSync(metaPath)) continue;
            try {
                const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as DatasetSummary;
                if (!meta?.id) continue;
                result.push(meta);
            } catch (error) {
                logger.warn(`[benchmark] broken dataset meta ${metaPath}: ${toErrorMessage(error)}`);
            }
        }
        return result.sort((a, b) => b.importedAt - a.importedAt);
    }

    getDataset(datasetId: string): DatasetSummary | null {
        let metaPath: string;
        try {
            metaPath = path.join(this.resolveInside(this.datasetsDir, datasetId), META_FILE);
        } catch {
            // datasetId 来自 renderer，越界路径按「不存在」处理，不要拿它去拼文件路径
            return null;
        }
        if (!fs.existsSync(metaPath)) return null;
        try {
            return JSON.parse(fs.readFileSync(metaPath, 'utf8')) as DatasetSummary;
        } catch {
            return null;
        }
    }

    async importDataset(archivePath: string): Promise<DatasetSummary> {
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
            const manifest = this.readDatasetManifest(path.join(datasetRoot, 'dataset.json'));
            const scanned = this.scanDataset(datasetRoot, manifest);
            const caseCount = scanned.tracks.reduce((sum, track) => sum + track.cases.length, 0);
            if (caseCount === 0) {
                throw new BenchmarkDataError(t('error.caseJsonMissing'));
            }

            const id = `${slugify(manifest.name)}-${crypto.randomBytes(3).toString('hex')}`;
            const targetDir = path.join(this.datasetsDir, id);
            fs.mkdirSync(path.dirname(targetDir), { recursive: true });
            fs.renameSync(datasetRoot, targetDir);

            const summary: DatasetSummary = {
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
            fs.writeFileSync(
                path.join(targetDir, META_FILE),
                JSON.stringify({ ...summary, archiveName: path.basename(normalized) }, null, 2)
            );
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
        const manifest = this.readDatasetManifest(datasetJsonPath);
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
                    runTaskId: null,
                    verifyTaskId: null,
                    startedAt: null,
                    finishedAt: null,
                    dir: path.join('cases', toSafeDirName(key))
                });
            }
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
        run.summary = summarizeCases(run.cases);
        this.writeRun(run);
        this.notifyNow();
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
    private readDatasetManifest(datasetJsonPath: string): DatasetManifest {
        let raw: unknown;
        try {
            raw = JSON.parse(fs.readFileSync(datasetJsonPath, 'utf8'));
        } catch (error) {
            throw new BenchmarkDataError(t('error.invalidDataset', { reason: toErrorMessage(error) }));
        }
        return parseDatasetManifest(raw);
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
        if (this.notifyTimer) {
            clearTimeout(this.notifyTimer);
            this.notifyTimer = null;
        }
        for (const listener of this.listeners) {
            try {
                listener();
            } catch (error) {
                logger.warn(`[benchmark] listener failed: ${toErrorMessage(error)}`);
            }
        }
    }

    private notifySoon(): void {
        if (this.notifyTimer) return;
        this.notifyTimer = setTimeout(() => {
            this.notifyTimer = null;
            this.notifyNow();
        }, 500);
    }
}

function isInside(baseDir: string, targetPath: string): boolean {
    const base = path.resolve(baseDir);
    const target = path.resolve(targetPath);
    return target === base || target.startsWith(`${base}${path.sep}`);
}
