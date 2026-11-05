import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import type { TaskState } from '../../../main/aikernel/states/tasks.js';
import type { TaskManagerState } from '../../../main/aikernel/task/manager.js';
import { UnsupportedAttachmentFileTypeError } from '../../../main/aikernel/attachment-support.js';

const events: string[] = [];
const ensureFullyLoaded = jest.fn(async () => {
    events.push('applications');
});
const applyNode = jest.fn(async (_task: unknown, nodeId: string | null | undefined) => {
    events.push(`node:${nodeId}`);
    return { status: 'ok', data: { type: 'local' } };
});
const createForMode = jest.fn(async () => ({
    grantTaskArtifactAccess: async () => {
        events.push('artifacts');
    }
}));
const createEmpty = jest.fn(() => ({}));
const standard = { id: 'standard', allowedTools: ['read'], disabledTools: ['write'] };
const plan = { id: 'plan', allowedTools: ['plan'], disabledTools: [] };
jest.unstable_mockModule('../../../main/applications/registry.js', () => ({
    ApplicationRegistry: { ensureFullyLoaded }
}));
jest.unstable_mockModule('../../../main/applications/devicemgr/execution.js', () => ({
    getExecutionNode: (id: string) => (id === 'remote' ? { nodeId: id } : null)
}));
jest.unstable_mockModule('../../../main/applications/devicemgr/task-execution.js', () => ({
    normalizeExecutionNodeId: (id?: string | null) => (typeof id === 'string' ? id.trim() : ''),
    applyTaskExecutionNode: applyNode
}));
jest.unstable_mockModule('../../../main/utils/setting.js', () => ({
    Setting: { getInstance: () => ({ getEffectiveWorkspace: () => '/workspace' }) },
    getTaskArtifactDirectory: () => '/artifacts'
}));
jest.unstable_mockModule('../../../main/aikernel/agents/registry.js', () => ({
    AgentRegistry: { getMainAgent: () => ({ supportedModes: () => [standard, plan], getDefaultMode: () => standard }) }
}));
jest.unstable_mockModule('../../../main/aikernel/security/harness.js', () => ({
    HarnessContext: { createForMode, createEmpty }
}));
jest.unstable_mockModule('../../../main/utils/logger.js', () => ({ logger: { warn: jest.fn() } }));
jest.unstable_mockModule('../../../locale/index.js', () => ({
    t: (key: string, values?: Record<string, string>) => key + ':' + JSON.stringify(values || {})
}));
const { createGuiTask, submitGuiTaskMessage } = await import('../../../main/applications/task-gui/operations.js');

function fixture() {
    const task = {
        task_id: 'task-1',
        workspace: '',
        activeModeId: '',
        harnessContext: {},
        model: 'old',
        reasoningEffort: 'high',
        rebuildSystemPrompt: jest.fn(async () => {
            events.push('prompt');
        }),
        attachFiles: jest.fn(async () => {
            events.push('files');
        }),
        ensureValidModelOrFallback: jest.fn(() => {
            events.push('model');
        }),
        submitUserMessage: jest.fn(async () => {
            events.push('submit');
        })
    };
    const manager = {
        createTask: jest.fn(() => {
            events.push('create');
            return task;
        }),
        publishTaskListUpdate: jest.fn(() => {
            events.push('publish');
        }),
        getTask: jest.fn(() => task),
        refreshLazyTaskSystemPrompt: jest.fn(async () => {
            events.push('lazy');
        })
    };
    const host = {
        currentModeId: 'plan',
        defaultExecutionNodeId: '',
        permissionPromptFactory: jest.fn(() => ({ host: true })),
        createInteractionToolset: jest.fn(() => ({ tools: true }))
    };
    return { task, manager, host };
}

