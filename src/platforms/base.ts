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
import open from 'open';

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

    async openPath(filePath: string) {
        await open(filePath);
    }

    async showItemInFolder(filePath: string) {}

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
}

export function getPlatform(): AbstractPlatform {
    if (__platform === null) {
        throw new Error('Platform is not set');
    }
    return __platform;
}
