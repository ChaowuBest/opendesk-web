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

import { BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import { IntentParser } from '../services/intent/parser.js';
import { safeSendToWebContents } from '../utils/electron-ipc.js';

/** @type {BrowserWindow | null} */
let globalFloatWindow = null;

const createFloatWindow = () => {
    if (globalFloatWindow !== null) {
        return globalFloatWindow;
    }

    const window = new BrowserWindow({
        width: 800,
        height: 400,
        frame: false,
        titlebarStyle: 'hiddenInset',
        alwaysOnTop: true,
        backgroundMaterial: 'acrylic',
        roundedCorners: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, '..', '..', 'renderer', 'preload.js'),
            devTools: false
        }
    });
    window.setMenu(null);
    window.loadFile(path.join(__dirname, '..', '..', 'renderer', 'floatpage.html'));
    window.once('closed', () => {
        globalFloatWindow = null;
    });

    registerFloatWindowAPIHandlers(window);
    globalFloatWindow = window;

    return window;
};

const registerFloatWindowAPIHandlers = (window) => {
    ipcMain.handle('floatWindow:hideFloatWindow', () => {
        window.hide();
    });
};

const openFloatWindow = async () => {
    const floatWindow = createFloatWindow();
    const screenshot = await IntentParser.getScreenshotAsURL();

    // 首先清理当前浮窗中的意图，然后再显示浮窗
    safeSendToWebContents(floatWindow.webContents, 'floatWindow:intentsUpdate', []);
    floatWindow.show();
    floatWindow.focus();

    const intents = await IntentParser.parseScreen(screenshot);
    safeSendToWebContents(floatWindow.webContents, 'floatWindow:intentsUpdate', intents);
};

export { openFloatWindow };
