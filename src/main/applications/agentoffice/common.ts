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
import type { TaskUsageSummary } from '../../telemetry/local-telemetry.js';

export const StaffTriggerIntervalSchema = z.enum(['5m', '10m', '15m', '30m', '1h', 'never']);

export const StaffDefinitionSchema = z.object({
    name: z.string().trim().min(1),
    vendor_name: z.string().trim().min(1),
    title: z.string().trim().min(1),
    specialties: z.array(z.string().trim().min(1)).default([]),
    trigger_interval: StaffTriggerIntervalSchema.default('never')
});

export const StaffDirectoryPermissionSchema = z.object({
    path: z.string().trim().min(1),
    access: z.enum(['read', 'readwrite'])
});

export const StaffPermissionSchema = z.object({
    directories: z.array(StaffDirectoryPermissionSchema).default([]),
    network_access: z.boolean().default(true)
});

export const StaffResourceContentSchema = z.object({
    type: z.literal('resource'),
    resource_id: z.string().min(1),
    media_type: z.enum(['image', 'video', 'audio', 'file']),
    mime_type: z.string().min(1),
    name: z.string().min(1),
    path: z.string().min(1)
});

export const StaffMessageSchema = z.object({
    id: z.string().min(1),
    role: z.enum(['user', 'assistant']),
    task_id: z.string().min(1),
    created_at: z.string().datetime(),
    status: z.enum(['sent', 'failed']).optional(),
    kind: z.enum(['message', 'error']).optional(),
    content: z.array(z.union([z.object({ type: z.literal('text'), text: z.string() }), StaffResourceContentSchema]))
});

export type StaffDefinition = z.output<typeof StaffDefinitionSchema>;
export type StaffDefinitionInput = z.input<typeof StaffDefinitionSchema>;
export type StaffTriggerInterval = z.output<typeof StaffTriggerIntervalSchema>;
export type StaffPermission = z.output<typeof StaffPermissionSchema>;
export type StaffResourceContent = z.output<typeof StaffResourceContentSchema>;
export type StaffMessage = z.output<typeof StaffMessageSchema>;

export interface StaffMetadata {
    id: string;
    hired_at: string;
    enabled: boolean;
    model?: string;
    last_triggered_at?: string;
    usage_summary?: TaskUsageSummary;
}

export type StaffTaskSource = 'user' | 'scheduled';

export interface StaffTaskRecord {
    task_id: string;
    message_ids: string[];
    status: string;
    source?: StaffTaskSource;
    triggered_at?: string;
    created_at: string;
    updated_at: string;
    usage_summary?: TaskUsageSummary;
}

export interface StaffListItem extends StaffDefinition {
    id: string;
    hired_at: string;
    enabled: boolean;
    model?: string;
    portrait_url?: string;
    message_count: number;
    task_count: number;
    skill_count: number;
    usage_summary?: TaskUsageSummary;
    active_task_id?: string;
}

export interface StaffDetail extends StaffListItem {
    agents_md: string;
    mcp: { servers: unknown[] };
    permission: StaffPermission;
    tasks: StaffTaskRecord[];
}

export interface StaffSkillSummary {
    name: string;
    directory_name: string;
    path: string;
    description: string;
    body: string;
    license?: string;
    compatibility?: string;
    allowed_tools?: string[];
}

export interface InstalledSkillSummary {
    id: string;
    name: string;
    description: string;
    directory_name: string;
    already_added: boolean;
}

export interface StaffSkillImportCandidate {
    path: string;
    name: string;
    type: 'directory' | 'zip';
}

export interface StaffSkillBatchImportResult {
    added: Array<{ path: string; name: string }>;
    errors: Array<{ path: string; message: string }>;
}

export interface StaffUpdateInput {
    definition?: StaffDefinitionInput;
    agents_md?: string;
    mcp?: { servers: unknown[] };
    permission?: StaffPermission;
    enabled?: boolean;
    model?: string | null;
    portrait_path?: string | null;
    portrait_data_uri?: string | null;
}

export type HistoryQuery =
    | { mode: 'recent'; limit: number; cursor?: string }
    | { mode: 'time_range'; start_time: string; end_time: string; limit?: number; cursor?: string };

export interface HistoryResult {
    messages: StaffMessage[];
    has_more: boolean;
    next_cursor?: string;
}

export interface MessageAttachmentInput {
    path: string;
    name?: string;
}

export interface SendStaffMessageInput {
    text?: string;
    attachments?: MessageAttachmentInput[];
    image_data_uris?: string[];
}

export interface PreparedMessage {
    message: StaffMessage;
    image_data_uris: string[];
}

export interface PresetStaffDefinition {
    key: string;
    definition: StaffDefinitionInput;
    agents_md: string;
}

export interface DueStaffTrigger {
    staff_id: string;
    triggered_at: string;
    previous_triggered_at?: string;
}

const STAFF_TRIGGER_INTERVAL_MS: Record<Exclude<StaffTriggerInterval, 'never'>, number> = {
    '5m': 5 * 60 * 1000,
    '10m': 10 * 60 * 1000,
    '15m': 15 * 60 * 1000,
    '30m': 30 * 60 * 1000,
    '1h': 60 * 60 * 1000
};

export function staffTriggerIntervalMs(interval: StaffTriggerInterval): number | undefined {
    return interval === 'never' ? undefined : STAFF_TRIGGER_INTERVAL_MS[interval];
}

export function unwrapAgentOfficeCallResult<T>(result: unknown, fallbackMessage: string): T {
    if (result && typeof result === 'object' && 'status' in result) {
        const wrapped = result as { status?: string; data?: T; message?: string };
        if (wrapped.status === 'error') throw new Error(wrapped.message || fallbackMessage);
        if (wrapped.status === 'ok') return wrapped.data as T;
    }
    return result as T;
}

export function emptyUsageSummary(): TaskUsageSummary {
    return {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        request_count: 0
    };
}

export function sumTaskUsage(tasks: StaffTaskRecord[]): TaskUsageSummary {
    const result = emptyUsageSummary();
    for (const task of tasks) {
        const usage = task.usage_summary;
        if (!usage) continue;
        result.prompt_tokens += usage.prompt_tokens;
        result.completion_tokens += usage.completion_tokens;
        result.total_tokens += usage.total_tokens;
        result.input_tokens += usage.input_tokens;
        result.output_tokens += usage.output_tokens;
        result.cache_creation_input_tokens += usage.cache_creation_input_tokens;
        result.cache_read_input_tokens += usage.cache_read_input_tokens;
        result.request_count += usage.request_count;
        if (usage.updated_at && (!result.updated_at || usage.updated_at > result.updated_at)) {
            result.updated_at = usage.updated_at;
        }
    }
    return result;
}
