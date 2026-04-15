/**
 * Memory system unit tests
 * Note: LLM-powered methods (smartSearch, smartAdd, smartForget) require a configured
 * LLM backend and are tested in integration tests, not here.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { MemoryRegistry } from '../../../main/aikernel/memory/registry';

let testDir: string;

function setup(): { registry: MemoryRegistry } {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-memory-test-'));
    const globalDir = path.join(testDir, 'global-app');
    const workspaceDir = path.join(testDir, 'workspace');
    fs.mkdirSync(globalDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });

    const registry = MemoryRegistry.createForTest(workspaceDir, globalDir);
    return { registry };
}

function cleanup() {
    if (testDir && fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
    }
}

afterEach(() => {
    cleanup();
});

describe('记忆系统', () => {
    test('写入和读取记忆', () => {
        const { registry } = setup();

        const meta = registry.putMemory(
            'workspace',
            {
                uid: 'test-mem-1',
                name: '项目架构决策',
                keywords: ['架构', 'React', '前端'],
                summary: '选择了 React + TypeScript 作为前端技术栈',
                category: 'key_decision',
                source_task_id: 'task-123'
            },
            '# 架构决策\n\n我们选择了 React + TypeScript 作为前端技术栈，主要原因是...'
        );

        expect(meta.uid).toBe('test-mem-1');
        expect(meta.name).toBe('项目架构决策');
        expect(meta.created_at).not.toBe('');

        const loaded = registry.getMemory('test-mem-1');
        expect(loaded).toBeDefined();
        expect(loaded!.meta.name).toBe('项目架构决策');
        expect(loaded!.scope).toBe('workspace');
        expect(loaded!.content).toContain('React + TypeScript');

        registry.putMemory(
            'global',
            {
                uid: 'test-mem-2',
                name: '用户偏好: 代码风格',
                keywords: ['代码风格', 'ESLint', 'Prettier'],
                summary: '偏好使用 4 空格缩进和分号',
                category: 'user_preference'
            },
            '# 代码风格偏好\n\n- 缩进: 4 空格\n- 分号: 必须'
        );

        const loadedGlobal = registry.getMemory('test-mem-2');
        expect(loadedGlobal).toBeDefined();
        expect(loadedGlobal!.scope).toBe('global');
    });

    test('关键词搜索', () => {
        const { registry } = setup();

        registry.putMemory(
            'workspace',
            {
                uid: 'search-1',
                name: 'TypeScript 配置',
                keywords: ['TypeScript', 'tsconfig', '编译'],
                summary: '项目使用 strict 模式的 TypeScript',
                category: 'important_fact'
            },
            'TypeScript strict 模式配置详情...'
        );

        registry.putMemory(
            'workspace',
            {
                uid: 'search-2',
                name: 'Docker 部署方案',
                keywords: ['Docker', '部署', 'CI/CD'],
                summary: '使用 Docker Compose 进行本地开发和部署',
                category: 'key_decision'
            },
            'Docker 部署方案详情...'
        );

        registry.putMemory(
            'global',
            {
                uid: 'search-3',
                name: '个人日程',
                keywords: ['日程', '会议'],
                summary: '每周一下午有 standup 会议',
                category: 'useful_context'
            },
            '每周一下午 3 点 standup 会议'
        );

        const tsResults = registry.keywordSearch('TypeScript');
        expect(tsResults.length).toBeGreaterThanOrEqual(1);
        expect(tsResults[0].meta.uid).toBe('search-1');

        const dockerResults = registry.keywordSearch('Docker 部署');
        expect(dockerResults.length).toBeGreaterThanOrEqual(1);
        expect(dockerResults[0].meta.uid).toBe('search-2');

        const meetingResults = registry.keywordSearch('会议');
        expect(meetingResults.length).toBeGreaterThanOrEqual(1);

        const noResults = registry.keywordSearch('量子计算');
        expect(noResults.length).toBe(0);
    });

    test('更新记忆', async () => {
        const { registry } = setup();

        const original = registry.putMemory(
            'workspace',
            {
                uid: 'update-1',
                name: '初始记忆',
                keywords: ['测试'],
                summary: '这是初始版本',
                category: 'useful_context'
            },
            '初始内容'
        );

        const originalCreatedAt = original.created_at;
        await new Promise((resolve) => setTimeout(resolve, 10));

        const updated = registry.putMemory(
            'workspace',
            {
                uid: 'update-1',
                name: '更新后的记忆',
                keywords: ['测试', '更新'],
                summary: '这是更新版本',
                category: 'useful_context'
            },
            '更新后的内容'
        );

        expect(updated.name).toBe('更新后的记忆');
        expect(updated.created_at).toBe(originalCreatedAt);
        expect(String(updated.updated_at) >= String(original.updated_at)).toBe(true);

        const loaded = registry.getMemory('update-1');
        expect(loaded).toBeDefined();
        expect(loaded!.content).toContain('更新后的内容');

        const list = registry.listMemories('workspace');
        expect(list.length).toBe(1);
    });

    test('删除记忆', () => {
        const { registry } = setup();

        registry.putMemory(
            'workspace',
            {
                uid: 'del-1',
                name: '要删除的记忆',
                keywords: ['删除'],
                summary: '这条记忆将被删除',
                category: 'useful_context'
            },
            '将被删除的内容'
        );

        expect(registry.getMemory('del-1')).toBeDefined();

        const deleted = registry.deleteMemory('del-1');
        expect(deleted).toBe(true);
        expect(registry.getMemory('del-1')).toBeUndefined();

        const deleted2 = registry.deleteMemory('non-existent');
        expect(deleted2).toBe(false);
    });

    test('列出所有记忆', () => {
        const { registry } = setup();

        registry.putMemory(
            'workspace',
            {
                uid: 'list-1',
                name: '工作区记忆',
                keywords: ['工作区'],
                summary: '这是工作区记忆',
                category: 'important_fact'
            },
            '工作区内容'
        );

        registry.putMemory(
            'global',
            {
                uid: 'list-2',
                name: '全局记忆',
                keywords: ['全局'],
                summary: '这是全局记忆',
                category: 'user_preference'
            },
            '全局内容'
        );

        const all = registry.listAllMemories();
        expect(all.length).toBe(2);

        const workspaceOnes = all.filter((m) => m.scope === 'workspace');
        const globalOnes = all.filter((m) => m.scope === 'global');
        expect(workspaceOnes.length).toBe(1);
        expect(globalOnes.length).toBe(1);
    });

    test('格式化记忆上下文', () => {
        const { registry } = setup();

        registry.putMemory(
            'workspace',
            {
                uid: 'fmt-1',
                name: '项目配置',
                keywords: ['配置'],
                summary: '重要的项目配置',
                category: 'important_fact'
            },
            '项目使用 ESBuild 构建'
        );

        const all = registry.listAllMemories();
        const formatted = registry.formatMemoriesForContext(all);

        expect(formatted).toContain('项目配置');
        expect(formatted).toContain('工作区');
        expect(formatted).toContain('ESBuild');

        const emptyFormatted = registry.formatMemoriesForContext([]);
        expect(emptyFormatted).toContain('未找到');
    });

    test('文件系统持久化', () => {
        const { registry } = setup();

        registry.putMemory(
            'workspace',
            {
                uid: 'persist-1',
                name: '持久化测试',
                keywords: ['持久化'],
                summary: '测试文件系统持久化',
                category: 'useful_context'
            },
            '这是持久化测试的内容'
        );

        const globalDir = path.join(testDir, 'global-app');
        const workspaceDir = path.join(testDir, 'workspace');
        const registry2 = MemoryRegistry.createForTest(workspaceDir, globalDir);

        const loaded = registry2.getMemory('persist-1');
        expect(loaded).toBeDefined();
        expect(loaded!.meta.name).toBe('持久化测试');
        expect(loaded!.content).toContain('持久化测试的内容');

        const indexPath = path.join(workspaceDir, '.opendesk', 'memory', 'index.json');
        expect(fs.existsSync(indexPath)).toBe(true);

        const contentPath = path.join(workspaceDir, '.opendesk', 'memory', 'persist-1.md');
        expect(fs.existsSync(contentPath)).toBe(true);
    });
});
