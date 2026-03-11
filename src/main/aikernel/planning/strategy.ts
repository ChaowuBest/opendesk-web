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
 * Lightweight planning strategy utilities.
 * The goal is to keep planning behavior deterministic instead of relying on prompt-only control.
 */

export type TaskExecutionMode = 'none' | 'lite' | 'delegate';

export interface ExecutionModeInput {
    userMessage: string;
    enabledToolNames?: string[];
    hasAttachments?: boolean;
}

export interface RuntimePolicyInput {
    missionAnchor: string;
    mode: TaskExecutionMode;
    requireInitialTodo: boolean;
    decisionStyle?: 'fixed' | 'model_with_score';
    scoreSuggestion?: {
        mode: TaskExecutionMode;
        score: number;
        reasons: string[];
    };
}

export interface TodoLike {
    id?: string;
    title?: string;
    content?: string;
    status?: string;
}

export interface NormalizedTodo {
    id?: string;
    title: string;
    content: string;
    status: 'pending' | 'in_progress' | 'completed';
}

export interface NormalizeTodoOptions {
    mode: TaskExecutionMode;
    firstPlan: boolean;
    minTodos?: number;
    maxTodos?: number;
}

export interface NormalizeTodoResult {
    blocked: boolean;
    reason?: string;
    todos: NormalizedTodo[];
    changed: boolean;
}

export interface ExecutionModeDecision {
    mode: TaskExecutionMode;
    score: number;
    reasons: string[];
    signals: {
        path_count: number;
        separator_count: number;
        action_count: number;
        list_count: number;
        clause_count: number;
    };
}

const MULTI_GOAL_PATTERN = /(\u5e76\u4e14|\u540c\u65f6|\u53e6\u5916|\u5206\u522b|\u591a\u4e2a|\u6279\u91cf|multi|multiple|for each|each|and then|at the same time)/i;
const COMPLEX_PATTERN = /(\u590d\u6742|\u6d41\u7a0b|\u5de5\u4f5c\u6d41|review|refactor|pipeline|workflow|orchestrate)/i;
const DELEGATE_PATTERN = /(\u5b50\u4efb\u52a1|parallel|delegate|orchestr|multi-agent|planner)/i;
const ATTACHMENT_PROCESS_PATTERN = /(\u63d0\u53d6|\u603b\u7ed3|\u89e3\u6790|extract|summarize|parse)/i;
const MICRO_OPERATION_PATTERN = /(\u68c0\u67e5|\u9a8c\u8bc1|verify|check|cd\s+|ls\b|dir\b|pwd\b)/i;
const DELIVERABLE_PATTERN = /(\u63d0\u53d6|\u751f\u6210|\u8f93\u51fa|\u6c47\u603b|\u5199\u5165|\u8f6c\u6362|extract|output|generate|summarize|convert|report)/i;
const ACTION_PATTERN = /(extract|read|parse|classify|summarize|generate|write|create|convert|analy(?:s|z)e|sort|count|\u63d0\u53d6|\u8bfb\u53d6|\u5f52\u7c7b|\u751f\u6210|\u5199\u5165|\u6c47\u603b|\u7edf\u8ba1|\u8f6c\u6362)/gi;
const PATH_PATTERN = /[A-Za-z]:[\\/][^\s"'`;,\uFF0C\u3002]+/g;
const SEPARATOR_PATTERN = /[;\uFF1B\u3002]+|\n+/g;
const ENGLISH_SEPARATOR_PATTERN = /\b(and then|then|also|next|after that)\b/gi;
const LIST_PATTERN = /(?:^|\s)(?:\d+[.)]|[\u2460-\u2469]|[-*])\s+/gm;

function normalizeText(input: string): string {
    return input.trim().replace(/\s+/g, ' ');
}

function safeSlice(input: string, maxLen: number): string {
    return input.length <= maxLen ? input : `${input.slice(0, maxLen)}...`;
}

