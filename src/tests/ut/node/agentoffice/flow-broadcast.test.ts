import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { setRuntimeLocale } from '../../../../locale/index.js';
import { AgentOfficeApplication } from '../../../../main/applications/agentoffice/app.js';
import type { StaffListItem } from '../../../../main/applications/agentoffice/common.js';
import type { PrepareAgentFlowUserMessageInput } from '../../../../main/applications/agentoffice/flow/common.js';
import { AgentFlowRepository } from '../../../../main/applications/agentoffice/flow/repository.js';
import { FlowReadingScheduler } from '../../../../main/applications/agentoffice/flow/scheduler.js';

setRuntimeLocale('en-US');

function applicationFixture(t: TestContext) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-broadcast-'));
    const staffs: StaffListItem[] = ['小文', '小策'].map((name) => ({
        id: crypto.randomUUID(),
        name,
        title: '分析师',
        vendor_name: 'fixture',
        specialties: [],
        enabled: true,
        hired_at: new Date().toISOString(),
        trigger_interval: 'never',
        task_count: 0,
        message_count: 0,
        skill_count: 0
    }));
    const repo = new AgentFlowRepository(root, { listStaffs: () => staffs });
    const flow = repo.createFlow({ name: 'broadcast', goal: 'fixture', memberIds: staffs.map((staff) => staff.id) });
    const application = new AgentOfficeApplication();
    application.callWorker = async (method: string, ...args: unknown[]) => {
        if (method === 'getFlow') return repo.getFlow(args[0] as string);
        if (method === 'prepareFlowUserMessage')
            return repo.prepareUserMessage(args[0] as string, args[1] as PrepareAgentFlowUserMessageInput);
        throw new Error(`Unexpected worker method: ${method}`);
    };
    let now = Date.parse('2026-10-02T07:21:00.000Z');
    const starts: string[] = [];
    const scheduler = new FlowReadingScheduler({
        now: () => now,
        targets: async (time) => repo.reading.collectSchedulerTargets(time),
        start: async (target, trigger) => {
            const claim = repo.reading.claim(target.flowId, target.staffId, trigger);
            if (!claim.batch || claim.status !== 'claimed') return claim.status;
            repo.reading.bindTask(target.flowId, claim.batch.batchId, crypto.randomUUID());
            starts.push(claim.batch.batchId);
            return 'started';
        },
        error: (_target, error) => assert.fail(String(error))
    });
    const internal = application as unknown as {
        flowReadingScheduler: FlowReadingScheduler;
        flowUserWakeTimer?: ReturnType<typeof setTimeout>;
    };
    internal.flowReadingScheduler = scheduler;
    t.after(() => {
        scheduler.stop();
        if (internal.flowUserWakeTimer) clearTimeout(internal.flowUserWakeTimer);
        assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(root).startsWith('opendesk-broadcast-'));
        fs.rmSync(root, { recursive: true, force: true });
    });
    const send = (text: string, clientRequestId = crypto.randomUUID()) =>
        application.sendFlowMessage(flow.id, { text, clientRequestId });
    const tick = async (milliseconds = 0) => {
        now += milliseconds;
        await scheduler.tick();
    };
    return { repo, flow, staffs, send, tick, starts };
}

test('real send entry stores unmentioned messages, broadcasts and accepts more input while batches run', async (t) => {
    const f = applicationFixture(t);
    const first = await f.send('first');
    assert.equal(f.repo.readMessages(f.flow.id).length, 1);
    assert.equal(f.starts.length, 0);
    await f.tick(500);
    assert.equal(f.starts.length, 2);
    const initial = f.repo.reading.getState(f.flow.id).batches;
    assert.ok(initial.every((batch) => batch.status === 'running'));
    assert.ok(initial.every((batch) => batch.unreadMessageIds[0] === first.message_id));
    const extra = await Promise.all([f.send('second'), f.send('third'), f.send('fourth')]);
    assert.equal(f.repo.readMessages(f.flow.id).length, 4);
    await f.tick(500);
    assert.equal(f.starts.length, 2);
    const wen = initial.find((batch) => batch.staffId === f.staffs[0].id)!;
    f.repo.reading.finish(f.flow.id, wen.batchId, 'completed');
    await f.tick();
    assert.equal(f.starts.length, 3);
    const followup = f.repo.reading.getState(f.flow.id).batches.at(-1)!;
    assert.deepEqual(
        followup.unreadMessageIds,
        extra.map((message) => message.message_id)
    );
    assert.equal(followup.staffId, f.staffs[0].id);
});

test('real send entry accepts multi-mentions and ambiguous names without restricting recipients', async (t) => {
    const f = applicationFixture(t);
    await f.send('@小文 @小策 @未知一起看看');
    assert.deepEqual(
        f.repo.readMessages(f.flow.id)[0].mentions,
        f.staffs.map((staff) => staff.id)
    );
    f.staffs[1].name = '小文';
    await f.send('@小文 同名仍保存正文');
    assert.deepEqual(f.repo.readMessages(f.flow.id)[1].mentions, []);
    await f.tick(500);
    assert.equal(f.starts.length, 2);
    assert.ok(f.repo.reading.getState(f.flow.id).batches.every((batch) => batch.unreadMessageIds.length === 2));
});

test('resending the same request does not duplicate messages or reading tasks', async (t) => {
    const f = applicationFixture(t);
    const request = crypto.randomUUID();
    const first = await f.send('@小文 work', request);
    const again = await f.send('@小文 work', request);
    assert.equal(again.message_id, first.message_id);
    await f.tick(500);
    for (const batch of f.repo.reading.getState(f.flow.id).batches)
        f.repo.reading.finish(f.flow.id, batch.batchId, 'completed');
    await f.send('@小文 work', request);
    await f.tick(500);
    assert.equal(f.repo.readMessages(f.flow.id).length, 1);
    assert.equal(f.starts.length, 2);
});
