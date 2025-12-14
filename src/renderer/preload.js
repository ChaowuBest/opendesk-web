const { contextBridge, ipcRenderer } = require('electron');


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
    submitMessage: (taskId, message) => ipcRenderer.invoke('taskManager:submitMessage', taskId, message),
});

contextBridge.exposeInMainWorld('settingAPI', {
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
    }
})