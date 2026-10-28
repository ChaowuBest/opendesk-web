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

import { app, ipcMain, session } from 'electron';
import type { BrowserWindow, WebPreferences, WebContents } from 'electron';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createTrustedRendererUrlMatcher } from '@bitclub.ai/opendesk-office/host-security';
import { presentationRevisionFromBytes } from '@bitclub.ai/opendesk-office/presentation-automation';
import { OfficeTaskSessionRegistry, type OfficeTaskSessionKind } from './officeTaskSessions.js';
import { t } from '../../locale/index.js';
import { safeSendToWebContents } from '../utils/electron-ipc.js';
import {
    PresentationProgramRepository,
    type PresentationProgramRecordContext
} from '../applications/slides/programRepository.js';
import type { PresentationProgramExecution, PresentationProgramInput } from '../applications/slides/provider.js';
import {
    runPresentationProgramWithDeadline,
    type PresentationProgramStageEvent,
    type PresentationProgramTimeoutOutcome
} from './presentationProgramExecution.js';
import { reviewPresentationContent, type PresentationContentReview } from './presentationContentReview.js';
import { isOpenDeskOfficePartition, OPENDESK_OFFICE_PARTITION } from '../../common/officeWebview.js';

export type OpenDeskOfficeEditorKind = OfficeTaskSessionKind;

const require = createRequire(import.meta.url);

