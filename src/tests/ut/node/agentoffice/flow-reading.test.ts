import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { setRuntimeLocale } from '../../../../locale/index.js';
import type { TaskState } from '../../../../main/aikernel/states/tasks.js';
import type { StaffListItem } from '../../../../main/applications/agentoffice/common.js';
import {
    projectFlowConversationContext,
    queryFlowHistory
} from '../../../../main/applications/agentoffice/flow/context.js';
import { AgentFlowRepository } from '../../../../main/applications/agentoffice/flow/repository.js';
import { FlowTaskExtension } from '../../../../main/applications/agentoffice/flow/task-extension.js';
import { parseFlowMentions } from '../../../../main/applications/agentoffice/flow/routing/mentions.js';

setRuntimeLocale('en-US');

test('receipts distinguish frozen running, failed, own-message holes and departed members', (t) => {
    const f = fixture(t);
    const first = f.send('first');
    const turn = f.start();
    const second = f.send('later');
    const own = f.repo.reading.appendReply(f.flow.id, turn.batch.batchId, turn.taskId, 'result', [], first.id);
    let view = f.repo.reading.getView(f.flow.id, true);
    assert.equal(view.receipts[first.id].members[0].status, 'reading');
    assert.equal(view.receipts[second.id].members[0].status, 'unread');
    assert.equal(view.receipts[own.messageId].read, 1);
    f.repo.reading.finish(f.flow.id, turn.batch.batchId, 'failed');
    view = f.repo.reading.getView(f.flow.id, true);
    assert.equal(view.receipts[first.id].members[0].status, 'failed');
    assert.equal(view.members[0].retryBatchId, turn.batch.batchId);
    f.staffs[1].enabled = false;
    const current = f.repo.getFlow(f.flow.id);
    f.repo.setFlowMembers(f.flow.id, current.revision, [f.ce]);
    view = f.reopen().reading.getView(f.flow.id, true);
    assert.equal(view.receipts[first.id].total, 1);
    assert.equal(view.members.find((m) => m.staffId === f.wen)?.availability, 'left');
    assert.equal(view.members.find((m) => m.staffId === f.wen)?.name, '小文');
    assert.equal(view.members.find((m) => m.staffId === f.ce)?.availability, 'disabled');
});

test('per-group member periods persist, suppress current slot and retain immediate mode', (t) => {
    const f = fixture(t);
    const now = '2026-10-02T07:20:00.000Z';
    f.repo.appendStaffMessage(f.flow.id, f.ce, crypto.randomUUID(), 'result', []);
    f.repo.reading.setInterval(f.flow.id, f.wen, 5, now);
    assert.equal(f.reopen().reading.getState(f.flow.id).members[f.wen].intervalMinutes, 5);
    let view = f.repo.reading.getView(f.flow.id, false, now);
    assert.equal(view.members[0].nextTriggerAt, '2026-10-02T07:25:00.000Z');
    assert.equal(f.repo.reading.collectSchedulerTargets(now).find((m) => m.staffId === f.wen)?.timerDue, false);
    assert.equal(
        f.repo.reading.collectSchedulerTargets('2026-10-02T07:25:00.000Z').find((m) => m.staffId === f.wen)?.timerDue,
        true
    );
    view = f.repo.reading.getView(f.flow.id, true, now);
    assert.equal(view.mode, 'immediate');
    assert.equal(view.members[0].nextTriggerAt, undefined);
    assert.throws(() => f.repo.reading.setInterval(f.flow.id, f.wen, 0, now));
    assert.throws(() => f.repo.reading.setInterval(f.flow.id, f.wen, 7, now));
    const current = f.repo.getFlow(f.flow.id);
    f.repo.archiveFlow(f.flow.id, current.revision);
    assert.throws(() => f.repo.reading.setInterval(f.flow.id, f.wen, 10, now));
    assert.equal(f.repo.reading.getView(f.flow.id, false, now).members[0].nextTriggerAt, undefined);
});

