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

import { NativeBridgeProxy } from '../../platforms/bridges/renderer.js';
import { createRendererTranslator } from '../locale.ts';

interface AgentInputElement extends Element {
    addImage?(dataUrl: string, name?: string): void;
}

interface QuickCaptureKitLike {
    takePendingCapture(): Promise<{ dataUrl: string } | null>;
}

export interface QuickCaptureInboxDependencies {
    /** 返回快速截图 kit；默认走 NativeBridgeProxy。 */
    getQuickCaptureKit?: () => Promise<QuickCaptureKitLike>;
    /** 打开新任务页（主页）；默认走 window.globalControlAPI.openHomePage()。 */
    openHomePage?: () => void;
    /** 查找主页输入框；默认在 document 中查找。 */
    findAgentInput?: () => AgentInputElement | null;
    /** 轮询等待主页输入框挂载的间隔与次数上限。 */
    mountPollIntervalMs?: number;
    mountPollMaxAttempts?: number;
}

const DEFAULT_MOUNT_POLL_INTERVAL_MS = 50;
const DEFAULT_MOUNT_POLL_MAX_ATTEMPTS = 40;

function findMainAgentInput(): AgentInputElement | null {
    const home = document.getElementById('home-page');
    if (!home) {
        return null;
    }
    return home.querySelector('#agent-input-main');
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

/**
 * 取出一条待处理的快速截图并放进主页新任务输入框。
 * 无待处理截图时返回 false；截图读取成功且已注入返回 true。
 */
export async function consumePendingQuickCapture(deps: QuickCaptureInboxDependencies = {}): Promise<boolean> {
    const getKit = deps.getQuickCaptureKit ?? (() => new NativeBridgeProxy().getQuickCaptureKit());
    const openHomePage = deps.openHomePage ?? (() => window.globalControlAPI.openHomePage());
    const findAgentInput = deps.findAgentInput ?? findMainAgentInput;
    const pollInterval = deps.mountPollIntervalMs ?? DEFAULT_MOUNT_POLL_INTERVAL_MS;
    const pollMaxAttempts = deps.mountPollMaxAttempts ?? DEFAULT_MOUNT_POLL_MAX_ATTEMPTS;

    const kit = await getKit();
    const pending = await kit.takePendingCapture();
    if (!pending?.dataUrl) {
        return false;
    }

    let agentInput = findAgentInput();
    if (!agentInput) {
        // 主页未打开：进入新任务页，然后等 <home-page> 挂载出输入框。
        openHomePage();
        for (let attempt = 0; attempt < pollMaxAttempts; attempt += 1) {
            await sleep(pollInterval);
            agentInput = findAgentInput();
            if (agentInput) {
                break;
            }
        }
    }
    if (!agentInput?.addImage) {
        console.error('[QuickCaptureInbox] main agent input not found, pending capture dropped');
        return false;
    }
    const t = createRendererTranslator();
    agentInput.addImage(pending.dataUrl, t('quickcapture.imageName'));
    return true;
}

/**
 * 安装待处理截图的消费监听（纯事件驱动，不做周期轮询）。
 *
 * 触发消费的信号（覆盖三条相互独立的激活路径）：
 * 1. 安装时消费一次 —— 覆盖冷启动交接：overlay 保存截图后才拉起主窗口，
 *    渲染层启动安装时截图已就位；
 * 2. window focus / document visibilitychange —— 主窗口重新激活；
 * 3. openDesk:visibilityChanged(detail=true) —— 主进程 BrowserWindow
 *    show/restore 时经 IPC 推送的 DOM 事件（preload 转发），走原生窗口
 *    生命周期，覆盖 DOM focus 在部分窗口切换路径下不触发的情况。
 *
 * 不轮询的原因：截图路径在 overlay 关闭前约 700ms 即已写入，上述任一
 * 激活信号到达时必然可取到；而每秒轮询会让主进程持续打印
 * "native bridge call: quickCaptureKit:takePendingCapture()" 刷日志。
 *
 * 仅在 HarmonyOS 上安装（window.systemInfo.isOpenHarmony）；其余平台
 * 快速截图热键不存在，消费监听与桥调用一并跳过。
 *
 * @returns dispose 函数，移除全部监听。
 */
export function installQuickCaptureInbox(deps: QuickCaptureInboxDependencies = {}): () => void {
    if (window.systemInfo?.isOpenHarmony !== true) {
        return () => undefined;
    }
    let inFlight = false;
    const tryConsume = (): void => {
        if (inFlight) {
            return;
        }
        inFlight = true;
        consumePendingQuickCapture(deps)
            .catch((err) => {
                console.error('[QuickCaptureInbox] consume failed:', err);
            })
            .finally(() => {
                inFlight = false;
            });
    };
    const onFocus = tryConsume;
    const onVisibilityChange = (): void => {
        if (document.visibilityState === 'visible') {
            tryConsume();
        }
    };
    const onWindowVisibilityChanged = (event: Event): void => {
        if ((event as CustomEvent<boolean>).detail === true) {
            tryConsume();
        }
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('openDesk:visibilityChanged', onWindowVisibilityChanged);
    tryConsume();
    return () => {
        window.removeEventListener('focus', onFocus);
        document.removeEventListener('visibilitychange', onVisibilityChange);
        window.removeEventListener('openDesk:visibilityChanged', onWindowVisibilityChanged);
    };
}
