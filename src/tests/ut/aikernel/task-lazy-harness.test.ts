import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import type { ModeDecl } from '../../../main/aikernel/agents/common.js';
import { ReadableDirectoryRegistry } from '../../../main/aikernel/security/enforcer.js';
import { HarnessContext } from '../../../main/aikernel/security/harness.js';
import type { PermissionPromptProvider } from '../../../main/aikernel/security/permission.js';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks.js';
import { applyPersistentPermissionAllowForTask } from '../../../main/aikernel/task/permission.js';
import { getTaskArtifactDirectory, setCustomOpendeskDirectory } from '../../../main/utils/setting.js';

let tempRootDir: string | undefined;
let managers: TaskManagerState[] = [];

const mode: ModeDecl = {
    id: 'test',
    name: 'Test',
    description: 'Test mode',
    icon: '',
    color: '',
    permissionFactory: (workspace) => [
        {
            resourceType: 'file',
            action: 'read',
            pathPattern: `${workspace}{,/**}`,
            effect: 'allow'
        },
        {
            resourceType: 'file',
            action: 'write',
            pathPattern: `${workspace}{,/**}`,
            effect: 'allow'
        }
    ]
};

const promptProvider: PermissionPromptProvider = {
    prompt: async () => ({ decision: 'deny', rememberScope: 'none' })
};

function createTask(manager: TaskManagerState, taskId: string, workspace: string): TaskState {
    const task = new TaskState(manager);
    task.task_id = taskId;
    task.workspace = workspace;
    manager.tasks.push(task);
    return task;
}

function createManager(): TaskManagerState {
    const manager = new TaskManagerState();
    managers.push(manager);
    return manager;
}

