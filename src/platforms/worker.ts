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
 * 工作线程专用的 Platform 实现。
 *
 * Worker 线程不能直接使用 Electron 的 net 模块或 undici，
 * 因此 fetch 请求通过 IPC (parentPort.postMessage) 转发到主进程执行。
 */

import { AbstractPlatform } from './base';
import { Setting } from '../main/utils/setting.js';
import type { TaskState } from '../main/aikernel/states/tasks.js';
import { parentPort } from 'worker_threads';
import { BaseApplication } from '../main/applications/base';
import { MailboxApplication } from '../main/applications/mailbox/app.js';
import { FileMgrApplication } from '../main/applications/filemgr/app.js';
import { CalendarApplication } from '../main/applications/calendar/app.js';
import { BrowserApplication } from '../main/applications/browser/app.js';
import { SearchApplication } from '../main/applications/search/app.js';
import { TerminalApplication } from '../main/applications/terminal/app.js';
import { SkillMgrApplication } from '../main/applications/skillmgr/app.js';
import { McpMgrApplication } from '../main/applications/mcpmgr/app.js';
import { TodoMgrApplication } from '../main/applications/todomgr/app.js';
import { ChannelMgrApplication } from '../main/applications/channelmgr/app.js';
import { KnowledgeBaseApplication } from '../main/applications/knowledgebase/app.js';
import { DeviceMgrApplication } from '../main/applications/devicemgr/app.js';
import { BuiltinApplication } from '../main/applications/builtin/app.js';
import { NotesApplication } from '../main/applications/notes/app.js';
import { AppMgrApplication } from '../main/applications/appmgr/app.js';

let fetchRequestCounter = 0;

export class WorkerPlatform extends AbstractPlatform {
    getName(): string {
        return 'worker';
    }

    getEffectiveWorkspace(): string {
        return Setting.getInstance().getEffectiveWorkspace();
    }

    async initPlatformHarness(_task: TaskState): Promise<void> {
        throw new Error('Worker platform does not support initPlatformHarness');
    }

    async fetch(input: string | URL, init?: RequestInit): Promise<Response> {
        if (!parentPort) {
            throw new Error('WorkerPlatform.fetch: parentPort is not available');
        }

        const requestId = `__fetch_${++fetchRequestCounter}_${Date.now()}`;
        const url = input instanceof URL ? input.href : input;

        const serializableInit: Record<string, any> = {};
        if (init) {
            if (init.method) serializableInit.method = init.method;
            if (init.headers) {
                if (init.headers instanceof Headers) {
                    const h: Record<string, string> = {};
                    init.headers.forEach((v, k) => {
                        h[k] = v;
                    });
                    serializableInit.headers = h;
                } else {
                    serializableInit.headers = init.headers;
                }
            }
            if (init.body !== undefined && init.body !== null) {
                if (typeof init.body === 'string') {
                    serializableInit.body = init.body;
                } else if (init.body instanceof ArrayBuffer) {
                    serializableInit.bodyBuffer = Buffer.from(init.body).toString('base64');
                } else if (ArrayBuffer.isView(init.body)) {
                    serializableInit.bodyBuffer = Buffer.from(
                        init.body.buffer,
                        init.body.byteOffset,
                        init.body.byteLength
                    ).toString('base64');
                } else {
                    serializableInit.body = String(init.body);
                }
            }
            if (init.redirect) serializableInit.redirect = init.redirect;
        }

        return new Promise<Response>((resolve, reject) => {
            const handler = (msg: any) => {
                if (msg.type !== '__fetch_response' || msg.id !== requestId) return;
                parentPort!.off('message', handler);

                if (msg.status === 'error') {
                    reject(new Error(msg.message || 'Fetch failed in main process'));
                    return;
                }

                const bodyBytes = msg.bodyBase64 ? Buffer.from(msg.bodyBase64, 'base64') : new Uint8Array();
                const responseHeaders = new Headers(msg.headers || {});

                resolve(
                    new Response(bodyBytes, {
                        status: msg.statusCode,
                        statusText: msg.statusText || '',
                        headers: responseHeaders
                    })
                );
            };

            parentPort!.on('message', handler);
            parentPort!.postMessage({
                type: '__fetch_request',
                id: requestId,
                url,
                init: serializableInit
            });
        });
    }

    getApplicationClasses(): (typeof BaseApplication)[] {
        return [
            MailboxApplication,
            FileMgrApplication,
            CalendarApplication,
            NotesApplication,
            BrowserApplication,
            SearchApplication,
            TerminalApplication,
            SkillMgrApplication,
            AppMgrApplication,
            McpMgrApplication,
            TodoMgrApplication,
            ChannelMgrApplication,
            KnowledgeBaseApplication,
            DeviceMgrApplication,
            BuiltinApplication
        ];
    }
}
