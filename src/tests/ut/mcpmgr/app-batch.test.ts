import { describe, expect, test } from '@jest/globals';
import { McpMgrApplication } from '../../../main/applications/mcpmgr/app.js';

type Server = {
    id: string;
    name: string;
    transport: string;
    enabled: boolean;
    command?: string;
    args?: string[];
};

function createApp(servers: Server[], options: { failIds?: string[] } = {}) {
    const app = Object.create(McpMgrApplication.prototype) as McpMgrApplication;
    const state = {
        servers: JSON.parse(JSON.stringify(servers)) as Server[],
        saved: 0,
        events: 0
    };
    (app as any).getServersFromConfig = () => state.servers;
    (app as any).saveServersToConfig = (next: Server[]) => {
        state.servers = JSON.parse(JSON.stringify(next));
        state.saved += 1;
    };
    (app as any).sendEventToSubscribers = () => {
        state.events += 1;
    };
    (app as any).assertServerLocalRuntimeAvailable = (server: Server) => {
        if (options.failIds?.includes(server.id)) throw new Error(`runtime unavailable: ${server.id}`);
    };
    return { app, state };
}

function serversFixture(): Server[] {
    return [
        { id: 's1', name: 'Alpha', transport: 'stdio', enabled: true, command: 'npx' },
        { id: 's2', name: 'Beta', transport: 'stdio', enabled: true, command: 'npx' },
        { id: 's3', name: 'Gamma', transport: 'sse', enabled: false }
    ];
}

describe('MCP manager batch server operations', () => {
    test('setServersEnabled writes the config once and skips entries already in the target state', async () => {
        const { app, state } = createApp(serversFixture());

        const result = await app.setServersEnabled(['s1', 's2', 's3'], false);

        expect(result.changed).toBe(2);
        expect(result.failed).toEqual([]);
        expect(state.servers.map((server) => server.enabled)).toEqual([false, false, false]);
        // 一次批量调用只写盘一次、只发一次事件，而不是逐条保存
        expect(state.saved).toBe(1);
        expect(state.events).toBe(1);

        const again = await app.setServersEnabled(['s1', 's2'], false);
        expect(again.changed).toBe(0);
        expect(state.saved).toBe(1);
    });

    test('setServersEnabled reports unknown ids and runtime failures without aborting the batch', async () => {
        const servers = serversFixture();
        servers[1].enabled = false;
        const { app, state } = createApp(servers, { failIds: ['s2'] });

        const result = await app.setServersEnabled(['s1', 's2', 'missing'], true);

        // s1 已启用 → 跳过；s2 运行时不可用 → 失败；missing 不存在 → 失败
        expect(result.changed).toBe(0);
        expect(result.failed.map((item) => item.id).sort()).toEqual(['missing', 's2']);
        expect(state.saved).toBe(0);

        const enableS3 = await app.setServersEnabled(['s3'], true);
        expect(enableS3.changed).toBe(1);
        expect(state.servers.find((server) => server.id === 's3')?.enabled).toBe(true);
    });

    test('deleteServers removes every matched id in one write and reports the rest', async () => {
        const { app, state } = createApp(serversFixture());

        const result = await app.deleteServers(['s1', 's3', 'ghost']);

        expect(result.changed).toBe(2);
        expect(result.failed.map((item) => item.id)).toEqual(['ghost']);
        expect(state.servers.map((server) => server.id)).toEqual(['s2']);
        expect(state.saved).toBe(1);
        expect(state.events).toBe(1);
    });

    test('an empty batch is a no-op that never touches the config file', async () => {
        const { app, state } = createApp(serversFixture());

        expect(await app.setServersEnabled([], true)).toEqual({ changed: 0, failed: [] });
        expect(await app.deleteServers([])).toEqual({ changed: 0, failed: [] });
        expect(state.saved).toBe(0);
        expect(state.events).toBe(0);
    });
});
