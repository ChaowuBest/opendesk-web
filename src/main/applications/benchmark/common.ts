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
 * 测评应用的数据契约与纯函数。
 *
 * 这里只放不依赖文件系统 / Electron / 任务内核的逻辑，
 * 便于用单元测试覆盖测评集解析、评分解析与统计汇总。
 * 抛出的错误文案走应用词表（./locale），保证中英文都能读。
 */

import { t } from './locale/index.js';

/** 测评集 dataset.json 中声明的 track 引用 */
export interface DatasetTrackRef {
    /** track 目录名；缺省时取 name */
    id?: string;
    name: string;
    description?: string;
}

export interface DatasetManifest {
    name: string;
    description: string;
    homepage: string;
    version: string;
    tracks: DatasetTrackRef[];
}

/** track.json 的原始结构（字段全部可省略） */
export interface TrackManifest {
    name?: string;
    description?: string;
}

/**
 * 单个用例的规范化描述。
 * 所有路径均相对于用例目录（case.json 所在目录）。
 */
export interface CaseSpec {
    caseId: string;
    name: string;
    /** 用例分数（权重），用于加权汇总；默认 1 */
    weight: number;
    runPromptFile: string;
    verifyPromptFile: string;
    runPrepareFile: string | null;
    verifyPrepareFile: string | null;
    runTimeoutSec: number;
    prepareTimeoutSec: number;
    verifyTimeoutSec: number;
}

export interface DatasetTrackSummary {
    id: string;
    name: string;
    description: string;
    caseCount: number;
}

export interface DatasetSummary {
    id: string;
    name: string;
    description: string;
    homepage: string;
    version: string;
    importedAt: number;
    caseCount: number;
    tracks: DatasetTrackSummary[];
}

/**
 * 测评集下载中心的一条清单项。
 * 除下载地址外，其余字段语义与测评集自带的 dataset.json 保持一致。
 */
export interface CatalogDatasetEntry {
    /** 清单内稳定 id，不随版本变化 */
    id: string;
    name: string;
    description: string;
    homepage: string;
    version: string;
    /** 压缩包下载地址（zip / tar.gz / tgz / tar） */
    downloadUrl: string;
    tracks: DatasetTrackRef[];
}

export type DownloadStatus = 'downloading' | 'installing' | 'done' | 'failed';

/** 单个测评集的下载进度（主进程内存态，供渲染层订阅刷新） */
export interface DownloadState {
    catalogId: string;
    status: DownloadStatus;
    receivedBytes: number;
    /** 服务端未声明 content-length 时为 null（进度条按不确定态展示） */
    totalBytes: number | null;
    error: string;
}

/** 清单项在本地的安装状态 */
export type CatalogInstallState = 'not-installed' | 'update-available' | 'installed';

export type CaseRunStatus = 'pending' | 'preparing' | 'running' | 'verifying' | 'done' | 'failed' | 'stopped';

export type RunStatus = 'running' | 'completed' | 'stopped' | 'failed';

export interface CaseRunState {
    /** `${trackId}/${caseId}`，运行时目录名会再做一次安全化处理 */
    key: string;
    trackId: string;
    trackName: string;
    caseId: string;
    name: string;
    weight: number;
    status: CaseRunStatus;
    /** 实际得分 = ratio * weight */
    score: number | null;
    /** 验证模型给出的得分率 0~1 */
    ratio: number | null;
    reason: string;
    error: string;
    /** 脚本失败时 stdout/stderr 的合并输出尾部，供详情面板「错误信息」栏展示；其他失败为空 */
    logError: string;
    runTaskId: string | null;
    verifyTaskId: string | null;
    startedAt: number | null;
    finishedAt: number | null;
    /** 相对 run 目录的用例工作目录 */
    dir: string;
}

