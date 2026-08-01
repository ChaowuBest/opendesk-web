import {
    buildSidebarSearchResults,
    buildSidebarTaskGroups,
    getSidebarRunningTasks,
    isSidebarTaskVisible,
    type SidebarTask
} from '../../../renderer/sidebarTaskGroups.js';

const now = new Date('2026-07-29T12:00:00');

function task(task_id: string, created_at: string, overrides: Partial<SidebarTask> = {}): SidebarTask {
    return {
        task_id,
        task_name: task_id,
        task_status: 'stopped',
        created_at,
        workspace: '/work/OpenDesk',
        ...overrides
    };
}

describe('sidebar task grouping', () => {
    test('hides titleless placeholder tasks but keeps named tasks', () => {
        expect(isSidebarTaskVisible(null)).toBe(false);
        expect(isSidebarTaskVisible(task('missing-title', '2026-07-29T10:00:00', { task_name: undefined }))).toBe(
            false
        );
        expect(isSidebarTaskVisible(task('blank-title', '2026-07-29T10:00:00', { task_name: '   ' }))).toBe(false);
        expect(isSidebarTaskVisible(task('temporary-title', '2026-07-29T10:00:00', { task_name: '未命名任务' }))).toBe(
            true
        );
    });

    test('shows newly created tasks with name_pending even when task_name is null', () => {
        expect(
            isSidebarTaskVisible(task('new-task', '2026-07-29T10:00:00', { task_name: null, name_pending: true }))
        ).toBe(true);
    });

    test('hides restored tasks without name_pending when task_name is null', () => {
        expect(isSidebarTaskVisible(task('old-empty', '2026-07-29T10:00:00', { task_name: null }))).toBe(false);
    });

    test('keeps running root tasks in their own section with their children', () => {
        const tasks = [
            task('running-root', '2026-07-29T10:00:00', { task_status: 'running' }),
            task('running-child', '2026-07-29T10:01:00', {
                task_status: 'running',
                parent_id: 'running-root'
            }),
            task('running-child-later', '2026-07-29T10:02:00', {
                task_status: 'waiting',
                parent_id: 'running-root'
            }),
            task('finished-root', '2026-07-29T09:00:00')
        ];

        const running = getSidebarRunningTasks(tasks);

        expect(running).toHaveLength(1);
        expect(running[0].task.task_id).toBe('running-root');
        expect(running[0].children.map((child) => child.task_id)).toEqual(['running-child', 'running-child-later']);
    });

    test('adds at most two recently completed tasks and excludes automatic tasks from the running section', () => {
        const tasks = [
            task('running-root', '2026-07-29T11:00:00', { task_status: 'running' }),
            task('automatic-running', '2026-07-29T11:10:00', {
                task_status: 'running',
                internal: true
            }),
            task('completed-latest', '2026-07-29T10:00:00', {
                finished_at: '2026-07-29T11:58:00'
            }),
            task('completed-second', '2026-07-29T10:00:00', {
                finished_at: '2026-07-29T11:55:00'
            }),
            task('completed-third', '2026-07-29T10:00:00', {
                finished_at: '2026-07-29T11:53:00'
            }),
            task('completed-too-old', '2026-07-29T10:00:00', {
                finished_at: '2026-07-29T11:49:00'
            }),
            task('automatic-completed', '2026-07-29T10:00:00', {
                finished_at: '2026-07-29T11:59:00',
                internal: true
            })
        ];

        const running = getSidebarRunningTasks(tasks, now);

        expect(running.map((item) => item.task.task_id)).toEqual([
            'running-root',
            'completed-latest',
            'completed-second'
        ]);
        expect(running.map((item) => item.recentlyCompleted)).toEqual([false, true, true]);
    });

    test('groups history into today, this week, earlier and automatic tasks', () => {
        const tasks = [
            task('today', '2026-07-29T09:00:00'),
            task('this-week', '2026-07-27T09:00:00'),
            task('earlier', '2026-07-19T09:00:00'),
            task('automatic', '2026-07-29T08:00:00', { internal: true }),
            task('running', '2026-07-29T11:00:00', { task_status: 'running' })
        ];

        const groups = buildSidebarTaskGroups(tasks, 'time', now);

        expect(groups.map((group) => group.id)).toEqual(['today', 'this-week', 'earlier', 'automatic']);
        expect(groups.map((group) => group.items.map((item) => item.task.task_id))).toEqual([
            ['running', 'today'],
            ['this-week'],
            ['earlier'],
            ['automatic']
        ]);
    });

    test('includes running tasks in task list groups alongside stopped tasks', () => {
        const tasks = [
            task('stopped-today', '2026-07-29T09:00:00'),
            task('running-today', '2026-07-29T11:00:00', { task_status: 'running' }),
            task('running-this-week', '2026-07-27T10:00:00', { task_status: 'running' })
        ];

        const groups = buildSidebarTaskGroups(tasks, 'time', now);

        const todayIds = groups.find((g) => g.id === 'today')!.items.map((i) => i.task.task_id);
        const thisWeekIds = groups.find((g) => g.id === 'this-week')!.items.map((i) => i.task.task_id);
        expect(todayIds).toContain('running-today');
        expect(todayIds).toContain('stopped-today');
        expect(thisWeekIds).toContain('running-this-week');
    });

    test('groups history by normalized workspace and keeps automatic tasks separate', () => {
        const tasks = [
            task('open-desk-a', '2026-07-29T09:00:00'),
            task('open-desk-b', '2026-07-28T09:00:00', { workspace: '/work/OpenDesk/' }),
            task('notes', '2026-07-27T09:00:00', { workspace: '/work/notes' }),
            task('no-workspace', '2026-07-26T09:00:00', { workspace: '' }),
            task('automatic', '2026-07-29T08:00:00', { internal: true })
        ];

        const groups = buildSidebarTaskGroups(tasks, 'workspace', now);

        expect(groups.map((group) => group.id)).toEqual([
            'workspace:/work/OpenDesk',
            'workspace:/work/notes',
            'workspace:',
            'automatic'
        ]);
        expect(groups[0]).toMatchObject({
            label: 'OpenDesk',
            workspace: '/work/OpenDesk'
        });
        expect(groups[0].items.map((item) => item.task.task_id)).toEqual(['open-desk-a', 'open-desk-b']);
        expect(groups[3].items.map((item) => item.task.task_id)).toEqual(['automatic']);
    });

    test('orders workspaces by latest activity and folds all but the latest three into other', () => {
        const groups = buildSidebarTaskGroups(
            [
                task('alpha-older', '2026-07-20T09:00:00', {
                    workspace: '/work/alpha',
                    updated_at: '2026-07-29T10:30:00'
                }),
                task('alpha-latest', '2026-07-20T09:00:00', {
                    workspace: '/work/alpha',
                    updated_at: '2026-07-29T11:30:00'
                }),
                task('bravo', '2026-07-20T09:00:00', {
                    workspace: '/work/bravo',
                    updated_at: '2026-07-29T11:00:00'
                }),
                task('charlie', '2026-07-20T09:00:00', {
                    workspace: '/work/charlie',
                    updated_at: '2026-07-29T10:00:00'
                }),
                task('delta', '2026-07-20T09:00:00', {
                    workspace: '/work/delta',
                    updated_at: '2026-07-29T09:00:00'
                }),
                task('echo', '2026-07-20T09:00:00', {
                    workspace: '/work/echo',
                    updated_at: '2026-07-29T08:00:00'
                }),
                task('foxtrot', '2026-07-20T09:00:00', {
                    workspace: '/work/foxtrot',
                    updated_at: '2026-07-29T07:00:00'
                }),
                task('automatic-running', '2026-07-29T12:00:00', {
                    task_status: 'running',
                    internal: true
                })
            ],
            'workspace',
            now
        );

        expect(groups.map((group) => group.id)).toEqual([
            'workspace:/work/alpha',
            'workspace:/work/bravo',
            'workspace:/work/charlie',
            'other-workspaces',
            'automatic'
        ]);
        expect(groups[0].items.map((item) => item.task.task_id)).toEqual(['alpha-latest', 'alpha-older']);
        expect(groups[3].items.map((item) => item.task.task_id)).toEqual(['delta', 'echo', 'foxtrot']);
        expect(groups[4].items.map((item) => item.task.task_id)).toEqual(['automatic-running']);
    });

    test('orders tasks by their latest available activity timestamp', () => {
        const groups = buildSidebarTaskGroups(
            [
                task('older-created-but-updated', '2026-07-29T07:00:00', {
                    updated_at: '2026-07-29T11:00:00'
                }),
                task('newer-created', '2026-07-29T10:00:00')
            ],
            'time',
            now
        );

        expect(groups[0].items.map((item) => item.task.task_id)).toEqual([
            'older-created-but-updated',
            'newer-created'
        ]);
    });
});

