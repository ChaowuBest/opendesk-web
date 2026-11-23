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

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import path from 'path';
import { EventBus } from '../event-bus.js';
import { getCurrentVersion } from '../../../utils/upgrade.js';
import { Setting } from '../../../utils/setting.js';
import { getRequestWorkspace } from '../workspace.js';
import {
    buildOpenCodeConfig,
    hasOpenCodePermissionPatch,
    isOpenDeskConfigReloadRequest,
    mergeOpenCodeConfigPatch,
    notifyOpenCodeConfigUpdated,
    reloadServerConfigFromDisk
} from '../config-compat.js';
import type { ConfigPermissionRuntime } from '../config-permission-runtime.js';
import { ServerPermissionBroker } from '../permission-broker.js';

export function GlobalRoutes(permissionRuntime?: ConfigPermissionRuntime) {
    const app = new Hono();

    // GET /global/health
    app.get('/health', async (c) => {
        const version = await getCurrentVersion();
        return c.json({
            healthy: true,
            version: version ?? 'unknown'
        });
    });

    // GET /global/event - 全局事件 SSE 流
    // opencode TUI 连接此端点获取所有实时事件。
    // SSE event name 必须是 "message"，data 是 GlobalBusEvent JSON。
    app.get('/event', async (c) => {
        c.header('Cache-Control', 'no-cache, no-transform');
        c.header('X-Accel-Buffering', 'no');
        c.header('X-Content-Type-Options', 'nosniff');

        const directory = getRequestWorkspace(c);
        const dirName = path.basename(directory) || 'unknown';
        const projectId = `proj_${dirName}`;

        return streamSSE(c, async (stream) => {
            let done = false;
            let heartbeat: ReturnType<typeof setInterval> | undefined;
            let unsub: (() => void) | undefined;
            let writeQueue = Promise.resolve();

            const stop = () => {
                if (done) return;
                done = true;
                if (heartbeat) {
                    clearInterval(heartbeat);
                }
                unsub?.();
            };

            const writeEvent = (data: unknown) => {
                writeQueue = writeQueue
                    .then(async () => {
                        if (done) return;
                        await stream.writeSSE({
                            event: 'message',
                            data: JSON.stringify(data)
                        });
                    })
                    .catch(stop);
            };

            // 初始 server.connected 事件
            await stream.writeSSE({
                event: 'message',
                data: JSON.stringify({
                    directory,
                    project: projectId,
                    payload: {
                        id: `evt_connected_${Date.now().toString(36)}`,
                        type: 'server.connected',
                        properties: {}
                    }
                })
            });

            heartbeat = setInterval(() => {
                if (done) return;
                writeEvent({
                    directory,
                    project: projectId,
                    payload: {
                        id: `evt_hb_${Date.now().toString(36)}`,
                        type: 'server.heartbeat',
                        properties: {}
                    }
                });
            }, 10_000);

            unsub = EventBus.subscribeGlobal((event) => {
                if (done) return;
                writeEvent(event);
            });

            stream.onAbort(stop);

            // keep stream alive until aborted
            await new Promise<void>((resolve) => {
                const check = setInterval(() => {
                    if (done) {
                        clearInterval(check);
                        resolve();
                    }
                }, 1000);
            });
        });
    });

    // GET /global/config
    app.get('/config', (c) => {
        const setting = Setting.getInstance();
        const data = setting.getData();
        return c.json(buildOpenCodeConfig(data));
    });

    // PATCH /global/config
    app.patch('/config', async (c) => {
        const body = await c.req.json().catch(() => ({}));
        const setting = Setting.getInstance();
        if (isOpenDeskConfigReloadRequest(body)) {
            return c.json(buildOpenCodeConfig(await reloadServerConfigFromDisk(permissionRuntime)));
        }

        const nextData = mergeOpenCodeConfigPatch(setting.getData(), body);
        setting.setData(nextData);
        if (hasOpenCodePermissionPatch(body)) {
            const reloadResult = permissionRuntime?.reload(setting.getData().permission);
            if (reloadResult && reloadResult.status !== 'disabled') {
                ServerPermissionBroker.getInstance().dispose();
            }
        }
        notifyOpenCodeConfigUpdated(setting.getData());
        return c.json(buildOpenCodeConfig(setting.getData()));
    });

    // POST /global/dispose - 与 opencode 释放全部实例对应：从磁盘重新加载配置，客户端收到事件后重新拉取状态
    app.post('/dispose', async (c) => {
        await reloadServerConfigFromDisk(permissionRuntime);
        const directory = getRequestWorkspace(c);
        EventBus.publish({ type: 'server.instance.disposed', directory, properties: { directory } });
        return c.json(true);
    });

    return app;
}
