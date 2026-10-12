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
import { t } from '../locale/index.js';

export const AGENT_FLOW_SCHEMA_VERSION = 1;
export const AGENT_FLOW_NAME_MAX_LENGTH = 100;
export const AGENT_FLOW_GOAL_MAX_LENGTH = 4_000;
export const AGENT_FLOW_MEMBER_MAX_COUNT = 32;
export const AGENT_FLOW_MESSAGE_MAX_LENGTH = 100_000;
export const AGENT_FLOW_MESSAGE_PAGE_MAX_SIZE = 200;
export const AGENT_FLOW_ATTACHMENT_MAX_COUNT = 20;

export const AgentFlowIdSchema = z.string().uuid();
export const AgentFlowTaskIdSchema = z.union([z.string().uuid(), z.string().regex(/^task_[0-9a-z]{8}_[0-9a-z]{4}$/)]);
export const AgentFlowRevisionSchema = z.number().int().positive();
export const AgentFlowStatusSchema = z.enum(['active', 'paused', 'archived']);
export const AgentFlowNameSchema = z.string().trim().min(1).max(AGENT_FLOW_NAME_MAX_LENGTH);
export const AgentFlowGoalSchema = z.string().trim().min(1).max(AGENT_FLOW_GOAL_MAX_LENGTH);

export const AgentFlowMemberIdsSchema = z
    .array(AgentFlowIdSchema)
    .min(1)
    .max(AGENT_FLOW_MEMBER_MAX_COUNT)
    .refine((memberIds) => new Set(memberIds).size === memberIds.length, {
        message: 'agentoffice.flow.error.duplicateMembers'
    });

export const AgentFlowSchema = z
    .object({
        schemaVersion: z.literal(AGENT_FLOW_SCHEMA_VERSION),
        id: AgentFlowIdSchema,
        revision: AgentFlowRevisionSchema,
        name: AgentFlowNameSchema,
        goal: AgentFlowGoalSchema,
        status: AgentFlowStatusSchema,
        memberIds: AgentFlowMemberIdsSchema,
        createdAt: z.string().datetime(),
        updatedAt: z.string().datetime(),
        archivedAt: z.string().datetime().optional()
    })
    .strict();

export const CreateAgentFlowInputSchema = z
    .object({
        name: AgentFlowNameSchema,
        goal: AgentFlowGoalSchema,
        memberIds: AgentFlowMemberIdsSchema
    })
    .strict();

export const UpdateAgentFlowPatchSchema = z
    .object({
        name: AgentFlowNameSchema.optional(),
        goal: AgentFlowGoalSchema.optional()
    })
    .strict()
    .refine((patch) => patch.name !== undefined || patch.goal !== undefined, {
        message: 'agentoffice.flow.error.emptyPatch'
    });

export const AgentFlowListFilterSchema = z
    .object({
        status: z.enum(['active', 'paused', 'archived', 'all']).optional().default('active'),
        query: z.string().trim().max(AGENT_FLOW_NAME_MAX_LENGTH).optional()
    })
    .strict();

export const AgentFlowMessageSenderSchema = z
    .object({
        type: z.enum(['user', 'staff', 'system']),
        id: AgentFlowIdSchema.optional(),
        name: z.string().optional(),
        title: z.string().optional()
    })
    .strict()
    .refine((sender) => (sender.type === 'staff' ? sender.id !== undefined : sender.id === undefined));

export const AgentFlowResourceContentSchema = z
    .object({
        type: z.literal('resource'),
        resourceId: AgentFlowIdSchema,
        mediaType: z.enum(['image', 'video', 'audio', 'file']),
        mimeType: z.string().trim().min(1).max(255),
        name: z.string().trim().min(1).max(255),
        path: z.string().regex(/^resources\/[0-9a-f-]{36}(?:\.[a-z0-9]{1,16})?$/i),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        size: z.number().int().nonnegative()
    })
    .strict();

export const AgentFlowMessageContentSchema = z.union([
    z.object({ type: z.literal('text'), text: z.string().min(1).max(AGENT_FLOW_MESSAGE_MAX_LENGTH) }).strict(),
    AgentFlowResourceContentSchema
]);

const AgentFlowMentionIdsSchema = z
    .array(AgentFlowIdSchema)
    .max(AGENT_FLOW_MEMBER_MAX_COUNT)
    .refine((staffIds) => new Set(staffIds).size === staffIds.length);

