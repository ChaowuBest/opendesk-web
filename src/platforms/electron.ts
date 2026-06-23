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
import { ElectronPermissionPromptProvider } from '../main/aikernel/security/electronPrompt.js';
import { ElectronAskUserProvider } from '../main/aikernel/interaction/electronAskUser.js';
import { ElectronExitPlanModeProvider } from '../main/aikernel/interaction/electronExitPlanMode.js';
import { createInteractionToolset } from '../main/aikernel/interaction/tools.js';
import { resolveNativeBridge } from './bridges/main.js';
import type { NativeBridge } from './bridges/common.js';
import { electron } from '../utils/electron.js';
import { safeSendToWebFrame } from '../main/utils/electron-ipc.js';
import path from 'path';

export class ElectronTaskUpdateSubscriber extends BaseTaskUpdateSubscriber {
    senderFrame: Electron.WebFrameMain;

    /**
     * A subscriber for task update
     */
    constructor(senderFrame: Electron.WebFrameMain) {
        super();
        this.senderFrame = senderFrame;
        this.wantsHtmlRender = true;
    }

    isAvailable() {
        return !this.senderFrame.isDestroyed();
    }

    /**
     * Send a message to the subscriber
     * @param chunkUpdate the chunk update to send
     */
    send(chunkUpdate: TaskUpdateChunk) {
        safeSendToWebFrame(this.senderFrame, `taskManager:taskUpdate:${this.subscription_id}`, chunkUpdate);
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
    }

    getName(): string {
        return 'electron';
    }

    async fetch(input: string | URL, init?: RequestInit): Promise<Response> {
        const { net } = await import('electron');
        const url = input instanceof URL ? input.href : input;
        return net.fetch(url, init);
    }

    getNativeBridge(): NativeBridge | null {
        return resolveNativeBridge();
    }

    async openPath(filePath: string): Promise<void> {
        await electron().shell.openPath(filePath);
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
        task.interactionToolset = createInteractionToolset(
            new ElectronAskUserProvider(),
            new ElectronExitPlanModeProvider()
        );
    }

    getWorkerPath(): string {
        if (!this.electronApp) {
            throw new Error('electronApp is not set, cannot get worker path');
        }
        return path.join(this.electronApp.getAppPath(), 'dist', 'main', 'worker.js');
    }
}
