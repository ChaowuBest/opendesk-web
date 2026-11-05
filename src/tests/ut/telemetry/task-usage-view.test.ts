import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createTaskUsageViewService } from '../../../main/telemetry/task-usage-view.js';
import type {
    UsageDashboardSummary,
    UsageTaskRankItem,
    UsageRankings
} from '../../../main/telemetry/local-telemetry.js';

function rank(taskId: string, taskName = `Recorded ${taskId}`): UsageTaskRankItem {
    return {
        task_id: taskId,
        task_name: taskName,
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        cache_read_input_tokens: 0,
        request_count: 1,
        last_used_at: '2026-01-07T12:00:00Z'
    };
}

function summary(ranks: UsageTaskRankItem[] = []): UsageDashboardSummary {
    const period = {
        task_count: 99,
        request_count: 1,
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        cache_read_input_tokens: 0,
        cache_miss_input_tokens: 10
    };
    return {
        today: { ...period },
        week: { ...period },
        daily_trend: [],
        hourly_trend: [],
        month_top_tasks: ranks,
        month_top_models: []
    };
}

function fixture(ranks: UsageTaskRankItem[] = [rank('deleted'), rank('internal'), rank('visible'), rank('unnamed')]) {
    const now = new Date(2026, 0, 7, 12);
    const tasks = new Map([
        ['visible', { created_at: new Date(2026, 0, 7, 10), task_name: 'Current name', internal: false }],
        ['internal', { created_at: new Date(2026, 0, 7, 11), task_name: 'Internal', internal: true }],
        ['unnamed', { created_at: new Date(2026, 0, 5), task_name: '', internal: false }],
        ['old', { created_at: new Date(2026, 0, 4), task_name: 'Old', internal: false }],
        ['tomorrow', { created_at: new Date(2026, 0, 8), task_name: 'Tomorrow', internal: false }]
    ]);
    const dashboard = summary(ranks);
    const rankings: UsageRankings = { tasks: ranks, models: [] };
    const readDashboard = jest.fn(async (_options?: unknown) => dashboard);
    const readRankings = jest.fn(async (_period?: string, _limit?: number) => rankings);
    let developerMode = false;
    const service = createTaskUsageViewService({
        listTasks: () => [...tasks.values()],
        getTask: (id) => tasks.get(id),
        isDeveloperMode: () => developerMode,
        isTaskVisible: (task, enabled) => enabled || task.internal !== true,
        now: () => now,
        readDashboard,
        readRankings
    });
    return {
        service,
        tasks,
        dashboard,
        rankings,
        readDashboard,
        readRankings,
        now,
        setDeveloperMode: (enabled: boolean) => (developerMode = enabled)
    };
}

