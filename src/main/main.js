import { app, BrowserWindow, Tray, globalShortcut, nativeImage, ipcMain, shell, Menu, dialog, protocol } from 'electron'
import { Setting, getAppDirectory } from './utils/setting.js'
import { GlobalState } from './states/global.js'
import { openFloatWindow } from './windows/floatwindow.js'
import { BaseToolset } from './agents/tool';
import { is } from '@electron-toolkit/utils';
import { z } from 'zod';
import { NotificationManager } from './utils/notificationmgr.js';
import { LogStream, logger } from './utils/logger.js'
import { registerApplicationRegistryHandlers, initializeRegistry, notifyWorkerSettingUpdate, ApplicationRegistry } from './applications/registry';
import { SkillRegistry } from './services/skills/SkillRegistry.js';
import { UpdateClient } from '../updater/client.js';

import Convert from 'ansi-to-html';
import path from 'path';
import fs from 'fs';

import appIcon from '../../resources/main/images/icon_round.png?asset'


const __dirname = import.meta.dirname;
const converter = new Convert();

/** @type {BrowserWindow | null} */
var globalMainWindow = null;
/** @type {Tray | null} */
var globalTray = null;
/** @type {boolean} */
var isAppQuitting = false;

/**
 * 将应用内置的 skills 目录（resources/skills）自动拷贝到用户的 skills 目录
 * - 支持 npm 调试（dev）和打包运行
 * - 总是覆盖同名内置技能到最新版本（与 resources/skills 保持一致）
 */
async function installBundledSkillsIfNeeded() {
  try {
    const appPath = app.getAppPath();
    const bundledSkillsDir = path.join(appPath, 'resources', 'skills');
    if (!fs.existsSync(bundledSkillsDir)) {
      return;
    }

    const userSkillsDir = SkillRegistry.getSkillsDirectory();

    const copyRecursive = (src, dest) => {
      const stat = fs.statSync(src);
      if (stat.isDirectory()) {
        fs.mkdirSync(dest, { recursive: true });
        for (const child of fs.readdirSync(src)) {
          copyRecursive(path.join(src, child), path.join(dest, child));
        }
      } else {
        fs.copyFileSync(src, dest);
      }
    };

    const entries = fs.readdirSync(bundledSkillsDir, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const srcDir = path.join(bundledSkillsDir, ent.name);
      const destDir = path.join(userSkillsDir, ent.name);
      copyRecursive(srcDir, destDir);
    }
  } catch (error) {
    console.error('installBundledSkillsIfNeeded failed', error);
  }
}

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

