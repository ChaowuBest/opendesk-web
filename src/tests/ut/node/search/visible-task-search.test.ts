import test from 'node:test';
import assert from 'node:assert/strict';
import { searchVisibleTasks } from '../../../../main/services/task-search/service.js';

test('task search uses current metadata after awaiting the worker without loading histories', async () => {
    let finish!: (value: any) => void;
    let tasks = [{ task_id: 'one', task_name: 'old', workspace: 'old' }];
    const waiting = searchVisibleTasks(
        {
            search: async (_query, _limit, clientId) => {
                assert.equal(clientId, 42);
                return new Promise((resolve) => {
                    finish = resolve;
                });
            }
        },
        () => tasks,
        'body',
        20,
        42
    );
    tasks = [{ task_id: 'one', task_name: 'new', workspace: 'new' }];
    finish({
        items: ['one', 'deleted'].map((taskId) => ({
            taskId,
            title: 'stale',
            workspace: 'stale',
            snippet: 'body',
            priority: 0
        })),
        hasMore: false,
        indexing: false,
        failedTasks: 0
    });
    const result = await waiting;
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].title, 'new');
    assert.equal(result.items[0].workspace, 'new');
});

test('search hides internal and unnamed tasks and validates inputs before starting a worker', async () => {
    let calls = 0;
    const service = {
        search: async () => {
            calls++;
            return {
                items: ['internal', 'unnamed', 'pending'].map((taskId) => ({
                    taskId,
                    title: '',
                    workspace: '',
                    snippet: '',
                    priority: 0
                })),
                hasMore: false,
                indexing: false,
                failedTasks: 0
            };
        }
    };
    for (const [query, limit] of [
        [null, 20],
        ['x'.repeat(201), 20],
        ['query', 0],
        ['query', 201],
        ['query', 1.5]
    ])
        await assert.rejects(
            searchVisibleTasks(service, () => [], query, limit),
            /Invalid task search request/
        );
    assert.equal(calls, 0);
    const result = await searchVisibleTasks(
        service,
        () => [
            { task_id: 'internal', task_name: 'private', internal: true },
            { task_id: 'unnamed', task_name: '' },
            { task_id: 'pending', task_name: '', name_pending: true }
        ],
        'query',
        20
    );
    assert.deepEqual(
        result.items.map((item) => item.taskId),
        ['pending']
    );
});
