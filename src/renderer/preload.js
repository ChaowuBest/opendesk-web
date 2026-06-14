/* eslint-disable no-console */
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

import { contextBridge, ipcRenderer, webUtils, clipboard } from 'electron';
import { defineBrowserBridge } from '../common/embedBrowserUse/preload';

/** 避免主 frame 上 registerPreloadScript + webPreferences.preload 重复 expose 导致整页 API 失效 */
function safeExposeInMainWorld(apiKey, api) {
    try {
        contextBridge.exposeInMainWorld(apiKey, api);
    } catch (err) {
        const msg = String(err?.message ?? err);
        if (/existing property|already been registered/i.test(msg)) {
            return;
        }
        throw err;
    }
}

function isApplicationFrameDocument() {
    try {
        const path = window.location?.pathname ?? '';
        const href = window.location?.href ?? '';
        return path.includes('application.html') || href.includes('application.html');
    } catch {
        return false;
    }
}

function shouldExposeMainWindowAPIs() {
    if (isApplicationFrameDocument()) {
        return false;
    }
    return isMainFramePreload();
}

function exposeTaskManagerAPI() {
    /** @type {Map<string, Map<string, (toolName: string, args: any) => Promise<string>>>} */
    const taskwiseToolsetCallbacks = new Map();

    safeExposeInMainWorld('taskManagerAPI', {
        createTask: async (modeIdOrOptions, maybeOptions) => {
            const options =
                modeIdOrOptions && typeof modeIdOrOptions === 'object'
                    ? modeIdOrOptions
                    : { ...(maybeOptions || {}), modeId: modeIdOrOptions };
            const result = await ipcRenderer.invoke('taskManager:createTask', options);
            if (result.status === 'ok') {
                return result.data;
            } else {
                console.error('creating task failed', result.message);
                throw new Error(result.message);
            }
        },
        removeTask: async (taskId) => {
            const result = await ipcRenderer.invoke('taskManager:removeTask', taskId);
            if (result.status === 'ok') {
                return result.data;
            } else {
                console.error('removing task failed', result.message);
                throw new Error(result.message);
            }
        },
        forkTask: async (taskId) => {
            const result = await ipcRenderer.invoke('taskManager:forkTask', taskId);
            if (result.status === 'ok') {
                return result.data;
            } else {
                console.error('forking task failed', result.message);
                throw new Error(result.message);
            }
        },
        clearAllTasks: async () => {
            const result = await ipcRenderer.invoke('taskManager:clearAllTasks');
            if (result.status !== 'ok') {
                console.error('clearing all tasks failed', result.message);
                throw new Error(result.message);
            }
        },
        stopTask: async (taskId) => {
            const result = await ipcRenderer.invoke('taskManager:stopTask', taskId);
            if (result.status !== 'ok') {
                console.error('stopping task failed', result.message);
                throw new Error(result.message);
            }
            return result.data;
        },
        skipRetryDelay: async (taskId) => {
            const result = await ipcRenderer.invoke('taskManager:skipRetryDelay', taskId);
            if (result.status !== 'ok') {
                console.error('skipRetryDelay failed', result.message);
                throw new Error(result.message);
            }
            return result.data;
        },
        getFullTask: async (taskId) => {
            const result = await ipcRenderer.invoke('taskManager:getFullTask', taskId);
            if (result.status === 'ok') {
                return result.data;
            } else {
                console.error('getting full task failed', result.message);
                throw new Error(result.message);
            }
        },
        getTaskTodos: async (taskId) => {
            const result = await ipcRenderer.invoke('taskManager:getTaskTodos', taskId);
            if (result.status === 'ok') {
                return result.data;
            } else {
                console.error('getting task todos failed', result.message);
                throw new Error(result.message);
            }
        },
        subscribeTaskUpdate: async (taskId, callback) => {
            const result = await ipcRenderer.invoke('taskManager:subscribeTaskUpdate', taskId);
            if (result.status !== 'ok') {
                console.error('subscribing task update failed', result.message);
                throw new Error(result.message);
            }
            const subscriptionId = result.data;
            console.info('task update subscribed for task', taskId, subscriptionId);
            ipcRenderer.on(`taskManager:taskUpdate:${subscriptionId}`, (event, ...args) => {
                callback(...args);
            });
            return subscriptionId;
        },
        unsubscribeTaskUpdate: async (taskId, subscriptionId) => {
            const result = await ipcRenderer.invoke('taskManager:unsubscribeTaskUpdate', taskId, subscriptionId);
            if (result.status !== 'ok') {
                console.error('unsubscribing task update failed', result.message);
                throw new Error(result.message);
            }
            ipcRenderer.removeAllListeners(`taskManager:taskUpdate:${subscriptionId}`);
            console.info('unsubscribing task update for task', taskId, subscriptionId);
        },
        getTaskList: async () => {
            const result = await ipcRenderer.invoke('taskManager:getTaskList');
            if (result.status !== 'ok') {
                console.error('getting task list failed', result.message);
                throw new Error(result.message);
            }
            return result.data;
        },
        subscribeTaskListUpdate: async (callback) => {
            const result = await ipcRenderer.invoke('taskManager:subscribeTaskListUpdate');
            if (result.status !== 'ok') {
                console.error('subscribing task list update failed', result.message);
                throw new Error(result.message);
            }
            ipcRenderer.on('taskManager:taskListUpdate', (event, ...args) => {
                callback(...args);
            });
        },
        attachToolset: async (taskId, toolset, toolsetCallback) => {
            const result = await ipcRenderer.invoke('taskManager:attachToolset', taskId, toolset);
            if (result.status !== 'ok') {
                console.error('attaching toolset failed', result.message);
                throw new Error(result.message);
            }

            if (!taskwiseToolsetCallbacks.has(taskId)) {
                taskwiseToolsetCallbacks.set(taskId, new Map());
            }
            taskwiseToolsetCallbacks.get(taskId).set(toolset.name, toolsetCallback);
            return result.data;
        },
        setSystemPrompt: (taskId, prompt) => ipcRenderer.invoke('taskManager:setSystemPrompt', taskId, prompt),
        submitMessage: (taskId, message) => ipcRenderer.invoke('taskManager:submitMessage', taskId, message),
        exportTaskToHtml: async (taskId) => {
            const result = await ipcRenderer.invoke('taskManager:exportTaskToHtml', taskId);
            if (result.status !== 'ok') {
                console.error('exporting task failed', result.message);
                throw new Error(result.message);
            }
            return result.data;
        },
        exportTask: async (taskId, filePath) => {
            const result = await ipcRenderer.invoke('taskManager:exportTask', taskId, filePath);
            if (result.status !== 'ok') {
                console.error('exporting task failed', result.message);
                throw new Error(result.message);
            }
            return result.data;
        },
        getSessionMemory: async (taskId) => {
            const result = await ipcRenderer.invoke('taskManager:getSessionMemory', taskId);
            if (result.status === 'ok') {
                return result.data;
            }
            return null;
        },
        getTaskChanges: async (taskId) => {
            const result = await ipcRenderer.invoke('taskManager:getTaskChanges', taskId);
            if (result.status === 'ok') {
                return result.data;
            }
            console.error('getting task changes failed', result.message);
            return null;
        },
        getModelContextSize: async (modelAlias) => {
            const result = await ipcRenderer.invoke('taskManager:getModelContextSize', modelAlias);
            if (result.status === 'ok') {
                return result.data;
            }
            return 0;
        }
    });

    ipcRenderer.on('taskManager:callTool', async (_event, taskId, toolCallId, toolsetName, toolName, args) => {
        try {
            const taskCallbacks = taskwiseToolsetCallbacks.get(taskId);
            const callback = taskCallbacks?.get(toolsetName);
            if (!callback) {
                ipcRenderer.send(`taskManager:reportToolCallResult:${toolCallId}`, {
                    status: 'error',
                    message: `No toolset callback for ${toolsetName} in task ${taskId}`
                });
                return;
            }
            const toolResult = await callback(toolName, args);
            ipcRenderer.send(`taskManager:reportToolCallResult:${toolCallId}`, {
                status: 'ok',
                data: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult)
            });
        } catch (err) {
            ipcRenderer.send(`taskManager:reportToolCallResult:${toolCallId}`, {
                status: 'error',
                message: err?.message || String(err)
            });
        }
    });

    // askUser 使用事件广播模式，每个 task-view 中的组件都可以按 taskId 过滤
    const askUserRequestCallbacks = new Set();
    const askUserDismissCallbacks = new Set();
    ipcRenderer.on('askUser:request', (_event, requestId, data) => {
        for (const cb of askUserRequestCallbacks) cb(requestId, data);
    });
    ipcRenderer.on('askUser:dismiss', (_event, requestId) => {
        for (const cb of askUserDismissCallbacks) cb(requestId);
    });
    safeExposeInMainWorld('askUserAPI', {
        onAskUserRequest: (callback) => {
            askUserRequestCallbacks.add(callback);
        },
        offAskUserRequest: (callback) => {
            askUserRequestCallbacks.delete(callback);
        },
        onAskUserDismiss: (callback) => {
            askUserDismissCallbacks.add(callback);
        },
        offAskUserDismiss: (callback) => {
            askUserDismissCallbacks.delete(callback);
        },
        respondAskUser: (requestId, response) => {
            ipcRenderer.send('askUser:response', requestId, response);
        }
    });

    // exitPlanMode 使用事件广播模式
    const exitPlanRequestCallbacks = new Set();
    const exitPlanDismissCallbacks = new Set();
    ipcRenderer.on('exitPlanMode:request', (_event, requestId, data) => {
        for (const cb of exitPlanRequestCallbacks) cb(requestId, data);
    });
    ipcRenderer.on('exitPlanMode:dismiss', (_event, requestId) => {
        for (const cb of exitPlanDismissCallbacks) cb(requestId);
    });
    safeExposeInMainWorld('exitPlanModeAPI', {
        onExitPlanModeRequest: (callback) => {
            exitPlanRequestCallbacks.add(callback);
        },
        offExitPlanModeRequest: (callback) => {
            exitPlanRequestCallbacks.delete(callback);
        },
        onExitPlanModeDismiss: (callback) => {
            exitPlanDismissCallbacks.add(callback);
        },
        offExitPlanModeDismiss: (callback) => {
            exitPlanDismissCallbacks.delete(callback);
        },
        respondExitPlanMode: (requestId, response) => {
            ipcRenderer.send('exitPlanMode:response', requestId, response);
        },
        getPendingRequest: async () => {
            const result = await ipcRenderer.invoke('exitPlanMode:getPending');
            if (result.status === 'ok') return result.data;
            return null;
        }
    });
}

