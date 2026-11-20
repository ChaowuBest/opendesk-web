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
    BaseTaskManagerUpdateSubscriber,
    BaseTaskUpdateSubscriber,
    TaskUpdateChunk
} from '../main/aikernel/states/tasks.js';
import type { TaskState } from '../main/aikernel/states/tasks.js';
import { WorkerPlatform } from './worker.js';
import { getGuiApplicationClasses } from './applications.js';
import { ElectronPermissionPromptProvider } from '../main/aikernel/security/electronPrompt.js';
import { ElectronAskUserProvider } from '../main/aikernel/interaction/electronAskUser.js';
import { ElectronExitPlanModeProvider } from '../main/aikernel/interaction/electronExitPlanMode.js';
import { createInteractionToolset } from '../main/aikernel/interaction/tools.js';
import { createGenUiTools } from '../main/aikernel/interaction/genui.js';
import { ElectronGenUiProvider } from '../main/aikernel/interaction/electronGenUi.js';
import { switchTaskMode } from '../main/aikernel/task/mode.js';
import { serializeTaskUpdateForRender } from '../main/aikernel/task/update-render.js';
import { resolveNativeBridge } from './bridges/main.js';
import type { NativeBridge } from './bridges/common.js';
import { electron } from '../utils/electron.js';
import { logger } from '../main/utils/logger.js';
import { safeSendToWebContents, safeSendToWebFrame } from '../main/utils/electron-ipc.js';
import { isHostInNoProxy } from '../main/utils/proxy.js';
import { getHarmonyOSSystemProxy } from './bridges/harmonyos/proxy.js';
import { Setting } from '../main/utils/setting.js';
import type { PlatformFetchOptions, PlatformNetworkConfig } from './base.js';
import type { InteractiveToolset } from '../main/aikernel/tool.js';
import crypto from 'crypto';
import path from 'path';
import { SlidesApplication } from '../main/applications/slides/app.js';
import { configureSlidesCapabilityProvider } from '../main/applications/slides/provider.js';
import {
    isOpenDeskPresentationProgramAvailable,
    openOpenDeskSlidesPresentation,
    runOpenDeskPresentationProgram
} from '../main/office/openDeskOfficeHost.js';

interface ElectronFetchSessionOptions {
    proxyUrl?: string | null;
    bypassProxy?: boolean;
    skipTlsVerification?: boolean;
    proxyBypassRules?: string;
}

const electronFetchSessionCache = new Map<string, Promise<Electron.Session>>();

/** openPath 等待上游 settle 的上限：xdg-open 正常派发在数百毫秒内完成，
 * 超过该时长仍未 settle 即视为命中上游挂起缺陷，放行调用方（详见 openPath） */
const OPEN_PATH_SETTLE_TIMEOUT_MS = 5000;

function formatProxyHostPort(proxyUrl: URL): string {
    const hostname = proxyUrl.hostname.includes(':')
        ? `[${proxyUrl.hostname.replace(/^\[|\]$/g, '')}]`
        : proxyUrl.hostname;
    return `${hostname}${proxyUrl.port ? `:${proxyUrl.port}` : ''}`;
}

function electronProxyRules(proxyUrl: string): string {
    const parsed = new URL(proxyUrl);
    const hostPort = formatProxyHostPort(parsed);
    if (parsed.protocol === 'socks:' || parsed.protocol === 'socks4:' || parsed.protocol === 'socks5:') {
        return `${parsed.protocol}//${hostPort}`;
    }
    if (parsed.protocol === 'https:') {
        return `http=https://${hostPort};https=https://${hostPort}`;
    }
    return `http=${hostPort};https=${hostPort}`;
}

async function getElectronFetchSession(options: ElectronFetchSessionOptions): Promise<Electron.Session> {
    const proxyKey = options.bypassProxy
        ? 'direct'
        : options.proxyUrl
          ? `proxy:${options.proxyUrl}:${options.proxyBypassRules ?? ''}`
          : 'system';
    const key = `${proxyKey}:tls:${options.skipTlsVerification ? 'skip' : 'verify'}`;
    let sessionPromise = electronFetchSessionCache.get(key);
    if (!sessionPromise) {
        sessionPromise = (async () => {
            const { session } = await import('electron');
            const partitionHash = crypto.createHash('sha256').update(key).digest('hex');
            const fetchSession = session.fromPartition(`opendesk-model-fetch-${partitionHash}`, { cache: false });
            if (options.bypassProxy) {
                await fetchSession.setProxy({ mode: 'direct' });
            } else if (options.proxyUrl) {
                await fetchSession.setProxy({
                    mode: 'fixed_servers',
                    proxyRules: electronProxyRules(options.proxyUrl),
                    proxyBypassRules: options.proxyBypassRules ?? '<local>;localhost;*.localhost;127.0.0.1;127.*;[::1]'
                });
            } else {
                await fetchSession.setProxy({ mode: 'system' });
            }
            if (options.skipTlsVerification) {
                fetchSession.setCertificateVerifyProc((_request, callback) => callback(0));
            }
            return fetchSession;
        })();
        electronFetchSessionCache.set(key, sessionPromise);
    }
    return sessionPromise;
}