function loadElectronHandler(channel: string, service: ReturnType<typeof createTaskUsageViewService>) {
    const source = ts.createSourceFile(
        'main.ts',
        readFileSync(new URL('../../../main/main.ts', import.meta.url), 'utf8'),
        ts.ScriptTarget.Latest,
        true
    );
    let expression: ts.Expression | undefined;
    const visit = (node: ts.Node) => {
        if (
            ts.isCallExpression(node) &&
            node.expression.getText(source) === 'ipcMain.handle' &&
            ts.isStringLiteral(node.arguments[0]) &&
            node.arguments[0].text === channel
        ) {
            expression = node.arguments[1];
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    expect(expression).toBeDefined();
    return runInNewContext(
        ts.transpileModule(`(${expression!.getText(source)})`, {
            compilerOptions: { target: ts.ScriptTarget.ES2022 }
        }).outputText,
        { usageViews: service }
    ) as (_event: object, params?: { rankPeriod?: string }) => Promise<unknown>;
}

afterEach(() => jest.restoreAllMocks());

describe('shared GUI task usage projection', () => {
    test('counts current tasks by local calendar day/week and enriches only existing visible rank entries', async () => {
        const data = fixture();
        const projected = await data.service.getDashboardSummary({ rankPeriod: 'week' });

        expect(data.readDashboard).toHaveBeenCalledWith({ now: data.now, rankLimit: 30, rankPeriod: 'week' });
        // Preserve desktop behavior: creation counts include internal tasks, while public ranks filter them.
        expect(projected.today.task_count).toBe(2);
        expect(projected.week.task_count).toBe(3);
        expect(projected.month_top_tasks.map((item) => [item.task_id, item.task_name])).toEqual([
            ['visible', 'Current name'],
            ['unnamed', 'Recorded unnamed']
        ]);
        expect(projected.daily_trend).toBe(data.dashboard.daily_trend);
        expect(data.dashboard.today.task_count).toBe(99);
    });

    test('reads current developer visibility and task names on every query', async () => {
        const data = fixture();
        expect((await data.service.getRankings()).tasks.map((item) => item.task_id)).toEqual(['visible', 'unnamed']);
        data.setDeveloperMode(true);
        data.tasks.get('visible')!.task_name = 'Renamed';
        const result = await data.service.getRankings({ rankPeriod: 'today' });
        expect(result.tasks.map((item) => item.task_id)).toEqual(['internal', 'visible', 'unnamed']);
        expect(result.tasks[1].task_name).toBe('Renamed');
        expect(data.readRankings.mock.calls).toEqual([
            ['month', 30],
            ['today', 30]
        ]);
    });

    test('uses a Monday calendar week across a year boundary and reevaluates the clock', async () => {
        const data = fixture([]);
        data.now.setFullYear(2026, 0, 4);
        data.tasks.clear();
        for (const [id, created_at] of [
            ['previous-sunday', new Date(2025, 11, 28, 12)],
            ['monday', new Date(2025, 11, 29, 12)],
            ['sunday', new Date(2026, 0, 4, 12)],
            ['next-monday', new Date(2026, 0, 5, 12)]
        ] as const) {
            data.tasks.set(id, { created_at, internal: false, task_name: id });
        }

        const sunday = await data.service.getDashboardSummary();
        expect([sunday.today.task_count, sunday.week.task_count]).toEqual([1, 2]);
        data.now.setDate(5);
        const monday = await data.service.getDashboardSummary();
        expect([monday.today.task_count, monday.week.task_count]).toEqual([1, 1]);
    });

    test('keeps rank ordering and selects ten existing visible tasks after filtering', async () => {
        const ranks = [rank('missing'), ...Array.from({ length: 15 }, (_, i) => rank(`task-${i}`))];
        const data = fixture(ranks);
        for (let i = 0; i < 15; i++) {
            data.tasks.set(`task-${i}`, { created_at: data.now, internal: false, task_name: `Name ${i}` });
        }
        const result = await data.service.getRankings({ rankPeriod: 'week' });
        expect(result.tasks.map((item) => item.task_id)).toEqual(Array.from({ length: 10 }, (_, i) => `task-${i}`));
        expect(result.models).toBe(data.rankings.models);
    });

    test('propagates telemetry failures so the host can preserve its error envelope', async () => {
        const data = fixture();
        data.readDashboard.mockRejectedValue(new Error('usage unavailable'));
        await expect(data.service.getDashboardSummary()).rejects.toThrow('usage unavailable');
        expect(await loadElectronHandler('usage:getDashboardSummary', data.service)({})).toEqual({
            status: 'error',
            message: 'usage unavailable'
        });
        data.readRankings.mockRejectedValue(new Error('ranking unavailable'));
        await expect(data.service.getRankings()).rejects.toThrow('ranking unavailable');
        expect(await loadElectronHandler('usage:getRankings', data.service)({})).toEqual({
            status: 'error',
            message: 'ranking unavailable'
        });
    });

    test('the actual Electron registrations consume the shared query service', async () => {
        const data = fixture();
        const dashboard = JSON.parse(
            JSON.stringify(
                await loadElectronHandler('usage:getDashboardSummary', data.service)({}, { rankPeriod: 'week' })
            )
        );
        expect(dashboard.status).toBe('ok');
        expect(dashboard.data.today.task_count).toBe(2);
        const rankings = JSON.parse(
            JSON.stringify(await loadElectronHandler('usage:getRankings', data.service)({}, { rankPeriod: 'today' }))
        );
        expect(rankings.data.tasks.map((item: UsageTaskRankItem) => item.task_id)).toEqual(['visible', 'unnamed']);
    });

    test('calendar boundaries include the late current day and exclude the next day on both DST transitions', () => {
        const moduleUrl = new URL('../../../main/telemetry/task-usage-view.ts', import.meta.url).href;
        const child = spawnSync(
            process.execPath,
            [
                '--import',
                'tsx',
                '--input-type=module',
                '-e',
                `import { createTaskUsageViewService } from ${JSON.stringify(moduleUrl)};
                 const cases = [[2026, 2, 8], [2026, 10, 1]];
                 const results = [];
                 for (const [year, month, day] of cases) {
                     const tasks = [new Date(year, month, day, 12), new Date(year, month, day, 23, 30), new Date(year, month, day + 1, 0, 30)].map(created_at => ({ created_at }));
                     const service = createTaskUsageViewService({ listTasks: () => tasks, getTask: () => null, isDeveloperMode: () => false, isTaskVisible: () => true, now: () => new Date(year, month, day, 12), readDashboard: async () => ({ today: {}, week: {}, month_top_tasks: [] }) });
                     results.push((await service.getDashboardSummary()).today.task_count);
                 }
                 console.log(JSON.stringify(results));`
            ],
            { encoding: 'utf8', env: { ...process.env, TZ: 'America/New_York' }, timeout: 10000 }
        );
        expect(child.status).toBe(0);
        expect(child.stderr).toBe('');
        expect(JSON.parse(child.stdout.trim())).toEqual([2, 2]);
    });
});