export interface RunSummary {
    total: number;
    pending: number;
    running: number;
    completed: number;
    failed: number;
    stopped: number;
    /** 已完成用例的得分之和 */
    totalScore: number;
    /** 所有用例的权重之和 */
    maxScore: number;
    /** 已完成用例的平均得分率 */
    avgRatio: number;
    /** 已结束用例的平均耗时（毫秒） */
    avgDurationMs: number;
}

export interface RunRecord {
    id: string;
    datasetId: string;
    datasetName: string;
    createdAt: number;
    startedAt: number | null;
    finishedAt: number | null;
    status: RunStatus;
    /** 用户已点停止、引擎还在收尾（用例逐个标记停止）时为 true，UI 显示「正在停止」 */
    stopRequested?: boolean;
    concurrency: number;
    runModel: string;
    verifyModel: string;
    /** 测试/验证模型的推理强度（'' 表示模型默认） */
    runModelEffort?: string;
    verifyModelEffort?: string;
    /** 单用例超时覆盖（秒），null 表示沿用用例自带设置 */
    runTimeoutSec?: number | null;
    verifyTimeoutSec?: number | null;
    /** 本次测评覆盖的 track id */
    tracks: string[];
    cases: CaseRunState[];
    summary: RunSummary;
}

/** 测评历史列表用的轻量摘要 */
export interface RunListItem {
    id: string;
    datasetId: string;
    datasetName: string;
    status: RunStatus;
    createdAt: number;
    startedAt: number | null;
    finishedAt: number | null;
    runModel: string;
    verifyModel: string;
    concurrency: number;
    summary: RunSummary;
}

export interface ModelOption {
    alias: string;
    model_name: string;
    provider_name: string;
    isDefault: boolean;
    /** 是否支持视觉输入 */
    vision: boolean;
    /** 模型设置里的默认推理强度（'' 表示模型默认） */
    defaultEffort: string;
    /** 该模型支持的推理强度取值（含 ''） */
    efforts: string[];
}

export class BenchmarkDataError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'BenchmarkDataError';
    }
}

function asString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function asPositiveNumber(value: unknown, fallback: number): number {
    const num = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
    return Number.isFinite(num) && num > 0 ? num : fallback;
}

/**
 * 解析并校验 dataset.json。
 * 兼容 tracks 为字符串数组或对象数组两种写法。
 */
export function parseDatasetManifest(raw: unknown): DatasetManifest {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new BenchmarkDataError(t('error.datasetManifestNotObject'));
    }
    const obj = raw as Record<string, unknown>;
    const name = asString(obj.name);
    if (!name) {
        throw new BenchmarkDataError(t('error.datasetNameMissing'));
    }
    if (!Array.isArray(obj.tracks) || obj.tracks.length === 0) {
        throw new BenchmarkDataError(t('error.datasetTracksInvalid'));
    }
    const tracks: DatasetTrackRef[] = [];
    for (const item of obj.tracks) {
        if (typeof item === 'string') {
            const trackName = item.trim();
            if (trackName) tracks.push({ name: trackName });
            continue;
        }
        if (item && typeof item === 'object') {
            const record = item as Record<string, unknown>;
            const trackName = asString(record.name) || asString(record.id);
            if (!trackName) continue;
            const id = asString(record.id);
            const description = asString(record.description);
            tracks.push({
                name: trackName,
                ...(id ? { id } : {}),
                ...(description ? { description } : {})
            });
            continue;
        }
        throw new BenchmarkDataError(t('error.datasetTrackItemInvalid'));
    }
    if (tracks.length === 0) {
        throw new BenchmarkDataError(t('error.datasetTrackEmpty'));
    }
    return {
        name,
        description: asString(obj.description),
        homepage: asString(obj.homepage) || asString(obj.url) || asString(obj.website),
        version: asString(obj.version),
        tracks
    };
}

/** 解析 track.json（允许为空对象） */
export function parseTrackManifest(raw: unknown): TrackManifest {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return {};
    }
    const obj = raw as Record<string, unknown>;
    return {
        name: asString(obj.name) || undefined,
        description: asString(obj.description) || undefined
    };
}

