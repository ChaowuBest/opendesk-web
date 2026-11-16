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

import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { defineBrowserBridge } from '../common/embedBrowserUse/preload';
import { PermissionPendingStore } from './permissionPendingStore';
import { createTaskListUpdateSubscription } from './taskListSubscription.js';
import { createSettingChangedDispatcher } from './settingChangedSubscription.js';
import { createIpcChannelDispatcher } from './ipcChannelDispatcher.js';
import { createAgentGateFloatingApi } from './agentGateFloatingApi.js';
import {
    createHarmonyRuntimeEnvironment,
    getHarmonyBrowseRoots,
    getHarmonyHomeDirectory
} from '../platforms/bridges/harmonyos/runtime-environment.js';

function resolveRendererHarmonyRuntime() {
    try {
        return createHarmonyRuntimeEnvironment({
            platform: process.platform,
            argv: process.argv,
            environment: process.env
        });
    } catch (error) {
        console.warn('[HarmonyRuntime] Renderer metadata unavailable:', error);
        return null;
    }
}

// 剪贴板桥与编辑菜单宿主标记：放在【所有 expose 之前】独立注册。
// 后续 exposeXXX 任何一处抛异常都会中断 preload 顶层执行，
// 若剪贴板桥排在它们后面，子 frame（如笔记应用的编辑 iframe）就会
// 失去剪贴板能力（自绘菜单的粘贴无反应）。提前注册 + 独立 try-catch
// 保证这两个基础能力不受其他 expose 的影响。
function setupClipboardBridgeEarly() {
    try {
        safeExposeInMainWorld('childFrameClipboard', {
            readText: () => ipcRenderer.invoke('clipboard:readText'),
            writeText: (text) => {
                if (typeof text !== 'string') return Promise.resolve();
                return ipcRenderer.invoke('clipboard:writeText', text);
            }
        });
    } catch (err) {
        console.warn('[Preload] childFrameClipboard expose failed:', err);
    }
    try {
        const markEditMenuHost = () => {
            try {
                if (document.documentElement) {
                    document.documentElement.setAttribute('data-od-lp-edit-menu', '1');
                    return true;
                }
            } catch {
                /* 忽略 */
            }
            return false;
        };
        if (!markEditMenuHost()) {
            document.addEventListener('DOMContentLoaded', markEditMenuHost, { once: true });
            window.addEventListener('load', markEditMenuHost, { once: true });
        }
    } catch (err) {
        console.warn('[Preload] edit menu host mark failed:', err);
    }
    try {
        window.addEventListener('od-clipboard-write', (event) => {
            const text = event?.detail?.text;
            if (typeof text !== 'string' || !text) return;
            ipcRenderer.invoke('clipboard:writeText', text).catch(() => {
                /* 剪贴板不可用时静默 */
            });
        });
        window.addEventListener('od-clipboard-read', (event) => {
            const requestId = event?.detail?.requestId;
            if (typeof requestId !== 'number') return;
            ipcRenderer
                .invoke('clipboard:readText')
                .then((text) => {
                    window.dispatchEvent(new CustomEvent('od-clipboard-read-result', { detail: { requestId, text } }));
                })
                .catch(() => {
                    // 剪贴板不可用时回填空文本，粘贴流程正常收尾
                    window.dispatchEvent(
                        new CustomEvent('od-clipboard-read-result', { detail: { requestId, text: '' } })
                    );
                });
        });
    } catch (err) {
        console.warn('[Preload] clipboard event bridge failed:', err);
    }
}
setupClipboardBridgeEarly();

/**
 * 避免主 frame 上 registerPreloadScript + webPreferences.preload 重复 expose 导致整页 API 失效。
 * @returns {boolean} 当前 preload 是否实际完成了暴露。
 */
