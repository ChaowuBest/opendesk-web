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

/**
 * Stable JSON contracts shared by OpenDesk runtime and external integrations.
 * Runtime classes and executable tool implementations intentionally do not belong here.
 */

/** A JSON-safe snapshot of the metadata attached to an OpenDesk message or tool call. */
export interface RuntimeMetadata {
    scope?: 'task' | 'goal' | 'global';
    origin?: {
        source: 'user' | 'internal' | 'hook' | 'scheduler' | 'compact' | 'tool' | 'system';
        reason?: string;
    };
    execution?: {
        turnId?: string;
        generation?: number;
        controller?: 'normal' | 'goal' | 'subtask' | 'system';
        controllerId?: string;
        controllerRevision?: number;
        continuationId?: string;
        supplementIds?: string[];
    };
}

export interface BaseTextMessagePart {
    type: 'text';
    text: string;
    rendered?: string;
}

export interface BaseReasoningMessagePart {
    type: 'reasoning';
    content: string;
    source: 'reasoning_content' | 'think_tag';
    rendered?: string;
    elapsedSeconds?: number;
}

export interface BaseFileMessagePart {
    type: 'file';
    path: string;
    rendered?: string;
    size?: number;
    modifiedTime?: string | number;
}

export interface BaseImageMessagePart {
    type: 'image_url';
    image_url: { url: string };
    rendered?: string;
    file_path?: string;
}

export interface BaseErrorMessagePart {
    type: 'error';
    title: string;
    message: string;
    rendered?: string;
}

export interface ToolResultStorageMetadata {
    result_id: string;
    storage_version: number;
    relative_path?: string;
    original_chars?: number;
    original_lines?: number;
    persisted_at?: string;
    replacement_text?: string;
}

export interface ToolCallMicrocompactMetadata {
    version: number;
    strategy: 'local_clear';
    cleared_at: string;
    original_chars?: number;
    original_lines?: number;
    replacement_text?: string;
    artifact_path_hint?: string;
}

export interface BaseChatToolCall {
    index: number;
    id: string;
    tool_name: string;
    args_string: string;
    args_object: unknown;
    status: 'pending' | 'running' | 'success' | 'error';
    result?: string;
    result_object?: object;
    rendered?: string;
    compress_id?: string;
    result_storage?: ToolResultStorageMetadata;
    microcompact?: ToolCallMicrocompactMetadata;
    metadata?: RuntimeMetadata;
}

export interface BaseToolCallMessagePart {
    type: 'tool_call';
    toolcalls: BaseChatToolCall[];
    rendered?: string;
}

export type UserMessagePart = BaseTextMessagePart | BaseImageMessagePart | BaseFileMessagePart;

export type AssistantMessagePart =
    BaseTextMessagePart | BaseReasoningMessagePart | BaseToolCallMessagePart | BaseErrorMessagePart;

export interface BaseUsage {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
}

export interface BaseSystemMessage {
    role: 'system';
    content: string;
}

export interface BaseUserMessage {
    role: 'user';
    message_id: string;
    content: UserMessagePart[];
    timestamp: number;
    internal?: boolean;
    rawText?: string;
    metadata?: RuntimeMetadata;
}

export interface BaseAssistantMessage {
    role: 'assistant';
    message_id: string;
    content: AssistantMessagePart[];
    usage?: BaseUsage;
    metadata?: RuntimeMetadata;
    timestamp?: number;
}

export interface CompactSummarizedRange {
    start_index: number;
    end_index_exclusive: number;
    message_count: number;
    user_messages: number;
    assistant_messages: number;
    tool_calls: number;
}

export type CompactBoundaryTrigger = 'manual' | 'auto';

export type CompactBoundaryStrategy = 'tail_preserving_full_compact' | 'session_memory_compact';

export interface CompactBoundaryMetadata {
    boundary_id: string;
    summary_version: number;
    created_at: string;
    summarized_range?: CompactSummarizedRange;
    previous_boundary_id?: string;
    trigger?: CompactBoundaryTrigger;
    strategy?: CompactBoundaryStrategy;
    kept_range?: CompactSummarizedRange;
    kept_messages?: number;
    summarized_messages?: number;
    kept_anchor_message_id?: string;
    kept_anchor_message_index?: number;
    kept_anchor_round_index?: number;
    kept_anchor_start_part_index?: number;
}

export interface BaseCompactSeparatorMessage {
    role: 'compact_separator';
    summary: string;
    metadata: CompactBoundaryMetadata;
}

/**
 * The mutable, JSON-serializable message snapshot exposed to request-time plugin hooks.
 * It intentionally excludes ChatContext methods, toolsets and other Aikernel runtime state.
 */
export type ChatMessage = BaseUserMessage | BaseAssistantMessage | BaseCompactSeparatorMessage;

export interface ChatContextSnapshot {
    system_prompt?: BaseSystemMessage;
    messages: ChatMessage[];
}
