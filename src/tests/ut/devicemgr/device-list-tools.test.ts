import type { DeviceMgrApplication } from '../../../main/applications/devicemgr/app.js';
import type { NodeSession, PairedNode, PendingPairingRequest } from '../../../main/applications/devicemgr/common.js';
import { ListConnectedDevicesTool, ListPairedDevicesTool } from '../../../main/applications/devicemgr/tools.js';

function nodeSession(patch: Partial<NodeSession> & { nodeId: string }): NodeSession {
    return {
        nodeId: patch.nodeId,
        connId: patch.connId ?? `conn-${patch.nodeId}`,
        socket: patch.socket as NodeSession['socket'],
        connect: patch.connect as NodeSession['connect'],
        displayName: patch.displayName,
        platform: patch.platform ?? 'linux',
        version: patch.version ?? '1.0.0',
        deviceFamily: patch.deviceFamily,
        modelIdentifier: patch.modelIdentifier,
        remoteIp: patch.remoteIp,
        caps: patch.caps ?? ['filesystem', 'shell'],
        commands: patch.commands ?? ['system.run'],
        shells: patch.shells ?? ['bash'],
        defaultShell: patch.defaultShell ?? 'bash',
        workspace: patch.workspace,
        permissions: patch.permissions,
        connectedAtMs: patch.connectedAtMs ?? 1000
    };
}

function pairedNode(patch: Partial<PairedNode> & { nodeId: string }): PairedNode {
    return {
        nodeId: patch.nodeId,
        token: patch.token ?? `token-${patch.nodeId}`,
        displayName: patch.displayName,
        platform: patch.platform ?? 'linux',
        version: patch.version,
        deviceFamily: patch.deviceFamily,
        modelIdentifier: patch.modelIdentifier,
        caps: patch.caps,
        commands: patch.commands,
        shells: patch.shells,
        defaultShell: patch.defaultShell,
        workspace: patch.workspace,
        remoteIp: patch.remoteIp,
        createdAtMs: patch.createdAtMs ?? 1000,
        approvedAtMs: patch.approvedAtMs ?? 2000,
        lastConnectedAtMs: patch.lastConnectedAtMs
    };
}

function fakeApp(options: {
    connected?: NodeSession[];
    paired?: PairedNode[];
    pending?: PendingPairingRequest[];
}): DeviceMgrApplication {
    const gateway = {
        isRunning: () => true,
        getNodeRegistry: () => ({
            listConnected: () => options.connected ?? []
        }),
        getPairingStore: () => ({
            list: () => ({
                paired: options.paired ?? [],
                pending: options.pending ?? []
            })
        })
    };
    return {
        getGateway: () => gateway
    } as unknown as DeviceMgrApplication;
}

describe('devicemgr device listing tools', () => {
    test('marks connected nodes as online but unpaired when they are not in the pairing store', async () => {
        const app = fakeApp({
            connected: [nodeSession({ nodeId: 'node-a', displayName: 'Node A' })],
            paired: []
        });

        const result = await new ListConnectedDevicesTool(app).execute({});

        expect(result.status).toBe('success');
        expect(result.result).toContain('共 1 个在线设备');
        expect(result.result).toContain('Node A');
        expect(result.result).toContain('配对状态: 未配对（当前在线，但尚未审批并写入配对存储）');
    });

    test('explains why paired list can be empty while connected nodes exist', async () => {
        const app = fakeApp({
            connected: [nodeSession({ nodeId: 'node-a', displayName: 'Node A' })],
            paired: []
        });

        const result = await new ListPairedDevicesTool(app).execute({});

        expect(result.status).toBe('success');
        expect(result.result).toContain('当前没有已配对的设备。');
        expect(result.result).toContain('在线设备和已配对设备是不同概念');
        expect(result.result).toContain('当前有 1 个在线但未配对的设备');
        expect(result.result).toContain('Node A (node-a)');
    });

    test('marks connected nodes as paired when they exist in pairing store', async () => {
        const app = fakeApp({
            connected: [nodeSession({ nodeId: 'node-a', displayName: 'Node A' })],
            paired: [pairedNode({ nodeId: 'node-a', displayName: 'Node A' })]
        });

        const connectedResult = await new ListConnectedDevicesTool(app).execute({});
        const pairedResult = await new ListPairedDevicesTool(app).execute({});

        expect(connectedResult.result).toContain('配对状态: 已配对');
        expect(pairedResult.result).toContain('共 1 个已配对设备');
        expect(pairedResult.result).toContain('Node A [🟢 在线]');
        expect(pairedResult.result).not.toContain('在线但未配对');
    });
});
