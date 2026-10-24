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
 * 用于实现ApplicationRegistry中部分与Electron强绑定的功能
 * 其他标准功能（可以在CLI版本中复用的仍然在registry.ts中实现）
 */

import { ApplicationRegistry } from './registry.js';
import { app, BrowserWindow, protocol } from 'electron';
import { logger } from '../utils/logger.js';
import { safeSendToWebContents } from '../utils/electron-ipc.js';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { AppManagerStore } from './appmgr/manager.js';

const EXTERNAL_APP_SCHEME = 'opendesk-app';

function mimeTypeFor(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
        case '.html':
            return 'text/html; charset=utf-8';
        case '.js':
            return 'text/javascript; charset=utf-8';
        case '.css':
            return 'text/css; charset=utf-8';
        case '.json':
            return 'application/json; charset=utf-8';
        case '.png':
            return 'image/png';
        case '.jpg':
        case '.jpeg':
            return 'image/jpeg';
        case '.svg':
            return 'image/svg+xml';
        case '.webp':
            return 'image/webp';
        case '.ico':
            return 'image/x-icon';
        default:
            return 'application/octet-stream';
    }
}

function assertPathInside(baseDir: string, targetPath: string): void {
    const base = path.resolve(baseDir);
    const target = path.resolve(targetPath);
    if (target !== base && !target.startsWith(`${base}${path.sep}`)) {
        throw new Error(`Unsafe app resource path: ${targetPath}`);
    }
}

function responseFromFile(filePath: string): Response {
    const body = fs.readFileSync(filePath);
    return new Response(body, {
        headers: {
            'content-type': mimeTypeFor(filePath),
            'cache-control': 'no-store'
        }
    });
}

function formatIpcError(error: unknown): string {
    const issues = (error as { issues?: Array<{ message?: string }> })?.issues;
    if (Array.isArray(issues) && issues.length > 0) {
        return (
            issues
                .map((issue) => issue.message)
                .filter(Boolean)
                .join('；') || '操作失败'
        );
    }
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}

function externalAppResourceHandler(request: Electron.ProtocolRequest): Response {
    const url = new URL(request.url);
    const bundleName = url.hostname;
    const appRecord = AppManagerStore.getApp(bundleName);
    if (!appRecord) {
        return new Response('Application not found', { status: 404 });
    }

    const parts = url.pathname
        .split('/')
        .filter(Boolean)
        .map((part) => decodeURIComponent(part));
    if (parts.length === 1 && (parts[0] === 'icon.png' || parts[0] === 'icon.svg')) {
        const iconPath = appRecord.iconPath;
        if (iconPath && fs.existsSync(iconPath)) {
            return responseFromFile(iconPath);
        }
        // 回退到用户放置的默认图标（生产/开发环境多路径查找）
        const defaultIconCandidates = [
            path.join(__dirname, '..', '..', 'renderer', 'applications', 'default_icon.png'),
            path.join(__dirname, '..', '..', 'renderer', 'applications', 'default_icon.svg'),
            path.join(app.getAppPath(), 'resources', 'renderer', 'applications', 'default_icon.png'),
            path.join(app.getAppPath(), 'resources', 'renderer', 'applications', 'default_icon.svg')
        ];
        for (const candidate of defaultIconCandidates) {
            if (fs.existsSync(candidate)) {
                return responseFromFile(candidate);
            }
        }
        return new Response('Icon not found', { status: 404 });
    }

    const [versionId, ...resourceParts] = parts;
    const version = appRecord.versions.find((item) => item.versionId === versionId);
    if (!version || resourceParts.length === 0) {
        return new Response('Resource not found', { status: 404 });
    }

    const relPath = resourceParts.join('/');
    if (path.isAbsolute(relPath) || relPath.split(/[\\/]+/).includes('..')) {
        return new Response('Unsafe resource path', { status: 400 });
    }
    const filePath = path.join(version.codePath, relPath);
    assertPathInside(version.codePath, filePath);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        return new Response('Resource not found', { status: 404 });
    }
    return responseFromFile(filePath);
}

export function initializeRegistryProtocols() {
    // 收集协议配置并注册 schemes（必须在 app.whenReady() 之前）
    const protocolConfigs = ApplicationRegistry.collectProtocolHandlerEntries();
    const schemes = protocolConfigs.map((config) => ({
        scheme: config.scheme,
        privileges: config.privileges || { standard: true, secure: true, supportFetchAPI: true }
    }));
    schemes.push({
        scheme: EXTERNAL_APP_SCHEME,
        privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
    });

    protocol.registerSchemesAsPrivileged(schemes);
}

/**
 * 注册应用注册器IPC处理程序
 */
