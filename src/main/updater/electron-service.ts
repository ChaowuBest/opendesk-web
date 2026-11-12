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

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { app, ipcMain } from 'electron';
import { GlobalState } from '../aikernel/states/global.js';
import { safeSendToWebContents } from '../utils/electron-ipc.js';
import { getPlatform } from '../../platforms/base.js';
import { UpdateCoordinator } from './coordinator.js';
import {
    DEFAULT_UPDATE_FEED_URL,
    UPDATE_CHECK_INTERVAL_MS,
    UPDATE_PACKAGE_TRUST_MODE,
    resolveUpdateCacheDirectory
} from './config.js';
import { copyLocalInstaller, downloadInstaller } from './download.js';
import { createMacInstallRunner, installFromDmg, resolveAppBundlePath } from './mac-install.js';
import { fetchLatestRelease, type UpdaterTargetArch, type UpdaterTargetPlatform } from './release-feed.js';
import { resolveUpdateRelaunchCommand } from './restart.js';
import { reportUpdateHealthToService, submitUpdateToService } from './update-service-client.js';
import { verifyUpdateInstaller } from './verification.js';
import type { ReadyUpdateRecord, UpdateState } from './types.js';

export interface ElectronUpdateServiceOptions {
    getMainWindow: () => Electron.BrowserWindow | null;
    prepareWindowsForQuit: () => Promise<boolean>;
    quitForRestart: () => void;
    logInfo: (message: string) => void;
    logError: (message: string) => void;
}

function getActiveTaskIds(): string[] {
    return GlobalState.getInstance()
        .taskManagerState.tasks.filter((task) => task.task_status === 'running' || task.task_status === 'waiting')
        .map((task) => task.task_id);
}

function updaterEnabled(): boolean {
    return (
        (process.platform === 'win32' || process.platform === 'darwin') &&
        (app.isPackaged || process.env.OPENDESK_UPDATE_FORCE_ENABLE === '1')
    );
}

function updaterTargetPlatform(): UpdaterTargetPlatform {
    return process.platform === 'darwin' ? 'darwin' : 'win32';
}

function updaterTargetArch(): UpdaterTargetArch {
    return process.arch === 'arm64' ? 'arm64' : 'x64';
}

// macOS 二期：挂载已下载校验的 DMG，用 ditto 原位替换当前 .app bundle（失败自动回滚）
function installReadyDmg(record: ReadyUpdateRecord): Promise<void> {
    const appBundlePath = resolveAppBundlePath(process.execPath);
    if (!appBundlePath) {
        throw new Error('OpenDesk is not running from an application bundle');
    }
    // mkdtemp 生成唯一挂载点，避免与用户已挂载的同名卷冲突
    const mountPoint = fs.mkdtempSync(path.join(app.getPath('temp'), 'opendesk-update-'));
    return installFromDmg({
        dmgPath: record.installerPath,
        appBundlePath,
        mountPoint,
        runner: createMacInstallRunner()
    }).finally(() => {
        void fs.promises.rm(mountPoint, { recursive: true, force: true }).catch(() => undefined);
    });
}

/**
 * Node 全局 fetch（undici）不读取 HTTP_PROXY/HTTPS_PROXY，也不经过 Chromium
 * 网络栈，内网代理环境下会直连失败。updater 的所有网络请求必须走平台
 * fetch（session.setProxy，none/system/custom 三种代理模式均已覆盖）。
 *
 * 参数取 `string | URL | Request`（即 RequestInfo | URL），以便本函数可直接
 * 作为 `typeof fetch` 传给 download.ts / release-feed.ts 的 fetchImpl；
 * 平台 fetch 只接受 `string | URL`，因此 Request 输入按其 url 转发。
 */
function platformProxyFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    if (input instanceof Request) {
        return getPlatform().fetch(input.url, init);
    }
    return getPlatform().fetch(input, init);
}

