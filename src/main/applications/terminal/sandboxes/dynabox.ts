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
import fs from 'node:fs';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { getLogDirectory, getOpendeskDirectory } from '../../../utils/setting.js';
import {
    FileResourcePath,
    type PermissionRequest,
    type PermissionRule
} from '../../../aikernel/security/permission.js';
import { applyPersistentPermissionAllowForTask } from '../../../aikernel/task/permission.js';
import type { TaskState } from '../../../aikernel/states/tasks.js';
import { t } from '../locale/index.js';
import { ensureSandboxLoopback } from './loopback.js';
import { virtualPathToHostPath } from './ask-path.js';

export interface DynamicSandboxLaunch {
    file: string;
    args: string[];
    cwd?: string;
    attach: (process: ChildProcess) => void;
    cleanup: () => Promise<void>;
}

function resolveSandboxExecutable(): string | null {
    if (process.platform !== 'win32') return null;
    const electronProcess = process as NodeJS.Process & {
        defaultApp?: boolean;
        resourcesPath?: string;
    };
    const executable =
        electronProcess.defaultApp === true
            ? path.join(process.env.INIT_CWD || process.cwd(), 'native', 'windows', 'sandbox', 'runtime', 'sandbox.exe')
            : path.join(electronProcess.resourcesPath || '', 'sandbox', 'sandbox.exe');
    return fs.existsSync(executable) ? executable : null;
}