export const AgentFlowMessageSchema = z
    .object({
        schemaVersion: z.literal(AGENT_FLOW_SCHEMA_VERSION),
        id: AgentFlowIdSchema,
        flowId: AgentFlowIdSchema,
        sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
        clientRequestId: AgentFlowIdSchema.optional(),
        requestHash: z
            .string()
            .regex(/^[0-9a-f]{64}$/)
            .optional(),
        taskId: AgentFlowTaskIdSchema.optional(),
        readingBatchId: AgentFlowIdSchema.optional(),
        replyKey: z
            .string()
            .regex(/^[0-9a-f]{64}$/)
            .optional(),
        replyToMessageId: AgentFlowIdSchema.optional(),
        sender: AgentFlowMessageSenderSchema,
        mentions: AgentFlowMentionIdsSchema,
        kind: z.enum(['message', 'error']),
        content: z.array(AgentFlowMessageContentSchema).min(1),
        retryable: z.boolean().optional(),
        createdAt: z.string().datetime()
    })
    .strict();

export const AgentFlowMessageAttachmentSchema = z
    .object({
        path: z.string().trim().min(1),
        name: z.string().trim().min(1).max(255).optional()
    })
    .strict();

export const PrepareAgentFlowUserMessageInputSchema = z
    .object({
        clientRequestId: AgentFlowIdSchema,
        taskId: AgentFlowTaskIdSchema.optional(),
        text: z.string().trim().min(1).max(AGENT_FLOW_MESSAGE_MAX_LENGTH).optional(),
        attachments: z.array(AgentFlowMessageAttachmentSchema).max(AGENT_FLOW_ATTACHMENT_MAX_COUNT).optional(),
        imageDataUris: z.array(z.string().min(1)).max(AGENT_FLOW_ATTACHMENT_MAX_COUNT).optional(),
        mentions: AgentFlowMentionIdsSchema,
        replyToMessageId: AgentFlowIdSchema.optional()
    })
    .strict()
    .refine((input) => Boolean(input.text || input.attachments?.length || input.imageDataUris?.length));

export const AgentFlowMessageHistoryQuerySchema = z
    .object({
        limit: z.number().int().min(1).max(AGENT_FLOW_MESSAGE_PAGE_MAX_SIZE),
        cursor: z.string().max(4096).optional()
    })
    .strict();

export const SendAgentFlowMessageInputSchema = z
    .object({
        clientRequestId: AgentFlowIdSchema,
        text: z.string().trim().min(1).max(AGENT_FLOW_MESSAGE_MAX_LENGTH).optional(),
        attachments: z.array(AgentFlowMessageAttachmentSchema).max(AGENT_FLOW_ATTACHMENT_MAX_COUNT).optional(),
        imageDataUris: z.array(z.string().min(1)).max(AGENT_FLOW_ATTACHMENT_MAX_COUNT).optional(),
        replyToMessageId: AgentFlowIdSchema.optional()
    })
    .strict()
    .refine((input) => Boolean(input.text || input.attachments?.length || input.imageDataUris?.length));

export function parseAgentFlowInput<Schema extends z.ZodType>(schema: Schema, value: unknown): z.output<Schema> {
    const result = schema.safeParse(value);
    if (!result.success) throw new Error(t('agentoffice.flow.error.invalidInput'));
    return result.data;
}

export type AgentFlow = z.output<typeof AgentFlowSchema>;
export type AgentFlowStatus = z.output<typeof AgentFlowStatusSchema>;
export type CreateAgentFlowInput = z.input<typeof CreateAgentFlowInputSchema>;
export type UpdateAgentFlowPatch = z.input<typeof UpdateAgentFlowPatchSchema>;
export type AgentFlowListFilter = z.input<typeof AgentFlowListFilterSchema>;
export type AgentFlowMessage = z.output<typeof AgentFlowMessageSchema>;
export type AgentFlowMessageContent = z.output<typeof AgentFlowMessageContentSchema>;
export type AgentFlowResourceContent = z.output<typeof AgentFlowResourceContentSchema>;
export type PrepareAgentFlowUserMessageInput = z.input<typeof PrepareAgentFlowUserMessageInputSchema>;
export type AgentFlowMessageHistoryQuery = z.input<typeof AgentFlowMessageHistoryQuerySchema>;
export type SendAgentFlowMessageInput = z.input<typeof SendAgentFlowMessageInputSchema>;

export interface PreparedAgentFlowUserMessage {
    message: AgentFlowMessage;
    referencedMessage?: AgentFlowMessage;
    imageDataUris: string[];
    created: boolean;
}

export interface AgentFlowMessageHistoryResult {
    messages: AgentFlowMessage[];
    referencedMessages?: AgentFlowMessage[];
    hasMore: boolean;
    nextCursor?: string;
}

export interface AgentFlowMember {
    staffId: string;
    missing: boolean;
    name?: string;
    title?: string;
    enabled?: boolean;
}

export interface AgentFlowSummary extends AgentFlow {
    memberCount: number;
    missingMemberCount: number;
}

export interface AgentFlowDetail extends AgentFlow {
    members: AgentFlowMember[];
}
