import assert from 'node:assert/strict';
import test from 'node:test';
import {
    FlowReadingScheduler,
    flowReadingSlot,
    isFlowImmediateReadingEnabled,
    type FlowReadingTarget
} from '../../../../main/applications/agentoffice/flow/scheduler.js';

test('debugging defaults to immediate reading and aligned mode remains explicitly selectable', () => {
    assert.equal(isFlowImmediateReadingEnabled({}), true);
    assert.equal(isFlowImmediateReadingEnabled({ OPENDESK_AGENT_FLOW_READING_MODE: 'immediate' }), true);
    assert.equal(isFlowImmediateReadingEnabled({ OPENDESK_AGENT_FLOW_READING_MODE: 'aligned' }), false);
});

test('staff-message events wait for an executing task then start once without a timer slot', async () => {
    let now = 0;
    let busy = true;
    const triggers: string[] = [];
    const scheduler = new FlowReadingScheduler({
        now: () => now,
        targets: async () => [{ flowId: 'group', staffId: 'wen', messageEventId: 'result1', timerDue: false }],
        start: async (_target, trigger) => {
            if (busy) return 'busy';
            triggers.push(trigger);
            return 'started';
        },
        error: () => assert.fail('unexpected error')
    });
    await scheduler.tick();
    now = 500;
    await scheduler.tick();
    assert.deepEqual(triggers, []);
    now = 1500;
    await scheduler.tick();
    assert.deepEqual(triggers, []);
    busy = false;
    await scheduler.tick();
    await scheduler.tick();
    assert.deepEqual(triggers, ['message']);
});

test('Shanghai reading slots align to wall clock and skip missed slots', () => {
    assert.equal(flowReadingSlot(Date.parse('2026-10-02T15:19:59+08:00')), '2026-10-02T07:10:00.000Z');
    assert.equal(flowReadingSlot(Date.parse('2026-10-02T15:20:00+08:00')), '2026-10-02T07:20:00.000Z');
    assert.equal(flowReadingSlot(Date.parse('2026-10-02T15:54:00+08:00')), '2026-10-02T07:50:00.000Z');
});

test('user event broadcasts to every target after fixed debounce without waiting for model completion', async () => {
    let now = 0;
    const started: string[] = [];
    let targets: FlowReadingTarget[] = ['wen', 'ce'].map((staffId) => ({
        flowId: 'group',
        staffId,
        userEventId: 'u1',
        timerDue: false
    }));
    const scheduler = new FlowReadingScheduler({
        now: () => now,
        targets: async () => targets,
        start: async (target, trigger) => {
            started.push(`${target.staffId}:${trigger}`);
            return 'started';
        },
        error: () => assert.fail('unexpected error')
    });
    scheduler.notifyUser('group');
    await scheduler.tick();
    now = 400;
    scheduler.notifyUser('group');
    await scheduler.tick();
    assert.deepEqual(started, []);
    now = 500;
    await scheduler.tick();
    assert.deepEqual(started.sort(), ['ce:user', 'wen:user']);
    targets = [];
    await scheduler.tick();
    assert.equal(started.length, 2);
});

test('busy user work remains eligible; skipped timer work never becomes a completion follow-up', async () => {
    let targets: FlowReadingTarget[] = [
        { flowId: 'group', staffId: 'wen', userEventId: 'new-user', timerDue: false },
        { flowId: 'group', staffId: 'ce', timerDue: true }
    ];
    let busy = true;
    const calls: string[] = [];
    let now = 0;
    const scheduler = new FlowReadingScheduler({
        now: () => now,
        targets: async () => targets,
        start: async (target, trigger) => {
            calls.push(`${target.staffId}:${trigger}`);
            return busy ? 'busy' : 'started';
        },
        error: () => assert.fail('unexpected error')
    });
    await scheduler.tick();
    now = 500;
    targets[1].timerDue = false;
    await scheduler.tick();
    busy = false;
    await scheduler.tick();
    assert.deepEqual(calls, ['ce:timer', 'wen:user', 'wen:user']);
    targets = [{ flowId: 'group', staffId: 'wen', timerDue: false }];
    await scheduler.tick();
    assert.equal(calls.length, 3);
});

test('one failed employee does not prevent another from starting and unchanged errors do not spin', async () => {
    let now = 0;
    const targets = ['wen', 'ce'].map((staffId) => ({ flowId: 'group', staffId, userEventId: 'u1', timerDue: false }));
    const calls: string[] = [];
    const scheduler = new FlowReadingScheduler({
        now: () => now,
        targets: async () => targets,
        start: async (target) => {
            calls.push(target.staffId);
            if (target.staffId === 'wen') throw new Error('fixture');
            return 'started';
        },
        error: () => {}
    });
    await scheduler.tick();
    now = 500;
    await scheduler.tick();
    await scheduler.tick();
    assert.equal(calls.filter((id) => id === 'wen').length, 1);
    assert.ok(calls.includes('ce'));
    targets[0].userEventId = 'u2';
    now = 1000;
    await scheduler.tick();
    now = 1500;
    await scheduler.tick();
    assert.equal(calls.filter((id) => id === 'wen').length, 2);
});

test('overlapping polls do not duplicate starts and stop prevents further execution', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
        release = resolve;
    });
    let starts = 0;
    const scheduler = new FlowReadingScheduler({
        now: () => 0,
        targets: async () => [{ flowId: 'group', staffId: 'wen', timerDue: true }],
        start: async () => {
            starts++;
            await pending;
            return 'started';
        },
        error: () => {}
    });
    const first = scheduler.tick();
    await scheduler.tick();
    await Promise.resolve();
    assert.equal(starts, 1);
    scheduler.stop();
    release();
    await first;
    await scheduler.tick();
    assert.equal(starts, 1);
});
