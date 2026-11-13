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
 * 主进程/worker 的 uncaughtException、unhandledRejection 兜底时，识别"可恢复错误"。
 *
 * 这类错误发生在窗口/renderer/帧已销毁的竞态下，进程本身健康——例如用户关掉
 * 内置浏览器宿主窗口的同一时刻，后台任务正好向该窗口推送更新。把整类错误降级为
 * 日志告警（而非弹 FATAL 对话框并 app.exit(1)），既避免一次点击导致整个应用退出，
 * 又保留 [RECOVERABLE] 日志便于事后定位真正的调用点。
 *
 * 判定刻意保守：这里是"关掉一整类异常"的地方，宁可漏判也不误判——
 * - 已销毁对象错误按**整句**匹配而非子串，避免把"消息里恰好含这段文字"的真实异常
 *   一起静默掉；
 * - `undefined.send` 这类属性访问错误只认 send/isDestroyed，且堆栈必须落在 Electron
 *   原生帧上，普通类型错误仍按致命处理；
 * - 命中后由 logRecoverableMainProcessError 去重限流，避免 tick 级刷屏。
 *
 * 代码里已用 safeSendToWebContents/safeSendToWebFrame 对已知发送点做了防护，
 * 这里是兜底网：WebContents/WebFrameMain 的触点很多（webview 生命周期、应用回调、
 * 插件、第三方宿主代码），无法逐一守护，漏网时不应升级为进程退出。
 */

/**
 * Electron 在已销毁/已释放的原生对象上调用方法时抛出的错误文案。
 *
 * 每条都锚定首尾，不做子串匹配——否则"消息里恰好带了相同文字"的真实异常会被静默掉。
 * 但也要列出真实存在的完整文案：WebFrameMain 在 render frame 已释放后访问抛的是
 * "Render frame was disposed before WebFrameMain could be accessed"，只写前缀会漏判。
 */
const DISPOSAL_ERROR_PATTERNS = [
    /^object has been destroyed$/,
    /^render frame was disposed(?: before webframemain could be accessed)?$/,
    /^webframemain (?:is|was) disposed$/,
    /^webframe (?:is|was) disposed$/
];

/**
 * 已销毁对象上的属性访问失败（`undefined.send` / `null.send`）。
 * 必须同时命中 Electron 原生栈帧才算可恢复，否则任何普通的类型错误都会被误吞。
 */
const DISPOSAL_PROPERTY_ACCESS_PATTERN =
    /^cannot read propert(?:y|ies) of (?:undefined|null) \(reading '(?:send|isDestroyed)'\)$/;

/** Electron 原生绑定帧在 V8 堆栈中的文案，用于区分"WebContents 已销毁"与普通类型错误。 */
const ELECTRON_NATIVE_STACK_HINT = 'node:electron';

/** 同一指纹的可恢复错误在该窗口期内只输出一条日志。 */
const RECOVERABLE_LOG_WINDOW_MS = 60_000;

/** 去重键上限：异常指纹可能来自任意调用点，防止 Map 无界增长。 */
const RECOVERABLE_LOG_MAX_ENTRIES = 100;

interface RecoverableLogEntry {
    /** 窗口期内被抑制的条数 */
    suppressed: number;
    /** 上次实际输出日志的时间戳 */
    lastLoggedAt: number;
}

const recoverableLogEntries = new Map<string, RecoverableLogEntry>();

/**
 * 日志去重指纹：可恢复原因 + 消息 + 第一个堆栈帧（调用点）。
 *
 * 只用消息首行不够——同一个 "Object has been destroyed" 可能来自完全不同的调用点，
 * 按调用点分开计数才能既压住单点刷屏、又不掩盖新出现的第二处问题。
 * 帧内的行号/列号在同一进程内稳定，保留它们能进一步区分同一函数的不同调用行。
 */
function buildLogFingerprint(reason: string, details: string): string {
    const lines = details.split('\n').map((line) => line.trim());
    const message = lines[0] ?? '';
    const callSite = lines.find((line, index) => index > 0 && line.startsWith('at ')) ?? '';
    return `${reason}\u0000${message}\u0000${callSite}`;
}

function normalizeMessage(message: string): string {
    return message
        .trim()
        .toLowerCase()
        .replace(/[.\s]+$/, '');
}

/** 安全读取 errno 风格错误码，避免对任意抛出值做属性访问。 */
function readErrorCode(error: unknown): string | null {
    if (typeof error !== 'object' || error === null) return null;
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
}

