import assert from 'node:assert/strict';
import test from 'node:test';
import {
    createRecoveryFixtureService,
    RecoveryFixtureController
} from '../../../../../main/applications/mobileaccess/acp/mobile/testing/recovery-fixture.js';
import type { RemoteSessionService } from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/service.js';

// 旧的线上控制帧协议（_opendeskWf8TestControl / 控制通道）随临时接线一起删除；
// 这里保留的是恢复 fixture 自身的业务边界与 trace 脱敏，不再经过控制口。

test('one-shot list and load failures are consumed exactly once', () => {
    const fixture = new RecoveryFixtureController();

    fixture.armListFailure();
    assert.equal(fixture.consumeListFailure(), true);
    assert.equal(fixture.consumeListFailure(), false);

    fixture.armLoadFailure();
    assert.equal(fixture.consumeLoadFailure(), true);
    assert.equal(fixture.consumeLoadFailure(), false);
});

test('the trace labels connections and never records the private connection id', () => {
    const fixture = new RecoveryFixtureController();

    fixture.trace.open('private-connection-id');
    fixture.trace.append('private-connection-id', 'prompt', 'received');
    fixture.trace.close('private-connection-id');

    const snapshot = fixture.trace.snapshot();
    assert.equal(snapshot.connections, 1);
    assert.equal(snapshot.activeConnection, undefined);
    assert.equal(JSON.stringify(snapshot).includes('private-connection-id'), false);
    assert.deepEqual(
        snapshot.events.filter((event) => event.operation === 'connection').map((event) => event.stage),
        ['opened', 'closed']
    );
    assert.deepEqual(
        snapshot.events.map((event) => event.connection),
        ['C1', 'C1', 'C1']
    );
});

test('reset clears armed failures and the recorded trace', () => {
    const fixture = new RecoveryFixtureController();
    fixture.armListFailure();
    fixture.armLoadFailure();
    fixture.trace.open('c-private');

    fixture.reset();

    assert.equal(fixture.consumeListFailure(), false);
    assert.equal(fixture.consumeLoadFailure(), false);
    assert.deepEqual(fixture.trace.snapshot().events, []);
});

test('fails exactly the next list/load at the RSS boundary and keeps the connection reusable', async () => {
    const fixture = new RecoveryFixtureController();
    let lists = 0;
    let loads = 0;
    const delegate = {
        async listSessions() {
            lists += 1;
            return [];
        },
        beginSessionLoad() {
            loads += 1;
            return { snapshot: {}, sync: {} };
        },
        stopCurrentRun() {},
        setSessionModelConfiguration() {
            throw new Error('unused');
        },
        async startPrompt() {
            throw new Error('unused');
        }
    } as unknown as RemoteSessionService;
    const service = createRecoveryFixtureService(delegate, fixture, 'private-c1');

    fixture.armListFailure();
    await assert.rejects(service.listSessions({}), /injected fixture list failure/);
    await service.listSessions({});
    fixture.armLoadFailure();
    assert.throws(() => service.beginSessionLoad('s-1', (() => undefined) as never), /injected fixture load failure/);
    service.beginSessionLoad('s-1', (() => undefined) as never);

    assert.equal(lists, 1);
    assert.equal(loads, 1);
    assert.equal(JSON.stringify(fixture.trace.snapshot()).includes('private-c1'), false);
});