test('a stale retry link cannot replay an already retried or deleted task', (t) => {
    const f = fixture(t);
    f.send('work');
    const first = f.start();
    f.repo.reading.finish(f.flow.id, first.batch.batchId, 'failed');
    const retry = f.start(f.wen, first.batch.batchId);
    f.repo.reading.finish(f.flow.id, retry.batch.batchId, 'failed');
    assert.throws(() => f.start(f.wen, first.batch.batchId));
    f.repo.reading.invalidateTask(f.flow.id, retry.taskId);
    assert.throws(() => f.start(f.wen, retry.batch.batchId));
});

function fixture(t: TestContext) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-flow-reading-'));
    t.after(() => {
        assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(root).startsWith('opendesk-flow-reading-'));
        fs.rmSync(root, { recursive: true, force: true });
    });
    const staffs: StaffListItem[] = ['小文', '小策'].map((name) => ({
        id: crypto.randomUUID(),
        name,
        title: '分析师',
        vendor_name: 'fixture',
        specialties: [],
        trigger_interval: 'never',
        enabled: true,
        hired_at: new Date().toISOString(),
        message_count: 0,
        task_count: 0,
        skill_count: 0
    }));
    const reopen = () => new AgentFlowRepository(root, { listStaffs: () => staffs });
    const repo = reopen();
    const flow = repo.createFlow({ name: '隔离测试', goal: '测试阅读', memberIds: staffs.map((s) => s.id) });
    const [wen, ce] = staffs.map((s) => s.id);
    const send = (text: string, flowId = flow.id) =>
        repo.prepareUserMessage(flowId, {
            clientRequestId: crypto.randomUUID(),
            text,
            mentions: []
        }).message;
    const start = (staffId = wen, retryOfBatchId?: string) => {
        const claim = repo.reading.claim(flow.id, staffId, 'manual', undefined, retryOfBatchId);
        assert.equal(claim.status, 'claimed');
        assert.ok(claim.batch);
        assert.ok(claim.snapshot);
        const taskId = crypto.randomUUID();
        repo.reading.bindTask(flow.id, claim.batch.batchId, taskId);
        return { batch: claim.batch, snapshot: claim.snapshot, taskId };
    };
    return { root, staffs, repo, reopen, flow, wen, ce, send, start };
}

test('full projection exceeds UI pagination and old text limits without duplicating bodies or leaking metadata', (t) => {
    const f = fixture(t);
    const messages = Array.from({ length: 205 }, (_, index) => f.send(`marker-${index}|${'正文'.repeat(90)}`));
    const snapshot = f.repo.getHistorySnapshot(f.flow.id);
    assert.equal(f.repo.getMessageHistory(f.flow.id, { limit: 20 }).messages.length, 20);
    const projected = projectFlowConversationContext(
        snapshot,
        messages.map((m) => m.id)
    );
    assert.equal(projected.messages.length, 205);
    assert.deepEqual(
        projected.unreadMessageRefs,
        messages.map((_, i) => `m${i + 1}`)
    );
    assert.ok(projected.messages.reduce((size, m) => size + (m.text?.length ?? 0), 0) > 32000);
    const json = JSON.stringify(projected);
    for (let i = 0; i < messages.length; i++) assert.equal(json.split(`marker-${i}|`).length - 1, 1);
    for (const field of ['schemaVersion', 'flowId', 'clientRequestId', 'requestHash', 'taskId', 'sha256']) {
        assert.equal(json.includes(`"${field}"`), false);
    }
    assert.equal(json.includes(f.flow.id), false);
    const page = queryFlowHistory(snapshot, { mode: 'recent', limit: 20 });
    assert.deepEqual(page.messages, projected.messages.slice(-20));
    assert.equal(page.nextCursor, 'm186');
    assert.equal(
        queryFlowHistory(snapshot, { mode: 'recent', limit: 20, cursor: page.nextCursor }).messages.at(-1)?.message,
        'm185'
    );
    assert.throws(() => queryFlowHistory(snapshot, { mode: 'recent', limit: 20, cursor: 'm99999' }));
});