function safeExposeInMainWorld(apiKey, api) {
    try {
        contextBridge.exposeInMainWorld(apiKey, api);
        return true;
    } catch (err) {
        const msg = String(err?.message ?? err);
        if (/existing property|already been registered/i.test(msg)) {
            return false;
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
    /** @type {Map<string, (...args: any[]) => void>} */
    const taskListUpdateSubscriptions = new Map();
    const unsubscribeTaskListUpdate = (subscriptionId) => {
        const listener = taskListUpdateSubscriptions.get(subscriptionId);
        if (!listener) return;

        ipcRenderer.removeListener('taskManager:taskListUpdate', listener);
        taskListUpdateSubscriptions.delete(subscriptionId);
        ipcRenderer.send('taskManager:unsubscribeTaskListUpdate', subscriptionId);
    };

    window.addEventListener('beforeunload', () => {
        for (const subscriptionId of [...taskListUpdateSubscriptions.keys()]) {
            unsubscribeTaskListUpdate(subscriptionId);
        }
    });

    const taskManagerExposed = safeExposeInMainWorld('taskManagerAPI', {
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
        releaseTaskMemory: async (taskId) => {
            const result = await ipcRenderer.invoke('taskManager:releaseTaskMemory', taskId);
            if (result.status !== 'ok') {
                // 释放失败不抛错，避免打断关闭流程
                console.error('releasing task memory failed', result.message);
                return;
            }
            return result.data;
        },
        forkTask: async (taskId, upToMessageId) => {
            const result = await ipcRenderer.invoke('taskManager:forkTask', taskId, upToMessageId);
            if (result.status === 'ok') {
                return result.data;
            } else {
                console.error('forking task failed', result.message);
                throw new Error(result.message);
            }
        },
        compactTask: async (taskId) => {
            const result = await ipcRenderer.invoke('taskManager:compactTask', taskId);
            if (result.status === 'ok') {
                return result.data;
            } else {
                console.error('compacting task failed', result.message);
                throw new Error(result.message);
            }
        },
        renameTask: async (taskId, newName) => {
            const result = await ipcRenderer.invoke('taskManager:renameTask', taskId, newName);
            if (result.status !== 'ok') {
                console.error('rename task failed', result.message);
                throw new Error(result.message);
            }
        },
        updateTaskWorkspace: async (taskId, newWorkspace) => {
            const result = await ipcRenderer.invoke('taskManager:updateTaskWorkspace', taskId, newWorkspace);
            if (result.status !== 'ok') {
                console.error('update task workspace failed', result.message);
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
        interruptForNewMessage: async (taskId) => {
            const result = await ipcRenderer.invoke('taskManager:interruptForNewMessage', taskId);
            if (result.status !== 'ok') {
                console.error('interrupting task for new message failed', result.message);
                throw new Error(result.message);
            }
        },
        triggerTaskReview: async (taskId) => {
            const result = await ipcRenderer.invoke('taskManager:triggerTaskReview', taskId);
            if (result.status !== 'ok') {
                console.error('triggering task review failed', result.message);
                throw new Error(result.message);
            }
            return result.data;
        },
        setTaskModel: async (taskId, modelAlias, reasoningEffort) => {
            const result = await ipcRenderer.invoke('taskManager:setTaskModel', taskId, modelAlias, reasoningEffort);
            if (result.status !== 'ok') {
                console.error('setting task model failed', result.message);
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
                const err = new Error(result.message);
                if (result.code) err.code = result.code;
                throw err;
            }
        },
        getTaskInfo: async (taskId) => {
            const result = await ipcRenderer.invoke('taskManager:getTaskInfo', taskId);
            if (result.status === 'ok') {
                return result.data;
            } else {
                console.error('getting task info failed', result.message);
                throw new Error(result.message);
            }
        },
        getContextDiagnostics: async (taskId) => {
            const result = await ipcRenderer.invoke('taskManager:getContextDiagnostics', taskId);
            if (result.status === 'ok') {
                return result.data;
            } else {
                console.error('getting context diagnostics failed', result.message);
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
        getGoalStatus: async (taskId) => {
            const result = await ipcRenderer.invoke('taskManager:getGoalStatus', taskId);
            if (result.status !== 'ok') {
                throw new Error(result.message);
            }
            return result.data;
        },
        createGoal: async (taskId, objective) => {
            const result = await ipcRenderer.invoke('taskManager:createGoal', taskId, objective);
            if (result.status !== 'ok') {
                throw new Error(result.message);
            }
            return result.data;
        },
        editGoal: async (taskId, objective, options) => {
            const result = await ipcRenderer.invoke('taskManager:editGoal', taskId, objective, options);
            if (result.status !== 'ok') {
                throw new Error(result.message);
            }
            return result.data;
        },
        addGoalSupplement: async (taskId, content) => {
            const result = await ipcRenderer.invoke('taskManager:addGoalSupplement', taskId, content);
            if (result.status !== 'ok') {
                throw new Error(result.message);
            }
            return result.data;
        },
        pauseGoal: async (taskId) => {
            const result = await ipcRenderer.invoke('taskManager:pauseGoal', taskId);
            if (result.status !== 'ok') {
                throw new Error(result.message);
            }
            return result.data;
        },
        resumeGoal: async (taskId) => {
            const result = await ipcRenderer.invoke('taskManager:resumeGoal', taskId);
            if (result.status !== 'ok') {
                throw new Error(result.message);
            }
            return result.data;
        },
        clearGoal: async (taskId) => {
            const result = await ipcRenderer.invoke('taskManager:clearGoal', taskId);
            if (result.status !== 'ok') {
                throw new Error(result.message);
            }
            return result.data;
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
        previewTaskImport: async () => {
            const result = await ipcRenderer.invoke('taskManager:previewTaskImport');
            if (result.status !== 'ok') throw new Error(result.message);
            return result.data;
        },
        discardTaskImport: async (token) => {
            await ipcRenderer.invoke('taskManager:discardTaskImport', token);
        },
        importTaskBundle: async (token, selectedIds, workspace) => {
            const result = await ipcRenderer.invoke('taskManager:importTaskBundle', token, selectedIds, workspace);
            if (result.status !== 'ok') throw new Error(result.message);
            return result.data;
        },
        exportTaskBundle: async (selectedIds) => {
            const result = await ipcRenderer.invoke('taskManager:exportTaskBundle', selectedIds);
            if (result.status !== 'ok') throw new Error(result.message);
            return result.data;
        },
        searchTasks: async (query, limit) => {
            const result = await ipcRenderer.invoke('taskManager:searchTasks', query, limit);
            if (result.status !== 'ok') throw new Error('Task search unavailable');
            return result.data;
        },
        subscribeSearchUpdates: (callback) => {
            const listener = (_event, unavailable) => callback(unavailable);
            ipcRenderer.on('taskManager:searchChanged', listener);
            // Listen first, then request a reconciliation when the search UI opens.
            ipcRenderer.send('taskManager:refreshSearchIndex');
            const unsubscribe = () => {
                ipcRenderer.removeListener('taskManager:searchChanged', listener);
                window.removeEventListener('beforeunload', unsubscribe);
            };
            window.addEventListener('beforeunload', unsubscribe);
            return unsubscribe;
        },
        subscribeTaskListUpdate: async (callback) => {
            try {
                const { subscriptionId, listener } = await createTaskListUpdateSubscription(ipcRenderer, callback);
                taskListUpdateSubscriptions.set(subscriptionId, listener);
                return () => unsubscribeTaskListUpdate(subscriptionId);
            } catch (error) {
                console.error('subscribing task list update failed', error);
                throw error;
            }
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
        listFrontendTailCardSections: async (taskId) => {
            const result = await ipcRenderer.invoke('taskManager:listFrontendTailCardSections', taskId);
            if (result.status !== 'ok') {
                console.error('listing TailCard sections failed', result.message);
                throw new Error(result.message);
            }
            return result.data;
        },
        setFrontendTailCardSection: async (taskId, id, content) => {
            const result = await ipcRenderer.invoke('taskManager:setFrontendTailCardSection', taskId, id, content);
            if (result.status !== 'ok') {
                console.error('setting TailCard section failed', result.message);
                throw new Error(result.message);
            }
        },
        removeFrontendTailCardSection: async (taskId, id) => {
            const result = await ipcRenderer.invoke('taskManager:removeFrontendTailCardSection', taskId, id);
            if (result.status !== 'ok') {
                console.error('removing TailCard section failed', result.message);
                throw new Error(result.message);
            }
        },
        setSystemPrompt: (taskId, prompt) => ipcRenderer.invoke('taskManager:setSystemPrompt', taskId, prompt),
        getAttachmentFileSupport: async () => {
            const result = await ipcRenderer.invoke('taskManager:getAttachmentFileSupport');
            if (result.status !== 'ok') {
                console.error('getting attachment file support failed', result.message);
                throw new Error(result.message);
            }
            return result.data;
        },
        submitMessage: async (taskId, message) => {
            const result = await ipcRenderer.invoke('taskManager:submitMessage', taskId, message);
            if (result.status !== 'ok') {
                console.error('submitting message failed', result.message);
                throw new Error(result.message);
            }
            return result.data;
        },
        log: (level, message) => {
            const safeLevel = ['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info';
            ipcRenderer.send('renderer:log', safeLevel, String(message ?? ''));
        },
        rewindToUserMessage: async (taskId, messageId, options = {}) => {
            const result = await ipcRenderer.invoke('taskManager:rewindToUserMessage', taskId, messageId, options);
            if (result.status !== 'ok') {
                console.error('rewinding task message failed', result.message);
                throw new Error(result.message);
            }
            return result.data;
        },
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
        saveExportHtml: async (filePath, html, fontUrls = []) => {
            const result = await ipcRenderer.invoke('taskManager:saveExportHtml', filePath, html, fontUrls);
            if (result.status !== 'ok') {
                console.error('saving export html failed', result.message);
                throw new Error(result.message);
            }
            return result.data;
        },
        exportTaskJson: async (taskId, filePath) => {
            const result = await ipcRenderer.invoke('taskManager:exportTaskJson', taskId, filePath);
            if (result.status !== 'ok') {
                console.error('exporting task json failed', result.message);
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

    // 重复 preload 会拥有独立的空回调表；若继续监听 callTool，会与真正暴露 API
    // 的实例竞态并错误返回 "No toolset callback"。
    if (!taskManagerExposed) {
        return;
    }

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
        getPendingRequest: async (taskId) => {
            const result = await ipcRenderer.invoke('exitPlanMode:getPending', taskId);
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
        },
        getFontPreset: async () => {
            return ipcRenderer.invoke('theme:getFontPreset');
        },
        onFontPresetChanged: (callback) => {
            const handler = (_event, preset) => callback(preset);
            ipcRenderer.on('theme:fontPresetChanged', handler);
            return () => ipcRenderer.removeListener('theme:fontPresetChanged', handler);
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
        showItemInFolder: async (filePath) => {
            const result = await ipcRenderer.invoke('fs:showItemInFolder', filePath);
            if (result.status !== 'ok') {
                console.error('showing item in folder failed', result.message);
                throw new Error(result.message);
            }
        },
        openTrash: async () => {
            const result = await ipcRenderer.invoke('fs:openTrash');
            if (result.status !== 'ok') {
                console.error('opening trash failed', result.message);
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
        watchFile: async (filePath, callback) => {
            const id = globalThis.crypto.randomUUID();
            const listener = (_event, watchId, change) => {
                if (watchId === id) callback(change);
            };
            const dispose = () => {
                ipcRenderer.removeListener('fs:fileChanged', listener);
                ipcRenderer.send('fs:unwatchFile', id);
            };
            ipcRenderer.on('fs:fileChanged', listener);
            try {
                await ipcRenderer.invoke('fs:watchFile', id, filePath);
                return dispose;
            } catch (error) {
                dispose();
                throw error;
            }
        },
        getFileSize: async (filePath) => {
            const result = await ipcRenderer.invoke('fs:getFileSize', filePath);
            if (result.status !== 'ok') throw new Error(result.message);
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

function exposeOfficeHostAPI() {
    const requestCloseChannels = Object.freeze({
        slides: 'office-host:slides:request-close',
        word: 'office-host:word:request-close',
        sheets: 'office-host:sheets:request-close'
    });
    const isOfficeEditorKind = (kind) => Object.prototype.hasOwnProperty.call(requestCloseChannels, kind);
    const openOfficeTaskFileChannel = 'office-host:open-task-file';
    const openOfficeTaskFileResultChannel = 'office-host:open-task-file-result';
    safeExposeInMainWorld('officeHostAPI', {
        prepare: (kind) => {
            if (!isOfficeEditorKind(kind)) return Promise.reject(new Error('Unsupported Office editor'));
            return ipcRenderer.invoke('office-host:prepare', kind);
        },
        refreshFile: (webContentsId, filePath) =>
            ipcRenderer.invoke('office-host:refresh-file', webContentsId, filePath),
        requestClose: (kind, webContentsId) => {
            if (!isOfficeEditorKind(kind)) return Promise.reject(new Error('Unsupported Office editor'));
            return ipcRenderer.invoke(requestCloseChannels[kind], webContentsId);
        },
        bindOfficeTask: (kind, taskId, filePath, webContentsId) => {
            if (!isOfficeEditorKind(kind) || !taskId || !filePath || !Number.isInteger(webContentsId)) {
                return Promise.resolve(false);
            }
            return ipcRenderer.invoke('office-host:bind-task', kind, taskId, filePath, webContentsId);
        },
        onOpenOfficeTaskFile: (callback) => {
            const listener = (_event, request) => callback(request);
            ipcRenderer.on(openOfficeTaskFileChannel, listener);
            return () => ipcRenderer.removeListener(openOfficeTaskFileChannel, listener);
        },
        reportOpenOfficeTaskFileResult: (requestId, status) => {
            if (!requestId || (status !== 'not_opened' && status !== 'failed')) return;
            ipcRenderer.send(openOfficeTaskFileResultChannel, { requestId, status });
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

    /**
     * 事件名 → 该事件在本 frame 的分发器。同一应用内可能有多个组件订阅同一事件
     * （也可能与主世界侧 applicationRegistryAPI.subscribeEvent 共享同一 IPC 通道），
     * 因此退订必须精确到自己的订阅，不能用 removeAllListeners（issue #116）。
     *
     * 注意：不能按 callback 引用匹配来退订 —— contextBridge 跨上下文传函数时会重新
     * 包装，同一个函数两次传入 preload 拿到的引用并不相等（实测 false）。
     * 精确退订一律使用 subscribe() 返回的 unsubscribe。
     */
    const applicationEventDispatchers = new Map();
    /** 事件名 → 本 frame 已登记的订阅项（只持有各自的 release） */
    const applicationEventSubscriptions = new Map();

    function trackApplicationEventSubscription(eventName, callback) {
        let dispatcher = applicationEventDispatchers.get(eventName);
        if (dispatcher === undefined) {
            dispatcher = createIpcChannelDispatcher(ipcRenderer, `applicationRegistry:event:${eventName}`);
            applicationEventDispatchers.set(eventName, dispatcher);
        }
        const entry = { release: dispatcher.subscribe(callback) };
        let entries = applicationEventSubscriptions.get(eventName);
        if (entries === undefined) {
            entries = [];
            applicationEventSubscriptions.set(eventName, entries);
        }
        entries.push(entry);
        return entry;
    }

    function dropApplicationEventSubscription(eventName, entry) {
        const entries = applicationEventSubscriptions.get(eventName);
        if (entries === undefined) return false;
        const index = entries.indexOf(entry);
        if (index < 0) return false;
        entries.splice(index, 1);
        if (entries.length === 0) {
            applicationEventSubscriptions.delete(eventName);
            // 该事件在本 frame 已无订阅：连同分发器一起丢掉，别让 Map 只增不减
            applicationEventDispatchers.delete(eventName);
        }
        entry.release();
        return true;
    }

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
                const listener = (event, chunk, error) => {
                    if (chunk === undefined) {
                        console.info('stream complete', result.requestId);
                        ipcRenderer.off(`applicationRegistry:streamChunk:${result.requestId}`, listener);
                        if (error) {
                            reject(new Error(error));
                        } else {
                            resolve();
                        }
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
                const listener = (event, chunk, error) => {
                    if (chunk === undefined) {
                        console.info('stream complete', result.requestId);
                        ipcRenderer.off(`applicationRegistry:streamChunk:${result.requestId}`, listener);
                        if (error) {
                            reject(new Error(error));
                        } else {
                            resolve();
                        }
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
            const entry = trackApplicationEventSubscription(eventName, callback);
            // 返回的 unsubscribe 是唯一能精确退订本订阅的方式（无法按 callback 引用匹配）
            // 每次订阅对应一次 main 侧引用计数，退订时配对递减
            return () => {
                if (!dropApplicationEventSubscription(eventName, entry)) return;
                void ipcRenderer
                    .invoke('applicationRegistry:unsubscribe', applicationBundleName, eventName)
                    .catch((error) => console.error('unsubscribing event failed', eventName, error));
            };
        },
        unsubscribe: async (eventName) => {
            const entries = applicationEventSubscriptions.get(eventName);
            // 本 frame 没有该事件的登记（从未订阅 / 已被 subscribe 返回的 unsubscribe 退掉）：
            // 不动 main 侧 —— main 的引用计数按 (事件, frame) 记，这里每多减一次就会把本 frame
            // 上通过 applicationRegistryAPI.subscribeEvent 注册的订阅者一起减掉（issue #116 同类）。
            if (entries === undefined) return;
            const targets = [...entries];
            // 每条登记对应 main 侧一次计数：先摘本地登记，再逐条配对递减。
            // 单条失败只记日志 —— 既不影响其余条目，也不把 fire-and-forget 的调用点
            // 变成未处理 rejection
            for (const entry of targets) {
                dropApplicationEventSubscription(eventName, entry);
                try {
                    const result = await ipcRenderer.invoke(
                        'applicationRegistry:unsubscribe',
                        applicationBundleName,
                        eventName
                    );
                    if (result.status !== 'ok') {
                        console.error('unsubscribing event failed', eventName, result.message);
                    }
                } catch (error) {
                    console.error('unsubscribing event failed', eventName, error);
                }
            }
        }
    });
}

/** 子应用和主窗口共用的交互式终端桥；主进程负责校验会话归属。 */
function exposeInteractiveTerminalAPI() {
    const dataListeners = new Set();
    const exitListeners = new Set();
    const dataHandler = (_event, payload) => {
        for (const listener of dataListeners) listener(payload);
    };
    const exitHandler = (_event, payload) => {
        for (const listener of exitListeners) listener(payload);
    };
    ipcRenderer.on('terminal:data', dataHandler);
    ipcRenderer.on('terminal:exit', exitHandler);

    const invoke = async (channel, ...args) => {
        const result = await ipcRenderer.invoke(channel, ...args);
        if (result.status !== 'ok') throw new Error(result.message);
        return result.data;
    };

    safeExposeInMainWorld('terminalAPI', {
        listProfiles: () => invoke('terminal:listProfiles'),
        create: (options) => invoke('terminal:create', options),
        start: (sessionId) => invoke('terminal:start', sessionId),
        write: (sessionId, data) => invoke('terminal:write', sessionId, data),
        resize: (sessionId, cols, rows) => invoke('terminal:resize', sessionId, cols, rows),
        close: (sessionId) => invoke('terminal:close', sessionId),
        acknowledge: (sessionId, count) => invoke('terminal:acknowledge', sessionId, count),
        onData: (callback) => {
            dataListeners.add(callback);
            return () => dataListeners.delete(callback);
        },
        onExit: (callback) => {
            exitListeners.add(callback);
            return () => exitListeners.delete(callback);
        }
    });
}

// 文件回收站：统一回收站的搜索、找回与任务上下文（GUI 文件回收站弹窗使用）
function exposeTrashAPI() {
    safeExposeInMainWorld('trashAPI', {
        search: async (options) => {
            const result = await ipcRenderer.invoke('trash:search', options);
            if (result.status !== 'ok') {
                console.error('searching trash failed', result.message);
                throw new Error(result.message);
            }
            return result.data;
        },
        restore: async (taskId, uuid, overwrite) => {
            const result = await ipcRenderer.invoke('trash:restore', { taskId, uuid, overwrite });
            if (result.status !== 'ok') {
                console.error('restoring trash entry failed', result.message);
                throw new Error(result.message);
            }
            return result.data;
        },
        openEntry: async (taskId, uuid) => {
            const result = await ipcRenderer.invoke('trash:openEntry', { taskId, uuid });
            if (result.status !== 'ok') {
                console.error('opening trash entry failed', result.message);
                throw new Error(result.message);
            }
            return result.data;
        },
        getTaskContext: async (taskId) => {
            const result = await ipcRenderer.invoke('trash:getTaskContext', taskId);
            if (result.status !== 'ok') {
                console.error('loading trash task context failed', result.message);
                throw new Error(result.message);
            }
            return result.data;
        }
    });
}

exposeApplicationAPI();
exposeInteractiveTerminalAPI();
exposeTaskManagerAPI();
exposeFSAPI();
exposeTrashAPI();
exposeOfficeHostAPI();
exposeThemeAPI();
exposeOpenDeskAppAPI();
exposeNativeBridgeAPI();

// 剪贴板桥与编辑菜单宿主标记已提前至 preload 顶部注册（setupClipboardBridgeEarly）：
// 后续 exposeXXX 抛异常时不再影响这两个基础能力。

// 通用窗口控制 API（主窗口和应用窗口均可使用）
safeExposeInMainWorld('windowControlAPI', {
    close: () => ipcRenderer.invoke('window:close'),
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    isMaximized: async () => {
        const result = await ipcRenderer.invoke('window:isMaximized');
        if (result.status !== 'ok') return false;
        return result.data;
    },
    quitApp: () => ipcRenderer.invoke('app:quit')
});

function isMainFramePreload() {
    try {
        return window.self === window.top;
    } catch {
        return true;
    }
}

// renderer 心跳：主进程据此判断主窗口是否冻结（见 main/utils/window-recovery.ts）。
// 仅 main frame 上报，避免 iframe preload 重复发送；主进程会过滤非主窗口的来源。
if (isMainFramePreload()) {
    const sendHeartbeat = () => {
        try {
            ipcRenderer.send('renderer:heartbeat');
        } catch {
            // 窗口销毁过程中 IPC 通道可能已不可用，心跳丢失由主进程超时兜底
        }
    };
    // 主进程探活：窗口被遮挡时心跳定时器会被节流，主进程改经 IPC 唤醒 renderer 立即补报一次；
    // IPC 不受定时器节流影响，能回应即说明主线程未冻结（见 main/utils/window-recovery.ts）。
    ipcRenderer.on('renderer:heartbeat-probe', sendHeartbeat);
    sendHeartbeat();
    setInterval(sendHeartbeat, 3000);
}

if (shouldExposeMainWindowAPIs()) {
    // Linux 阴影窗口的内容边缘 resize（见 main 进程 windows/shadow-resize.ts）。
    // options.driver='pointer'（触摸屏/手写笔）时附带按下点，主进程改用本侧
    // move 上报的窗口内坐标驱动；鼠标不传 driver，仍由主进程轮询光标。
    safeExposeInMainWorld('shadowResizeAPI', {
        start: (direction, options) => {
            ipcRenderer.send('window:shadowResizeStart', direction, options);
        },
        move: (x, y) => {
            ipcRenderer.send('window:shadowResizeMove', { x, y });
        },
        end: () => {
            ipcRenderer.send('window:shadowResizeEnd');
        }
    });

    // Linux 顶部拖拽层的手动拖动（见 main 进程 windows/window-drag.ts）：
    // drag region 在 Linux 会触发 GTK 标题栏右键 WM 系统菜单，拖拽层已改为
    // no-drag（titlebar.css）。driver='cursor'（鼠标）由主进程轮询光标驱动整窗
    // 移动；driver='pointer'（触摸屏/手写笔）不更新系统光标，改由 move 上报
    // 指针在窗口内的坐标（start 与 move 的坐标同一坐标系，主进程自行换算）。
    safeExposeInMainWorld('windowDragAPI', {
        start: (grabX, grabY, driver) => {
            ipcRenderer.send('window:dragStart', { x: grabX, y: grabY, driver });
        },
        move: (x, y) => {
            ipcRenderer.send('window:dragMove', { x, y });
        },
        end: () => {
            ipcRenderer.send('window:dragEnd');
        }
    });

    safeExposeInMainWorld('updateAPI', {
        getState: async () => {
            const result = await ipcRenderer.invoke('updater:getState');
            if (result.status !== 'ok') throw new Error(result.message);
            return result.data;
        },
        check: async () => {
            const result = await ipcRenderer.invoke('updater:check');
            if (result.status !== 'ok') throw new Error(result.message);
            return result.data;
        },
        restart: async () => {
            const result = await ipcRenderer.invoke('updater:restart');
            if (result.status !== 'ok') throw new Error(result.message);
            return result.data;
        },
        onStateChanged: (callback) => {
            const listener = (_event, state) => callback(state);
            ipcRenderer.on('updater:stateChanged', listener);
            return () => ipcRenderer.removeListener('updater:stateChanged', listener);
        }
    });
    safeExposeInMainWorld('memoryAPI', {
        getUserPortrait: async () => {
            const result = await ipcRenderer.invoke('memory:getUserPortrait');
            if (result.status !== 'ok') {
                console.error('loading user portrait failed', result.message);
                throw new Error(result.message);
            }
            return result.data;
        },
        listMemories: async () => {
            const result = await ipcRenderer.invoke('memory:listMemories');
            if (result.status !== 'ok') {
                console.error('loading memories failed', result.message);
                throw new Error(result.message);
            }
            return result.data;
        },
        updateUserPortrait: async (content) => {
            const result = await ipcRenderer.invoke('memory:updateUserPortrait', content);
            if (result.status !== 'ok') {
                console.error('updating user portrait failed', result.message);
                throw new Error(result.message);
            }
            return result.data;
        },
        updateMemory: async (uid, title, content) => {
            const result = await ipcRenderer.invoke('memory:updateMemory', uid, title, content);
            if (result.status !== 'ok') {
                console.error('updating memory failed', result.message);
                throw new Error(result.message);
            }
            return result.data;
        },
        removeMemory: async (uid) => {
            const result = await ipcRenderer.invoke('memory:removeMemory', uid);
            if (result.status !== 'ok') {
                console.error('removing memory failed', result.message);
                throw new Error(result.message);
            }
            return result.data;
        },
        cleanupMemories: async () => {
            const result = await ipcRenderer.invoke('memory:cleanup');
            if (result.status !== 'ok') {
                console.error('cleaning up memories failed', result.message);
                throw new Error(result.message);
            }
            return result.data;
        }
    });

    safeExposeInMainWorld('usageAPI', {
        getDashboardSummary: async (params) => {
            const result = await ipcRenderer.invoke('usage:getDashboardSummary', params);
            if (result.status !== 'ok') {
                console.error('loading usage dashboard summary failed', result.message);
                throw new Error(result.message);
            }
            return result.data;
        },
        getRankings: async (params) => {
            const result = await ipcRenderer.invoke('usage:getRankings', params);
            if (result.status !== 'ok') {
                console.error('loading usage rankings failed', result.message);
                throw new Error(result.message);
            }
            return result.data;
        }
    });

    safeExposeInMainWorld('desktopAPI', {
        loadCards: async () => {
            const result = await ipcRenderer.invoke('desktop:loadCards');
            if (result.status !== 'ok') {
                console.error('loading desktop cards failed', result.message);
                throw new Error(result.message);
            }
            return result.data;
        },
        saveCards: async (cards) => {
            const result = await ipcRenderer.invoke('desktop:saveCards', cards);
            if (result.status !== 'ok') {
                console.error('saving desktop cards failed', result.message);
                throw new Error(result.message);
            }
        },
        // 返回完整结果对象（含 status/taskId），不抛异常——
        // contextBridge 会对抛出的 Error 做序列化，自定义属性（taskId）会丢失
        generateCardContent: async (input) => {
            return ipcRenderer.invoke('desktop:generateCardContent', input);
        }
    });

    // setting:changed 的订阅者众多（各组件翻译器/特性开关），收敛到单个 IPC listener
    // 分发，避免每个订阅者直接挂 ipcRenderer 触发 MaxListenersExceededWarning
    const settingChangedDispatcher = createSettingChangedDispatcher(ipcRenderer);

    // 保存设置的两个 API 共用同一次 IPC 调用与失败处理，只是暴露的字段不同
    async function invokeSaveSettingObject(settingObject) {
        const result = await ipcRenderer.invoke('setting:saveSettingObject', settingObject);
        if (result.status !== 'ok') {
            console.error('saving setting object failed', result.message);
            throw new Error(result.message);
        }
        return result;
    }

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
        listShells: () => ipcRenderer.invoke('setting:listShells'),
        loadSettingObject: async () => {
            const result = await ipcRenderer.invoke('setting:loadSettingObject');
            if (result.status !== 'ok') {
                console.error('loading setting object failed', result.message);
                throw new Error(result.message);
            }
            return result.data;
        },
        saveSettingObject: async (settingObject) => (await invokeSaveSettingObject(settingObject)).data,
        // 与 saveSettingObject 相同，但同时带回「已落盘、但未能立即生效」的步骤信息。
        // 单列一个 API 而不是塞进 saveSettingObject 的返回值：后者被多处调用，返回值必须是
        // 设置对象本身；失败信息也必须与发起它的那次调用绑定，用模块级变量跨调用共享
        // 会让 A 次保存的失败被 B 次调用读到（误报），或被 B 次调用覆盖掉（漏报）。
        saveSettingObjectDetailed: async (settingObject) => {
            const result = await invokeSaveSettingObject(settingObject);
            return {
                data: result.data,
                sideEffectFailures: Array.isArray(result.sideEffectFailures) ? result.sideEffectFailures : []
            };
        },
        onSettingChanged: (callback) => settingChangedDispatcher.subscribe(callback),
        isFullscreen: async () => {
            const result = await ipcRenderer.invoke('setting:isFullscreen');
            if (result.status !== 'ok') {
                throw new Error(result.message);
            }
            return result.data;
        },
        setFullscreen: async (fullscreen) => {
            const result = await ipcRenderer.invoke('setting:setFullscreen', fullscreen);
            if (result.status !== 'ok') {
                throw new Error(result.message);
            }
            return result.data;
        },
        openDevTools: () => ipcRenderer.invoke('setting:openDevTools'),
        openConfigDirectory: () => ipcRenderer.invoke('setting:openConfigDirectory'),
        openLogWindow: () => ipcRenderer.invoke('setting:openLogWindow'),
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
        // 提交用户反馈（feature / bug）。附件由 main 侧按勾选读取并截断，
        // renderer 只传是否勾选与当前任务 id。
        submitFeedback: (submission) => ipcRenderer.invoke('feedback:submit', submission),
        exportLogEntries: async (options) => {
            const result = await ipcRenderer.invoke('setting:exportLogEntries', options);
            if (result.status !== 'ok') {
                console.error('exporting log entries failed', result.message);
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
        isFullScreen: async () => {
            const result = await ipcRenderer.invoke('setting:isFullScreen');
            if (result.status !== 'ok') {
                return false;
            }
            return result.data;
        },
        // 主进程在窗口 maximize/unmaximize 事件时主动推送（X11 下 WM 异步应用
        // 状态，invoke 返回后立即回查 isMaximized 会拿到旧值）
        onMaximizeStateChanged: (callback) => {
            ipcRenderer.on('setting:maximizeStateChanged', (_event, maximized) => {
                callback(maximized);
            });
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
        verifyModel: async ({
            base_url,
            api_key,
            provider_type,
            model_name,
            model_type,
            custom_headers,
            no_proxy,
            no_ssl
        }) => {
            const result = await ipcRenderer.invoke('setting:verifyModel', {
                base_url,
                api_key,
                provider_type,
                model_name,
                model_type,
                custom_headers,
                no_proxy,
                no_ssl
            });
            if (result.status !== 'ok') {
                throw new Error(result.message);
            }
            return result.data;
        },
        fetchProviderModels: async ({ base_url, api_key, provider_type, no_proxy, no_ssl }) => {
            const result = await ipcRenderer.invoke('setting:fetchProviderModels', {
                base_url,
                api_key,
                provider_type,
                no_proxy,
                no_ssl
            });
            if (result.status !== 'ok') {
                throw new Error(result.message);
            }
            return result.data;
        },
        getVersion: async () => {
            const result = await ipcRenderer.invoke('setting:getAppVersion');
            if (result.status !== 'ok') {
                throw new Error(result.message);
            }
            return result.data;
        },
        getBuildTime: async () => {
            const result = await ipcRenderer.invoke('setting:getBuildTime');
            if (result.status !== 'ok') {
                throw new Error(result.message);
            }
            return result.data;
        },
        estimateContextSize: async (modelName) => {
            const result = await ipcRenderer.invoke('setting:estimateContextSize', modelName);
            if (result.status !== 'ok') return 0;
            return result.data;
        },
        estimateMaxOutputTokens: async (modelName) => {
            const result = await ipcRenderer.invoke('setting:estimateMaxOutputTokens', modelName);
            if (result.status !== 'ok') return 0;
            return result.data;
        },
        checkVisionSupport: async (models) => {
            const result = await ipcRenderer.invoke('model:checkVisionSupport', models);
            return result;
        },
        checkReasoningEfforts: async (models) => {
            const result = await ipcRenderer.invoke('model:checkReasoningEfforts', models);
            return result;
        }
    });

    const modeDispatchers = {
        changed: createIpcChannelDispatcher(ipcRenderer, 'mode:changed'),
        taskModeChanged: createIpcChannelDispatcher(ipcRenderer, 'mode:taskModeChanged')
    };

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
        onModeChanged: (callback) => modeDispatchers.changed.subscribe((modeId) => callback(modeId)),
        onTaskModeChanged: (callback) =>
            modeDispatchers.taskModeChanged.subscribe((taskId, modeId) => callback(taskId, modeId))
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
        },
        setDefaultExecutionNode: async (nodeId, label = '') => {
            const result = await ipcRenderer.invoke('node:setDefaultExecutionNode', nodeId, label);
            if (result.status !== 'ok') {
                throw new Error(result.message);
            }
        },
        getDefaultExecutionNode: async () => {
            const result = await ipcRenderer.invoke('node:getDefaultExecutionNode');
            if (result.status !== 'ok') {
                throw new Error(result.message);
            }
            return result.data;
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
        pickDirectoryDialog: async () => {
            const result = await ipcRenderer.invoke('workspace:pickDirectoryDialog');
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
            await ipcRenderer.invoke('clipboard:writeText', result.data);
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

    const notificationDispatcher = createIpcChannelDispatcher(ipcRenderer, 'notification:notificationReceived');

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
            await ipcRenderer.invoke('notification:subscribeNotification');
            return notificationDispatcher.subscribe((...args) => callback(...args));
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

    // 每个订阅返回只移除自己的 unsubscribe：同 renderer 中可能有多个 consumer
    // （如被缓存的多个 task-view）订阅同一通道，退订不得波及其他 consumer（issue #116）。
    safeExposeInMainWorld('agentGateFloatingAPI', createAgentGateFloatingApi(ipcRenderer));

    safeExposeInMainWorld('floatWindowAPI', {
        hideFloatWindow: () => ipcRenderer.invoke('floatWindow:hideFloatWindow'),
        subscribeIntentsUpdate: (callback) => {
            ipcRenderer.on('floatWindow:intentsUpdate', (event, ...args) => {
                callback(...args);
            });
        }
    });

    // AgentGate 存储超限提醒：主进程低频轮询 storage_stats，跨阈值边沿时推送此 channel。
    // 与浮窗 eventsUpdate 独立——浮窗关闭时存储超限仍会提醒。
    safeExposeInMainWorld('agentgateStorageAPI', {
        onStorageOversize: (callback) => {
            const listener = (_event, data) => callback(data);
            ipcRenderer.on('agentgate:storageOversize', listener);
            return () => ipcRenderer.removeListener('agentgate:storageOversize', listener);
        },
        // 主窗口确认后调用：删除全部 tool_calls + 清空拦截记录（main-process 转发，实际删除在 worker）
        cleanupAll: async () => {
            const result = await ipcRenderer.invoke('agentgate:cleanupStorage');
            return result.status === 'ok' ? result.data : { error: result.message };
        }
    });

    // 任务状态浮窗 API：主窗口不在前台时右上角常驻小窗（胶囊/卡片）使用。
    safeExposeInMainWorld('taskStatusWidgetAPI', {
        platform: process.platform,
        getSummary: () => ipcRenderer.invoke('taskStatusWidget:getSummary'),
        restoreMainWindow: () => ipcRenderer.invoke('taskStatusWidget:restoreMainWindow'),
        setCollapsed: (collapsed) => ipcRenderer.invoke('taskStatusWidget:setCollapsed', collapsed),
        openTask: (taskId) => ipcRenderer.invoke('taskStatusWidget:openTask', taskId),
        // 关闭菜单 · 关闭一次：本次触发周期内不再显示。
        hideWidget: () => ipcRenderer.invoke('taskStatusWidget:hide'),
        // 关闭菜单 · 下次启动恢复：本次会话内不再显示。
        disableForSession: () => ipcRenderer.invoke('taskStatusWidget:disableSession'),
        // 关闭菜单 · 永久：renderer 确认后保存关闭设置。
        closePermanently: () => ipcRenderer.invoke('taskStatusWidget:closePermanently'),
        notifyWaitingForInput: (taskId, waiting) => ipcRenderer.send('taskStatusWidget:notifyWaiting', taskId, waiting),
        // Linux 手动拖拽：与主窗口 windowDragAPI 同一套驱动约定——鼠标由主进程轮询光标，
        // 触摸屏/手写笔上报窗口内坐标（见 main 进程 windows/window-drag.ts）。
        dragStart: (grabX, grabY, driver) => {
            ipcRenderer.send('taskStatusWidget:dragStart', { x: grabX, y: grabY }, driver);
        },
        dragMove: (x, y) => {
            ipcRenderer.send('taskStatusWidget:dragMove', { x, y });
        },
        dragEnd: () => ipcRenderer.send('taskStatusWidget:dragEnd'),
        onSummaryUpdate: (callback) => {
            const listener = (_event, summary) => callback(summary);
            ipcRenderer.on('taskStatusWidget:summaryUpdate', listener);
            return () => ipcRenderer.removeListener('taskStatusWidget:summaryUpdate', listener);
        }
    });

    // permission 使用事件广播模式，每个 task-view 中的组件都可以按 taskId 过滤。
    // 请求需要在 preload 层保留，避免 task-view 重渲染时丢失已经发出的队首权限请求。
    const permissionStore = new PermissionPendingStore();
    ipcRenderer.on('permission:request', (_event, requestId, data) => {
        permissionStore.receiveRequest(requestId, data);
    });
    ipcRenderer.on('permission:dismiss', (_event, requestId) => {
        permissionStore.receiveDismiss(requestId);
    });
    safeExposeInMainWorld('permissionAPI', {
        onPermissionRequest: (callback) => {
            permissionStore.onRequest(callback);
        },
        offPermissionRequest: (callback) => {
            permissionStore.offRequest(callback);
        },
        onPermissionDismiss: (callback) => {
            permissionStore.onDismiss(callback);
        },
        offPermissionDismiss: (callback) => {
            permissionStore.offDismiss(callback);
        },
        respondPermission: (requestId, response) => {
            permissionStore.respond(requestId);
            ipcRenderer.send('permission:response', requestId, response);
        }
    });

    // closeWindow: 主窗口关闭时由 main 进程发起，renderer 显示自定义弹窗后回传用户选择
    const closeWindowRequestCallbacks = new Set();
    ipcRenderer.on('closeWindow:request', (_event, requestId) => {
        for (const cb of closeWindowRequestCallbacks) cb(requestId);
    });
    safeExposeInMainWorld('closeWindowAPI', {
        onCloseWindowRequest: (callback) => {
            closeWindowRequestCallbacks.add(callback);
        },
        offCloseWindowRequest: (callback) => {
            closeWindowRequestCallbacks.delete(callback);
        },
        respondCloseWindow: (requestId, response) => {
            ipcRenderer.send('closeWindow:response', requestId, response);
        }
    });

    safeExposeInMainWorld('applicationRegistryAPI', {
        ensureFullyLoaded: async () => {
            const result = await ipcRenderer.invoke('applicationRegistry:ensureFullyLoaded');
            if (result.status !== 'ok') {
                throw new Error(result.message);
            }
        },
        ensureApplicationLoaded: async (bundleName) => {
            const result = await ipcRenderer.invoke('applicationRegistry:ensureApplicationLoaded', bundleName);
            if (result.status !== 'ok') {
                throw new Error(result.message);
            }
        },
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

            return new Promise((resolve, reject) => {
                const listener = (_event, chunk, error) => {
                    if (chunk === undefined) {
                        ipcRenderer.off(`applicationRegistry:streamChunk:${result.requestId}`, listener);
                        if (error) {
                            reject(new Error(error));
                        } else {
                            resolve();
                        }
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

            return new Promise((resolve, reject) => {
                const listener = (_event, chunk, error) => {
                    if (chunk === undefined) {
                        ipcRenderer.off(`applicationRegistry:streamChunk:${result.requestId}`, listener);
                        if (error) {
                            reject(new Error(error));
                        } else {
                            resolve();
                        }
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
            const channel = `applicationRegistry:event:${eventName}`;
            const listener = (event, ...args) => {
                callback(...args);
            };
            ipcRenderer.on(channel, listener);
            // 返回取消订阅函数
            return () => {
                ipcRenderer.removeListener(channel, listener);
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

    const harmonyRuntime = resolveRendererHarmonyRuntime();

    // 主窗口创建时通过 additionalArguments 带来的有效 zoom factor（含平台补偿）。
    // renderer 的 CSS 长度是 CSS 像素，需按它反算窗口阴影边距等要与 main 侧 DIP
    // 对齐的尺寸；首帧前必须同步可得，运行时变更以 display:scaleFactorChanged 为准。
    const zoomArg = process.argv.find((item) => item.startsWith('--opendesk-zoom='));
    const zoomArgValue = zoomArg ? Number(zoomArg.split('=')[1]) : 1;
    const initialZoomFactor = Number.isFinite(zoomArgValue) && zoomArgValue > 0 ? zoomArgValue : 1;

    // 暴露系统平台信息，用于路径选择等功能的平台适配
    safeExposeInMainWorld('systemInfo', {
        platform: process.platform,
        isMac: process.platform === 'darwin',
        isWindows: process.platform === 'win32',
        isLinux: process.platform === 'linux',
        isOpenHarmony: process.platform === 'openharmony',
        initialZoomFactor,
        homePath: harmonyRuntime
            ? getHarmonyHomeDirectory(harmonyRuntime)
            : process.env.USERPROFILE || process.env.HOME || process.env.USER_DATA_PATH || '',
        harmonyRuntime: harmonyRuntime
            ? {
                  ...harmonyRuntime,
                  browseRoots: getHarmonyBrowseRoots(harmonyRuntime)
              }
            : null
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

    // 恶意技能黑名单提示 API
    /** @type {Set<(data: object) => void>} */
    const skillBlacklistCallbacks = new Set();
    ipcRenderer.on('skill:blacklistPrompt', (_event, data) => {
        for (const cb of skillBlacklistCallbacks) cb(data);
    });
    safeExposeInMainWorld('skillBlacklistAPI', {
        onBlacklistPrompt: (callback) => {
            skillBlacklistCallbacks.add(callback);
        },
        offBlacklistPrompt: (callback) => {
            skillBlacklistCallbacks.delete(callback);
        },
        addToBlacklist: (items) => {
            ipcRenderer.send('skill:blacklist:add', items);
        },
        dismissBlacklist: (taskId) => {
            ipcRenderer.send('skill:blacklist:dismiss', taskId);
        }
    });

    safeExposeInMainWorld('accountAPI', {
        getConfig: async () => {
            const result = await ipcRenderer.invoke('account:getConfig');
            if (result.status !== 'ok') throw new Error(result.message);
            return result.data;
        },
        configure: async (patch) => {
            const result = await ipcRenderer.invoke('account:configure', patch);
            if (result.status !== 'ok') throw new Error(result.message);
            return result.data;
        },
        isSetupComplete: async () => {
            const result = await ipcRenderer.invoke('account:isSetupComplete');
            if (result.status !== 'ok') throw new Error(result.message);
            return result.data;
        },
        isAvailable: async (kind) => {
            const result = await ipcRenderer.invoke('account:isAvailable', kind);
            if (result.status !== 'ok') throw new Error(result.message);
            return result.data;
        },
        getSession: async () => {
            const result = await ipcRenderer.invoke('account:getSession');
            if (result.status !== 'ok') throw new Error(result.message);
            return result.data;
        },
        getUserInfo: async () => {
            const result = await ipcRenderer.invoke('account:getUserInfo');
            if (result.status !== 'ok') throw new Error(result.message);
            return result.data;
        },
        getLoginMethods: async (kind) => {
            const result = await ipcRenderer.invoke('account:getLoginMethods', kind);
            if (result.status !== 'ok') throw new Error(result.message);
            return result.data;
        },
        startLogin: async (kind, methodId) => {
            const result = await ipcRenderer.invoke('account:startLogin', kind, methodId);
            if (result.status !== 'ok') throw new Error(result.message);
            return result.data;
        },
        submitLogin: async (flowId, values) => {
            const result = await ipcRenderer.invoke('account:submitLogin', flowId, values);
            if (result.status !== 'ok') throw new Error(result.message);
            return result.data;
        },
        pollLogin: async (flowId) => {
            const result = await ipcRenderer.invoke('account:pollLogin', flowId);
            if (result.status !== 'ok') throw new Error(result.message);
            return result.data;
        },
        cancelLogin: async (flowId) => {
            const result = await ipcRenderer.invoke('account:cancelLogin', flowId);
            if (result.status !== 'ok') throw new Error(result.message);
            return result.data;
        },
        updateDisplayName: async (displayName) => {
            const result = await ipcRenderer.invoke('account:updateDisplayName', displayName);
            if (result.status !== 'ok') throw new Error(result.message);
            return result.data;
        },
        refreshToken: async () => {
            const result = await ipcRenderer.invoke('account:refreshToken');
            if (result.status !== 'ok') throw new Error(result.message);
            return result.data;
        },
        logout: async () => {
            const result = await ipcRenderer.invoke('account:logout');
            if (result.status !== 'ok') throw new Error(result.message);
            return result.data;
        },
        onSessionChanged: (callback) => {
            const listener = (_event, session) => callback(session);
            ipcRenderer.on('account:sessionChanged', listener);
            return () => ipcRenderer.removeListener('account:sessionChanged', listener);
        }
    });

    // 将 webview 内部的键盘事件转发为主 renderer 的合成 KeyboardEvent，
    // 使得快捷键管理器在 webview 获焦时仍能工作。
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

    // 窗口可见性变化 → DOM 事件，各组件可自行监听并降低刷新率
    ipcRenderer.on('window:visibilityChanged', (_event, visible) => {
        window.dispatchEvent(new CustomEvent('openDesk:visibilityChanged', { detail: visible }));
    });
}
