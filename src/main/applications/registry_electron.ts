import { ApplicationRegistry } from "./registry.js";
import { app, protocol } from 'electron';
import { logger } from "../utils/logger.js";
import crypto from "crypto";


export function initializeRegistryProtocols() {
    // 收集协议配置并注册 schemes（必须在 app.whenReady() 之前）
    const protocolConfigs = ApplicationRegistry.collectProtocolHandlerEntries();
    const schemes = protocolConfigs.map(config => ({
        scheme: config.scheme,
        privileges: config.privileges || { standard: true, secure: true, supportFetchAPI: true }
    }));

    if (schemes.length > 0) {
        protocol.registerSchemesAsPrivileged(schemes);
    }
}

/**
 * 注册应用注册器IPC处理程序
 */
export function registerApplicationRegistryHandlers(ipcMain: Electron.IpcMain) {
    ipcMain.handle('applicationRegistry:getApplicationGUIConfig', async (event, bundleName) => {
        const application = ApplicationRegistry.getApplication(bundleName);
        if (application === undefined) {
            return { status: 'error', message: `application ${bundleName} not found` }
        }
        return { status: 'ok', data: application.getGUIConfig() };
    })
    ipcMain.handle('applicationRegistry:getApplicationList', async (event) => {
        return { status: 'ok', data: ApplicationRegistry.getApplicationList() };
    })
    ipcMain.handle('applicationRegistry:call', async (event, bundleName, methodName, ...args) => {
        return ApplicationRegistry.callWorker(bundleName, methodName, ...args);
    })
    ipcMain.handle('applicationRegistry:callMainWorld', async (event, bundleName, methodName, ...args) => {
        const application = ApplicationRegistry.getApplication(bundleName);
        if (application === undefined) {
            return { status: 'error', message: `application ${bundleName} not found` }
        }
        const method = application[methodName];
        if (method === undefined) {
            return { status: 'error', message: `method ${methodName} not found in application ${bundleName}` }
        }
        return { status: 'ok', data: await method(...args) };
    })
    ipcMain.handle('applicationRegistry:streamCall', async (event, bundleName, methodName, ...args) => {
        const application = ApplicationRegistry.getApplication(bundleName);
        const requestId = crypto.randomUUID();

        if (application === undefined) {
            return { status: 'error', message: `application ${bundleName} not found` }
        } else if (!ApplicationRegistry.hasGlobalWorker()) {
            return { status: 'error', message: 'global worker not initialized yet' }
        }

        try {
            const callback = (chunk) => {
                event.senderFrame?.send?.(`applicationRegistry:streamChunk:${requestId}`, chunk);
            }
            ApplicationRegistry.pendingStreamRequests.set(requestId, callback);

            ApplicationRegistry.getGlobalWorker().postMessage({
                bundleName: bundleName,
                requestId: requestId,
                methodName: methodName,
                args: args,
                stream: true,
            })

            return { status: 'ok', requestId: requestId };
        } catch (error) {
            return { status: 'error', message: error.message };
        }
    })
    ipcMain.handle('applicationRegistry:streamCallMainWorld', async (event, bundleName, methodName, ...args) => {
        const application = ApplicationRegistry.getApplication(bundleName);
        const requestId = crypto.randomUUID();

        if (application === undefined) {
            return { status: 'error', message: `application ${bundleName} not found` }
        }
        const method = application[methodName];
        if (method === undefined) {
            return { status: 'error', message: `method ${methodName} not found in application ${bundleName}` }
        }

        const send = (chunk: any) => {
            event.senderFrame?.send?.(`applicationRegistry:streamChunk:${requestId}`, chunk);
        };

        (async () => {
            try {
                for await (const chunk of method.apply(application, args)) {
                    send(chunk);
                }
                send(undefined);
            } catch (error) {
                logger.error(`streamCallMainWorld ${bundleName}.${methodName} error: ${error}`);
                send(undefined);
            }
        })();

        return { status: 'ok', requestId };
    })
    ipcMain.handle('applicationRegistry:subscribe', async (event, bundleName, eventName) => {
        const application = ApplicationRegistry.getApplication(bundleName);
        if (application === undefined) {
            return { status: 'error', message: `application ${bundleName} not found` };
        }
        application.addSubscriber(eventName, event.senderFrame);
        return { status: 'ok' };
    })
    ipcMain.handle('applicationRegistry:unsubscribe', async (event, bundleName, eventName) => {
        const application = ApplicationRegistry.getApplication(bundleName);
        if (application === undefined) {
            return { status: 'error', message: `application ${bundleName} not found` };
        }
        application.removeSubscriber(eventName, event.senderFrame);
        return { status: 'ok' };
    })
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
}
