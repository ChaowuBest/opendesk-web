import path from 'path';
import { pathToFileURL } from 'url';

/**
 * 内置品牌注册表插件的搜索失败契约回归：断网 / 超时 / HTTP 错误必须以
 * `error` 字段（原始错误明细）回传，而不是吞进 `message`（信息性计数）。
 *
 * 此前各品牌插件把「getaddrinfo ENOTFOUND …」这类网络错误塞进 message，
 * 渲染层把它当成普通提示显示在搜索框右端的小字里，同时下方给出误导性的
 * 「未找到匹配的技能 / 未找到 MCP」空态。
 */

const PLUGINS_DIRECTORY = path.resolve(process.cwd(), 'resources/plugins');

interface CapturedRegistryContext {
    registry: {
        fetch: (input: unknown, init?: unknown) => Promise<unknown>;
        registerSkillRegistry: (definition: Record<string, unknown>) => { dispose: () => Promise<void> };
        registerMcpRegistry: (definition: Record<string, unknown>) => { dispose: () => Promise<void> };
    };
    registeredSkillRegistries: Record<string, unknown>[];
    registeredMcpRegistries: Record<string, unknown>[];
}

function createContext(fetchImpl?: CapturedRegistryContext['registry']['fetch']): CapturedRegistryContext {
    const context: CapturedRegistryContext = {
        registeredSkillRegistries: [],
        registeredMcpRegistries: [],
        registry: {} as CapturedRegistryContext['registry']
    };
    context.registry = {
        fetch:
            fetchImpl ??
            (async () => {
                throw new Error('fetch should be delegated to the host registry capability');
            }),
        registerSkillRegistry: (definition) => {
            context.registeredSkillRegistries.push(definition);
            return { dispose: async () => undefined };
        },
        registerMcpRegistry: (definition) => {
            context.registeredMcpRegistries.push(definition);
            return { dispose: async () => undefined };
        }
    };
    return context;
}

async function loadPlugin(directoryName: string): Promise<{ id: string; setup: (ctx: unknown) => Promise<unknown> }> {
    const entryPath = path.join(PLUGINS_DIRECTORY, directoryName, 'index.mjs');
    const module = (await import(`${pathToFileURL(entryPath).href}?spec=${Date.now()}-${Math.random()}`)) as {
        default: { id: string; setup: (ctx: unknown) => Promise<unknown> };
    };
    return module.default;
}

function networkFailure(): Error {
    // undici fetch 的网络失败形态：外层 message 不含原因，真实原因挂在 cause 链上
    const error = new TypeError('fetch failed');
    (error as TypeError & { cause?: Error }).cause = new Error('getaddrinfo ENOTFOUND api.example.com');
    return error;
}

function timeoutFailure(): Error {
    const error = new Error('The operation was aborted due to timeout');
    error.name = 'TimeoutError';
    return error;
}

function jsonResponse(data: unknown) {
    return { ok: true, status: 200, json: async () => data };
}

/* 各品牌注册表一次成功搜索的响应样例（与既有验收测试保持同一 API 形状） */
const SUCCESS_RESPONSES: Record<string, unknown> = {
    skillhub: { code: 0, data: { skills: [{ slug: 'demo', name: 'Demo', description: 'd' }], total: 1 } },
    clawhub: {
        items: [{ slug: 'demo', name: 'demo', displayName: 'Demo', ownerHandle: 'alice', summary: 'd', stats: {} }],
        nextCursor: null
    },
    matrix: {
        data: {
            list: [{ id: 1, enName: 'demo', name: 'Demo', description: 'd', owner: { cnName: 'alice' } }],
            count: 1
        }
    },
    modelscope: {
        Code: 200,
        Data: { SkillList: [{ Name: 'demo', DisplayName: 'Demo', Description: 'd', Owner: 'alice' }], TotalCount: 1 }
    },
    'matrix-mcp': {
        code: '20000',
        data: {
            count: 1,
            list: [
                {
                    id: 'm1',
                    name: 'demo',
                    enName: 'demo',
                    mcpServerConfiguration: '{"mcpServers":{"a":{"command":"node"}}}'
                }
            ]
        }
    },
    'modelscope-mcp': {
        Code: 200,
        Success: true,
        Data: {
            Data: {
                Mcp: { McpServers: [{ Name: 'fetch', Path: '@modelcontextprotocol' }], TotalCount: 1 }
            }
        }
    }
};

