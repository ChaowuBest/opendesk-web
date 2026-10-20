import assert from 'node:assert/strict';
import test from 'node:test';
import {
    ASK_USER_METHOD,
    EXIT_PLAN_MODE_METHOD,
    INTERACTION_CLOSED_METHOD,
    MAX_INTERACTION_BYTES,
    createPermissionToolCallId,
    parseAskUserAnswer,
    parseAskUserRequest,
    parseAdvertisedInteractionCapability,
    parseAdvertisedInteractionFailedTerminalCapability,
    parseInteractionCapability,
    parseInteractionClosed,
    parseExitPlanModeAnswer,
    parseExitPlanModeRequest,
    parsePermissionAnswer,
    parsePermissionRequest,
    toAskUserWireRequest,
    toAcpPermissionOption,
    toExitPlanModeWireRequest,
    validateAskUserAnswer,
    validateExitPlanModeAnswer,
    validatePermissionAnswer
} from '../../../../../main/applications/mobileaccess/acp/mobile/interaction/message-mapper.js';
import {
    encodeSessionInvalidation,
    parseAdvertisedSessionInvalidationCapability
} from '../../../../../main/applications/mobileaccess/acp/mobile/acp-endpoint/session-message-mapper.js';
import type {
    AskUserDeliveryRequest,
    ExitPlanModeDeliveryRequest,
    PermissionDeliveryOption
} from '../../../../../main/aikernel/interaction/delivery.js';
import { interactionVectors } from './interaction-vectors.js';

test('interaction profile accepts the shared v1 vectors', () => {
    assert.equal(ASK_USER_METHOD, '_opendesk/interaction/ask-user');
    assert.equal(EXIT_PLAN_MODE_METHOD, '_opendesk/interaction/exit-plan-mode');
    assert.equal(INTERACTION_CLOSED_METHOD, '_opendesk/interaction/closed');
    assert.equal(MAX_INTERACTION_BYTES, 1024 * 1024);
    assert.deepEqual(parseInteractionCapability(interactionVectors.capability), interactionVectors.capability);
    assert.deepEqual(parseAskUserRequest(interactionVectors.ask.request), interactionVectors.ask.request);
    assert.deepEqual(parseAskUserAnswer(interactionVectors.ask.answer), interactionVectors.ask.answer);
    assert.deepEqual(parseExitPlanModeRequest(interactionVectors.exit.request), interactionVectors.exit.request);
    assert.deepEqual(parseExitPlanModeAnswer(interactionVectors.exit.answer), interactionVectors.exit.answer);
    assert.deepEqual(
        parsePermissionRequest(interactionVectors.permission.request),
        interactionVectors.permission.request
    );
    assert.deepEqual(parsePermissionAnswer(interactionVectors.permission.answer), interactionVectors.permission.answer);
    assert.deepEqual(parseInteractionClosed(interactionVectors.closed), interactionVectors.closed);
});

test('parses an advertised capability without rejecting unrelated extension siblings', () => {
    assert.deepEqual(
        parseAdvertisedInteractionCapability({
            opendesk: {
                interaction: interactionVectors.capability,
                unrelated: { enabled: true }
            },
            anotherExtension: true
        }),
        interactionVectors.capability
    );
    assert.equal(parseAdvertisedInteractionCapability(undefined), undefined);
    assert.equal(parseAdvertisedInteractionCapability({ opendesk: {} }), undefined);
    assert.equal(
        parseAdvertisedInteractionCapability({
            opendesk: {
                interaction: { ...interactionVectors.capability, closed: undefined }
            }
        }),
        undefined
    );
    assert.equal(
        parseAdvertisedInteractionCapability({
            opendesk: {
                interaction: { ...interactionVectors.capability, schemaVersion: 2 }
            }
        }),
        undefined
    );
});

test('failed is part of the only strict closed schema and recovery siblings remain independent', () => {
    assert.equal(
        parseInteractionClosed({
            schemaVersion: 1,
            requestId: 'r1',
            sessionId: 's1',
            interactionType: 'askUser',
            status: 'failed'
        }).status,
        'failed'
    );
    assert.deepEqual(
        parseAdvertisedInteractionFailedTerminalCapability({
            opendesk: { interactionFailedTerminal: { schemaVersion: 1 } }
        }),
        { schemaVersion: 1 }
    );
    assert.equal(
        parseAdvertisedInteractionFailedTerminalCapability({
            opendesk: { interactionFailedTerminal: { schemaVersion: 1, extra: true } }
        }),
        undefined
    );
    assert.deepEqual(
        parseAdvertisedSessionInvalidationCapability({
            opendesk: { sessionInvalidation: { schemaVersion: 1 } }
        }),
        { schemaVersion: 1 }
    );
    assert.deepEqual(encodeSessionInvalidation('s1'), {
        method: '_opendesk/session/invalidated',
        params: { schemaVersion: 1, sessionId: 's1' }
    });
});

