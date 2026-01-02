import { BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import { IntentParser } from '../services/intent/parser.js';

/** @type {BrowserWindow | null} */
var globalFloatWindow = null;

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
    })
    window.setMenu(null)
    window.loadFile(path.join(__dirname, '..', '..', 'renderer', 'floatpage.html'));
    window.once('closed', () => {
        globalFloatWindow = null;
    })

    registerFloatWindowAPIHandlers(window);
    globalFloatWindow = window;

    return window;
}

const registerFloatWindowAPIHandlers = (window) => {
    ipcMain.handle('floatWindow:hideFloatWindow', () => {
        window.hide();
    })
}

const openFloatWindow = async () => {
    const floatWindow = createFloatWindow();
    let screenshot = await IntentParser.getScreenshotAsURL();

    // 首先清理当前浮窗中的意图，然后再显示浮窗
    floatWindow.webContents.send('floatWindow:intentsUpdate', []);
    floatWindow.show();
    floatWindow.focus();

    let intents = await IntentParser.parseScreen(screenshot);
    floatWindow.webContents.send('floatWindow:intentsUpdate', intents);

}

export { openFloatWindow };