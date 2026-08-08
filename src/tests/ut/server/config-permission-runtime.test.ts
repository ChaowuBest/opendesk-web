import { jest } from '@jest/globals';
import type {
    PermissionCheckResult,
    PermissionEnforcer,
    PermissionRequest,
    PermissionRule
} from '../../../main/aikernel/security/permission.js';
import { ConfigPermissionRuntime } from '../../../main/server/opencode/config-permission-runtime.js';
import { handleToolPermissionsForTask } from '../../../main/aikernel/task/permission.js';
import { replaceTaskHarnessForMode } from '../../../main/aikernel/task/mode.js';

class FallbackPermissionEnforcer implements PermissionEnforcer {
    constructor(private readonly effect: PermissionCheckResult['effect']) {}

    async check(request: PermissionRequest): Promise<PermissionCheckResult> {
        return { effect: this.effect, request };
    }

    async checkAll(requests: PermissionRequest[]): Promise<PermissionCheckResult | null> {
        for (const request of requests) {
            const result = await this.check(request);
            if (result.effect !== 'allow') return result;
        }
        return null;
    }

    async checkAllDetailed(requests: PermissionRequest[]): Promise<PermissionCheckResult[]> {
        const results = await Promise.all(requests.map((request) => this.check(request)));
        return results.filter((result) => result.effect !== 'allow');
    }

    async addRule(_rule: PermissionRule): Promise<void> {}

    async removeRule(_rule: PermissionRule): Promise<void> {}
}