function exposeThemeAPI() {
    safeExposeInMainWorld('themeAPI', {
        getResolvedTheme: async () => {
            return ipcRenderer.invoke('theme:getResolvedTheme');
        },
        setPreference: async (preference) => {
            return ipcRenderer.invoke('theme:setPreference', preference);
        },
        onThemeChanged: (callback) => {
            const handler = (_event, resolved) => callback(resolved);
            ipcRenderer.on('theme:changed', handler);
            return () => ipcRenderer.removeListener('theme:changed', handler);
        }
    });
}

function getBundleNameFromLocation() {
    try {
        return new URLSearchParams(window.location.search).get('applicationBundleName');
    } catch {
        return null;
    }
}

function exposeOpenDeskAppAPI() {
    safeExposeInMainWorld('opendeskAppAPI', {
        getApplicationInfo: async () => {
            const bundleName = getBundleNameFromLocation();
            if (!bundleName) return null;
            const result = await ipcRenderer.invoke('applicationRegistry:getApplicationGUIConfig', bundleName);
            if (result.status !== 'ok') {
                throw new Error(result.message);
            }
            return result.data;
        },
        getManifest: async () => {
            const bundleName = getBundleNameFromLocation();
            if (!bundleName) return null;
            const result = await ipcRenderer.invoke('applicationRegistry:callMainWorld', bundleName, 'getManifest');
            if (result.status !== 'ok') {
                throw new Error(result.message);
            }
            return result.data;
        },
        getTheme: async () => {
            return ipcRenderer.invoke('theme:getResolvedTheme');
        },
        onThemeChanged: (callback) => {
            const handler = (_event, resolved) => callback(resolved);
            ipcRenderer.on('theme:changed', handler);
            return () => ipcRenderer.removeListener('theme:changed', handler);
        }
    });
}

