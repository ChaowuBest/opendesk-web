import { afterEach, describe, expect, jest, test } from '@jest/globals';
import McpMgrWorker from '../../../main/applications/mcpmgr/worker.js';
import type { McpServerConfig, McpServerState } from '../../../main/applications/mcpmgr/common.js';

function pluginSkillConfig(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
    return {
        id: 'pluginskill_a',
        name: 'fs',
        transport: 'stdio',
        enabled: true,
        command: 'node',
        args: ['server.js'],
        pluginId: 'some-plugin',
        pluginSkillName: 'some-skill',
        pluginSource: 'builtin',
        ...overrides
    };
}

describe('mcpmgr worker: 插件技能内部 MCP server', () => {
    let worker: McpMgrWorker;

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    function createWorker() {
        worker = new McpMgrWorker('mcpmgr', '/tmp/opendesk-test', null);
        // 连接生命周期不在本测试范围：stub 掉真实连接，只验证配置组合与全局过滤
        jest.spyOn(worker as any, 'connectServer').mockImplementation(async () => undefined);
        jest.spyOn(worker as any, 'disconnectServer').mockImplementation(async () => undefined);
        jest.spyOn(worker as any, 'emitEvent').mockImplementation(async () => undefined);
        (worker as any).configuredServers = [];
        (worker as any).agentServers = [];
        (worker as any).pluginSkillServers = [];
        (worker as any).recomposeServers();
        return worker;
    }

    function connect(id: string, tools: { name: string; description: string; inputSchema?: object }[]) {
        (worker as any).connections.set(id, { client: {}, tools, status: 'connected' });
    }

    test('replacePluginSkillServers：全量替换并进入 servers 组合', async () => {
        createWorker();
        await worker.replacePluginSkillServers([pluginSkillConfig()]);
        const states = (await worker.getServers()) as McpServerState[];
        expect(states).toHaveLength(1);
        expect(states[0]).toMatchObject({
            id: 'pluginskill_a',
            pluginSkillName: 'some-skill',
            pluginSource: 'builtin'
        });
    });

    test('getDiscoveredTools：技能内部 server 的工具不进入全局工具视角', async () => {
        createWorker();
        (worker as any).configuredServers = [
            { id: 'mcp_user', name: 'user-server', transport: 'stdio', enabled: true, command: 'npx' }
        ];
        (worker as any).recomposeServers();
        await worker.replacePluginSkillServers([pluginSkillConfig()]);
        connect('mcp_user', [{ name: 'user_tool', description: 'd', inputSchema: {} }]);
        connect('pluginskill_a', [{ name: 'read_file', description: 'd', inputSchema: {} }]);

        const tools = await worker.getDiscoveredTools();
        expect(tools.map((tool) => tool.name)).toEqual(['user_tool']);
    });

    test('ensurePluginSkillServers：内容未变时静默返回；缺失的补齐、变化的更新', async () => {
        createWorker();
        await worker.replacePluginSkillServers([pluginSkillConfig()]);
        const emitMock = jest.spyOn(worker as any, 'emitEvent').mockImplementation(async () => undefined);
        emitMock.mockClear();

        (worker as any).connectServer.mockClear();
        // 完全相同的内容：配置幂等；但 replace 只登记不建连，ensure 需对未连接的 server 兜底建连
        await worker.ensurePluginSkillServers([pluginSkillConfig()]);
        expect(emitMock).not.toHaveBeenCalled();
        expect((worker as any).connectServer).toHaveBeenCalledWith('pluginskill_a');

        // 连接健康后再 ensure：静默返回，不刷事件、不重复建连
        (worker as any).connections.set('pluginskill_a', { client: {}, tools: [], status: 'connected' });
        (worker as any).connectServer.mockClear();
        await worker.ensurePluginSkillServers([pluginSkillConfig()]);
        expect(emitMock).not.toHaveBeenCalled();
        expect((worker as any).connectServer).not.toHaveBeenCalled();

        // 新增另一个技能的 server：合并而不是替换
        await worker.ensurePluginSkillServers([
            pluginSkillConfig(),
            pluginSkillConfig({ id: 'pluginskill_b', name: 'git', pluginSkillName: 'other-skill' })
        ]);
        expect((worker as any).pluginSkillServers).toHaveLength(2);

        // 配置变化：更新并触发重连
        emitMock.mockClear();
        (worker as any).connectServer.mockClear();
        await worker.ensurePluginSkillServers([
            pluginSkillConfig({ args: ['server-v2.js'] }),
            pluginSkillConfig({ id: 'pluginskill_b', name: 'git', pluginSkillName: 'other-skill' })
        ]);
        expect((worker as any).pluginSkillServers[0].args).toEqual(['server-v2.js']);
        expect(emitMock).toHaveBeenCalled();
        expect((worker as any).connectServer).toHaveBeenCalledWith('pluginskill_a');
    });

    test('懒加载：replace 只登记配置不建连，ensure / connectPluginSkillServers 才建连', async () => {
        createWorker();
        const connectSpy = (worker as any).connectServer as jest.Mock;

        await worker.replacePluginSkillServers([pluginSkillConfig()]);
        expect(connectSpy).not.toHaveBeenCalled();

        // ensure 是技能加载路径：即使配置与 replace 登记的完全一致，也要对未连接的 server 建连
        await worker.ensurePluginSkillServers([pluginSkillConfig()]);
        expect(connectSpy).toHaveBeenCalledWith('pluginskill_a');

        // 已连接的 ensure 静默返回，不重复建连
        (worker as any).connections.set('pluginskill_a', { client: {}, tools: [], status: 'connected' });
        connectSpy.mockClear();
        await worker.ensurePluginSkillServers([pluginSkillConfig()]);
        expect(connectSpy).not.toHaveBeenCalled();

        // connectPluginSkillServers：只连接目标技能名匹配的 server
        connectSpy.mockClear();
        (worker as any).connections.delete('pluginskill_a');
        await worker.replacePluginSkillServers([
            pluginSkillConfig(),
            pluginSkillConfig({ id: 'pluginskill_b', name: 'git', pluginSkillName: 'other-skill' })
        ]);
        await worker.connectPluginSkillServers('some-plugin', 'some-skill');
        expect(connectSpy).toHaveBeenCalledTimes(1);
        expect(connectSpy).toHaveBeenCalledWith('pluginskill_a');

        // 已连接的目标不重连
        connectSpy.mockClear();
        (worker as any).connections.set('pluginskill_a', { client: {}, tools: [], status: 'connected' });
        await worker.connectPluginSkillServers('some-plugin', 'some-skill');
        expect(connectSpy).not.toHaveBeenCalled();
    });

    test('replace/ensure 串行执行：前序操作完成前后续操作不交错', async () => {
        createWorker();
        await worker.replacePluginSkillServers([pluginSkillConfig()]);
        (worker as any).connections.set('pluginskill_a', { client: {}, tools: [], status: 'connected' });

        let releaseDisconnect: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
            releaseDisconnect = resolve;
        });
        (worker as any).disconnectServer.mockImplementation(async () => gate);

        // ensure 的配置变更走被 gate 阻塞的断连路径
        const ensurePromise = worker.ensurePluginSkillServers([pluginSkillConfig({ args: ['server-v2.js'] })]);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect((worker as any).pluginSkillServers[0].args).toEqual(['server-v2.js']);

        // replace 排队在 ensure 之后：ensure 的 syncConnections 完成前不会被应用
        const replacePromise = worker.replacePluginSkillServers([]);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect((worker as any).pluginSkillServers).toHaveLength(1);
        expect((worker as any).pluginSkillServers[0].args).toEqual(['server-v2.js']);

        releaseDisconnect();
        await ensurePromise;
        await replacePromise;
        expect((worker as any).pluginSkillServers).toHaveLength(0);
    });

    describe('懒加载自愈与错误容错', () => {
        /** 让 stub 的 connectServer 表现成一次成功的真实连接（写入可用 client） */
        function stubConnectSuccess(): void {
            (worker as any).connectServer.mockImplementation(async (id: string) => {
                (worker as any).connections.set(id, {
                    client: { callTool: async () => ({ content: [{ type: 'text', text: 'pong' }] }) },
                    tools: [],
                    status: 'connected'
                });
            });
        }

        test('callMcpTool：内部 server 未连接时按需重连后调用成功（历史任务里的技能工具同样适用）', async () => {
            createWorker();
            await worker.replacePluginSkillServers([pluginSkillConfig()]);
            stubConnectSuccess();

            const result = await worker.callMcpTool('pluginskill_a', 'read_file', { path: '/tmp/a' });
            expect(result).toBe('pong');
            expect((worker as any).connectServer).toHaveBeenCalledWith('pluginskill_a');
        });

        test('callMcpTool：重连失败时把底层连接错误透传到工具结果', async () => {
            createWorker();
            await worker.replacePluginSkillServers([pluginSkillConfig()]);
            (worker as any).connectServer.mockImplementation(async () => {
                (worker as any).connections.set('pluginskill_a', {
                    client: null,
                    tools: [],
                    status: 'error',
                    error: 'connect timed out after 30s\n[stderr] command not found'
                });
            });

            await expect(worker.callMcpTool('pluginskill_a', 'read_file', {})).rejects.toThrow(
                /"fs" \(plugin skill "some-skill"\).*connect timed out after 30s\n\[stderr\] command not found/
            );
        });

        test('callMcpTool：建连在途时等待其完成，不重复建连', async () => {
            createWorker();
            await worker.replacePluginSkillServers([pluginSkillConfig()]);
            // createWorker 给 connectServer 打了 stub，本用例需要真实的在途守卫逻辑
            (worker as any).connectServer.mockRestore();
            let releaseConnect: () => void = () => undefined;
            const gate = new Promise<void>((resolve) => {
                releaseConnect = resolve;
            });
            let connectCalls = 0;
            jest.spyOn(worker as any, 'doConnectServer').mockImplementation(async (id: string) => {
                connectCalls += 1;
                await gate;
                (worker as any).connections.set(id, {
                    client: { callTool: async () => ({ content: [{ type: 'text', text: 'pong' }] }) },
                    tools: [],
                    status: 'connected'
                });
            });

            // 第一次调用触发真实建连（在途），第二次调用应等待同一个在途 promise
            const first = worker.callMcpTool('pluginskill_a', 'read_file', {});
            const second = worker.callMcpTool('pluginskill_a', 'read_file', {});
            await new Promise((resolve) => setTimeout(resolve, 0));
            releaseConnect();
            expect(await first).toBe('pong');
            expect(await second).toBe('pong');
            expect(connectCalls).toBe(1);
        });

        test('callMcpTool：非内部 server 不触发自动重连', async () => {
            createWorker();
            (worker as any).configuredServers = [
                { id: 'mcp_user', name: 'user-server', transport: 'stdio', enabled: true, command: 'npx' }
            ];
            (worker as any).recomposeServers();

            await expect(worker.callMcpTool('mcp_user', 'tool', {})).rejects.toThrow('is not connected');
            expect((worker as any).connectServer).not.toHaveBeenCalled();
        });

        test('内部 server 连续 30 分钟无工具调用后自动断开；调用会重置计时', async () => {
            jest.useFakeTimers();
            createWorker();
            await worker.replacePluginSkillServers([pluginSkillConfig()]);
            const disconnectSpy = (worker as any).disconnectServer as jest.Mock;

            // 连接成功即开始计时（生产路径在 doConnectServer 内 arm；测试直接触达以隔离连接细节）
            (worker as any).connections.set('pluginskill_a', {
                client: { callTool: async () => ({ content: [{ type: 'text', text: 'pong' }] }) },
                tools: [],
                status: 'connected'
            });
            (worker as any).armPluginSkillIdleTimer('pluginskill_a');

            // 29 分钟后调用一次：计时重置，再过 29 分钟不应断开
            jest.advanceTimersByTime(29 * 60 * 1000);
            const result = await worker.callMcpTool('pluginskill_a', 'read_file', {});
            expect(result).toBe('pong');
            jest.advanceTimersByTime(29 * 60 * 1000);
            expect(disconnectSpy).not.toHaveBeenCalled();

            // 空闲满 30 分钟：自动断开并清理计时器
            jest.advanceTimersByTime(30 * 60 * 1000);
            expect(disconnectSpy).toHaveBeenCalledWith('pluginskill_a');
        });

        test('空闲断开只作用于内部 server；断开后计时器一并清理', async () => {
            jest.useFakeTimers();
            createWorker();
            (worker as any).configuredServers = [
                { id: 'mcp_user', name: 'user-server', transport: 'stdio', enabled: true, command: 'npx' }
            ];
            (worker as any).recomposeServers();
            await worker.replacePluginSkillServers([pluginSkillConfig()]);
            const disconnectSpy = (worker as any).disconnectServer as jest.Mock;

            // 用户自配 server 不受空闲断开管理
            (worker as any).connections.set('mcp_user', { client: {}, tools: [], status: 'connected' });
            (worker as any).armPluginSkillIdleTimer('mcp_user');
            jest.advanceTimersByTime(31 * 60 * 1000);
            expect(disconnectSpy).not.toHaveBeenCalled();

            // 内部 server 空闲超时断开后，计时器被清理（不会重复触发）
            (worker as any).connections.set('pluginskill_a', { client: {}, tools: [], status: 'connected' });
            (worker as any).armPluginSkillIdleTimer('pluginskill_a');
            jest.advanceTimersByTime(30 * 60 * 1000);
            expect(disconnectSpy).toHaveBeenCalledWith('pluginskill_a');
            expect(disconnectSpy).toHaveBeenCalledTimes(1);
            jest.advanceTimersByTime(30 * 60 * 1000);
            expect(disconnectSpy).toHaveBeenCalledTimes(1);
        });
    });
});