describe('OpenCode config permission runtime', () => {
    test('uses ordered OpenCode-style bash rules and checks compound commands', async () => {
        const runtime = new ConfigPermissionRuntime(true, {
            '*': 'allow',
            bash: {
                'rm *': 'ask',
                'rm -f safe.tmp': 'allow',
                'cmd /c del *': 'ask',
                'powershell -Command"rm *': 'ask'
            }
        });
        const enforcer = runtime.wrapEnforcer('/workspace', new FallbackPermissionEnforcer('deny'));

        await expect(
            enforcer.checkToolCall?.({
                toolName: 'executeBash',
                args: { command: 'echo ready && rm output.txt' },
                workspace: '/workspace'
            })
        ).resolves.toEqual([
            expect.objectContaining({
                effect: 'ask',
                request: expect.objectContaining({ action: 'execute', resourcePath: 'echo ready && rm output.txt' })
            })
        ]);
        await expect(
            enforcer.checkToolCall?.({
                toolName: 'executeBash',
                args: { command: 'rm -f safe.tmp' },
                workspace: '/workspace'
            })
        ).resolves.toEqual([]);
        await expect(
            enforcer.checkToolCall?.({
                toolName: 'executePowerShell',
                args: { command: 'cmd /c del old.txt' },
                workspace: '/workspace'
            })
        ).resolves.toEqual([expect.objectContaining({ effect: 'ask' })]);
        await expect(
            enforcer.checkToolCall?.({
                toolName: 'executePowerShell',
                args: { command: 'cmd /c del /f /q "D:\\2.txt"' },
                workspace: '/workspace'
            })
        ).resolves.toEqual([expect.objectContaining({ effect: 'ask' })]);
        await expect(
            enforcer.checkToolCall?.({
                toolName: 'executePowerShell',
                args: { command: 'powershell -Command"rm old.txt' },
                workspace: '/workspace'
            })
        ).resolves.toEqual([expect.objectContaining({ effect: 'ask' })]);
    });

    test('applies read and external_directory rules in addition to the root fallback', async () => {
        const runtime = new ConfigPermissionRuntime(true, {
            '*': 'allow',
            read: {
                '*.env': 'deny'
            },
            external_directory: {
                '/storage/Users/currentUser/Documents/*': 'ask'
            }
        });
        const enforcer = runtime.wrapEnforcer('/workspace', new FallbackPermissionEnforcer('deny'));

        await expect(
            enforcer.check({ resourceType: 'file', action: 'read', resourcePath: '/workspace/app.env' })
        ).resolves.toMatchObject({ effect: 'deny' });
        await expect(
            enforcer.check({
                resourceType: 'file',
                action: 'read',
                resourcePath: '/storage/Users/currentUser/Documents/note.txt'
            })
        ).resolves.toMatchObject({ effect: 'ask' });
        await expect(
            enforcer.check({
                resourceType: 'file',
                action: 'write',
                resourcePath: '/storage/Users/currentUser/Documents/note.txt'
            })
        ).resolves.toMatchObject({ effect: 'ask' });
        await expect(
            enforcer.check({ resourceType: 'file', action: 'read', resourcePath: '/workspace/readme.md' })
        ).resolves.toMatchObject({ effect: 'allow' });
    });

    test('hot reloads existing enforcers and falls back to their current mode enforcer on invalid config', async () => {
        const runtime = new ConfigPermissionRuntime(true, {
            '*': 'allow',
            bash: { 'rm *': 'ask' }
        });
        const originalFallback = new FallbackPermissionEnforcer('deny');
        const enforcer = runtime.wrapEnforcer('/workspace', originalFallback);

        expect(
            await enforcer.checkToolCall?.({
                toolName: 'executeBash',
                args: { command: 'rm old.txt' },
                workspace: '/workspace'
            })
        ).toEqual([expect.objectContaining({ effect: 'ask' })]);

        expect(runtime.reload({ '*': 'allow', bash: { 'rm *': 'deny' } }).status).toBe('active');
        expect(
            await enforcer.checkToolCall?.({
                toolName: 'executeBash',
                args: { command: 'rm old.txt' },
                workspace: '/workspace'
            })
        ).toEqual([expect.objectContaining({ effect: 'deny' })]);

        const currentModeFallback = new FallbackPermissionEnforcer('ask');
        enforcer.setFallbackEnforcer?.(currentModeFallback);
        expect(runtime.reload({ bash: { 'rm *': 'allow' } }).status).toBe('invalid');
        await expect(
            enforcer.check({ resourceType: 'file', action: 'read', resourcePath: '/workspace/readme.md' })
        ).resolves.toMatchObject({ effect: 'ask' });
    });

    test('does not activate configured permissions when the server flag is disabled', async () => {
        const runtime = new ConfigPermissionRuntime(false, {
            '*': 'deny'
        });
        const fallback = new FallbackPermissionEnforcer('allow');
        const enforcer = runtime.wrapEnforcer('/workspace', fallback);

        expect(enforcer).toBe(fallback);
        await expect(
            enforcer.check({ resourceType: 'file', action: 'read', resourcePath: '/outside/file.txt' })
        ).resolves.toMatchObject({ effect: 'allow' });
        expect(runtime.reload({ '*': 'deny' }).status).toBe('disabled');
    });

    test('clears session-only remembered allows when the config generation changes', async () => {
        const runtime = new ConfigPermissionRuntime(true, {
            '*': 'allow',
            bash: { 'rm *': 'ask' }
        });
        const enforcer = runtime.wrapEnforcer('/workspace', new FallbackPermissionEnforcer('deny'));
        await enforcer.addRule({ resourceType: '*', action: 'execute', pathPattern: 'rm old.txt', effect: 'allow' });

        await expect(
            enforcer.checkToolCall?.({
                toolName: 'executeBash',
                args: { command: 'rm old.txt' },
                workspace: '/workspace'
            })
        ).resolves.toEqual([]);

        runtime.reload({ '*': 'allow', bash: { 'rm *': 'ask' } });
        await expect(
            enforcer.checkToolCall?.({
                toolName: 'executeBash',
                args: { command: 'rm old.txt' },
                workspace: '/workspace'
            })
        ).resolves.toEqual([expect.objectContaining({ effect: 'ask' })]);
    });

    test('checks bash tool calls even when the terminal analyzer declares no file permissions', async () => {
        const runtime = new ConfigPermissionRuntime(true, {
            '*': 'allow',
            bash: { 'rm *': 'ask' }
        });
        const enforcer = runtime.wrapEnforcer('/workspace', new FallbackPermissionEnforcer('allow'));
        const prompt = jest.fn(async () => ({ decision: 'allow', rememberScope: 'none' }) as const);
        const task = {
            task_id: 'task-bash-permission',
            task_name: 'bash permission',
            parent_id: null,
            harnessContext: {
                permission: enforcer,
                permissionPrompt: { prompt }
            },
            getWorkspace: () => '/workspace',
            chat_context: { messages: [] }
        } as any;
        const tool = {
            name: 'executeBash',
            getDeclaredPermissions: jest.fn(() => [])
        } as any;
        const toolCall = {
            id: 'call-rm',
            status: 'pending',
            args_object: { command: 'rm old.txt' }
        } as any;

        await expect(handleToolPermissionsForTask(task, tool, { command: 'rm old.txt' }, toolCall)).resolves.toBe(
            false
        );
        expect(prompt).toHaveBeenCalledWith(
            [expect.objectContaining({ action: 'execute', resourcePath: 'rm old.txt' })],
            'executeBash',
            expect.any(Array),
            expect.objectContaining({ taskId: 'task-bash-permission' }),
            expect.objectContaining({ input: { command: 'rm old.txt' } })
        );
    });

    test('keeps the dynamic wrapper across mode changes and updates its fallback atomically', async () => {
        const runtime = new ConfigPermissionRuntime(true, { '*': 'allow' });
        const wrapper = runtime.wrapEnforcer('/workspace', new FallbackPermissionEnforcer('deny'));
        const unlimitedMode = {
            id: 'test-unlimited',
            name: 'Unlimited',
            description: '',
            icon: '',
            color: '',
            bypassPermissionChecks: true,
            permissionFactory: () => []
        };
        const agent = {
            agentId: 'test-agent',
            supportedModes: () => [unlimitedMode]
        };
        const task = {
            task_id: 'task-mode-change',
            activeModeId: 'old-mode',
            allowedTools: undefined,
            disabledTools: undefined,
            harnessContext: {
                permission: wrapper,
                permissionPrompt: { prompt: jest.fn() },
                workspace: '/workspace',
                environ: {},
                executionHost: { type: 'local' }
            },
            getAgent: () => agent,
            getWorkspace: () => '/workspace',
            buildSystemPrompt: jest.fn(async () => 'new system prompt'),
            installBuiltSystemPrompt: jest.fn(),
            task_manager_state: {
                clearLazyTaskSystemPromptRefresh: jest.fn()
            }
        } as any;

        await replaceTaskHarnessForMode(
            task,
            '/workspace',
            unlimitedMode as any,
            () => task.harnessContext.permissionPrompt
        );

        expect(task.harnessContext.permission).toBe(wrapper);
        runtime.reload({ bash: { 'rm *': 'ask' } });
        await expect(
            wrapper.check({ resourceType: 'file', action: 'read', resourcePath: '/outside/file.txt' })
        ).resolves.toMatchObject({ effect: 'allow' });
    });
});
