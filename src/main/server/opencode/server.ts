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
import { serve as honoServe } from '@hono/node-server';
import { GlobalRoutes } from './routes/global.js';
import { SessionRoutes, getServerDefaultModel, setServerDefaultModel, disposeTaskNameSyncSubscriber, registerTaskNameSyncSubscriber } from './routes/session.js';
import { ConfigRoutes } from './routes/config.js';
import { ProviderRoutes } from './routes/provider.js';
import { EventRoutes } from './routes/event.js';
import { InstanceRoutes } from './routes/instance.js';
import { McpRoutes } from './routes/mcp.js';
import { PermissionRoutes } from './routes/permission.js';
import { QuestionRoutes } from './routes/question.js';
import { AuthMiddleware, CorsMiddleware, LoggerMiddleware } from './middleware.js';
import { EventBus } from './event-bus.js';
import { ServerPermissionBroker } from './permission-broker.js';
import { ServerQuestionBroker } from './question-broker.js';
import { ConfigPermissionRuntime } from './config-permission-runtime.js';
import { Setting } from '../../utils/setting.js';

export interface ServerOptions {
    port: number;
    hostname: string;
    cors?: string[];
    password?: string;
    username?: string;
    useConfigPermissions?: boolean;
}

export interface ServerListener {
    hostname: string;
    port: number;
    url: URL;
    stop: () => Promise<void>;
}

function create(opts: {
    cors?: string[];
    password?: string;
    username?: string;
    permissionRuntime: ConfigPermissionRuntime;
}) {
    const app = new Hono();

    app.onError((err, c) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[server] request error: ${c.req.method} ${c.req.path} - ${message}`);
        return c.json({ error: message }, 500);
    });

    app.use('*', AuthMiddleware(opts.password, opts.username));
    app.use('*', LoggerMiddleware);
    app.use('*', CorsMiddleware(opts.cors));

    app.route('/global', GlobalRoutes(opts.permissionRuntime));
    app.route('/', EventRoutes());
    app.route('/', InstanceRoutes());
    app.route('/', McpRoutes());
    app.route('/', PermissionRoutes());
    app.route('/', QuestionRoutes());
    app.route('/session', SessionRoutes(opts.permissionRuntime));
    app.route('/config', ConfigRoutes(opts.permissionRuntime));
    app.route('/provider', ProviderRoutes());

    return app;
}

export async function listen(opts: ServerOptions): Promise<ServerListener> {
    const setting = Setting.getInstance();
    setServerDefaultModel(setting.getData().default_model || undefined);
    const permissionRuntime = new ConfigPermissionRuntime(
        opts.useConfigPermissions === true,
        setting.getData().permission
    );
    const app = create({
        cors: opts.cors,
        password: opts.password,
        username: opts.username,
        permissionRuntime
    });

    return new Promise<ServerListener>((resolve, reject) => {
        try {
            const server = honoServe(
                {
                    fetch: app.fetch,
                    hostname: opts.hostname,
                    port: opts.port
                },
                (info) => {
                    registerTaskNameSyncSubscriber();
                    const url = new URL(`http://${opts.hostname}:${info.port}`);
                    resolve({
                        hostname: opts.hostname,
                        port: info.port,
                        url,
                        async stop() {
                            const model = getServerDefaultModel();
                            if (model && setting.getModelInstance(model, 'chat')) {
                                setting.setData({ ...setting.getData(), default_model: model });
                            }
                            disposeTaskNameSyncSubscriber();
                            ServerPermissionBroker.getInstance().dispose();
                            ServerQuestionBroker.getInstance().dispose();
                            EventBus.dispose();
                            server.close();
                        }
                    });
                }
            );

            server.on('error', (err) => {
                reject(err);
            });
        } catch (err) {
            reject(err);
        }
    });
}

export { EventBus } from './event-bus.js';