function exposeFSAPI() {
    safeExposeInMainWorld('fsAPI', {
        searchFilesByKeyword: async (keyword) => {
            const result = await ipcRenderer.invoke(
                'applicationRegistry:call',
                'filemgr',
                'searchFilesByKeyword',
                keyword
            );
            if (result.status !== 'ok') {
                console.error('searching files by keyword failed', result.message);
                throw new Error(result.message);
            }
            console.info(result);
            return result.data;
        },
        searchFilesByKeywordInPath: async (keyword, basePath) => {
            const result = await ipcRenderer.invoke(
                'applicationRegistry:call',
                'filemgr',
                'searchFilesByKeywordInPath',
                keyword,
                basePath
            );
            if (result.status !== 'ok') {
                console.error('searching files by keyword in path failed', result.message);
                throw new Error(result.message);
            }
            return result.data;
        },
        searchIndexedFiles: async (query, options = {}) => {
            const result = await ipcRenderer.invoke(
                'applicationRegistry:call',
                'filemgr',
                'searchIndexedFiles',
                query,
                options
            );
            if (result.status !== 'ok') {
                console.error('searching indexed files failed', result.message);
                throw new Error(result.message);
            }
            return result.data;
        },
        openPath: async (filePath) => {
            const result = await ipcRenderer.invoke(
                'applicationRegistry:callMainWorld',
                'filemgr',
                'openPath',
                filePath
            );
            if (result.status !== 'ok') {
                console.error('opening file failed', result.message);
                throw new Error(result.message);
            }
        },
        selectFile: async () => {
            // 调用主进程的 dialog
            const filePaths = await ipcRenderer.invoke('fs:dialog-open');
            // 这里的返回值直接就是路径数组 ['C:/Users/.../a.pdf']，或者空数组(用户取消)
            return filePaths;
        },
        selectDirectory: async () => {
            const dirPath = await ipcRenderer.invoke('fs:dialog-open-directory');
            return dirPath; // 返回选中的目录路径字符串，取消时为 null
        },
        saveFile: async (options) => {
            // 调用主进程的保存对话框
            const result = await ipcRenderer.invoke('dialog:saveFile', options);
            if (result.status !== 'ok') {
                console.error('showing save dialog failed', result.message);
                throw new Error(result.message);
            }
            return result.data;
        },
        fileExists: async (filePath) => {
            // 检查文件是否存在
            const result = await ipcRenderer.invoke('fs:fileExists', filePath);
            if (result.status !== 'ok') {
                console.error('checking file exists failed', result.message);
                throw new Error(result.message);
            }
            return result.data;
        },
        getFilePath: (file) => {
            // 统一为跨平台路径，始终返回如 c:/xxx 格式
            let p = webUtils.getPathForFile(file);
            // 将所有反斜杠替换为正斜杠，以统一为 URI 风格
            if (typeof p === 'string') {
                p = p.replace(/\\/g, '/');
            }
            return p;
        },
        getPathType: async (filePath) => {
            const result = await ipcRenderer.invoke('fs:getPathType', filePath);
            if (result.status !== 'ok') {
                console.error('getting path type failed', result.message);
                throw new Error(result.message);
            }

            return result.data;
        },
        listDirectory: async (dirPath) => {
            const result = await ipcRenderer.invoke('fs:listDirectory', dirPath);
            if (result.status !== 'ok') {
                console.error('listing directory failed', result.message);
                throw new Error(result.message);
            }
            return result.data;
        },
        readTextFile: async (filePath, maxBytes) => {
            const result = await ipcRenderer.invoke('fs:readTextFile', filePath, maxBytes);
            if (result.status !== 'ok') {
                console.error('reading text file failed', result.message);
                throw new Error(result.message);
            }
            return result.data;
        },
        trashItem: async (itemPath) => {
            const result = await ipcRenderer.invoke('fs:trashItem', itemPath);
            if (result.status !== 'ok') {
                console.error('trashing item failed', result.message);
                throw new Error(result.message);
            }
            return result.data;
        },
        writeTextFile: async (filePath, content) => {
            const result = await ipcRenderer.invoke('fs:writeTextFile', filePath, content);
            if (result.status !== 'ok') {
                console.error('writing text file failed', result.message);
                throw new Error(result.message);
            }
            return result.data;
        },
        resolveFilePath: async (filePath) => {
            const result = await ipcRenderer.invoke('fs:resolveFilePath', filePath);
            if (result.status !== 'ok') {
                console.error('resolving file path failed', result.message);
                throw new Error(result.message);
            }
            return result.data;
        }
    });
}

