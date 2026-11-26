/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { PermissionOption, RequestPermissionRequest } from '@agentclientprotocol/sdk';
import type {
    AskUserQuestion,
    ExitPlanModeAction,
    InteractionTerminalStatus,
    InteractionType
} from '../../../../../aikernel/interaction/contracts.js';
import type {
    AskUserDeliveryRequest,
    ExitPlanModeDeliveryRequest,
    PermissionDeliveryOption
} from '../../../../../aikernel/interaction/delivery.js';
export type { InteractionTerminalStatus, InteractionType } from '../../../../../aikernel/interaction/contracts.js';

export const MOBILE_INTERACTION_SCHEMA_VERSION = 1 as const;
export const ASK_USER_METHOD = '_opendesk/interaction/ask-user' as const;
export const EXIT_PLAN_MODE_METHOD = '_opendesk/interaction/exit-plan-mode' as const;
export const INTERACTION_CLOSED_METHOD = '_opendesk/interaction/closed' as const;
export const MAX_INTERACTION_BYTES = 1024 * 1024;
export const INTERACTION_FAILED_TERMINAL_CAPABILITY = { schemaVersion: 1 } as const;

export type InteractionProfileErrorCode = 'interaction_invalid' | 'interaction_too_large';

export class InteractionProfileError extends Error {
    constructor(readonly code: InteractionProfileErrorCode) {
        super(code);
        this.name = 'InteractionProfileError';
    }
}

export interface OpenDeskInteractionCapabilityV1 {
    schemaVersion: 1;
    askUser: 1;
    exitPlanMode: 1;
    permission: 1;
    closed: 1;
}

export interface OpenDeskCapabilityMeta {
    opendesk: {
        interaction: OpenDeskInteractionCapabilityV1;
    };
}

export type AskUserWireAnswer = {
    answers: Record<number, string[]>;
    cancelled?: boolean;
};

export type InteractionWireContext = {
    schemaVersion: 1;
    requestId: string;
    sessionId: string;
    taskId: string;
    taskName?: string;
    expiresAt?: number;
};

export type AskUserWireRequest = InteractionWireContext & {
    questions: AskUserQuestion[];
};

export type ExitPlanModeWireRequest = InteractionWireContext & {
    planContent: string;
    planRelativePath: string;
};

export type OpenDeskPermissionMetaV1 = {
    opendesk: {
        schemaVersion: 1;
        interactionType: 'permission';
        requestId: string;
        taskId: string;
        taskName?: string;
    };
};

export type PermissionWireRequest = Omit<RequestPermissionRequest, '_meta'> & {
    _meta: OpenDeskPermissionMetaV1;
};

export type ExitPlanModeWireAction = ExitPlanModeAction;

export type ExitPlanModeWireAnswer = {
    schemaVersion: 1;
    requestId: string;
    action: ExitPlanModeWireAction;
};

export type PermissionWireAnswer =
    | { schemaVersion: 1; requestId: string; optionId: string }
    | { schemaVersion: 1; requestId: string; cancelled: true };

export type InteractionClosedNotification = {
    schemaVersion: 1;
    requestId: string;
    sessionId: string;
    interactionType: InteractionType;
    status: InteractionTerminalStatus;
};

const nonBlankString = z.string().refine((value) => value.trim().length > 0);
const optionalWireContextShape = {
    taskName: nonBlankString.optional(),
    expiresAt: z.number().finite().int().nonnegative().optional()
};
const requiredWireContextShape = {
    schemaVersion: z.literal(MOBILE_INTERACTION_SCHEMA_VERSION),
    requestId: nonBlankString,
    sessionId: nonBlankString,
    taskId: nonBlankString,
    ...optionalWireContextShape
};

const interactionCapabilitySchema = z
    .object({
        schemaVersion: z.literal(MOBILE_INTERACTION_SCHEMA_VERSION),
        askUser: z.literal(1),
        exitPlanMode: z.literal(1),
        permission: z.literal(1),
        closed: z.literal(1)
    })
    .strict();

const interactionFailedTerminalCapabilitySchema = z
    .object({ schemaVersion: z.literal(MOBILE_INTERACTION_SCHEMA_VERSION) })
    .strict();

const askUserOptionSchema = z
    .object({
        label: nonBlankString,
        description: nonBlankString
    })
    .strict();

const askUserQuestionSchema = z
    .object({
        question: nonBlankString,
        header: nonBlankString.max(30),
        options: z.array(askUserOptionSchema).min(2).max(8),
        multiple: z.boolean().optional()
    })
    .strict();

const askUserRequestSchema = z
    .object({
        ...requiredWireContextShape,
        questions: z.array(askUserQuestionSchema).min(1).max(4)
    })
    .strict();

const askUserAnswerSchema = z
    .object({
        answers: z.record(z.string(), z.array(nonBlankString).min(1)),
        cancelled: z.boolean().optional()
    })
    .strict();

