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

import fs from 'fs';
import path from 'path';

import { app, BrowserWindow, clipboard, desktopCapturer, ipcMain, screen } from 'electron';

import { logger } from '../../../main/utils/logger.js';
import { t } from '../../../locale/index.js';
import {
    QUICK_CAPTURE_BRING_MAIN_TO_FRONT_EVENT,
    type QuickCaptureKit,
    type QuickCapturePendingCapture,
    type QuickCaptureState
} from '../common.js';

const TAG = '[QuickCapture]';
const OVERLAY_PAGE = 'quickcapture_overlay.html';
/**
 * 遮罩窗口的独立内存 session。Electron 的 zoom 按 origin 共享：若遮罩与主窗口共用
 * 默认 session，遮罩会继承主窗口设过的缩放（gui_config.scale_factor），框选坐标与截图
 * 像素不再一一对应；而遮罩为了 1:1 又会把 zoom 设回 1，反而把主窗口的缩放改回 100%。
 * 独立 partition 隔离 HostZoomMap，两边互不影响。
 */
const OVERLAY_PARTITION = 'opendesk-quickcapture-overlay';
/** 与鸿蒙 QuickCaptureHotkeyManager 的防抖/快速连按保护保持一致。 */
const HOTKEY_DEBOUNCE_MS = 500;
const RAPID_TOGGLE_GUARD_MS = 1000;
const JPEG_QUALITY = 90;

interface OverlayStrings {
    hintDrag: string;
    hintExit: string;
    cancel: string;
    copy: string;
    send: string;
    /** 遮罩显示前的整屏预截屏（JPEG Data URL），作为不透明窗口的背景画面。 */
    backdrop: string;
    /** 预截屏对应的显示器尺寸（DIP）：页面按它铺背景，保证框选与截图像素一一对应。 */
    screenWidth: number;
    screenHeight: number;
}

interface OverlayRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

interface CommitResult {
    ok: boolean;
    message: string;
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(value, max));
}

/** 同一份源码可能被打进 dist/main 或 dist/main/chunks，路径按候选顺序探测。 */
function resolveResourcePath(candidates: string[]): string {
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
    }
    return candidates[0];
}

/**
 * 解析打包产物里的资源路径。优先用运行时 __dirname（CJS 产物可用，指向 dist/main 或
 * dist/main/chunks），并始终保留 app.getAppPath()/dist 作为兜底（测试环境无 __dirname）。
 */
function resolveDistResourcePath(...segments: string[]): string {
    const candidates: string[] = [];
    if (typeof __dirname === 'string') {
        candidates.push(path.join(__dirname, '..', ...segments), path.join(__dirname, '..', '..', ...segments));
    }
    candidates.push(path.join(app.getAppPath(), 'dist', ...segments));
    return resolveResourcePath(candidates);
}

function resolveOverlayPagePath(): string {
    const devServerUrl = process.env['ELECTRON_RENDERER_URL'];
    if (devServerUrl) {
        return new URL(OVERLAY_PAGE, devServerUrl).toString();
    }
    return resolveDistResourcePath('renderer', OVERLAY_PAGE);
}

function resolveOverlayPreloadPath(): string {
    return resolveDistResourcePath('preload', 'quickcapture_overlay.js');
}

/** 遮罩 IPC 只注册一次；处理器统一转发到当前活跃的 kit 实例（bridge 重建时自动接管）。 */
let activeKit: WindowsQuickCaptureKit | null = null;
let ipcHandlersRegistered = false;

function activateKit(kit: WindowsQuickCaptureKit): void {
    activeKit = kit;
}

/**
 * Windows 上的快速截图实现（Alt+Space 全局热键 → 全屏遮罩框选 → 截图投递到新任务输入框）。
 *
 * 与鸿蒙实现的对应关系：
 * - 热键与开关 gate：鸿蒙由 QuickCaptureHotkeyManager + QuickCaptureAdapter 承担，
 *   这里由 main.ts 的 globalShortcut 回调转发到 {@link triggerFromHotkey}。
 * - 遮罩：鸿蒙是独立 UIAbility + ArkTS Canvas 页面，这里是铺满当前显示器的不透明置顶窗口，
 *   页面用同一套绘制参数复刻（见 src/renderer/quickcaptureOverlay.ts）。Windows 上透明窗口
 *   收不到触摸输入，所以挖洞处用遮罩显示前的预截屏（冻结画面）而不是实时桌面。
 * - 截图交接：鸿蒙经 cacheDir 落盘 + 进程内 pending path，这里直接在进程内存里交接 Data URL，
 *   因为遮罩与主窗口同进程，无需落盘。
 */
