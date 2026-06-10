/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import type { UsageFields } from '../messages.js';

export type BenchmarkUsageRequestType = 'complete' | 'streamComplete';

export interface BenchmarkUsageRequestRecord {
    request_index: number;
    task_id: string;
    turn: number;
    request_type: BenchmarkUsageRequestType;
    model?: string;
    provider?: string;
    start_ms: number;
    end_ms: number;
    duration_ms: number;
    retry_count: number;
    retry_reason?: string;
    retry_reasons: string[];
    usage_present: boolean;
    usage?: UsageFields;
}

export interface BenchmarkUsageSummary {
    request_count: number;
    retry_count: number;
    usage_present_count: number;
    missing_usage_count: number;
    usage_coverage: number;
    missing_usage_rate: number;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    cached_token_ratio: number;
}

export interface BenchmarkUsageTaskSummary {
    task_status: string;
    task_success: boolean;
    stop_requested_by_user: boolean;
    started_at?: string;
    finished_at?: string;
    wall_clock_ms: number;
    total_elapsed_ms: number;
    request_count: number;
    retry_count: number;
    turn_count: number;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    cached_token_ratio: number;
}

export interface BenchmarkUsageReport {
    version: 1;
    task_id: string;
    generated_at: string;
    requests: BenchmarkUsageRequestRecord[];
    summary: BenchmarkUsageSummary;
    task_summary?: BenchmarkUsageTaskSummary;
}

export interface BenchmarkUsageTaskReport {
    version: 1;
    task_id: string;
    generated_at: string;
    task_summary?: BenchmarkUsageTaskSummary;
}