function toStatus(value: string | undefined): 'pending' | 'in_progress' | 'completed' {
    if (value === 'completed') return 'completed';
    if (value === 'in_progress') return 'in_progress';
    return 'pending';
}

function buildToolFamilySet(enabledToolNames: string[]): Set<string> {
    const families = new Set<string>();
    for (const name of enabledToolNames) {
        const idx = name.indexOf('-');
        families.add(idx > 0 ? name.slice(0, idx) : name);
    }
    return families;
}

function sanitizeTodo(todo: TodoLike): NormalizedTodo | null {
    const content = normalizeText(String(todo.content ?? ''));
    const title = normalizeText(String(todo.title ?? ''));
    const bestTitle = title || safeSlice(content, 40);
    if (!bestTitle && !content) return null;
    return {
        id: todo.id,
        title: bestTitle || 'Untitled todo',
        content: content || bestTitle,
        status: toStatus(todo.status),
    };
}

function deduplicateTodos(todos: NormalizedTodo[]): NormalizedTodo[] {
    const deduped: NormalizedTodo[] = [];
    const seen = new Set<string>();
    for (const todo of todos) {
        const key = `${todo.title}|${todo.content}`.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(todo);
    }
    return deduped;
}

function isMicroOperationalStep(todo: NormalizedTodo): boolean {
    const text = `${todo.title} ${todo.content}`;
    return MICRO_OPERATION_PATTERN.test(text) && !DELIVERABLE_PATTERN.test(text);
}

function normalizeInitialStatuses(todos: NormalizedTodo[]): NormalizedTodo[] {
    return todos.map((todo, idx) => ({
        ...todo,
        status: idx === 0 ? 'in_progress' : 'pending',
    }));
}

function countMatches(input: string, regex: RegExp, maxCount = 50): number {
    const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
    const pattern = new RegExp(regex.source, flags);
    let count = 0;
    while (count < maxCount && pattern.exec(input) !== null) {
        count += 1;
    }
    return count;
}

export function analyzeExecutionMode(input: ExecutionModeInput): ExecutionModeDecision {
    const userMessage = normalizeText(input.userMessage || '');
    if (!userMessage) {
        return {
            mode: 'none',
            score: 0,
            reasons: ['empty_message'],
            signals: {
                path_count: 0,
                separator_count: 0,
                action_count: 0,
                list_count: 0,
                clause_count: 0,
            },
        };
    }

    let score = 0;
    const reasons: string[] = [];

    if (MULTI_GOAL_PATTERN.test(userMessage)) {
        score += 2;
        reasons.push('multi_goal_keyword');
    }
    if (COMPLEX_PATTERN.test(userMessage)) {
        score += 1;
        reasons.push('complex_keyword');
    }
    if (DELEGATE_PATTERN.test(userMessage)) {
        score += 2;
        reasons.push('delegate_keyword');
    }
    if ((input.hasAttachments ?? false) && ATTACHMENT_PROCESS_PATTERN.test(userMessage)) {
        score += 1;
        reasons.push('attachment_with_processing');
    }
    if (userMessage.length > 80) {
        score += 1;
        reasons.push('long_message');
    }

    const pathCount = countMatches(userMessage, PATH_PATTERN, 16);
    if (pathCount >= 2) {
        score += 2;
        reasons.push(`multi_path(${pathCount})`);
    }
    if (pathCount >= 4) {
        score += 1;
        reasons.push('many_paths');
    }

    const separatorCount = countMatches(userMessage, SEPARATOR_PATTERN, 24) + countMatches(userMessage, ENGLISH_SEPARATOR_PATTERN, 24);
    if (separatorCount >= 2) {
        score += 2;
        reasons.push(`multi_segment(${separatorCount})`);
    }

    const actionCount = countMatches(userMessage, ACTION_PATTERN, 24);
    if (actionCount >= 3) {
        score += 2;
        reasons.push(`multi_action(${actionCount})`);
    }
    if (actionCount >= 5) {
        score += 1;
        reasons.push('many_actions');
    }

    const listCount = countMatches(userMessage, LIST_PATTERN, 24);
    if (listCount >= 2) {
        score += 1;
        reasons.push(`list_structure(${listCount})`);
    }

    const clauseCount = Math.max(1, separatorCount + 1);
    if (clauseCount >= 4) {
        score += 1;
        reasons.push(`many_clauses(${clauseCount})`);
    }

    const toolNames = input.enabledToolNames ?? [];
    const families = buildToolFamilySet(toolNames);
    if (families.size >= 3) {
        score += 1;
        reasons.push(`tool_family(${families.size})`);
    }
    if (toolNames.some(t => t.startsWith('terminal-')) && toolNames.some(t => t.startsWith('search-'))) {
        score += 1;
        reasons.push('terminal_search_combo');
    }

    const multiIntentSignals = (pathCount >= 2 ? 1 : 0)
        + (separatorCount >= 2 ? 1 : 0)
        + (actionCount >= 3 ? 1 : 0)
        + (listCount >= 2 ? 1 : 0);

    let mode: TaskExecutionMode = 'none';
    if (multiIntentSignals >= 2 && (actionCount >= 2 || pathCount >= 2)) {
        mode = 'delegate';
        reasons.push('hard_delegate_multi_intent');
    } else if (score >= 5) {
        mode = 'delegate';
    } else if (score >= 2) {
        mode = 'lite';
    }

    return {
        mode,
        score,
        reasons,
        signals: {
            path_count: pathCount,
            separator_count: separatorCount,
            action_count: actionCount,
            list_count: listCount,
            clause_count: clauseCount,
        },
    };
}