test('deleted references remain tombstones; departed sender name and attachment metadata survive projection', (t) => {
    const f = fixture(t);
    const original = f.send('deleted secret');
    const file = path.join(f.root, '模拟.txt');
    fs.writeFileSync(file, 'attachment body not in prompt', 'utf8');
    f.repo.appendStaffMessage(f.flow.id, f.wen, crypto.randomUUID(), 'result', [file], 'message', original.id);
    f.repo.deleteMessage(f.flow.id, original.id);
    f.staffs.shift();
    const snapshot = f.reopen().getHistorySnapshot(f.flow.id);
    const projected = projectFlowConversationContext(snapshot, []);
    assert.deepEqual(projected.messages[0], { message: 'm1', deleted: true });
    assert.deepEqual(projected.messages[1].sender, { name: '小文', title: '分析师' });
    assert.equal(projected.messages[1].replyTo, 'm1');
    assert.equal(projected.messages[1].attachments?.[0].name, '模拟.txt');
    assert.equal(JSON.stringify(projected).includes('deleted secret'), false);
    assert.equal(JSON.stringify(projected).includes('attachment body not in prompt'), false);
    assert.equal(f.send('next').sequence, 3);
});

test('silent completion commits only one employee frozen set and persists across repository reopen', (t) => {
    const f = fixture(t);
    const first = f.send('first');
    const run = f.start();
    const late = f.send('late');
    assert.deepEqual(run.batch.unreadMessageIds, [first.id]);
    assert.deepEqual(
        run.snapshot.messages.map((m) => m.id),
        [first.id]
    );
    f.repo.reading.finish(f.flow.id, run.batch.batchId, 'completed');
    const state = f.reopen().reading.getState(f.flow.id);
    assert.deepEqual(state.members[f.wen].readMessageIds, [first.id]);
    assert.deepEqual(state.members[f.wen].pendingUserMessageIds, [late.id]);
    assert.deepEqual(state.members[f.ce].readMessageIds, []);
    assert.equal(state.batches.length, 1);
    assert.equal(f.repo.readMessages(f.flow.id).length, 2);
    f.repo.reading.finish(f.flow.id, run.batch.batchId, 'failed', 'late callback');
    assert.equal(f.repo.reading.getState(f.flow.id).batches[0].status, 'completed');
});

test('simultaneous requests serialize to one claim while another employee can claim', async (t) => {
    const f = fixture(t);
    f.send('work');
    const claims = await Promise.all(
        Array.from({ length: 8 }, () => Promise.resolve().then(() => f.repo.reading.claim(f.flow.id, f.wen, 'manual')))
    );
    assert.equal(claims.filter((c) => c.status === 'claimed').length, 1);
    assert.equal(claims.filter((c) => c.status === 'busy').length, 7);
    assert.equal(f.repo.reading.claim(f.flow.id, f.ce, 'manual').status, 'claimed');
    const other = f.repo.createFlow({ name: 'other', goal: 'other', memberIds: [f.wen] });
    f.send('other work', other.id);
    assert.equal(f.repo.reading.claim(other.id, f.wen, 'manual').status, 'busy');
});

test('empty history creates no batch and duplicate source events reuse their original batch', (t) => {
    const f = fixture(t);
    assert.equal(f.repo.reading.claim(f.flow.id, f.wen, 'manual').status, 'empty');
    assert.equal(f.repo.reading.getState(f.flow.id).batches.length, 0);
    const message = f.send('work');
    const first = f.repo.reading.claim(f.flow.id, f.wen, 'mention', message.id);
    assert.ok(first.batch);
    const duplicate = f.repo.reading.claim(f.flow.id, f.wen, 'mention', message.id);
    assert.equal(duplicate.status, 'existing');
    assert.equal(duplicate.batch?.batchId, first.batch.batchId);
});

