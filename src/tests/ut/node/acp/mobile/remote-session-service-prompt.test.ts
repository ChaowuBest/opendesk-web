import assert from 'node:assert/strict';
import test from 'node:test';
import {
    RemotePromptContractError,
    RemotePromptDomainError,
    createRemoteSessionService
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/service.js';
import type {
    LoadedPublicSessionTask,
    RemoteTaskSubmitOptions,
    RemoteTaskSubmitResult
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/session-projector.js';
import { sourceTask, unavailableSessionConfigurationBinding } from './session-projector-fixtures.js';
import { createInteractionSessionScopeResolver } from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/session-projector.js';
import type { HostSessionConfigurableTask } from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/host-binding.js';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}

function promptTask(overrides: Partial<HostSessionConfigurableTask> = {}) {
    let submitCalls = 0;
    let committedId = '550e8400-e29b-41d4-a716-446655440111';
    let submitResult: RemoteTaskSubmitResult = { status: 'ok' };
    const finished = deferred<void>();
    const seenOptions: RemoteTaskSubmitOptions[] = [];
    const task = sourceTask({
        task_id: 's1',
        task_name: 'Visible',
        task_status: 'stopped'
    }) as HostSessionConfigurableTask;
    Object.assign(task, {
        goal_state: undefined,
        stop_requested_by_user: false,
        async submitUserMessage(_text: string, options: RemoteTaskSubmitOptions) {
            submitCalls += 1;
            seenOptions.push(options);
            options.onUserMessageCommitted(committedId);
            return submitResult;
        },
        waitUntilFinished(_callback?: unknown, resolveOnStop?: boolean) {
            assert.equal(resolveOnStop, true);
            return finished.promise;
        },
        ...overrides
    });
    return {
        task,
        finished,
        submitCalls: () => submitCalls,
        seenOptions,
        setId: (value: string) => (committedId = value),
        setResult: (value: RemoteTaskSubmitResult) => (submitResult = value)
    };
}

function serviceFor(fixture: ReturnType<typeof promptTask>) {
    let visible = true;
    let corrupted = false;
    let loadedTask: HostSessionConfigurableTask | undefined = fixture.task;
    let loadCalls = 0;
    const getTaskList = () => (visible ? [fixture.task] : []);
    const service = createRemoteSessionService(
        {
            ...unavailableSessionConfigurationBinding,
            getTaskList,
            getTaskLoadResult: (sessionId) => {
                loadCalls += 1;
                return { task: sessionId === 's1' ? loadedTask : undefined, corrupted };
            },
            getDefaultWorkspace: () => '/work',
            subscribeTaskUpdates: () => () => undefined,
            subscribeTaskManagerUpdates: () => () => undefined
        },
        { resolveInteractionSessionScope: createInteractionSessionScopeResolver(getTaskList) }
    );
    return {
        service,
        loadCalls: () => loadCalls,
        hide: () => (visible = false),
        corrupt: () => (corrupted = true),
        replaceLoadedTask: (task: HostSessionConfigurableTask | undefined) => (loadedTask = task)
    };
}

async function expectCode(operation: Promise<unknown>, code: string): Promise<void> {
    await assert.rejects(operation, (error) => {
        assert.ok(error instanceof RemotePromptDomainError);
        assert.equal(error.code, code);
        assert.equal(JSON.stringify(error).includes('/Users/'), false);
        return true;
    });
}

test('allows waiting stopped and runtime failed but rejects running without submit', async () => {
    for (const status of ['waiting', 'stopped', 'failed'] as const) {
        const fixture = promptTask({ task_status: status });
        const { service } = serviceFor(fixture);
        const result = await service.startPrompt('s1', `from ${status}`);
        assert.equal(result.kind, 'started');
        assert.equal(fixture.submitCalls(), 1);
        fixture.finished.resolve();
        if (result.kind === 'started') await result.completion;
    }
    const busy = promptTask({ task_status: 'running' });
    const { service } = serviceFor(busy);
    await expectCode(service.startPrompt('s1', 'busy'), 'task_busy');
    assert.equal(busy.submitCalls(), 0);
});

test('rejects every unfinished Goal before Task status and permits terminal Goals', async () => {
    for (const status of ['active', 'paused', 'blocked'] as const) {
        const fixture = promptTask({ task_status: 'running', goal_state: { status } });
        const { service } = serviceFor(fixture);
        await expectCode(service.startPrompt('s1', 'goal'), 'goal_not_supported');
        assert.equal(fixture.submitCalls(), 0);
    }
    for (const status of ['complete', 'cleared'] as const) {
        const fixture = promptTask({ goal_state: { status } });
        const { service } = serviceFor(fixture);
        const result = await service.startPrompt('s1', 'terminal goal');
        assert.equal(result.kind, 'started');
        fixture.finished.resolve();
        if (result.kind === 'started') await result.completion;
    }
});

test('rejects unknown Goal states before Task status', async () => {
    const fixture = promptTask({ task_status: 'running', goal_state: { status: 'future' } });
    const { service } = serviceFor(fixture);
    await expectCode(service.startPrompt('s1', 'goal'), 'goal_not_supported');
    assert.equal(fixture.submitCalls(), 0);
});

test('calls submit exactly once with interactive false and returns P plus immutable completion', async () => {
    const fixture = promptTask();
    const { service } = serviceFor(fixture);
    const result = await service.startPrompt('s1', 'hello');
    assert.deepEqual(result.kind === 'started' && result.userMessageId, '550e8400-e29b-41d4-a716-446655440111');
    assert.equal(fixture.submitCalls(), 1);
    assert.equal(fixture.seenOptions[0].interactive, false);
    Object.assign(fixture.task, { stop_requested_by_user: true });
    fixture.finished.resolve();
    assert.deepEqual(result.kind === 'started' && (await result.completion), { stoppedByUser: true });
    Object.assign(fixture.task, { stop_requested_by_user: false });
    assert.deepEqual(result.kind === 'started' && (await result.completion), { stoppedByUser: true });
});

test('passes an explicitly negotiated interactive prompt to the task unchanged', async () => {
    const fixture = promptTask();
    const { service } = serviceFor(fixture);
    const result = await service.startPrompt('s1', 'hello', true);
    assert.equal(fixture.seenOptions[0].interactive, true);
    fixture.finished.resolve();
    if (result.kind === 'started') await result.completion;
});

test('returns recorded_not_started for result error or throw after P', async () => {
    const returned = promptTask();
    returned.setResult({ status: 'error', messageKey: 'private.key', messageArgs: { path: '/private' } });
    const first = serviceFor(returned);
    assert.deepEqual(await first.service.startPrompt('s1', 'x'), {
        kind: 'recorded_not_started',
        userMessageId: '550e8400-e29b-41d4-a716-446655440111'
    });

    const thrown = promptTask({
        async submitUserMessage(_text, options) {
            options.onUserMessageCommitted('550e8400-e29b-41d4-a716-446655440222');
            throw new Error('private /Users/stella token');
        }
    });
    const second = serviceFor(thrown);
    assert.deepEqual(await second.service.startPrompt('s1', 'x'), {
        kind: 'recorded_not_started',
        userMessageId: '550e8400-e29b-41d4-a716-446655440222'
    });
});

test('maps pre-P structured rejection unexpected failure and supplement defensively', async () => {
    const structured = promptTask({
        async submitUserMessage() {
            return { status: 'error', messageKey: 'secret.key', messageArgs: { token: 'secret' } };
        }
    });
    const a = serviceFor(structured);
    await expectCode(a.service.startPrompt('s1', 'x'), 'prompt_rejected');

    const unexpected = promptTask({
        async submitUserMessage() {
            throw new Error('db=/Users/stella/private');
        }
    });
    const b = serviceFor(unexpected);
    await expectCode(b.service.startPrompt('s1', 'x'), 'prompt_failed');

    const supplement = promptTask({
        async submitUserMessage() {
            return { status: 'ok', supplementId: 'goal-supplement' };
        }
    });
    const c = serviceFor(supplement);
    await expectCode(c.service.startPrompt('s1', 'x'), 'prompt_rejected');
});

test('fails the internal identity contract when ordinary success has no P', async () => {
    const fixture = promptTask({
        async submitUserMessage() {
            return { status: 'ok' };
        }
    });
    const { service } = serviceFor(fixture);
    await assert.rejects(service.startPrompt('s1', 'x'), RemotePromptContractError);
});

test('reauthorizes and reloads every request', async () => {
    const fixture = promptTask();
    const checked = serviceFor(fixture);
    const first = await checked.service.startPrompt('s1', 'first');
    fixture.finished.resolve();
    if (first.kind === 'started') await first.completion;
    assert.equal(checked.loadCalls(), 1);
    checked.hide();
    await expectCode(checked.service.startPrompt('s1', 'second'), 'session_unavailable');
    assert.equal(checked.loadCalls(), 1);
    assert.equal(fixture.submitCalls(), 1);
});

test('refuses corrupted missing and mismatched targets without submit', async () => {
    const corruptFixture = promptTask();
    const corrupt = serviceFor(corruptFixture);
    corrupt.corrupt();
    await expectCode(corrupt.service.startPrompt('s1', 'x'), 'session_unavailable');
    assert.equal(corruptFixture.submitCalls(), 0);

    const missingFixture = promptTask();
    const missing = serviceFor(missingFixture);
    missing.replaceLoadedTask(undefined);
    await expectCode(missing.service.startPrompt('s1', 'x'), 'session_unavailable');
    assert.equal(missingFixture.submitCalls(), 0);

    const mismatchFixture = promptTask();
    const mismatch = serviceFor(mismatchFixture);
    mismatch.replaceLoadedTask(promptTask({ task_id: 's2' }).task);
    await expectCode(mismatch.service.startPrompt('s1', 'x'), 'session_unavailable');
    assert.equal(mismatchFixture.submitCalls(), 0);
});