export class WindowsQuickCaptureKit implements QuickCaptureKit {
    /** 开关状态不持久化：进程重启后恢复默认开启，前端负责同步持久化设置。 */
    private enabled = true;
    private overlayWindow: BrowserWindow | null = null;
    private overlayOpenedAt = 0;
    private preCaptured: Electron.NativeImage | null = null;
    private preCapturedDisplay: Electron.Display | null = null;
    private pending: QuickCapturePendingCapture | null = null;
    /** 本次遮罩是否已把截图交给主窗口（决定关闭遮罩后是否拉起主窗口）。 */
    private delivered = false;
    private opening = false;
    private lastTriggerAt = 0;

    constructor() {
        activateKit(this);
    }

    async getState(): Promise<QuickCaptureState> {
        return { supported: true, enabled: this.enabled };
    }

    async setEnabled(enabled: boolean): Promise<QuickCaptureState> {
        this.enabled = enabled === true;
        if (!this.enabled) {
            this.closeOverlay();
        }
        return { supported: true, enabled: this.enabled };
    }

    /**
     * 取出（并清空）一条待处理的快速截图。
     * Windows 下截图不落盘，直接返回预编码好的 Data URL，读后即清。
     */
    async takePendingCapture(): Promise<QuickCapturePendingCapture | null> {
        const pending = this.pending;
        this.pending = null;
        return pending;
    }

    /** 由 main.ts 的 Alt+Space 全局热键回调转发（见 registerHotKeys）。 */
    triggerFromHotkey(): void {
        if (!this.enabled) {
            logger.info(`${TAG} disabled by setting, ignore hotkey`);
            return;
        }
        const now = Date.now();
        if (now - this.lastTriggerAt < HOTKEY_DEBOUNCE_MS) {
            return;
        }
        this.lastTriggerAt = now;
        if (this.overlayWindow) {
            // 与鸿蒙一致：刚打开的 1s 内再次按热键不会立刻关掉遮罩（避免误触）。
            if (now - this.overlayOpenedAt < RAPID_TOGGLE_GUARD_MS) {
                logger.info(`${TAG} rapid re-press, keep overlay open`);
                return;
            }
            logger.info(`${TAG} hotkey toggle off`);
            this.closeOverlay();
            return;
        }
        logger.info(`${TAG} hotkey triggered`);
        void this.openOverlay();
    }

    private async openOverlay(): Promise<void> {
        if (this.opening || this.overlayWindow) {
            return;
        }
        this.opening = true;
        try {
            // 与鸿蒙一致：遮罩显示前先完成全屏预截取，否则会截到遮罩自身。
            const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
            const capture = await this.captureDisplay(display);
            if (!capture) {
                throw new Error('empty screen capture');
            }
            // 预截取是异步的：期间用户可能在设置里关掉开关，此时不应再弹遮罩。
            if (!this.enabled) {
                logger.info(`${TAG} disabled while capturing, skip overlay`);
                return;
            }
            this.preCaptured = capture;
            this.preCapturedDisplay = display;
            this.delivered = false;
            this.ensureIpcHandlers();
            this.overlayWindow = this.createOverlayWindow(display);
            this.overlayOpenedAt = Date.now();
        } catch (error) {
            logger.error(`${TAG} open overlay failed: ${String(error)}`);
            this.preCaptured = null;
            this.preCapturedDisplay = null;
            this.overlayWindow = null;
        } finally {
            this.opening = false;
        }
    }

