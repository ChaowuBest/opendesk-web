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

import { BaseTool } from '../../aikernel/tool.js';
import { z } from 'zod';
import type { DeviceMgrApplication } from './app.js';
import type { NodeSession, PairedNode, PendingPairingRequest } from './common.js';

function buildPairedNodeMap(paired: PairedNode[]): Map<string, PairedNode> {
    return new Map(paired.map((node) => [node.nodeId, node]));
}

function buildPendingNodeMap(pending: PendingPairingRequest[]): Map<string, PendingPairingRequest> {
    return new Map(pending.map((request) => [request.nodeId, request]));
}

function formatConnectedPairingStatus(
    node: NodeSession,
    pairedByNodeId: Map<string, PairedNode>,
    pendingByNodeId: Map<string, PendingPairingRequest>
): string {
    if (pairedByNodeId.has(node.nodeId)) {
        return '已配对';
    }
    if (pendingByNodeId.has(node.nodeId)) {
        return '待审批配对';
    }
    return '未配对（当前在线，但尚未审批并写入配对存储）';
}

function formatOnlineUnpairedNote(connectedNodes: NodeSession[], pairedByNodeId: Map<string, PairedNode>): string {
    const unpairedOnline = connectedNodes.filter((node) => !pairedByNodeId.has(node.nodeId));
    if (unpairedOnline.length === 0) return '';
    const lines = unpairedOnline.map(
        (node, index) => `  ${index + 1}. ${node.displayName || node.nodeId} (${node.nodeId})`
    );
    return [
        `说明：在线设备和已配对设备是不同概念。在线表示当前 WebSocket 已连接；已配对表示节点已经审批并持久写入配对存储。`,
        `当前有 ${unpairedOnline.length} 个在线但未配对的设备：`,
        ...lines
    ].join('\n');
}

// ── Get Gateway Status ──────────────────────────────────────────────────────

const GetGatewayStatusSchema = z.object({});

export class GetGatewayStatusTool extends BaseTool<typeof GetGatewayStatusSchema> {
    private app: DeviceMgrApplication;

    constructor(app: DeviceMgrApplication) {
        super(
            'getDeviceGatewayStatus',
            'Get the status of the device gateway WebSocket server, including port, running state, and number of connected nodes.',
            GetGatewayStatusSchema,
            undefined,
            { 'zh-CN': '网关状态', 'en-US': 'Gateway Status' }
        );
        this.app = app;
        this.setExecutor(this.run.bind(this));
    }

    private async run(): Promise<string> {
        const gw = this.app.getGateway();
        if (!gw || !gw.isRunning()) {
            return '设备网关未启动。';
        }
        const connected = gw.getNodeRegistry().listConnected();
        const pairing = gw.getPairingStore().list();
        const identity = gw.getIdentity();

        return [
            `设备网关状态:`,
            `  运行中: 是`,
            `  监听地址: ${gw.getHost()}`,
            `  端口: ${gw.getPort()}`,
            `  网关 ID: ${identity.deviceId}`,
            `  在线设备: ${connected.length}`,
            `  已配对设备: ${pairing.paired.length}`,
            `  待审批配对: ${pairing.pending.length}`
        ].join('\n');
    }
}

// ── List Connected Devices ──────────────────────────────────────────────────

const ListConnectedDevicesSchema = z.object({});

export class ListConnectedDevicesTool extends BaseTool<typeof ListConnectedDevicesSchema> {
    private app: DeviceMgrApplication;

    constructor(app: DeviceMgrApplication) {
        super(
            'listConnectedDevices',
            'List all currently online/connected device nodes via the OpenClaw WebSocket gateway. Shows node ID, display name, platform, capabilities, and connection time.',
            ListConnectedDevicesSchema,
            undefined,
            { 'zh-CN': '在线设备', 'en-US': 'Connected Devices' }
        );
        this.app = app;
        this.setExecutor(this.run.bind(this));
    }

