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

/**
 * 沙箱 ask 弹窗的来源描述：本次沙箱执行由哪个工具发起、执行的是什么命令。
 * 权限弹窗用它把"dynamicSandbox 请求编辑文件"升级为"executeBash 请求编辑文件 +
 * 命令内容"，让用户能判断弹窗来自哪条命令。
 */
export interface SandboxAskInvocation {
    /** 发起本次沙箱命令的工具名（如 executeBash/executeZsh/executePwsh） */
    toolName?: string;
    /** 被执行的命令文本（展示用，过长由 UI 截断） */
    command?: string;
}

export interface SandboxDecideEndpointOptions {
    taskState?: TaskState;
    /** 弹窗来源描述（触发沙箱执行的工具名与被执行命令），缺省保持 dynamicSandbox */
    invocation?: SandboxAskInvocation;
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
 * 任务是否已停止/中断。任务停止后沙箱进程的退出是异步的，在进程真正退出前，
 * 沙箱原生侧排队的 ask 请求仍会持续打到 /decide 端点；若不在此拦截，这些请求
 * 会继续弹权限弹窗，且任务停止时的 cancelTaskPrompts 已执行完毕、无人再取消。
 *
 * - task_status === 'stopped'：stop() / interruptForNewMessage() 在取消弹窗之前
 *   就已置位，晚到的请求可直接拒绝。
 * - runtimeInterrupt.requested：interruptRunningTurn() 把 task_status 翻转为
 *   stopped 之前存在 await 窗口（stopRunningTools），而 runtimeInterrupt 在
 *   取消弹窗之前就已置位，用它兜住该窗口。
 *
 * 任务恢复（新 turn）会清除 runtimeInterrupt 并把 task_status 改回 'running'，
 * 因此恢复后的新沙箱实例不受影响、可正常询问。
 */
function isTaskStopped(task: TaskState): boolean {
    if (task.task_status === 'stopped') return true;
    if (task.runtimeInterrupt?.requested === true) return true;
    return false;
}

/**
 * 会话级"允许"决策缓存（按任务 harnessContext 索引）：弹窗上不带记住范围的
 * 普通"允许读取 X"批准，在本次任务的沙箱执行会话内对后续沙箱实例（后续命令
 * 拉起的新端点）持续生效，同 (action, 路径) 的 ask 不再重复弹窗。WeakMap 以
 * harnessContext 为键：会话更换/任务结束后旧条目随上下文对象一并回收。
 * 只记 allow：拒绝在后续实例中仍重新询问（避免用户某次的拒绝演变为整个会话
 * 的静默自动拒绝）；带记住范围（prefix/type）的批准走权限引擎规则，不在此重复。
 */
const sessionAllows = new WeakMap<object, Map<string, 'allow'>>();

/**
 * 动态沙箱的授权决策端点（HTTP /decide，协议 v2）：接收原生沙箱的 ask 请求，
 * 查询当前权限引擎（先查持久规则，再弹窗审批），返回 allow/deny；支持决策缓存
 * 与"记住"回写权限引擎。Windows 与 Linux 沙箱共用。
 *
 * 决策作用域分三层：引擎规则（prefix/type 记住，任务生命周期，随策略导出到
 * 后续沙箱原生层）> 会话级 allow（普通批准，按 harnessContext 记忆，本次任务
 * 执行期间跨沙箱实例生效）> 端点内缓存（含 deny，仅当前沙箱实例）。
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
        // 任务已停止/中断：新到达的沙箱 ask 直接拒绝，避免任务停止后仍持续弹窗
        // （已进入宿主弹窗队列的旧请求由任务停止时的 cancelTaskPrompts 统一拒绝）。
        if (isTaskStopped(task)) return deny;
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
        const key = `${action}:${options.caseInsensitivePathKey ? resourcePath.toLowerCase() : resourcePath}`;
        // 本次会话内已批准过同路径同操作：直接放行（引擎显式 ask/deny 已在上方短路）
        if (sessionAllows.get(current)?.get(key) === 'allow') return { decision: 'allow' };
        const provider = current.permissionPrompt;
        if (!provider) return deny;
        // 弹窗前二次检查：请求可能在任务停止前已通过入口检查，但在 await
        // permission.check 期间任务被停止（此时 cancelTaskPrompts 已执行、队列
        // 尚空），若不在此拦截仍会弹窗且无人取消。
        if (isTaskStopped(task)) return deny;
        let pending = decisions.get(key);
        if (!pending) {
            pending = (async (): Promise<Decision> => {
                try {
                    notifyPermissionWaitChange(1);
                    const prefixes = new FileResourcePath(resourcePath).getPrefixes();
                    const response = await provider.prompt(
                        [request],
                        options.invocation?.toolName || 'dynamicSandbox',
                        prefixes,
                        {
                            taskId: task.task_id,
                            taskName: task.task_name,
                            workspace: task.getWorkspace()
                        },
                        options.invocation?.command ? { input: { command: options.invocation.command } } : undefined
                    );
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
                    } else {
                        // 普通批准记入会话缓存：后续沙箱实例（后续命令）不再重复弹窗
                        let session = sessionAllows.get(current);
                        if (!session) {
                            session = new Map();
                            sessionAllows.set(current, session);
                        }
                        session.set(key, 'allow');
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