function exposeNativeBridgeAPI() {
    safeExposeInMainWorld('native', {
        call: async (method, ...args) => {
            const resp = await ipcRenderer.invoke('native:call', method, ...args);
            if (resp.status !== 'ok') {
                console.error('native bridge call failed', method, resp.message);
                throw new Error(resp.message);
            }
            return resp.data;
        }
    });
}

/** 子应用 iframe 专用；须在主窗口与子 frame 均暴露（部分 Electron 子 frame 里 self===top）。 */
function exposeApplicationAPI() {
    /** @type {string | null} */
    let applicationBundleName = getBundleNameFromLocation();

    safeExposeInMainWorld('applicationAPI', {
        setApplicationBundleName: async (bundleName) => {
            applicationBundleName = bundleName;
        },
        call: async (methodName, ...args) => {
            if (applicationBundleName === null) {
                console.error('application bundle name is not set');
                throw new Error('application bundle name is not set');
            }
            const result = await ipcRenderer.invoke(
                'applicationRegistry:call',
                applicationBundleName,
                methodName,
                ...args
            );
            if (result.status !== 'ok') {
                console.error('calling application failed', methodName, result.message);
                throw new Error(result.message);
            }
            return result.data;
        },
        callMainWorld: async (methodName, ...args) => {
            if (applicationBundleName === null) {
                console.error('application bundle name is not set');
                throw new Error('application bundle name is not set');
            }
            const result = await ipcRenderer.invoke(
                'applicationRegistry:callMainWorld',
                applicationBundleName,
                methodName,
                ...args
            );
            if (result.status !== 'ok') {
                console.error('calling application failed', methodName, result.message);
                throw new Error(result.message);
            }
            return result.data;
        },
        streamCall: async (methodName, callback, ...args) => {
            if (applicationBundleName === null) {
                console.error('application bundle name is not set');
                throw new Error('application bundle name is not set');
            }
            const result = await ipcRenderer.invoke(
                'applicationRegistry:streamCall',
                applicationBundleName,
                methodName,
                ...args
            );
            if (result.status !== 'ok') {
                console.error('calling application failed', methodName, result.message);
                throw new Error(result.message);
            }

            return new Promise((resolve, reject) => {
                const listener = (event, chunk) => {
                    if (chunk === undefined) {
                        console.info('stream complete', result.requestId);
                        ipcRenderer.off(`applicationRegistry:streamChunk:${result.requestId}`, listener);
                        resolve();
                    } else {
                        try {
                            callback(chunk);
                        } catch (e) {
                            console.error('stream callback error', e);
                        }
                    }
                };

                console.info('listener registered', result.requestId);
                ipcRenderer.on(`applicationRegistry:streamChunk:${result.requestId}`, listener);
            });
        },
        streamCallMainWorld: async (methodName, callback, ...args) => {
            if (applicationBundleName === null) {
                console.error('application bundle name is not set');
                throw new Error('application bundle name is not set');
            }
            const result = await ipcRenderer.invoke(
                'applicationRegistry:streamCallMainWorld',
                applicationBundleName,
                methodName,
                ...args
            );
            if (result.status !== 'ok') {
                console.error('calling application failed', methodName, result.message);
                throw new Error(result.message);
            }

            return new Promise((resolve, reject) => {
                const listener = (event, chunk) => {
                    if (chunk === undefined) {
                        console.info('stream complete', result.requestId);
                        ipcRenderer.off(`applicationRegistry:streamChunk:${result.requestId}`, listener);
                        resolve();
                    } else {
                        try {
                            callback(chunk);
                        } catch (e) {
                            console.error('stream callback error', e);
                        }
                    }
                };

                console.info('listener registered', result.requestId);
                ipcRenderer.on(`applicationRegistry:streamChunk:${result.requestId}`, listener);
            });
        },
        subscribe: async (eventName, callback) => {
            const result = await ipcRenderer.invoke('applicationRegistry:subscribe', applicationBundleName, eventName);
            if (result.status !== 'ok') {
                console.error('subscribing event failed', eventName, result.message);
                throw new Error(result.message);
            }
            ipcRenderer.on(`applicationRegistry:event:${eventName}`, (event, ...args) => {
                callback(...args);
            });
            return result.data;
        },
        unsubscribe: async (eventName) => {
            const result = await ipcRenderer.invoke(
                'applicationRegistry:unsubscribe',
                applicationBundleName,
                eventName
            );
            if (result.status !== 'ok') {
                console.error('unsubscribing event failed', eventName, result.message);
                throw new Error(result.message);
            }
            ipcRenderer.removeAllListeners(`applicationRegistry:event:${eventName}`);
            return result.data;
        }
    });
}

exposeApplicationAPI();
exposeTaskManagerAPI();
exposeFSAPI();
exposeThemeAPI();
exposeOpenDeskAppAPI();
exposeNativeBridgeAPI();

// 通用窗口控制 API（主窗口和应用窗口均可使用）
safeExposeInMainWorld('windowControlAPI', {
    close: () => ipcRenderer.invoke('window:close'),
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    isMaximized: async () => {
        const result = await ipcRenderer.invoke('window:isMaximized');
        if (result.status !== 'ok') return false;
        return result.data;
    }
});

