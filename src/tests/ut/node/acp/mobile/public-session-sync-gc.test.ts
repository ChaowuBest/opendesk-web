/// <reference types="node" />

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    createPublicSessionSync,
    type RemoteTaskManagerSubscriber,
    type RemoteTaskUpdateSubscriber
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session-sync.js';
import {
    applyPublicSessionUpdate,
    type PublicSessionState,
    type PublicSessionUpdate
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session.js';
import {
    deriveRunToken,
    type PublicSessionIdentifierPlan
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session-identifiers.js';

const state = (): PublicSessionState => ({
    sessionId: 's1',
    title: 'Session',
    cwd: '/work',
    updatedAt: '2026-08-22T00:00:00.000Z',
    taskStatus: 'running',
    completionStatus: null,
    runToken: deriveRunToken('s1', 1),
    history: {
        messages: [{ role: 'assistant', messageId: 'a1', parts: [{ type: 'text', text: 'base' }] }]
    }
});

const identity = (): PublicSessionIdentifierPlan => ({
    hasMessage: () => false,
    hasToolCall: () => false,
    messageId: () => 'a1',
    toolCallId: () => 't1',
    registerMessage: () => 'a1',
    registerToolCall: () => 't1',
    rebindMessageToolCalls: () => []
});

function enqueueQueued(send: (update: PublicSessionUpdate) => void): WeakRef<object> {
    const queued: PublicSessionUpdate = {
        type: 'part_state',
        messageId: 'a1',
        role: 'assistant',
        partIndex: 0,
        part: { type: 'text', text: 'queued' }
    };
    const partRef = new WeakRef<object>(queued.part);
    send(queued);
    return partRef;
}

test(
    'formal public session sync stop releases an unstarted queued part',
    { skip: typeof globalThis.gc !== 'function' },
    async () => {
        let taskSubscriber: RemoteTaskUpdateSubscriber | undefined;
        let managerSubscriber: RemoteTaskManagerSubscriber | undefined;
        let authoritative = state();
        const setup = createPublicSessionSync('s1', {
            subscribeTask(subscriber) {
                taskSubscriber = subscriber;
                return () => {
                    taskSubscriber = undefined;
                };
            },
            subscribeTaskManager(subscriber) {
                managerSubscriber = subscriber;
                return () => {
                    managerSubscriber = undefined;
                };
            },
            projectChunk: (chunk) => structuredClone((chunk as unknown as { update: PublicSessionUpdate }).update),
            projectInfo: () => ({
                title: authoritative.title,
                cwd: authoritative.cwd,
                updatedAt: authoritative.updatedAt,
                taskStatus: authoritative.taskStatus,
                completionStatus: authoritative.completionStatus,
                runToken: authoritative.runToken
            }),
            assertStillAuthorized: () => undefined,
            projectAuthoritativeState: () => authoritative
        });
        setup.initializeT0(authoritative, identity());
        await setup.handle.activate(async () => new Promise<void>(() => undefined));
        const held: PublicSessionUpdate = {
            type: 'part_state',
            messageId: 'a1',
            role: 'assistant',
            partIndex: 0,
            part: { type: 'text', text: 'held' }
        };
        authoritative = applyPublicSessionUpdate(authoritative, structuredClone(held));
        taskSubscriber?.send({ task_id: 's1', task_status: 'running', update: held } as never);
        const partRef = enqueueQueued((queued) => {
            authoritative = applyPublicSessionUpdate(authoritative, structuredClone(queued));
            taskSubscriber?.send({ task_id: 's1', task_status: 'running', update: queued } as never);
        });
        setup.handle.stop();
        assert.equal(managerSubscriber, undefined);
        for (let index = 0; index < 30; index += 1) {
            globalThis.gc?.();
            await new Promise((resolve) => setTimeout(resolve, 0));
            if (partRef.deref() === undefined) break;
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
        assert.equal(partRef.deref(), undefined);
    }
);