test('validates answers against their active request', () => {
    const ask = parseAskUserRequest(interactionVectors.ask.request);
    const exit = parseExitPlanModeRequest(interactionVectors.exit.request);
    const permission = parsePermissionRequest(interactionVectors.permission.request);
    assert.deepEqual(validateAskUserAnswer(ask, interactionVectors.ask.answer), interactionVectors.ask.answer);
    assert.deepEqual(validateExitPlanModeAnswer(exit, interactionVectors.exit.answer), interactionVectors.exit.answer);
    assert.deepEqual(
        validatePermissionAnswer(permission, interactionVectors.permission.answer),
        interactionVectors.permission.answer
    );
    assert.throws(() => validateAskUserAnswer(ask, { answers: {} }));
    assert.throws(() => validateExitPlanModeAnswer(exit, { ...interactionVectors.exit.answer, requestId: 'wrong' }));
    assert.throws(() =>
        validatePermissionAnswer(permission, {
            ...interactionVectors.permission.answer,
            optionId: 'unknown'
        })
    );
});

test('interaction profile rejects coercion, unknown answers and oversized payloads', () => {
    assert.throws(() => parseInteractionCapability({ schemaVersion: '1' }));
    assert.throws(() => parseAskUserAnswer({ ...interactionVectors.ask.answer, extra: true }));
    assert.throws(() => parseExitPlanModeAnswer({ action: 'approve-everything' }));
    assert.throws(() => parseInteractionClosed({ ...interactionVectors.closed, status: 'lost' }));
    const oversized = 'x'.repeat(MAX_INTERACTION_BYTES + 1);
    assert.throws(() => parseAskUserAnswer({ answers: { 0: [oversized] } }));
});

test('projects delivery requests onto the exact public wire shapes', () => {
    const ask: AskUserDeliveryRequest = {
        type: 'askUser',
        requestId: 'ask-1',
        sourceTaskId: 'child-1',
        taskName: 'Refactor API',
        expiresAt: 1_777_777_777_000,
        request: {
            requestId: 'ask-1',
            taskId: 'child-1',
            taskName: 'Refactor API',
            workspace: '/private/workspace',
            questions: interactionVectors.ask.request.questions.map((question) => ({
                ...question,
                options: question.options.map((option) => ({ ...option }))
            }))
        }
    };
    const exit: ExitPlanModeDeliveryRequest = {
        type: 'exitPlanMode',
        requestId: 'exit-1',
        sourceTaskId: 'child-1',
        taskName: 'Refactor API',
        expiresAt: 1_777_777_777_000,
        planRelativePath: '.plan/refactor.md',
        planContent: '# Plan\nComplete content'
    };

    assert.deepEqual(toAskUserWireRequest('root-1', ask), interactionVectors.ask.request);
    assert.deepEqual(toExitPlanModeWireRequest('root-1', exit), interactionVectors.exit.request);
    assert.equal('workspace' in toAskUserWireRequest('root-1', ask), false);
    assert.equal('planFilePath' in toExitPlanModeWireRequest('root-1', exit), false);
});

test('creates stable request-scoped UUIDs and exhaustively maps permission options', () => {
    const id = createPermissionToolCallId('root', 'r1');
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(createPermissionToolCallId('root', 'r1'), id);
    assert.notEqual(createPermissionToolCallId('root', 'r2'), id);

    const options: PermissionDeliveryOption[] = [
        { optionId: 'once', kind: 'allowOnce', label: 'Once', response: { decision: 'allow', rememberScope: 'none' } },
        {
            optionId: 'prefix',
            kind: 'allowAlwaysPrefix',
            label: 'Prefix',
            prefix: '/workspace',
            response: { decision: 'allow', rememberScope: 'prefix', selectedPrefixPattern: '/workspace' }
        },
        {
            optionId: 'type',
            kind: 'allowAlwaysType',
            label: 'Type',
            response: { decision: 'allow', rememberScope: 'type' }
        },
        {
            optionId: 'reject',
            kind: 'rejectOnce',
            label: 'Reject',
            response: { decision: 'deny', rememberScope: 'none', denyReason: 'user_denied' }
        }
    ];

    assert.deepEqual(options.map(toAcpPermissionOption), [
        { optionId: 'once', name: 'Once', kind: 'allow_once' },
        { optionId: 'prefix', name: 'Prefix', kind: 'allow_always' },
        { optionId: 'type', name: 'Type', kind: 'allow_always' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' }
    ]);
    assert.equal(JSON.stringify(options.map(toAcpPermissionOption)).includes('label'), false);
    assert.equal(JSON.stringify(options.map(toAcpPermissionOption)).includes('reject_always'), false);
});
