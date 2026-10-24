import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import type { ModeDecl } from '../../../../main/aikernel/agents/common.js';
import { TaskManagerState } from '../../../../main/aikernel/task/manager.js';
import { registerImportCommand } from '../../../../main/tui/commands/import.js';
import { expandPath } from '../../../../main/tui/components/file-completions.js';
import { setCustomOpendeskDirectory } from '../../../../main/utils/setting.js';

let tempDirectory: string | undefined;

afterEach(() => {
    if (tempDirectory) {
        fs.rmSync(tempDirectory, { recursive: true, force: true });
        tempDirectory = undefined;
    }
    setCustomOpendeskDirectory(undefined);
});

async function setupImportCommand(): Promise<{
    manager: TaskManagerState;
    importCommand: { execute: (args: string) => Promise<void> };
    switchToTask: any;
    taskPath: string;
}> {
    tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-import-task-'));
    setCustomOpendeskDirectory(tempDirectory);
    const taskPath = path.join(tempDirectory, 'task.json');
    fs.writeFileSync(
        taskPath,
        JSON.stringify({
            task_id: 'exported-task',
            task_name: 'Exported task',
            task_status: 'waiting',
            agentId: null,
            custom_system_prompt: 'custom prompt',
            chat_context: {
                system_prompt: { role: 'system', content: 'custom prompt' },
                messages: []
            },
            workspace: '/workspace/imported',
            created_at: new Date().toISOString()
        })
    );

    const mode: ModeDecl = {
        id: 'test',
        name: 'Test',
        description: 'Test mode',
        icon: '',
        color: '',
        permissionFactory: () => []
    };
    const manager = new TaskManagerState();
    await manager.setupLazyHarnessInit(mode, '/workspace/default', () => ({
        prompt: async () => ({ decision: 'deny', rememberScope: 'none' })
    }));
    jest.spyOn(manager, 'save').mockImplementation(() => undefined);
    jest.spyOn(manager, 'publishTaskListUpdate').mockImplementation(() => undefined);

    let importCommand: { execute: (args: string) => Promise<void> } | undefined;
    const switchToTask = jest.fn(async () => undefined);
    registerImportCommand({
        workspace: '/workspace/default',
        taskManagerState: manager,
        switchToTask,
        commandRegistry: {
            register: (command: { name: string; execute: (args: string) => Promise<void> }) => {
                if (command.name === 'import') importCommand = command;
            }
        }
    } as any);

    if (!importCommand) {
        throw new Error('import command not registered');
    }
    return { manager, importCommand, switchToTask, taskPath };
}

describe('/import task path expansion', () => {
    test('expandPath should expand ~/ prefix', () => {
        const input = '~/Projects/task.json';
        const output = expandPath(input).replace(/\\/g, '/');
        const expected = `${os.homedir().replace(/\\/g, '/')}/Projects/task.json`;

        expect(output).toBe(expected);
    });

    test('expandPath should expand ~\\ prefix', () => {
        const input = '~\\Projects\\task.json';
        const output = expandPath(input).replace(/\\/g, '/');
        const expected = `${os.homedir().replace(/\\/g, '/')}/Projects/task.json`;

        expect(output).toBe(expected);
    });

    test('resolved import path should not contain literal "~" segment', () => {
        const resolved = path.resolve(expandPath('~/Projects/task.json')).replace(/\\/g, '/');

        expect(resolved.includes('/~/')).toBe(false);
        expect(resolved.endsWith('/Projects/task.json')).toBe(true);
    });
});

describe('/import task lifecycle', () => {
    test('initializes the imported task harness only when switching to it', async () => {
        const { manager, importCommand, switchToTask, taskPath } = await setupImportCommand();
        await importCommand.execute(`task ${taskPath}`);

        expect(switchToTask).toHaveBeenCalledTimes(1);
        const importedTask = switchToTask.mock.calls[0][0];
        expect(importedTask.harnessContext.workspace).toBe('/workspace/imported');
        expect(importedTask.harnessContext.permission).toBeDefined();
        expect(importedTask.chat_context.system_prompt?.content).toBe('custom prompt');
        manager.disposeLazyHarnessInit();
    });
});

describe('/import task quoted path (issue #209: drag & drop wraps path in quotes)', () => {
    test('imports a task whose path is wrapped in double quotes', async () => {
        const { manager, importCommand, switchToTask, taskPath } = await setupImportCommand();
        await importCommand.execute(`task "${taskPath}"`);

        expect(switchToTask).toHaveBeenCalledTimes(1);
        const importedTask = switchToTask.mock.calls[0][0];
        expect(importedTask.task_id).toBeDefined();
        expect(importedTask.harnessContext.workspace).toBe('/workspace/imported');
        manager.disposeLazyHarnessInit();
    });

    test('imports a task whose path is wrapped in single quotes', async () => {
        const { manager, importCommand, switchToTask, taskPath } = await setupImportCommand();
        await importCommand.execute(`task '${taskPath}'`);

        expect(switchToTask).toHaveBeenCalledTimes(1);
        expect(switchToTask.mock.calls[0][0].task_id).toBeDefined();
        manager.disposeLazyHarnessInit();
    });
});
