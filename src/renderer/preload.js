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

function exposeTaskManagerAPI() {
    /** @type {Map<string, Map<string, (toolName: string, args: any) => Promise<string>>>} */
    const taskwiseToolsetCallbacks = new Map();

    contextBridge.exposeInMainWorld('taskManagerAPI', {
        createTask: async (modeId) => {
            const result = await ipcRenderer.invoke('taskManager:createTask', modeId);
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
    contextBridge.exposeInMainWorld('askUserAPI', {
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
    contextBridge.exposeInMainWorld('exitPlanModeAPI', {
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

function exposeFSAPI() {
    contextBridge.exposeInMainWorld('fsAPI', {
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
        searchFilesByNameSimilarity: async (query) => {
            const result = await ipcRenderer.invoke(
                'applicationRegistry:call',
                'filemgr',
                'searchFilesByNameSimilarity',
                query
            );
            if (result.status !== 'ok') {
                console.error('searching files by name similarity failed', result.message);
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

if (window.self !== window.top) {
    /** @type {string | null} */
    let applicationBundleName = null;

    contextBridge.exposeInMainWorld('applicationAPI', {
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

            const listener = (event, chunk) => {
                if (chunk === undefined) {
                    console.info('stream complete', result.requestId);
                    ipcRenderer.off(`applicationRegistry:streamChunk:${result.requestId}`);
                } else {
                    callback(chunk);
                }
            };

            console.info('listener registered', result.requestId);
            ipcRenderer.on(`applicationRegistry:streamChunk:${result.requestId}`, listener);
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

            const listener = (event, chunk) => {
                if (chunk === undefined) {
                    console.info('stream complete', result.requestId);
                    ipcRenderer.off(`applicationRegistry:streamChunk:${result.requestId}`);
                } else {
                    callback(chunk);
                }
            };

            console.info('listener registered', result.requestId);
            ipcRenderer.on(`applicationRegistry:streamChunk:${result.requestId}`, listener);
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

    exposeTaskManagerAPI();
    exposeFSAPI();
} else {
    exposeTaskManagerAPI();
    exposeFSAPI();

    contextBridge.exposeInMainWorld('settingAPI', {
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
        verifyModel: async ({ base_url, api_key, model_name }) => {
            const result = await ipcRenderer.invoke('setting:verifyModel', { base_url, api_key, model_name });
            if (result.status !== 'ok') {
                throw new Error(result.message);
            }
            return result.data;
        },
        fetchProviderModels: async ({ base_url, api_key }) => {
            const result = await ipcRenderer.invoke('setting:fetchProviderModels', { base_url, api_key });
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

    contextBridge.exposeInMainWorld('magicPointerAPI', {
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

    contextBridge.exposeInMainWorld('modeAPI', {
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

    contextBridge.exposeInMainWorld('workspaceAPI', {
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

    contextBridge.exposeInMainWorld('quickpassAPI', {
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

    contextBridge.exposeInMainWorld('notificationAPI', {
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

    contextBridge.exposeInMainWorld('displayAPI', {
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

    contextBridge.exposeInMainWorld('screenAPI', {
        getDisplayScaleFactors: async () => {
            const result = await ipcRenderer.invoke('screen:getDisplayScaleFactors');
            if (result.status !== 'ok') {
                throw new Error(result.message);
            }
            return result.data;
        }
    });

    contextBridge.exposeInMainWorld('floatWindowAPI', {
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
    contextBridge.exposeInMainWorld('permissionAPI', {
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

    contextBridge.exposeInMainWorld('applicationRegistryAPI', {
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
        }
    });

    // Browser API — delegated to embedBrowserUse library
    defineBrowserBridge('browserAPI', contextBridge, ipcRenderer);

    contextBridge.exposeInMainWorld('contextMenuAPI', {
        suppress: () => ipcRenderer.send('context-menu:suppress')
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
}
