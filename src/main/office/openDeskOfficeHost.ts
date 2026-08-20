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

import { ipcMain } from 'electron';
import type { BrowserWindow, WebPreferences, WebContents } from 'electron';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createTrustedRendererUrlMatcher } from '@bitclub.ai/opendesk-office/host-security';
import { OfficeTaskSessionRegistry, type OfficeTaskSessionKind } from './officeTaskSessions.js';
import { t } from '../../locale/index.js';
import { safeSendToWebContents } from '../utils/electron-ipc.js';

export type OpenDeskOfficeEditorKind = OfficeTaskSessionKind;

const require = createRequire(import.meta.url);

interface OpenDeskOfficeHost {
    register(): void;
    attachWindow(window: BrowserWindow): void;
    activateContents(contents: WebContents): void;
    getCapabilities?(): readonly SlidesCapabilityDefinition[];
    executeCapability?(
        contents: WebContents,
        call: { name: string; input: Record<string, unknown> }
    ): Promise<SlidesCapabilityExecution>;
    requestCloseAll(): Promise<boolean>;
}

export interface SlidesCapabilityDefinition {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}

export interface SlidesCapabilityExecution {
    output: string;
    isError?: boolean;
    mutated?: boolean;
    summary: string;
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
    return {
        ...definition,
        preloadPath,
        rendererFilePath,
        rendererDevUrl,
        isTrustedUrl: createTrustedRendererUrlMatcher({ rendererFilePath, rendererDevUrl })
    };
});

let attachedWindow: BrowserWindow | undefined;
let prepareHandlerRegistered = false;
const officeTaskSessions = new OfficeTaskSessionRegistry<WebContents>();
const OPEN_OFFICE_TASK_FILE_CHANNEL = 'office-host:open-task-file';
const OPEN_OFFICE_TASK_FILE_RESULT_CHANNEL = 'office-host:open-task-file-result';
const OPEN_OFFICE_TASK_TIMEOUT_MS = 30_000;
type OfficeTaskFileRendererResult = 'not_opened' | 'failed';

export interface OfficeTaskFileOpenResult {
    status: 'opened' | 'not_opened';
    filePath: string;
    message?: string;
}

const pendingOfficeTaskFileResults = new Map<string, (status: OfficeTaskFileRendererResult) => void>();

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
        async (
            event,
            kind: OpenDeskOfficeEditorKind,
            taskId: string,
            filePath: string,
            webContentsId: number
        ) => {
            if (!taskId || !filePath || !Number.isInteger(webContentsId)) return false;
            const target = (await import('electron')).webContents.fromId(webContentsId);
            if (!target || target.isDestroyed() || target.getType() !== 'webview') return false;
            if (target.hostWebContents?.id !== event.sender.id) return false;
            const runtime = getEditorRuntime(kind);
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

export async function getOpenDeskSlidesCapabilities(): Promise<readonly SlidesCapabilityDefinition[]> {
    const host = await loadEditorHost(getEditorRuntime('slides'));
    return host.getCapabilities?.() ?? [];
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
                .waitFor(kind, taskId, resolvedPath, OPEN_OFFICE_TASK_TIMEOUT_MS, waitController.signal)
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

export async function executeOpenDeskSlidesCapability(
    taskId: string,
    name: string,
    input: Record<string, unknown>
): Promise<SlidesCapabilityExecution> {
    const session = officeTaskSessions.get('slides', taskId);
    if (!session) throw new Error(t('office.slides.error.noTaskSession'));
    const host = await loadEditorHost(getEditorRuntime('slides'));
    if (!host.executeCapability) throw new Error(t('office.slides.error.capabilityUnavailable'));
    return await host.executeCapability(session.contents, { name, input });
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
