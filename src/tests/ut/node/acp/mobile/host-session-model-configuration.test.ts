import assert from 'node:assert/strict';
import test from 'node:test';
import {
    HostSessionModelConfigurationError,
    readHostSessionModelConfiguration,
    setHostSessionModelConfiguration,
    type HostEffectiveDefaultModel,
    type HostSessionConfigurableTask,
    type HostSessionModelSource
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/host-binding.js';

function source(defaultModel: HostEffectiveDefaultModel = { kind: 'configured_alias', alias: 'alpha' }) {
    const models = new Map([
        ['alpha', { alias: 'alpha', modelName: 'gpt-5' }],
        ['beta', { alias: 'beta', modelName: 'custom-model' }]
    ]);
    return {
        listConfiguredModelAliases: () => ['alpha', 'beta'],
        resolveChatModel: (alias) => models.get(alias),
        resolveEffectiveDefaultModel: () => defaultModel
    } satisfies HostSessionModelSource;
}

function task(overrides: Partial<HostSessionConfigurableTask> = {}) {
    let persists = 0;
    const value = {
        task_id: 's1',
        parent_id: undefined,
        internal: false,
        chat_context: { messages: [] },
        getTurnGeneration: () => 0,
        stop: () => undefined,
        submitUserMessage: async () => ({ status: 'ok' as const }),
        waitUntilFinished: async () => undefined,
        model: undefined,
        reasoningEffort: undefined,
        persistLater: () => {
            persists += 1;
        },
        ...overrides
    } satisfies HostSessionConfigurableTask;
    return { value, persists: () => persists };
}

test('reads an exact task override or configured host default without mutation', () => {
    const inherited = task();
    assert.deepEqual(readHostSessionModelConfiguration(inherited.value, source()), {
        current: { modelAlias: 'alpha', reasoningEffort: '' },
        candidates: [
            { modelAlias: 'alpha', reasoningEfforts: ['', 'none', 'low', 'medium', 'high'] },
            { modelAlias: 'beta', reasoningEfforts: ['', 'none', 'low', 'medium', 'high', 'max'] }
        ]
    });
    assert.equal(inherited.persists(), 0);

    const overridden = task({ model: 'beta', reasoningEffort: 'max' });
    assert.deepEqual(readHostSessionModelConfiguration(overridden.value, source())?.current, {
        modelAlias: 'beta',
        reasoningEffort: 'max'
    });
});

test('sets both fields after validation and schedules persistence exactly once', () => {
    const target = task({ model: 'alpha', reasoningEffort: 'high' });
    const notifications: unknown[] = [];
    const notify = () => notifications.push([target.value.model, target.value.reasoningEffort]);
    const result = setHostSessionModelConfiguration(
        target.value,
        source(),
        {
            modelAlias: 'beta',
            reasoningEffort: ''
        },
        notify
    );
    assert.equal(target.value.model, 'beta');
    assert.equal(target.value.reasoningEffort, undefined);
    assert.equal(target.persists(), 1);
    assert.deepEqual(result.current, { modelAlias: 'beta', reasoningEffort: '' });

    setHostSessionModelConfiguration(target.value, source(), result.current, notify);
    assert.equal(target.persists(), 1);
    assert.deepEqual(notifications, [['beta', undefined]]);
});

test('a legal explicit set recovers from an unrepresentable environment default', () => {
    const target = task();
    const unavailableSource = source({ kind: 'unrepresentable' });
    assert.equal(readHostSessionModelConfiguration(target.value, unavailableSource), undefined);
    const result = setHostSessionModelConfiguration(target.value, unavailableSource, {
        modelAlias: 'beta',
        reasoningEffort: 'max'
    });
    assert.deepEqual(result.current, { modelAlias: 'beta', reasoningEffort: 'max' });
    assert.equal(target.value.model, 'beta');
    assert.equal(target.persists(), 1);
});

test('rejects invalid selections before either field changes', () => {
    const target = task({ model: 'alpha', reasoningEffort: 'low' });
    assert.throws(
        () =>
            setHostSessionModelConfiguration(target.value, source(), {
                modelAlias: ' beta',
                reasoningEffort: 'max'
            }),
        (error: unknown) => error instanceof HostSessionModelConfigurationError && error.code === 'invalid_selection'
    );
    assert.deepEqual(
        { model: target.value.model, effort: target.value.reasoningEffort, persists: target.persists() },
        { model: 'alpha', effort: 'low', persists: 0 }
    );
});

test('read fails closed for invalid defaults, task effort, and candidate catalogs', () => {
    assert.equal(readHostSessionModelConfiguration(task().value, source({ kind: 'none' })), undefined);
    assert.equal(readHostSessionModelConfiguration(task().value, source({ kind: 'unrepresentable' })), undefined);
    assert.equal(
        readHostSessionModelConfiguration(task({ model: 'alpha', reasoningEffort: 'max' }).value, source()),
        undefined
    );

    const duplicate = source();
    duplicate.listConfiguredModelAliases = () => ['alpha', 'alpha'];
    assert.equal(readHostSessionModelConfiguration(task().value, duplicate), undefined);

    const mismatched = source();
    mismatched.resolveChatModel = () => ({ alias: 'other', modelName: 'gpt-5' });
    assert.equal(readHostSessionModelConfiguration(task().value, mismatched), undefined);

    const throwing = source();
    throwing.listConfiguredModelAliases = () => {
        throw new Error('/private/path/setting.json');
    };
    assert.equal(readHostSessionModelConfiguration(task().value, throwing), undefined);

    const empty = source();
    empty.listConfiguredModelAliases = () => ['', 'missing'];
    assert.equal(readHostSessionModelConfiguration(task().value, empty), undefined);
});

test('set distinguishes an unavailable catalog from an invalid selection', () => {
    const unavailable = source();
    unavailable.listConfiguredModelAliases = () => ['alpha', 'alpha'];
    assert.throws(
        () =>
            setHostSessionModelConfiguration(task().value, unavailable, {
                modelAlias: 'alpha',
                reasoningEffort: ''
            }),
        (error: unknown) =>
            error instanceof HostSessionModelConfigurationError && error.code === 'configuration_unavailable'
    );
});