interface OpenDeskOfficeHost {
    register(): void;
    attachWindow(window: BrowserWindow): void;
    activateContents(contents: WebContents): void;
    runPresentationProgram?(
        contents: WebContents,
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
    requestCloseAll(): Promise<boolean>;
    getPresentationSnapshot?(contents: WebContents): Promise<{
        bytes: Uint8Array;
        revision: string;
        path: string;
    }>;
}

interface PresentationProgramExecutionControl {
    signal?: AbortSignal;
    onProgress?: (event: { stage: string; at: string }) => void;
}

interface OfficePresentationProgramResult {
    apiVersion: string;
    ok: boolean;
    bytes?: Uint8Array;
    value?: unknown;
    revision?: { before?: string; after?: string; current?: string; expected?: string };
    diff?: unknown;
    validation?: unknown;
    contentReview?: PresentationContentReview;
    error?: unknown;
}

interface OfficeEditorDefinition {
    kind: OpenDeskOfficeEditorKind;
    extension: string;
    rendererPageName: string;
    preloadName: string;
    requestCloseChannel: string;
    createHost(options: {
        preloadPath: string;
        rendererFilePath: string;
        rendererDevUrl?: string;
        requestCloseChannel: string;
        ironCalcWasmPath?: string;
    }): Promise<OpenDeskOfficeHost>;
}

interface OfficeEditorRuntime extends OfficeEditorDefinition {
    preloadPath: string;
    rendererFilePath: string;
    rendererDevUrl?: string;
    isTrustedUrl(url: string): boolean;
    hostPromise?: Promise<OpenDeskOfficeHost>;
}

function getRendererDevUrl(rendererPageName: string): string | undefined {
    const rendererUrl = process.env['ELECTRON_RENDERER_URL'];
    if (!rendererUrl) return undefined;
    return new URL(rendererPageName, rendererUrl.endsWith('/') ? rendererUrl : `${rendererUrl}/`).toString();
}

function getIronCalcWasmPath(): string {
    const stagedPath = path.join(__dirname, 'assets', 'opendesk-office-ironcalc.wasm');
    if (existsSync(stagedPath)) return stagedPath;
    return require.resolve('@bitclub.ai/opendesk-office/ironcalc-wasm');
}

const editorDefinitions: readonly OfficeEditorDefinition[] = [
    {
        kind: 'slides',
        extension: '.pptx',
        rendererPageName: 'slides_editor.html',
        preloadName: 'slidesPreload.js',
        requestCloseChannel: 'office-host:slides:request-close',
        async createHost(options) {
            const { createOpenDeskOfficeSlidesHost } = await import('@bitclub.ai/opendesk-office/main');
            return createOpenDeskOfficeSlidesHost(options);
        }
    },
    {
        kind: 'word',
        extension: '.docx',
        rendererPageName: 'word_editor.html',
        preloadName: 'wordPreload.js',
        requestCloseChannel: 'office-host:word:request-close',
        async createHost(options) {
            const { createOpenDeskOfficeWordHost } = await import('@bitclub.ai/opendesk-office/word-main');
            return createOpenDeskOfficeWordHost(options);
        }
    },
    {
        kind: 'sheets',
        extension: '.xlsx',
        rendererPageName: 'sheets_editor.html',
        preloadName: 'sheetsPreload.js',
        requestCloseChannel: 'office-host:sheets:request-close',
        async createHost(options) {
            const { createOpenDeskOfficeSheetsHost } = await import('@bitclub.ai/opendesk-office/sheets-main');
            return createOpenDeskOfficeSheetsHost(options);
        }
    }
];

const editorRuntimes: readonly OfficeEditorRuntime[] = editorDefinitions.map((definition) => {
    const preloadPath = path.join(__dirname, '..', 'preload', definition.preloadName);
    const rendererFilePath = path.join(__dirname, '..', 'renderer', definition.rendererPageName);
    const rendererDevUrl = getRendererDevUrl(definition.rendererPageName);
    const matchesTrustedUrl = createTrustedRendererUrlMatcher({ rendererFilePath, rendererDevUrl });
    return {
        ...definition,
        preloadPath,
        rendererFilePath,
        rendererDevUrl,
        isTrustedUrl: (url: string) => url.trim().length > 0 && matchesTrustedUrl(url)
    };
});

let attachedWindow: BrowserWindow | undefined;
let prepareHandlerRegistered = false;
const officeTaskSessions = new OfficeTaskSessionRegistry<WebContents>();
const OPEN_OFFICE_TASK_FILE_CHANNEL = 'office-host:open-task-file';
const OPEN_OFFICE_TASK_FILE_RESULT_CHANNEL = 'office-host:open-task-file-result';
const OPEN_OFFICE_TASK_TIMEOUT_MS = 30_000;
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
type OfficeTaskFileRendererResult = 'not_opened' | 'failed';

export interface OfficeTaskFileOpenResult {
    status: 'opened' | 'not_opened';
    filePath: string;
    message?: string;
}

const pendingOfficeTaskFileResults = new Map<string, (status: OfficeTaskFileRendererResult) => void>();
let presentationProgramRepository: PresentationProgramRepository | undefined;

function getPresentationProgramRepository(): PresentationProgramRepository {
    presentationProgramRepository ??= new PresentationProgramRepository(
        path.join(app.getPath('userData'), 'presentation-automation')
    );
    return presentationProgramRepository;
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
        ...(result.contentReview ? { contentReview: result.contentReview } : {}),
        acceptance: {
            passed:
                result.ok &&
                (result.validation as { summary?: { qualityPassed?: boolean } } | undefined)?.summary?.qualityPassed ===
                    true &&
                result.contentReview?.passed === true,
            structuralPassed:
                (result.validation as { summary?: { qualityPassed?: boolean } } | undefined)?.summary?.qualityPassed ===
                true,
            contentPassed: result.contentReview?.passed === true
        },
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

function getEditorRuntime(kind: OpenDeskOfficeEditorKind): OfficeEditorRuntime {
    const runtime = editorRuntimes.find((candidate) => candidate.kind === kind);
    if (!runtime) throw new Error(`Unsupported OpenDesk Office editor: ${kind}`);
    return runtime;
}

async function loadEditorHost(runtime: OfficeEditorRuntime): Promise<OpenDeskOfficeHost> {
    if (runtime.hostPromise) return runtime.hostPromise;

    runtime.hostPromise = runtime
        .createHost({
            preloadPath: runtime.preloadPath,
            rendererDevUrl: runtime.rendererDevUrl,
            rendererFilePath: runtime.rendererFilePath,
            requestCloseChannel: runtime.requestCloseChannel,
            ...(runtime.kind === 'sheets' ? { ironCalcWasmPath: getIronCalcWasmPath() } : {})
        })
        .then((host) => {
            host.register();
            if (attachedWindow && !attachedWindow.isDestroyed()) host.attachWindow(attachedWindow);
            return host;
        })
        .catch((error: unknown) => {
            runtime.hostPromise = undefined;
            throw error;
        });
    return runtime.hostPromise;
}

export function getOpenDeskOfficeEditorKind(url: string): OpenDeskOfficeEditorKind | undefined {
    return editorRuntimes.find(({ isTrustedUrl }) => isTrustedUrl(url))?.kind;
}

export function getEmbeddedOpenDeskOfficeEditorKind(
    url: string,
    partition: string | undefined
): OpenDeskOfficeEditorKind | undefined {
    if (!isOpenDeskOfficePartition(partition)) return undefined;
    return getOpenDeskOfficeEditorKind(url);
}

export function isEmbeddedOpenDeskOfficeContents(contents: WebContents): boolean {
    return contents.session === session.fromPartition(OPENDESK_OFFICE_PARTITION);
}

export function getEmbeddedOpenDeskOfficeContentsKind(contents: WebContents): OpenDeskOfficeEditorKind | undefined {
    if (!isEmbeddedOpenDeskOfficeContents(contents)) return undefined;
    return getOpenDeskOfficeEditorKind(contents.getURL());
}

export function configureOpenDeskOfficeWebPreferences(
    kind: OpenDeskOfficeEditorKind,
    webPreferences: WebPreferences
): void {
    const runtime = getEditorRuntime(kind);
    webPreferences.preload = runtime.preloadPath;
    webPreferences.contextIsolation = true;
    webPreferences.nodeIntegration = false;
    webPreferences.sandbox = true;
    webPreferences.backgroundThrottling = false;
    webPreferences.session = session.fromPartition(OPENDESK_OFFICE_PARTITION);
}

export function registerEmbeddedOpenDeskOffice(): void {
    if (prepareHandlerRegistered) return;
    prepareHandlerRegistered = true;
    ipcMain.handle('office-host:prepare', async (_event, kind: OpenDeskOfficeEditorKind) => {
        await loadEditorHost(getEditorRuntime(kind));
        return true;
    });
    ipcMain.handle(
        'office-host:bind-task',
        async (event, kind: OpenDeskOfficeEditorKind, taskId: string, filePath: string, webContentsId: number) => {
            if (!taskId || !filePath || !Number.isInteger(webContentsId)) return false;
            const target = (await import('electron')).webContents.fromId(webContentsId);
            if (!target || target.isDestroyed() || target.getType() !== 'webview') return false;
            if (target.hostWebContents?.id !== event.sender.id) return false;
            const runtime = getEditorRuntime(kind);
            if (!isEmbeddedOpenDeskOfficeContents(target)) return false;
            if (!runtime.isTrustedUrl(target.getURL())) return false;
            const host = await loadEditorHost(runtime);
            host.activateContents(target);
            officeTaskSessions.bind(kind, taskId, filePath, target);
            return true;
        }
    );
    ipcMain.on(
        OPEN_OFFICE_TASK_FILE_RESULT_CHANNEL,
        (event, result: { requestId?: unknown; status?: unknown } | undefined) => {
            if (!attachedWindow || attachedWindow.isDestroyed()) return;
            if (event.sender.id !== attachedWindow.webContents.id) return;
            if (!result || typeof result.requestId !== 'string') return;
            if (result.status !== 'not_opened' && result.status !== 'failed') return;
            pendingOfficeTaskFileResults.get(result.requestId)?.(result.status);
        }
    );
}

export async function openOpenDeskOfficeTaskFile(
    kind: OpenDeskOfficeEditorKind,
    taskId: string,
    filePath: string
): Promise<OfficeTaskFileOpenResult> {
    const runtime = getEditorRuntime(kind);
    const resolvedPath = path.resolve(filePath);
    if (path.extname(resolvedPath).toLowerCase() !== runtime.extension) {
        throw new Error(t('office.error.unsupportedFile'));
    }

    let isFile = false;
    try {
        isFile = existsSync(resolvedPath) && statSync(resolvedPath).isFile();
    } catch {
        isFile = false;
    }
    if (!isFile) throw new Error(t('office.error.fileNotFound'));

    const current = officeTaskSessions.get(kind, taskId);
    if (current && path.resolve(current.filePath) === resolvedPath) {
        return { status: 'opened', filePath: resolvedPath };
    }
    if (!attachedWindow || attachedWindow.isDestroyed()) {
        throw new Error(t('office.error.windowUnavailable'));
    }
    const requestId = randomUUID();
    const waitController = new AbortController();
    const waitSignal = AbortSignal.any([waitController.signal, AbortSignal.timeout(OPEN_OFFICE_TASK_TIMEOUT_MS)]);
    const rendererResult = new Promise<OfficeTaskFileRendererResult>((resolve) => {
        pendingOfficeTaskFileResults.set(requestId, resolve);
    });

    try {
        if (
            !safeSendToWebContents(attachedWindow.webContents, OPEN_OFFICE_TASK_FILE_CHANNEL, {
                requestId,
                kind,
                taskId,
                filePath: resolvedPath
            })
        ) {
            throw new Error(t('office.error.windowUnavailable'));
        }

        const outcome = await Promise.race([
            officeTaskSessions
                .waitFor(kind, taskId, resolvedPath, waitSignal)
                .then((session) => ({ type: 'session' as const, session })),
            rendererResult.then((status) => ({ type: 'renderer' as const, status }))
        ]);
        if (outcome.type === 'renderer') {
            if (outcome.status === 'not_opened') {
                return {
                    status: 'not_opened',
                    filePath: resolvedPath,
                    message: t('office.open.notCompleted')
                };
            }
            throw new Error(t('office.error.routeUnavailable'));
        }
        if (!outcome.session) throw new Error(t('office.error.openTimeout'));
        return { status: 'opened', filePath: resolvedPath };
    } finally {
        waitController.abort();
        pendingOfficeTaskFileResults.delete(requestId);
    }
}

export async function openOpenDeskSlidesPresentation(
    taskId: string,
    filePath: string
): Promise<OfficeTaskFileOpenResult> {
    return await openOpenDeskOfficeTaskFile('slides', taskId, filePath);
}

export async function isOpenDeskPresentationProgramAvailable(): Promise<boolean> {
    const host = await loadEditorHost(getEditorRuntime('slides'));
    return Boolean(host.runPresentationProgram && host.runHeadlessPresentationProgram && host.getPresentationSnapshot);
}

export async function runOpenDeskPresentationProgram(
    taskId: string,
    input: PresentationProgramInput
): Promise<PresentationProgramExecution> {
    const program = loadPresentationProgramSource(input);
    const expectedRevision = normalizePresentationRevision(input.expectedRevision);
    const session = officeTaskSessions.get('slides', taskId);
    const repository = getPresentationProgramRepository();
    const sourcePath = repository.getSourcePath(taskId, input.workspace);
    const requestedOutputPath = input.outputPath ? path.resolve(input.outputPath) : undefined;
    const projectOutputPath = repository.getOutputPath(taskId);
    const automaticOutputPath =
        !session && !requestedOutputPath
            ? (projectOutputPath ?? defaultPresentationOutputPath(input.workspace, input.suggestedName))
            : undefined;
    const resolvedOutputPath = requestedOutputPath ?? automaticOutputPath;
    const useLiveSession = !!session && (!resolvedOutputPath || resolvedOutputPath === path.resolve(session.filePath));

    const outputPath = resolvedOutputPath ?? session?.filePath;
    if (outputPath && path.extname(outputPath).toLowerCase() !== '.pptx') {
        throw new Error(t('office.slides.error.invalidOutputPath'));
    }

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
    const recoveredAssets = input.programPath ? repository.getAssetPaths(taskId, input.programPath) : {};
    const { officeAssets, recordAssets } = loadPresentationAssets({ ...recoveredAssets, ...input.assets });
    const expectedSlideCount =
        input.expectedSlideCount ??
        (input.programPath ? repository.getExpectedSlideCount(taskId, input.programPath) : undefined);
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
    const reviewResult = async (
        result: OfficePresentationProgramResult,
        bytes?: Uint8Array
    ): Promise<OfficePresentationProgramResult> => {
        if (!result.ok) return result;
        try {
            if (bytes) {
                const contentReview = await reviewPresentationContent(bytes, expectedSlideCount);
                if (effectiveStartFrom === 'blank' && expectedSlideCount === undefined) {
                    contentReview.passed = false;
                    contentReview.findings.push({ code: 'EXPECTED_SLIDE_COUNT_REQUIRED' });
                }
                return { ...result, contentReview };
            }
        } catch (error) {
            console.warn('Presentation content review failed', error);
        }
        // The write may already be committed. Preserve execution status while withholding acceptance.
        return {
            ...result,
            contentReview: {
                passed: false,
                complete: false,
                expectedSlideCount,
                slides: [],
                findings: [{ code: 'CONTENT_REVIEW_UNAVAILABLE' }]
            }
        };
    };

    if (useLiveSession && session) {
        const host = await loadEditorHost(getEditorRuntime('slides'));
        if (!host.runPresentationProgram || !host.getPresentationSnapshot) {
            throw new Error(t('office.slides.error.programUnavailable'));
        }
        const snapshot = await host.getPresentationSnapshot(session.contents);
        const outputPath = path.resolve(requestedOutputPath ?? session.filePath);
        const recorded = await repository.recordRun(
            {
                taskId,
                outputPath,
                program,
                sourcePath,
                startFrom: effectiveStartFrom,
                expectedRevision,
                beforeBytes: snapshot.bytes,
                expectedSlideCount,
                assets: recordAssets
            },
            async (context) => {
                const conflict = checkGeneratorRevision(outputPath, snapshot.revision);
                if (conflict) return conflict;
                const outcome = await runPresentationProgramWithDeadline(
                    async ({ signal, reportStage }) =>
                        await host.runPresentationProgram!(
                            session.contents,
                            {
                                ...effectiveInput,
                                outputPath,
                                expectedRevision: expectedRevision ?? snapshot.revision,
                                assets: officeAssets
                            },
                            {
                                signal,
                                onProgress: (event) => reportStage(event.stage)
                            }
                        ),
                    {
                        operationId: `${taskId}:${context.programId}`,
                        timeoutMs: presentationProgramTimeoutMs(),
                        onStage: (event) => context.reportStage(event.stage),
                        log: logPresentationProgramStage
                    }
                );
                if (outcome.ok === false) return presentationProgramTimeoutResult(outcome, snapshot.revision);
                const result = outcome.value;
                let outputBytes = result.bytes;
                if (result.ok && !outputBytes) {
                    try {
                        outputBytes = (await host.getPresentationSnapshot!(session.contents)).bytes;
                    } catch (error) {
                        console.warn('Presentation output snapshot unavailable', error);
                    }
                }
                return await reviewResult(result, outputBytes);
            }
        );
        return publicProgramExecution(
            recorded.result,
            recorded.context,
            effectiveInput,
            outputPath,
            recorded.result.ok && presentationDiffHasChanges(recorded.result.diff)
        );
    }

    if (!resolvedOutputPath) throw new Error(t('office.slides.error.outputPathRequired'));
    const outputExisted = existsSync(resolvedOutputPath);
    const beforeBytes = outputExisted ? new Uint8Array(readFileSync(resolvedOutputPath)) : undefined;
    if (effectiveStartFrom === 'current' && !beforeBytes) {
        throw new Error(t('office.slides.error.currentFileMissing'));
    }
    const revisionBefore = beforeBytes ? await presentationRevisionFromBytes(beforeBytes) : undefined;
    const recorded = await repository.recordRun(
        {
            taskId,
            outputPath: resolvedOutputPath,
            program,
            sourcePath,
            startFrom: effectiveStartFrom,
            expectedRevision,
            ...(beforeBytes ? { beforeBytes } : {}),
            expectedSlideCount,
            assets: recordAssets
        },
        async (context) => {
            const conflict = checkGeneratorRevision(resolvedOutputPath, revisionBefore);
            if (conflict) return conflict;
            const host = await loadEditorHost(getEditorRuntime('slides'));
            if (!host.runHeadlessPresentationProgram) {
                throw new Error(t('office.slides.error.programUnavailable'));
            }
            const outcome = await runPresentationProgramWithDeadline(
                async ({ signal, reportStage }): Promise<OfficePresentationProgramResult> => {
                    const result = await host.runHeadlessPresentationProgram!(
                        {
                            program,
                            startFrom: effectiveStartFrom,
                            ...(beforeBytes && effectiveStartFrom === 'current' ? { currentBytes: beforeBytes } : {}),
                            ...(revisionBefore ? { currentRevision: revisionBefore } : {}),
                            ...(expectedRevision ? { expectedRevision } : {}),
                            assets: officeAssets
                        },
                        {
                            signal,
                            onProgress: (event) => reportStage(event.stage)
                        }
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

                    const stillExists = existsSync(resolvedOutputPath);
                    const currentRevision = stillExists
                        ? await presentationRevisionFromBytes(new Uint8Array(readFileSync(resolvedOutputPath)))
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
                    atomicWritePresentation(resolvedOutputPath, result.bytes);
                    return result;
                },
                {
                    operationId: `${taskId}:${context.programId}`,
                    timeoutMs: presentationProgramTimeoutMs(),
                    onStage: (event) => context.reportStage(event.stage),
                    log: logPresentationProgramStage
                }
            );
            if (outcome.ok === false) return presentationProgramTimeoutResult(outcome, revisionBefore);
            const result = outcome.value;
            if (!result.ok || !result.bytes) return result;
            return await reviewResult(result, result.bytes);
        }
    );
    const committed = recorded.result.ok && presentationDiffHasChanges(recorded.result.diff);
    const execution = publicProgramExecution(
        recorded.result,
        recorded.context,
        effectiveInput,
        resolvedOutputPath,
        committed
    );
    if (!committed || !automaticOutputPath) return execution;
    try {
        execution.open = await openOpenDeskOfficeTaskFile('slides', taskId, resolvedOutputPath);
    } catch (error) {
        execution.open = {
            status: 'not_opened',
            filePath: resolvedOutputPath,
            message: error instanceof Error ? error.message : String(error)
        };
    }
    return execution;
}

export function attachOpenDeskOfficeWindow(window: BrowserWindow): void {
    attachedWindow = window;
    for (const runtime of editorRuntimes) {
        if (runtime.hostPromise) void runtime.hostPromise.then((host) => host.attachWindow(window));
    }
}

export function activateOpenDeskOfficeContents(kind: OpenDeskOfficeEditorKind, contents: WebContents): void {
    const runtime = getEditorRuntime(kind);
    if (runtime.hostPromise) void runtime.hostPromise.then((host) => host.activateContents(contents));
}

export async function requestCloseOpenDeskOfficeContents(): Promise<boolean> {
    const loadedHosts = editorRuntimes.flatMap((runtime) => (runtime.hostPromise ? [runtime.hostPromise] : []));
    const results = await Promise.all(loadedHosts.map(async (hostPromise) => (await hostPromise).requestCloseAll()));
    return results.every(Boolean);
}