const exitPlanModeRequestSchema = z
    .object({
        ...requiredWireContextShape,
        planContent: nonBlankString,
        planRelativePath: nonBlankString
    })
    .strict();

const exitPlanModeAnswerSchema = z
    .object({
        schemaVersion: z.literal(MOBILE_INTERACTION_SCHEMA_VERSION),
        requestId: nonBlankString,
        action: z.enum(['execute-standard', 'execute-solo', 'continue-editing'])
    })
    .strict();

const permissionLocationSchema = z
    .object({
        path: nonBlankString,
        line: z.number().finite().int().nonnegative().nullable().optional()
    })
    .strict();

const permissionToolCallSchema = z
    .object({
        toolCallId: nonBlankString,
        title: nonBlankString.nullable().optional(),
        kind: z
            .enum(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other'])
            .nullable()
            .optional(),
        status: z.enum(['pending', 'in_progress', 'completed', 'failed']).nullable().optional(),
        locations: z.array(permissionLocationSchema).nullable().optional()
    })
    .strict();

const permissionOptionSchema = z
    .object({
        optionId: nonBlankString,
        name: nonBlankString,
        kind: z.enum(['allow_once', 'allow_always', 'reject_once', 'reject_always'])
    })
    .strict();

const permissionMetaSchema = z
    .object({
        opendesk: z
            .object({
                schemaVersion: z.literal(MOBILE_INTERACTION_SCHEMA_VERSION),
                interactionType: z.literal('permission'),
                requestId: nonBlankString,
                taskId: nonBlankString,
                taskName: nonBlankString.optional()
            })
            .strict()
    })
    .strict();

const permissionRequestSchema = z
    .object({
        sessionId: nonBlankString,
        toolCall: permissionToolCallSchema,
        options: z.array(permissionOptionSchema).min(1),
        _meta: permissionMetaSchema
    })
    .strict();

const permissionAnswerSchema = z.union([
    z
        .object({
            schemaVersion: z.literal(MOBILE_INTERACTION_SCHEMA_VERSION),
            requestId: nonBlankString,
            optionId: nonBlankString
        })
        .strict(),
    z
        .object({
            schemaVersion: z.literal(MOBILE_INTERACTION_SCHEMA_VERSION),
            requestId: nonBlankString,
            cancelled: z.literal(true)
        })
        .strict()
]);

const interactionClosedSchema = z
    .object({
        schemaVersion: z.literal(MOBILE_INTERACTION_SCHEMA_VERSION),
        requestId: nonBlankString,
        sessionId: nonBlankString,
        interactionType: z.enum(['askUser', 'exitPlanMode', 'permission']),
        status: z.enum(['accepted', 'superseded', 'timeout', 'cancelled', 'resolved', 'failed'])
    })
    .strict();

export function assertInteractionSize(value: unknown): void {
    let encoded: Uint8Array;
    try {
        const serialized = JSON.stringify(value);
        if (serialized === undefined) {
            throw new InteractionProfileError('interaction_invalid');
        }
        encoded = new TextEncoder().encode(serialized);
    } catch (error) {
        if (error instanceof InteractionProfileError) {
            throw error;
        }
        throw new InteractionProfileError('interaction_invalid');
    }
    if (encoded.byteLength > MAX_INTERACTION_BYTES) {
        throw new InteractionProfileError('interaction_too_large');
    }
}

function parseSized<T>(schema: z.ZodType<T>, value: unknown): T {
    assertInteractionSize(value);
    const result = schema.safeParse(value);
    if (!result.success) {
        throw new InteractionProfileError('interaction_invalid');
    }
    return result.data;
}

function parseUnsized<T>(schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value);
    if (!result.success) {
        throw new InteractionProfileError('interaction_invalid');
    }
    return result.data;
}

export function parseInteractionCapability(value: unknown): OpenDeskInteractionCapabilityV1 {
    return parseUnsized(interactionCapabilitySchema, value);
}

export function parseAdvertisedInteractionCapability(meta: unknown): OpenDeskInteractionCapabilityV1 | undefined {
    if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined;
    const opendesk = (meta as Record<string, unknown>).opendesk;
    if (typeof opendesk !== 'object' || opendesk === null || Array.isArray(opendesk)) return undefined;
    const interaction = (opendesk as Record<string, unknown>).interaction;
    try {
        return parseInteractionCapability(interaction);
    } catch {
        return undefined;
    }
}

export function parseAdvertisedInteractionFailedTerminalCapability(
    meta: unknown
): { schemaVersion: 1 } | undefined {
    if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined;
    const opendesk = (meta as Record<string, unknown>).opendesk;
    if (typeof opendesk !== 'object' || opendesk === null || Array.isArray(opendesk)) return undefined;
    const parsed = interactionFailedTerminalCapabilitySchema.safeParse(
        (opendesk as Record<string, unknown>).interactionFailedTerminal
    );
    return parsed.success ? parsed.data : undefined;
}