export function registerElectronUpdateService(options: ElectronUpdateServiceOptions): UpdateCoordinator | undefined {
    if (!updaterEnabled()) {
        ipcMain.handle('updater:getState', () => ({
            status: 'ok',
            data: { status: 'unsupported' } satisfies UpdateState
        }));
        ipcMain.handle('updater:check', () => ({
            status: 'ok',
            data: { status: 'unsupported' } satisfies UpdateState
        }));
        ipcMain.handle('updater:restart', () => ({ status: 'ok', data: false }));
        ipcMain.handle('updater:applyManual', () => ({ status: 'ok', data: false }));
        return undefined;
    }

    const manualInstall = process.platform === 'darwin';
    const installerExtension = manualInstall ? '.dmg' : '.exe';
    const stateDirectory = resolveUpdateCacheDirectory(app.getPath('userData'));
    const feedUrl = process.env.OPENDESK_UPDATE_FEED_URL || DEFAULT_UPDATE_FEED_URL;
    const allowUnverified = process.env.OPENDESK_UPDATE_ALLOW_UNVERIFIED === '1';
    const localTestInstaller = process.env.OPENDESK_UPDATE_TEST_INSTALLER;
    const localTestVersion = process.env.OPENDESK_UPDATE_TEST_VERSION;
    const trustedSignerSubjects = process.env.OPENDESK_UPDATE_SIGNER_SUBJECTS?.split(',')
        .map((subject) => subject.trim())
        .filter(Boolean);
    let lastBroadcastStatus = '';

    const coordinator = new UpdateCoordinator({
        currentVersion: app.getVersion(),
        stateDirectory,
        manualInstall,
        installerExtension,
        installManually: manualInstall ? installReadyDmg : undefined,
        fetchRelease: async () => {
            if (!localTestInstaller)
                return fetchLatestRelease(
                    feedUrl,
                    platformProxyFetch,
                    30_000,
                    UPDATE_PACKAGE_TRUST_MODE,
                    updaterTargetArch(),
                    updaterTargetPlatform()
                );
            if (!allowUnverified || !localTestVersion) {
                throw new Error(
                    'A local update test requires OPENDESK_UPDATE_TEST_VERSION and OPENDESK_UPDATE_ALLOW_UNVERIFIED=1'
                );
            }
            const stat = await fs.promises.stat(localTestInstaller);
            return {
                version: localTestVersion,
                installerUrl: 'https://local-test.invalid/' + encodeURIComponent(path.basename(localTestInstaller)),
                installerName: path.basename(localTestInstaller),
                size: stat.size
            };
        },
        download: (release, destination, onProgress) =>
            localTestInstaller
                ? copyLocalInstaller(localTestInstaller, destination, onProgress, installerExtension)
                : downloadInstaller({
                      url: release.installerUrl,
                      destination,
                      expectedSize: release.size,
                      onProgress,
                      fetchImpl: platformProxyFetch
                  }),
        verify: (release, installerPath) =>
            verifyUpdateInstaller({
                installerPath,
                sha256: release.sha256,
                allowUnverified,
                trustMode: UPDATE_PACKAGE_TRUST_MODE,
                trustedSignerSubjects
            }),
        submitToService: submitUpdateToService,
        getActiveTasks: getActiveTaskIds,
        stopActiveTasks: async (taskIds) => {
            const taskManager = GlobalState.getInstance().taskManagerState;
            for (const taskId of taskIds) taskManager.getTask(taskId)?.stop('system');
        },
        flushState: () => GlobalState.getInstance().taskManagerState.flushAllPendingSaves(),
        prepareWindowsForQuit: options.prepareWindowsForQuit,
        relaunch: () => {
            if (manualInstall) {
                // macOS 二期：.app 已原位替换，重启同一路径即新版本
                app.relaunch();
                return;
            }
            const command = resolveUpdateRelaunchCommand(process.execPath, process.pid);
            if (!command.usesStableLauncher) {
                app.relaunch({ execPath: command.executablePath, args: [] });
                return;
            }
            const launcher = spawn(command.executablePath, command.arguments, {
                detached: true,
                stdio: 'ignore',
                windowsHide: true
            });
            launcher.unref();
        },
        quit: options.quitForRestart,
        onStateChanged: (state) => {
            const progressBucket =
                state.status === 'downloading' ? Math.floor(state.receivedBytes / (1024 * 1024)) : '';
            const broadcastStatus = `${state.status}:${'version' in state ? state.version : ''}:${progressBucket}`;
            if (broadcastStatus === lastBroadcastStatus) return;
            lastBroadcastStatus = broadcastStatus;
            const mainWindow = options.getMainWindow();
            if (mainWindow && !mainWindow.isDestroyed()) {
                safeSendToWebContents(mainWindow.webContents, 'updater:stateChanged', state);
            }
            if (state.status === 'error') options.logError(`[updater] ${state.code}: ${state.message}`);
        }
    });

    ipcMain.handle('updater:getState', () => ({ status: 'ok', data: coordinator.getState() }));
    ipcMain.handle('updater:check', async () => ({ status: 'ok', data: await coordinator.checkForUpdates() }));
    ipcMain.handle('updater:restart', async () => ({
        status: 'ok',
        data: await coordinator.restartToApplyUpdate()
    }));
    // macOS 手动安装：ready 后由用户触发挂载 DMG 替换 .app，成功后进入 installed 等待重启
    ipcMain.handle('updater:applyManual', async () => ({
        status: 'ok',
        data: await coordinator.applyManualUpdate()
    }));

    const reportHealthy = () => {
        if (manualInstall) return; // macOS 无 Windows 更新系统服务可上报
        void reportUpdateHealthToService(app.getVersion(), process.pid)
            .then((response) => {
                if (response.code === 'health_recorded' || response.code === 'cleanup_completed') {
                    options.logInfo(`[updater] ${response.code} for ${app.getVersion()}`);
                }
            })
            .catch((error) => {
                options.logError(
                    `[updater] health report failed: ${error instanceof Error ? error.message : String(error)}`
                );
            });
    };
    const mainWindow = options.getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.webContents.isLoadingMainFrame()) mainWindow.webContents.once('did-finish-load', reportHealthy);
        else reportHealthy();
    }

    void coordinator.restore().then(async (state) => {
        if (state.status === 'ready') {
            options.logInfo(`[updater] Restored downloaded update ${state.version}`);
            await coordinator.submitPendingUpdate();
            return;
        }
        void coordinator.checkForUpdates();
    });
    setInterval(() => void coordinator.checkForUpdates(), UPDATE_CHECK_INTERVAL_MS).unref();
    return coordinator;
}
