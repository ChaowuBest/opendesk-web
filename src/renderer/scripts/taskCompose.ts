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

/**
 * composeTask 消费端：应用 iframe（如管理后台）经 window.parent.postMessage 投递
 * { type: 'composeTask', prompt, filePaths } 到主窗口后，这里切到新任务页（主页）
 * 并把 prompt 与附件 pill 预填进 <agent-input id="agent-input-main">，用户按发送即开始任务。
 * 流程与 quickcaptureInbox 同构（openHomePage → 轮询挂载 → 注入）。
 */

export interface ComposeTaskRequest {
    prompt: string;
    filePaths?: string[];
}

interface ComposeAgentInputElement {
    setText?: (text: string) => void;
    /** 清空已附文件与图片（compose 为覆盖式预填，避免遗留 pill 误入当前任务） */
    clearAttachedFilePaths?: () => void;
    attachFilePaths?: (filePaths: string[]) => Promise<boolean>;
    ensureInputExpanded?: () => void;
}

export interface TaskComposeDependencies {
    /** 打开新任务页（主页）；默认走 window.globalControlAPI.openHomePage()。 */
    openHomePage?: () => void;
    /** 查找主页输入框；默认在 document 中查找。 */
    findAgentInput?: () => ComposeAgentInputElement | null;
    /** 轮询等待主页输入框挂载的间隔与次数上限。 */
    mountPollIntervalMs?: number;
    mountPollMaxAttempts?: number;
    /** 向请求方（发起 composeTask 的应用 iframe）回执预填结果。 */
    postResult?: (source: unknown, payload: ComposeResultMessage) => void;
    /** 判断消息来源是否可信；默认只接受主窗口自身与内置应用 iframe（见 isApplicationFrameSource）。 */
    isTrustedSource?: (source: unknown) => boolean;
    /**
     * 预填失败时的用户可见反馈（默认无操作）。发起方是应用 iframe，而预填会先切走应用视图，
     * 它的 toast 此刻不可见，因此由主窗口负责提示（index.js 注入 notificationAPI 实现）。
     */
    notifyFailure?: (reason: ComposeFailureReason) => void;
}

/** 预填失败原因：input_not_found（主页输入框未挂载）/ busy（上一次预填未结束）/ invalid（载荷非法） */
export type ComposeFailureReason = 'input_not_found' | 'busy' | 'invalid';

/** 预填结果回执：由主窗口发回发起 composeTask 的 iframe，用于给出准确的成功/失败提示 */
export interface ComposeResultMessage {
    type: 'composeTaskResult';
    ok: boolean;
    /** 原样带回请求里的 requestId：同一 iframe 可能有多条 compose 并发，发起方据此只认自己的回执 */
    requestId?: string;
    reason?: ComposeFailureReason;
}

const APP_FRAMES_CONTAINER_ID = 'app-frames-container';

/**
 * 消息来源校验：composeTask 能让主窗口把任意本地文件挂成附件 pill，
 * 因此只接受两类来源——主窗口自身（同窗口 fallback），以及内置应用 iframe。
 * 外部应用（gui.source === 'user' 的远程 entryUrl）iframe 带 data-external-app 标记，
 * 应用 iframe 内部的子 frame 也不会等于应用 iframe 的 contentWindow，两者都被拒绝。
 * `contentWindow === event.source` 的身份比较成立，因为 Electron 渲染进程内的子 frame
 * 共用同一 WindowProxy（未开启 out-of-process iframe）。
 */
export function isApplicationFrameSource(source: unknown): boolean {
    const win = (globalThis as any).window;
    const doc = (globalThis as any).document;
    if (!source || !win || !doc) {
        return false;
    }
    if (source === win) {
        return true;
    }
    // 容器 id 变化时退回全文档搜索，避免来源校验把正常入口一起挡死
    const host = typeof doc.getElementById === 'function' ? (doc.getElementById(APP_FRAMES_CONTAINER_ID) ?? doc) : doc;
    if (typeof host.querySelectorAll !== 'function') {
        return false;
    }
    const frames = host.querySelectorAll('iframe');
    for (let index = 0; index < frames.length; index += 1) {
        const frame = frames[index];
        if (frame?.contentWindow === source) {
            // 外部应用加载的是远程页面，不能借 composeTask 往主窗口注入输入与附件路径
            return frame.getAttribute?.('data-external-app') !== '1';
        }
    }
    return false;
}

const DEFAULT_MOUNT_POLL_INTERVAL_MS = 50;
const DEFAULT_MOUNT_POLL_MAX_ATTEMPTS = 40;

