import { describe, expect, test } from '@jest/globals';
import { registerTaskExtension, type TaskExtension } from '../../../main/aikernel/task-extension.js';
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
});
