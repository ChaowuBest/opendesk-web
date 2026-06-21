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

import { ApplicationRegistry } from '../registry.js';
import type { TaskState } from '../../aikernel/states/tasks.js';
import type { NodeExecutionCapabilities, ExecutionNodeSummary } from '../../aikernel/security/harness.js';
import { registerExecutionNodeListProvider } from '../../aikernel/security/harness.js';
import type { DeviceMgrApplication } from './app.js';
import type { NodeInvokeResult, NodeSession } from './common.js';

export const NODE_SHELL_COMMAND = 'system.run';
export const NODE_FILE_COMMANDS = {
    readText: 'fs.readText',
    writeText: 'fs.writeText',
    fetch: 'file.fetch',
    write: 'file.write',
    editText: 'fs.editText',
    searchReplace: 'fs.searchReplace',
    glob: 'fs.glob',
    grep: 'fs.grep'
} as const;

export type NodeShell = 'bash' | 'zsh' | 'powershell' | 'cmd' | 'sh' | 'auto';

function normalizeStringList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const result: string[] = [];
    const seen = new Set<string>();
    for (const item of value) {
        if (typeof item !== 'string') continue;
        const normalized = item.trim().toLowerCase();
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        result.push(normalized);
    }
    return result;
}

function getDeviceMgrApplication(): DeviceMgrApplication | undefined {
    return ApplicationRegistry.getApplication('devicemgr') as DeviceMgrApplication | undefined;
}

function toExecutionNodeSummary(session: NodeSession): ExecutionNodeSummary {
    const shells = normalizeStringList(session.shells);
    const defaultShell = session.defaultShell?.trim().toLowerCase() || undefined;
    if (defaultShell && !shells.includes(defaultShell)) {
        shells.push(defaultShell);
    }
    return {
        nodeId: session.nodeId,
        displayName: session.displayName,
        platform: session.platform,
        workspace: session.workspace,
        commands: [...session.commands],
        shells,
        defaultShell,
        connected: true,
        caps: [...session.caps],
        deviceFamily: session.deviceFamily,
        modelIdentifier: session.modelIdentifier,
        version: session.version,
        remoteIp: session.remoteIp,
        connectedAtMs: session.connectedAtMs
    };
}

export function listExecutionNodes(): ExecutionNodeSummary[] {
    const app = getDeviceMgrApplication();
    const gateway = app?.getGateway();
    if (!gateway?.isRunning()) return [];
    return gateway.getNodeRegistry().listConnected().map(toExecutionNodeSummary);
}

export function getExecutionNode(nodeId: string): ExecutionNodeSummary | null {
    const app = getDeviceMgrApplication();
    const gateway = app?.getGateway();
    if (!gateway?.isRunning()) return null;
    const session = gateway.getNodeRegistry().get(nodeId);
    return session ? toExecutionNodeSummary(session) : null;
}

export function isNodeExecutionActive(taskState?: TaskState): boolean {
    return taskState?.harnessContext?.executionHost?.type === 'node';
}

export function getActiveNodeExecutionCapabilities(taskState?: TaskState): NodeExecutionCapabilities | null {
    const host = taskState?.harnessContext?.executionHost;
    return host?.type === 'node' ? host.capabilities : null;
}

export function nodeSupportsCommand(
    capabilities: NodeExecutionCapabilities | null | undefined,
    command: string
): boolean {
    return Array.isArray(capabilities?.commands) && capabilities.commands.includes(command);
}

export function nodeSupportsShell(
    capabilities: NodeExecutionCapabilities | null | undefined,
    shell: Exclude<NodeShell, 'auto'>
): boolean {
    if (!nodeSupportsCommand(capabilities, NODE_SHELL_COMMAND)) return false;
    const shells = new Set((capabilities?.shells ?? []).map((entry) => entry.trim().toLowerCase()).filter(Boolean));
    const defaultShell = capabilities?.defaultShell?.trim().toLowerCase();
    if (defaultShell) shells.add(defaultShell);
    switch (shell) {
        case 'powershell':
            return shells.has('powershell') || shells.has('pwsh') || shells.has('powershell.exe');
        case 'cmd':
            return shells.has('cmd') || shells.has('cmd.exe');
        case 'bash':
            return shells.has('bash');
        case 'zsh':
            return shells.has('zsh');
        case 'sh':
            return shells.has('sh');
    }
}

