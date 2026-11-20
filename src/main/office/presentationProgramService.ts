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

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { presentationRevisionFromBytes } from '@bitclub.ai/opendesk-office/presentation-automation';
import type {
    PresentationProgramRecordContext,
    PresentationProgramRepository
} from '../applications/slides/programRepository.js';
import type {
    PresentationProgramExecution,
    PresentationProgramInput,
    SlidesPresentationOpenResult
} from '../applications/slides/provider.js';
import { t as defaultTranslator } from '../../locale/index.js';
import {
    runPresentationProgramWithDeadline,
    type PresentationProgramStageEvent,
    type PresentationProgramTimeoutOutcome
} from './presentationProgramExecution.js';

export interface PresentationProgramHost<C> {
    runPresentationProgram?(
        contents: C,
        request: Omit<PresentationProgramInput, 'assets'> & {
            assets?: Record<string, { bytes: Uint8Array; ext: string }>;
        },
        control?: PresentationProgramExecutionControl
    ): Promise<OfficePresentationProgramResult>;
    runHeadlessPresentationProgram?(
        request: {
            program: string;
            startFrom: 'current' | 'blank';
            currentBytes?: Uint8Array;
            currentRevision?: string;
            expectedRevision?: string;
            assets?: Record<string, { bytes: Uint8Array; ext: string }>;
        },
        control?: PresentationProgramExecutionControl
    ): Promise<OfficePresentationProgramResult>;
    getPresentationSnapshot?(contents: C): Promise<{
        bytes: Uint8Array;
        revision: string;
        path: string;
    }>;
}

export interface PresentationProgramExecutionControl {
    signal?: AbortSignal;
    onProgress?: (event: { stage: string; at: string }) => void;
}

export interface OfficePresentationProgramResult {
    apiVersion: string;
    ok: boolean;
    bytes?: Uint8Array;
    value?: unknown;
    revision?: { before?: string; after?: string; current?: string; expected?: string };
    diff?: unknown;
    validation?: unknown;
    error?: unknown;
}

const DEFAULT_PRESENTATION_PROGRAM_TIMEOUT_MS = 180_000;
const MIN_PRESENTATION_PROGRAM_TIMEOUT_MS = 30_000;
const MAX_PRESENTATION_PROGRAM_TIMEOUT_MS = 30 * 60_000;

function presentationProgramTimeoutMs(): number {
    const configured = Number(process.env['OPENDESK_PRESENTATION_PROGRAM_TIMEOUT_MS']);
    if (!Number.isFinite(configured)) return DEFAULT_PRESENTATION_PROGRAM_TIMEOUT_MS;
    return Math.min(MAX_PRESENTATION_PROGRAM_TIMEOUT_MS, Math.max(MIN_PRESENTATION_PROGRAM_TIMEOUT_MS, configured));
}

function logPresentationProgramStage(event: PresentationProgramStageEvent): void {
    const message = JSON.stringify({ event: 'presentation-program-stage', ...event });
    if (event.stage === 'timed-out') console.warn(message);
    else console.info(message);
}

function presentationProgramTimeoutResult(
    outcome: PresentationProgramTimeoutOutcome,
    currentRevision?: string
): OfficePresentationProgramResult {
    return {
        apiVersion: 'presentation/v1',
        ok: false,
        error: outcome.error,
        revision: { current: currentRevision ?? 'presentation/v1:timeout' }
    };
}
const PRESENTATION_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'tif', 'tiff']);

