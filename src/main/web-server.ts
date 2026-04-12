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
 * Web Debug Server — 以纯 HTTP + WebSocket 方式暴露与 Electron IPC 等效的 API，
 * 让 renderer 可以在普通浏览器中运行，便于调试和自动化测试。
 *
 * 启动入口：npm run start-debug
 */

import { isMainThread } from 'worker_threads';
import { setPlatform as setPlatformBase } from '../platforms/base.js';
import { CliPlatform as CliPlatformBase } from '../platforms/cli.js';
import { initializeAppWorkers } from './applications/worker.js';

if (!isMainThread) {
    setPlatformBase(new CliPlatformBase());
    initializeAppWorkers();
}

import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { GlobalState } from './aikernel/states/global.js';
import { BaseToolset } from './aikernel/tool.js';
import { MainAgentDecl } from './aikernel/agents/mainagent.js';
import { ApplicationRegistry, initializeRegistry, initializeRegistryWorker } from './applications/registry.js';
import { Setting } from './utils/setting.js';
import { logger, useConsoleTransport, LogStream } from './utils/logger.js';
import { setPlatform } from '../platforms/base.js';
import { CliPlatform } from '../platforms/cli.js';
import { z } from 'zod';
import Convert from 'ansi-to-html';
import {
    BaseTaskUpdateSubscriber,
    BaseTaskManagerUpdateSubscriber,
    type TaskUpdateChunk
} from './aikernel/states/tasks.js';
import { HarnessContext } from './aikernel/security/harness.js';

const converter = new Convert();

class WebSocketTaskUpdateSubscriber extends BaseTaskUpdateSubscriber {
    ws: WebSocket;

    constructor(ws: WebSocket) {
        super();
        this.ws = ws;
    }

    isAvailable() {
        return this.ws.readyState === WebSocket.OPEN;
    }

    send(chunkUpdate: TaskUpdateChunk) {
        if (this.isAvailable()) {
            this.ws.send(
                JSON.stringify({
                    type: 'taskUpdate',
                    subscriptionId: this.subscription_id,
                    data: chunkUpdate
                })
            );
        }
    }
}

class WebSocketTaskManagerUpdateSubscriber extends BaseTaskManagerUpdateSubscriber {
    ws: WebSocket;

    constructor(ws: WebSocket) {
        super();
        this.ws = ws;
    }

    send(taskList: object[]): void {
        if (this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(
                JSON.stringify({
                    type: 'taskListUpdate',
                    data: taskList
                })
            );
        }
    }
}

function parseBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk: string) => {
            body += chunk;
        });
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (e) {
                reject(e);
            }
        });
        req.on('error', reject);
    });
}

function sendJSON(res: http.ServerResponse, data: any, statusCode = 200) {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end(JSON.stringify(data));
}