export class ElectronTaskUpdateSubscriber extends BaseTaskUpdateSubscriber {
    senderFrame: Electron.WebFrameMain;

    /**
     * A subscriber for task update
     */
    constructor(senderFrame: Electron.WebFrameMain) {
        super();
        this.senderFrame = senderFrame;
        this.wantsHtmlRender = true;
        this.supportsReplaceDelta = true;
    }

    isAvailable() {
        return !this.senderFrame.isDestroyed();
    }

    /**
     * Send a message to the subscriber
     * @param chunkUpdate the chunk update to send
     */
    send(chunkUpdate: TaskUpdateChunk) {
        safeSendToWebFrame(
            this.senderFrame,
            `taskManager:taskUpdate:${this.subscription_id}`,
            serializeTaskUpdateForRender(chunkUpdate)
        );
    }
}

export class ElectronTaskManagerUpdateSubscriber extends BaseTaskManagerUpdateSubscriber {
    senderFrame: Electron.WebFrameMain;

    constructor(senderFrame: Electron.WebFrameMain) {
        super();
        this.senderFrame = senderFrame;
    }

    isAvailable() {
        return !this.senderFrame.isDestroyed();
    }

    send(taskList: object[]): void {
        if (!this.isAvailable()) return;
        safeSendToWebFrame(this.senderFrame, `taskManager:taskListUpdate`, taskList);
    }
}

export class ElectronPlatform extends WorkerPlatform {
    /**
     * 如果在Worker中使用，由于Worker中无法获取Electron的原始信息，所以这里的App就只能为
     * undefined
     */
    electronApp: Electron.App | undefined;

    constructor(electronApp: Electron.App | undefined = undefined) {
        super();
        this.electronApp = electronApp;
        configureSlidesCapabilityProvider({
            openPresentation: openOpenDeskSlidesPresentation,
            isProgramAvailable: isOpenDeskPresentationProgramAvailable,
            executeProgram: runOpenDeskPresentationProgram
        });
    }

    getName(): string {
        return 'electron';
    }

    /**
     * 注入到所有子进程的环境变量。只覆写在 ElectronPlatform：CLI（CliPlatform，含其
     * worker 线程）与 WorkerPlatform 都不带这条变量，OpenDesk 本机的 shell 沙箱由 Electron
     * 主进程发起，覆盖这里即可。
     *
     * OPENSSL_armcap=0：关闭 openssl 的 ARM 运行时 capability 探测，固定走通用实现，
     * 避免探测结果在宿主/沙箱环境下与真实可执行指令不一致而踩到非法加速分支。
     */
    getInjectedEnviron(): Map<string, string> {
        return new Map([['OPENSSL_armcap', '0']]);
    }

    /**
     * Electron 主进程直接读 Setting：WorkerPlatform 的实现返回的是 workerData 快照，
     * 在主线程里为空，不能代表用户当前配置。
     */
    getNetworkConfig(): PlatformNetworkConfig {
        const nc = Setting.getInstance().getData().network_config;
        return {
            no_ssl: nc.no_ssl,
            use_proxy: nc.use_proxy,
            custom_proxy_addr: nc.custom_proxy_addr,
            no_proxy: nc.no_proxy
        };
    }

    getApplicationClasses() {
        return [...getGuiApplicationClasses(), SlidesApplication];
    }

