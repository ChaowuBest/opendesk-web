/**
 * Memory system unit tests
 * Note: LLM-powered methods (smartSearch, smartAdd, smartForget) require a configured
 * LLM backend and are tested in integration tests, not here.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { MemoryRegistry } from '../../../main/aikernel/memory/registry.js';

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

function assert(condition: boolean, message: string) {
    if (!condition) {
        throw new Error(`ASSERTION FAILED: ${message}`);
    }
}

function assertEqual<T>(actual: T, expected: T, message: string) {
    if (actual !== expected) {
        throw new Error(`ASSERTION FAILED: ${message}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
    }
}

async function testPutAndGetMemory() {
    console.log('  测试: 写入和读取记忆...');
    const { registry } = setup();

    try {
        const meta = registry.putMemory('workspace', {
            uid: 'test-mem-1',
            name: '项目架构决策',
            keywords: ['架构', 'React', '前端'],
            summary: '选择了 React + TypeScript 作为前端技术栈',
            category: 'key_decision',
            source_task_id: 'task-123',
        }, '# 架构决策\n\n我们选择了 React + TypeScript 作为前端技术栈，主要原因是...');

        assertEqual(meta.uid, 'test-mem-1', 'uid should match');
        assertEqual(meta.name, '项目架构决策', 'name should match');
        assert(meta.created_at !== '', 'should have created_at');

        const loaded = registry.getMemory('test-mem-1');
        assert(loaded !== undefined, 'memory should be loadable');
        assertEqual(loaded!.meta.name, '项目架构决策', 'loaded name should match');
        assertEqual(loaded!.scope, 'workspace', 'scope should be workspace');
        assert(loaded!.content.includes('React + TypeScript'), 'content should match');

        registry.putMemory('global', {
            uid: 'test-mem-2',
            name: '用户偏好: 代码风格',
            keywords: ['代码风格', 'ESLint', 'Prettier'],
            summary: '偏好使用 4 空格缩进和分号',
            category: 'user_preference',
        }, '# 代码风格偏好\n\n- 缩进: 4 空格\n- 分号: 必须');

        const loadedGlobal = registry.getMemory('test-mem-2');
        assert(loadedGlobal !== undefined, 'global memory should be loadable');
        assertEqual(loadedGlobal!.scope, 'global', 'scope should be global');

        console.log('  ✅ 写入和读取记忆 通过');
    } finally {
        cleanup();
    }
}

async function testKeywordSearch() {
    console.log('  测试: 关键词搜索...');
    const { registry } = setup();

    try {
        registry.putMemory('workspace', {
            uid: 'search-1',
            name: 'TypeScript 配置',
            keywords: ['TypeScript', 'tsconfig', '编译'],
            summary: '项目使用 strict 模式的 TypeScript',
            category: 'important_fact',
        }, 'TypeScript strict 模式配置详情...');

        registry.putMemory('workspace', {
            uid: 'search-2',
            name: 'Docker 部署方案',
            keywords: ['Docker', '部署', 'CI/CD'],
            summary: '使用 Docker Compose 进行本地开发和部署',
            category: 'key_decision',
        }, 'Docker 部署方案详情...');

        registry.putMemory('global', {
            uid: 'search-3',
            name: '个人日程',
            keywords: ['日程', '会议'],
            summary: '每周一下午有 standup 会议',
            category: 'useful_context',
        }, '每周一下午 3 点 standup 会议');

        const tsResults = registry.keywordSearch('TypeScript');
        assert(tsResults.length >= 1, 'should find TypeScript memory');
        assertEqual(tsResults[0].meta.uid, 'search-1', 'first result should be TypeScript config');

        const dockerResults = registry.keywordSearch('Docker 部署');
        assert(dockerResults.length >= 1, 'should find Docker memory');
        assertEqual(dockerResults[0].meta.uid, 'search-2', 'first result should be Docker');

        const meetingResults = registry.keywordSearch('会议');
        assert(meetingResults.length >= 1, 'should find meeting memory');

        const noResults = registry.keywordSearch('量子计算');
        assertEqual(noResults.length, 0, 'should find no results');

        console.log('  ✅ 关键词搜索 通过');
    } finally {
        cleanup();
    }
}

async function testUpdateMemory() {
    console.log('  测试: 更新记忆...');
    const { registry } = setup();

    try {
        const original = registry.putMemory('workspace', {
            uid: 'update-1',
            name: '初始记忆',
            keywords: ['测试'],
            summary: '这是初始版本',
            category: 'useful_context',
        }, '初始内容');

        const originalCreatedAt = original.created_at;
        await new Promise(resolve => setTimeout(resolve, 10));

        const updated = registry.putMemory('workspace', {
            uid: 'update-1',
            name: '更新后的记忆',
            keywords: ['测试', '更新'],
            summary: '这是更新版本',
            category: 'useful_context',
        }, '更新后的内容');

        assertEqual(updated.name, '更新后的记忆', 'name should be updated');
        assertEqual(updated.created_at, originalCreatedAt, 'created_at should be preserved');
        assert(updated.updated_at >= original.updated_at, 'updated_at should be newer');

        const loaded = registry.getMemory('update-1');
        assert(loaded !== undefined, 'updated memory should be loadable');
        assert(loaded!.content.includes('更新后的内容'), 'content should be updated');

        const list = registry.listMemories('workspace');
        assertEqual(list.length, 1, 'should have exactly one memory');

        console.log('  ✅ 更新记忆 通过');
    } finally {
        cleanup();
    }
}

async function testDeleteMemory() {
    console.log('  测试: 删除记忆...');
    const { registry } = setup();

    try {
        registry.putMemory('workspace', {
            uid: 'del-1',
            name: '要删除的记忆',
            keywords: ['删除'],
            summary: '这条记忆将被删除',
            category: 'useful_context',
        }, '将被删除的内容');

        assert(registry.getMemory('del-1') !== undefined, 'should exist before delete');

        const deleted = registry.deleteMemory('del-1');
        assert(deleted, 'should return true on successful delete');
        assert(registry.getMemory('del-1') === undefined, 'should not exist after delete');

        const deleted2 = registry.deleteMemory('non-existent');
        assert(!deleted2, 'should return false for non-existent memory');

        console.log('  ✅ 删除记忆 通过');
    } finally {
        cleanup();
    }
}

async function testListAllMemories() {
    console.log('  测试: 列出所有记忆...');
    const { registry } = setup();

    try {
        registry.putMemory('workspace', {
            uid: 'list-1',
            name: '工作区记忆',
            keywords: ['工作区'],
            summary: '这是工作区记忆',
            category: 'important_fact',
        }, '工作区内容');

        registry.putMemory('global', {
            uid: 'list-2',
            name: '全局记忆',
            keywords: ['全局'],
            summary: '这是全局记忆',
            category: 'user_preference',
        }, '全局内容');

        const all = registry.listAllMemories();
        assertEqual(all.length, 2, 'should list both workspace and global');

        const workspaceOnes = all.filter(m => m.scope === 'workspace');
        const globalOnes = all.filter(m => m.scope === 'global');
        assertEqual(workspaceOnes.length, 1, 'should have 1 workspace memory');
        assertEqual(globalOnes.length, 1, 'should have 1 global memory');

        console.log('  ✅ 列出所有记忆 通过');
    } finally {
        cleanup();
    }
}

async function testFormatMemoriesForContext() {
    console.log('  测试: 格式化记忆上下文...');
    const { registry } = setup();

    try {
        registry.putMemory('workspace', {
            uid: 'fmt-1',
            name: '项目配置',
            keywords: ['配置'],
            summary: '重要的项目配置',
            category: 'important_fact',
        }, '项目使用 ESBuild 构建');

        const all = registry.listAllMemories();
        const formatted = registry.formatMemoriesForContext(all);

        assert(formatted.includes('项目配置'), 'should contain memory name');
        assert(formatted.includes('工作区'), 'should contain scope label');
        assert(formatted.includes('ESBuild'), 'should contain memory content');

        const emptyFormatted = registry.formatMemoriesForContext([]);
        assert(emptyFormatted.includes('未找到'), 'should indicate no memories found');

        console.log('  ✅ 格式化记忆上下文 通过');
    } finally {
        cleanup();
    }
}

async function testFileSystemPersistence() {
    console.log('  测试: 文件系统持久化...');
    const { registry } = setup();

    try {
        registry.putMemory('workspace', {
            uid: 'persist-1',
            name: '持久化测试',
            keywords: ['持久化'],
            summary: '测试文件系统持久化',
            category: 'useful_context',
        }, '这是持久化测试的内容');

        const globalDir = path.join(testDir, 'global-app');
        const workspaceDir = path.join(testDir, 'workspace');
        const registry2 = MemoryRegistry.createForTest(workspaceDir, globalDir);

        const loaded = registry2.getMemory('persist-1');
        assert(loaded !== undefined, 'should persist and be loadable from new instance');
        assertEqual(loaded!.meta.name, '持久化测试', 'name should persist');
        assert(loaded!.content.includes('持久化测试的内容'), 'content should persist');

        const indexPath = path.join(workspaceDir, '.opendesk', 'memory', 'index.json');
        assert(fs.existsSync(indexPath), 'index.json should exist');

        const contentPath = path.join(workspaceDir, '.opendesk', 'memory', 'persist-1.md');
        assert(fs.existsSync(contentPath), 'content file should exist');

        console.log('  ✅ 文件系统持久化 通过');
    } finally {
        cleanup();
    }
}

export async function runMemoryTests(): Promise<boolean> {
    console.log('\n🧠 记忆系统测试\n');
    let allPassed = true;
    const tests = [
        testPutAndGetMemory,
        testKeywordSearch,
        testUpdateMemory,
        testDeleteMemory,
        testListAllMemories,
        testFormatMemoriesForContext,
        testFileSystemPersistence,
    ];

    for (const test of tests) {
        try {
            await test();
        } catch (err: any) {
            console.log(`  ❌ ${err.message}`);
            allPassed = false;
        }
    }

    console.log(allPassed ? '\n✅ 所有记忆系统测试通过' : '\n❌ 部分记忆系统测试失败');
    console.log(chalk.dim('\n  注: LLM-powered 方法 (smartSearch, smartAdd, smartForget) 需要配置 LLM 后端，在集成测试中验证'));
    return allPassed;
}

import chalk from 'chalk';
