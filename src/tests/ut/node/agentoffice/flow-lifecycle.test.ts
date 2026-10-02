import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { setRuntimeLocale } from '../../../../locale/index.js';
import { GlobalState } from '../../../../main/aikernel/states/global.js';
import { AgentOfficeApplication } from '../../../../main/applications/agentoffice/app.js';
import AgentOfficeWorker from '../../../../main/applications/agentoffice/worker.js';
import { AgentOfficeRepository } from '../../../../main/applications/agentoffice/repository.js';
import { AgentFlowRepository } from '../../../../main/applications/agentoffice/flow/repository.js';
import { FlowReadingScheduler } from '../../../../main/applications/agentoffice/flow/scheduler.js';
import {
    getTaskArtifactDirectory,
    getTaskDirectory,
    setCustomOpendeskDirectory
} from '../../../../main/utils/setting.js';

setRuntimeLocale('en-US');

function fixture(t: TestContext) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-lifecycle-'));
    setCustomOpendeskDirectory(root);
    t.after(() => {
        setCustomOpendeskDirectory(undefined);
        assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(root).startsWith('opendesk-lifecycle-'));
        fs.rmSync(root, { recursive: true, force: true });
    });
    const staffRepo = new AgentOfficeRepository(path.join(root, 'office'));
    const staffs = ['小文', '小策', '旁观员工'].map((name) =>
        staffRepo.createStaff({ name, vendor_name: 'fixture', title: 'Analyst' })
    );
    const repo = new AgentFlowRepository(path.join(root, 'office'), staffRepo);
    const flow = repo.createFlow({
        name: 'Mock hiring',
        goal: 'Synthetic data only',
        memberIds: staffs.map((s) => s.id)
    });
    const events: string[] = [];
    const worker = Object.create(AgentOfficeWorker.prototype) as any;
    worker.repository = staffRepo;
    worker.flowRepository = repo;
    worker.emitEvent = async (name: string) => {
        events.push(name);
    };
    const app = new AgentOfficeApplication() as any;
    app.callWorker = async (method: string, ...args: unknown[]) => worker[method](...args);
    const tasks = new Map<string, any>();
    const manager = {
        get tasks() {
            return [...tasks.values()];
        },
        getTask: (id: string) => tasks.get(id),
        removeTask: (id: string) => {
            tasks.delete(id);
        }
    };
    t.mock.method(GlobalState, 'getInstance', () => ({ taskManagerState: manager }) as any);
    const task = (turn?: Record<string, unknown>, parentId?: string) => {
        const id = crypto.randomUUID();
        const artifact = getTaskArtifactDirectory(id);
        assert.ok(path.resolve(artifact).startsWith(path.resolve(root) + path.sep));
        fs.writeFileSync(path.join(artifact, 'result.txt'), 'synthetic result', 'utf8');
        fs.writeFileSync(path.join(getTaskDirectory(), `${id}.json`), '{}', 'utf8');
        const value = {
            task_id: id,
            parent_id: parentId,
            internal: true,
            task_status: 'stopped',
            extensions: { require: () => ({ state: turn }) },
            getTurnGeneration: () => 1,
            stop() {
                this.task_status = 'stopped';
            }
        };
        tasks.set(id, value);
        return value;
    };
    const send = (text: string) =>
        repo.prepareUserMessage(flow.id, { clientRequestId: crypto.randomUUID(), text, mentions: [] }).message;
    const claim = (staffId = staffs[0].id) => repo.reading.claim(flow.id, staffId, 'user').batch!;
    return { root, app, worker, repo, staffRepo, staffs, flow, events, tasks, task, send, claim };
}

test('recovery finds created-but-unbound tasks and commits only durable successful completion', async (t) => {
    const f = fixture(t);
    const message = f.send('synthetic request');
    const completed = f.claim();
    const success = f.task({ ...completed, outcome: 'completed' });
    const interrupted = f.claim(f.staffs[1].id);
    const failed = f.task({ ...interrupted, outcome: 'failed', failure: 'interrupted' });
    f.worker.bindFlowReadingTask(f.flow.id, interrupted.batchId, failed.task_id);
    const missing = f.claim(f.staffs[2].id);
    await f.app.recoverFlowReadings();
    const state = f.repo.reading.getState(f.flow.id);
    assert.equal(state.batches[0].taskId, success.task_id);
    assert.deepEqual(
        state.batches.map((b) => b.status),
        ['completed', 'failed', 'failed']
    );
    assert.ok(state.members[completed.staffId].readMessageIds.includes(message.id));
    assert.equal(state.members[interrupted.staffId].readMessageIds.length, 0);
    assert.equal(state.members[missing.staffId].readMessageIds.length, 0);
    await f.app.recoverFlowReadings();
    assert.equal(f.repo.reading.getState(f.flow.id).batches.length, 3);
    assert.ok(
        f.repo.reading.collectSchedulerTargets(new Date().toISOString(), true).every((target) => !target.userEventId)
    );
    assert.ok(f.events.includes('flowReadingChanged'));
});