const createWindow = () => {
    const mainWindow = new BrowserWindow({
        width: 1200,
        height: 700,
        frame: false,
        icon: appIcon,
        webPreferences: {
            nodeIntegration: false,
            nodeIntegrationInSubFrames: true,
            contextIsolation: true,
            preload: path.join(__dirname, '..', 'preload', 'index.js')
        }
    })

    mainWindow.setMenu(null)
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
        mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
    } else {
        mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
    }

    mainWindow.on('close', (event) => {
        if (!isAppQuitting) {
            // 如果不是应用要退出，仅仅是窗口关闭，则拦截并隐藏
            event.preventDefault();
            mainWindow.hide();
        }
        // 如果 isAppQuitting 为 true，则不执行 preventDefault，窗口正常销毁
    });

    const protocolConfigs = ApplicationRegistry.collectProtocolHandlerEntries();
    const inAppSchemePrefixes = protocolConfigs.map((c) => c.scheme + '://');
    const openLink = (url) => {
        console.log(`openLink: ${url}`);
        if (url.startsWith('file://') || url.startsWith('http://localhost') || inAppSchemePrefixes.some((p) => url.startsWith(p))) {
            return false;
        }
        shell.openExternal(url);
        return true;
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
        if (task === undefined) {
            return { status: 'error', message: `task ${taskId} not found` }
        }
        if (details.attachedFilePaths) {
            await task.attachFiles(details.attachedFilePaths);
        }

        await task.submitUserMessage(details.message);
        return { status: 'ok' };
    });
    ipcMain.handle('taskManager:stopTask', (event, taskId) => {
        const task = globalState.taskManagerState.getTask(taskId);
        if (task === undefined) {
            return { status: 'error', message: `task ${taskId} not found` }
        }
        task.stop();
        return { status: 'ok' };
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
    ipcMain.handle('fs:dialog-open', async () => {
        const { canceled, filePaths } = await dialog.showOpenDialog({
            title: '选择附件',
            properties: ['openFile', 'multiSelections'] // 允许选文件、允许多选
        });

        if (canceled) {
            return []; // 用户取消，返回空数组
        } else {
            // 将 Windows 路径的反斜杠统一替换为正斜杠，保持前后端一致
            return filePaths.map(p => p.replace(/\\/g, '/'));
        }
    })
    ipcMain.handle('fs:getPathType', async (event, filePath) => {
        try {
            // 将正斜杠路径转换回系统路径格式（Windows需要反斜杠）
            const systemPath = filePath.replace(/\//g, path.sep);
            const stats = await fs.promises.stat(systemPath);
            if (stats.isFile()) {
                return { status: 'ok', data: 'file' };
            } else if (stats.isDirectory()) {
                return { status: 'ok', data: 'directory' };
            } else {
                return { status: 'ok', data: null };
            }
        } catch (error) {
            // 如果路径不存在或无法访问，返回null
            if (error.code === 'ENOENT') {
                return { status: 'ok', data: null };
            }
            return { status: 'error', message: error.message };
        }
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
            // 通知 Worker 线程更新设置，使新的模型配置立即生效
            notifyWorkerSettingUpdate(Setting.getInstance().getData());
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
    }),
        ipcMain.handle('setting:minimizeMainWindow', () => {
            if (globalMainWindow === null) {
                return { status: 'error', message: 'main window not found' }
            }
            globalMainWindow.minimize();
            return { status: 'ok' };
        }),
        ipcMain.handle('setting:maximizeMainWindow', () => {
            if (globalMainWindow === null) {
                return { status: 'error', message: 'main window not found' }
            }
            if (globalMainWindow.isMaximized()) {
                globalMainWindow.unmaximize();
            } else {
                globalMainWindow.maximize();
            }
            return { status: 'ok' };
        }),
        ipcMain.handle('setting:isMaximized', () => {
            if (globalMainWindow === null) {
                return { status: 'error', message: 'main window not found' }
            }
            return { status: 'ok', data: globalMainWindow.isMaximized() };
        })

}

const registerSkillRegistryHandlers = () => {
  ipcMain.handle('skillRegistry:list', () => {
    try {
      return { status: 'ok', data: SkillRegistry.listSkills() };
    } catch (error) {
      return { status: 'error', message: error.message };
    }
  });
  ipcMain.handle('skillRegistry:refresh', () => {
    try {
      const { toolsets, errors } = SkillRegistry.refresh();
      return { status: 'ok', data: { count: toolsets.length, errors } };
    } catch (error) {
      return { status: 'error', message: error.message };
    }
  });
  ipcMain.handle('skillRegistry:getSkillsDirectory', () => {
    try {
      return { status: 'ok', data: SkillRegistry.getSkillsDirectory() };
    } catch (error) {
      return { status: 'error', message: error.message };
    }
  });
};

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
    var icon = nativeImage.createFromPath(appIcon);
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

// 初始化自动更新客户端
let updateClient = null;
const initializeUpdater = () => {
    // 配置多个备选更新服务器地址，按顺序尝试
    // 如果第一个服务器不可用，会自动尝试下一个
    const updateServerUrls = [
        // 如果要进行更新测试，可以把下边这一行注释打开
        // 'http://localhost:3000',
        'https://fillipdesk.uv0xab.com/update'
    ];

    // 只在生产环境启用自动更新，或者设置了 DEBUG_UPDATER 环境变量
    if (!is.dev || process.env.DEBUG_UPDATER) {
        logger.info(`启用自动更新, 当前版本: ${app.getVersion()}`);
        updateClient = new UpdateClient({
            serverUrls: updateServerUrls,
            currentVersion: app.getVersion(),
            checkInterval: 3600000, // 每小时检查一次
        });

        // 延迟检查更新，避免影响应用启动速度
        setTimeout(() => {
            updateClient.checkAndPromptUpdate().catch((error) => {
                logger.error('检查更新失败', error);
            });
        }, 3000); // 3秒后检查
    }
}

const initializeProtocolHandlers = () => {
    // 由各应用通过 base.getProtocolHandlers 注册自定义协议；主进程在此统一声明 scheme 权限
    const protocolConfigs = ApplicationRegistry.collectProtocolHandlerEntries();
    for (const { scheme, handler } of protocolConfigs) {
        protocol.handle(scheme, handler);
    }
}

app.whenReady().then(() => {
    GlobalState.initialize();
    createWindow();

    // 将打包内置/源码中的 resources/skills 自动同步到用户 skills 目录
    installBundledSkillsIfNeeded().catch((err) => {
      console.error('installBundledSkillsIfNeeded error', err);
    });

    registerTaskManagerAPIHandlers();
    registerFSAPIHandlers();
    registerSettingAPIHandlers();
    registerApplicationRegistryHandlers(ipcMain);
    registerSkillRegistryHandlers();
    registerNotificationAPIHandlers();
    registerHotKeys();
    registerTray();
    initializeRegistry();
    initializeProtocolHandlers();
    initializeUpdater();
})

app.on('will-quit', async () => {
    globalShortcut.unregisterAll()
    // 停止自动更新检查
    if (updateClient) {
        updateClient.stopAutoCheck();
    }
})
