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

import {
    app,
    BrowserWindow,
    Tray,
    globalShortcut,
    nativeImage,
    ipcMain,
    shell,
    Menu,
    dialog,
    protocol
} from 'electron';
import { Setting, getAppDirectory } from './utils/setting.js';
import { GlobalState } from './aikernel/states/global.js';
import { BaseToolset } from './aikernel/tool';
import { is } from '@electron-toolkit/utils';
import { z } from 'zod';
import { NotificationManager } from './utils/notificationmgr.js';
import { LogStream, logger, useConsoleTransport } from './utils/logger.js';
import { SkillRegistry } from './applications/skillmgr/skillregistry.js';
import {
    initializeRegistry,
    initializeRegistryWorker,
    notifyWorkerSettingUpdate,
    ApplicationRegistry
} from './applications/registry';
import {
    initializeRegistryProtocols,
    initializeProtocolHandlers,
    registerApplicationRegistryHandlers
} from './applications/registry_electron.js';
import { UpdateClient } from '../updater/client.js';
import { setPlatform } from '../platforms/base.js';
import {
    ElectronTaskUpdateSubscriber,
    ElectronPlatform,
    ElectronTaskManagerUpdateSubscriber
} from '../platforms/electron.js';
import { exportTaskToHtml, generateTaskHtml } from './utils/export';
import { MainAgentDecl } from './aikernel/agents/mainagent.js';

import Convert from 'ansi-to-html';
import path from 'path';
import fs from 'fs';

import appIcon from '../../resources/main/images/icon_round.png?asset';

setPlatform(new ElectronPlatform(app));
useConsoleTransport();

const __dirname = import.meta.dirname;
const converter = new Convert();

/** @type {BrowserWindow | null} */
let globalMainWindow = null;
/** @type {Tray | null} */
let globalTray = null;
/** @type {boolean} */
let isAppQuitting = false;

/**
 * 解析内置 skills 目录：优先用 SkillRegistry，再尝试 main 进程侧路径（开发/打包均可用）
 */
function resolveBundledSkillsDir() {
    const fromRegistry = SkillRegistry.getBundledSkillsDirectory();
    if (fs.existsSync(fromRegistry)) return fromRegistry;
    const appPath = app.getAppPath();
    const candidates = [
        path.join(__dirname, 'applications', 'skills', 'resources'),
        path.join(appPath, 'applications', 'skills', 'resources'),
        path.join(appPath, 'src', 'main', 'applications', 'skills', 'resources')
    ];
    for (const dir of candidates) {
        if (fs.existsSync(dir)) return dir;
    }
    return null;
}

/**
 * 仅在首次运行时将内置 skills 拷贝到用户的 apps/skills/resources
 * - 若用户技能目录已存在（含用户删除后的空目录），则不再覆盖，以保留用户删除/修改
 * - 支持 npm 调试（dev）和打包运行，多路径回退定位内置目录
 */
async function installBundledSkillsIfNeeded() {
    try {
        const appDir = getAppDirectory();
        const userSkillsDirPath = path.join(appDir, 'apps', 'skills', 'resources');
        if (fs.existsSync(userSkillsDirPath)) {
            return;
        }

        const bundledSkillsDir = resolveBundledSkillsDir();
        if (!bundledSkillsDir) {
            logger.warn('installBundledSkillsIfNeeded: 未找到内置 skills 目录，跳过拷贝');
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
            const srcPath = path.join(bundledSkillsDir, ent.name);
            const destPath = path.join(userSkillsDir, ent.name);
            copyRecursive(srcPath, destPath);
        }
    } catch (error) {
        console.error('installBundledSkillsIfNeeded failed', error);
    }
}

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
    });

    mainWindow.setMenu(null);
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
        mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
    } else {
        mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
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
        if (
            url.startsWith('file://') ||
            url.startsWith('http://localhost') ||
            inAppSchemePrefixes.some((p) => url.startsWith(p))
        ) {
            return false;
        }
        shell.openExternal(url);
        return true;
    };

    mainWindow.webContents.on('context-menu', (_event, params) => {
        const menuItems = [];
        if (params.editFlags.canCut) {
            menuItems.push({ label: '剪切', role: 'cut' });
        }
        if (params.editFlags.canCopy || params.selectionText) {
            menuItems.push({ label: '复制', role: 'copy' });
        }
        if (params.editFlags.canPaste) {
            menuItems.push({ label: '粘贴', role: 'paste' });
        }
        if (params.editFlags.canSelectAll) {
            menuItems.push({ label: '全选', role: 'selectAll' });
        }
        if (menuItems.length > 0) {
            Menu.buildFromTemplate(menuItems).popup({ window: mainWindow });
        }
    });

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
};

