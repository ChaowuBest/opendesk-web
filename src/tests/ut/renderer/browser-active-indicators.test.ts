import { describe, expect, test } from '@jest/globals';
import { BROWSER_ACTIVE_ICON_TTL_MS, pruneBrowserActiveTasks } from '../../../renderer/browserActiveIndicators.js';

const NOW = Date.parse('2026-11-11T12:00:00.000Z');
const MINUTE = 60 * 1000;

function iso(offsetMs: number): string {
    return new Date(NOW + offsetMs).toISOString();
}

describe('browser active icon pruning', () => {
    test('keeps running tasks and renews their timestamp', () => {
        const activeAt = new Map([['task-1', NOW - 60 * MINUTE]]);

        const result = pruneBrowserActiveTasks(activeAt, [{ task_id: 'task-1', task_status: 'running' }], NOW);

        expect(result.removed).toEqual([]);
        expect(activeAt.get('task-1')).toBe(NOW);
    });

    test('drops the icon of a finished task once the retention window elapses', () => {
        const activeAt = new Map([['task-1', NOW - 10 * MINUTE]]);

        const result = pruneBrowserActiveTasks(
            activeAt,
            [{ task_id: 'task-1', task_status: 'stopped', finished_at: iso(-10 * MINUTE) }],
            NOW
        );

        expect(result.removed).toEqual(['task-1']);
        expect(activeAt.has('task-1')).toBe(false);
    });

    test('keeps the icon while the retention window has not elapsed yet', () => {
        const activeAt = new Map([['task-1', NOW - 2 * MINUTE]]);

        const result = pruneBrowserActiveTasks(
            activeAt,
            [{ task_id: 'task-1', task_status: 'stopped', finished_at: iso(-2 * MINUTE) }],
            NOW
        );

        expect(result.removed).toEqual([]);
        expect(activeAt.get('task-1')).toBe(NOW - 2 * MINUTE);
    });

    test('starts counting from the later of last activity and task finish time', () => {
        // 浏览器活跃记录很早，但任务是刚刚结束的：不能立刻清掉图标
        const activeAt = new Map([['task-1', NOW - 30 * MINUTE]]);

        const result = pruneBrowserActiveTasks(
            activeAt,
            [{ task_id: 'task-1', task_status: 'stopped', finished_at: iso(-1 * MINUTE) }],
            NOW
        );

        expect(result.removed).toEqual([]);
        expect(activeAt.has('task-1')).toBe(true);
    });

    test('drops records of tasks that are no longer in the list', () => {
        const activeAt = new Map([
            ['stale-task', NOW - BROWSER_ACTIVE_ICON_TTL_MS - 1],
            ['fresh-task', NOW - MINUTE]
        ]);

        const result = pruneBrowserActiveTasks(activeAt, [], NOW);

        expect(result.removed).toEqual(['stale-task']);
        expect([...activeAt.keys()]).toEqual(['fresh-task']);
    });

    test('does nothing when there is no active record', () => {
        const activeAt = new Map<string, number>();

        const result = pruneBrowserActiveTasks(activeAt, [{ task_id: 'task-1', task_status: 'running' }], NOW);

        expect(result.removed).toEqual([]);
    });

    test('honours a custom retention window', () => {
        const activeAt = new Map([['task-1', NOW - 2 * MINUTE]]);

        const result = pruneBrowserActiveTasks(
            activeAt,
            [{ task_id: 'task-1', task_status: 'stopped', finished_at: iso(-2 * MINUTE) }],
            NOW,
            MINUTE
        );

        expect(result.removed).toEqual(['task-1']);
    });
});