for (const status of ['failed', 'cancelled'] as const) {
    test(`${status} preserves unread, own reply does not skip holes, explicit retry deduplicates committed replies`, (t) => {
        const f = fixture(t);
        const first = f.send('work');
        const run = f.start();
        const reply = f.repo.reading.appendReply(f.flow.id, run.batch.batchId, run.taskId, 'result', [], first.id);
        assert.equal(reply.created, true);
        assert.deepEqual(f.repo.reading.appendReply(f.flow.id, run.batch.batchId, run.taskId, 'result', [], first.id), {
            messageId: reply.messageId,
            created: false
        });
        f.repo.reading.finish(f.flow.id, run.batch.batchId, status, 'fixture');
        const member = f.repo.reading.getState(f.flow.id).members[f.wen];
        assert.deepEqual(member.readMessageIds, [reply.messageId]);
        assert.deepEqual(member.pendingUserMessageIds, [first.id]);
        assert.throws(() => f.repo.reading.claim(f.flow.id, f.wen, 'manual'));
        const retry = f.start(f.wen, run.batch.batchId);
        assert.deepEqual(
            f.repo.reading.appendReply(f.flow.id, retry.batch.batchId, retry.taskId, 'result', [], first.id),
            {
                messageId: reply.messageId,
                created: false
            }
        );
        f.repo.reading.finish(f.flow.id, retry.batch.batchId, 'completed');
        assert.equal(f.repo.readMessages(f.flow.id).length, 2);
        assert.equal(f.repo.reading.getState(f.flow.id).members[f.wen].failureCount, 0);
    });
}

test('reply validation rejects other-group, future, deleted and wrong-task references', (t) => {
    const f = fixture(t);
    const first = f.send('first');
    const other = f.repo.createFlow({ name: 'other', goal: 'other', memberIds: [f.wen] });
    const foreign = f.send('foreign', other.id);
    const run = f.start();
    const future = f.send('future');
    for (const reference of [foreign.id, future.id]) {
        assert.throws(() =>
            f.repo.reading.appendReply(f.flow.id, run.batch.batchId, run.taskId, 'reply', [], reference)
        );
    }
    assert.throws(() => f.repo.reading.appendReply(f.flow.id, run.batch.batchId, crypto.randomUUID(), 'reply', []));
    f.repo.deleteMessage(f.flow.id, first.id);
    assert.throws(() => f.repo.reading.appendReply(f.flow.id, run.batch.batchId, run.taskId, 'reply', [], first.id));
});

test('reopen reconstructs a lost reply receipt and deleted replies are not resurrected by retries', (t) => {
    const f = fixture(t);
    f.send('work');
    const run = f.start();
    const reply = f.repo.reading.appendReply(f.flow.id, run.batch.batchId, run.taskId, 'result', []);
    const stateFile = path.join(f.repo.flowDirectory(f.flow.id), 'reading.json');
    const state = f.repo.reading.getState(f.flow.id);
    state.batches[0].replies = [];
    fs.writeFileSync(stateFile, JSON.stringify(state), 'utf8');
    const recovered = f.reopen().reading.getState(f.flow.id);
    assert.equal(recovered.batches[0].replies[0].messageId, reply.messageId);
    f.repo.deleteMessage(f.flow.id, reply.messageId);
    f.repo.reading.finish(f.flow.id, run.batch.batchId, 'failed');
    const retry = f.start(f.wen, run.batch.batchId);
    assert.equal(f.repo.reading.appendReply(f.flow.id, retry.batch.batchId, retry.taskId, 'result', []).created, false);
    assert.equal(f.repo.readMessages(f.flow.id).length, 1);
});

test('attachments deduplicate by bytes and name, but changed bytes are a new reply', (t) => {
    const f = fixture(t);
    f.send('work');
    const run = f.start();
    const file = path.join(f.root, 'result.txt');
    fs.writeFileSync(file, 'first', 'utf8');
    const append = () => f.repo.reading.appendReply(f.flow.id, run.batch.batchId, run.taskId, 'result', [file]);
    assert.equal(append().created, true);
    assert.equal(append().created, false);
    fs.writeFileSync(file, 'changed', 'utf8');
    assert.equal(append().created, true);
});

