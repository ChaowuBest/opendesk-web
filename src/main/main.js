const { app, BrowserWindow, Tray, globalShortcut, ipcMain, shell } = require('electron')
const { GlobalState } = require('./states/global')
const { Setting } = require('./utils/setting')
const { openFloatWindow } = require('./windows/floatwindow')
const { FSService } = require('./services/fs/scanner')
const { FSStorage } = require('./services/fs/storage')
const { LogStream } = require('./utils/logger')

const path = require('path');


if (require('electron-squirrel-startup')) {
  app.quit();
}

/** @type {BrowserWindow | null} */
var globalMainWindow = null;

const createWindow = () => {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 700,
    frame: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '..', 'renderer', 'preload.js')
    }
  })

  mainWindow.setMenu(null)
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
  globalMainWindow = mainWindow;
}

const registerTaskManagerAPIHandlers = () => {
  const globalState = GlobalState.getInstance();

  ipcMain.handle('taskManager:createTask', () => {
    var task = globalState.taskManagerState.createTask();
    return { status: 'ok', data: task.task_id };
  });
  ipcMain.handle('taskManager:removeTask', (event, taskId) => {
    var task = globalState.taskManagerState.getTask(taskId);
    if (task === undefined) {
      return { status: 'error', message: `task ${taskId} not found` }
    }

    globalState.taskManagerState.removeTask(taskId);
    return { status: 'ok', data: task.task_id };
  })
  ipcMain.handle('taskManager:getFullTask', async (event, taskId) => {
    var task = globalState.taskManagerState.getTask(taskId);
    if (task === undefined) {
      return { status: 'error', message: `task ${taskId} not found` }
    }

    await task.render();
    return { status: 'ok', data: task.toJSON() };
  })
  ipcMain.handle('taskManager:subscribeTaskUpdate', (event, taskId) => {
    var task = globalState.taskManagerState.getTask(taskId);
    if (task === undefined) {
      return { status: 'error', message: `task ${taskId} not found` }
    }

    return { status: 'ok', data: task.addSubscriber(event.sender) };
  })
  ipcMain.handle('taskManager:unsubscribeTaskUpdate', (event, taskId, subscriptionId) => {
    var task = globalState.taskManagerState.getTask(taskId);
    if (task === undefined) {
      return { status: 'error', message: `task ${taskId} not found` }
    }

    return { status: 'ok', data: task.removeSubscriber(subscriptionId) };
  })

  ipcMain.handle('taskManager:getTaskList', (event) => {
    return { status: 'ok', data: globalState.taskManagerState.getTaskList() };
  })
  ipcMain.handle('taskManager:subscribeTaskListUpdate', (event) => {
    return { status: 'ok', data: globalState.taskManagerState.addSubscriber(event.sender) };
  })
  ipcMain.handle('taskManager:submitMessage', (event, taskId, message) => {
    const task = globalState.taskManagerState.getTask(taskId);
    task.submitUserMessage(message);
  });
}

const registerFSAPIHandlers = () => {
  ipcMain.handle('fs:searchFilesByKeyword', async (event, keyword) => {
    const storage = await FSStorage.getInstance();
    const result = await storage.searchFilesByKeyword(keyword);
    return { status: 'ok', data: result };
  }),
  ipcMain.handle('fs:searchFilesByNameSimilarity', async (event, query) => {
    const storage = await FSStorage.getInstance();
    const result = await storage.searchFilesByNameSimilarity(query);
    return { status: 'ok', data: result };
  }),
  ipcMain.handle('fs:openFile', async (event, filePath) => {
    shell.openPath(filePath);
    return { status: 'ok' };
  })
}

const registerSettingAPIHandlers = () => {
  ipcMain.handle('setting:loadSettingObject', () => {
    return { status: 'ok', data: Setting.getInstance().getData() };
  })
  ipcMain.handle('setting:saveSettingObject', (event, settingObject) => {
    try {
      Setting.getInstance().setData(settingObject);
      return { status: 'ok' };
    } catch (error) {
      return { status: 'error', message: error.message };
    }
  })
  ipcMain.handle('setting:openDevTools', () => {
    if (globalMainWindow === null) {
      return { status: 'error', message: 'main window not found' }
    }
    globalMainWindow.webContents.openDevTools();
    return { status: 'ok' };
  }),
  ipcMain.handle('setting:getLogContent', () => {
    return { status: 'ok', data: LogStream.getStream().getContent() };
  })
  ipcMain.handle('setting:closeMainWindow', () => {
    if (globalMainWindow === null) {
      return { status: 'error', message: 'main window not found' }
    }
    globalMainWindow.close();
    return { status: 'ok' };
  })
}

const registerHotKeys = () => {
  const ret = globalShortcut.register('Alt+Space', () => {
    openFloatWindow();
  })

  if (!ret) {
    console.log('hotkey register failed, possibly because the hot key is already in use')
  }
}

app.whenReady().then(() => {
  GlobalState.initialize();
  createWindow();
  registerTaskManagerAPIHandlers();
  registerFSAPIHandlers();
  registerSettingAPIHandlers();
  registerHotKeys();

  FSService.startFSService();
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  FSService.stopFSService();
})