function isMainFramePreload() {
    try {
        return window.self === window.top;
    } catch {
        return true;
    }
}

if (shouldExposeMainWindowAPIs()) {
    safeExposeInMainWorld('settingAPI', {
        registerCommandCallback: (command, callback) => {
            ipcRenderer.on(`command:${command}`, (event, ...args) => {
                callback(...args);
            });
        },
        loadSettingSchema: async () => {
            const result = await ipcRenderer.invoke('setting:loadSettingSchema');
            if (result.status !== 'ok') {
                console.error('loading setting schema failed', result.message);
                throw new Error(result.message);
            }
            return result.data;
        },
        loadSettingObject: async () => {
            const result = await ipcRenderer.invoke('setting:loadSettingObject');
            if (result.status !== 'ok') {
                console.error('loading setting object failed', result.message);
                throw new Error(result.message);
            }
            return result.data;
        },
        saveSettingObject: async (settingObject) => {
            const result = await ipcRenderer.invoke('setting:saveSettingObject', settingObject);
            if (result.status !== 'ok') {
                console.error('saving setting object failed', result.message);
                throw new Error(result.message);
            }
        },
        onSettingChanged: (callback) => {
            const handler = (_event, data) => callback(data);
            ipcRenderer.on('setting:changed', handler);
            return () => ipcRenderer.removeListener('setting:changed', handler);
        },
        openDevTools: () => ipcRenderer.invoke('setting:openDevTools'),
        getLogContent: async () => {
            const result = await ipcRenderer.invoke('setting:getLogContent');
            if (result.status !== 'ok') {
                console.error('getting log content failed', result.message);
                throw new Error(result.message);
            }
            return result.data;
        },
        getLogEntries: async (options) => {
            const result = await ipcRenderer.invoke('setting:getLogEntries', options);
            if (result.status !== 'ok') {
                console.error('getting log entries failed', result.message);
                throw new Error(result.message);
            }
            return result.data;
        },
        subscribeLogContentUpdate: (callback) => {
            ipcRenderer.on('setting:logContentUpdate', (event, ...args) => {
                callback(...args);
            });
        },
        closeMainWindow: () => ipcRenderer.invoke('setting:closeMainWindow'),
        minimizeMainWindow: () => ipcRenderer.invoke('setting:minimizeMainWindow'),
        maximizeMainWindow: () => ipcRenderer.invoke('setting:maximizeMainWindow'),
        isMaximized: async () => {
            const result = await ipcRenderer.invoke('setting:isMaximized');
            if (result.status !== 'ok') {
                return false;
            }
            return result.data;
        },
        getProviderTemplates: async () => {
            const result = await ipcRenderer.invoke('setting:getProviderTemplates');
            if (result.status !== 'ok') {
                throw new Error(result.message);
            }
            return result.data;
        },
        getGatewayHostOptions: async () => {
            const result = await ipcRenderer.invoke('setting:getGatewayHostOptions');
            if (result.status !== 'ok') {
                throw new Error(result.message);
            }
            return result.data;
        },
        verifyModel: async ({ base_url, api_key, provider_type, model_name }) => {
            const result = await ipcRenderer.invoke('setting:verifyModel', {
                base_url,
                api_key,
                provider_type,
                model_name
            });
            if (result.status !== 'ok') {
                throw new Error(result.message);
            }
            return result.data;
        },
        fetchProviderModels: async ({ base_url, api_key, provider_type }) => {
            const result = await ipcRenderer.invoke('setting:fetchProviderModels', {
                base_url,
                api_key,
                provider_type
            });
            if (result.status !== 'ok') {
                return [];
            }
            return result.data;
        },
        getVersion: async () => {
            const result = await ipcRenderer.invoke('setting:getAppVersion');
            if (result.status !== 'ok') {
                throw new Error(result.message);
            }
            return result.data;
        }
    });

    safeExposeInMainWorld('magicPointerAPI', {
        getCursorPosition: async () => {
            const result = await ipcRenderer.invoke('magicPointer:getCursorPosition');
            if (result.status !== 'ok') {
                console.error('getting cursor position failed', result.message);
                return null;
            }
            return result.data;
        },
        captureWindow: async () => {
            const result = await ipcRenderer.invoke('magicPointer:captureWindow');
            if (result.status !== 'ok') {
                console.error('capturing window failed', result.message);
                return null;
            }
            return result.data;
        },
        saveScreenshot: async (pngDataUrl, description) => {
            const result = await ipcRenderer.invoke('magicPointer:saveScreenshot', pngDataUrl, description);
            if (result.status !== 'ok') {
                console.error('saving screenshot failed', result.message);
                return null;
            }
            return result.data;
        }
    });

    safeExposeInMainWorld('modeAPI', {
        getSupportedModes: async () => {
            const result = await ipcRenderer.invoke('mode:getSupportedModes');
            if (result.status !== 'ok') {
                console.error('getting supported modes failed', result.message);
                throw new Error(result.message);
            }
            return result.data;
        },
        setCurrentMode: async (modeId) => {
            const result = await ipcRenderer.invoke('mode:setCurrentMode', modeId);
            if (result.status !== 'ok') {
                console.error('setting current mode failed', result.message);
                throw new Error(result.message);
            }
            return result.data;
        },
        setTaskMode: async (taskId, modeId) => {
            const result = await ipcRenderer.invoke('mode:setTaskMode', taskId, modeId);
            if (result.status !== 'ok') {
                console.error('setting task mode failed', result.message);
                throw new Error(result.message);
            }
            return result.data;
        },
        onModeChanged: (callback) => {
            ipcRenderer.removeAllListeners('mode:changed');
            ipcRenderer.on('mode:changed', (event, modeId) => {
                callback(modeId);
            });
        },
        onTaskModeChanged: (callback) => {
            ipcRenderer.removeAllListeners('mode:taskModeChanged');
            ipcRenderer.on('mode:taskModeChanged', (event, taskId, modeId) => {
                callback(taskId, modeId);
            });
        }
    });

    safeExposeInMainWorld('nodeAPI', {
        listExecutionNodes: async () => {
            const result = await ipcRenderer.invoke('node:listExecutionNodes');
            if (result.status !== 'ok') {
                throw new Error(result.message);
            }
            return result.data;
        },
        setTaskExecutionNode: async (taskId, nodeId) => {
            const result = await ipcRenderer.invoke('node:setTaskExecutionNode', taskId, nodeId);
            if (result.status !== 'ok') {
                throw new Error(result.message);
            }
            return result.data;
        },
        onExecutionNodesChanged: (callback) => {
            const events = ['device:connected', 'device:disconnected'];
            const handlers = events.map((eventName) => {
                const handler = () => callback();
                ipcRenderer.invoke('applicationRegistry:subscribe', 'devicemgr', eventName).catch(() => {});
                ipcRenderer.on(`applicationRegistry:event:${eventName}`, handler);
                return { eventName, handler };
            });
            return () => {
                for (const { eventName, handler } of handlers) {
                    ipcRenderer.removeListener(`applicationRegistry:event:${eventName}`, handler);
                    ipcRenderer.invoke('applicationRegistry:unsubscribe', 'devicemgr', eventName).catch(() => {});
                }
            };
        }
    });

    safeExposeInMainWorld('workspaceAPI', {
        getEffectiveWorkspace: async () => {
            const result = await ipcRenderer.invoke('workspace:getEffectiveWorkspace');
            if (result.status !== 'ok') {
                throw new Error(result.message);
            }
            return result.data;
        },
        openWorkspaceDirectory: async () => {
            const result = await ipcRenderer.invoke('workspace:openWorkspaceDirectory');
            if (result.status !== 'ok') {
                throw new Error(result.message);
            }
        },
        selectWorkspaceDirectory: async () => {
            const result = await ipcRenderer.invoke('workspace:selectWorkspaceDirectory');
            if (result.status !== 'ok') {
                throw new Error(result.message);
            }
            return result.data;
        },
        copyWorkspacePath: async () => {
            const result = await ipcRenderer.invoke('workspace:getEffectiveWorkspace');
            if (result.status !== 'ok') {
                throw new Error(result.message);
            }
            clipboard.writeText(result.data);
        },
        setWorkspaceDirectory: async (dirPath) => {
            const result = await ipcRenderer.invoke('workspace:setWorkspaceDirectory', dirPath);
            if (result.status !== 'ok') {
                throw new Error(result.message);
            }
            return result.data;
        },
        getRecentWorkspaces: async () => {
            const result = await ipcRenderer.invoke('workspace:getRecentWorkspaces');
            if (result.status !== 'ok') {
                throw new Error(result.message);
            }
            return result.data;
        },
        removeRecentWorkspace: async (workspacePath) => {
            const result = await ipcRenderer.invoke('workspace:removeRecentWorkspace', workspacePath);
            if (result.status !== 'ok') {
                throw new Error(result.message);
            }
        },
        listDirectory: async (dirPath, opts) => {
            const result = await ipcRenderer.invoke('workspace:listDirectory', dirPath, opts);
            if (result.status !== 'ok') {
                throw new Error(result.message);
            }
            return result.data;
        },
        listDrives: async () => {
            const result = await ipcRenderer.invoke('workspace:listDrives');
            if (result.status !== 'ok') {
                throw new Error(result.message);
            }
            return result.data;
        },
        renameEntry: async (oldPath, newName) => {
            const result = await ipcRenderer.invoke('workspace:renameEntry', oldPath, newName);
            if (result.status !== 'ok') {
                throw new Error(result.message);
            }
            return result.data;
        },
        createDirectory: async (parentPath, dirName) => {
            const result = await ipcRenderer.invoke('workspace:createDirectory', parentPath, dirName);
            if (result.status !== 'ok') {
                throw new Error(result.message);
            }
            return result.data;
        },
        deleteEntry: async (entryPath) => {
            const result = await ipcRenderer.invoke('workspace:deleteEntry', entryPath);
            if (result.status !== 'ok') {
                throw new Error(result.message);
            }
        }
    });

    safeExposeInMainWorld('quickpassAPI', {
        isQuickPass: async (text) => {
            const result = await ipcRenderer.invoke('quickpass:isQuickPass', text);
            return result.status === 'ok' ? result.data : false;
        },
        importQuickPass: async (quickpass) => {
            const result = await ipcRenderer.invoke('quickpass:import', quickpass);
            if (result.status !== 'ok') {
                throw new Error(result.message);
            }
            return result.data;
        },
        exportBaseConfig: async () => {
            const result = await ipcRenderer.invoke('quickpass:exportBase');
            if (result.status !== 'ok') {
                throw new Error(result.message);
            }
            return result.data;
        },
        exportAllConfig: async () => {
            const result = await ipcRenderer.invoke('quickpass:exportAll');
            if (result.status !== 'ok') {
                throw new Error(result.message);
            }
            return result.data;
        }
    });

    safeExposeInMainWorld('notificationAPI', {
        sendNotification: async (...args) => {
            const result = await ipcRenderer.invoke('notification:sendNotification', ...args);
            if (result.status !== 'ok') {
                console.error('sending notification failed', result.message);
                throw new Error(result.message);
            }
            return result.data;
        },
        subscribeNotification: async (callback) => {
            // 先移除旧的监听器，避免重复订阅
            ipcRenderer.removeAllListeners('notification:notificationReceived');
            await ipcRenderer.invoke('notification:subscribeNotification');
            ipcRenderer.on('notification:notificationReceived', (event, ...args) => {
                callback(...args);
            });
        }
    });

    safeExposeInMainWorld('displayAPI', {
        getScaleFactor: async () => {
            const result = await ipcRenderer.invoke('display:getScaleFactor');
            if (result.status !== 'ok') throw new Error(result.message);
            return result.data;
        },
        setScaleFactor: async (factor) => {
            const result = await ipcRenderer.invoke('display:setScaleFactor', factor);
            if (result.status !== 'ok') throw new Error(result.message);
            return result.data;
        },
        adjustScaleFactor: async (delta) => {
            const result = await ipcRenderer.invoke('display:adjustScaleFactor', delta);
            if (result.status !== 'ok') throw new Error(result.message);
            return result.data;
        },
        onScaleFactorChanged: (callback) => {
            const handler = (_event, factor) => callback(factor);
            ipcRenderer.on('display:scaleFactorChanged', handler);
            return () => ipcRenderer.removeListener('display:scaleFactorChanged', handler);
        }
    });

    safeExposeInMainWorld('screenAPI', {
        getDisplayScaleFactors: async () => {
            const result = await ipcRenderer.invoke('screen:getDisplayScaleFactors');
            if (result.status !== 'ok') {
                throw new Error(result.message);
            }
            return result.data;
        }
    });

    safeExposeInMainWorld('floatWindowAPI', {
        hideFloatWindow: () => ipcRenderer.invoke('floatWindow:hideFloatWindow'),
        subscribeIntentsUpdate: (callback) => {
            ipcRenderer.on('floatWindow:intentsUpdate', (event, ...args) => {
                callback(...args);
            });
        }
    });

    // permission 使用事件广播模式，每个 task-view 中的组件都可以按 taskId 过滤
    const permRequestCallbacks = new Set();
    const permDismissCallbacks = new Set();
    ipcRenderer.on('permission:request', (_event, requestId, data) => {
        for (const cb of permRequestCallbacks) cb(requestId, data);
    });
    ipcRenderer.on('permission:dismiss', (_event, requestId) => {
        for (const cb of permDismissCallbacks) cb(requestId);
    });
    safeExposeInMainWorld('permissionAPI', {
        onPermissionRequest: (callback) => {
            permRequestCallbacks.add(callback);
        },
        offPermissionRequest: (callback) => {
            permRequestCallbacks.delete(callback);
        },
        onPermissionDismiss: (callback) => {
            permDismissCallbacks.add(callback);
        },
        offPermissionDismiss: (callback) => {
            permDismissCallbacks.delete(callback);
        },
        respondPermission: (requestId, response) => {
            ipcRenderer.send('permission:response', requestId, response);
        }
    });

    safeExposeInMainWorld('applicationRegistryAPI', {
        getApplicationGUIConfig: async (bundleName) => {
            const result = await ipcRenderer.invoke('applicationRegistry:getApplicationGUIConfig', bundleName);
            if (result.status !== 'ok') {
                console.error('getting application GUI config failed', result.message);
                throw new Error(result.message);
            }
            return result.data;
        },
        getApplicationList: async () => {
            const result = await ipcRenderer.invoke('applicationRegistry:getApplicationList');
            if (result.status !== 'ok') {
                console.error('getting application list failed', result.message);
                throw new Error(result.message);
            }
            return result.data;
        },
        onApplicationListChanged: (callback) => {
            const handler = (_event, apps) => callback(apps);
            ipcRenderer.on('applicationRegistry:changed', handler);
            return () => ipcRenderer.removeListener('applicationRegistry:changed', handler);
        },
        call: async (bundleName, methodName, ...args) => {
            const result = await ipcRenderer.invoke('applicationRegistry:call', bundleName, methodName, ...args);
            if (result.status !== 'ok') {
                console.error('calling application failed', bundleName, methodName, result.message);
                throw new Error(result.message);
            }
            return result.data;
        },
        callMainWorld: async (bundleName, methodName, ...args) => {
            const result = await ipcRenderer.invoke(
                'applicationRegistry:callMainWorld',
                bundleName,
                methodName,
                ...args
            );
            if (result.status !== 'ok') {
                console.error('calling application failed', bundleName, methodName, result.message);
                throw new Error(result.message);
            }
            return result.data;
        },
        streamCall: async (bundleName, methodName, callback, ...args) => {
            const result = await ipcRenderer.invoke('applicationRegistry:streamCall', bundleName, methodName, ...args);
            if (result.status !== 'ok') {
                console.error('calling application failed', bundleName, methodName, result.message);
                throw new Error(result.message);
            }

            return new Promise((resolve) => {
                const listener = (_event, chunk) => {
                    if (chunk === undefined) {
                        ipcRenderer.off(`applicationRegistry:streamChunk:${result.requestId}`, listener);
                        resolve();
                    } else {
                        try {
                            callback(chunk);
                        } catch (e) {
                            console.error('stream callback error', e);
                        }
                    }
                };

                ipcRenderer.on(`applicationRegistry:streamChunk:${result.requestId}`, listener);
            });
        },
        streamCallMainWorld: async (bundleName, methodName, callback, ...args) => {
            const result = await ipcRenderer.invoke(
                'applicationRegistry:streamCallMainWorld',
                bundleName,
                methodName,
                ...args
            );
            if (result.status !== 'ok') {
                console.error('calling application failed', bundleName, methodName, result.message);
                throw new Error(result.message);
            }

            return new Promise((resolve) => {
                const listener = (_event, chunk) => {
                    if (chunk === undefined) {
                        ipcRenderer.off(`applicationRegistry:streamChunk:${result.requestId}`, listener);
                        resolve();
                    } else {
                        try {
                            callback(chunk);
                        } catch (e) {
                            console.error('stream callback error', e);
                        }
                    }
                };

                ipcRenderer.on(`applicationRegistry:streamChunk:${result.requestId}`, listener);
            });
        },
        subscribeEvent: async (bundleName, eventName, callback) => {
            const result = await ipcRenderer.invoke('applicationRegistry:subscribe', bundleName, eventName);
            if (result.status !== 'ok') {
                console.error('subscribing event failed', bundleName, eventName, result.message);
                throw new Error(result.message);
            }
            ipcRenderer.on(`applicationRegistry:event:${eventName}`, (event, ...args) => {
                callback(...args);
            });
            // 返回取消订阅函数
            return () => {
                ipcRenderer.removeAllListeners(`applicationRegistry:event:${eventName}`);
                ipcRenderer.invoke('applicationRegistry:unsubscribe', bundleName, eventName);
            };
        },
        openInNewWindow: async (bundleName) => {
            const result = await ipcRenderer.invoke('application:openInNewWindow', bundleName);
            if (result.status !== 'ok') {
                console.error('opening application in new window failed', result.message);
                throw new Error(result.message);
            }
        }
    });

    // Browser API — delegated to embedBrowserUse library
    defineBrowserBridge('browserAPI', contextBridge, ipcRenderer);

    // 下载管理 API
    safeExposeInMainWorld('downloadAPI', {
        getDownloads: async () => {
            const result = await ipcRenderer.invoke('browser:getDownloads');
            if (result.status !== 'ok') throw new Error(result.message);
            return result.data;
        },
        cancelDownload: async (downloadId) => {
            const result = await ipcRenderer.invoke('browser:cancelDownload', downloadId);
            if (result.status !== 'ok') throw new Error(result.message);
        },
        openDownloadFile: async (downloadId) => {
            const result = await ipcRenderer.invoke('browser:openDownloadFile', downloadId);
            if (result.status !== 'ok') throw new Error(result.message);
        },
        openDownloadFolder: async (downloadId) => {
            const result = await ipcRenderer.invoke('browser:openDownloadFolder', downloadId);
            if (result.status !== 'ok') throw new Error(result.message);
        },
        clearDownload: async (downloadId) => {
            await ipcRenderer.invoke('browser:clearDownload', downloadId);
        },
        onDownloadUpdate: (callback) => {
            const handler = (event) => callback(event.detail);
            window.addEventListener('browser-download-update', handler);
            return () => window.removeEventListener('browser-download-update', handler);
        }
    });

    // 桥接下载状态更新：main → IPC → DOM event
    ipcRenderer.on('embedBrowser:download-update', (_event, data) => {
        window.dispatchEvent(new CustomEvent('browser-download-update', { detail: data }));
    });

    safeExposeInMainWorld('contextMenuAPI', {
        suppress: () => ipcRenderer.send('context-menu:suppress')
    });

    // 暴露系统平台信息，用于 magic pointer 等功能的平台适配
    safeExposeInMainWorld('systemInfo', {
        platform: process.platform,
        isMac: process.platform === 'darwin',
        isWindows: process.platform === 'win32',
        isLinux: process.platform === 'linux',
        isOpenHarmony: process.platform === 'openharmony',
        homePath: process.env.USERPROFILE || process.env.HOME || process.env.USER_DATA_PATH || ''
    });

    // 设置加载错误通知 API
    /** @type {Set<(message: string) => void>} */
    const settingErrorCallbacks = new Set();
    ipcRenderer.on('setting:loadError', (_event, message) => {
        for (const cb of settingErrorCallbacks) cb(message);
    });
    safeExposeInMainWorld('settingErrorAPI', {
        onSettingLoadError: (callback) => {
            settingErrorCallbacks.add(callback);
        },
        offSettingLoadError: (callback) => {
            settingErrorCallbacks.delete(callback);
        }
    });

    // 将 webview 内部的键盘事件转发为主 renderer 的合成 KeyboardEvent，
    // 使得快捷键管理器和 magic pointer 在 webview 获焦时仍能工作。
    ipcRenderer.on('webview:keyboard-event', (_event, input) => {
        const modSet = new Set(input.modifiers || []);
        const eventType = input.type === 'keyUp' ? 'keyup' : 'keydown';
        const init = {
            key: input.key,
            code: input.code,
            bubbles: true,
            cancelable: true,
            metaKey: modSet.has('meta'),
            ctrlKey: modSet.has('control'),
            altKey: modSet.has('alt'),
            shiftKey: modSet.has('shift')
        };
        window.dispatchEvent(new KeyboardEvent(eventType, init));
        document.dispatchEvent(new KeyboardEvent(eventType, init));
    });

    ipcRenderer.on('magicPointer:forceExit', () => {
        const event = new CustomEvent('magicPointer:forceExit');
        window.dispatchEvent(event);
        document.dispatchEvent(new CustomEvent('magicPointer:forceExit'));
    });

    // 窗口可见性变化 → DOM 事件，各组件可自行监听并降低刷新率
    ipcRenderer.on('window:visibilityChanged', (_event, visible) => {
        window.dispatchEvent(new CustomEvent('openDesk:visibilityChanged', { detail: visible }));
    });
}
