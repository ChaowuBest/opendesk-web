import { jest } from '@jest/globals';
import { buildActiveContextView } from '../../../main/aikernel/compaction/context-view.js';
import { GlobalHooks } from '../../../main/aikernel/hooks.js';
import { ChatContext, UserMessage } from '../../../main/aikernel/messages.js';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks.js';
import { logger } from '../../../main/utils/logger.js';
import { Setting } from '../../../main/utils/setting.js';

function createContext() {
    const chatContext = new ChatContext();
    chatContext.appendMessage(new UserMessage('hello'));
    return {
        activeContext: buildActiveContextView(chatContext),
        chatContext,
        model: 'mock-model',
        requestType: 'streamComplete' as const
    };
}

describe('Hooks.onTailcardGenerate / buildTailcards', () => {
    beforeEach(() => {
        Setting.updateInstanceData({
            task_config: {
                auto_retry: true,
                generate_taskname: true,
                termination_check: true,
                evidence_card: false
            }
        });
    });

    afterEach(() => {
        jest.restoreAllMocks();
        Setting.clearCache();
    });

    test('returns undefined when every callback is inactive', async () => {
        const task = new TaskState(new TaskManagerState());
        task.hooks.onTailcardGenerate(() => undefined, {
            id: 'inactive-module'
        });

        const result = await task.hooks.buildTailcards(task, createContext());

        expect(result).toBeUndefined();
    });

    test('checks task-local module state on every request without re-registering', async () => {
        const task = new TaskState(new TaskManagerState());
        let enabled = false;
        task.hooks.onTailcardGenerate(
            () => (enabled ? { id: 'dynamic-module', content: 'dynamic tail content' } : undefined),
            { id: 'dynamic-module' }
        );

        expect(await task.hooks.buildTailcards(task, createContext())).toBeUndefined();

        enabled = true;
        const enabledTail = await task.hooks.buildTailcards(task, createContext());
        expect(enabledTail).toContain('[OpenDesk Internal Request Tail]');
        expect(enabledTail).toContain('## Section: dynamic-module');
        expect(enabledTail).toContain('dynamic tail content');
        expect(enabledTail).toContain('[End OpenDesk Internal Request Tail]');
        expect(enabledTail).toContain("Answer the user's original request directly.");

        enabled = false;
        expect(await task.hooks.buildTailcards(task, createContext())).toBeUndefined();
    });

    test('sorts non-empty sections by priority and stable registration order', async () => {
        const task = new TaskState(new TaskManagerState());
        task.hooks.onTailcardGenerate(() => ({ id: 'default-first', content: 'default first' }), {
            id: 'default-first',
            priority: 500
        });
        task.hooks.onTailcardGenerate(() => ({ id: 'early', content: 'early' }), {
            id: 'early',
            priority: 100
        });
        task.hooks.onTailcardGenerate(() => ({ id: 'empty', content: '   ' }), {
            id: 'empty',
            priority: 200
        });
        task.hooks.onTailcardGenerate(() => ({ id: 'default-second', content: 'default second' }), {
            id: 'default-second',
            priority: 500
        });

        const result = await task.hooks.buildTailcards(task, createContext());

        expect(result).toBeDefined();
        expect(result!.indexOf('## Section: early')).toBeLessThan(result!.indexOf('## Section: default-first'));
        expect(result!.indexOf('## Section: default-first')).toBeLessThan(
            result!.indexOf('## Section: default-second')
        );
        expect(result).not.toContain('## Section: empty');
    });

    test('isolates callback errors and applies per-module maxChars', async () => {
        const task = new TaskState(new TaskManagerState());
        const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
        task.hooks.onTailcardGenerate(
            () => {
                throw new Error('broken tail');
            },
            { id: 'broken' }
        );
        task.hooks.onTailcardGenerate(() => ({ id: 'limited', content: 'abcdefghij' }), {
            id: 'limited',
            maxChars: 5
        });

        const result = await task.hooks.buildTailcards(task, createContext());

        expect(result).toContain('## Section: limited');
        expect(result).toContain('ab...');
        expect(result).not.toContain('abcdefghij');
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('callback broken failed'), expect.any(Error));
    });

    test('keeps registrations isolated between tasks', async () => {
        const firstTask = new TaskState(new TaskManagerState());
        const secondTask = new TaskState(new TaskManagerState());
        firstTask.hooks.onTailcardGenerate(() => ({ id: 'task-local', content: 'first task only' }), {
            id: 'task-local'
        });

        expect(await firstTask.hooks.buildTailcards(firstTask, createContext())).toContain('first task only');
        expect(await secondTask.hooks.buildTailcards(secondTask, createContext())).toBeUndefined();
    });

    test('includes global registrations after task-local registrations', async () => {
        const initialGlobalRegistrationCount = GlobalHooks.tailcardRegistrations.length;
        try {
            GlobalHooks.onTailcardGenerate(() => ({ id: 'global-tail', content: 'global tail content' }), {
                id: 'global-tail'
            });
            const task = new TaskState(new TaskManagerState());
            task.hooks.onTailcardGenerate(() => ({ id: 'local-tail', content: 'local tail content' }), {
                id: 'local-tail'
            });

            const result = await task.hooks.buildTailcards(task, createContext());

            expect(result).toContain('## Section: local-tail');
            expect(result).toContain('## Section: global-tail');
            expect(result!.indexOf('## Section: local-tail')).toBeLessThan(result!.indexOf('## Section: global-tail'));
        } finally {
            GlobalHooks.tailcardRegistrations.splice(initialGlobalRegistrationCount);
        }
    });

    test('keeps the first registration when the same task registers an id more than once', async () => {
        const task = new TaskState(new TaskManagerState());
        task.hooks.onTailcardGenerate(() => ({ id: 'duplicate-id', content: 'first registration' }), {
            id: 'duplicate-id'
        });
        task.hooks.onTailcardGenerate(() => ({ id: 'duplicate-id', content: 'second registration' }), {
            id: 'duplicate-id'
        });

        const result = await task.hooks.buildTailcards(task, createContext());

        expect(result).toContain('first registration');
        expect(result).not.toContain('second registration');
        expect(task.hooks.tailcardRegistrations.filter((r) => r.id === 'duplicate-id')).toHaveLength(1);
    });

    test('installs EvidenceCard once per task and checks its feature switch on every request', async () => {
        const task = new TaskState(new TaskManagerState());

        expect(await task.hooks.buildTailcards(task, createContext())).toBeUndefined();

        Setting.updateInstanceData({
            task_config: {
                auto_retry: true,
                generate_taskname: true,
                termination_check: true,
                evidence_card: true
            }
        });
        const enabledTail = await task.hooks.buildTailcards(task, createContext());
        expect(enabledTail).toContain('## Section: evidence-card');
        expect(enabledTail).toContain('# EvidenceCard Runtime');

        Setting.updateInstanceData({
            task_config: {
                auto_retry: true,
                generate_taskname: true,
                termination_check: true,
                evidence_card: false
            }
        });
        expect(await task.hooks.buildTailcards(task, createContext())).toBeUndefined();
        expect(task.hooks.tailcardRegistrations.filter((r) => r.id === 'evidence-card')).toHaveLength(1);
    });
});