function safePresentationName(value: string): string {
    const printableValue = [...value.normalize('NFKC')]
        .map((character) => (character.charCodeAt(0) < 32 ? ' ' : character))
        .join('');
    const normalized = printableValue
        .replace(/[<>:"/\\|?*]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[. ]+$/g, '');
    return (normalized || 'presentation').slice(0, 80);
}

function defaultPresentationOutputPath(workspace: string | undefined, suggestedName: string | undefined): string {
    const directory = path.resolve(workspace || process.cwd());
    const baseName = safePresentationName(suggestedName || 'presentation');
    const initial = path.join(directory, `${baseName}.pptx`);
    if (!existsSync(initial)) return initial;
    for (let suffix = 2; suffix < 10_000; suffix += 1) {
        const candidate = path.join(directory, `${baseName}-${suffix}.pptx`);
        if (!existsSync(candidate)) return candidate;
    }
    return path.join(directory, `${baseName}-${randomUUID()}.pptx`);
}

function loadPresentationAssets(assets: Record<string, string> | undefined): {
    officeAssets: Record<string, { bytes: Uint8Array; ext: string }>;
    recordAssets: Record<string, { sourcePath: string; bytes: Uint8Array; ext: string }>;
} {
    const officeAssets: Record<string, { bytes: Uint8Array; ext: string }> = {};
    const recordAssets: Record<string, { sourcePath: string; bytes: Uint8Array; ext: string }> = {};
    for (const [id, sourcePath] of Object.entries(assets ?? {})) {
        const ext = path.extname(sourcePath).slice(1).toLowerCase();
        if (!PRESENTATION_IMAGE_EXTENSIONS.has(ext)) {
            throw new Error(`Unsupported presentation image asset: ${sourcePath}`);
        }
        const bytes = new Uint8Array(readFileSync(sourcePath));
        officeAssets[id] = { bytes, ext };
        recordAssets[id] = { sourcePath, bytes, ext };
    }
    return { officeAssets, recordAssets };
}

function loadPresentationProgramSource(input: PresentationProgramInput): string {
    if (Boolean(input.program) === Boolean(input.programPath)) {
        throw new Error('Exactly one of program or programPath is required');
    }
    if (input.program) return input.program;
    const sourcePath = path.resolve(input.programPath!);
    let isFile = false;
    try {
        isFile = statSync(sourcePath).isFile();
    } catch {
        isFile = false;
    }
    if (!isFile) throw new Error(`Presentation generator source does not exist: ${sourcePath}`);
    const program = readFileSync(sourcePath, 'utf8');
    if (!program.trim()) throw new Error('Presentation generator source must not be empty');
    if (program.length > 200_000) throw new Error('Presentation generator source exceeds 200000 characters');
    return program;
}

function publicProgramExecution(
    result: OfficePresentationProgramResult,
    context: PresentationProgramRecordContext,
    input: PresentationProgramInput,
    outputPath: string,
    committed: boolean
): PresentationProgramExecution {
    return {
        apiVersion: result.apiVersion,
        ok: result.ok,
        committed,
        programId: context.programId,
        outputPath,
        provenance: {
            baselineAvailable: context.baselineAvailable,
            priorRunCount: context.priorRunCount,
            mode: input.startFrom === 'blank' ? 'generator' : 'incremental',
            sourcePath: context.sourcePath,
            sourceRevision: context.sourceRevision
        },
        ...(!result.ok &&
        input.startFrom === 'blank' &&
        (result.error as { code?: unknown } | undefined)?.code !== 'GENERATOR_OUTPUT_CHANGED'
            ? {
                  recovery: {
                      strategy: 'edit-generator-source' as const,
                      sourcePath: context.sourcePath,
                      sourceRevision: context.sourceRevision,
                      preserveCompleteProgram: true as const,
                      rerun: {
                          programPath: context.sourcePath,
                          startFrom: 'blank' as const
                      }
                  }
              }
            : {}),
        ...(result.revision ? { revision: result.revision } : {}),
        ...(result.diff ? { diff: result.diff } : {}),
        ...(result.validation ? { validation: result.validation } : {}),
        ...(result.value !== undefined ? { value: result.value } : {}),
        ...(result.error ? { error: result.error } : {})
    };
}

function atomicWritePresentation(outputPath: string, bytes: Uint8Array): void {
    mkdirSync(path.dirname(outputPath), { recursive: true });
    const temporaryPath = path.join(
        path.dirname(outputPath),
        `.${path.basename(outputPath)}.${randomUUID()}.opendesk-tmp`
    );
    try {
        writeFileSync(temporaryPath, bytes);
        renameSync(temporaryPath, outputPath);
    } finally {
        if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    }
}

function presentationDiffHasChanges(diff: unknown): boolean {
    if (!diff || typeof diff !== 'object') return true;
    const value = diff as {
        deckChanges?: unknown[];
        slidesAdded?: unknown[];
        slidesRemoved?: unknown[];
        slideChanges?: unknown[];
        elementChanges?: unknown[];
    };
    return [
        value.deckChanges ?? [],
        value.slidesAdded,
        value.slidesRemoved,
        value.slideChanges,
        value.elementChanges
    ].some((changes) => !Array.isArray(changes) || changes.length > 0);
}

const PRESENTATION_REVISION_DIGEST = /^(?:presentation\/v1:)?([0-9a-f]{64})$/i;

function normalizePresentationRevision(revision: string | undefined): string | undefined {
    const value = revision?.trim();
    if (!value) return undefined;
    const digest = PRESENTATION_REVISION_DIGEST.exec(value)?.[1];
    return digest ? `presentation/v1:${digest.toLowerCase()}` : value;
}

export interface PresentationProgramServiceOptions<C> {
    getRepository(): PresentationProgramRepository;
    getSession(taskId: string): { filePath: string; contents: C } | undefined;
    loadHost(): Promise<PresentationProgramHost<C>>;
    openPresentation(taskId: string, filePath: string): Promise<SlidesPresentationOpenResult>;
    translate?: typeof defaultTranslator;
    timeoutMs?: () => number;
    log?: (event: PresentationProgramStageEvent) => void;
}

/** Shared program workflow; hosts own editor identity, execution transport and file presentation. */
export class PresentationProgramService<C> {
    constructor(private readonly options: PresentationProgramServiceOptions<C>) {}

    async isAvailable(): Promise<boolean> {
        const host = await this.options.loadHost();
        return Boolean(
            host.runPresentationProgram && host.runHeadlessPresentationProgram && host.getPresentationSnapshot
        );
    }

    async execute(taskId: string, input: PresentationProgramInput): Promise<PresentationProgramExecution> {
        const t = this.options.translate ?? defaultTranslator;
        // session 关联当前任务打开的 PPT；其内存状态可能包含尚未保存到磁盘的修改。
        const program = loadPresentationProgramSource(input);
        const expectedRevision = normalizePresentationRevision(input.expectedRevision);
        const session = this.options.getSession(taskId);
        const repository = this.options.getRepository();
        const sourcePath = repository.getSourcePath(taskId, input.workspace);
        const requestedOutputPath = input.outputPath ? path.resolve(input.outputPath) : undefined;
        const projectOutputPath = repository.getOutputPath(taskId);
        // 显式输出路径优先；未指定路径时复用当前文稿或历史产物，避免后续修改生成另一份文件。
        const automaticOutputPath =
            !session && !requestedOutputPath
                ? (projectOutputPath ?? defaultPresentationOutputPath(input.workspace, input.suggestedName))
                : undefined;
        const resolvedOutputPath = requestedOutputPath ?? automaticOutputPath;
        // 当前编辑器仅用于操作其绑定文件；指定其他目标时使用后台执行。
        const useLiveSession =
            !!session && (!resolvedOutputPath || resolvedOutputPath === path.resolve(session.filePath));

        const outputPath = resolvedOutputPath ?? session?.filePath;
        if (outputPath && path.extname(outputPath).toLowerCase() !== '.pptx') {
            throw new Error(t('office.slides.error.invalidOutputPath'));
        }

        // auto 不允许隐式新建，防止目标缺失时用空白文稿替代原有内容。
        if (input.startFrom === 'auto' && !useLiveSession && (!resolvedOutputPath || !existsSync(resolvedOutputPath))) {
            throw new Error(t('office.slides.error.startRequired'));
        }
        const effectiveStartFrom: 'current' | 'blank' = input.startFrom === 'auto' ? 'current' : input.startFrom;
        const effectiveInput: PresentationProgramInput & { program: string } = {
            ...input,
            program,
            programPath: sourcePath,
            startFrom: effectiveStartFrom
        };
        if (expectedRevision) effectiveInput.expectedRevision = expectedRevision;
        else delete effectiveInput.expectedRevision;
        // 从脚本路径重跑时继承归档素材，调用方只需提供新增或替换的素材。
        const recoveredAssets = input.programPath ? repository.getAssetPaths(taskId, input.programPath) : {};
        const { officeAssets, recordAssets } = loadPresentationAssets({ ...recoveredAssets, ...input.assets });
        // blank 会重建整稿。当前内容偏离最近生成版本时拒绝重建，要求调用方基于 current 修改。
        const checkGeneratorRevision = (
            outputPath: string,
            currentRevision: string | undefined
        ): OfficePresentationProgramResult | undefined => {
            if (effectiveStartFrom !== 'blank') return undefined;
            const lastGeneratedRevision = repository.getLastGeneratedRevision(taskId, outputPath);
            if (!lastGeneratedRevision || currentRevision === lastGeneratedRevision) return undefined;
            return {
                apiVersion: 'presentation/v1',
                ok: false,
                error: {
                    code: 'GENERATOR_OUTPUT_CHANGED',
                    message: t('office.slides.error.generatorOutputChanged'),
                    details: {
                        outputPath,
                        lastGeneratedRevision,
                        currentRevision: currentRevision ?? 'presentation/v1:missing',
                        requiredStartFrom: 'current'
                    }
                },
                revision: { current: currentRevision ?? 'presentation/v1:missing', expected: lastGeneratedRevision }
            };
        };
        if (!outputPath) throw new Error(t('office.slides.error.outputPathRequired'));
        const targetOutputPath = path.resolve(outputPath);
        const liveSession = useLiveSession ? session : undefined;
        const liveHost = liveSession ? await this.options.loadHost() : undefined;
        if (liveSession && (!liveHost?.runPresentationProgram || !liveHost.getPresentationSnapshot)) {
            throw new Error(t('office.slides.error.programUnavailable'));
        }

        // 编辑器快照保留未保存内容，后台快照来自磁盘；备份内容与版本保护必须使用同一份输入。
        const snapshot = liveSession ? await liveHost!.getPresentationSnapshot!(liveSession.contents) : undefined;
        const outputExisted = !liveSession && existsSync(targetOutputPath);
        const beforeBytes =
            snapshot?.bytes ?? (outputExisted ? new Uint8Array(readFileSync(targetOutputPath)) : undefined);
        if (effectiveStartFrom === 'current' && !beforeBytes) {
            throw new Error(t('office.slides.error.currentFileMissing'));
        }
        const revisionBefore =
            snapshot?.revision ?? (beforeBytes ? await presentationRevisionFromBytes(beforeBytes) : undefined);

        // recordRun 在执行前归档输入，在执行后保存结果；失败和超时也保留可追溯记录。
        const recorded = await repository.recordRun(
            {
                taskId,
                outputPath: targetOutputPath,
                program,
                sourcePath,
                startFrom: effectiveStartFrom,
                expectedRevision,
                ...(beforeBytes ? { beforeBytes } : {}),
                assets: recordAssets
            },
            async (context) => {
                const conflict = checkGeneratorRevision(targetOutputPath, revisionBefore);
                if (conflict) return conflict;
                const host = liveHost ?? (await this.options.loadHost());
                if (!liveSession && !host.runHeadlessPresentationProgram) {
                    throw new Error(t('office.slides.error.programUnavailable'));
                }
                const outcome = await runPresentationProgramWithDeadline(
                    async ({ signal, reportStage }): Promise<OfficePresentationProgramResult> => {
                        const control: PresentationProgramExecutionControl = {
                            signal,
                            onProgress: (event) => reportStage(event.stage)
                        };
                        // 如右侧有直接编辑器窗口，由接口负责处理未保存修改并更新文稿状态，本层不额外写盘。
                        if (liveSession) {
                            return await host.runPresentationProgram!(
                                liveSession.contents,
                                {
                                    ...effectiveInput,
                                    outputPath: targetOutputPath,
                                    expectedRevision: expectedRevision ?? revisionBefore,
                                    assets: officeAssets
                                },
                                control
                            );
                        }

                        // 否则进入后台模式，引擎返回 PPT 二进制而不提交文件，磁盘版本校验和写入由本层负责。
                        const result = await host.runHeadlessPresentationProgram!(
                            {
                                program,
                                startFrom: effectiveStartFrom,
                                ...(beforeBytes && effectiveStartFrom === 'current'
                                    ? { currentBytes: beforeBytes }
                                    : {}),
                                ...(revisionBefore ? { currentRevision: revisionBefore } : {}),
                                ...(expectedRevision ? { expectedRevision } : {}),
                                assets: officeAssets
                            },
                            control
                        );
                        if (!result.ok || !result.bytes) return result;
                        reportStage('validating-output-revision');
                        if (signal.aborted) throw signal.reason;
                        if (!presentationDiffHasChanges(result.diff)) {
                            return {
                                ...result,
                                revision: {
                                    before: revisionBefore ?? result.revision?.before,
                                    after: revisionBefore ?? result.revision?.before
                                }
                            };
                        }

                        // expectedRevision 保护执行前版本；此处额外检查执行期间的外部修改，防止提交时覆盖。
                        const stillExists = existsSync(targetOutputPath);
                        const currentRevision = stillExists
                            ? await presentationRevisionFromBytes(new Uint8Array(readFileSync(targetOutputPath)))
                            : undefined;
                        if (stillExists !== outputExisted || currentRevision !== revisionBefore) {
                            return {
                                apiVersion: result.apiVersion,
                                ok: false,
                                error: {
                                    code: 'REVISION_CONFLICT',
                                    message: 'The presentation changed before the program could be committed'
                                },
                                revision: {
                                    current: currentRevision ?? 'presentation/v1:missing',
                                    expected: revisionBefore ?? 'presentation/v1:missing'
                                }
                            };
                        }
                        if (signal.aborted) throw signal.reason;
                        reportStage('committing-output');
                        atomicWritePresentation(targetOutputPath, result.bytes);
                        return result;
                    },
                    {
                        operationId: `${taskId}:${context.programId}`,
                        timeoutMs: this.options.timeoutMs?.() ?? presentationProgramTimeoutMs(),
                        onStage: (event) => context.reportStage(event.stage),
                        log: this.options.log ?? logPresentationProgramStage
                    }
                );
                if (outcome.ok === false) return presentationProgramTimeoutResult(outcome, revisionBefore);
                return outcome.value;
            }
        );
        const committed = recorded.result.ok && presentationDiffHasChanges(recorded.result.diff);
        const execution = publicProgramExecution(
            recorded.result,
            recorded.context,
            effectiveInput,
            targetOutputPath,
            committed
        );
        // 已有编辑器无需重新打开；仅自动选定的后台输出在提交后尝试打开，打开失败单独返回。
        if (!committed || !automaticOutputPath) return execution;
        try {
            execution.open = await this.options.openPresentation(taskId, targetOutputPath);
        } catch (error) {
            execution.open = {
                status: 'not_opened',
                filePath: targetOutputPath,
                message: error instanceof Error ? error.message : String(error)
            };
        }
        return execution;
    }
}
