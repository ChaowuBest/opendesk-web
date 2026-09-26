/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import { createServer, type Server } from 'node:http';
import crypto from 'node:crypto';
import type { PermissionRequest, PermissionRule } from '../../../aikernel/security/permission.js';
import { applyPersistentPermissionAllowForTask } from '../../../aikernel/task/permission.js';
import type { TaskState } from '../../../aikernel/states/tasks.js';
import { FileResourcePath } from '../../../aikernel/security/permission.js';

export interface SandboxDecideEndpointOptions {
    taskState?: TaskState;
    /**
     * 沙箱触发权限管控、弹窗等待用户决策时的回调：
     * waiting=true 表示开始等待（宿主应暂停工具超时计时），
     * waiting=false 表示决策已返回（批准或拒绝，恢复计时）。
     */
    onPermissionWaitChange?: (waiting: boolean) => void;
    /**
     * 原生 ask 请求的沙箱内路径 → 宿主真实路径。Windows 用 virtualPathToHostPath
     * （/C/... 还原 C:/...）；Linux 透明路径恒等（沙箱内路径即宿主路径）。
     */
    pathMapper: (sandboxPath: string) => string | null;
    /**
     * 决策缓存 key 是否大小写不敏感（Windows 路径语义；Linux 路径大小写敏感，
     * 小写化会错误合并 /Work/a 与 /work/a 的决策）
     */
    caseInsensitivePathKey?: boolean;
}

export interface SandboxDecideEndpoint {
    endpoint: string;
    token: string;
    cleanup: () => Promise<void>;
}

export type Decision = { decision: 'allow' | 'deny' };

/**
 * 动态沙箱的授权决策端点（HTTP /decide，协议 v2）：接收原生沙箱的 ask 请求，
 * 查询当前权限引擎（先查持久规则，再弹窗审批），返回 allow/deny；支持决策缓存
 * 与"记住"回写权限引擎。Windows 与 Linux 沙箱共用。
 */