describe('sidebar search results', () => {
    test('returns a flat list without grouping and excludes running tasks', () => {
        const tasks = [
            task('today', '2026-07-29T09:00:00'),
            task('this-week', '2026-07-27T09:00:00'),
            task('earlier', '2026-07-19T09:00:00'),
            task('automatic', '2026-07-29T08:00:00', { internal: true }),
            task('running', '2026-07-29T11:00:00', { task_status: 'running' })
        ];

        const results = buildSidebarSearchResults(tasks);

        expect(results.map((item) => item.task.task_id)).toEqual(['today', 'automatic', 'this-week', 'earlier']);
    });

    test('orders results by latest activity timestamp across all categories', () => {
        const tasks = [
            task('old-created-recently-updated', '2026-07-19T09:00:00', {
                updated_at: '2026-07-29T11:00:00'
            }),
            task('today', '2026-07-29T09:00:00'),
            task('automatic-task', '2026-07-29T08:00:00', { internal: true })
        ];

        const results = buildSidebarSearchResults(tasks);

        expect(results.map((item) => item.task.task_id)).toEqual([
            'old-created-recently-updated',
            'today',
            'automatic-task'
        ]);
    });

    test('returns empty array when all tasks are running', () => {
        const tasks = [
            task('running-1', '2026-07-29T10:00:00', { task_status: 'running' }),
            task('running-2', '2026-07-29T11:00:00', { task_status: 'running' })
        ];

        const results = buildSidebarSearchResults(tasks);

        expect(results).toEqual([]);
    });
});
