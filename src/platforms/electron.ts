import { BaseTaskManagerUpdateSubscriber, BaseTaskUpdateSubscriber, TaskUpdateChunk } from '../main/states/tasks.js';
import { app } from 'electron';
import { AbstractPlatform } from './base.js';
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
    static getWorkerPath(): string {
        return path.join(app.getAppPath(), 'dist', 'main', 'worker.js');
    }
}