    private async run(): Promise<string> {
        const gw = this.app.getGateway();
        if (!gw?.isRunning()) return '设备网关未启动。';

        const nodes = gw.getNodeRegistry().listConnected();
        if (nodes.length === 0) return '当前没有在线设备。';
        const { paired, pending } = gw.getPairingStore().list();
        const pairedByNodeId = buildPairedNodeMap(paired);
        const pendingByNodeId = buildPendingNodeMap(pending);

        const lines = nodes.map((n, i) => {
            const caps = n.caps.length > 0 ? n.caps.join(', ') : '无';
            const cmds = n.commands.length > 0 ? n.commands.join(', ') : '无';
            return [
                `${i + 1}. ${n.displayName || n.nodeId}`,
                `   节点ID: ${n.nodeId}`,
                `   平台: ${n.platform || '未知'}`,
                `   设备系列: ${n.deviceFamily || '未知'}`,
                `   配对状态: ${formatConnectedPairingStatus(n, pairedByNodeId, pendingByNodeId)}`,
                `   能力: ${caps}`,
                `   命令: ${cmds}`,
                `   连接时间: ${new Date(n.connectedAtMs).toLocaleString()}`,
                `   IP: ${n.remoteIp || '未知'}`
            ].join('\n');
        });

        return `共 ${nodes.length} 个在线设备:\n\n${lines.join('\n\n')}`;
    }
}

// ── List Paired Devices ─────────────────────────────────────────────────────

const ListPairedDevicesSchema = z.object({});

export class ListPairedDevicesTool extends BaseTool<typeof ListPairedDevicesSchema> {
    private app: DeviceMgrApplication;

    constructor(app: DeviceMgrApplication) {
        super(
            'listPairedDevices',
            'List all paired (approved) device nodes, including both online and offline ones.',
            ListPairedDevicesSchema,
            undefined,
            { 'zh-CN': '已配对设备', 'en-US': 'Paired Devices' }
        );
        this.app = app;
        this.setExecutor(this.run.bind(this));
    }

    private async run(): Promise<string> {
        const gw = this.app.getGateway();
        if (!gw?.isRunning()) return '设备网关未启动。';

        const { paired } = gw.getPairingStore().list();
        const pairedByNodeId = buildPairedNodeMap(paired);
        const connectedNodes = gw.getNodeRegistry().listConnected();
        const connected = new Set(connectedNodes.map((n) => n.nodeId));
        const onlineUnpairedNote = formatOnlineUnpairedNote(connectedNodes, pairedByNodeId);
        if (paired.length === 0) {
            return ['当前没有已配对的设备。', onlineUnpairedNote].filter(Boolean).join('\n\n');
        }

        const lines = paired.map((n, i) => {
            const online = connected.has(n.nodeId) ? '🟢 在线' : '⚪ 离线';
            return [
                `${i + 1}. ${n.displayName || n.nodeId} [${online}]`,
                `   节点ID: ${n.nodeId}`,
                `   平台: ${n.platform || '未知'}`,
                `   设备系列: ${n.deviceFamily || '未知'}`,
                `   配对时间: ${new Date(n.approvedAtMs).toLocaleString()}`,
                n.lastConnectedAtMs ? `   最后连接: ${new Date(n.lastConnectedAtMs).toLocaleString()}` : ''
            ]
                .filter(Boolean)
                .join('\n');
        });

        return [`共 ${paired.length} 个已配对设备:`, lines.join('\n\n'), onlineUnpairedNote]
            .filter(Boolean)
            .join('\n\n');
    }
}

// ── List Pending Pairings ───────────────────────────────────────────────────

const ListPendingPairingsSchema = z.object({});

export class ListPendingPairingsTool extends BaseTool<typeof ListPendingPairingsSchema> {
    private app: DeviceMgrApplication;

    constructor(app: DeviceMgrApplication) {
        super(
            'listPendingDevicePairings',
            'List all pending device pairing requests waiting for approval.',
            ListPendingPairingsSchema,
            undefined,
            { 'zh-CN': '待配对请求', 'en-US': 'Pending Pairings' }
        );
        this.app = app;
        this.setExecutor(this.run.bind(this));
    }

    private async run(): Promise<string> {
        const gw = this.app.getGateway();
        if (!gw?.isRunning()) return '设备网关未启动。';

        const { pending } = gw.getPairingStore().list();
        if (pending.length === 0) return '当前没有待审批的配对请求。';

        const lines = pending.map((r, i) =>
            [
                `${i + 1}. ${r.displayName || r.nodeId}`,
                `   请求ID: ${r.requestId}`,
                `   节点ID: ${r.nodeId}`,
                `   平台: ${r.platform || '未知'}`,
                `   设备系列: ${r.deviceFamily || '未知'}`,
                `   能力: ${r.caps?.join(', ') || '无'}`,
                `   请求时间: ${new Date(r.ts).toLocaleString()}`,
                `   IP: ${r.remoteIp || '未知'}`,
                r.isRepair ? '   类型: 重新配对' : ''
            ]
                .filter(Boolean)
                .join('\n')
        );

        return `共 ${pending.length} 个待审批配对请求:\n\n${lines.join('\n\n')}`;
    }
}

