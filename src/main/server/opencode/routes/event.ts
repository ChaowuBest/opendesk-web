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
import { EventBus } from '../event-bus.js';

/**
 * 实例级别事件 SSE 流。
 * 对应 opencode 的 GET /event 端点。
 * SSE event name 必须是 "message"，data 是 BusEvent JSON（含 id）。
 */
export function EventRoutes() {
    const app = new Hono();

    // GET /event - 实例事件 SSE 流
    app.get('/event', async (c) => {
        c.header('Cache-Control', 'no-cache, no-transform');
        c.header('X-Accel-Buffering', 'no');
        c.header('X-Content-Type-Options', 'nosniff');

        return streamSSE(c, async (stream) => {
            let done = false;

            await stream.writeSSE({
                event: 'message',
                data: JSON.stringify({
                    id: `evt_connected_${Date.now().toString(36)}`,
                    type: 'server.connected',
                    properties: {}
                })
            });

            const heartbeat = setInterval(() => {
                if (done) return;
                stream
                    .writeSSE({
                        event: 'message',
                        data: JSON.stringify({
                            id: `evt_hb_${Date.now().toString(36)}`,
                            type: 'server.heartbeat',
                            properties: {}
                        })
                    })
                    .catch(() => {
                        done = true;
                    });
            }, 10_000);

            const unsub = EventBus.subscribe((event) => {
                if (done) return;
                stream
                    .writeSSE({
                        event: 'message',
                        data: JSON.stringify(event)
                    })
                    .catch(() => {
                        done = true;
                    });
            });

            const stop = () => {
                if (done) return;
                done = true;
                clearInterval(heartbeat);
                unsub();
            };

            stream.onAbort(stop);

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

    return app;
}