describe('shared GUI task operations', () => {
    beforeEach(() => {
        events.length = 0;
        jest.clearAllMocks();
    });

    test('creates after application readiness and publishes only after the complete harness initialization', async () => {
        const { task, manager, host } = fixture();
        const result = await createGuiTask(
            manager as unknown as TaskManagerState,
            { taskName: 'Review', internal: true },
            host as never
        );
        expect(result).toEqual({ status: 'ok', data: 'task-1' });
        expect(events).toEqual(['applications', 'create', 'artifacts', 'prompt', 'publish']);
        expect(manager.createTask).toHaveBeenCalledWith(undefined, { internal: true, taskName: 'Review' });
        expect(createForMode).toHaveBeenCalledWith('/workspace', plan);
        expect(task).toMatchObject({ workspace: '/workspace', activeModeId: 'plan', allowedTools: ['plan'] });
    });

    test('rejects a disconnected node before creating a task', async () => {
        const { manager, host } = fixture();
        expect(
            await createGuiTask(
                manager as unknown as TaskManagerState,
                { selectedExecutionNodeId: 'offline' },
                host as never
            )
        ).toEqual({ status: 'error', message: 'node offline not connected' });
        expect(events).toEqual([]);
    });

    test('reads the live current mode after the application readiness barrier settles', async () => {
        const { manager, host } = fixture();
        let currentMode = 'standard';
        const readMode = jest.fn(() => currentMode);
        Object.defineProperty(host, 'currentModeId', { get: readMode });
        let ready!: () => void;
        ensureFullyLoaded.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    ready = resolve;
                })
        );
        const pending = createGuiTask(manager as unknown as TaskManagerState, {}, host as never);
        expect(manager.createTask).not.toHaveBeenCalled();
        expect(readMode).not.toHaveBeenCalled();
        currentMode = 'plan';
        ready();
        expect(await pending).toEqual({ status: 'ok', data: 'task-1' });
        expect(readMode).toHaveBeenCalledTimes(1);
        expect(createForMode).toHaveBeenCalledWith('/workspace', plan);
    });

    test('retains the existing default-node fallback and legacy string mode input', async () => {
        const { manager, host } = fixture();
        host.defaultExecutionNodeId = 'remote';
        await createGuiTask(manager as unknown as TaskManagerState, 'standard', host as never);
        expect(createForMode).toHaveBeenCalledWith('/workspace', standard);
        expect(events).toEqual(['applications', 'create', 'artifacts', 'node:remote', 'prompt', 'publish']);
    });

    test('keeps the existing empty-harness fallback and still publishes on initialization failure', async () => {
        const { task, manager, host } = fixture();
        createForMode.mockRejectedValueOnce(new Error('init failed'));
        expect(await createGuiTask(manager as unknown as TaskManagerState, {}, host as never)).toEqual({
            status: 'ok',
            data: 'task-1'
        });
        expect(task.harnessContext).toEqual({ workspace: '/workspace' });
        expect(events).toEqual(['applications', 'create', 'publish']);
    });

    test('applies attachments, model, explicit empty effort and node before interactive submission', async () => {
        const { task, manager } = fixture();
        expect(
            await submitGuiTaskMessage(manager as unknown as TaskManagerState, 'task-1', {
                message: 'Hello',
                attachedFilePaths: ['/input.txt'],
                selectedModel: 'new',
                reasoningEffort: '',
                selectedExecutionNodeId: null,
                attachedImages: ['data:image/png;base64,AA==']
            })
        ).toEqual({ status: 'ok' });
        expect(events).toEqual(['lazy', 'files', 'model', 'node:null', 'submit']);
        expect(task.reasoningEffort).toBe('');
        expect(task.submitUserMessage).toHaveBeenCalledWith('Hello', {
            imageDataUris: ['data:image/png;base64,AA=='],
            interactive: true
        });
    });

    test('an omitted node keeps the task selection, and missing tasks run no mutations', async () => {
        const { manager } = fixture();
        await submitGuiTaskMessage(manager as unknown as TaskManagerState, 'task-1', { message: 'keep node' });
        expect(applyNode).not.toHaveBeenCalled();
        manager.getTask.mockReturnValueOnce(undefined as never);
        expect(
            await submitGuiTaskMessage(manager as unknown as TaskManagerState, 'missing', { message: 'no' })
        ).toEqual({ status: 'error', message: 'task missing not found' });
    });

    test('unsupported attachments retain localized feedback and prevent submission', async () => {
        const { task, manager } = fixture();
        task.attachFiles.mockRejectedValueOnce(
            new UnsupportedAttachmentFileTypeError([{ filePath: '/file.ppt', extension: 'ppt' }], ['pptx'])
        );
        const result = await submitGuiTaskMessage(manager as unknown as TaskManagerState, 'task-1', {
            message: 'no',
            attachedFilePaths: ['/file.ppt']
        });
        expect(result.status).toBe('error');
        expect('message' in result && result.message).toContain('renderer.agentInput.unsupportedFile.message');
        expect(task.submitUserMessage).not.toHaveBeenCalled();
    });

    test('a rejected execution node never submits on the previous host', async () => {
        const { task, manager } = fixture();
        applyNode.mockResolvedValueOnce({ status: 'error', message: 'node offline not connected' } as never);
        expect(
            await submitGuiTaskMessage(manager as unknown as TaskManagerState, 'task-1', {
                message: 'must not execute',
                selectedExecutionNodeId: 'offline'
            })
        ).toEqual({ status: 'error', message: 'node offline not connected' });
        expect(task.submitUserMessage).not.toHaveBeenCalled();
    });

    test('unexpected attachment errors still reach the host instead of being reported as a successful send', async () => {
        const { task, manager } = fixture();
        task.attachFiles.mockRejectedValueOnce(new Error('read failed'));
        await expect(
            submitGuiTaskMessage(manager as unknown as TaskManagerState, 'task-1', {
                message: 'must not execute',
                attachedFilePaths: ['/file.txt']
            })
        ).rejects.toThrow('read failed');
        expect(task.submitUserMessage).not.toHaveBeenCalled();
    });
});