function quotePowerShell(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

function isPowerShell(shellPath: string): boolean {
    return /(?:^|[\\/])(?:powershell|pwsh)(?:\.exe)?$/i.test(shellPath);
}

/** Map a host drive path to the stable root-relative path exposed by --automount. */
export function mapHostPathToSandboxRoot(value: string): string | null {
    const normalized = path.win32.normalize(value.replace(/\//g, '\\'));
    const drivePath = /^([A-Za-z]):\\(.*)$/.exec(normalized);
    if (!drivePath) return null;
    const suffix = drivePath[2].replace(/\\/g, '/');
    return `/${drivePath[1].toUpperCase()}/${suffix}`;
}

/**
 * Enter the mapped workspace before the user command so descendants inherit the task cwd.
 * 仅支持 PowerShell：动态沙箱（prepareDynamicSandbox）只会启动 powershell/pwsh，
 * 其他 shell 仅做 cwd 可映射性校验，不会注入切换目录前缀。
 */
export function withSandboxWorkingDirectory(shellPath: string, shellArgs: string[], cwd?: string): string[] {
    const childArgs = shellArgs.slice();
    if (!cwd) return childArgs;
    const mappedCwd = mapHostPathToSandboxRoot(cwd);
    if (!mappedCwd) {
        throw new Error(t('sandbox.cwdUnsupported', { path: cwd }));
    }
    if (!isPowerShell(shellPath)) return childArgs;
    const commandIndex = childArgs.findIndex((arg) => arg === '-Command' || arg === '-c');
    if (commandIndex >= 0 && commandIndex + 1 < childArgs.length) {
        childArgs[commandIndex + 1] =
            `Set-Location -LiteralPath ${quotePowerShell(mappedCwd)}; ${childArgs[commandIndex + 1]}`;
    }
    return childArgs;
}

function quoteWindowsArgument(value: string): string {
    if (value && !/[\s"]/.test(value)) return value;
    return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

export function expandPermissionPattern(pattern: string): string[] {
    const normalized = pattern.replace(/\\/g, '/').replace(/\/+/g, '/');
    if (normalized.endsWith('{,/**}')) {
        const base = normalized.slice(0, -'{,/**}'.length).replace(/\/$/, '');
        return [base || '/', `${base || ''}/**`];
    }
    return [normalized];
}

export function hostPatternToVirtual(pattern: string): string | null {
    const normalized = pattern.replace(/\\/g, '/');
    const drive = /^([A-Za-z]):(?:\/(.*))?$/.exec(normalized);
    if (drive) return `/${drive[1].toUpperCase()}${drive[2] ? `/${drive[2]}` : ''}`;
    // Non-drive paths (for example /dev/null) are not exposed by --automount.
    return null;
}

export function permissionRulesForSandbox(rules: PermissionRule[] | undefined): string[] {
    const lines: string[] = [];
    // GlobPermissionEnforcer evaluates deny > ask > allow regardless of the
    // insertion order. Keep the same precedence in Policy's first-match table.
    const orderedRules = [...(rules || [])].sort((left, right) => {
        const rank = { deny: 0, ask: 1, allow: 2 } as const;
        return rank[left.effect] - rank[right.effect];
    });
    for (const rule of orderedRules) {
        if (rule.resourceType !== 'file' && rule.resourceType !== '*') continue;
        const access = rule.action === '*' ? 'all' : rule.action;
        if (!['read', 'write', 'execute', 'all'].includes(access)) continue;
        // Executing a file is always allowed in every OpenDesk mode. Keep
        // read/write effects from an "all" rule, but never export its execute
        // part into the native policy.
        if (access === 'execute') continue;
        const exportedAccesses = access === 'all' ? ['read', 'write'] : [access];
        for (const expanded of expandPermissionPattern(rule.pathPattern)) {
            const virtual = expanded === '**' ? '/**' : hostPatternToVirtual(expanded);
            if (!virtual) continue;
            for (const exportedAccess of exportedAccesses) {
                lines.push(
                    `[[rules]]\npath = ${JSON.stringify(virtual)}\naccess = ${JSON.stringify(exportedAccess)}\nperm = ${JSON.stringify(rule.effect)}`
                );
            }
        }
    }
    return lines;
}

export function policyText(endpoint: string, token: string, rules?: PermissionRule[]): string {
    const quote = (value: string) => JSON.stringify(value);
    return [
        'version = 1',
        'default = "deny"',
        '',
        '[ask]',
        `endpoint = ${quote(endpoint)}`,
        `token = ${quote(token)}`,
        // The UI allows five minutes, including queue time. Leave transport headroom.
        'timeout_ms = 330000',
        'cache_ttl_seconds = 0',
        'grant_ttl_seconds = 0',
        '',
        ...permissionRulesForSandbox(rules),
        // OpenDesk's normal fallback is read-only access outside the workspace.
        // Explicit ask/deny rules above still take precedence for sensitive paths
        // and write operations. Execution is intentionally open in every mode.
        '[[rules]]',
        'path = "/**"',
        'access = "read"',
        'perm = "allow"',
        '',
        '[[rules]]',
        'path = "/**"',
        'access = "write"',
        'perm = "ask"',
        '',
        '[[rules]]',
        'path = "/**"',
        'access = "execute"',
        'perm = "allow"',
        ''
    ].join('\n');
}

async function listen(server: Server): Promise<number> {
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error(t('sandbox.endpointFailed'));
    return address.port;
}

export function sandboxRunArgs(options: {
    policyPath: string;
    endpoint: string;
    logPath: string;
    deleteToTrash?: boolean;
    childCommand: string;
}): string[] {
    return [
        'run',
        '--automount',
        // 开启后沙箱内的直接删除送 Windows 回收站；必须位于 -- 分隔符之前
        ...(options.deleteToTrash ? ['--del-to-trash'] : []),
        '--policy',
        options.policyPath,
        '--upstream',
        options.endpoint,
        '--log-file',
        options.logPath,
        '--',
        options.childCommand
    ];
}

export async function prepareDynamicSandbox(options: {
    shellPath: string;
    shellArgs: string[];
    command: string;
    cwd?: string;
    taskState?: TaskState;
    deleteToTrash?: boolean;
    /**
     * 沙箱触发权限管控、弹窗等待用户决策时的回调：
     * waiting=true 表示开始等待（宿主应暂停工具超时计时），
     * waiting=false 表示决策已返回（批准或拒绝，恢复计时）。
     */
    onPermissionWaitChange?: (waiting: boolean) => void;
}): Promise<DynamicSandboxLaunch | null> {
    if (process.platform !== 'win32') return null;
    // Only the selected Windows pwsh tool requests a native sandbox launch.
    if (!isPowerShell(options.shellPath)) return null;

    const executable = resolveSandboxExecutable();
    if (!executable) throw new Error(t('sandbox.executableMissing'));
    // 校验并映射工作目录必须先于任何宿主侧资源（授权端点、策略文件）的分配，
    // 否则不可映射的 cwd（UNC/相对路径）抛错时会泄漏已监听的服务器与临时文件。
    const childArgs = withSandboxWorkingDirectory(options.shellPath, options.shellArgs, options.cwd);
    await ensureSandboxLoopback(executable);
    const token = crypto.randomBytes(32).toString('hex');
    let closed = false;
    type Decision = { decision: 'allow' | 'deny' };
    const deny: Decision = { decision: 'deny' };
    let context = options.taskState?.harnessContext;
    const decisions = new Map<string, Promise<Decision>>();
    // 正在等待用户决策的权限请求数；跨过 0↔N 边界时通知宿主暂停/恢复工具超时计时
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
        const resourcePath = typeof body.path === 'string' ? virtualPathToHostPath(body.path) : null;
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
        // A single command may open a file many times. Remember its exact decision in
        // the host, after checking live rules; never install stale native TTL grants.
        const key = `${action}:${resourcePath.toLowerCase()}`;
        let pending = decisions.get(key);
        if (!pending) {
            pending = (async (): Promise<Decision> => {
                try {
                    // +1 必须在 try 内：观察者回调抛错时 finally 仍能归还计数，
                    // 否则 waitingDecisions 永久 >=1，宿主计时器会被永久暂停
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
        // A native ask can time out or the sandbox can exit while the Electron
        // prompt is still open. Response socket errors must stay local to this
        // request; otherwise Electron's global unhandled-error handler exits.
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
        // The HTTP client is allowed to abandon a timed-out ask.
        if (!socket.destroyed) socket.destroy();
    });
    const configDirectory = getOpendeskDirectory();
    fs.mkdirSync(configDirectory, { recursive: true });
    const runId = `dynamic-sandbox-${crypto.randomUUID()}`;
    const policyPath = path.join(configDirectory, `${runId}.toml`);
    const logDirectory = path.join(getLogDirectory(), 'sandbox');
    fs.mkdirSync(logDirectory, { recursive: true });
    const logPath = path.join(logDirectory, `${runId}.log`);
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = (): Promise<void> => {
        if (!cleanupPromise) {
            closed = true;
            decisions.clear();
            cleanupPromise = (async () => {
                server.closeAllConnections();
                await new Promise<void>((resolve) => server.close(() => resolve()));
                fs.rmSync(policyPath, { force: true });
            })();
        }
        return cleanupPromise;
    };
    let endpoint: string;
    try {
        endpoint = `http://127.0.0.1:${await listen(server)}/decide`;
        fs.writeFileSync(
            policyPath,
            policyText(endpoint, token, options.taskState?.harnessContext.permission?.getRules?.()),
            'utf8'
        );
    } catch (error) {
        await cleanup();
        throw error;
    }

    const childCommand = [options.shellPath, ...childArgs].map(quoteWindowsArgument).join(' ');
    return {
        file: executable,
        args: sandboxRunArgs({
            policyPath,
            endpoint,
            logPath,
            deleteToTrash: options.deleteToTrash,
            childCommand
        }),
        cwd: undefined,
        attach: (proc) => {
            const finish = () => {
                void cleanup().catch(() => undefined);
            };
            proc.once('exit', finish);
            proc.once('close', finish);
            proc.once('error', finish);
        },
        cleanup
    };
}