/** 可恢复原因：管道/网络断开（环境性错误，与调用点无关）。 */
export const RECOVERABLE_REASON_EPIPE = 'EPIPE (网络/管道断开)';

/** 可恢复原因：Electron 对象已销毁/帧已释放（销毁竞态，与调用点有关）。 */
export const RECOVERABLE_REASON_DISPOSAL = 'Electron 对象已销毁/帧已释放';

/** 可恢复原因：上游返回越界 HTTP 状态码（环境/上游问题）。 */
export const RECOVERABLE_REASON_HTTP_STATUS = 'Out-of-range HTTP status code';

/**
 * 是否把可恢复错误降级为告警（而不是弹 FATAL 对话框并退出）。
 *
 * debug 模式只对"与调用点有关的销毁竞态"保持致命——开发期必须能立刻看到这类问题，
 * 否则它只会安静地消失在日志里；EPIPE、越界 HTTP 状态码属于环境/上游问题，与我们的
 * 代码无关，debug 模式下同样降级，免得调试实例因为终端断开就退出。
 */
export function shouldDowngradeRecoverableError(reason: string, debugMode: boolean): boolean {
    if (!debugMode) return true;
    return reason === RECOVERABLE_REASON_EPIPE || reason === RECOVERABLE_REASON_HTTP_STATUS;
}

/**
 * 判定异常是否属于"进程健康、可以继续运行"的可恢复错误。
 * @returns 可恢复原因（用于日志）；不可恢复时返回 null
 */
export function isRecoverableMainProcessError(error: unknown): string | null {
    // EPIPE 是可恢复的网络/管道断开错误：常见于系统休眠后网络恢复、或终端管道断开
    if (readErrorCode(error) === 'EPIPE') {
        return RECOVERABLE_REASON_EPIPE;
    }

    if (!(error instanceof Error)) return null;

    // Electron net.fetch() 遇到越界 HTTP 状态码（如 LinkedIn 返回 999）
    if (error instanceof RangeError && error.stack?.includes('initializeResponse')) {
        return RECOVERABLE_REASON_HTTP_STATUS;
    }

    const message = normalizeMessage(error.message ?? '');
    if (DISPOSAL_ERROR_PATTERNS.some((pattern) => pattern.test(message))) {
        return RECOVERABLE_REASON_DISPOSAL;
    }
    if (DISPOSAL_PROPERTY_ACCESS_PATTERN.test(message) && error.stack?.includes(ELECTRON_NATIVE_STACK_HINT)) {
        return RECOVERABLE_REASON_DISPOSAL;
    }

    return null;
}

/**
 * 输出可恢复错误日志，并对同一指纹做去重限流。
 *
 * 一个已销毁的 webview 若被定时器持续推送，错误会在每个 tick 触发一次；带上完整
 * 堆栈原样刷日志会直接淹没真正的告警，因此窗口期内的重复只计数不输出。
 *
 * @param warn 日志输出函数（调用方负责绑定 logger/写 stderr）
 * @param reason isRecoverableMainProcessError 返回的可恢复原因
 * @param details 错误详情（通常是 stack）
 * @param now 当前时间戳，测试可注入
 */
export function logRecoverableMainProcessError(
    warn: (message: string) => void,
    reason: string,
    details: string,
    now: number = Date.now()
): void {
    // 指纹用 原因 + 消息 + 调用点：同一处反复触发才抑制，不同调用点各自独立计数
    const fingerprint = buildLogFingerprint(reason, details);
    const entry = recoverableLogEntries.get(fingerprint);
    if (entry === undefined) {
        if (recoverableLogEntries.size >= RECOVERABLE_LOG_MAX_ENTRIES) {
            recoverableLogEntries.clear();
        }
        recoverableLogEntries.set(fingerprint, { suppressed: 0, lastLoggedAt: now });
        warn(`[RECOVERABLE] ${reason}: ${details}`);
        return;
    }

    if (now - entry.lastLoggedAt < RECOVERABLE_LOG_WINDOW_MS) {
        entry.suppressed += 1;
        return;
    }

    const suppressed = entry.suppressed;
    entry.suppressed = 0;
    entry.lastLoggedAt = now;
    warn(`[RECOVERABLE] ${reason}: ${details} (窗口期内同类错误已抑制 ${suppressed} 条)`);
}

/** 仅供测试：清空限流状态，避免用例之间互相影响。 */
export function resetRecoverableLogState(): void {
    recoverableLogEntries.clear();
}
