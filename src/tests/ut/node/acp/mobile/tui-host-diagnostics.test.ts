import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getLogDirectory } from '../../../../../main/utils/setting.js';
import { createTuiCapabilitySource } from '../../../../../main/applications/mobileaccess/tui.js';
import { OpenDeskTUI } from '../../../../../main/tui/entry.js';
import { createHostSessionTask } from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/host-binding.js';
import { logTuiRemoteDiagnostic } from '../../../../../main/applications/mobileaccess/acp/mobile/hosts/tui-diagnostics.js';
import { createMobileHostLifecycle } from '../../../../../main/applications/mobileaccess/acp/mobile/hosts/lifecycle.js';
import { logger, LogStream, getLogFilename } from '../../../../../main/utils/logger.js';

async function record(scope: Parameters<typeof logTuiRemoteDiagnostic>[0], event: unknown): Promise<string[]> {
    const stream = LogStream.getStream();
    const offset = stream.getEntries().total;
    logTuiRemoteDiagnostic(scope, event);
    await new Promise<void>((resolve) => setImmediate(resolve));
    return stream.getEntries({ offset }).entries.map((entry) => entry.message);
}

test('real logger retains the network failure code in one line', async () => {
    assert.deepEqual(await record('network', { code: 'attempt_expired' }), ['[TuiRemoteNetwork] attempt_expired']);
});

test('registration HTTP categories and recovery counts reach the real logger', async () => {
    assert.deepEqual(await record('network', { kind: 'failure', category: 'http_401', count: 1 }), [
        '[TuiRemoteNetwork] http_401 count=1'
    ]);
    assert.deepEqual(await record('network', { kind: 'recovered', count: 3 }), [
        '[TuiRemoteNetwork] recovered count=3'
    ]);
});

test('real lifecycle failure retains its preparation phase', async () => {
    const stream = LogStream.getStream();
    const offset = stream.getEntries().total;
    const lifecycle = createMobileHostLifecycle({ diagnose: (event) => logTuiRemoteDiagnostic('lifecycle', event) });
    lifecycle.start({
        prepare: async () => {
            throw Error('synthetic-private-error');
        },
        waitUntilReady: async () => undefined
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await lifecycle.close();
    assert.deepEqual(
        stream.getEntries({ offset }).entries.map((entry) => entry.message),
        ['[TuiRemoteLifecycle] start_failed phase=prepare']
    );
});

test('credentials, raw errors, SDP, Session contents and unknown phases stay out of logs', async () => {
    assert.deepEqual(
        await record('network', {
            code: 'signaling_lost',
            count: 0,
            phase: 'synthetic-private-phase',
            detail: 'synthetic-private-detail',
            error: Error('synthetic-private-error'),
            accessToken: 'synthetic-private-token',
            sdp: 'synthetic-private-sdp',
            sessionId: 'synthetic-private-session',
            content: 'synthetic-private-content'
        }),
        ['[TuiRemoteNetwork] signaling_lost count=0']
    );
});

test('invalid codes cannot inject arbitrary text or new lines', async () => {
    for (const code of ['attempt_expired\nsynthetic-private-content', 'a'.repeat(65), '', 401, null]) {
        assert.deepEqual(await record('network', { code }), []);
    }
});

test('only nonnegative safe integer counts are recorded', async () => {
    for (const count of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 'synthetic-private-count']) {
        assert.deepEqual(await record('network', { code: 'recovered', count }), ['[TuiRemoteNetwork] recovered']);
    }
});

test('logger failure does not affect the remote runtime', () => {
    const warning = mock.method(logger, 'warn', () => {
        throw Error('synthetic logger failure');
    });
    try {
        assert.doesNotThrow(() => logTuiRemoteDiagnostic('network', { code: 'attempt_expired' }));
    } finally {
        warning.mock.restore();
    }
});

test('actual TUI session creation retains safe code and assembly step in both log transports', async () => {
    const tui = Object.create(OpenDeskTUI.prototype) as OpenDeskTUI;
    const diagnose = createTuiCapabilitySource(tui).diagnose;
    const task = {
        task_id: 'synthetic-task',
        getAgentMode: () => ({}) as any,
        setExecutionHost: async () => {
            throw Error('synthetic-private-error');
        },
        rebuildSystemPrompt: async () => undefined
    };
    const dependencies = {
        taskManager: {
            tasks: [task],
            createTask: () => task,
            initHarness: async () => undefined,
            publishTaskListUpdate: () => undefined
        },
        getDefaultExecutionNodeId: () => '',
        getExecutionNode: () => null,
        diagnose
    };
    const stream = LogStream.getStream();
    const offset = stream.getEntries().total;
    const result = await createHostSessionTask({ workspace: '/synthetic' }, dependencies);
    assert.equal(result.status, 'created', 'existing best-effort assembly remains intact');
    const unavailable = await createHostSessionTask(
        { workspace: '/synthetic' },
        {
            ...dependencies,
            getDefaultExecutionNodeId: () => 'synthetic-unavailable-node'
        }
    );
    assert.equal(unavailable.status, 'not_created');
    await new Promise<void>((resolve) => setImmediate(resolve));
    const expected = [
        '[TuiSessionCreation] task_assembly_failed step=set_execution_host',
        '[TuiSessionCreation] execution_node_unavailable'
    ];
    assert.deepEqual(
        stream.getEntries({ offset }).entries.map((entry) => entry.message),
        expected
    );
    const deadline = Date.now() + 3000;
    let file = '';
    while (!expected.every((message) => file.includes(message)) && Date.now() < deadline) {
        file = await readFile(join(getLogDirectory(), getLogFilename()), 'utf8').catch(() => '');
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    for (const message of expected) assert.ok(file.includes(message), 'real file transport preserves diagnostic');
    assert.ok(!file.includes('synthetic-private-error'));
    assert.ok(!file.includes('synthetic-unavailable-node'));
    const warning = mock.method(logger, 'warn', () => {
        throw Error('synthetic logger failure');
    });
    try {
        assert.doesNotThrow(() => diagnose({ code: 'task_assembly_failed', step: 'init_harness' }));
    } finally {
        warning.mock.restore();
    }
});

test('session diagnostics accept only creation codes and finite assembly steps', async () => {
    for (const step of ['init_harness', 'set_execution_host', 'rebuild_system_prompt', 'publish_task_list']) {
        assert.deepEqual(await record('session', { code: 'task_assembly_failed', step }), [
            `[TuiSessionCreation] task_assembly_failed step=${step}`
        ]);
    }
    assert.deepEqual(
        await record('session', {
            code: 'task_assembly_failed',
            step: 'synthetic-private-step\nextra',
            error: Error('synthetic-private-error')
        }),
        ['[TuiSessionCreation] task_assembly_failed']
    );
    assert.deepEqual(await record('session', { code: 'synthetic_private_code' }), []);
});