export function decideExecutionMode(input: ExecutionModeInput): TaskExecutionMode {
    return analyzeExecutionMode(input).mode;
}

export function shouldRequireInitialTodoWrite(mode: TaskExecutionMode, userMessage: string): boolean {
    if (mode === 'none') return false;
    // Delegate mode should orchestrate through planning-delegateTask at root level.
    // Subtasks run in lite mode and can use TodoWrite locally.
    if (mode === 'delegate') return false;
    return /(\u590d\u6742|\u591a\u6b65|\u6d41\u7a0b|\u63d0\u53d6|\u89e3\u6790|\u8f6c\u6362|convert|extract|analyze)/i.test(userMessage) || userMessage.length > 60;
}

export function buildMissionAnchor(userMessage: string): string {
    const normalized = normalizeText(userMessage);
    return safeSlice(normalized, 500);
}

export function buildRuntimeExecutionPolicy(input: RuntimePolicyInput): string {
    const decisionStyle = input.decisionStyle ?? 'fixed';
    const scoreSuggestion = input.scoreSuggestion;
    const suggestionReasons = scoreSuggestion?.reasons?.slice(0, 8).join(', ') || 'n/a';
    const strategySuggestsDelegate = scoreSuggestion?.mode === 'delegate';

    if (decisionStyle === 'model_with_score') {
        return [
            '<runtime_execution_policy>',
            `- mission_anchor: ${input.missionAnchor}`,
            `- execution_mode: ${input.mode}`,
            `- require_initial_todowrite: ${input.requireInitialTodo ? 'true' : 'false'}`,
            '- mode_decision: model_with_score',
            `- strategy_suggestion_mode: ${scoreSuggestion?.mode ?? 'none'}`,
            `- strategy_score: ${scoreSuggestion?.score ?? 0}`,
            `- strategy_reasons: ${suggestionReasons}`,
            ...(strategySuggestsDelegate
                ? [
                    '- strategy_delegate_bias: strong',
                    '- strategy_delegate_bias_rule: score suggests delegate, so prefer planning-delegateTask as first business action.',
                ]
                : []),
            '- planning_rules:',
            '  1) Strategy score is a reference signal, not a hard command.',
            '  2) Decide mode in this main-task dialog by your first execution action:',
            '     - planning-delegateTask => delegate mode',
            '     - todomgr-TodoWrite => lite mode',
            '     - direct business tool => direct execution for this turn',
            ...(strategySuggestsDelegate
                ? [
                    '  2.1) Current strategy suggestion is delegate: strongly prefer planning-delegateTask',
                    '  2.2) One planning-delegateTask call must map to one focused sub-goal. If there are multiple goals, create multiple calls.',
                ]
                : []),
            '  3) If you choose delegate mode, keep root execution through planning-delegateTask.',
            '  4) Todo granularity must be result-oriented, not operation-oriented.',
            '  5) Keep todo count in [1,3], hard max 4. Merge tiny operational steps.',
            '  6) Always align with mission_anchor, do not drift to side quests.',
            '</runtime_execution_policy>',
        ].join('\n');
    }

    return [
        '<runtime_execution_policy>',
        `- mission_anchor: ${input.missionAnchor}`,
        `- execution_mode: ${input.mode}`,
        `- require_initial_todowrite: ${input.requireInitialTodo ? 'true' : 'false'}`,
        '- planning_rules:',
        '  1) If execution_mode=none: do not call TodoWrite. Execute directly and return result.',
        '  2) If execution_mode=lite and require_initial_todowrite=true, call TodoWrite first.',
        '  3) If execution_mode=delegate: split goals and call planning-delegateTask for execution.',
        '  4) In delegate mode, one planning-delegateTask call maps to one focused sub-goal.',
        '  5) In delegate mode root task, do not execute business tools directly and do not use TodoWrite.',
        '  6) Todo granularity must be result-oriented, not operation-oriented.',
        '  7) Keep todo count in [2,5], hard max 6. Merge tiny operational steps.',
        '  8) Always align with mission_anchor, do not drift to side quests.',
        '</runtime_execution_policy>',
    ].join('\n');
}