test('disabled or removed employees cannot complete or send and rejoining preserves progress', (t) => {
    const f = fixture(t);
    const first = f.send('work');
    const run = f.start();
    f.staffs[0].enabled = false;
    assert.throws(() => f.repo.reading.appendReply(f.flow.id, run.batch.batchId, run.taskId, 'result', []));
    assert.equal(f.repo.reading.finish(f.flow.id, run.batch.batchId, 'completed')?.status, 'cancelled');
    assert.deepEqual(f.repo.reading.getState(f.flow.id).members[f.wen].readMessageIds, []);
    assert.throws(() => f.repo.reading.claim(f.flow.id, f.wen, 'manual'));
    f.staffs[0].enabled = true;
    const retry = f.start(f.wen, run.batch.batchId);
    f.repo.reading.finish(f.flow.id, retry.batch.batchId, 'completed');
    const changed = f.repo.setFlowMembers(f.flow.id, f.flow.revision, [f.ce]);
    assert.throws(() => f.repo.reading.claim(f.flow.id, f.wen, 'manual'));
    f.repo.setFlowMembers(f.flow.id, changed.revision, [f.wen, f.ce]);
    assert.deepEqual(f.repo.reading.getState(f.flow.id).members[f.wen].readMessageIds, [first.id]);
});

test('task invalidation prevents a late completion from committing read receipts', (t) => {
    const f = fixture(t);
    f.send('work');
    const run = f.start();
    f.repo.reading.invalidateTask(f.flow.id, run.taskId);
    assert.equal(f.repo.reading.finish(f.flow.id, run.batch.batchId, 'completed'), undefined);
    const state = f.reopen().reading.getState(f.flow.id);
    assert.equal(state.batches[0].status, 'cancelled');
    assert.ok(state.batches[0].taskDeletedAt);
    assert.deepEqual(state.members[f.wen].readMessageIds, []);
});

test('deletion blocks claims and callbacks without recreating files or deleting another group', (t) => {
    const f = fixture(t);
    f.send('work');
    const run = f.start();
    const other = f.repo.createFlow({ name: 'other', goal: 'other', memberIds: [f.ce] });
    f.send('keep', other.id);
    assert.deepEqual(f.repo.rememberTasks(f.flow.id, []), [run.taskId]);
    const archived = f.repo.archiveFlow(f.flow.id, f.flow.revision);
    assert.throws(() => f.repo.reading.claim(f.flow.id, f.ce, 'manual'));
    assert.deepEqual(f.repo.reading.blockDeletion(f.flow.id), [run.taskId]);
    assert.throws(() => f.repo.reading.appendReply(f.flow.id, run.batch.batchId, run.taskId, 'late', []));
    assert.equal(f.repo.reading.finish(f.flow.id, run.batch.batchId, 'completed'), undefined);
    f.repo.deleteFlow(f.flow.id, archived.revision);
    assert.throws(() => f.repo.reading.finish(f.flow.id, run.batch.batchId, 'completed'));
    assert.equal(fs.existsSync(f.repo.flowDirectory(f.flow.id)), false);
    assert.equal(f.repo.readMessages(other.id).length, 1);
});

test('mentions are semantic: multiple, unknown, ambiguous and disabled names never reject a message', (t) => {
    const f = fixture(t);
    assert.deepEqual(parseFlowMentions('@小文 @小策 @未知', f.repo.getFlow(f.flow.id)), [f.wen, f.ce]);
    f.staffs[1].enabled = false;
    assert.deepEqual(parseFlowMentions('@小策', f.repo.getFlow(f.flow.id)), [f.ce]);
    f.staffs[1].name = '小文';
    assert.deepEqual(parseFlowMentions('@小文', f.repo.getFlow(f.flow.id)), []);
});

test('new groups wait for next aligned slot; persisted slots prevent restart duplicates and sleep catch-up storms', (t) => {
    const f = fixture(t);
    f.repo.appendStaffMessage(f.flow.id, f.ce, crypto.randomUUID(), '@小文 result');
    const due = (repo: AgentFlowRepository, time: string) =>
        repo.reading.collectSchedulerTargets(time).filter((target) => target.timerDue);
    assert.equal(due(f.repo, '2026-10-02T07:19:59.000Z').length, 0);
    assert.equal(due(f.repo, '2026-10-02T07:20:00.000Z').length, 1);
    assert.equal(due(f.reopen(), '2026-10-02T07:20:00.900Z').length, 0);
    assert.equal(due(f.repo, '2026-10-02T07:54:00.000Z').length, 1);
    assert.equal(due(f.repo, '2026-10-02T07:54:01.000Z').length, 0);
    assert.equal(due(f.repo, '2026-10-02T07:30:00.000Z').length, 0);
});

