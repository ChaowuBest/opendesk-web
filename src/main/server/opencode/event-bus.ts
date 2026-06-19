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

import EventEmitter from 'events';
import crypto from 'crypto';
import path from 'path';
import { getServerDefaultWorkspace } from './workspace.js';

let _eventCounter = 0;

function generateEventId(): string {
    return `evt_${Date.now().toString(36)}_${(++_eventCounter).toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

export interface BusEvent {
    id: string;
    type: string;
    properties: Record<string, unknown>;
}

export interface GlobalBusEvent {
    directory?: string;
    project?: string;
    workspace?: string;
    payload: BusEvent;
}

type EventHandler = (event: BusEvent) => void;
type GlobalEventHandler = (event: GlobalBusEvent) => void;

/**
 * 进程内事件总线，用于在 server 各层之间传递事件。
 * 对应 opencode 的 Instance Bus + GlobalBus 概念。
 */
class EventBusImpl {
    private emitter = new EventEmitter();
    private _disposed = false;

    constructor() {
        this.emitter.setMaxListeners(100);
    }

    /**
     * 发布事件。自动生成 event id，并包装为 GlobalBusEvent 转发给全局订阅者。
     * properties 中不需要包含 id，会自动添加。
     */
    publish(event: Omit<BusEvent, 'id'> & { id?: string; directory?: string }) {
        if (this._disposed) return;
        const fullEvent: BusEvent = {
            id: event.id || generateEventId(),
            type: event.type,
            properties: event.properties
        };
        this.emitter.emit('event', fullEvent);

        const directory = event.directory || getServerDefaultWorkspace();
        const dirName = path.basename(directory) || 'unknown';

        const globalEvent: GlobalBusEvent = {
            directory,
            project: `proj_${dirName}`,
            payload: fullEvent
        };
        this.emitter.emit('global', globalEvent);
    }

    publishGlobal(event: GlobalBusEvent) {
        if (this._disposed) return;
        this.emitter.emit('global', event);
    }

    subscribe(handler: EventHandler): () => void {
        this.emitter.on('event', handler);
        return () => this.emitter.off('event', handler);
    }

    subscribeGlobal(handler: GlobalEventHandler): () => void {
        this.emitter.on('global', handler);
        return () => this.emitter.off('global', handler);
    }

    dispose() {
        this._disposed = true;
        this.emitter.removeAllListeners();
    }
}

export const EventBus = new EventBusImpl();
