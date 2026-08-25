import { describe, expect, test } from '@jest/globals';
import { registerTaskExtension, type TaskExtension } from '../../../main/aikernel/task-extension.js';
import { extractAttemptCompletionResult } from '../../../main/aikernel/planning/harness.js';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks.js';

describe('task extension manager', () => {
    test('preserves unknown persisted fields while current task fields take precedence', () => {
        const task = new TaskState(new TaskManagerState());
        task.extensions.restore(
            {
                task_name: 'stale name',
                future_extension: { version: 2, value: 'preserve me' }
            },
            false
        );
        task.task_name = 'current name';

        const json = task.toJSON() as Record<string, unknown>;

        expect(json.task_name).toBe('current name');
        expect(json.future_extension).toEqual({ version: 2, value: 'preserve me' });
    });

    test('attaches an extension registered after task restoration and restores it from the original JSON', () => {
        const task = new TaskState(new TaskManagerState());
        task.extensions.restore({ late_extension_value: 'restored' }, false);
        const key = `late-test-${crypto.randomUUID()}`;

        class LateExtension implements TaskExtension {
            readonly key = key;
            value?: string;

            restore(raw: Record<string, unknown>): void {
                this.value = typeof raw.late_extension_value === 'string' ? raw.late_extension_value : undefined;
            }

            serialize(): Record<string, unknown> {
                return { late_extension_value: this.value };
            }
        }

        registerTaskExtension(key, () => new LateExtension());

        expect(task.extensions.require<LateExtension>(key).value).toBe('restored');
        expect((task.toJSON() as Record<string, unknown>).late_extension_value).toBe('restored');
    });

    test('forwards task lifecycle notifications to extensions', () => {
        const key = `lifecycle-test-${crypto.randomUUID()}`;
        const calls: string[] = [];

        class LifecycleExtension implements TaskExtension {
            readonly key = key;

            onTaskLifecycle(event: Parameters<NonNullable<TaskExtension['onTaskLifecycle']>>[0]): void {
                if (event.type === 'stop') calls.push(`stop:${event.reason}`);
                if (event.type === 'agent_changed') {
                    calls.push(`agent:${event.previousAgentId}->${event.nextAgentId}`);
                }
                if (event.type === 'dispose') calls.push('dispose');
            }
        }

        registerTaskExtension(key, () => new LifecycleExtension());
        const task = new TaskState(new TaskManagerState());

        task.extensions.notifyLifecycle({ type: 'stop', reason: 'user' });
        task.extensions.notifyLifecycle({ type: 'agent_changed', previousAgentId: 'old', nextAgentId: 'new' });
        task.extensions.notifyLifecycle({ type: 'dispose' });

        expect(calls).toEqual(['stop:user', 'agent:old->new', 'dispose']);
    });

    test('uses extension completion results when no attemptCompletion tool call exists', () => {
        const key = `completion-test-${crypto.randomUUID()}`;
        const targetTaskId = crypto.randomUUID();

        class CompletionExtension implements TaskExtension {
            readonly key = key;

            constructor(private readonly task: TaskState) {}

            getSubTaskCompletionResult() {
                if (this.task.task_id !== targetTaskId) return undefined;
                return { success: true, result: 'Remote result', status: 'success' as const };
            }
        }

        registerTaskExtension(key, (task) => new CompletionExtension(task));
        const task = new TaskState(new TaskManagerState());
        task.task_id = targetTaskId;

        expect(extractAttemptCompletionResult(task)).toEqual({
            success: true,
            result: 'Remote result',
            status: 'success'
        });
    });
});