    async fetch(input: string | URL, init?: RequestInit, options?: PlatformFetchOptions): Promise<Response> {
        const url = input instanceof URL ? input.href : input;
        const networkConfig = Setting.getInstance().getData().network_config;
        const useProxy = networkConfig.use_proxy ?? 'system';
        const customProxyUrl = networkConfig.custom_proxy_addr.trim();
        const bypassProxy =
            !!options?.bypassProxy ||
            isHostInNoProxy(url) ||
            useProxy === 'none' ||
            (useProxy === 'custom' && customProxyUrl.length === 0);
        let proxyUrl = useProxy === 'custom' && !bypassProxy ? customProxyUrl : null;
        let proxyBypassRules: string | undefined;

        // On OpenHarmony, Chromium's setProxy({ mode: 'system' }) does not read the OS
        // proxy configuration. When use_proxy is 'system', bridge to ArkTS to retrieve
        // the system HTTP proxy via connection.getDefaultHttpProxy() and convert it to
        // fixed_servers mode so Chromium actually uses it.
        if (useProxy === 'system' && !bypassProxy && (process.platform as string) === 'openharmony') {
            try {
                const systemProxy = await getHarmonyOSSystemProxy();
                if (systemProxy) {
                    // 鸿蒙 getDefaultHttpProxy().host 可能带协议前缀（如 "http://1.2.3.4"），
                    // 此处统一剥离，再拼成标准 "http://host:port" 格式
                    const cleanHost = systemProxy.host.replace(/^https?:\/\//, '');
                    proxyUrl = `http://${cleanHost}:${systemProxy.port}`;
                    if (systemProxy.exclusionList.length > 0) {
                        proxyBypassRules = [
                            ...systemProxy.exclusionList,
                            '<local>',
                            'localhost',
                            '*.localhost',
                            '127.0.0.1',
                            '127.*',
                            '[::1]'
                        ].join(';');
                    }
                }
            } catch {
                // Bridge failure: degrade to Chromium's system mode (original behavior)
            }
        }

        // Electron must stay on Chromium's network stack. Some Electron target platforms
        // (notably the OpenHarmony adapter) cannot load undici here; do not replace this
        // implementation with the shared undici-based proxy-fetch helper.
        // In system mode, Electron delegates directly to the OS proxy configuration.
        // Environment proxy variables are intentionally not converted into fixed proxy rules.
        const fetchSession = await getElectronFetchSession({
            proxyUrl,
            bypassProxy,
            skipTlsVerification: networkConfig.no_ssl || options?.skipTlsVerification,
            proxyBypassRules
        });
        return fetchSession.fetch(url, init);
    }

    getNativeBridge(): NativeBridge | null {
        return resolveNativeBridge();
    }

    async openPath(filePath: string): Promise<void> {
        const opened = electron().shell.openPath(filePath);
        // 超时兜底后上游 promise 仍可能拒绝（不能成为 unhandled rejection），
        // 真实失败信息保留在日志里供诊断
        opened.catch((error) => logger.warn(`[platform] openPath rejected: ${filePath} ${error}`));
        let timer: NodeJS.Timeout | undefined;
        const settled = await Promise.race([
            opened.then(() => true),
            new Promise<false>((resolve) => {
                timer = setTimeout(() => resolve(false), OPEN_PATH_SETTLE_TIMEOUT_MS);
            })
        ]);
        clearTimeout(timer);
        if (!settled) {
            // Electron Linux 的 shell.openPath 存在 promise 永不 settle 的上游分支
            // （xdg-open wait_for_exit=false 路径不回调）：此时系统默认应用通常已被
            // 成功派发（文件实际已打开），等待只会让 await 本方法的 IPC handler
            // 永不 reply（renderer 卡"打开中"，窗口重载后报 "reply was never sent"）。
            logger.warn(
                `[platform] openPath not settled in ${OPEN_PATH_SETTLE_TIMEOUT_MS}ms, assuming dispatched: ${filePath}`
            );
        }
    }

    async openExternal(url: string): Promise<void> {
        await electron().shell.openExternal(url);
    }

    async trashItem(filePath: string): Promise<void> {
        await electron().shell.trashItem(filePath);
    }

    async showItemInFolder(filePath: string): Promise<void> {
        electron().shell.showItemInFolder(filePath);
    }

    async initPlatformHarness(task: TaskState): Promise<void> {
        task.harnessContext.permissionPrompt = new ElectronPermissionPromptProvider();
        task.interactionToolset = this.createInteractionToolset(task);
    }

    createInteractionToolset(task: TaskState): InteractiveToolset {
        const askUserProvider = new ElectronAskUserProvider();
        const exitPlanModeProvider = new ElectronExitPlanModeProvider();
        exitPlanModeProvider.setModeSwitcher(async (targetModeId: string) => {
            const switched = await switchTaskMode(task, targetModeId, () => new ElectronPermissionPromptProvider());
            if (!switched) return;
            // 通知 renderer 更新该任务的模式显示（模式按钮/下拉）
            const { BrowserWindow } = electron();
            for (const win of BrowserWindow.getAllWindows()) {
                if (!win.isDestroyed()) {
                    safeSendToWebContents(win.webContents, 'mode:taskModeChanged', task.task_id, targetModeId);
                }
            }
        });
        const toolset = createInteractionToolset(askUserProvider, exitPlanModeProvider);
        // 生成式 UI（showUI/askUI）依赖 GUI 渲染进程，只在 Electron 平台挂载
        for (const tool of createGenUiTools(new ElectronGenUiProvider())) {
            toolset.addTool(tool);
        }
        return toolset;
    }

    getWorkerPath(): string {
        if (!this.electronApp) {
            throw new Error('electronApp is not set, cannot get worker path');
        }
        return path.join(this.electronApp.getAppPath(), 'dist', 'main', 'worker.js');
    }
}