const SKILL_CASES = [
    { dir: 'matrix', id: 'matrix', itemsKey: 'skills' },
    { dir: 'clawhub', id: 'clawhub', itemsKey: 'skills' },
    { dir: 'skillhub', id: 'skillhub', itemsKey: 'skills' },
    { dir: 'modelscope', id: 'modelscope', itemsKey: 'skills' }
] as const;

const MCP_CASES = [
    { dir: 'matrix', id: 'matrix', itemsKey: 'mcps' },
    { dir: 'modelscope', id: 'modelscope-mcp', itemsKey: 'mcps' }
] as const;

interface SearchLike {
    search: (opts?: Record<string, unknown>) => Promise<Record<string, any>>;
}

async function loadSkillRegistry(
    dir: string,
    fetchImpl?: CapturedRegistryContext['registry']['fetch']
): Promise<SearchLike> {
    const plugin = await loadPlugin(dir);
    const context = createContext(fetchImpl);
    await plugin.setup(context);
    return context.registeredSkillRegistries[0] as unknown as SearchLike;
}

async function loadMcpRegistry(
    dir: string,
    fetchImpl?: CapturedRegistryContext['registry']['fetch']
): Promise<SearchLike> {
    const plugin = await loadPlugin(dir);
    const context = createContext(fetchImpl);
    await plugin.setup(context);
    const expectedId = MCP_CASES.find((c) => c.dir === dir)!.id;
    return context.registeredMcpRegistries.find((registry) => registry.id === expectedId) as unknown as SearchLike;
}

describe('品牌注册表插件的搜索失败契约', () => {
    test.each(SKILL_CASES.map((c) => [c.dir, c] as const))(
        '%s 技能注册表：网络错误走 error 字段而非 message',
        async (_dir, { dir, itemsKey }) => {
            const registry = await loadSkillRegistry(dir, (() => Promise.reject(networkFailure())) as never);
            const result = await registry.search({ query: '' });

            expect(Array.isArray(result[itemsKey])).toBe(true);
            expect(result[itemsKey]).toEqual([]);
            expect(result.hasMore).toBe(false);
            expect(result.total).toBe(0);
            // 原始底层原因必须保留在 error 里（供渲染层分类展示），且不再伪装成信息性 message
            expect(result.error).toContain('getaddrinfo ENOTFOUND');
            expect(result.message).toBeUndefined();
        }
    );

    test.each(MCP_CASES.map((c) => [c.dir, c] as const))(
        '%s MCP 注册表：网络错误走 error 字段而非 message',
        async (_dir, { dir, itemsKey }) => {
            const registry = await loadMcpRegistry(dir, (() => Promise.reject(networkFailure())) as never);
            const result = await registry.search({ query: '' });

            expect(result[itemsKey]).toEqual([]);
            expect(result.hasMore).toBe(false);
            expect(result.total).toBe(0);
            expect(result.error).toContain('getaddrinfo ENOTFOUND');
            expect(result.message).toBeUndefined();
        }
    );

    test('超时同样走 error 字段', async () => {
        const registry = await loadSkillRegistry('skillhub', (() => Promise.reject(timeoutFailure())) as never);
        const result = await registry.search({ query: '' });
        expect(result.error).toContain('aborted due to timeout');
        expect(result.message).toBeUndefined();
        expect(result.skills).toEqual([]);
    });

    test('HTTP 状态错误走 error 字段并保留状态码', async () => {
        const registry = await loadSkillRegistry('skillhub', (async () => ({ ok: false, status: 503 })) as never);
        const result = await registry.search({ query: '' });
        expect(result.error).toContain('503');
        expect(result.message).toBeUndefined();
    });

    test('成功搜索仍以 message 回传信息性计数，不产生 error', async () => {
        const registry = await loadSkillRegistry('skillhub', (async () =>
            jsonResponse(SUCCESS_RESPONSES.skillhub)) as never);
        const result = await registry.search({ query: '' });
        expect(result.error).toBeUndefined();
        expect(result.skills?.length).toBe(1);
        expect(typeof result.message).toBe('string');
    });

    test('MCP 注册表成功搜索不产生 error', async () => {
        const registry = await loadMcpRegistry('matrix', (async () =>
            jsonResponse(SUCCESS_RESPONSES['matrix-mcp'])) as never);
        const result = await registry.search({ query: '' });
        expect(result.error).toBeUndefined();
        expect(result.mcps?.length).toBe(1);
        expect(typeof result.message).toBe('string');
    });
});
