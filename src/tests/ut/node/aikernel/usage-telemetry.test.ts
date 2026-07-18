/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile, readdir, mkdir } from 'node:fs/promises';
import { Usage } from '../../../../main/aikernel/messages.js';
import {
    getUsageTelemetryDirectory,
    readUsageEvents,
    recordTaskUsage,
    summarizeUsageEvents,
    cleanupOldUsageEvents,
    type TokenUsageCounters,
    type UsageTelemetryEvent
} from '../../../../main/telemetry/local-telemetry.js';
import { setCustomOpendeskDirectory } from '../../../../main/utils/setting.js';

function counters(input: number, output: number): TokenUsageCounters {
    return {
        prompt_tokens: input,
        completion_tokens: output,
        total_tokens: input + output,
        input_tokens: input,
        output_tokens: output,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0
    };
}

function event(
    taskId: string,
    timestamp: string,
    input: number,
    output: number,
    taskName?: string,
    taskCreatedAt: string = timestamp,
    model?: string
): UsageTelemetryEvent {
    return {
        version: 1,
        id: `${taskId}-${timestamp}`,
        timestamp,
        task_id: taskId,
        task_name: taskName,
        task_created_at: taskCreatedAt,
        model,
        request_type: 'streamComplete',
        usage: counters(input, output)
    };
}

test('recordTaskUsage appends normalized events under telemetry directory', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opendesk-usage-telemetry-'));
    setCustomOpendeskDirectory(tempRoot);
    try {
        const recorded = await recordTaskUsage({
            taskId: 'task-alpha',
            taskName: 'alpha',
            parentId: null,
            model: 'demo-model',
            provider: 'openai',
            requestType: 'complete',
            usage: new Usage(12, 5, 17),
            taskCreatedAt: new Date('2026-07-09T11:30:00.000Z'),
            timestamp: new Date('2026-07-09T12:00:00.000Z')
        });

        assert.equal(recorded?.usage.input_tokens, 12);
        assert.equal(recorded?.usage.output_tokens, 5);
        assert.equal(recorded?.model, 'demo-model');
        assert.equal(recorded?.task_created_at, '2026-07-09T11:30:00.000Z');

        const files = await readdir(getUsageTelemetryDirectory());
        const dailyFile = files.find((f) => /^usage-events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
        assert.ok(dailyFile, 'per-day usage events file should exist');
        const raw = await readFile(path.join(getUsageTelemetryDirectory(), dailyFile!), 'utf8');
        assert.match(raw, /"task_id":"task-alpha"/);
        assert.match(raw, /"task_created_at":"2026-07-09T11:30:00.000Z"/);

        const events = await readUsageEvents();
        assert.equal(events.length, 1);
        assert.equal(events[0].task_name, 'alpha');
        assert.equal(events[0].usage.total_tokens, 17);
    } finally {
        setCustomOpendeskDirectory(undefined);
        await rm(tempRoot, { recursive: true, force: true });
    }
});