// ── Approve Pairing ─────────────────────────────────────────────────────────

const ApprovePairingSchema = z.object({
    requestId: z.string().describe('The pairing request ID to approve (from listPendingDevicePairings)')
});

export class ApproveDevicePairingTool extends BaseTool<typeof ApprovePairingSchema> {
    private app: DeviceMgrApplication;

    constructor(app: DeviceMgrApplication) {
        super(
            'approveDevicePairing',
            'Approve a pending device pairing request. The device will receive a pairing token and can reconnect as an authenticated node.',
            ApprovePairingSchema,
            undefined,
            { 'zh-CN': '批准配对', 'en-US': 'Approve Pairing' }
        );
        this.app = app;
        this.setExecutor(this.run.bind(this));
    }

    private async run(args: z.infer<typeof ApprovePairingSchema>): Promise<string> {
        const gw = this.app.getGateway();
        if (!gw?.isRunning()) return '设备网关未启动。';

        const result = gw.getPairingStore().approve(args.requestId);
        if (!result) return `未找到请求 ID 为 ${args.requestId} 的待审批配对请求。`;

        return `已批准设备 ${result.node.displayName || result.node.nodeId} 的配对请求。该设备现在可以重新连接并使用已授权的 token 进行认证。`;
    }
}

// ── Reject Pairing ──────────────────────────────────────────────────────────

const RejectPairingSchema = z.object({
    requestId: z.string().describe('The pairing request ID to reject')
});

export class RejectDevicePairingTool extends BaseTool<typeof RejectPairingSchema> {
    private app: DeviceMgrApplication;

    constructor(app: DeviceMgrApplication) {
        super('rejectDevicePairing', 'Reject a pending device pairing request.', RejectPairingSchema, undefined, {
            'zh-CN': '拒绝配对',
            'en-US': 'Reject Pairing'
        });
        this.app = app;
        this.setExecutor(this.run.bind(this));
    }

    private async run(args: z.infer<typeof RejectPairingSchema>): Promise<string> {
        const gw = this.app.getGateway();
        if (!gw?.isRunning()) return '设备网关未启动。';

        const result = gw.getPairingStore().reject(args.requestId);
        if (!result) return `未找到请求 ID 为 ${args.requestId} 的待审批配对请求。`;

        return `已拒绝节点 ${result.nodeId} 的配对请求。`;
    }
}

// ── Invoke Device Command ───────────────────────────────────────────────────

const InvokeDeviceCommandSchema = z.object({
    nodeId: z.string().describe('Target device node ID'),
    command: z
        .string()
        .describe('Command to invoke on the device (e.g. "camera.snap", "location.get", "screen.record")'),
    params: z.any().optional().describe('Optional JSON parameters for the command'),
    timeoutMs: z.number().optional().describe('Timeout in milliseconds (default: 30000)')
});

export class InvokeDeviceCommandTool extends BaseTool<typeof InvokeDeviceCommandSchema> {
    private app: DeviceMgrApplication;

    constructor(app: DeviceMgrApplication) {
        super(
            'invokeDeviceCommand',
            'Invoke a command on a connected device node. The device must be online and support the specified command. Common commands: camera.snap, canvas.navigate, screen.record, location.get, voice.record.',
            InvokeDeviceCommandSchema,
            undefined,
            { 'zh-CN': '调用设备命令', 'en-US': 'Invoke Device Command' }
        );
        this.app = app;
        this.setExecutor(this.run.bind(this));
    }

    private async run(args: z.infer<typeof InvokeDeviceCommandSchema>): Promise<string> {
        const gw = this.app.getGateway();
        if (!gw?.isRunning()) return '设备网关未启动。';

        const result = await gw.getNodeRegistry().invoke({
            nodeId: args.nodeId,
            command: args.command,
            params: args.params,
            timeoutMs: args.timeoutMs
        });

        if (result.ok) {
            const payload = result.payloadJSON
                ? result.payloadJSON
                : result.payload !== undefined
                  ? JSON.stringify(result.payload, null, 2)
                  : '(无返回数据)';
            return `命令执行成功:\n${payload}`;
        }

        const errCode = result.error?.code || 'UNKNOWN';
        const errMsg = result.error?.message || '未知错误';
        return `命令执行失败 [${errCode}]: ${errMsg}`;
    }
}
