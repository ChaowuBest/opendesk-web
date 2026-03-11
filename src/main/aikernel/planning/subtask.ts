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

import { jsonrepair } from 'jsonrepair';
import { analyzeExecutionMode } from './strategy.js';

export interface SubTaskBudget {
    max_steps?: number;
}

export interface SubTaskRequest {
    subtask_title?: string;
    sub_goal: string;
    done_criteria: string;
    context?: string;
    allowed_tools?: string[];
    budget?: SubTaskBudget;
}

export interface SubTaskResult {
    status: 'success' | 'error';
    summary: string;
    key_data: Record<string, any>;
    artifacts: string[];
    next_action?: string;
    subtask_id: string;
    raw_output?: string;
}

interface ParsedSubTaskResult {
    status?: string;
    summary?: string;
    key_data?: Record<string, any>;
    next_action?: string;
}

export interface SubTaskScopeAnalysis {
    should_split: boolean;
    score: number;
    reasons: string[];
    signals: {
        path_count: number;
        separator_count: number;
        action_count: number;
        list_count: number;
        clause_count: number;
    };
    suggested_sub_goals: string[];
}

function normalizeText(input: string): string {
    return input.trim().replace(/\s+/g, ' ');
}

function safeSlice(input: string, maxLen: number): string {
    return input.length <= maxLen ? input : `${input.slice(0, maxLen)}...`;
}

export function buildSubTaskPrompt(request: SubTaskRequest, missionAnchor?: string): string {
    return buildSubTaskSystemPrompt(request, missionAnchor);
}

function splitSubGoalCandidates(rawText: string, maxItems = 4): string[] {
    if (!rawText) return [];
    const normalized = normalizeText(rawText);
    const separated = normalized
        .replace(/\b(and then|also|then|next|after that)\b/gi, '\n')
        .replace(/(以及|并且|同时|另外|然后|再|此外|同时还|并且还)/g, '\n')
        .replace(/[;\uFF1B]/g, '\n');
    const pieces = separated
        .split(/\n+/)
        .map(part => part.trim())
        .filter(part => part.length >= 8)
        .slice(0, maxItems * 2);

    const deduped: string[] = [];
    const seen = new Set<string>();
    for (const part of pieces) {
        const key = part.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(safeSlice(part, 140));
        if (deduped.length >= maxItems) break;
    }
    return deduped;
}

export function analyzeSubTaskScope(request: SubTaskRequest): SubTaskScopeAnalysis {
    const scopeText = [request.sub_goal, request.done_criteria, request.context]
        .filter(Boolean)
        .join('\n');
    const decision = analyzeExecutionMode({ userMessage: scopeText });
    const suggestedSubGoals = splitSubGoalCandidates(scopeText, 4);
    const shouldSplit = decision.mode === 'delegate' && (
        decision.reasons.includes('hard_delegate_multi_intent')
        || decision.signals.path_count >= 2
        || decision.signals.separator_count >= 2
        || decision.signals.action_count >= 4
        || suggestedSubGoals.length >= 2
    );

    return {
        should_split: shouldSplit,
        score: decision.score,
        reasons: decision.reasons,
        signals: decision.signals,
        suggested_sub_goals: suggestedSubGoals,
    };
}

export function buildSubTaskSystemPrompt(request: SubTaskRequest, missionAnchor?: string): string {
    const allowedToolsText = request.allowed_tools?.length
        ? request.allowed_tools.join(', ')
        : 'inherit-from-parent';
    const maxSteps = request.budget?.max_steps ?? 8;

    return [
        'You are a delegated subtask executor.',
        'Focus only on the assigned sub-goal and return a strict JSON result.',
        '',
        `Mission anchor: ${missionAnchor ? safeSlice(normalizeText(missionAnchor), 500) : 'n/a'}`,
        request.subtask_title ? `Sub-task title: ${safeSlice(normalizeText(request.subtask_title), 40)}` : '',
        `Sub-goal: ${safeSlice(normalizeText(request.sub_goal), 400)}`,
        `Done criteria: ${safeSlice(normalizeText(request.done_criteria), 400)}`,
        `Execution budget: max_steps=${maxSteps}, timeout=disabled`,
        `Allowed tools: ${allowedToolsText}`,
        request.context ? `Context: ${safeSlice(request.context, 1000)}` : '',
        '',
        'Return format requirements:',
        '1) At completion, output one JSON object wrapped by <subtask_result_json>...</subtask_result_json>.',
        '2) JSON schema:',
        '{',
        '  "status": "success|error",',
        '  "summary": "one-paragraph summary",',
        '  "key_data": { "any": "structured key facts" },',
        '  "next_action": "optional next step for parent task"',
        '}',
        '3) Do not add markdown fences inside <subtask_result_json>.',
        '4) If you cannot finish, set status=error and explain why in summary.',
    ].filter(Boolean).join('\n');
}

export function buildSubTaskUserPrompt(request: SubTaskRequest): string {
    return [
        request.subtask_title ? `Sub-task title: ${safeSlice(normalizeText(request.subtask_title), 40)}` : '',
        `Sub-goal: ${safeSlice(normalizeText(request.sub_goal), 260)}`,
        `Done criteria: ${safeSlice(normalizeText(request.done_criteria), 220)}`,
        request.context ? `Key context: ${safeSlice(normalizeText(request.context), 300)}` : '',
        'Execute only this sub-goal and report result as requested by system instructions.',
    ].filter(Boolean).join('\n');
}

function extractTaggedJson(text: string): string | null {
    const match = text.match(/<subtask_result_json>([\s\S]*?)<\/subtask_result_json>/i);
    if (!match) return null;
    return match[1].trim();
}

function extractFirstJsonObject(text: string): string | null {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    return text.slice(start, end + 1);
}

function parseJsonObject(text: string): ParsedSubTaskResult | null {
    try {
        return JSON.parse(text) as ParsedSubTaskResult;
    } catch {
        try {
            return JSON.parse(jsonrepair(text)) as ParsedSubTaskResult;
        } catch {
            return null;
        }
    }
}

export function parseSubTaskResult(text: string): ParsedSubTaskResult | null {
    if (!text) return null;

    const tagged = extractTaggedJson(text);
    if (tagged) {
        const parsedTagged = parseJsonObject(tagged);
        if (parsedTagged) return parsedTagged;
    }

    const firstObject = extractFirstJsonObject(text);
    if (firstObject) {
        return parseJsonObject(firstObject);
    }
    return null;
}
