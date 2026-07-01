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

import { BaseApplication } from '../main/applications/base';
import type { TaskState } from '../main/aikernel/states/tasks.js';
import type { NativeBridge } from './native/constants.js';

export interface PlatformFetchOptions {
    /** Prefer proxy settings inherited from the process environment for this request. */
    forceEnvironmentProxy?: boolean;
    /** Bypass all configured proxies for this request. */
    bypassProxy?: boolean;
    /** Disable TLS certificate verification for this request when the platform supports it. */
    skipTlsVerification?: boolean;
}

export abstract class AbstractPlatform {
    getName(): string {
        throw new Error('Not implemented');
    }

    abstract getEffectiveWorkspace(): string;

    /**
     * 为任务注入平台相关的提供者（权限确认 UI、交互工具集等）。
     * 仅处理跨平台存在差异的部分，与 mode/harness 无关的通用逻辑由 TaskManagerState.initHarness 完成。
     */
    abstract initPlatformHarness(task: TaskState): Promise<void>;

    /**
     * 发起 HTTP 请求，自动继承系统代理配置。
     * 各平台实现方式不同：CLI 使用内置 fetch 搭配按需 dispatcher，Electron 使用 Chromium net/session.fetch，Worker 通过 IPC 转发到主进程。
     * 签名与标准 fetch API 兼容。
     */
    abstract fetch(input: string | URL, init?: RequestInit, options?: PlatformFetchOptions): Promise<Response>;

    /**
     * 获取当前系统平台的原生桥（聚合系统相关原生能力，如语音识别等）。
     * 默认无原生桥（CLI / Worker 等），由具体平台覆写提供实现。
     */
    /**
     * 获取平台需要注入到所有子进程中的环境变量。
     * 默认返回空 Map，各平台可覆写添加自己的环境变量。
     */
    getInjectedEnviron(): Map<string, string> {
        return new Map();
    }

    getNativeBridge(): NativeBridge | null {
        return null;
    }

    async openPath(_filePath: string): Promise<void> {
        throw new Error('Not implemented');
    }

    async openExternal(_url: string): Promise<void> {
        throw new Error('Not implemented');
    }

    async trashItem(_filePath: string): Promise<void> {
        throw new Error('Not implemented');
    }

    async showItemInFolder(_filePath: string): Promise<void> {
        throw new Error('Not implemented');
    }

    getWorkerPath(): string {
        return process.argv[1];
    }

    getApplicationClasses(): (typeof BaseApplication)[] {
        return [];
    }
}

let __platform: AbstractPlatform | null = null;

export function setPlatform(platform: AbstractPlatform) {
    __platform = platform;
    // Expose getPlatform globally so the generated openclaw plugin-sdk shim
    // (which lives outside the app bundle) can access the platform instance
    // without needing a file:// import back into the bundle.
    (globalThis as any).__opendesk_getPlatform = getPlatform;
}

export function getPlatform(): AbstractPlatform {
    if (__platform === null) {
        throw new Error('Platform is not set');
    }
    return __platform;
}
