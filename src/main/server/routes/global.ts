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
import { getCurrentVersion } from '../../utils/upgrade.js';
import { Setting } from '../../utils/setting.js';
import { getRequestWorkspace } from '../workspace.js';

/**
 * 构造符合 opencode Config 类型的全局配置响应。
 */
function buildGlobalConfig(data: any): Record<string, unknown> {
    const providerConfig: Record<string, unknown> = {};
    for (const p of data.providers || []) {
        providerConfig[p.name] = {
            api: 'openai',
            options: {
                apiKey: p.api_key || '',
                baseURL: p.base_url || ''
            }
        };
    }

    let defaultModel: string | undefined;
    if (data.default_model) {
        const dm = (data.models || []).find((m: any) => m.alias === data.default_model);
        if (dm) {
            defaultModel = `${dm.provider_name}/${dm.alias}`;
        }
    }

    return {
        model: defaultModel,
        provider: providerConfig
    };
}

export function GlobalRoutes() {
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

            const heartbeat = setInterval(() => {
                if (done) return;
                stream
                    .writeSSE({
                        event: 'message',
                        data: JSON.stringify({
                            directory,
                            project: projectId,
                            payload: {
                                id: `evt_hb_${Date.now().toString(36)}`,
                                type: 'server.heartbeat',
                                properties: {}
                            }
                        })
                    })
                    .catch(() => {
                        done = true;
                    });
            }, 10_000);

            const unsub = EventBus.subscribeGlobal((event) => {
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
        return c.json(buildGlobalConfig(data));
    });

    // PATCH /global/config
    app.patch('/config', async (c) => {
        const body = await c.req.json();
        const setting = Setting.getInstance();
        const data = setting.getData();

        if (body.model !== undefined) {
            const parts = (body.model as string).split('/');
            if (parts.length >= 2) {
                const providerName = parts[0];
                const modelId = parts.slice(1).join('/');
                const matchedModel = (data.models || []).find(
                    (m: any) => m.provider_name === providerName && (m.alias === modelId || m.model_name === modelId)
                );
                if (matchedModel) {
                    data.default_model = matchedModel.alias;
                }
            } else {
                data.default_model = body.model;
            }
        }

        if (body.default_model !== undefined) {
            data.default_model = body.default_model;
        }

        setting.save();
        return c.json(buildGlobalConfig(data));
    });

    // POST /global/dispose
    app.post('/dispose', (c) => {
        EventBus.publish({
            type: 'server.instance.disposed',
            directory: getRequestWorkspace(c),
            properties: {}
        });
        return c.json(true);
    });

    return app;
}