function findMainAgentInput(): ComposeAgentInputElement | null {
    const home = (globalThis as any).document?.getElementById?.('home-page');
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
 * 把一条 compose 请求预填进新任务输入框。
 * 契约是「切到新任务页」：无条件走 openHomePage() 重建主页后轮询等待输入框挂载。
 * 不能复用已存在的输入框——切到应用视图后旧 <home-page> 只是 display:none 仍留在
 * nonAppSlot 里，直接预填会写进不可见页面导致视图不切换。
 * prompt 为空（或纯空白）时直接拒绝；返回 true 表示 prompt 已注入输入框
 * （附件可能因扩展名不支持回退为路径文本）。
 */
export async function composeNewTask(
    request: ComposeTaskRequest,
    deps: TaskComposeDependencies = {}
): Promise<boolean> {
    if (!request || typeof request.prompt !== 'string' || request.prompt.trim().length === 0) {
        return false;
    }
    const openHomePage = deps.openHomePage ?? (() => (globalThis as any).window?.globalControlAPI?.openHomePage?.());
    const findAgentInput = deps.findAgentInput ?? findMainAgentInput;
    const pollInterval = deps.mountPollIntervalMs ?? DEFAULT_MOUNT_POLL_INTERVAL_MS;
    const pollMaxAttempts = deps.mountPollMaxAttempts ?? DEFAULT_MOUNT_POLL_MAX_ATTEMPTS;

    openHomePage();
    let agentInput: ComposeAgentInputElement | null = null;
    for (let attempt = 0; attempt < pollMaxAttempts; attempt += 1) {
        await sleep(pollInterval);
        agentInput = findAgentInput();
        if (agentInput) {
            break;
        }
    }
    if (!agentInput?.setText) {
        console.error('[TaskCompose] main agent input not found, compose request dropped');
        return false;
    }
    agentInput.setText(request.prompt);
    // 覆盖式预填：清掉输入框遗留的附件（上一次 compose 或主页草稿恢复的 pill），
    // 避免旧附件被静默带入当前任务
    agentInput.clearAttachedFilePaths?.();
    // 载荷来自其他 frame，路径在这里统一消毒（非字符串项会在界面上渲染成 [object Object]）
    const filePaths = normalizeComposeFilePaths(request.filePaths);
    if (filePaths.length > 0) {
        // attachFilePaths 会按主进程下发的扩展名白名单过滤：支持的生成附件 pill，
        // 不支持的自动回退为把路径文本写进输入框（与拖拽上传同一语义）
        await agentInput.attachFilePaths?.(filePaths);
    }
    agentInput.ensureInputExpanded?.();
    return true;
}

/** 默认回执通道：把结果发回发起 composeTask 的 iframe（source 跨 origin 时是 WindowProxy） */
function postComposeResult(source: unknown, payload: ComposeResultMessage): void {
    const target = source as { postMessage?: (message: unknown, targetOrigin: string) => void } | null | undefined;
    try {
        target?.postMessage?.(payload, '*');
    } catch (error: any) {
        console.error('[TaskCompose] posting compose result failed:', error);
    }
}

/**
 * 只接受字符串路径：载荷来自其他 frame，非字符串项会被 attachFilePaths 原样塞进 pill，
 * 最终在界面上渲染成 "[object Object]"。空白路径同样丢弃。
 */
function normalizeComposeFilePaths(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

/**
 * 安装 composeTask 的消费监听（纯事件驱动，不做周期轮询）。
 * 消息载荷契约见 AdminConsoleEntryWidget.startCompose：
 * { type: 'composeTask', prompt: string, filePaths?: string[] }。
 * 处理结束（无论成功失败）都会向 event.source 回执 composeTaskResult，
 * 让发起方按真实结果给提示，而不是只凭「消息已发出」就宣布成功。
 * @returns dispose 函数，移除监听。
 */
export function installTaskComposeListener(deps: TaskComposeDependencies = {}): () => void {
    const postResult = deps.postResult ?? postComposeResult;
    const isTrustedSource = deps.isTrustedSource ?? isApplicationFrameSource;
    const notifyFailure = deps.notifyFailure;
    let inFlight = false;
    let warnedUntrustedSource = false;
    const fail = (source: unknown, requestId: string | undefined, reason: ComposeFailureReason): void => {
        postResult(source, { type: 'composeTaskResult', ok: false, reason, requestId });
        // 预填是在切走应用视图之后才失败的：发起方面板已被隐藏，它自己的 toast 用户看不到，
        // 失败反馈必须由主窗口给出
        notifyFailure?.(reason);
    };
    const onMessage = (event: Event): void => {
        const data = (event as MessageEvent)?.data;
        if (!data || data.type !== 'composeTask' || typeof data.prompt !== 'string') {
            return;
        }
        const source = (event as MessageEvent).source;
        // 来源不可信时既不预填也不回执：不向外来页面暴露「主窗口是否处理了请求」
        if (!isTrustedSource(source)) {
            if (!warnedUntrustedSource) {
                warnedUntrustedSource = true;
                console.warn('[TaskCompose] ignored composeTask from an untrusted frame');
            }
            return;
        }
        const requestId = typeof data.requestId === 'string' ? data.requestId : undefined;
        if (inFlight) {
            // 静默丢弃会让发起方误以为已预填，这里明确回执 busy 供其提示用户稍后重试
            fail(source, requestId, 'busy');
            return;
        }
        if (data.prompt.trim().length === 0) {
            fail(source, requestId, 'invalid');
            return;
        }
        inFlight = true;
        composeNewTask({ prompt: data.prompt, filePaths: data.filePaths }, deps)
            .then((ok: boolean) => {
                if (ok) {
                    postResult(source, { type: 'composeTaskResult', ok: true, requestId });
                    return;
                }
                fail(source, requestId, 'input_not_found');
            })
            .catch((err) => {
                console.error('[TaskCompose] compose failed:', err);
                fail(source, requestId, 'input_not_found');
            })
            .finally(() => {
                inFlight = false;
            });
    };
    window.addEventListener('message', onMessage);
    return () => {
        window.removeEventListener('message', onMessage);
    };
}