test('timer busy skip is durable and employee-only arrival never causes user follow-up', (t) => {
    const f = fixture(t);
    f.send('first');
    const run = f.start();
    f.repo.reading.collectSchedulerTargets('2026-10-02T07:19:00.000Z');
    f.repo.appendStaffMessage(f.flow.id, f.ce, crypto.randomUUID(), '@小文 result');
    const due = f.repo.reading
        .collectSchedulerTargets('2026-10-02T07:20:00.000Z')
        .find((target) => target.staffId === f.wen);
    assert.equal(due?.timerDue, true);
    assert.equal(f.repo.reading.claim(f.flow.id, f.wen, 'timer').status, 'busy');
    f.repo.reading.finish(f.flow.id, run.batch.batchId, 'completed');
    const after = f.repo.reading
        .collectSchedulerTargets('2026-10-02T07:20:01.000Z')
        .find((target) => target.staffId === f.wen);
    assert.equal(after?.timerDue, false);
    assert.equal(after?.userEventId, undefined);
    assert.equal(f.repo.reading.claim(f.flow.id, f.wen, 'user').status, 'empty');
    assert.equal(
        f.repo.reading.collectSchedulerTargets('2026-10-02T07:30:00.000Z').find((target) => target.staffId === f.wen)
            ?.timerDue,
        true
    );
});

test('user arrival during a batch schedules one frozen follow-up containing all new unread', (t) => {
    const f = fixture(t);
    f.send('first');
    const run = f.start();
    const extra = [f.send('second'), f.send('third'), f.send('fourth')];
    f.repo.reading.finish(f.flow.id, run.batch.batchId, 'completed');
    const targets = f.repo.reading.collectSchedulerTargets('2026-10-02T07:21:00.000Z');
    assert.equal(targets.find((target) => target.staffId === f.wen)?.userEventId, extra[2].id);
    const next = f.repo.reading.claim(f.flow.id, f.wen, 'user');
    assert.deepEqual(
        next.batch?.unreadMessageIds,
        extra.map((message) => message.id)
    );
    assert.equal(f.repo.reading.claim(f.flow.id, f.wen, 'user').status, 'busy');
});

test('failed old user batch never self-retries, but a new user event may reevaluate all unread', (t) => {
    const f = fixture(t);
    const old = f.send('old');
    const run = f.start();
    f.repo.reading.finish(f.flow.id, run.batch.batchId, 'failed', 'fixture');
    const targets = f.repo.reading.collectSchedulerTargets('2026-10-02T07:20:00.000Z');
    const target = targets.find((candidate) => candidate.staffId === f.wen);
    assert.equal(target?.userEventId, undefined);
    assert.equal(target?.timerDue, false);
    assert.equal(f.repo.reading.claim(f.flow.id, f.wen, 'user').status, 'empty');
    assert.equal(f.repo.reading.claim(f.flow.id, f.wen, 'timer').status, 'empty');
    const recent = f.send('new');
    const next = f.repo.reading.claim(f.flow.id, f.wen, 'user');
    assert.deepEqual(next.batch?.unreadMessageIds, [old.id, recent.id]);
});

test('disabled, removed, archived and deleting members have no scheduler targets', (t) => {
    const f = fixture(t);
    f.send('work');
    f.staffs[0].enabled = false;
    assert.deepEqual(
        f.repo.reading.collectSchedulerTargets('2026-10-02T07:20:00.000Z').map((target) => target.staffId),
        [f.ce]
    );
    f.repo.reading.blockDeletion(f.flow.id);
    assert.deepEqual(f.repo.reading.collectSchedulerTargets('2026-10-02T07:30:00.000Z'), []);
    f.repo.archiveFlow(f.flow.id, f.flow.revision);
    assert.deepEqual(f.repo.reading.collectSchedulerTargets('2026-10-02T07:40:00.000Z'), []);
});

