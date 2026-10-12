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
import { AgentFlowIdSchema, AgentFlowTaskIdSchema } from './common.js';
import type { FlowHistorySnapshot } from './context.js';

export const FlowReadingIntervalSchema = z.union([
    z.literal(5),
    z.literal(10),
    z.literal(15),
    z.literal(20),
    z.literal(30),
    z.literal(60)
]);

export const FlowReadingBatchSchema = z
    .object({
        batchId: AgentFlowIdSchema,
        flowId: AgentFlowIdSchema,
        staffId: AgentFlowIdSchema,
        taskId: AgentFlowTaskIdSchema.optional(),
        taskDeletedAt: z.string().datetime().optional(),
        trigger: z.enum(['manual', 'mention', 'user', 'message', 'timer']),
        sourceMessageId: AgentFlowIdSchema.optional(),
        retryOfBatchId: AgentFlowIdSchema.optional(),
        unreadMessageIds: z.array(AgentFlowIdSchema),
        snapshotMessageIds: z.array(AgentFlowIdSchema),
        snapshotHighWater: z.number().int().nonnegative(),
        status: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled']),
        createdAt: z.string().datetime(),
        startedAt: z.string().datetime().optional(),
        completedAt: z.string().datetime().optional(),
        failureCount: z.number().int().nonnegative(),
        failure: z.string().optional(),
        replies: z.array(z.object({ key: z.string(), messageId: AgentFlowIdSchema }))
    })
    .strict();

export const FlowReadingStateSchema = z
    .object({
        schemaVersion: z.literal(1),
        flowId: AgentFlowIdSchema,
        deleting: z.boolean().default(false),
        members: z.record(
            AgentFlowIdSchema,
            z
                .object({
                    readMessageIds: z.array(AgentFlowIdSchema),
                    pendingUserMessageIds: z.array(AgentFlowIdSchema),
                    userEventBaselineIds: z.array(AgentFlowIdSchema).default([]),
                    failureCount: z.number().int().nonnegative(),
                    intervalMinutes: FlowReadingIntervalSchema.default(10),
                    name: z.string().optional(),
                    lastTimerSlot: z.string().datetime().optional()
                })
                .strict()
        ),
        batches: z.array(FlowReadingBatchSchema)
    })
    .strict();

export type FlowReadingBatch = z.output<typeof FlowReadingBatchSchema>;
export type FlowReadingState = z.output<typeof FlowReadingStateSchema>;
export interface FlowReadingClaim {
    status: 'claimed' | 'busy' | 'empty' | 'existing';
    batch?: FlowReadingBatch;
    snapshot?: FlowHistorySnapshot;
}