test('reply saved before read commit survives restart without replay or false read', async (t) => {
    const f = fixture(t);
    const message = f.send('synthetic request');
    const batch = f.claim();
    const task = f.task({ ...batch, outcome: 'failed' });
    f.worker.bindFlowReadingTask(f.flow.id, batch.batchId, task.task_id);
    const reply = f.worker.appendFlowReadingReply(
        f.flow.id,
        batch.batchId,
        task.task_id,
        'Shortlist: A, B',
        [],
        message.id
    );
    await f.app.recoverFlowReadings();
    assert.equal(f.repo.reading.getView(f.flow.id, true).receipts[message.id].read, 0);
    const retry = f.repo.reading.claim(f.flow.id, batch.staffId, 'manual', undefined, batch.batchId).batch!;
    const retryTask = f.task({ ...retry, outcome: 'completed' });
    f.worker.bindFlowReadingTask(f.flow.id, retry.batchId, retryTask.task_id);
    const duplicate = f.worker.appendFlowReadingReply(
        f.flow.id,
        retry.batchId,
        retryTask.task_id,
        'Shortlist: A, B',
        [],
        message.id
    );
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.messageId, reply.messageId);
    await f.app.recoverFlowReadings();
    assert.equal(f.repo.readMessages(f.flow.id).length, 2);
    assert.equal(f.repo.reading.getView(f.flow.id, true).receipts[message.id].read, 1);
});

test('public retry preserves an existing personal Task and rejects archived group writes', async (t) => {
    const f = fixture(t);
    f.send('work');
    const batch = f.claim();
    const failed = f.task({ ...batch, outcome: 'failed' });
    f.worker.bindFlowReadingTask(f.flow.id, batch.batchId, failed.task_id);
    f.worker.settleFlowReading(f.flow.id, batch.batchId, failed.task_id, 'failed');
    const personal = f.task();
    personal.task_status = 'running';
    const now = new Date().toISOString();
    f.staffRepo.upsertTask(batch.staffId, {
        task_id: personal.task_id,
        message_ids: [],
        status: 'running',
        created_at: now,
        updated_at: now
    });
    const result = await f.app.retryFlowReading(f.flow.id, batch.staffId, batch.batchId);
    assert.equal(result.status, 'busy');
    assert.equal(personal.task_status, 'running');
    assert.equal(f.repo.reading.getState(f.flow.id).batches.length, 1);
    personal.task_status = 'stopped';
    f.repo.archiveFlow(f.flow.id, f.flow.revision);
    await assert.rejects(f.app.retryFlowReading(f.flow.id, batch.staffId, batch.batchId));
    await assert.rejects(f.app.setFlowReadingInterval(f.flow.id, batch.staffId, 5));
});