    private async captureDisplay(display: Electron.Display): Promise<Electron.NativeImage | null> {
        const width = Math.max(1, Math.round(display.size.width * display.scaleFactor));
        const height = Math.max(1, Math.round(display.size.height * display.scaleFactor));
        const sources = await desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize: { width, height }
        });
        if (sources.length === 0) {
            return null;
        }
        const source = sources.find((item) => item.display_id === String(display.id)) ?? sources[0];
        const image = source.thumbnail;
        return image.isEmpty() ? null : image;
    }

    private createOverlayWindow(display: Electron.Display): BrowserWindow {
        const overlay = new BrowserWindow({
            x: display.bounds.x,
            y: display.bounds.y,
            width: display.bounds.width,
            height: display.bounds.height,
            frame: false,
            // Windows 上透明窗口收不到触摸输入（鼠标正常），触摸屏用户无法框选；
            // 因此遮罩用不透明窗口，挖洞处改由页面铺一张预截屏背景。
            transparent: false,
            backgroundColor: '#000000',
            resizable: false,
            movable: false,
            minimizable: false,
            maximizable: false,
            fullscreenable: false,
            skipTaskbar: true,
            alwaysOnTop: true,
            hasShadow: false,
            show: false,
            enableLargerThanScreen: true,
            webPreferences: {
                preload: resolveOverlayPreloadPath(),
                contextIsolation: true,
                nodeIntegration: false,
                devTools: false,
                // 主窗口按缩放偏好设置过 zoomFactor，Electron 的 zoom 又按 origin 共享；
                // 遮罩的框选坐标必须与 DIP 1:1，否则绘制与命中位置会被整体放大。
                partition: OVERLAY_PARTITION,
                zoomFactor: 1
            }
        });
        overlay.setMenu(null);
        overlay.on('closed', () => this.handleOverlayClosed());
        // 遮罩必须压在普通窗口之上；任务栏仍在遮罩之上（与鸿蒙的 dock 层级一致）。
        overlay.setAlwaysOnTop(true, 'normal');
        overlay.webContents.on('did-finish-load', () => {
            overlay.webContents.setZoomFactor(1);
        });
        overlay.once('ready-to-show', () => {
            if (overlay.isDestroyed()) return;
            overlay.show();
            overlay.focus();
        });

        const page = resolveOverlayPagePath();
        if (page.startsWith('http://') || page.startsWith('https://')) {
            void overlay.loadURL(page);
        } else {
            void overlay.loadFile(page);
        }
        return overlay;
    }

    private handleOverlayClosed(): void {
        const delivered = this.delivered;
        this.overlayWindow = null;
        this.overlayOpenedAt = 0;
        this.preCaptured = null;
        this.preCapturedDisplay = null;
        this.delivered = false;
        if (delivered) {
            app.emit(QUICK_CAPTURE_BRING_MAIN_TO_FRONT_EVENT);
        }
    }

    private closeOverlay(): void {
        const overlay = this.overlayWindow;
        if (overlay && !overlay.isDestroyed()) {
            // 清理与交接统一由 closed 事件处理（handleOverlayClosed）。
            overlay.close();
            return;
        }
        this.overlayWindow = null;
        this.overlayOpenedAt = 0;
        this.preCaptured = null;
        this.preCapturedDisplay = null;
        this.delivered = false;
    }

    /**
     * 按遮罩页面的选区（CSS 像素）裁剪预截屏。
     * 截图是物理像素，按实际图像尺寸与显示器 DIP 尺寸的比率换算。
     */
    private cropSelection(rect: OverlayRect): { image: Electron.NativeImage; width: number; height: number } | null {
        const image = this.preCaptured;
        const display = this.preCapturedDisplay;
        if (!image || !display) {
            return null;
        }
        const size = image.getSize();
        const ratioX = size.width / Math.max(1, display.bounds.width);
        const ratioY = size.height / Math.max(1, display.bounds.height);
        const x = clamp(Math.round(rect.left * ratioX), 0, size.width - 1);
        const y = clamp(Math.round(rect.top * ratioY), 0, size.height - 1);
        const width = clamp(Math.round(rect.width * ratioX), 1, size.width - x);
        const height = clamp(Math.round(rect.height * ratioY), 1, size.height - y);
        return { image: image.crop({ x, y, width, height }), width, height };
    }

    private commitSelection(rect: OverlayRect): CommitResult {
        if (!this.preCaptured || !this.preCapturedDisplay) {
            logger.error(`${TAG} no pre-captured image, cannot commit`);
            return { ok: false, message: t('quickcapture.noData') };
        }
        try {
            const cropped = this.cropSelection(rect);
            if (!cropped) {
                return { ok: false, message: t('quickcapture.noData') };
            }
            const jpeg = cropped.image.toJPEG(JPEG_QUALITY);
            this.pending = { dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}` };
            this.delivered = true;
            logger.info(`${TAG} selection queued: ${cropped.width} x ${cropped.height}`);
            return { ok: true, message: t('quickcapture.sent', { width: cropped.width, height: cropped.height }) };
        } catch (error) {
            logger.error(`${TAG} commit selection failed: ${String(error)}`);
            this.pending = null;
            return { ok: false, message: t('quickcapture.saveFailed') };
        }
    }

    /** 把选区写入系统剪贴板；复制不改变交付状态，关闭遮罩后不会拉起主窗口。 */
    private copySelection(rect: OverlayRect): CommitResult {
        if (!this.preCaptured || !this.preCapturedDisplay) {
            logger.error(`${TAG} no pre-captured image, cannot copy`);
            return { ok: false, message: t('quickcapture.noData') };
        }
        try {
            const cropped = this.cropSelection(rect);
            if (!cropped) {
                return { ok: false, message: t('quickcapture.noData') };
            }
            clipboard.writeImage(cropped.image);
            logger.info(`${TAG} selection copied to clipboard: ${cropped.width} x ${cropped.height}`);
            return { ok: true, message: t('quickcapture.copied', { width: cropped.width, height: cropped.height }) };
        } catch (error) {
            logger.error(`${TAG} copy selection failed: ${String(error)}`);
            return { ok: false, message: t('quickcapture.copyFailed') };
        }
    }

    private isOverlaySender(sender: Electron.WebContents): boolean {
        const overlay = this.overlayWindow;
        return overlay !== null && !overlay.isDestroyed() && overlay.webContents.id === sender.id;
    }

    private overlayStrings(): OverlayStrings {
        const image = this.preCaptured;
        const display = this.preCapturedDisplay;
        // 不透明窗口才能收到触摸输入（Windows 上透明窗口收不到触摸），
        // 于是把预截屏当作遮罩背景：挖洞处显示的是冻结画面而不是实时桌面。
        // 用 JPEG（与最终裁剪产物同格式）控制 IPC 载荷与首帧解码耗时。
        const backdrop =
            image && !image.isEmpty() ? `data:image/jpeg;base64,${image.toJPEG(JPEG_QUALITY).toString('base64')}` : '';
        return {
            hintDrag: t('quickcapture.hintDrag'),
            hintExit: t('quickcapture.hintExit'),
            cancel: t('quickcapture.cancel'),
            copy: t('quickcapture.copy'),
            send: t('quickcapture.send'),
            backdrop,
            screenWidth: display ? display.bounds.width : 0,
            screenHeight: display ? display.bounds.height : 0
        };
    }

    /** 遮罩页面的 IPC 通道一次性注册；处理器自带 sender 校验，只接受当前遮罩窗口的调用。 */
    private ensureIpcHandlers(): void {
        if (ipcHandlersRegistered) return;
        ipcHandlersRegistered = true;

        ipcMain.handle('quickcapture-overlay:ready', (event): OverlayStrings | null => {
            const kit = activeKit;
            if (!kit || !kit.isOverlaySender(event.sender)) return null;
            return kit.overlayStrings();
        });

        ipcMain.handle('quickcapture-overlay:commit', (event, rect: OverlayRect): CommitResult => {
            const kit = activeKit;
            if (!kit || !kit.isOverlaySender(event.sender)) {
                return { ok: false, message: t('quickcapture.saveFailed') };
            }
            return kit.commitSelection(rect);
        });

        ipcMain.handle('quickcapture-overlay:copy', (event, rect: OverlayRect): CommitResult => {
            const kit = activeKit;
            if (!kit || !kit.isOverlaySender(event.sender)) {
                return { ok: false, message: t('quickcapture.copyFailed') };
            }
            return kit.copySelection(rect);
        });

        ipcMain.handle('quickcapture-overlay:close', (event) => {
            const kit = activeKit;
            if (!kit || !kit.isOverlaySender(event.sender)) return { ok: false };
            kit.closeOverlay();
            return { ok: true };
        });
    }
}
