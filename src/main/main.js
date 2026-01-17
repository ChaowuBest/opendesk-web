import { app, BrowserWindow, Tray, globalShortcut, nativeImage, ipcMain, shell, Menu } from 'electron'
import { Setting } from './utils/setting.js'
import { GlobalState } from './states/global.js'
import { openFloatWindow } from './windows/floatwindow.js'
import { FSService } from './services/fs/service.js'
import { BaseToolset } from './agents/tool.js';

/* applications */
import { ApplicationRegistry } from './applications/base.js';
import { SearchApplication } from './applications/search/app.js';
import { MailboxApplication } from './applications/mailbox/app.js';
import { RecallApplication } from './applications/recall/app.js';
import { NewsApplication } from './applications/news/app.js';
import { A2AApplication } from './applications/a2a/app.js';
import { A2AService } from './applications/a2a/service/service.js';
import { CalendarApplication } from './applications/calendar/app.js';


import { z } from 'zod';
import Convert from 'ansi-to-html';
import path from 'path';
import { NotificationManager } from './utils/notificationmgr.js';
import { FileMgrApplication } from './applications/filemgr/app.js';
import { LogStream, logger } from './utils/logger.js'


const __dirname = import.meta.dirname;
const searchApplication = new SearchApplication();
const mailboxApplication = new MailboxApplication();
const recallApplication = new RecallApplication();
const newsApplication = new NewsApplication();
const a2aApplication = new A2AApplication();
const fileMgrApplication = new FileMgrApplication();
const calendarApplication = new CalendarApplication();
const converter = new Convert();

/** @type {BrowserWindow | null} */
var globalMainWindow = null;
/** @type {Tray | null} */
var globalTray = null;
/** @type {boolean} */
var isAppQuitting = false;

if (app.requestSingleInstanceLock()) {
  app.on('second-instance', (event, path) => {
    if (globalMainWindow) {
      globalMainWindow.show();
    }
  })
} else {
  app.quit();
  process.exit(1);
}

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

  /**
   * Open a link according to the system strategy
   * @param {string} url
   * @returns {boolean} true if the link is opened, false otherwise
   */
  const openLink = (url) => {
    if (!url.startsWith('file://')) {
      shell.openExternal(url);
      return true;
    }
    return false;
  }

  mainWindow.webContents.on('will-navigate', (event) => {
    if (openLink(event.url)) {
      event.preventDefault();
      return;
    }
  });

  mainWindow.webContents.on('will-frame-navigate', (event) => {
    if (openLink(event.url)) {
      event.preventDefault();
      return;
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (openLink(url)) {
      return { action: 'deny' };
    }
    return { action: 'allow' };
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

    return { status: 'ok', data: task.addSubscriber(event.senderFrame) };
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
  ipcMain.handle('taskManager:attachToolset', async (event, taskId, toolsetObject) => {
    const task = globalState.taskManagerState.getTask(taskId);
    if (task === undefined) {
      return { status: 'error', message: `task ${taskId} not found` }
    }

    const toolset = BaseToolset.fromJSON(toolsetObject);
    for (let tool of toolset.tools.values()) {
      tool.setExecutor(async (args) => {
        let toolCallId = crypto.randomUUID();

        let result = new Promise((resolve, reject) => {
          ipcMain.once(`taskManager:reportToolCallResult:${toolCallId}`, (event, result) => {
            resolve(result);
          });
          event.senderFrame.send(`taskManager:callTool`, taskId, toolCallId, toolset.name, tool.name, args);
        });

        return await result;
      });
    }

    await task.attachToolset(toolset);
    return { status: 'ok' };
  })
  ipcMain.handle('taskManager:setSystemPrompt', (event, taskId, prompt) => {
    const task = globalState.taskManagerState.getTask(taskId);
    if (task === undefined) {
      return { status: 'error', message: `task ${taskId} not found` }
    }
    task.setSystemPrompt(prompt);
  })
  ipcMain.handle('taskManager:submitMessage', async (event, taskId, details) => {
    const task = globalState.taskManagerState.getTask(taskId);
    if (details.attachedFilePaths) {
      await task.attachFiles(details.attachedFilePaths);
    }
    task.submitUserMessage(details.message);
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
    if (!filePath) {
      return { status: 'error', message: `file path is required, ${filePath} given` }
    }
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
  ipcMain.handle('applicationRegistry:getApplicationList', async (event) => {
    return { status: 'ok', data: ApplicationRegistry.getApplicationList() };
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

  // A2A 应用的流式响应处理
  ipcMain.handle('a2a:subscribeStream', (event, requestId) => {
    const unsubscribe = A2AService.subscribeStream(requestId, (data) => {
      // 发送流式数据到渲染进程
      event.senderFrame.send('a2a:streamChunk', requestId, data);
    });
    return { status: 'ok', data: { requestId } };
  })
}

const registerNotificationAPIHandlers = () => {
  ipcMain.handle('notification:sendNotification', (event, ...args) => {
    try {
      NotificationManager.getInstance().sendNotification(...args);
      return { status: 'ok' };
    } catch (error) {
      return { status: 'error', message: error.message };
    }
  }),
  ipcMain.handle('notification:subscribeNotification', (event) => {
    NotificationManager.getInstance().addSubscriber(event.sender);
    return { status: 'ok' };
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
    { label: '打开开发者工具', click: () => { globalMainWindow.webContents.openDevTools(); } },
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
  registerNotificationAPIHandlers();
  registerHotKeys();
  registerTray();

  FSService.startFSService();
  ApplicationRegistry.registerApplication(searchApplication);
  ApplicationRegistry.registerApplication(mailboxApplication);
  ApplicationRegistry.registerApplication(recallApplication);
  ApplicationRegistry.registerApplication(newsApplication);
  ApplicationRegistry.registerApplication(a2aApplication);
  ApplicationRegistry.registerApplication(fileMgrApplication);
  ApplicationRegistry.registerApplication(calendarApplication);
})

app.on('will-quit', async () => {
  globalShortcut.unregisterAll()
  await FSService.stopFSService();
})