export async function createSandboxDecideEndpoint(
    options: SandboxDecideEndpointOptions
): Promise<SandboxDecideEndpoint> {
    const token = crypto.randomBytes(32).toString('hex');
    let closed = false;
    const deny: Decision = { decision: 'deny' };
    let context = options.taskState?.harnessContext;
    const decisions = new Map<string, Promise<Decision>>();
    let waitingDecisions = 0;
    const notifyPermissionWaitChange = (delta: number) => {
        if (!options.onPermissionWaitChange) return;
        const before = waitingDecisions;
        waitingDecisions = Math.max(0, waitingDecisions + delta);
        if (before > 0 !== waitingDecisions > 0) {
            options.onPermissionWaitChange(waitingDecisions > 0);
        }
    };
    const decideRequest = async (body: Record<string, unknown>): Promise<Decision> => {
        if (closed || !body || (body.token !== undefined && body.token !== token)) return deny;
        const resourcePath = typeof body.path === 'string' ? options.pathMapper(body.path) : null;
        const action = body.access;
        if (!resourcePath || (action !== 'read' && action !== 'write' && action !== 'execute')) return deny;
        const task = options.taskState;
        if (!task) return deny;
        const current = task.harnessContext;
        if (context !== current) {
            context = current;
            decisions.clear();
        }
        const request: PermissionRequest = { resourceType: 'file', action, resourcePath };
        const existing = await current.permission?.check(request);
        if (closed) return deny;
        if (current !== task.harnessContext) return decideRequest(body);
        if (existing?.effect === 'deny' || existing?.effect === 'allow') return { decision: existing.effect };
        const provider = current.permissionPrompt;
        if (!provider) return deny;
        const key = `${action}:${options.caseInsensitivePathKey ? resourcePath.toLowerCase() : resourcePath}`;
        let pending = decisions.get(key);
        if (!pending) {
            pending = (async (): Promise<Decision> => {
                try {
                    notifyPermissionWaitChange(1);
                    const prefixes = new FileResourcePath(resourcePath).getPrefixes();
                    const response = await provider.prompt([request], 'dynamicSandbox', prefixes, {
                        taskId: task.task_id,
                        taskName: task.task_name,
                        workspace: task.getWorkspace()
                    });
                    if (closed) return deny;
                    if (current !== task.harnessContext) return decideRequest(body);
                    const latest = await current.permission?.check(request);
                    if (closed) return deny;
                    if (current !== task.harnessContext) return decideRequest(body);
                    if (latest?.effect === 'deny') return deny;
                    if (response.decision !== 'allow') return deny;
                    const pattern =
                        response.rememberScope === 'type'
                            ? '**'
                            : response.rememberScope === 'prefix' &&
                                prefixes.some((prefix) => prefix.pattern === response.selectedPrefixPattern)
                              ? response.selectedPrefixPattern
                              : undefined;
                    if (pattern) {
                        await applyPersistentPermissionAllowForTask(task, {
                            resourceType: 'file',
                            action,
                            pathPattern: pattern,
                            effect: 'allow'
                        });
                    }
                    return { decision: 'allow' };
                } finally {
                    notifyPermissionWaitChange(-1);
                }
            })().catch(() => deny);
            decisions.set(key, pending);
        }
        return pending;
    };
    const server = createServer((request, response) => {
        response.on('error', () => undefined);
        let clientDisconnected = false;
        response.on('close', () => {
            if (!response.writableEnded) clientDisconnected = true;
        });
        request.on('aborted', () => {
            clientDisconnected = true;
        });
        request.on('close', () => {
            if (!request.complete) clientDisconnected = true;
        });
        request.on('error', () => {
            clientDisconnected = true;
        });
        const finishResponse = (status: number, body: string): boolean => {
            if (clientDisconnected || response.destroyed || response.writableEnded) return false;
            try {
                response.statusCode = status;
                response.end(body);
                return true;
            } catch {
                clientDisconnected = true;
                return false;
            }
        };
        if (request.method !== 'POST' || request.url !== '/decide') {
            finishResponse(404, '');
            return;
        }
        const authorization = request.headers.authorization;
        if (authorization !== `Bearer ${token}`) {
            finishResponse(401, JSON.stringify(deny));
            return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        request.on('data', (chunk) => {
            if (response.writableEnded || clientDisconnected) return;
            size += chunk.length;
            if (size > 64 * 1024) {
                finishResponse(413, JSON.stringify(deny));
            } else chunks.push(Buffer.from(chunk));
        });
        request.on('end', () => {
            if (response.writableEnded || clientDisconnected) return;
            void (async () => {
                try {
                    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
                    const result = await decideRequest(body);
                    if (!clientDisconnected && !response.writableEnded && !response.destroyed) {
                        try {
                            response.setHeader('Content-Type', 'application/json');
                        } catch {
                            clientDisconnected = true;
                        }
                    }
                    finishResponse(200, JSON.stringify(result));
                } catch {
                    finishResponse(200, JSON.stringify(deny));
                }
            })();
        });
    });
    server.on('clientError', (_error, socket) => {
        if (!socket.destroyed) socket.destroy();
    });
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = (): Promise<void> => {
        if (!cleanupPromise) {
            closed = true;
            decisions.clear();
            cleanupPromise = (async () => {
                server.closeAllConnections();
                await new Promise<void>((resolve) => server.close(() => resolve()));
            })();
        }
        return cleanupPromise;
    };
    const endpoint = await new Promise<string>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (!address || typeof address === 'string') {
                reject(new Error('动态沙箱授权端点未能获取端口'));
                return;
            }
            resolve(`http://127.0.0.1:${address.port}/decide`);
        });
    });
    return { endpoint, token, cleanup };
}

export {
    policyText,
    permissionRulesForSandbox,
    hostPatternToVirtual,
    hostPatternToVirtualLinux,
    policyTextLinux
} from './dynabox-policy.js';
export type { PermissionRule };