/**
 * 把 case.json 规范化成 CaseSpec。
 *
 * @param caseId 用例目录名
 * @param raw case.json 内容
 * @param hasFile 判断某个相对路径文件是否存在
 */
export function resolveCaseSpec(caseId: string, raw: unknown, hasFile: (relativePath: string) => boolean): CaseSpec {
    const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};

    const name = asString(obj.name) || asString(obj.title) || caseId;
    const weight = asPositiveNumber(obj.score ?? obj.points ?? obj.weight, 1);

    const runPromptFile = asString(obj.runPrompt) || asString(obj.runInstruction) || 'run.md';
    const verifyPromptFile = asString(obj.verifyPrompt) || asString(obj.verifyInstruction) || 'verify.md';

    const declaredRunPrepare = asString(obj.runPrepare) || asString(obj.runScript);
    const declaredVerifyPrepare = asString(obj.verifyPrepare) || asString(obj.verifyScript);

    const runPrepareFile = declaredRunPrepare
        ? declaredRunPrepare
        : hasFile('run-prepare.sh')
          ? 'run-prepare.sh'
          : null;
    const verifyPrepareFile = declaredVerifyPrepare
        ? declaredVerifyPrepare
        : hasFile('verify-prepare.sh')
          ? 'verify-prepare.sh'
          : null;

    if (runPrepareFile && !hasFile(runPrepareFile)) {
        throw new BenchmarkDataError(t('error.caseRunPrepareMissing', { case: caseId, file: runPrepareFile }));
    }
    if (verifyPrepareFile && !hasFile(verifyPrepareFile)) {
        throw new BenchmarkDataError(t('error.caseVerifyPrepareMissing', { case: caseId, file: verifyPrepareFile }));
    }
    if (!hasFile(runPromptFile)) {
        throw new BenchmarkDataError(t('error.caseRunPromptMissing', { case: caseId, file: runPromptFile }));
    }
    if (!hasFile(verifyPromptFile)) {
        throw new BenchmarkDataError(t('error.caseVerifyPromptMissing', { case: caseId, file: verifyPromptFile }));
    }

    return {
        caseId,
        name,
        weight,
        runPromptFile,
        verifyPromptFile,
        runPrepareFile,
        verifyPrepareFile,
        runTimeoutSec: asPositiveNumber(obj.runTimeoutSec ?? obj.timeoutSec, 1800),
        prepareTimeoutSec: asPositiveNumber(obj.prepareTimeoutSec, 3600),
        verifyTimeoutSec: asPositiveNumber(obj.verifyTimeoutSec, 1800)
    };
}

/** 从验证模型输出中提取得分率，支持直接读 result.json 或从文本里兜底解析 */
export function parseJudgeScore(input: unknown): { ratio: number; reason: string } | null {
    const candidates: unknown[] = [];
    if (typeof input === 'string') {
        const text = input.trim();
        if (text) {
            const fenced = /```(?:json)?\s*([\s\S]*?)```/gi;
            let match: RegExpExecArray | null;
            while ((match = fenced.exec(text)) !== null) {
                candidates.push(match[1]);
            }
            candidates.push(text);
            const start = text.indexOf('{');
            const end = text.lastIndexOf('}');
            if (start >= 0 && end > start) {
                candidates.push(text.slice(start, end + 1));
            }
        }
    } else if (input && typeof input === 'object') {
        candidates.push(input);
    }

    for (const candidate of candidates) {
        const parsed = typeof candidate === 'string' ? tryParseJson(candidate) : candidate;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
        const obj = parsed as Record<string, unknown>;
        const rawScore = obj.score ?? obj.ratio ?? obj.result;
        const num = typeof rawScore === 'string' ? Number(rawScore) : typeof rawScore === 'number' ? rawScore : NaN;
        if (!Number.isFinite(num)) continue;
        // 兼容 0~1 与 0~100 两种口径
        const ratio = num > 1 ? Math.min(1, num / 100) : Math.max(0, num);
        return { ratio, reason: asString(obj.reason) || asString(obj.notes) || asString(obj.message) };
    }
    return null;
}

function tryParseJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

/**
 * 汇总整轮测评的最终状态。
 *
 * 用户手动停止优先；其次只有「本轮所有用例都跑完且全部失败」才算整轮失败，
 * 其余情况（有成功的、有被跳过的）都按完成处理。
 */
export function resolveRunStatus(
    caseStatuses: readonly CaseRunStatus[],
    stopped: boolean,
    plannedCount: number
): RunStatus {
    if (stopped) return 'stopped';
    const allPlannedFinished = plannedCount > 0 && caseStatuses.length === plannedCount;
    if (allPlannedFinished && caseStatuses.every((status) => status === 'failed')) return 'failed';
    return 'completed';
}

/** 汇总一次测评的进度与得分 */
export function summarizeCases(cases: readonly CaseRunState[]): RunSummary {
    let pending = 0;
    let running = 0;
    let completed = 0;
    let failed = 0;
    let stopped = 0;
    let totalScore = 0;
    let maxScore = 0;
    let ratioSum = 0;
    let ratioCount = 0;
    let durationSum = 0;
    let durationCount = 0;

    for (const item of cases) {
        maxScore += item.weight;
        switch (item.status) {
            case 'pending':
                pending += 1;
                break;
            case 'preparing':
            case 'running':
            case 'verifying':
                running += 1;
                break;
            case 'done':
                completed += 1;
                break;
            case 'stopped':
                stopped += 1;
                break;
            default:
                failed += 1;
                break;
        }
        if (item.status === 'done' && item.score !== null) {
            totalScore += item.score;
        }
        if ((item.status === 'done' || item.status === 'failed') && item.ratio !== null) {
            ratioSum += item.ratio;
            ratioCount += 1;
        }
        if (item.startedAt && item.finishedAt && item.finishedAt > item.startedAt) {
            durationSum += item.finishedAt - item.startedAt;
            durationCount += 1;
        }
    }

    return {
        total: cases.length,
        pending,
        running,
        completed,
        failed,
        stopped,
        totalScore: round4(totalScore),
        maxScore: round4(maxScore),
        avgRatio: ratioCount > 0 ? round4(ratioSum / ratioCount) : 0,
        avgDurationMs: durationCount > 0 ? Math.round(durationSum / durationCount) : 0
    };
}

function round4(value: number): number {
    return Math.round(value * 10000) / 10000;
}

/** 生成可用于目录名的 slug（保留中文，替换空白与路径分隔符） */
export function slugify(input: string): string {
    const cleaned = input
        .normalize('NFKC')
        .replaceAll(/[/\\:*?"<>|\s]+/g, '-')
        .replaceAll(/^-+|-+$/g, '')
        .slice(0, 60);
    return cleaned || 'dataset';
}

/** 把 track/case 标识转成安全的目录名 */
export function toSafeDirName(input: string): string {
    return input.replaceAll(/[/\\:*?"<>|\s]+/g, '_').replace(/^\.+/, '_') || 'case';
}

/**
 * 给验证任务指令追加统一的「评分结果输出」契约。
 * 缺少这段契约时验证模型不知道把分数写到哪里。
 */
export function buildVerifyPrompt(verifyInstruction: string, resultFile: string): string {
    return [
        verifyInstruction.trim(),
        '',
        '## 评分结果输出（由测评系统注入，必须遵守）',
        `1. 验证完成后，把最终评分写入文件：\`${resultFile}\``,
        '2. 文件内容为单个 JSON 对象，形如：`{"score": 0.85, "reason": "简要说明"}`',
        '3. `score` 为 0 到 1 之间的小数（0 表示完全未通过，1 表示完全通过），`reason` 用一句话说明主要依据',
        '4. 只写这一个文件即可，不要修改工作区的其它内容'
    ].join('\n');
}
