import assert from 'node:assert/strict';
import test from 'node:test';
import {
    InteractionDeliveryChannel,
    type AskUserDeliveryRequest,
    type InteractionDeliveryEndpoint,
    type InteractionDeliveryHandle
} from '../../../../../main/aikernel/interaction/delivery.js';
import type { AskUserResponse } from '../../../../../main/aikernel/interaction/contracts.js';

function askDeliveryRequest(overrides: Partial<AskUserDeliveryRequest> = {}): AskUserDeliveryRequest {
    return {
        type: 'askUser',
        requestId: 'ask-1',
        sourceTaskId: 'child',
        request: {
            requestId: 'ask-1',
            questions: [],
            taskId: 'child',
            taskName: null
        },
        ...overrides
    };
}

function fakeDelivery(_answer: (answer: AskUserResponse) => boolean, closes: string[] = []): InteractionDeliveryHandle {
    let closed = false;
    return {
        delivered: true,
        close(status) {
            if (closed) return;
            closed = true;
            closes.push(status);
        }
    };
}

function endpoint(sessionId: string, name: string, deliveries: string[] = []): InteractionDeliveryEndpoint {
    return {
        sessionId,
        tryDeliverAskUser(_request, answer) {
            deliveries.push(name);
            return fakeDelivery(answer);
        },
        tryDeliverExitPlanMode: () => undefined,
        tryDeliverPermission: () => undefined
    };
}

test('publishes only to a matching currently registered endpoint', () => {
    const delivered: string[] = [];
    const channel = new InteractionDeliveryChannel((source) => (source === 'child' ? 'root' : undefined));
    const unregister = channel.registerEndpoint({
        sessionId: 'root',
        tryDeliverAskUser(request, answer) {
            delivered.push(request.requestId);
            return fakeDelivery(answer);
        },
        tryDeliverExitPlanMode: () => undefined,
        tryDeliverPermission: () => undefined
    });
    const handle = channel.publishAskUser(askDeliveryRequest(), () => true);
    assert.equal(handle?.delivered, true);
    assert.deepEqual(delivered, ['ask-1']);
    unregister();
    assert.equal(
        channel.publishAskUser(askDeliveryRequest(), () => true),
        undefined
    );
});

test('stale unregister cannot remove a replacement endpoint', () => {
    const deliveries: string[] = [];
    const channel = new InteractionDeliveryChannel(() => 'root');
    const unregisterA = channel.registerEndpoint(endpoint('root', 'a', deliveries));
    channel.registerEndpoint(endpoint('root', 'b', deliveries));
    unregisterA();
    channel.publishAskUser(askDeliveryRequest(), () => true);
    assert.deepEqual(deliveries, ['b']);
});

test('channel owns no active request and never synthesizes a result on unregister', () => {
    let answers = 0;
    const channel = new InteractionDeliveryChannel(() => 'root');
    const unregister = channel.registerEndpoint(endpoint('root', 'a'));
    const handle = channel.publishAskUser(askDeliveryRequest(), () => {
        answers += 1;
        return true;
    });
    unregister();
    assert.equal(answers, 0);
    handle?.close('cancelled');
    assert.equal(answers, 0);
});

test('returns unavailable for missing scope, session mismatch or a busy endpoint', () => {
    const missing = new InteractionDeliveryChannel(() => undefined);
    missing.registerEndpoint(endpoint('root', 'missing'));
    assert.equal(
        missing.publishAskUser(askDeliveryRequest(), () => true),
        undefined
    );

    const mismatch = new InteractionDeliveryChannel(() => 'other');
    mismatch.registerEndpoint(endpoint('root', 'mismatch'));
    assert.equal(
        mismatch.publishAskUser(askDeliveryRequest(), () => true),
        undefined
    );

    const busy = new InteractionDeliveryChannel(() => 'root');
    busy.registerEndpoint({
        sessionId: 'root',
        tryDeliverAskUser: () => undefined,
        tryDeliverExitPlanMode: () => undefined,
        tryDeliverPermission: () => undefined
    });
    assert.equal(
        busy.publishAskUser(askDeliveryRequest(), () => true),
        undefined
    );
});

test('keeps answer types separate and delegates idempotent close to the endpoint', () => {
    const closes: string[] = [];
    const channel = new InteractionDeliveryChannel(() => 'root');
    channel.registerEndpoint({
        sessionId: 'root',
        tryDeliverAskUser(_request, answer) {
            assert.equal(answer({ answers: {} }), true);
            return fakeDelivery(answer, closes);
        },
        tryDeliverExitPlanMode: () => undefined,
        tryDeliverPermission: () => undefined
    });
    const handle = channel.publishAskUser(askDeliveryRequest(), () => true);
    handle?.close('timeout');
    handle?.close('cancelled');
    assert.deepEqual(closes, ['timeout']);
});

test('endpoint readiness is announced with the generation that identifies the registered endpoint', () => {
    const channel = new InteractionDeliveryChannel(() => 'root');
    const announced: Array<number | undefined> = [];
    const unsubscribe = channel.subscribeEndpointReady((generation) => announced.push(generation));

    assert.equal(channel.endpointGeneration, undefined);
    // Without an endpoint there is nothing to re-offer to.
    channel.notifyEndpointReady();
    assert.deepEqual(announced, []);

    const unregisterFirst = channel.registerEndpoint(endpoint('root', 'a'));
    const first = channel.endpointGeneration;
    assert.equal(typeof first, 'number');
    channel.notifyEndpointReady();
    channel.notifyEndpointReady();
    // Repeats are announced; skipping a duplicate delivery is the Provider's own record.
    assert.deepEqual(announced, [first, first]);

    unregisterFirst();
    assert.equal(channel.endpointGeneration, undefined);
    channel.registerEndpoint(endpoint('root', 'b'));
    const second = channel.endpointGeneration;
    assert.notEqual(second, first);
    channel.notifyEndpointReady();
    assert.deepEqual(announced, [first, first, second]);

    unsubscribe();
    channel.notifyEndpointReady();
    assert.deepEqual(announced, [first, first, second]);
});

test('readiness announcement stops once a listener replaces the endpoint it was told about', () => {
    const channel = new InteractionDeliveryChannel(() => 'root');
    const reached: string[] = [];
    channel.subscribeEndpointReady(() => {
        reached.push('first');
        channel.registerEndpoint(endpoint('root', 'replacement'));
    });
    channel.subscribeEndpointReady(() => reached.push('second'));
    channel.registerEndpoint(endpoint('root', 'a'));
    channel.notifyEndpointReady();
    assert.deepEqual(reached, ['first']);
});

test('a throwing Provider re-offer cannot break the announcement or the caller', () => {
    const channel = new InteractionDeliveryChannel(() => 'root');
    const reached: string[] = [];
    channel.subscribeEndpointReady(() => {
        reached.push('first');
        throw new Error('provider re-offer failed');
    });
    channel.subscribeEndpointReady(() => reached.push('second'));
    channel.registerEndpoint(endpoint('root', 'a'));

    // One Provider failing must not hide the endpoint from the others, and must not propagate into
    // the session load that announces readiness right after committing.
    assert.doesNotThrow(() => channel.notifyEndpointReady());
    assert.deepEqual(reached, ['first', 'second']);
});