test('summarizeUsageEvents builds period totals, daily trend, and monthly task ranking', () => {
    const summary = summarizeUsageEvents(
        [
            event('task-a', '2026-07-09T10:00:00.000Z', 100, 50, 'A', '2026-07-09T10:00:00.000Z', 'gpt-4o'),
            event('task-a', '2026-07-09T11:00:00.000Z', 30, 20, 'A', '2026-07-09T10:00:00.000Z', 'gpt-4o'),
            event(
                'task-created-yesterday',
                '2026-07-09T11:30:00.000Z',
                5,
                5,
                'Created Yesterday',
                '2026-07-08T12:00:00.000Z',
                'claude-3.5'
            ),
            event('task-b', '2026-07-07T10:00:00.000Z', 40, 10, 'B', '2026-07-07T10:00:00.000Z', 'gpt-4o'),
            event('task-c', '2026-07-01T10:00:00.000Z', 200, 100, 'C', '2026-07-01T10:00:00.000Z', 'claude-3.5'),
            event('task-old', '2026-06-20T10:00:00.000Z', 500, 500, 'Old', '2026-06-20T10:00:00.000Z', 'gpt-4o')
        ],
        {
            now: new Date('2026-07-09T12:00:00.000Z'),
            trendDays: 4,
            rankLimit: 2
        }
    );

    assert.equal(summary.today.task_count, 1);
    assert.equal(summary.today.request_count, 3);
    assert.equal(summary.today.input_tokens, 135);
    assert.equal(summary.today.output_tokens, 75);
    assert.equal(summary.today.total_tokens, 210);

    assert.equal(summary.week.task_count, 3);
    assert.equal(summary.week.request_count, 4);
    assert.equal(summary.week.total_tokens, 260);

    assert.deepEqual(
        summary.daily_trend.map((point) => point.day),
        ['2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09']
    );
    assert.equal(summary.daily_trend[1].total_tokens, 50);
    assert.equal(summary.daily_trend[3].total_tokens, 210);

    assert.equal(summary.month_top_tasks.length, 2);
    assert.equal(summary.month_top_tasks[0].task_id, 'task-c');
    assert.equal(summary.month_top_tasks[0].total_tokens, 300);
    assert.equal(summary.month_top_tasks[1].task_id, 'task-a');
    assert.equal(summary.month_top_tasks[1].total_tokens, 200);

    // Model ranking
    assert.equal(summary.month_top_models.length, 2);
    assert.equal(summary.month_top_models[0].model, 'claude-3.5');
    assert.equal(summary.month_top_models[0].input_tokens, 205);
    assert.equal(summary.month_top_models[0].output_tokens, 105);
    assert.equal(summary.month_top_models[0].total_tokens, 310);
    assert.equal(summary.month_top_models[0].request_count, 2);
    assert.equal(summary.month_top_models[1].model, 'gpt-4o');
    assert.equal(summary.month_top_models[1].input_tokens, 170);
    assert.equal(summary.month_top_models[1].output_tokens, 80);
    assert.equal(summary.month_top_models[1].total_tokens, 250);
    assert.equal(summary.month_top_models[1].request_count, 3);

    // Hourly trend (today)
    assert.equal(summary.hourly_trend.length, 24);
    assert.equal(summary.hourly_trend[0].hour, '00:00');
    assert.equal(summary.hourly_trend[23].hour, '23:00');
    const hourlyTotal = summary.hourly_trend.reduce((sum, p) => sum + p.total_tokens, 0);
    assert.equal(hourlyTotal, 210);
});

test('cleanupOldUsageEvents deletes files older than retention period and keeps recent ones', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opendesk-usage-cleanup-'));
    setCustomOpendeskDirectory(tempRoot);
    try {
        const dir = getUsageTelemetryDirectory();
        await mkdir(dir, { recursive: true });

        const now = new Date('2026-07-09T12:00:00.000Z');
        const oldDate = '2026-06-01'; // 38+ days before now
        const recentDate = '2026-07-08';

        // Create old per-day file
        await writeFile(
            path.join(dir, `usage-events-${oldDate}.jsonl`),
            JSON.stringify(event('task-old', '2026-06-01T10:00:00.000Z', 10, 5, 'Old')) + '\n',
            'utf8'
        );
        // Create recent per-day file
        await writeFile(
            path.join(dir, `usage-events-${recentDate}.jsonl`),
            JSON.stringify(event('task-recent', '2026-07-08T10:00:00.000Z', 20, 10, 'Recent')) + '\n',
            'utf8'
        );

        cleanupOldUsageEvents(30, now);

        const remaining = await readdir(dir);
        const remainingDaily = remaining.filter((f) => /^usage-events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
        assert.equal(remainingDaily.length, 1, 'only the recent file should remain');
        assert.ok(
            remainingDaily[0].includes(recentDate),
            `remaining file should be ${recentDate}, got ${remainingDaily[0]}`
        );
    } finally {
        setCustomOpendeskDirectory(undefined);
        await rm(tempRoot, { recursive: true, force: true });
    }
});

test('readUsageEvents aggregates events from multiple per-day files', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opendesk-usage-multi-'));
    setCustomOpendeskDirectory(tempRoot);
    try {
        const dir = getUsageTelemetryDirectory();
        await mkdir(dir, { recursive: true });

        await writeFile(
            path.join(dir, 'usage-events-2026-07-08.jsonl'),
            JSON.stringify(
                event('task-a', '2026-07-08T10:00:00.000Z', 100, 50, 'A', '2026-07-08T10:00:00.000Z', 'gpt-4o')
            ) + '\n',
            'utf8'
        );
        await writeFile(
            path.join(dir, 'usage-events-2026-07-09.jsonl'),
            JSON.stringify(
                event('task-b', '2026-07-09T10:00:00.000Z', 30, 20, 'B', '2026-07-09T10:00:00.000Z', 'claude-3.5')
            ) + '\n',
            'utf8'
        );

        const events = await readUsageEvents();
        assert.equal(events.length, 2);
        const taskIds = events.map((e) => e.task_id).sort();
        assert.deepEqual(taskIds, ['task-a', 'task-b']);
        const models = events.map((e) => e.model).sort();
        assert.deepEqual(models, ['claude-3.5', 'gpt-4o']);
    } finally {
        setCustomOpendeskDirectory(undefined);
        await rm(tempRoot, { recursive: true, force: true });
    }
});
