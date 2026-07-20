import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentOfficeTaskToolset } from '../../../../main/applications/agentoffice/tools.js';
import type { HistoryQuery } from '../../../../main/applications/agentoffice/common.js';

test('sendReply forwards content and declares read permission for every file', async () => {
    let received: { text?: string; files: string[] } | undefined;
    const toolset = createAgentOfficeTaskToolset({
        sendReply: async (text, files) => {
            received = { text, files };
        },
        getHistory: async () => ({ messages: [], has_more: false })
    });
    const tool = toolset.getTool('sendReply');
    assert.ok(tool);
    const result = await tool.execute({ text: 'done', files: ['/tmp/report.pdf'] });
    assert.equal(result.status, 'success');
    assert.deepEqual(received, { text: 'done', files: ['/tmp/report.pdf'] });
    assert.deepEqual(tool.getDeclaredPermissions({ text: 'done', files: ['/tmp/report.pdf'] }), [
        { resourceType: 'file', action: 'read', resourcePath: '/tmp/report.pdf' }
    ]);
});

test('sendReply getDeclaredPermissions does not crash when files is missing', async () => {
    const toolset = createAgentOfficeTaskToolset({
        sendReply: async () => undefined,
        getHistory: async () => ({ messages: [], has_more: false })
    });
    const tool = toolset.getTool('sendReply');
    assert.ok(tool);
    assert.deepEqual(tool.getDeclaredPermissions({ text: 'hi' }), []);
});

test('getHistoryMessages forwards recent and time range queries unchanged', async () => {
    const received: HistoryQuery[] = [];
    const toolset = createAgentOfficeTaskToolset({
        sendReply: async () => undefined,
        getHistory: async (query) => {
            received.push(query);
            return { messages: [], has_more: false };
        }
    });
    const tool = toolset.getTool('getHistoryMessages');
    assert.ok(tool);
    const jsonSchema = tool.toJSON().params as { type?: string };
    assert.equal(jsonSchema.type, 'object');
    assert.equal((await tool.execute({ mode: 'recent', limit: 25 })).status, 'success');
    assert.equal(
        (
            await tool.execute({
                mode: 'time_range',
                start_time: '2026-07-01',
                end_time: '2026-07-19',
                limit: 100
            })
        ).status,
        'success'
    );
    assert.deepEqual(received, [
        { mode: 'recent', limit: 25 },
        {
            mode: 'time_range',
            start_time: '2026-07-01',
            end_time: '2026-07-19',
            limit: 100
        }
    ]);
});

test('getHistoryMessages rejects an incomplete time range without producing a union schema', async () => {
    const toolset = createAgentOfficeTaskToolset({
        sendReply: async () => undefined,
        getHistory: async () => ({ messages: [], has_more: false })
    });
    const tool = toolset.getTool('getHistoryMessages');
    assert.ok(tool);

    const result = await tool.execute({ mode: 'time_range', limit: 20 });

    assert.equal(result.status, 'error');
    assert.equal((tool.toJSON().params as { type?: string }).type, 'object');
});