async function invokeNodeCommand(params: {
    nodeId: string;
    command: string;
    payload?: unknown;
    timeoutMs?: number;
}): Promise<NodeInvokeResult> {
    const app = getDeviceMgrApplication();
    const gateway = app?.getGateway();
    if (!gateway?.isRunning()) {
        throw new Error('设备网关未启动，无法在 node 上执行工具');
    }
    const result = await gateway.getNodeRegistry().invoke({
        nodeId: params.nodeId,
        command: params.command,
        params: params.payload,
        timeoutMs: params.timeoutMs
    });
    if (!result.ok) {
        const code = result.error?.code ?? 'NODE_INVOKE_FAILED';
        const message = result.error?.message ?? 'node invoke failed';
        throw new Error(`${code}: ${message}`);
    }
    return result;
}

function parsePayload(result: NodeInvokeResult): unknown {
    if (typeof result.payloadJSON === 'string' && result.payloadJSON.trim()) {
        try {
            return JSON.parse(result.payloadJSON);
        } catch {
            return result.payloadJSON;
        }
    }
    return result.payload;
}

function payloadToText(payload: unknown): string {
    if (payload === undefined || payload === null) return '';
    if (typeof payload === 'string') return payload;
    return JSON.stringify(payload, null, 2);
}

export async function runShellOnSelectedNode(params: {
    taskState?: TaskState;
    shell: NodeShell;
    command: string;
    cwd?: string;
    timeoutMs?: number;
}): Promise<string | null> {
    const host = params.taskState?.harnessContext?.executionHost;
    if (host?.type !== 'node') return null;
    if (params.shell !== 'auto' && !nodeSupportsShell(host.capabilities, params.shell)) {
        throw new Error(`节点 ${host.nodeId} 不支持 ${params.shell} shell`);
    }
    const result = await invokeNodeCommand({
        nodeId: host.nodeId,
        command: NODE_SHELL_COMMAND,
        payload: {
            command: params.command,
            shell: params.shell,
            cwd: params.cwd,
            timeoutMs: params.timeoutMs
        },
        timeoutMs: params.timeoutMs
    });
    const payload = parsePayload(result);
    if (payload && typeof payload === 'object') {
        const obj = payload as Record<string, unknown>;
        const stdout = typeof obj.stdout === 'string' ? obj.stdout : '';
        const stderr = typeof obj.stderr === 'string' ? obj.stderr : '';
        const error = typeof obj.error === 'string' ? obj.error : '';
        const parts = [stdout, stderr, error].filter(Boolean);
        if (parts.length > 0) return parts.join('\n').trimEnd();
    }
    return payloadToText(payload).trimEnd();
}

export async function invokeNodeTextCommand(params: {
    taskState?: TaskState;
    command: string;
    payload?: unknown;
    timeoutMs?: number;
}): Promise<string | null> {
    const host = params.taskState?.harnessContext?.executionHost;
    if (host?.type !== 'node') return null;
    if (!nodeSupportsCommand(host.capabilities, params.command)) {
        throw new Error(`节点 ${host.nodeId} 不支持 ${params.command}`);
    }
    const result = await invokeNodeCommand({
        nodeId: host.nodeId,
        command: params.command,
        payload: params.payload,
        timeoutMs: params.timeoutMs
    });
    return payloadToText(parsePayload(result));
}

// 注册 aikernel 层的节点列表 provider，避免 aikernel 直接依赖 applications 层
registerExecutionNodeListProvider(listExecutionNodes);