const registerTaskManagerAPIHandlers = () => {
    const globalState = GlobalState.getInstance();

    ipcMain.handle('taskManager:createTask', async () => {
        const task = globalState.taskManagerState.createTask();
        const agentDecl = new MainAgentDecl();
        agentDecl
            .createSystemPrompt()
            .then((prompt) => {
                task.setSystemPrompt(prompt);
            })
            .catch((err) => {
                logger.error('failed to create system prompt', err);
            });
        return { status: 'ok', data: task.task_id };
    });
    ipcMain.handle('taskManager:removeTask', (event, taskId) => {
        const task = globalState.taskManagerState.getTask(taskId);
        if (task === undefined) {
            return { status: 'error', message: `task ${taskId} not found` };
        }

        globalState.taskManagerState.removeTask(taskId);
        return { status: 'ok', data: task.task_id };
    });
    ipcMain.handle('taskManager:clearAllTasks', () => {
        globalState.taskManagerState.clearAllTasks();
        return { status: 'ok' };
    });
    ipcMain.handle('taskManager:getFullTask', async (event, taskId) => {
        const task = globalState.taskManagerState.getTask(taskId);
        if (task === undefined) {
            return { status: 'error', message: `task ${taskId} not found` };
        }

        await task.render();
        return { status: 'ok', data: task.toRenderJSON() };
    });
    ipcMain.handle('taskManager:subscribeTaskUpdate', (event, taskId) => {
        const task = globalState.taskManagerState.getTask(taskId);
        if (task === undefined) {
            return { status: 'error', message: `task ${taskId} not found` };
        }

        if (!event.senderFrame) {
            return { status: 'error', message: 'sender frame not found' };
        }

        const subscriber = new ElectronTaskUpdateSubscriber(event.senderFrame);
        return { status: 'ok', data: task.addSubscriber(subscriber) };
    });
    ipcMain.handle('taskManager:unsubscribeTaskUpdate', (event, taskId, subscriptionId) => {
        const task = globalState.taskManagerState.getTask(taskId);
        if (task === undefined) {
            return { status: 'error', message: `task ${taskId} not found` };
        }

        return { status: 'ok', data: task.removeSubscriber(subscriptionId) };
    });

    ipcMain.handle('taskManager:getTaskList', (event) => {
        return { status: 'ok', data: globalState.taskManagerState.getTaskList() };
    });
    ipcMain.handle('taskManager:subscribeTaskListUpdate', (event) => {
        if (!event.senderFrame) {
            return { status: 'error', message: 'sender frame not found' };
        }
        const subscriber = new ElectronTaskManagerUpdateSubscriber(event.senderFrame);
        return { status: 'ok', data: globalState.taskManagerState.addSubscriber(subscriber) };
    });
    ipcMain.handle('taskManager:attachToolset', async (event, taskId, toolsetObject) => {
        const task = globalState.taskManagerState.getTask(taskId);
        if (task === undefined) {
            return { status: 'error', message: `task ${taskId} not found` };
        }

        const toolset = BaseToolset.fromJSON(toolsetObject);
        for (const tool of toolset.tools.values()) {
            tool.setExecutor(async (args) => {
                const toolCallId = crypto.randomUUID();

                const result = new Promise((resolve, reject) => {
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
    });
    ipcMain.handle('taskManager:setSystemPrompt', (event, taskId, prompt) => {
        const task = globalState.taskManagerState.getTask(taskId);
        if (task === undefined) {
            return { status: 'error', message: `task ${taskId} not found` };
        }
        task.setSystemPrompt(prompt);
    });
    ipcMain.handle('taskManager:submitMessage', async (event, taskId, details) => {
        const task = globalState.taskManagerState.getTask(taskId);
        if (task === undefined) {
            return { status: 'error', message: `task ${taskId} not found` };
        }
        if (details.attachedFilePaths) {
            await task.attachFiles(details.attachedFilePaths);
        }

        task.submitUserMessage(details.message).catch((err) =>
            logger.error(`submitUserMessage failed for task ${taskId}:`, err)
        );
        return { status: 'ok' };
    });
    ipcMain.handle('taskManager:stopTask', (event, taskId) => {
        const task = globalState.taskManagerState.getTask(taskId);
        if (task === undefined) {
            return { status: 'error', message: `task ${taskId} not found` };
        }
        task.stop();
        return { status: 'ok' };
    });
    // 检查文件是否存在
    ipcMain.handle('fs:fileExists', async (event, filePath) => {
        try {
            const exists = fs.existsSync(filePath);
            return { status: 'ok', data: exists };
        } catch (error) {
            logger.error('checking file exists failed', error);
            return { status: 'error', message: error.message };
        }
    });
    // 显示保存文件对话框
    ipcMain.handle('dialog:saveFile', async (event, options) => {
        try {
            const result = await dialog.showSaveDialog(globalMainWindow, options);
            return { status: 'ok', data: result };
        } catch (error) {
            logger.error('showing save dialog failed', error);
            return { status: 'error', message: error.message };
        }
    });
    ipcMain.handle('taskManager:exportTask', async (event, taskId, filePath) => {
        const task = globalState.taskManagerState.getTask(taskId);
        if (task === undefined) {
            return { status: 'error', message: `task ${taskId} not found` };
        }
        try {
            await task.render();
            await exportTaskToHtml(task, filePath);
            return { status: 'ok', data: filePath };
        } catch (error) {
            logger.error('exporting task failed', error);
            return { status: 'error', message: error.message };
        }
    });
    ipcMain.handle('taskManager:exportTaskToHtml', async (event, taskId) => {
        const task = globalState.taskManagerState.getTask(taskId);
        if (task === undefined) {
            return { status: 'error', message: `task ${taskId} not found` };
        }
        try {
            await task.render();
            // 创建一个临时函数来获取 HTML 内容而不写入文件
            const htmlContent = await generateTaskHtml(task);
            return { status: 'ok', data: htmlContent };
        } catch (error) {
            logger.error('exporting task failed', error);
            return { status: 'error', message: error.message };
        }
    });
};

const registerFSAPIHandlers = () => {
    (ipcMain.handle('fs:searchFilesByKeyword', async (event, keyword) => {
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
                return { status: 'error', message: `file path is required, ${filePath} given` };
            }
            shell.openPath(filePath);
            return { status: 'ok' };
        }));
    ipcMain.handle('fs:dialog-open', async () => {
        const { canceled, filePaths } = await dialog.showOpenDialog({
            title: '选择附件',
            properties: ['openFile', 'multiSelections'] // 允许选文件、允许多选
        });

        if (canceled) {
            return []; // 用户取消，返回空数组
        } else {
            // 将 Windows 路径的反斜杠统一替换为正斜杠，保持前后端一致
            return filePaths.map((p) => p.replace(/\\/g, '/'));
        }
    });
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
    });
};

const registerSettingAPIHandlers = () => {
    ipcMain.handle('setting:loadSettingSchema', () => {
        try {
            const schema = Setting.getSettingSchema();
            return { status: 'ok', data: z.toJSONSchema(schema) };
        } catch (error) {
            logger.error(`error loading setting schema`, error);
            logger.error(error.stack);
            return { status: 'error', message: error.message };
        }
    });
    ipcMain.handle('setting:loadSettingObject', () => {
        return { status: 'ok', data: Setting.getInstance().getData() };
    });
    ipcMain.handle('setting:saveSettingObject', (event, settingObject) => {
        try {
            Setting.getInstance().setData(settingObject);
            // 通知 Worker 线程更新设置，使新的模型配置立即生效
            notifyWorkerSettingUpdate(Setting.getInstance().getData());
            return { status: 'ok' };
        } catch (error) {
            return { status: 'error', message: error.message };
        }
    });
    (ipcMain.handle('setting:openDevTools', () => {
        if (globalMainWindow === null) {
            return { status: 'error', message: 'main window not found' };
        }
        globalMainWindow.webContents.openDevTools();
        return { status: 'ok' };
    }),
        ipcMain.handle('setting:getLogContent', () => {
            return { status: 'ok', data: converter.toHtml(LogStream.getStream().getContent()) };
        }));
    (ipcMain.handle('setting:closeMainWindow', () => {
        if (globalMainWindow === null) {
            return { status: 'error', message: 'main window not found' };
        }
        globalMainWindow.close();
        return { status: 'ok' };
    }),
        ipcMain.handle('setting:minimizeMainWindow', () => {
            if (globalMainWindow === null) {
                return { status: 'error', message: 'main window not found' };
            }
            globalMainWindow.minimize();
            return { status: 'ok' };
        }),
        ipcMain.handle('setting:maximizeMainWindow', () => {
            if (globalMainWindow === null) {
                return { status: 'error', message: 'main window not found' };
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
                return { status: 'error', message: 'main window not found' };
            }
            return { status: 'ok', data: globalMainWindow.isMaximized() };
        }));
};

const registerNotificationAPIHandlers = () => {
    (ipcMain.handle('notification:sendNotification', (event, ...args) => {
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
        }));
};

const registerHotKeys = () => {
    let hotkey = 'Alt+Space';
    if (process.platform === 'darwin') {
        hotkey = 'Option+Space';
    }
    const ret = globalShortcut.register(hotkey, () => {
        // todo: 意图理解还没成熟，先显示主窗口
        // openFloatWindow();
        globalMainWindow.show();
        globalMainWindow.webContents.send('command:openHomePage');
    });
    if (!ret) {
        console.log(`hotkey ${hotkey} register failed, possibly because the hot key is already in use`);
    }
};

const registerTray = () => {
    let icon = nativeImage.createFromPath(appIcon);
    icon = icon.resize({ width: 22, height: 22 });
    const menu = Menu.buildFromTemplate([
        {
            label: '打开主窗口',
            click: () => {
                globalMainWindow.show();
            }
        },
        {
            label: '录制用户活动',
            click: () => {
                recallApplication.requestCaptureActivity();
            }
        },
        {
            label: '打开开发者工具',
            click: () => {
                globalMainWindow.webContents.openDevTools();
            }
        },
        { type: 'separator' },
        {
            label: '退出',
            click: () => {
                app.quit();
            }
        }
    ]);

    globalTray = new Tray(icon);
    globalTray.setToolTip('OpenDesk | 一站式智慧办公空间');
    globalTray.setContextMenu(menu);
    globalTray.on('click', () => {
        globalMainWindow.show();
    });
};

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
            checkInterval: 3600000 // 每小时检查一次
        });

        // 延迟检查更新，避免影响应用启动速度
        setTimeout(() => {
            updateClient.checkAndPromptUpdate().catch((error) => {
                logger.error('检查更新失败', error);
            });
        }, 3000); // 3秒后检查
    }
};

