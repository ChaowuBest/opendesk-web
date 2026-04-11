/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 *
 * Web Debug Mode: 在纯浏览器环境中用 fetch + WebSocket 模拟 Electron preload.js 提供的所有 API。
 * 通过在 index.html 中以 <script> 引入来取代 contextBridge.exposeInMainWorld。
 */

(function () {
    const API_BASE = 'http://localhost:3001';
    const WS_URL = 'ws://localhost:3001';

    // --- WebSocket 管理 ---
    let ws = null;
    let wsReady = false;
    const wsCallbacks = new Map(); // subscriptionId -> callback
    let taskListCallback = null;
    let pendingMessages = [];

    function ensureWS() {
        if (ws && ws.readyState === WebSocket.OPEN) return;
        if (ws && ws.readyState === WebSocket.CONNECTING) return;

        ws = new WebSocket(WS_URL);
        ws.onopen = () => {
            wsReady = true;
            console.info('[preload-web] WebSocket connected');
            for (const msg of pendingMessages) {
                ws.send(JSON.stringify(msg));
            }
            pendingMessages = [];
        };
        ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                if (msg.type === 'taskUpdate') {
                    const cb = wsCallbacks.get(msg.subscriptionId);
                    if (cb) cb(msg.data);
                } else if (msg.type === 'taskListUpdate') {
                    if (taskListCallback) taskListCallback(msg.data);
                } else if (msg.type === 'subscribeTaskUpdateResult') {
                    const resolver = pendingSubscriptions.get(msg.taskId);
                    if (resolver) {
                        resolver(msg.subscriptionId);
                        pendingSubscriptions.delete(msg.taskId);
                    }
                }
            } catch (err) {
                console.error('[preload-web] WebSocket message parse error:', err);
            }
        };
        ws.onclose = () => {
            wsReady = false;
            console.info('[preload-web] WebSocket disconnected, reconnecting in 2s...');
            setTimeout(ensureWS, 2000);
        };
        ws.onerror = (err) => {
            console.error('[preload-web] WebSocket error:', err);
        };
    }

    function wsSend(msg) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(msg));
        } else {
            pendingMessages.push(msg);
            ensureWS();
        }
    }

    const pendingSubscriptions = new Map(); // taskId -> resolve

    // --- HTTP helpers ---
    async function apiPost(path, body = {}) {
        const res = await fetch(`${API_BASE}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        return res.json();
    }

    async function apiGet(path) {
        const res = await fetch(`${API_BASE}${path}`);
        return res.json();
    }

    // --- taskManagerAPI ---
    window.taskManagerAPI = {
        createTask: async () => {
            const result = await apiPost('/api/taskManager/createTask');
            if (result.status === 'ok') return result.data;
            throw new Error(result.message);
        },
        removeTask: async (taskId) => {
            const result = await apiPost('/api/taskManager/removeTask', { taskId });
            if (result.status === 'ok') return result.data;
            throw new Error(result.message);
        },
        forkTask: async (taskId) => {
            const result = await apiPost('/api/taskManager/forkTask', { taskId });
            if (result.status === 'ok') return result.data;
            throw new Error(result.message);
        },
        clearAllTasks: async () => {
            const result = await apiPost('/api/taskManager/clearAllTasks');
            if (result.status !== 'ok') throw new Error(result.message);
        },
        stopTask: async (taskId) => {
            const result = await apiPost('/api/taskManager/stopTask', { taskId });
            if (result.status !== 'ok') throw new Error(result.message);
            return result.data;
        },
        getFullTask: async (taskId) => {
            const result = await apiPost('/api/taskManager/getFullTask', { taskId });
            if (result.status === 'ok') return result.data;
            throw new Error(result.message);
        },
        subscribeTaskUpdate: async (taskId, callback) => {
            ensureWS();
            return new Promise((resolve) => {
                pendingSubscriptions.set(taskId, (subscriptionId) => {
                    wsCallbacks.set(subscriptionId, callback);
                    resolve(subscriptionId);
                });
                wsSend({ type: 'subscribeTaskUpdate', taskId });
            });
        },
        unsubscribeTaskUpdate: async (taskId, subscriptionId) => {
            wsCallbacks.delete(subscriptionId);
            wsSend({ type: 'unsubscribeTaskUpdate', taskId });
        },
        getTaskList: async () => {
            const result = await apiGet('/api/taskManager/getTaskList');
            if (result.status !== 'ok') throw new Error(result.message);
            return result.data;
        },
        subscribeTaskListUpdate: async (callback) => {
            taskListCallback = callback;
            ensureWS();
        },
        attachToolset: async (taskId, toolset, toolsetCallback) => {
            // Web 模式下暂不支持前端工具集
            console.warn('[preload-web] attachToolset is not supported in web debug mode');
        },
        setSystemPrompt: async (taskId, prompt) => {
            return apiPost('/api/taskManager/setSystemPrompt', { taskId, prompt });
        },
        submitMessage: async (taskId, details) => {
            return apiPost('/api/taskManager/submitMessage', { taskId, details });
        },
        exportTaskToHtml: async (taskId) => {
            const result = await apiPost('/api/taskManager/exportTaskToHtml', { taskId });
            if (result.status !== 'ok') throw new Error(result.message);
            return result.data;
        },
        exportTask: async (taskId, filePath) => {
            console.warn('[preload-web] exportTask to file is not supported in web debug mode');
        }
    };

    // --- settingAPI ---
    const commandCallbacks = {};
    window.settingAPI = {
        registerCommandCallback: (command, callback) => {
            commandCallbacks[command] = callback;
        },
        loadSettingSchema: async () => {
            const result = await apiGet('/api/setting/loadSettingSchema');
            if (result.status !== 'ok') throw new Error(result.message);
            return result.data;
        },
        loadSettingObject: async () => {
            const result = await apiGet('/api/setting/loadSettingObject');
            if (result.status !== 'ok') throw new Error(result.message);
            return result.data;
        },
        saveSettingObject: async (settingObject) => {
            const result = await apiPost('/api/setting/saveSettingObject', settingObject);
            if (result.status !== 'ok') throw new Error(result.message);
        },
        openDevTools: () => {
            // 在浏览器中直接用 F12
            console.info('[preload-web] Use F12 to open browser DevTools');
        },
        getLogContent: async () => {
            const result = await apiGet('/api/setting/getLogContent');
            if (result.status !== 'ok') throw new Error(result.message);
            return result.data;
        },
        subscribeLogContentUpdate: (callback) => {
            // Web 模式下暂不支持日志订阅推送
        },
        closeMainWindow: () => {
            console.info('[preload-web] closeMainWindow: no-op in web mode');
        },
        minimizeMainWindow: () => {
            console.info('[preload-web] minimizeMainWindow: no-op in web mode');
        },
        maximizeMainWindow: async () => {
            console.info('[preload-web] maximizeMainWindow: no-op in web mode');
        },
        isMaximized: async () => {
            return false;
        }
    };

    // --- fsAPI ---
    window.fsAPI = {
        searchFilesByKeyword: async (keyword) => {
            const result = await apiPost('/api/applicationRegistry/call', {
                bundleName: 'filemgr',
                methodName: 'searchFilesByKeyword',
                args: [keyword]
            });
            if (result.status !== 'ok') throw new Error(result.message);
            return result.data;
        },
        searchFilesByNameSimilarity: async (query) => {
            const result = await apiPost('/api/applicationRegistry/call', {
                bundleName: 'filemgr',
                methodName: 'searchFilesByNameSimilarity',
                args: [query]
            });
            if (result.status !== 'ok') throw new Error(result.message);
            return result.data;
        },
        openPath: async (filePath) => {
            const result = await apiPost('/api/applicationRegistry/callMainWorld', {
                bundleName: 'filemgr',
                methodName: 'openPath',
                args: [filePath]
            });
            if (result.status !== 'ok') throw new Error(result.message);
        },
        selectFile: async () => {
            // Web 模式使用浏览器原生文件选择
            return new Promise((resolve) => {
                const input = document.createElement('input');
                input.type = 'file';
                input.multiple = true;
                input.onchange = () => {
                    const files = Array.from(input.files || []);
                    resolve(files.map((f) => f.name));
                };
                input.click();
            });
        },
        saveFile: async (options) => {
            console.warn('[preload-web] saveFile dialog is not supported in web debug mode');
            return { canceled: true };
        },
        fileExists: async (filePath) => {
            return false;
        },
        getFilePath: (file) => {
            return file.name || '';
        },
        getPathType: async (filePath) => {
            return null;
        }
    };

    // --- notificationAPI ---
    window.notificationAPI = {
        sendNotification: async (...args) => {
            console.info('[preload-web] notification:', ...args);
        },
        subscribeNotification: async (callback) => {
            // Web 模式下暂不支持通知推送
        }
    };

    // --- floatWindowAPI ---
    window.floatWindowAPI = {
        hideFloatWindow: () => {
            console.info('[preload-web] hideFloatWindow: no-op in web mode');
        },
        subscribeIntentsUpdate: (callback) => {
            // no-op
        }
    };

    // --- applicationAPI (for iframe / application.html) ---
    let applicationBundleName = null;
    window.applicationAPI = {
        setApplicationBundleName: async (bundleName) => {
            applicationBundleName = bundleName;
        },
        call: async (methodName, ...args) => {
            if (!applicationBundleName) throw new Error('application bundle name is not set');
            const result = await apiPost('/api/applicationRegistry/call', {
                bundleName: applicationBundleName,
                methodName,
                args
            });
            if (result.status !== 'ok') throw new Error(result.message);
            return result.data;
        },
        callMainWorld: async (methodName, ...args) => {
            if (!applicationBundleName) throw new Error('application bundle name is not set');
            const result = await apiPost('/api/applicationRegistry/callMainWorld', {
                bundleName: applicationBundleName,
                methodName,
                args
            });
            if (result.status !== 'ok') throw new Error(result.message);
            return result.data;
        },
        streamCall: async (methodName, callback, ...args) => {
            console.warn('[preload-web] streamCall not supported in web debug mode');
        },
        streamCallMainWorld: async (methodName, callback, ...args) => {
            console.warn('[preload-web] streamCallMainWorld not supported in web debug mode');
        },
        subscribe: async (eventName, callback) => {
            // Web 模式下暂不支持事件订阅
            return () => {};
        },
        unsubscribe: async (eventName) => {}
    };

    // --- applicationRegistryAPI ---
    window.applicationRegistryAPI = {
        getApplicationGUIConfig: async (bundleName) => {
            const result = await apiPost('/api/setting/getApplicationGUIConfig', { bundleName });
            if (result.status !== 'ok') throw new Error(result.message);
            return result.data;
        },
        getApplicationList: async () => {
            const result = await apiGet('/api/applicationRegistry/getApplicationList');
            if (result.status !== 'ok') throw new Error(result.message);
            return result.data;
        },
        call: async (bundleName, methodName, ...args) => {
            const result = await apiPost('/api/applicationRegistry/call', {
                bundleName,
                methodName,
                args
            });
            if (result.status !== 'ok') throw new Error(result.message);
            return result.data;
        },
        callMainWorld: async (bundleName, methodName, ...args) => {
            const result = await apiPost('/api/applicationRegistry/callMainWorld', {
                bundleName,
                methodName,
                args
            });
            if (result.status !== 'ok') throw new Error(result.message);
            return result.data;
        },
        subscribeEvent: async (bundleName, eventName, callback) => {
            // Web 模式下暂不支持事件订阅
            return () => {};
        }
    };

    // 初始化 WebSocket
    ensureWS();

    console.info('[preload-web] Web debug preload initialized, API base:', API_BASE);
})();
