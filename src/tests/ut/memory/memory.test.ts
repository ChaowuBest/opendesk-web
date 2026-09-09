/**
 * Factorial memory unit tests.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { FactorialMemoryStore } from '../../../main/aikernel/memory/store';
import { createMemoryToolset } from '../../../main/aikernel/memory/tools';
import { getGlobalMemoryFilePath, getWorkspaceMemoryFilePath } from '../../../main/aikernel/memory/common';
import {
    buildFactorialMemoryReviewPrompt,
    buildFactorialMemoryReviewSystemPrompt,
    formatMemoryIndexForReview
} from '../../../main/aikernel/memory/factorial_memory';
import { ToolCall } from '../../../main/aikernel/messages';

let testDir: string;

function setup(): { registry: FactorialMemoryStore; workspaceDir: string; globalDir: string } {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-memory-test-'));
    const globalDir = path.join(testDir, 'global-app');
    const workspaceDir = path.join(testDir, 'workspace');
    fs.mkdirSync(globalDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });

    const registry = FactorialMemoryStore.createForTest(workspaceDir, globalDir);
    return { registry, workspaceDir, globalDir };
}

function cleanup() {
    if (testDir && fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
    }
}

function makeToolCall(toolName: string, args: object, result: unknown): ToolCall {
    const toolCall = new ToolCall(0, `call-${toolName}`, toolName, JSON.stringify(args));
    toolCall.args_object = args;
    toolCall.status = 'success';
    toolCall.result = JSON.stringify(result);
    return toolCall;
}

afterEach(() => {
    cleanup();
});

describe('关键事实记忆', () => {
    test('memory.json 路径固定在全局和工作区记忆目录下', () => {
        const { workspaceDir, globalDir } = setup();

        expect(getGlobalMemoryFilePath({ baseDir: globalDir })).toBe(path.join(globalDir, 'memory', 'memory.json'));
        expect(getWorkspaceMemoryFilePath({ workspaceDir })).toBe(
            path.join(workspaceDir, '.opendesk', 'memory', 'memory.json')
        );
    });

    test('addMemory 自动创建文件并返回短 uid', async () => {
        const { registry, workspaceDir } = setup();

        const result = await registry.addMemory(
            'workspace',
            '项目构建命令',
            '项目使用 npm run build 构建 Electron 应用。'
        );

        expect(result.success).toBe(true);
        expect(result.status).toBe('created');
        expect(result.scope).toBe('workspace');
        expect(result.uid).toHaveLength(12);

        const filePath = path.join(workspaceDir, '.opendesk', 'memory', 'memory.json');
        expect(fs.existsSync(filePath)).toBe(true);
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        expect(raw).toHaveLength(1);
        expect(raw[0]).toMatchObject({
            uid: result.uid,
            title: '项目构建命令',
            content: '项目使用 npm run build 构建 Electron 应用。',
            heat: 0
        });
        expect(Date.parse(raw[0].createdAt)).not.toBeNaN();
        expect(raw[0].updatedAt).toBe(raw[0].createdAt);
    });

    test('updateMemory 修改标题和内容并刷新更新时间', async () => {
        const { registry } = setup();
        const created = await registry.addMemory('workspace', '旧标题', '旧内容');
        const before = await registry.getMemory(created.uid);

        await new Promise((resolve) => setTimeout(resolve, 5));
        await expect(registry.updateMemory(created.uid, '新标题', '新内容')).resolves.toMatchObject({
            success: true,
            updated: true,
            uid: created.uid,
            scope: 'workspace'
        });

        const after = await registry.getMemory(created.uid);
        expect(after?.chunk).toMatchObject({
            title: '新标题',
            content: '新内容',
            createdAt: before?.chunk.createdAt
        });
        expect(Date.parse(after!.chunk.updatedAt)).toBeGreaterThan(Date.parse(before!.chunk.updatedAt));
    });

    test('cleanupStaleMemories 同时清理全局和工作区中超过一周且热度为 0 的记忆', async () => {
        const { registry, workspaceDir, globalDir } = setup();
        const now = new Date('2026-08-05T12:00:00.000Z');
        const stale = '2026-07-20T12:00:00.000Z';
        const recent = '2026-08-01T12:00:00.000Z';
        const exactlyOneWeek = '2026-07-29T12:00:00.000Z';
        const workspaceFile = getWorkspaceMemoryFilePath({ workspaceDir });
        const globalFile = getGlobalMemoryFilePath({ baseDir: globalDir });
        fs.mkdirSync(path.dirname(workspaceFile), { recursive: true });
        fs.mkdirSync(path.dirname(globalFile), { recursive: true });
        fs.writeFileSync(
            workspaceFile,
            JSON.stringify([
                { uid: 'workspace-stale', title: '过期', content: '删除', heat: 0, createdAt: stale, updatedAt: stale },
                { uid: 'workspace-hot', title: '有热度', content: '保留', heat: 2, createdAt: stale, updatedAt: stale },
                {
                    uid: 'workspace-boundary',
                    title: '恰好一周',
                    content: '保留',
                    heat: 0,
                    createdAt: exactlyOneWeek,
                    updatedAt: exactlyOneWeek
                }
            ])
        );
        fs.writeFileSync(
            globalFile,
            JSON.stringify([
                {
                    uid: 'global-stale',
                    title: '全局过期',
                    content: '删除',
                    heat: 0,
                    createdAt: stale,
                    updatedAt: stale
                },
                { uid: 'global-recent', title: '近期', content: '保留', heat: 0, createdAt: recent, updatedAt: recent }
            ])
        );

        await expect(registry.cleanupStaleMemories({ now })).resolves.toEqual({
            removed: 2,
            byScope: { workspace: 1, global: 1 }
        });
        expect((await registry.listMemories('workspace')).map((memory) => memory.uid).sort()).toEqual([
            'workspace-boundary',
            'workspace-hot'
        ]);
        expect((await registry.listMemories('global')).map((memory) => memory.uid)).toEqual(['global-recent']);
    });

    test('旧格式记忆使用 memory.json 修改时间补齐时间戳', async () => {
        const { registry, workspaceDir } = setup();
        const filePath = getWorkspaceMemoryFilePath({ workspaceDir });
        const legacyUpdatedAt = new Date('2026-07-15T08:30:00.000Z');
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify([{ uid: 'legacy', title: '旧记忆', content: '旧内容', heat: 0 }]));
        fs.utimesSync(filePath, legacyUpdatedAt, legacyUpdatedAt);

        const [memory] = await registry.listMemories('workspace');
        expect(memory.createdAt).toBe(legacyUpdatedAt.toISOString());
        expect(memory.updatedAt).toBe(legacyUpdatedAt.toISOString());
    });

    test('searchMemory 只返回 uid 和 title', async () => {
        const { registry } = setup();

        const first = await registry.addMemory('workspace', 'TypeScript 配置', '项目启用 TypeScript strict 模式。');
        await registry.addMemory('workspace', 'Docker 部署方案', '使用 Docker Compose 进行本地开发。');
        const third = await registry.addMemory('global', '会议安排', '每周一下午有站会。');

        const tsResults = await registry.searchMemory('TypeScript');
        expect(tsResults).toEqual([{ uid: first.uid, title: 'TypeScript 配置' }]);

        const meetingResults = await registry.searchMemory('站会');
        expect(meetingResults).toEqual([{ uid: third.uid, title: '会议安排' }]);

        const noResults = await registry.searchMemory('量子计算');
        expect(noResults).toEqual([]);
        expect(Object.keys(tsResults[0])).toEqual(['uid', 'title']);
    });

    test('getMemory 获取全文时按需递增热度', async () => {
        const { registry } = setup();

        const created = await registry.addMemory('workspace', '构建工具', '项目使用 electron-vite 构建。');

        const preview = await registry.getMemory(created.uid);
        expect(preview?.chunk.heat).toBe(0);

        const loaded = await registry.getMemory(created.uid, { incrementHeat: true });
        expect(loaded?.scope).toBe('workspace');
        expect(loaded?.chunk.content).toContain('electron-vite');
        expect(loaded?.chunk.heat).toBe(1);

        const loadedAgain = await registry.getMemory(created.uid, { incrementHeat: true });
        expect(loadedAgain?.chunk.heat).toBe(2);
    });

    test('removeMemory 删除指定 uid', async () => {
        const { registry } = setup();

        const created = await registry.addMemory('workspace', '待删除记忆', '这条记忆会被删除。');
        expect(await registry.getMemory(created.uid)).toBeDefined();

        await expect(registry.removeMemory(created.uid)).resolves.toMatchObject({
            success: true,
            removed: true,
            uid: created.uid,
            scope: 'workspace'
        });
        await expect(registry.getMemory(created.uid)).resolves.toBeUndefined();

        await expect(registry.removeMemory('non-existent')).resolves.toMatchObject({
            success: true,
            removed: false,
            uid: 'non-existent'
        });
    });

    test('listAllMemories 同时返回工作区和全局记忆', async () => {
        const { registry } = setup();

        await registry.addMemory('workspace', '工作区记忆', '工作区内容');
        await registry.addMemory('global', '全局记忆', '全局内容');

        const all = await registry.listAllMemories();
        expect(all).toHaveLength(2);
        expect(all.map((item) => item.scope).sort()).toEqual(['global', 'workspace']);
        expect(all.map((item) => item.chunk.title).sort()).toEqual(['全局记忆', '工作区记忆']);
    });

    test('getInstance 按工作区隔离实例，避免切换工作区时串写', async () => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-memory-instance-test-'));
        const workspaceA = path.join(testDir, 'workspace-a');
        const workspaceB = path.join(testDir, 'workspace-b');
        fs.mkdirSync(workspaceA, { recursive: true });
        fs.mkdirSync(workspaceB, { recursive: true });

        const registryA = FactorialMemoryStore.getInstance(workspaceA);
        const registryB = FactorialMemoryStore.getInstance(workspaceB);

        await registryA.addMemory('workspace', 'A 工作区事实', '只应写入 A 工作区。');
        await registryB.addMemory('workspace', 'B 工作区事实', '只应写入 B 工作区。');
        await registryA.addMemory('workspace', 'A 第二条事实', '仍应写入 A 工作区。');

        const titlesA = (await registryA.listMemories('workspace')).map((item) => item.title).sort();
        const titlesB = (await registryB.listMemories('workspace')).map((item) => item.title).sort();

        expect(titlesA).toEqual(['A 工作区事实', 'A 第二条事实']);
        expect(titlesB).toEqual(['B 工作区事实']);
    });

    test('并发 addMemory 不丢失写入', async () => {
        const { registry } = setup();

        await Promise.all(
            Array.from({ length: 10 }, (_, index) =>
                registry.addMemory('workspace', `并发记忆 ${index}`, `并发写入内容 ${index}`)
            )
        );

        const memories = await registry.listMemories('workspace');
        expect(memories).toHaveLength(10);
        expect(new Set(memories.map((item) => item.uid)).size).toBe(10);
    });

    test('并发 getMemory 增热不丢失计数', async () => {
        const { registry } = setup();
        const created = await registry.addMemory('workspace', '高频事实', '该事实会被并发读取。');

        await Promise.all(Array.from({ length: 8 }, () => registry.getMemory(created.uid, { incrementHeat: true })));

        const memory = await registry.getMemory(created.uid);
        expect(memory?.chunk.heat).toBe(8);
    });

    test('记忆工具集包含四个事实记忆工具和 updateUserPortrait', () => {
        const toolset = createMemoryToolset();

        expect(toolset.getTool('addMemory')).toBeDefined();
        expect(toolset.getTool('removeMemory')).toBeDefined();
        expect(toolset.getTool('searchMemory')).toBeDefined();
        expect(toolset.getTool('getMemory')).toBeDefined();
        expect(toolset.getTool('updateUserPortrait')).toBeDefined();
        expect(() =>
            toolset.getTool('addMemory')!.params.parse({
                scope: 'workspace',
                title: '标题',
                content: '内容'
            })
        ).not.toThrow();
        expect(() =>
            toolset.getTool('addMemory')!.params.parse({
                scope: 'workspace',
                content: '内容'
            })
        ).not.toThrow();
    });

    test('maintenance 工具集额外提供 updateMemory，默认工具集不提供', () => {
        expect(createMemoryToolset().getTool('updateMemory')).toBeUndefined();
        const maintenance = createMemoryToolset({ maintenance: true });

        expect(maintenance.getTool('updateMemory')).toBeDefined();
        for (const name of ['addMemory', 'removeMemory', 'searchMemory', 'getMemory', 'updateUserPortrait']) {
            expect(maintenance.getTool(name)).toBeDefined();
        }
    });

    test('addMemory 工具缺省 title 时从 content 派生标题并保存', async () => {
        const { workspaceDir } = setup();
        const tool = createMemoryToolset().getTool('addMemory');

        const result = await tool!.execute(
            {
                scope: 'workspace',
                content: '  项目使用 npm run build 构建。\n需要先安装依赖。  '
            },
            undefined,
            { getWorkspace: () => workspaceDir } as any
        );

        expect(result.status).toBe('success');
        const parsed = JSON.parse(result.result);
        expect(parsed).toMatchObject({
            success: true,
            status: 'created',
            scope: 'workspace'
        });

        const filePath = path.join(workspaceDir, '.opendesk', 'memory', 'memory.json');
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        expect(raw).toHaveLength(1);
        expect(raw[0]).toMatchObject({
            uid: parsed.uid,
            title: '项目使用 npm run build 构建。 需要先安装依赖。',
            content: '项目使用 npm run build 构建。\n需要先安装依赖。',
            heat: 0
        });

        const toolCall = makeToolCall(
            'addMemory',
            {
                scope: 'workspace',
                content: '项目使用 npm run build 构建。'
            },
            parsed
        );
        const cli = tool!.renderToolCallCli(toolCall, 100)?.join('\n') ?? '';
        const html = await tool!.renderToolCall(toolCall);

        expect(cli).toContain('项目使用 npm run build 构建。');
        expect(cli).not.toContain('undefined');
        expect(html).not.toContain('undefined');
    });

    test('addMemory 工具拒绝空 content 且不进入 store trim 分支', async () => {
        const { workspaceDir } = setup();
        const tool = createMemoryToolset().getTool('addMemory');

        const result = await tool!.execute(
            {
                scope: 'workspace',
                content: '   '
            },
            undefined,
            { getWorkspace: () => workspaceDir } as any
        );

        expect(result.status).toBe('error');
        expect(result.result).toContain('content');
        expect(result.result).not.toContain('trim');
        expect(fs.existsSync(path.join(workspaceDir, '.opendesk', 'memory', 'memory.json'))).toBe(false);
    });

    test('updateMemory 工具原地更新并保留 uid、heat 和创建时间', async () => {
        const { registry, workspaceDir } = setup();
        const created = await registry.addMemory('workspace', '旧标题', '旧内容');
        await registry.getMemory(created.uid, { incrementHeat: true });

        const before = (await registry.listMemories('workspace')).find((chunk) => chunk.uid === created.uid)!;
        const tool = createMemoryToolset({ maintenance: true }).getTool('updateMemory');

        const result = await tool!.execute(
            {
                uid: created.uid,
                title: '新标题',
                content: '新内容'
            },
            undefined,
            { getWorkspace: () => workspaceDir } as any
        );

        expect(result.status).toBe('success');
        expect(JSON.parse(result.result)).toMatchObject({
            success: true,
            updated: true,
            uid: created.uid,
            scope: 'workspace'
        });

        const after = (await registry.listMemories('workspace')).find((chunk) => chunk.uid === created.uid)!;
        expect(after.uid).toBe(before.uid);
        expect(after.heat).toBe(before.heat);
        expect(after.createdAt).toBe(before.createdAt);
        expect(after.title).toBe('新标题');
        expect(after.content).toBe('新内容');
    });

    test('updateMemory 工具更新不存在的 uid 返回 updated:false', async () => {
        const { workspaceDir } = setup();
        const tool = createMemoryToolset({ maintenance: true }).getTool('updateMemory');

        const result = await tool!.execute(
            {
                uid: 'deadbeef0000ffff',
                title: '新标题',
                content: '新内容'
            },
            undefined,
            { getWorkspace: () => workspaceDir } as any
        );

        expect(result.status).toBe('success');
        expect(JSON.parse(result.result)).toMatchObject({
            success: true,
            updated: false,
            uid: 'deadbeef0000ffff'
        });
    });

    test('记忆工具均提供 GUI 和 TUI 卡片渲染', async () => {
        const toolset = createMemoryToolset({ maintenance: true });
        const samples: Array<[string, object, unknown, string]> = [
            [
                'addMemory',
                {
                    scope: 'workspace',
                    title: '项目命令 <script>',
                    content: '项目使用 npm run build 构建。'
                },
                { success: true, uid: 'abc123' },
                '项目命令'
            ],
            ['removeMemory', { uid: 'abc123' }, { removed: true }, 'abc123'],
            [
                'updateMemory',
                { uid: 'abc123', title: '项目命令 v2', content: '项目使用 pnpm 构建。' },
                { success: true, updated: true, uid: 'abc123', scope: 'workspace' },
                '项目命令 v2'
            ],
            ['searchMemory', { keyword: '构建' }, [{ uid: 'abc123', title: '项目命令 <script>' }], 'abc123'],
            [
                'getMemory',
                { uid: 'abc123' },
                {
                    found: true,
                    uid: 'abc123',
                    scope: 'workspace',
                    title: '项目命令',
                    content: '项目使用 npm run build 构建。',
                    heat: 1
                },
                '项目使用 npm run build 构建。'
            ],
            [
                'updateUserPortrait',
                { content: '# 用户画像\n\n- 偏好简洁输出。' },
                { success: true, path: '/tmp/memory/user.md' },
                '偏好简洁输出'
            ]
        ];

        for (const [toolName, args, result, expectedText] of samples) {
            const tool = toolset.getTool(toolName);
            expect(tool).toBeDefined();
            const toolCall = makeToolCall(toolName, args, result);
            const cli = tool!.renderToolCallCli(toolCall, 100)?.join('\n') ?? '';
            const html = await tool!.renderToolCall(toolCall);

            expect(cli).toContain(expectedText);
            expect(html).toContain('od-inline-toolcall-container');
            expect(html).toContain('memory-tool-card');
            expect(html).not.toContain('<script>');
        }
    });

    test('关键事实回顾 prompt 限定 scope 和用户画像边界', () => {
        const systemPrompt = buildFactorialMemoryReviewSystemPrompt(
            '/workspace/.opendesk/memory/memory.json',
            '/home/.opendesk/memory/memory.json'
        );
        const memoryIndex = formatMemoryIndexForReview([
            {
                scope: 'workspace',
                chunk: {
                    uid: 'abc123',
                    title: '项目构建命令',
                    content: '项目使用 npm run build 构建。',
                    heat: 2,
                    createdAt: '2026-08-01T00:00:00.000Z',
                    updatedAt: '2026-08-01T00:00:00.000Z'
                }
            }
        ]);
        const prompt = buildFactorialMemoryReviewPrompt(memoryIndex, '用户: 项目使用 npm run build 构建。');

        expect(systemPrompt).toContain('workspace: 当前工作空间相关事实');
        expect(systemPrompt).toContain('global: 与当前工作空间无关');
        expect(systemPrompt).toContain('用户身份、沟通偏好、长期协作偏好属于用户画像 user.md');
        expect(systemPrompt).toContain('个人偏好、身份背景、沟通习惯、长期协作要求，属于用户画像');
        expect(systemPrompt).toContain('同一句话同时包含用户偏好和项目事实时，只保存项目事实');
        expect(systemPrompt).toContain('先 removeMemory 删除旧 uid，再 addMemory');
        expect(prompt).toContain('先判断每条候选信息属于用户画像、workspace 关键事实、global 关键事实');
        expect(prompt).toContain('abc123');
        expect(prompt).toContain('不可信资料');
    });
});