export async function startWebServer(port = 3001) {
    setPlatform(new CliPlatform());
    useConsoleTransport();

    initializeRegistry();
    GlobalState.initialize();
    GlobalState.getInstance().taskManagerState.toolsetProvider = {
        listAvailableToolsets: () => ApplicationRegistry.listAvailableToolsets()
    };
    initializeRegistryWorker();

    const globalState = GlobalState.getInstance();

    const server = http.createServer(async (req, res) => {
        // CORS preflight
        if (req.method === 'OPTIONS') {
            res.writeHead(204, {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type'
            });
            res.end();
            return;
        }

        const url = new URL(req.url || '/', `http://localhost:${port}`);
        const pathname = url.pathname;

        try {
            // --- Task Manager APIs ---
            if (pathname === '/api/taskManager/createTask' && req.method === 'POST') {
                const task = globalState.taskManagerState.createTask();
                const workspace = process.cwd();
                const agentDecl = new MainAgentDecl({ workspace });
                agentDecl
                    .createSystemPrompt()
                    .then((prompt) => {
                        task.setSystemPrompt(prompt);
                    })
                    .catch((err) => {
                        logger.error('failed to create system prompt', err);
                    });
                try {
                    task.harnessContext = await HarnessContext.createWithDefaults(workspace);
                    // web-server 没有交互式 prompt provider；ask 权限默认拒绝（安全侧倒）
                } catch (err) {
                    logger.warn(`Failed to init task harness in web-server: ${err}`);
                    task.harnessContext = HarnessContext.createEmpty();
                }
                sendJSON(res, { status: 'ok', data: task.task_id });
            } else if (pathname === '/api/taskManager/removeTask' && req.method === 'POST') {
                const body = await parseBody(req);
                const task = globalState.taskManagerState.getTask(body.taskId);
                if (!task) {
                    sendJSON(res, { status: 'error', message: `task ${body.taskId} not found` });
                    return;
                }
                globalState.taskManagerState.removeTask(body.taskId);
                sendJSON(res, { status: 'ok', data: task.task_id });
            } else if (pathname === '/api/taskManager/forkTask' && req.method === 'POST') {
                const body = await parseBody(req);
                const task = globalState.taskManagerState.getTask(body.taskId);
                if (!task) {
                    sendJSON(res, { status: 'error', message: `task ${body.taskId} not found` });
                    return;
                }
                const forkedTask = task.fork();
                sendJSON(res, { status: 'ok', data: forkedTask.task_id });
            } else if (pathname === '/api/taskManager/clearAllTasks' && req.method === 'POST') {
                globalState.taskManagerState.clearAllTasks();
                sendJSON(res, { status: 'ok' });
            } else if (pathname === '/api/taskManager/getFullTask' && req.method === 'POST') {
                const body = await parseBody(req);
                const task = globalState.taskManagerState.getTask(body.taskId);
                if (!task) {
                    sendJSON(res, { status: 'error', message: `task ${body.taskId} not found` });
                    return;
                }
                await task.render();
                sendJSON(res, { status: 'ok', data: task.toRenderJSON() });
            } else if (pathname === '/api/taskManager/getTaskList' && req.method === 'GET') {
                sendJSON(res, { status: 'ok', data: globalState.taskManagerState.getTaskList() });
            } else if (pathname === '/api/taskManager/submitMessage' && req.method === 'POST') {
                const body = await parseBody(req);
                const task = globalState.taskManagerState.getTask(body.taskId);
                if (!task) {
                    sendJSON(res, { status: 'error', message: `task ${body.taskId} not found` });
                    return;
                }
                if (body.details?.attachedFilePaths) {
                    await task.attachFiles(body.details.attachedFilePaths);
                }
                if (body.details?.selectedModel) {
                    task.model = body.details.selectedModel;
                }
                if (body.details?.reasoningEffort !== undefined) {
                    task.reasoningEffort = body.details.reasoningEffort || undefined;
                }
                task.submitUserMessage(body.details?.message || body.message).catch((err: Error) =>
                    logger.error(`submitUserMessage failed for task ${body.taskId}:`, err)
                );
                sendJSON(res, { status: 'ok' });
            } else if (pathname === '/api/taskManager/stopTask' && req.method === 'POST') {
                const body = await parseBody(req);
                const task = globalState.taskManagerState.getTask(body.taskId);
                if (!task) {
                    sendJSON(res, { status: 'error', message: `task ${body.taskId} not found` });
                    return;
                }
                task.stop();
                sendJSON(res, { status: 'ok' });
            } else if (pathname === '/api/taskManager/setSystemPrompt' && req.method === 'POST') {
                const body = await parseBody(req);
                const task = globalState.taskManagerState.getTask(body.taskId);
                if (!task) {
                    sendJSON(res, { status: 'error', message: `task ${body.taskId} not found` });
                    return;
                }
                task.setSystemPrompt(body.prompt);
                sendJSON(res, { status: 'ok' });
            } else if (pathname === '/api/taskManager/exportTaskToHtml' && req.method === 'POST') {
                const body = await parseBody(req);
                const task = globalState.taskManagerState.getTask(body.taskId);
                if (!task) {
                    sendJSON(res, { status: 'error', message: `task ${body.taskId} not found` });
                    return;
                }
                await task.render();
                const { generateTaskHtml } = await import('./utils/export.js');
                const htmlContent = await generateTaskHtml(task);
                sendJSON(res, { status: 'ok', data: htmlContent });
            }
            // --- Setting APIs ---
            else if (pathname === '/api/setting/loadSettingSchema' && req.method === 'GET') {
                const schema = Setting.getSettingSchema();
                sendJSON(res, { status: 'ok', data: z.toJSONSchema(schema) });
            } else if (pathname === '/api/setting/loadSettingObject' && req.method === 'GET') {
                sendJSON(res, { status: 'ok', data: Setting.getInstance().getData() });
            } else if (pathname === '/api/setting/saveSettingObject' && req.method === 'POST') {
                const body = await parseBody(req);
                Setting.getInstance().setData(body);
                sendJSON(res, { status: 'ok' });
            } else if (pathname === '/api/setting/getLogContent' && req.method === 'GET') {
                sendJSON(res, {
                    status: 'ok',
                    data: converter.toHtml(LogStream.getStream().getContent())
                });
            }
            // --- Application Registry APIs ---
            else if (pathname === '/api/applicationRegistry/getApplicationList' && req.method === 'GET') {
                sendJSON(res, { status: 'ok', data: ApplicationRegistry.getApplicationList() });
            } else if (pathname === '/api/applicationRegistry/call' && req.method === 'POST') {
                const body = await parseBody(req);
                const result = await ApplicationRegistry.callWorker(body.bundleName, body.methodName, ...body.args);
                sendJSON(res, result);
            } else if (pathname === '/api/applicationRegistry/callMainWorld' && req.method === 'POST') {
                const body = await parseBody(req);
                const application = ApplicationRegistry.getApplication(body.bundleName);
                if (!application) {
                    sendJSON(res, { status: 'error', message: `application ${body.bundleName} not found` });
                    return;
                }
                if (typeof (application as any)[body.methodName] !== 'function') {
                    sendJSON(res, {
                        status: 'error',
                        message: `method ${body.methodName} not found`
                    });
                    return;
                }
                const data = await (application as any)[body.methodName](...body.args);
                sendJSON(res, { status: 'ok', data });
            }
            // --- Misc APIs ---
            else if (pathname === '/api/setting/getApplicationGUIConfig' && req.method === 'POST') {
                const body = await parseBody(req);
                const application = ApplicationRegistry.getApplication(body.bundleName);
                if (!application) {
                    sendJSON(res, { status: 'error', message: `application ${body.bundleName} not found` });
                    return;
                }
                sendJSON(res, { status: 'ok', data: application.toJSON() });
            } else {
                sendJSON(res, { status: 'error', message: 'not found' }, 404);
            }
        } catch (err: any) {
            logger.error(`API error: ${err.message}`, err);
            sendJSON(res, { status: 'error', message: err.message }, 500);
        }
    });

    // --- WebSocket for subscriptions ---
    const wss = new WebSocketServer({ server });

    wss.on('error', (err) => {
        logger.error('WebSocket server error:', err);
    });

    wss.on('connection', (ws) => {
        logger.info('WebSocket client connected');

        // auto-subscribe to task list updates
        const taskListSubscriber = new WebSocketTaskManagerUpdateSubscriber(ws);
        globalState.taskManagerState.addSubscriber(taskListSubscriber);

        const taskSubscriptions = new Map<string, string>(); // taskId -> subscriptionId

        ws.on('message', async (raw) => {
            try {
                const msg = JSON.parse(raw.toString());

                if (msg.type === 'subscribeTaskUpdate') {
                    const task = globalState.taskManagerState.getTask(msg.taskId);
                    if (!task) {
                        ws.send(
                            JSON.stringify({
                                type: 'error',
                                message: `task ${msg.taskId} not found`
                            })
                        );
                        return;
                    }
                    const subscriber = new WebSocketTaskUpdateSubscriber(ws);
                    const subscriptionId = task.addSubscriber(subscriber);
                    taskSubscriptions.set(msg.taskId, subscriptionId);
                    ws.send(
                        JSON.stringify({
                            type: 'subscribeTaskUpdateResult',
                            taskId: msg.taskId,
                            subscriptionId
                        })
                    );
                } else if (msg.type === 'unsubscribeTaskUpdate') {
                    const task = globalState.taskManagerState.getTask(msg.taskId);
                    const subscriptionId = taskSubscriptions.get(msg.taskId);
                    if (task && subscriptionId) {
                        task.removeSubscriber(subscriptionId);
                        taskSubscriptions.delete(msg.taskId);
                    }
                }
            } catch (err: any) {
                logger.error('WebSocket message error:', err);
            }
        });

        ws.on('close', () => {
            logger.info('WebSocket client disconnected');
            // cleanup all subscriptions
            for (const [taskId, subscriptionId] of taskSubscriptions) {
                const task = globalState.taskManagerState.getTask(taskId);
                if (task) {
                    task.removeSubscriber(subscriptionId);
                }
            }
            globalState.taskManagerState.removeSubscriberByFilter(
                (s) => s.subscription_id !== taskListSubscriber.subscription_id
            );
        });
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
            logger.error(`Port ${port} is already in use. Please free the port and try again.`);
            console.error(`\n  ERROR: Port ${port} is already in use.`);
            console.error(`  Run: npx kill-port ${port}  -- then try again.\n`);
        } else {
            logger.error('Web server error:', err);
        }
        process.exit(1);
    });

    server.listen(port, () => {
        logger.info(`OpenDesk Web Debug Server running at http://localhost:${port}`);
        console.log(`\n  OpenDesk Web Debug Server`);
        console.log(`  API Server:  http://localhost:${port}`);
        console.log(`  Frontend:    started by Vite dev server (see above)\n`);
    });

    return server;
}

// 当设置了 OPENDESK_WEB_MODE 环境变量且为主线程时启动服务器
if (process.env.OPENDESK_WEB_MODE === '1' && isMainThread) {
    startWebServer(3001);
}
