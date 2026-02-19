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

import { BaseTaskManagerUpdateSubscriber, BaseTaskUpdateSubscriber, TaskUpdateChunk } from '../main/states/tasks.js';
import { AbstractPlatform } from './base.js';
import { MailboxApplication } from "../main/applications/mailbox/app.js";
import { FileMgrApplication } from "../main/applications/filemgr/app.js";
import { CalendarApplication } from "../main/applications/calendar/app.js";
import { A2AApplication } from "../main/applications/a2a/app.js";
import { RecallApplication } from "../main/applications/recall/app.js";
import { SearchApplication } from "../main/applications/search/app";
import { NewsApplication } from "../main/applications/news/app.js";
import { TerminalApplication } from "../main/applications/terminal/app.js";
import { PPTCreatorApplication } from "../main/applications/ppt/app.js";
import { DesignerApplication } from "../main/applications/designer/app.js";
import { SkillsApplication } from "../main/applications/skills/app.js";
import { McpMgrApplication } from "../main/applications/mcpmgr/app.js";
import { BaseApplication } from "../main/applications/base";

import path from 'path';


export class ElectronTaskUpdateSubscriber extends BaseTaskUpdateSubscriber {
    senderFrame: Electron.WebFrameMain;

    /**
     * A subscriber for task update
     */
    constructor (senderFrame: Electron.WebFrameMain) {
        super();
        this.senderFrame = senderFrame;
    }

    isAvailable() {
        return !this.senderFrame.isDestroyed();
    }

    /**
     * Send a message to the subscriber
     * @param chunkUpdate the chunk update to send
     */
    send(chunkUpdate: TaskUpdateChunk) {
        this.senderFrame.send(`taskManager:taskUpdate:${this.subscription_id}`, chunkUpdate);
    }
}

export class ElectronTaskManagerUpdateSubscriber extends BaseTaskManagerUpdateSubscriber {
    senderFrame: Electron.WebFrameMain;

    constructor (senderFrame: Electron.WebFrameMain) {
        super();
        this.senderFrame = senderFrame;
    }

    send(taskList: object[]): void {
        this.senderFrame.send(`taskManager:taskListUpdate`, taskList);
    }
}

export class ElectronPlatform extends AbstractPlatform {

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

    getWorkerPath(): string {
        if (!this.electronApp) {
            throw new Error('electronApp is not set, cannot get worker path');
        }
        return path.join(this.electronApp.getAppPath(), 'dist', 'main', 'worker.js');
    }

    getApplicationClasses(): typeof BaseApplication[] {
        return [
            MailboxApplication,
            FileMgrApplication,
            CalendarApplication,
            A2AApplication,
            RecallApplication,
            SearchApplication,
            NewsApplication,
            TerminalApplication,
            PPTCreatorApplication,
            DesignerApplication,
            SkillsApplication,
            McpMgrApplication,
        ];
    }
}