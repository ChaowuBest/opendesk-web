const { contextBridge, ipcRenderer, webUtils } = require('electron');


function exposeTaskManagerAPI() {
    /** @type {Map<string, Map<string, (toolName: string, args: any) => Promise<string>>>} */
    var taskwiseToolsetCallbacks = new Map();

    contextBridge.exposeInMainWorld('taskManagerAPI', {
        createTask: async () => {
            const result = await ipcRenderer.invoke('taskManager:createTask');
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
        getFullTask: async (taskId) => {
            const result = await ipcRenderer.invoke('taskManager:getFullTask', taskId);
            if (result.status === 'ok') {
                return result.data;
            } else {
                console.error('getting full task failed', result.message);
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
            console.info('task update subscribed for task', taskId, subscriptionId)
            ipcRenderer.on(`taskManager:taskUpdate:${subscriptionId}`, (event, ...args) => {
                callback(...args)
            })
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
                callback(...args)
            })
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
    });

    ipcRenderer.on('taskManager:callTool', async (event, taskId, toolCallId, toolsetName, toolName, args) => {
        let result = "";
        if (!taskwiseToolsetCallbacks.has(taskId)) {
            result = "错误: 当前任务没有在前端注册";
        } else {
            const toolsetCallback = taskwiseToolsetCallbacks.get(taskId).get(toolsetName);
            if (toolsetCallback === undefined) {
                result = "错误: 当前工具集没有在前端注册";
            } else {
                try {
                    result = await toolsetCallback(toolName, args);
                } catch (error) {
                    result = "错误: 执行工具失败, 错误信息为: " + error.message;
                    console.error('error executing tool', error);
                }
            }
        }
        ipcRenderer.send(`taskManager:reportToolCallResult:${toolCallId}`, result);
    });
}


if (window.self !== window.top) {
    /** @type {string | null} */
    var applicationBundleName = null;

    contextBridge.exposeInMainWorld('applicationAPI', {
        getApplicationGUIConfig: async (bundleName) => {
            const result = await ipcRenderer.invoke('applicationRegistry:getApplicationGUIConfig', bundleName);
            if (result.status !== 'ok') {
                console.error('getting application GUI config failed', result.message);
                throw new Error(result.message);
            }
            applicationBundleName = bundleName;
            return result.data;
        },
        sendMessageToApplication: async (...args) => {
            if (applicationBundleName === null) {
                console.error('application bundle name is not set');
                throw new Error('application bundle name is not set');
            }
            const result = await ipcRenderer.invoke('applicationRegistry:sendMessageToApplication', applicationBundleName, ...args);
            if (result.status !== 'ok') {
                console.error('sending message to application failed', result.message);
                throw new Error(result.message);
            }
            return result.data;
        }
    })
    exposeTaskManagerAPI();
} else {
    exposeTaskManagerAPI();

    contextBridge.exposeInMainWorld('fsAPI', {
        searchFilesByKeyword: async (keyword) => {
            const result = await ipcRenderer.invoke('fs:searchFilesByKeyword', keyword);
            if (result.status !== 'ok') {
                console.error('searching files by keyword failed', result.message);
                throw new Error(result.message);
            }
            return result.data;
        },
        searchFilesByNameSimilarity: async (query) => {
            const result = await ipcRenderer.invoke('fs:searchFilesByNameSimilarity', query);
            if (result.status !== 'ok') {
                console.error('searching files by name similarity failed', result.message);
                throw new Error(result.message);
            }
            return result.data;
        },
        openFile: async (filePath) => {
            const result = await ipcRenderer.invoke('fs:openFile', filePath);
            if (result.status !== 'ok') {
                console.error('opening file failed', result.message);
                throw new Error(result.message);
            }
        },
        getFilePath: (file) => {
            // 统一为跨平台路径，始终返回如 c:/xxx 格式
            let p = webUtils.getPathForFile(file);
            // 将所有反斜杠替换为正斜杠，以统一为 URI 风格
            if (typeof p === "string") {
                p = p.replace(/\\/g, '/');
            }
            return p;
        }
    })

    contextBridge.exposeInMainWorld('settingAPI', {
        registerCommandCallback: (command, callback) => {
            ipcRenderer.on(`command:${command}`, (event, ...args) => {
                callback(...args)
            })
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
        subscribeLogContentUpdate: (callback) => {
            ipcRenderer.on('setting:logContentUpdate', (event, ...args) => {
                callback(...args)
            })
        },
        closeMainWindow: () => ipcRenderer.invoke('setting:closeMainWindow'),
    })

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
            await ipcRenderer.invoke('notification:subscribeNotification');
            ipcRenderer.on('notification:notificationReceived', (event, ...args) => {
                callback(...args)
            })
        }
    })

    contextBridge.exposeInMainWorld('floatWindowAPI', {
        hideFloatWindow: () => ipcRenderer.invoke('floatWindow:hideFloatWindow'),
        subscribeIntentsUpdate: (callback) => {
            ipcRenderer.on('floatWindow:intentsUpdate', (event, ...args) => {
                callback(...args)
            })
        }
    })

    contextBridge.exposeInMainWorld('applicationRegistryAPI', {
        getApplicationGUIConfig: async (bundleName) => {
            const result = await ipcRenderer.invoke('applicationRegistry:getApplicationGUIConfig', bundleName);
            if (result.status !== 'ok') {
                console.error('getting application GUI config failed', result.message);
                throw new Error(result.message);
            }
            return result.data;
        }
    })
}