test('permanent deletion discovers unbound tasks and retries failed cleanup without resurrection or collateral deletion', async (t) => {
    const f = fixture(t);
    f.send('work');
    const batch = f.claim();
    const owned = f.task({ ...batch, outcome: 'pending' });
    const child = f.task(undefined, owned.task_id);
    const unrelated = f.task();
    const otherFlow = f.repo.createFlow({ name: 'Other', goal: 'Keep unrelated work', memberIds: [f.staffs[0].id] });
    const other = f.task({ flowId: otherFlow.id, staffId: f.staffs[0].id, outcome: 'completed' });
    f.repo.prepareUserMessage(otherFlow.id, { clientRequestId: crypto.randomUUID(), text: 'other', mentions: [] });
    const archived = f.repo.archiveFlow(f.flow.id, f.flow.revision);
    const cleanup = f.app.deleteFlowTaskFiles.bind(f.app);
    let fail = true;
    f.app.deleteFlowTaskFiles = (id: string) => {
        if (fail && id === child.task_id) {
            fail = false;
            throw new Error('injected disk failure');
        }
        cleanup(id);
    };
    await assert.rejects(f.app.deleteFlow(f.flow.id, archived.revision), /injected disk failure/);
    assert.equal(f.repo.reading.getState(f.flow.id).deleting, true);
    assert.throws(() => f.repo.reading.claim(f.flow.id, batch.staffId, 'manual'));
    assert.equal(f.repo.reading.finish(f.flow.id, batch.batchId, 'completed'), undefined);
    await f.app.deleteFlow(f.flow.id, archived.revision);
    assert.equal(fs.existsSync(path.join(f.root, 'office', 'flows', f.flow.id)), false);
    for (const deleted of [owned, child]) {
        assert.equal(f.tasks.has(deleted.task_id), false);
        assert.equal(fs.existsSync(getTaskArtifactDirectory(deleted.task_id, false)), false);
        assert.equal(fs.existsSync(path.join(getTaskDirectory(), `${deleted.task_id}.json`)), false);
    }
    for (const retained of [unrelated, other]) {
        assert.equal(f.tasks.has(retained.task_id), true);
        assert.equal(fs.existsSync(getTaskArtifactDirectory(retained.task_id, false)), true);
    }
    await f.app.recoverFlowReadings();
    assert.ok(
        f.repo.reading
            .collectSchedulerTargets(new Date().toISOString(), true)
            .every((target) => target.flowId !== f.flow.id)
    );
    assert.ok(f.staffRepo.readTasks(batch.staffId).every((record) => record.flow_id !== f.flow.id));
});

test('synthetic immediate collaboration reaches a quiet fixed point with attachments, references and independent receipts', async (t) => {
    const f = fixture(t);
    const file = path.join(f.root, 'candidates.txt');
    fs.writeFileSync(file, 'A: 5 years; B: 3 years', 'utf8');
    const first = f.repo.prepareUserMessage(f.flow.id, {
        clientRequestId: crypto.randomUUID(),
        text: '小文筛选，小策协调。' + '模拟简历正文'.repeat(6000),
        attachments: [{ path: file }],
        imageDataUris: [
            'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
        ],
        mentions: []
    }).message;
    let now = Date.parse('2026-10-02T07:21:00.000Z');
    const scheduler = new FlowReadingScheduler({
        now: () => now,
        targets: async (time) => f.repo.reading.collectSchedulerTargets(time, true),
        start: async (target, trigger) => {
            const claim = f.repo.reading.claim(target.flowId, target.staffId, trigger);
            if (claim.status !== 'claimed') return claim.status;
            const batch = claim.batch!;
            const task = f.task({ ...batch, outcome: 'completed' });
            f.worker.bindFlowReadingTask(f.flow.id, batch.batchId, task.task_id);
            const messages = claim.snapshot!.messages;
            const result = messages.find((m) => m.sender.id === f.staffs[0].id);
            const advice = messages.find((m) => m.sender.id === f.staffs[1].id);
            if (target.staffId === f.staffs[0].id && !result)
                f.worker.appendFlowReadingReply(
                    f.flow.id,
                    batch.batchId,
                    task.task_id,
                    '@小策 初筛结果：A、B 符合要求',
                    [file],
                    first.id
                );
            if (target.staffId === f.staffs[1].id && result && !advice)
                f.worker.appendFlowReadingReply(
                    f.flow.id,
                    batch.batchId,
                    task.task_id,
                    '建议模拟面试时间：周一 10 点、11 点',
                    [],
                    result.id
                );
            f.worker.settleFlowReading(f.flow.id, batch.batchId, task.task_id, 'completed');
            return 'started';
        },
        error: (_target, error) => assert.fail(String(error))
    });
    t.after(() => scheduler.stop());
    for (let i = 0; i < 12; i++) {
        await scheduler.tick();
        now += 1000;
    }
    assert.equal(f.repo.readMessages(f.flow.id).length, 3);
    const count = f.tasks.size;
    for (let i = 0; i < 3; i++) {
        await scheduler.tick();
        now += 1000;
    }
    assert.equal(f.tasks.size, count);
    assert.equal(f.repo.reading.getView(f.flow.id, true).receipts[first.id].read, 3);
    f.repo.deleteMessage(f.flow.id, first.id);
    const reopened = new AgentFlowRepository(path.join(f.root, 'office'), f.staffRepo);
    assert.equal(reopened.readMessages(f.flow.id)[0].replyToMessageId, first.id);
    assert.equal(reopened.getMessage(f.flow.id, first.id), undefined);
    assert.deepEqual(
        reopened.readMessages(f.flow.id).map((m) => m.sequence),
        [2, 3]
    );
});
