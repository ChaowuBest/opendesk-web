const { app, BrowserWindow, Tray, globalShortcut, nativeImage, ipcMain, shell, Menu } = require('electron')
const { GlobalState } = require('./states/global')
const { Setting } = require('./utils/setting')
const { openFloatWindow } = require('./windows/floatwindow')
const { FSService } = require('./services/fs/service')
const { LogStream, logger } = require('./utils/logger')
const convert = require('ansi-to-html');
const { ApplicationRegistry } = require('./applications/base');
const { SearchApplication } = require('./applications/search/app');
const { MailboxApplication } = require('./applications/mailbox/app');
const { RecallApplication } = require('./applications/recall/app');
const { z } = require('zod');
const path = require('path');
const converter = new convert();


if (require('electron-squirrel-startup')) {
  app.quit();
}

const searchApplication = new SearchApplication();
const mailboxApplication = new MailboxApplication();
const recallApplication = new RecallApplication();

/** @type {BrowserWindow | null} */
var globalMainWindow = null;
/** @type {Tray | null} */
var globalTray = null;
/** @type {boolean} */
var isAppQuitting = false;

app.on('before-quit', () => {
  isAppQuitting = true;
});


const iconPath = path.join(__dirname, '..', 'assets', 'images', 'icon_round.png');

const createWindow = () => {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 700,
    frame: false,
    icon: iconPath,
    webPreferences: {
      nodeIntegration: false,
      nodeIntegrationInSubFrames: true,
      contextIsolation: true,
      preload: path.join(__dirname, '..', 'renderer', 'preload.js')
    }
  })

  mainWindow.setMenu(null)
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))

  mainWindow.on('close', (event) => {
    if (!isAppQuitting) {
      // 如果不是应用要退出，仅仅是窗口关闭，则拦截并隐藏
      event.preventDefault();
      mainWindow.hide();
    }
    // 如果 isAppQuitting 为 true，则不执行 preventDefault，窗口正常销毁
  });

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
    try {
      const result = await FSService.searchFilesByKeyword(keyword);
      return { status: 'ok', data: result };
    } catch (error) {
      return { status: 'error', message: error.message };
    }
  }),
  ipcMain.handle('fs:searchFilesByNameSimilarity', async (event, query) => {
    try {
      const result = await FSService.searchFilesByNameSimilarity(query);
      return { status: 'ok', data: result };
    } catch (error) {
      return { status: 'error', message: error.message };
    }
  }),
  ipcMain.handle('fs:openFile', async (event, filePath) => {
    shell.openPath(filePath);
    return { status: 'ok' };
  })
}

const registerSettingAPIHandlers = () => {
  ipcMain.handle('setting:loadSettingSchema', () => {
    try {
      const schema = Setting.getSettingSchema();
      return { status: 'ok', data: z.toJSONSchema(schema) };
    } catch (error) {
      logger.error(`error loading setting schema`, error);
      logger.error(error.stack)
      return { status: 'error', message: error.message };
    }
  })
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
    return { status: 'ok', data: converter.toHtml(LogStream.getStream().getContent()) };
  })
  ipcMain.handle('setting:closeMainWindow', () => {
    if (globalMainWindow === null) {
      return { status: 'error', message: 'main window not found' }
    }
    globalMainWindow.close();
    return { status: 'ok' };
  })
  ipcMain.handle('applicationRegistry:getApplicationGUIConfig', async (event, bundleName) => {
    const application = ApplicationRegistry.getApplication(bundleName);
    if (application === undefined) {
      return { status: 'error', message: `application ${bundleName} not found` }
    }
    return { status: 'ok', data: application.getGUIConfig() };
  })
  ipcMain.handle('applicationRegistry:sendMessageToApplication', async (event, bundleName, ...args) => {
    const application = ApplicationRegistry.getApplication(bundleName);
    if (application === undefined) {
      return { status: 'error', message: `application ${bundleName} not found` }
    }

    try {
      const data = await application.handleMessage(...args);
      return { status: 'ok', data: data };
    } catch (error) {
      return { status: 'error', message: error.message };
    }
  })
}

const registerHotKeys = () => {
  var hotkey = 'Alt+Space';
  if (process.platform === 'darwin') {
    hotkey = 'Option+Space';
  }
  const ret = globalShortcut.register(hotkey, () => {
    // todo: 意图理解还没成熟，先显示主窗口
    // openFloatWindow();
    globalMainWindow.show();
    globalMainWindow.webContents.send('command:openHomePage')
  })
  if (!ret) {
    console.log(`hotkey ${hotkey} register failed, possibly because the hot key is already in use`)
  }
}

const registerTray = () => {
  var icon = nativeImage.createFromPath(iconPath);
  icon = icon.resize({ width: 22, height: 22 });
  const menu = Menu.buildFromTemplate([
    { label: '打开主窗口', click: () => { globalMainWindow.show(); } },
    { label: '录制用户活动', click: () => { recallApplication.requestCaptureActivity(); } },
    { type: 'separator' },
    { label: '退出', click: () => { app.quit(); } }
  ])

  globalTray = new Tray(icon);
  globalTray.setToolTip('Fillip Desk | 弹指神通');
  globalTray.setContextMenu(menu);
  globalTray.on('click', () => {
    globalMainWindow.show();
  })
}

app.whenReady().then(() => {
  GlobalState.initialize();
  createWindow();
  registerTaskManagerAPIHandlers();
  registerFSAPIHandlers();
  registerSettingAPIHandlers();
  registerHotKeys();
  registerTray();

  FSService.startFSService();
  ApplicationRegistry.registerApplication(searchApplication);
  ApplicationRegistry.registerApplication(mailboxApplication);
  ApplicationRegistry.registerApplication(recallApplication);
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  FSService.stopFSService();
})