describe('lazy task harness initialization', () => {
    afterEach(() => {
        for (const manager of managers) {
            manager.disposeLazyHarnessInit();
        }
        managers = [];
        if (tempRootDir && fs.existsSync(tempRootDir)) {
            fs.rmSync(tempRootDir, { recursive: true, force: true });
        }
        tempRootDir = undefined;
        setCustomOpendeskDirectory(undefined);
    });

    test('shares compiled workspace rules while keeping persistent task grants isolated', async () => {
        tempRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-lazy-harness-'));
        setCustomOpendeskDirectory(tempRootDir);

        const manager = createManager();
        const firstTask = createTask(manager, 'task-first', '/workspace/shared');
        const secondTask = createTask(manager, 'task-second', '/workspace/shared');
        const permissionFactory = jest.fn(mode.permissionFactory);
        await manager.setupLazyHarnessInit({ ...mode, permissionFactory }, '/workspace/shared', () => promptProvider);

        manager.getTask(firstTask.task_id);
        manager.getTask(secondTask.task_id);

        expect(permissionFactory).toHaveBeenCalledTimes(1);
        expect(permissionFactory).toHaveBeenCalledWith('/workspace/shared');

        await applyPersistentPermissionAllowForTask(firstTask, {
            resourceType: 'network',
            action: 'read',
            pathPattern: 'https://api.example.com/**',
            effect: 'allow'
        });
        expect(
            (
                await firstTask.harnessContext.permission!.check({
                    resourceType: 'network',
                    action: 'read',
                    resourcePath: 'https://api.example.com/v1'
                })
            ).effect
        ).toBe('allow');
        expect(
            (
                await secondTask.harnessContext.permission!.check({
                    resourceType: 'network',
                    action: 'read',
                    resourcePath: 'https://api.example.com/v1'
                })
            ).effect
        ).toBe('ask');
        expect(firstTask.harnessContext.permission).not.toBe(secondTask.harnessContext.permission);
    });

    test('keeps each restored task artifact directory isolated', async () => {
        tempRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-lazy-harness-'));
        setCustomOpendeskDirectory(tempRootDir);

        const manager = createManager();
        const firstTask = createTask(manager, 'task-first-artifact', '/workspace/shared');
        const secondTask = createTask(manager, 'task-second-artifact', '/workspace/shared');
        await manager.setupLazyHarnessInit(mode, '/workspace/shared', () => promptProvider);
        manager.getTask(firstTask.task_id);
        manager.getTask(secondTask.task_id);

        // 旧 fire-and-forget 实现需要一个 microtask 才会加入 write 规则；
        // 等待后再检查，确保本用例只验证跨任务隔离，而不是时序。
        await Promise.resolve();

        const firstArtifactFile = path.join(getTaskArtifactDirectory(firstTask.task_id, false), 'memory.md');
        expect(
            (
                await firstTask.harnessContext.permission!.check({
                    resourceType: 'file',
                    action: 'write',
                    resourcePath: firstArtifactFile
                })
            ).effect
        ).toBe('allow');
        expect(
            (
                await secondTask.harnessContext.permission!.check({
                    resourceType: 'file',
                    action: 'write',
                    resourcePath: firstArtifactFile
                })
            ).effect
        ).toBe('ask');
    });

    test('makes artifact write permission available immediately after the first getTask', async () => {
        tempRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-lazy-harness-'));
        setCustomOpendeskDirectory(tempRootDir);

        const manager = createManager();
        const task = createTask(manager, 'task-immediate-artifact', '/workspace/shared');
        await manager.setupLazyHarnessInit(mode, '/workspace/shared', () => promptProvider);
        manager.getTask(task.task_id);

        const artifactFile = path.join(getTaskArtifactDirectory(task.task_id, false), 'memory.md');
        const result = await task.harnessContext.permission!.check({
            resourceType: 'file',
            action: 'write',
            resourcePath: artifactFile
        });
        expect(result.effect).toBe('allow');
    });

    test('creates the correct base rules for a workspace added after setup', async () => {
        tempRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-lazy-harness-'));
        setCustomOpendeskDirectory(tempRootDir);

        const manager = createManager();
        const permissionFactory = jest.fn(mode.permissionFactory);
        await manager.setupLazyHarnessInit({ ...mode, permissionFactory }, '/workspace/default', () => promptProvider);
        const importedTask = createTask(manager, 'task-imported', '/workspace/imported');

        manager.getTask(importedTask.task_id);

        expect(permissionFactory).toHaveBeenCalledTimes(2);
        expect(permissionFactory).toHaveBeenNthCalledWith(1, '/workspace/default');
        expect(permissionFactory).toHaveBeenNthCalledWith(2, '/workspace/imported');
        expect(importedTask.harnessContext.workspace).toBe('/workspace/imported');
        expect(
            (
                await importedTask.harnessContext.permission!.check({
                    resourceType: 'file',
                    action: 'write',
                    resourcePath: '/workspace/imported/new-file.txt'
                })
            ).effect
        ).toBe('allow');
        expect(
            (
                await importedTask.harnessContext.permission!.check({
                    resourceType: 'file',
                    action: 'write',
                    resourcePath: '/workspace/default/new-file.txt'
                })
            ).effect
        ).toBe('ask');
    });

    test('keeps readable-directory propagation working for tasks initialized before repeated setup', async () => {
        tempRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-lazy-harness-'));
        setCustomOpendeskDirectory(tempRootDir);

        const manager = createManager();
        const firstTask = createTask(manager, 'task-before-resetup', '/workspace/shared');
        await manager.setupLazyHarnessInit(mode, '/workspace/shared', () => promptProvider);
        manager.getTask(firstTask.task_id);

        await manager.setupLazyHarnessInit(mode, '/workspace/shared', () => promptProvider);
        const secondTask = createTask(manager, 'task-after-resetup', '/workspace/shared');
        manager.getTask(secondTask.task_id);

        const readableDirectory = path.join(tempRootDir, 'late-readable');
        const registry = ReadableDirectoryRegistry.getInstance();
        registry.register(readableDirectory);
        try {
            for (const task of [firstTask, secondTask]) {
                expect(
                    (
                        await task.harnessContext.permission!.check({
                            resourceType: 'file',
                            action: 'read',
                            resourcePath: path.join(readableDirectory, 'skill.md')
                        })
                    ).effect
                ).toBe('allow');
            }
        } finally {
            registry.unregister(readableDirectory);
        }
    });

    test('releases retired lazy base enforcers after tasks stop inheriting from them', async () => {
        tempRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-lazy-harness-'));
        setCustomOpendeskDirectory(tempRootDir);

        const manager = createManager();
        const task = createTask(manager, 'task-retired-base', '/workspace/shared');
        await manager.setupLazyHarnessInit(mode, '/workspace/shared', () => promptProvider);
        manager.getTask(task.task_id);

        const managerInternals = manager as unknown as {
            _sharedHarnessBaseEnforcers: Set<unknown>;
            pruneLazyHarnessBaseEnforcers?: () => void;
        };
        expect(managerInternals._sharedHarnessBaseEnforcers.size).toBe(1);

        const nextMode = { ...mode, id: 'next-mode', name: 'Next mode' };
        manager.updateLazyHarnessMode(nextMode);
        expect(managerInternals._sharedHarnessBaseEnforcers.size).toBe(1);

        task.harnessContext = await HarnessContext.createForMode('/workspace/shared', nextMode);
        managerInternals.pruneLazyHarnessBaseEnforcers?.();

        expect(managerInternals._sharedHarnessBaseEnforcers.size).toBe(0);
    });

    test('refreshes a lazy task system prompt with the mode used to initialize its harness', async () => {
        const manager = createManager();
        const task = createTask(manager, 'task-lazy-prompt', '/workspace/shared');
        task.setSystemPrompt('system:old-mode');
        const createSystemPrompt = jest.fn(async (activeMode: ModeDecl) => `system:${activeMode.id}`);
        await manager.setupLazyHarnessInit(mode, '/workspace/shared', () => promptProvider, createSystemPrompt);

        manager.getTask(task.task_id);
        expect(task.chat_context.system_prompt?.content).toBe('system:old-mode');

        const refreshLazyTaskSystemPrompt = (
            manager as unknown as {
                refreshLazyTaskSystemPrompt?: (taskState: TaskState) => Promise<boolean>;
            }
        ).refreshLazyTaskSystemPrompt;

        expect(refreshLazyTaskSystemPrompt).toBeDefined();
        await expect(refreshLazyTaskSystemPrompt!.call(manager, task)).resolves.toBe(true);
        expect(createSystemPrompt).toHaveBeenCalledWith(mode, task);
        expect(task.chat_context.system_prompt?.content).toBe('system:test');
    });
});