export function normalizeTodoWriteTodos(rawTodos: TodoLike[], options: NormalizeTodoOptions): NormalizeTodoResult {
    const todos = Array.isArray(rawTodos) ? rawTodos : [];
    const minTodos = options.minTodos ?? 2;
    const maxTodos = options.maxTodos ?? 6;

    if (options.mode === 'none') {
        return {
            blocked: true,
            reason: 'simple_task_mode_skips_todowrite',
            todos: [],
            changed: todos.length > 0,
        };
    }

    let normalized = deduplicateTodos(
        todos
            .map(sanitizeTodo)
            .filter((item): item is NormalizedTodo => item !== null)
            .map(todo => ({
                ...todo,
                title: safeSlice(todo.title, 80),
                content: safeSlice(todo.content, 500),
            }))
    );

    if (normalized.length === 0) {
        return { blocked: false, todos: [], changed: false };
    }

    if (options.firstPlan) {
        const droppedMicro = normalized.filter(todo => !isMicroOperationalStep(todo));
        if (droppedMicro.length >= minTodos) {
            normalized = droppedMicro;
        }
        if (normalized.length > maxTodos) {
            normalized = normalized.slice(0, maxTodos);
        }
        normalized = normalizeInitialStatuses(normalized);
    } else {
        if (normalized.length > maxTodos) {
            normalized = normalized.slice(0, maxTodos);
        }
        normalized = normalized.map(todo => ({ ...todo, status: toStatus(todo.status) }));
    }

    return {
        blocked: false,
        todos: normalized,
        changed: JSON.stringify(todos) !== JSON.stringify(normalized),
    };
}

export function isPlanningTool(toolName: string): boolean {
    return toolName === 'todomgr-TodoWrite';
}

export function isToolAllowedBeforePlanning(toolName: string): boolean {
    if (isPlanningTool(toolName)) return true;
    if (toolName === 'planning-delegateTask') return true;
    if (toolName === 'todomgr-getCurrentTime') return true;
    if (toolName.startsWith('memory-')) return true;
    return false;
}