function startApplication() {
    if (app.requestSingleInstanceLock()) {
        app.on('second-instance', (event, path) => {
            if (globalMainWindow) {
                globalMainWindow.show();
            }
        });
    } else {
        app.quit();
        process.exit(1);
    }

    // 在 app.whenReady() 之前初始化 Registry 和协议 schemes
    initializeRegistry();
    initializeRegistryProtocols();

    app.on('before-quit', () => {
        isAppQuitting = true;
    });

    // macOS: 点击 Dock 图标时恢复并显示主窗口（解决最小化后点击图标不显示的问题）
    app.on('activate', () => {
        if (globalMainWindow) {
            if (globalMainWindow.isMinimized()) {
                globalMainWindow.restore();
            }
            globalMainWindow.show();
            globalMainWindow.focus();
        }
    });

    app.whenReady().then(async () => {
        GlobalState.initialize();
        GlobalState.getInstance().taskManagerState.toolsetProvider = {
            listAvailableToolsets: () => ApplicationRegistry.listAvailableToolsets()
        };
        createWindow();

        // 将内置 skills（applications/skills/resources）自动同步到用户 skills 目录（先完成再注册，确保首次对话能发现技能）
        try {
            await installBundledSkillsIfNeeded();
        } catch (err) {
            console.error('installBundledSkillsIfNeeded error', err);
        }

        registerTaskManagerAPIHandlers();
        registerFSAPIHandlers();
        registerSettingAPIHandlers();
        registerApplicationRegistryHandlers(ipcMain);
        registerNotificationAPIHandlers();
        registerHotKeys();
        registerTray();
        initializeRegistryWorker();
        initializeProtocolHandlers();
        initializeUpdater();
    });

    app.on('will-quit', async () => {
        globalShortcut.unregisterAll();
        // 停止自动更新检查
        if (updateClient) {
            updateClient.stopAutoCheck();
        }
    });
}

startApplication();