test('archiving between batch binding and submission rejects the execution lease', (t) => {
    const f = fixture(t);
    f.send('work');
    const run = f.start();
    f.repo.archiveFlow(f.flow.id, f.flow.revision);
    assert.throws(() => f.repo.reading.assertRunning(f.flow.id, run.batch.batchId, run.taskId));
});

test('a newly added member keeps historical messages unread until the next timer, while new user messages wake it', (t) => {
    const f = fixture(t);
    const old = f.send('before joining');
    const newcomer = { ...f.staffs[0], id: crypto.randomUUID(), name: '新人' };
    f.staffs.push(newcomer);
    f.repo.setFlowMembers(
        f.flow.id,
        f.flow.revision,
        f.staffs.map((staff) => staff.id)
    );
    let target = f.repo.reading
        .collectSchedulerTargets('2026-10-02T07:21:00.000Z')
        .find((candidate) => candidate.staffId === newcomer.id);
    assert.equal(target?.userEventId, undefined);
    assert.equal(target?.timerDue, false);
    assert.deepEqual(f.repo.reading.getState(f.flow.id).members[newcomer.id].readMessageIds, []);
    assert.equal(f.repo.reading.claim(f.flow.id, newcomer.id, 'user').status, 'empty');
    assert.equal(
        f.repo.reading
            .collectSchedulerTargets('2026-10-02T07:30:00.000Z')
            .find((candidate) => candidate.staffId === newcomer.id)?.timerDue,
        true
    );
    const fresh = f.send('after joining');
    target = f.repo.reading
        .collectSchedulerTargets('2026-10-02T07:30:01.000Z')
        .find((candidate) => candidate.staffId === newcomer.id);
    assert.equal(target?.userEventId, fresh.id);
    assert.deepEqual(f.repo.reading.claim(f.flow.id, newcomer.id, 'user').batch?.unreadMessageIds, [old.id, fresh.id]);
});

test('immediate debugging reads staff messages without a clock slot, waits for busy batches and does not self-loop', (t) => {
    const f = fixture(t);
    f.send('work');
    const run = f.start();
    const reply = f.repo.appendStaffMessage(f.flow.id, f.ce, crypto.randomUUID(), 'new result');
    const collect = () => f.repo.reading.collectSchedulerTargets('2026-10-02T07:23:00.000Z', true);
    assert.equal(collect().find((target) => target.staffId === f.wen)?.messageEventId, reply.id);
    assert.equal(collect().find((target) => target.staffId === f.wen)?.timerDue, false);
    assert.equal(f.repo.reading.claim(f.flow.id, f.wen, 'message').status, 'busy');
    f.repo.reading.finish(f.flow.id, run.batch.batchId, 'completed');
    const next = f.repo.reading.claim(f.flow.id, f.wen, 'message');
    assert.equal(next.status, 'claimed');
    assert.deepEqual(next.batch?.unreadMessageIds, [reply.id]);
    assert.ok(next.batch);
    f.repo.reading.bindTask(f.flow.id, next.batch.batchId, crypto.randomUUID());
    f.repo.reading.finish(f.flow.id, next.batch.batchId, 'completed');
    assert.equal(collect().find((target) => target.staffId === f.wen)?.messageEventId, undefined);
    assert.equal(collect().find((target) => target.staffId === f.ce)?.messageEventId, undefined);
    assert.equal(f.repo.reading.claim(f.flow.id, f.wen, 'message').status, 'empty');
});

test('immediate debugging does not retry unchanged failed staff messages or awaken on system errors', (t) => {
    const f = fixture(t);
    f.repo.appendStaffMessage(f.flow.id, f.ce, crypto.randomUUID(), 'result');
    const run = f.start();
    f.repo.reading.finish(f.flow.id, run.batch.batchId, 'failed');
    f.repo.appendSystemMessage(f.flow.id, 'fixture error', undefined, 'error');
    const collect = () => f.repo.reading.collectSchedulerTargets('2026-10-02T07:23:00.000Z', true);
    assert.equal(collect().find((target) => target.staffId === f.wen)?.messageEventId, undefined);
    assert.equal(f.repo.reading.claim(f.flow.id, f.wen, 'message').status, 'empty');
    const fresh = f.repo.appendStaffMessage(f.flow.id, f.ce, crypto.randomUUID(), 'new result');
    assert.equal(collect().find((target) => target.staffId === f.wen)?.messageEventId, fresh.id);
    assert.equal(f.repo.reading.claim(f.flow.id, f.wen, 'message').status, 'claimed');
});

