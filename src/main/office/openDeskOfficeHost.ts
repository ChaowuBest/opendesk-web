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
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createTrustedRendererUrlMatcher } from '@bitclub.ai/opendesk-office/host-security';

export type OpenDeskOfficeEditorKind = 'slides' | 'word' | 'sheets';

const require = createRequire(import.meta.url);

interface OpenDeskOfficeHost {
    register(): void;
    attachWindow(window: BrowserWindow): void;
    activateContents(contents: WebContents): void;
    requestCloseAll(): Promise<boolean>;
}

interface OfficeEditorDefinition {
    kind: OpenDeskOfficeEditorKind;
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
