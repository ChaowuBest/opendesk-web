/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 *
 * 原生桥共享协议：在主进程 / preload / 渲染进程三种运行时之间共享。
 * 本文件不得引入任何运行时依赖（electron / node / browser 专用 API），
 * 以保证可被任意运行时安全导入。
 */

/** 主进程 ↔ 渲染进程 IPC 通道（opendesk:*），按「能力」划分，与具体系统平台无关。 */
export const IpcChannels = {
    PING: 'opendesk:ping',
    SPEECH_INIT: 'opendesk:speechInit',
    SPEECH_START: 'opendesk:speechStart',
    SPEECH_PEEK: 'opendesk:speechPeek',
    SPEECH_STOP: 'opendesk:speechStop',
    SPEECH_RELEASE: 'opendesk:speechRelease'
} as const;

/** 渲染进程 window 上的桥接对象名 */
export const RENDERER_BRIDGE_GLOBAL = 'opendeskNative';

/**
 * 当前已实现原生桥的系统平台集合（process.platform 取值）。
 * 新增平台接入时，在此登记并在主进程 index.ts 的 resolveNativeBridge() 中提供实现。
 */
const NATIVE_BRIDGE_PLATFORMS: ReadonlySet<string> = new Set<string>(['openharmony']);

/** 指定系统平台是否提供原生桥（preload 与主进程共用此判断，保持一致）。 */
export function isNativeBridgePlatform(platform: string): boolean {
    return NATIVE_BRIDGE_PLATFORMS.has(platform);
}

/**
 * 语音识别能力（平台无关接口）。
 * 各系统平台按自身能力实现；不支持则在 NativeBridge.speech 上返回 null。
 */
export interface NativeSpeechProvider {
    init(): Promise<void>;
    start(): Promise<void>;
    /** 返回当前中间识别结果 */
    peek(): Promise<string>;
    /** 停止并返回最终识别结果 */
    stop(): Promise<string>;
    release(): Promise<void>;
}

/**
 * 系统平台原生桥：聚合各类与系统平台相关的原生能力。
 * 不同平台（OpenHarmony / Windows / macOS / Linux ...）提供各自实现；
 * 某项能力不支持时对应字段返回 null。
 */
export interface NativeBridge {
    /** 实现该桥的系统平台标识（process.platform 取值） */
    readonly platform: string;
    /** 连通性测试，回显入参 */
    ping(message: string): Promise<string>;
    /** 语音识别能力；不支持时为 null */
    readonly speech: NativeSpeechProvider | null;
}