function taskFixture() {
    let generation = 1;
    let stops = 0;
    const task = {
        persistLater() {},
        getTurnGeneration: () => generation,
        stop() {
            stops++;
            extension.onTaskLifecycle({ type: 'stop', reason: 'system' });
        }
    } as unknown as TaskState;
    const extension = new FlowTaskExtension(task);
    const identity = {
        flowId: crypto.randomUUID(),
        staffId: crypto.randomUUID(),
        batchId: crypto.randomUUID(),
        generation: 1,
        model: 'fixture-model'
    };
    extension.configure(identity);
    return { extension, identity, changeGeneration: () => generation++, stopCount: () => stops };
}

test('Task extension credits silent settled turns without imposing a kernel context policy', async () => {
    const { extension } = taskFixture();
    extension.onTaskLifecycle({ type: 'agent_changed' });
    assert.equal(extension.state?.outcome, 'pending');
    await extension.handleUserMessage();
    await extension.checkpoint('after_finish_hooks');
    extension.onTurnSettled();
    await extension.waitUntilSettled();
    assert.equal(extension.state?.outcome, 'completed');
    assert.equal('getFullContextPolicy' in extension, false);
    await assert.rejects(() => extension.handleUserMessage());
});

test('Task extension never credits failed, cancelled, changed-generation or edited-history turns', async () => {
    for (const kind of ['failed', 'cancelled', 'generation', 'history'] as const) {
        const f = taskFixture();
        await f.extension.handleUserMessage();
        if (kind === 'failed') f.extension.onTurnIterationFailed('fixture failure');
        if (kind === 'cancelled') f.extension.onTaskLifecycle({ type: 'stop', reason: 'user' });
        if (kind === 'generation') f.changeGeneration();
        if (kind === 'history') f.extension.onHistoryMutation();
        f.extension.onTurnSettled();
        await f.extension.waitUntilSettled();
        assert.notEqual(f.extension.state?.outcome, 'completed');
        if (kind === 'history') assert.equal(f.stopCount(), 1);
    }
});

test('restored running turns fail without replay while durable completed markers remain complete', async () => {
    const f = taskFixture();
    await f.extension.handleUserMessage();
    const running = structuredClone(f.extension.serialize());
    const restored = taskFixture().extension;
    restored.restore(running, true);
    assert.equal(restored.state?.outcome, 'failed');
    await assert.rejects(() => restored.handleUserMessage());
    await f.extension.checkpoint('after_finish_hooks');
    f.extension.onTurnSettled();
    restored.restore(structuredClone(f.extension.serialize()), false);
    assert.equal(restored.state?.outcome, 'completed');
});

test('a kernel stop without normal finish checkpoints cannot mark group history read', async () => {
    const { extension } = taskFixture();
    await extension.handleUserMessage();
    extension.onTurnSettled();
    await extension.waitUntilSettled();
    assert.equal(extension.state?.outcome, 'failed');
});

test('a rejected finish followed by a failed completion cannot reuse the earlier finish checkpoint', async () => {
    const { extension } = taskFixture();
    await extension.handleUserMessage();
    await extension.checkpoint('after_finish_hooks');
    await extension.checkpoint('after_hook_backoff');
    extension.onTurnSettled();
    assert.equal(extension.state?.outcome, 'failed');
});

test('a kernel completion error remains failed even if normal finish hooks run', async () => {
    const task = {
        persistLater() {},
        getTurnGeneration: () => 1,
        chat_context: { messages: [{ role: 'assistant', content: [{ type: 'error', message: 'provider failure' }] }] }
    } as unknown as TaskState;
    const extension = new FlowTaskExtension(task);
    extension.configure({ ...taskFixture().identity });
    await extension.handleUserMessage();
    await extension.checkpoint('after_finish_hooks');
    extension.onTurnSettled();
    assert.equal(extension.state?.outcome, 'failed');
});