export function registerApplicationRegistryHandlers(
    ipcMain: Electron.IpcMain,
    ensureFullyLoaded: () => Promise<void> = () => ApplicationRegistry.ensureFullyLoaded()
) {
    ApplicationRegistry.onApplicationListChanged(() => {
        const apps = ApplicationRegistry.getApplicationList();
        for (const win of BrowserWindow.getAllWindows()) {
            safeSendToWebContents(win.webContents, 'applicationRegistry:changed', apps);
        }
    });

    ipcMain.handle('applicationRegistry:getApplicationList', async (_event) => {
        return { status: 'ok', data: ApplicationRegistry.getApplicationList() };
    });
    ipcMain.handle('applicationRegistry:ensureFullyLoaded', async () => {
        try {
            await ensureFullyLoaded();
            return { status: 'ok' };
        } catch (error) {
            return { status: 'error', message: formatIpcError(error) };
        }
    });
    ipcMain.handle('applicationRegistry:getApplicationGUIConfig', async (_event, bundleName) => {
        const config = ApplicationRegistry.getApplicationGUIConfig(bundleName);
        if (!config) {
            return { status: 'error', message: `application ${bundleName} not found` };
        }
        return { status: 'ok', data: config };
    });
    ipcMain.handle('applicationRegistry:call', async (event, bundleName, methodName, ...args) => {
        return ApplicationRegistry.callWorker(bundleName, methodName, ...args);
    });
    ipcMain.handle('applicationRegistry:callMainWorld', async (event, bundleName, methodName, ...args) => {
        const application = ApplicationRegistry.getApplication(bundleName);
        if (application === undefined) {
            return { status: 'error', message: `application ${bundleName} not found` };
        }
        if (typeof application[methodName] !== 'function') {
            return {
                status: 'error',
                message: `method ${methodName} not found in application ${bundleName}`
            };
        }
        try {
            return { status: 'ok', data: await application[methodName](...args) };
        } catch (error) {
            const message = formatIpcError(error);
            logger.warn(`applicationRegistry:callMainWorld ${bundleName}.${methodName} failed: ${message}`);
            return { status: 'error', message };
        }
    });
    ipcMain.handle('applicationRegistry:streamCall', async (event, bundleName, methodName, ...args) => {
        const application = ApplicationRegistry.getApplication(bundleName);
        const requestId = crypto.randomUUID();

        if (application === undefined) {
            return { status: 'error', message: `application ${bundleName} not found` };
        } else if (!ApplicationRegistry.hasGlobalWorker()) {
            return { status: 'error', message: 'global worker not initialized yet' };
        }

        try {
            const callback = (chunk: any, error?: string) => {
                event.senderFrame?.send?.(`applicationRegistry:streamChunk:${requestId}`, chunk, error);
            };
            ApplicationRegistry.pendingStreamRequests.set(requestId, callback);

            ApplicationRegistry.getGlobalWorker().postMessage({
                bundleName: bundleName,
                requestId: requestId,
                methodName: methodName,
                args: args,
                stream: true
            });

            return { status: 'ok', requestId: requestId };
        } catch (error) {
            return { status: 'error', message: error.message };
        }
    });
    ipcMain.handle('applicationRegistry:streamCallMainWorld', async (event, bundleName, methodName, ...args) => {
        const application = ApplicationRegistry.getApplication(bundleName);
        const requestId = crypto.randomUUID();

        if (application === undefined) {
            return { status: 'error', message: `application ${bundleName} not found` };
        }
        const method = application[methodName];
        if (method === undefined) {
            return {
                status: 'error',
                message: `method ${methodName} not found in application ${bundleName}`
            };
        }

        const send = (chunk: any, error?: string) => {
            event.senderFrame?.send?.(`applicationRegistry:streamChunk:${requestId}`, chunk, error);
        };

        (async () => {
            try {
                for await (const chunk of method.apply(application, args)) {
                    send(chunk);
                }
                send(undefined);
            } catch (error) {
                logger.error(`streamCallMainWorld ${bundleName}.${methodName} error: ${error}`);
                send(undefined, error.message);
            }
        })();

        return { status: 'ok', requestId };
    });
    ipcMain.handle('applicationRegistry:subscribe', async (event, bundleName, eventName) => {
        const application = ApplicationRegistry.getApplication(bundleName);
        if (application === undefined) {
            return { status: 'error', message: `application ${bundleName} not found` };
        }
        application.addSubscriber(eventName, event.senderFrame);
        return { status: 'ok' };
    });
    ipcMain.handle('applicationRegistry:unsubscribe', async (event, bundleName, eventName) => {
        const application = ApplicationRegistry.getApplication(bundleName);
        if (application === undefined) {
            return { status: 'error', message: `application ${bundleName} not found` };
        }
        application.removeSubscriber(eventName, event.senderFrame);
        return { status: 'ok' };
    });
}

/**
 * 注册协议 handlers
 * 在 app.whenReady() 之后调用
 */
export function initializeProtocolHandlers() {
    // 由各应用通过 base.getProtocolHandlers 注册自定义协议；主进程在此统一注册 handler
    const protocolConfigs = ApplicationRegistry.collectProtocolHandlerEntries();
    for (const { scheme, handler } of protocolConfigs) {
        // protocol.handle 期望的 handler 类型与我们的类型定义兼容，使用类型断言
        protocol.handle(scheme, handler as any);
    }
    protocol.handle(EXTERNAL_APP_SCHEME, externalAppResourceHandler as any);
}