export function parseAskUserRequest(value: unknown): AskUserWireRequest {
    return parseSized(askUserRequestSchema, value);
}

export function parseAskUserAnswer(value: unknown): AskUserWireAnswer {
    return parseSized(askUserAnswerSchema, value) as AskUserWireAnswer;
}

export function validateAskUserAnswer(request: AskUserWireRequest, value: unknown): AskUserWireAnswer {
    const answer = parseAskUserAnswer(value);
    if (answer.cancelled === true) {
        return answer;
    }
    const keys = Object.keys(answer.answers);
    if (keys.length !== request.questions.length) {
        throw new InteractionProfileError('interaction_invalid');
    }
    for (let index = 0; index < request.questions.length; index += 1) {
        const values = answer.answers[index];
        if (!values || values.length === 0 || (!request.questions[index].multiple && values.length !== 1)) {
            throw new InteractionProfileError('interaction_invalid');
        }
    }
    if (keys.some((key) => !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= request.questions.length)) {
        throw new InteractionProfileError('interaction_invalid');
    }
    return answer;
}

export function parseExitPlanModeRequest(value: unknown): ExitPlanModeWireRequest {
    return parseSized(exitPlanModeRequestSchema, value);
}

export function parseExitPlanModeAnswer(value: unknown): ExitPlanModeWireAnswer {
    return parseSized(exitPlanModeAnswerSchema, value);
}

export function validateExitPlanModeAnswer(request: ExitPlanModeWireRequest, value: unknown): ExitPlanModeWireAnswer {
    const answer = parseExitPlanModeAnswer(value);
    if (answer.requestId !== request.requestId) {
        throw new InteractionProfileError('interaction_invalid');
    }
    return answer;
}

export function parsePermissionRequest(value: unknown): PermissionWireRequest {
    return parseUnsized(permissionRequestSchema, value) as PermissionWireRequest;
}

export function parsePermissionAnswer(value: unknown): PermissionWireAnswer {
    return parseUnsized(permissionAnswerSchema, value);
}

export function validatePermissionAnswer(request: PermissionWireRequest, value: unknown): PermissionWireAnswer {
    const answer = parsePermissionAnswer(value);
    if (answer.requestId !== request._meta.opendesk.requestId) {
        throw new InteractionProfileError('interaction_invalid');
    }
    if ('optionId' in answer && !request.options.some((option) => option.optionId === answer.optionId)) {
        throw new InteractionProfileError('interaction_invalid');
    }
    return answer;
}

export function parseInteractionClosed(value: unknown): InteractionClosedNotification {
    return parseSized(interactionClosedSchema, value);
}

export function createPermissionToolCallId(sessionId: string, requestId: string): string {
    const bytes = createHash('sha256').update(`${sessionId}\0${requestId}`, 'utf8').digest().subarray(0, 16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function assertNever(_value: never): never {
    throw new InteractionProfileError('interaction_invalid');
}

function toAcpPermissionKind(kind: PermissionDeliveryOption['kind']): PermissionOption['kind'] {
    switch (kind) {
        case 'allowOnce':
            return 'allow_once';
        case 'allowAlwaysPrefix':
        case 'allowAlwaysType':
            return 'allow_always';
        case 'rejectOnce':
            return 'reject_once';
        default:
            return assertNever(kind);
    }
}

export function toAcpPermissionOption(option: PermissionDeliveryOption): PermissionOption {
    return {
        optionId: option.optionId,
        name: option.label,
        kind: toAcpPermissionKind(option.kind)
    };
}

export function toAskUserWireRequest(sessionId: string, delivery: AskUserDeliveryRequest): AskUserWireRequest {
    const result: AskUserWireRequest = {
        schemaVersion: 1,
        requestId: delivery.requestId,
        sessionId,
        taskId: delivery.sourceTaskId,
        ...(delivery.taskName === undefined ? {} : { taskName: delivery.taskName }),
        ...(delivery.expiresAt === undefined ? {} : { expiresAt: delivery.expiresAt }),
        questions: delivery.request.questions
    };
    assertInteractionSize(result);
    return result;
}

export function toExitPlanModeWireRequest(
    sessionId: string,
    delivery: ExitPlanModeDeliveryRequest
): ExitPlanModeWireRequest {
    const result: ExitPlanModeWireRequest = {
        schemaVersion: 1,
        requestId: delivery.requestId,
        sessionId,
        taskId: delivery.sourceTaskId,
        ...(delivery.taskName === undefined ? {} : { taskName: delivery.taskName }),
        ...(delivery.expiresAt === undefined ? {} : { expiresAt: delivery.expiresAt }),
        planContent: delivery.planContent,
        planRelativePath: delivery.planRelativePath
    };
    assertInteractionSize(result);
    return result;
}
