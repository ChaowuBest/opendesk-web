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

import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseJsonWithRepair } from '../../utils/json.js';
import {
    AssistantMessage,
    CompactSeparatorMessage,
    UserMessage,
    type ChatContext,
    type ToolCall,
    type UsageFields
} from '../aikernel/messages.js';
import type { ToolResultPreviewOptions } from '../aikernel/compaction/tool-results.js';
import { estimateTextTokens } from '../aikernel/compaction/token-estimation.js';
import type { TaskState } from '../aikernel/states/tasks.js';
import { Setting } from './setting.js';

export type EvidenceCardPhase = 'plan' | 'localize' | 'inspect' | 'patch' | 'verify' | 'replan' | 'answer' | 'other';

export type EvidenceCardEvidenceKind =
    | 'repo_map'
    | 'symbol_signature'
    | 'function_body'
    | 'caller_callee'
    | 'failing_test'
    | 'error_trace'
    | 'config_block'
    | 'edit_region'
    | 'full_file'
    | 'multi_file_context'
    | 'llm_context'
    | 'search_result'
    | 'tool_observation';

type EvidenceToolCall = Pick<ToolCall, 'tool_name' | 'args_string' | 'args_object' | 'tool' | 'status'>;

interface RelevantEvidenceToolInvocation {
    kind: 'file' | 'shell';
    toolName: string;
    args: Record<string, unknown>;
}

interface EvidenceToolSemantics {
    target: string;
    evidenceKind: EvidenceCardEvidenceKind;
    phase: EvidenceCardPhase;
}

const FILE_EVIDENCE_TOOL_NAMES = new Set(['readfile', 'extracttext', 'globfiles', 'grepfiles', 'semanticsearch']);
const SHELL_EVIDENCE_TOOL_NAMES = new Set(['executebash', 'executezsh', 'executepwsh', 'executepowershell']);
const CONFIG_FILE_PATTERN = /(?:^|\/)(?:package\.json|pyproject\.toml|dockerfile|[^/]+\.(?:ya?ml|toml|ini|cfg|conf))$/i;
const SHELL_SEARCH_COMMAND_PATTERN =
    /^(?:rg|ripgrep|grep|find|findstr|fd|ls|dir|get-childitem|select-string|git\s+(?:ls-files|grep))\b/i;
const SHELL_READ_COMMAND_PATTERN =
    /^(?:get-content|cat|nl|type|head|tail|git\s+(?:show|log|blame))\b|^sed\s+(?:-[a-z]*n\b|--quiet\b|--silent\b)/i;
const SHELL_CONTROL_OR_REDIRECT_PATTERN = /&&|\|\||;|[\r\n]|\$\(|`|>{1,2}|(?:^|[^&])&(?!&)/;
const MUTATING_FIND_PATTERN = /^find\b.*(?:-delete|-exec|-execdir|-ok|-okdir)\b/i;
const SHELL_READONLY_PIPE_COMMANDS = new Set([
    'rg',
    'ripgrep',
    'grep',
    'findstr',
    'select-string',
    'get-content',
    'cat',
    'nl',
    'type',
    'head',
    'tail',
    'sed',
    'sort',
    'uniq',
    'wc',
    'cut',
    'tr',
    'select-object',
    'where-object',
    'sort-object',
    'format-table',
    'out-string',
    'measure-object'
]);

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseEvidenceObject(value: unknown): Record<string, unknown> {
    if (value === undefined || value === null) return {};
    if (isRecord(value)) return value;
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return {};
        const parsed = parseJsonWithRepair(trimmed);
        if (parsed === null) return {};
        if (isRecord(parsed)) return parsed;
    }
    throw new Error('证据工具参数无法解析为对象');
}

function readString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'string' && value.trim().length > 0) {
            return value.trim();
        }
    }
    return undefined;
}

function readNumber(record: Record<string, unknown>, ...keys: string[]): number | undefined {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'number' && Number.isFinite(value)) {
            return value;
        }
    }
    return undefined;
}

function stableSerialize(value: unknown, seen: Set<object> = new Set()): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
    if (typeof value !== 'object') return JSON.stringify(String(value));
    if (seen.has(value)) return '"[Circular]"';
    seen.add(value);
    if (Array.isArray(value)) {
        const result = '[' + value.map((item) => stableSerialize(item, seen)).join(',') + ']';
        seen.delete(value);
        return result;
    }
    const record = value as Record<string, unknown>;
    const result =
        '{' +
        Object.keys(record)
            .sort()
            .map((key) => JSON.stringify(key) + ':' + stableSerialize(record[key], seen))
            .join(',') +
        '}';
    seen.delete(value);
    return result;
}

function digestEvidenceValue(value: unknown): string {
    return createHash('sha256').update(stableSerialize(value), 'utf8').digest('hex').slice(0, 16);
}

function limitTarget(target: string): string {
    if (target.length <= 240) return target;
    return target.slice(0, 215) + ':hash=' + digestEvidenceValue(target);
}

function normalizePath(value: string): string {
    const slashed = value.trim().replace(/\\/g, '/');
    const isUncPath = slashed.startsWith('//');
    const normalized = path.posix.normalize(slashed);
    const withUncPrefix = isUncPath && !normalized.startsWith('//') ? '/' + normalized : normalized;
    return withUncPrefix.replace(/^([a-z]):/i, (_match, drive: string) => drive.toUpperCase() + ':');
}

function parseEvidenceToolCallArgs(toolCall: EvidenceToolCall): Record<string, unknown> {
    if (isRecord(toolCall.args_object)) {
        if (Object.keys(toolCall.args_object).length > 0 || !toolCall.args_string) {
            return toolCall.args_object;
        }
    }
    if (!toolCall.args_string) return {};
    try {
        return parseEvidenceObject(toolCall.args_string);
    } catch {
        return {};
    }
}

function hasUnsafeShellComposition(command: string): boolean {
    if (SHELL_CONTROL_OR_REDIRECT_PATTERN.test(command) || MUTATING_FIND_PATTERN.test(command)) {
        return true;
    }
    return command
        .split('|')
        .slice(1)
        .some((segment) => {
            const commandName = segment
                .trim()
                .match(/^([a-z][\w-]*)/i)?.[1]
                .toLowerCase();
            return !commandName || !SHELL_READONLY_PIPE_COMMANDS.has(commandName);
        });
}

function isQualifiedTool(toolCall: EvidenceToolCall, toolsetName: string, toolName: string): boolean {
    const qualifiedName = toolCall.tool_name?.trim().toLowerCase();
    const expectedName = `${toolsetName}-${toolName}`.toLowerCase();
    if (qualifiedName === expectedName) return true;
    return qualifiedName === toolName.toLowerCase() && toolCall.tool?.name.toLowerCase() === toolName.toLowerCase();
}

function resolveRelevantEvidenceToolInvocation(toolCall: EvidenceToolCall): RelevantEvidenceToolInvocation | undefined {
    const args = parseEvidenceToolCallArgs(toolCall);

    for (const toolName of FILE_EVIDENCE_TOOL_NAMES) {
        if (isQualifiedTool(toolCall, 'filemgr', toolName)) {
            return { kind: 'file', toolName, args };
        }
    }
    for (const toolName of SHELL_EVIDENCE_TOOL_NAMES) {
        if (isQualifiedTool(toolCall, 'terminal', toolName)) {
            return { kind: 'shell', toolName, args };
        }
    }

    if (!isQualifiedTool(toolCall, 'skill-manager', 'callskilltool')) {
        return undefined;
    }
    const innerToolName = readString(args, 'toolName')?.toLowerCase();
    if (
        !innerToolName ||
        (!FILE_EVIDENCE_TOOL_NAMES.has(innerToolName) && !SHELL_EVIDENCE_TOOL_NAMES.has(innerToolName))
    ) {
        return undefined;
    }
    let innerArgs: Record<string, unknown>;
    try {
        innerArgs = parseEvidenceObject(args.toolArgs);
    } catch {
        return undefined;
    }
    return {
        kind: FILE_EVIDENCE_TOOL_NAMES.has(innerToolName) ? 'file' : 'shell',
        toolName: innerToolName,
        args: innerArgs
    };
}

function resolveFileEvidenceSemantics(invocation: RelevantEvidenceToolInvocation): EvidenceToolSemantics | undefined {
    const args = invocation.args;
    const rawPath = readString(args, 'file_path', 'filePath');
    const filePath = rawPath ? normalizePath(rawPath) : undefined;

    if (invocation.toolName === 'readfile') {
        if (!filePath) return undefined;
        const offset = readNumber(args, 'offset');
        const limit = readNumber(args, 'limit');
        const range =
            offset !== undefined || limit !== undefined
                ? `lines=${offset ?? 1}..${limit !== undefined ? (offset ?? 1) + limit - 1 : 'end'}`
                : 'full';
        return {
            target: limitTarget(`file:read:${filePath}:${range}`),
            evidenceKind:
                range !== 'full' ? 'function_body' : CONFIG_FILE_PATTERN.test(filePath) ? 'config_block' : 'full_file',
            phase: 'inspect'
        };
    }
    if (invocation.toolName === 'extracttext') {
        if (!filePath) return undefined;
        return {
            target: limitTarget(`file:extractText:${filePath}:full`),
            evidenceKind: 'full_file',
            phase: 'inspect'
        };
    }
    if (invocation.toolName === 'globfiles') {
        const pattern = readString(args, 'pattern');
        if (!pattern) return undefined;
        const root = readString(args, 'path');
        return {
            target: limitTarget(
                `file:glob:${root ? normalizePath(root) : 'workspace'}:query=${digestEvidenceValue(args)}`
            ),
            evidenceKind: 'repo_map',
            phase: 'localize'
        };
    }
    if (invocation.toolName === 'grepfiles' || invocation.toolName === 'semanticsearch') {
        const query = readString(args, invocation.toolName === 'grepfiles' ? 'pattern' : 'query');
        if (!query) return undefined;
        const root = readString(args, 'path');
        return {
            target: limitTarget(
                `file:${invocation.toolName}:${root ? normalizePath(root) : 'workspace'}:query=${digestEvidenceValue(args)}`
            ),
            evidenceKind: invocation.toolName === 'grepfiles' ? 'symbol_signature' : 'search_result',
            phase: 'localize'
        };
    }
    return undefined;
}

function resolveShellEvidenceSemantics(invocation: RelevantEvidenceToolInvocation): EvidenceToolSemantics | undefined {
    const command = readString(invocation.args, 'command');
    if (!command || hasUnsafeShellComposition(command)) {
        return undefined;
    }
    const normalizedCommand = command.trim();
    const isSearch = SHELL_SEARCH_COMMAND_PATTERN.test(normalizedCommand);
    const isRead = !isSearch && SHELL_READ_COMMAND_PATTERN.test(normalizedCommand);
    if (!isSearch && !isRead) {
        return undefined;
    }
    const cwd = readString(invocation.args, 'workingDirectory', 'cwd');
    return {
        target: limitTarget(
            `shell:${invocation.toolName}:cwd=${cwd ? normalizePath(cwd) : 'default'}:command=${digestEvidenceValue(command)}`
        ),
        evidenceKind: isSearch
            ? /^(?:rg|ripgrep|grep|findstr|select-string|git\s+grep)\b/i.test(normalizedCommand)
                ? 'symbol_signature'
                : 'repo_map'
            : 'tool_observation',
        phase: isSearch ? 'localize' : 'inspect'
    };
}

export function resolveEvidenceToolSemantics(toolCall: EvidenceToolCall): EvidenceToolSemantics | undefined {
    const invocation = resolveRelevantEvidenceToolInvocation(toolCall);
    if (!invocation) return undefined;

    const semantics =
        invocation.kind === 'file'
            ? resolveFileEvidenceSemantics(invocation)
            : resolveShellEvidenceSemantics(invocation);
    if (!semantics || toolCall.status !== 'error') {
        return semantics;
    }
    return { ...semantics, evidenceKind: 'error_trace', phase: 'localize' };
}

export type EvidenceCardLedgerSource = 'tool' | 'llm';
export type EvidenceCardDecision = 'collect' | 'reuse' | 'compress' | 'stop' | 'replan';
export type EvidenceCardPressure = 'low' | 'medium' | 'high' | 'over';

export interface EvidenceCardSettings {
    enabled: boolean;
    globalBudgetTokens: number;
    planBudgetTokens: number;
    evidenceBudgetTokens: number;
    patchReserveTokens: number;
    verifyReserveTokens: number;
    toolResultBudgetChars: number;
    previewHeadChars: number;
    previewTailChars: number;
    minEvidenceScore: number;
    maxLedgerEntries: number;
    maxPromptLedgerEntries: number;
}

export interface EvidenceCardLedgerEntry {
    id: string;
    step: number;
    created_at: string;
    source: EvidenceCardLedgerSource;
    phase: EvidenceCardPhase;
    evidence_kind: EvidenceCardEvidenceKind;
    target: string;
    planned_budget_tokens: number;
    actual_tokens: number;
    remaining_budget_tokens: number;
    evidence_score: number;
    budget_pressure: EvidenceCardPressure;
    decision: EvidenceCardDecision;
    repeated_evidence: boolean;
    stop_rule: string;
    args_summary?: string;
    tool_name?: string;
    status?: ToolCall['status'];
}

export interface EvidenceCardState {
    version: number;
    enabled: boolean;
    global_budget_tokens: number;
    used_tokens: number;
    remaining_budget_tokens: number;
    total_llm_tokens: number;
    total_tool_tokens: number;
    total_original_tool_result_chars: number;
    total_visible_tool_result_chars: number;
    estimated_saved_chars: number;
    budget_violation_count: number;
    replan_count: number;
    evidence_debt_count: number;
    repeated_evidence_count: number;
    target_counts: Record<string, number>;
    phase_counts: Partial<Record<EvidenceCardPhase, number>>;
    ledger: EvidenceCardLedgerEntry[];
    last_updated_at?: string;
}

export const EVIDENCECARD_STATE_VERSION = 1;

const ALLOWED_PHASES: EvidenceCardPhase[] = [
    'plan',
    'localize',
    'inspect',
    'patch',
    'verify',
    'replan',
    'answer',
    'other'
];

const ALLOWED_EVIDENCE_KINDS: EvidenceCardEvidenceKind[] = [
    'repo_map',
    'symbol_signature',
    'function_body',
    'caller_callee',
    'failing_test',
    'error_trace',
    'config_block',
    'edit_region',
    'full_file',
    'multi_file_context',
    'llm_context',
    'search_result',
    'tool_observation'
];

function parsePositiveInt(value: unknown, defaultValue: number): number {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        return Math.floor(value);
    }
    if (typeof value === 'string') {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
            return parsed;
        }
    }
    return defaultValue;
}

function parseScore(value: unknown, defaultValue: number): number {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.max(0, Math.min(1, value));
    }
    if (typeof value === 'string') {
        const parsed = Number.parseFloat(value);
        if (Number.isFinite(parsed)) {
            return Math.max(0, Math.min(1, parsed));
        }
    }
    return defaultValue;
}

function readEvidenceCardEnv(suffix: string): string | undefined {
    const evidenceCardNames = [`EvidenceCard_${suffix}`, `EVIDENCECARD_${suffix}`, `EVIDENCE_CARD_${suffix}`];
    for (const name of evidenceCardNames) {
        const value = process.env[name];
        if (value !== undefined) {
            return value;
        }
    }

    const legacyEvidenceCoderNames = [`EvidenceCoder_${suffix}`, `EVIDENCECODER_${suffix}`, `EVIDENCE_CODER_${suffix}`];
    for (const name of legacyEvidenceCoderNames) {
        const value = process.env[name];
        if (value !== undefined) {
            return value;
        }
    }

    const legacyBudgetCoderNames = [`BudgetCoder_${suffix}`, `BUDGETCODER_${suffix}`, `BUDGET_CODER_${suffix}`];
    for (const name of legacyBudgetCoderNames) {
        const value = process.env[name];
        if (value !== undefined) {
            return value;
        }
    }

    return undefined;
}

export function isEvidenceCardFeatureEnabled(): boolean {
    try {
        return Setting.getInstance().getData().task_config?.evidence_card === true;
    } catch {
        return false;
    }
}

export function getEvidenceCardSettings(enabled: boolean = isEvidenceCardFeatureEnabled()): EvidenceCardSettings {
    return {
        enabled,
        globalBudgetTokens: parsePositiveInt(readEvidenceCardEnv('GLOBAL_BUDGET_TOKENS'), 12_000),
        planBudgetTokens: parsePositiveInt(readEvidenceCardEnv('PLAN_BUDGET_TOKENS'), 1_200),
        evidenceBudgetTokens: parsePositiveInt(readEvidenceCardEnv('EVIDENCE_BUDGET_TOKENS'), 6_000),
        patchReserveTokens: parsePositiveInt(readEvidenceCardEnv('PATCH_RESERVE_TOKENS'), 2_500),
        verifyReserveTokens: parsePositiveInt(readEvidenceCardEnv('VERIFY_RESERVE_TOKENS'), 1_500),
        toolResultBudgetChars: parsePositiveInt(readEvidenceCardEnv('TOOL_RESULT_BUDGET_CHARS'), 6_000),
        previewHeadChars: parsePositiveInt(readEvidenceCardEnv('PREVIEW_HEAD_CHARS'), 1_000),
        previewTailChars: parsePositiveInt(readEvidenceCardEnv('PREVIEW_TAIL_CHARS'), 1_500),
        minEvidenceScore: parseScore(readEvidenceCardEnv('MIN_EVIDENCE_SCORE'), 0.45),
        maxLedgerEntries: parsePositiveInt(readEvidenceCardEnv('MAX_LEDGER_ENTRIES'), 100),
        maxPromptLedgerEntries: parsePositiveInt(readEvidenceCardEnv('PROMPT_LEDGER_ENTRIES'), 10)
    };
}

export function getEvidenceCardPreviewOptions(settings: EvidenceCardSettings): ToolResultPreviewOptions {
    return {
        prefer: 'chars',
        force: true,
        thresholdChars: 0,
        thresholdLines: 0,
        headChars: settings.previewHeadChars,
        tailChars: settings.previewTailChars,
        headLines: 18,
        tailLines: 28
    };
}

export function createEvidenceCardState(
    enabled: boolean = false,
    globalBudgetTokens: number = getEvidenceCardSettings(enabled).globalBudgetTokens
): EvidenceCardState {
    return {
        version: EVIDENCECARD_STATE_VERSION,
        enabled,
        global_budget_tokens: globalBudgetTokens,
        used_tokens: 0,
        remaining_budget_tokens: globalBudgetTokens,
        total_llm_tokens: 0,
        total_tool_tokens: 0,
        total_original_tool_result_chars: 0,
        total_visible_tool_result_chars: 0,
        estimated_saved_chars: 0,
        budget_violation_count: 0,
        replan_count: 0,
        evidence_debt_count: 0,
        repeated_evidence_count: 0,
        target_counts: {},
        phase_counts: {},
        ledger: []
    };
}

function normalizePhase(value: unknown): EvidenceCardPhase {
    return typeof value === 'string' && ALLOWED_PHASES.includes(value as EvidenceCardPhase)
        ? (value as EvidenceCardPhase)
        : 'other';
}

function normalizeEvidenceKind(value: unknown): EvidenceCardEvidenceKind {
    return typeof value === 'string' && ALLOWED_EVIDENCE_KINDS.includes(value as EvidenceCardEvidenceKind)
        ? (value as EvidenceCardEvidenceKind)
        : 'tool_observation';
}

function normalizeDecision(value: unknown): EvidenceCardDecision {
    return value === 'collect' || value === 'reuse' || value === 'compress' || value === 'stop' || value === 'replan'
        ? value
        : 'collect';
}

function normalizePressure(value: unknown): EvidenceCardPressure {
    return value === 'low' || value === 'medium' || value === 'high' || value === 'over' ? value : 'low';
}

function normalizeLedgerEntry(raw: unknown): EvidenceCardLedgerEntry | undefined {
    if (!raw || typeof raw !== 'object') {
        return undefined;
    }
    const candidate = raw as Partial<EvidenceCardLedgerEntry>;
    if (typeof candidate.id !== 'string' || typeof candidate.target !== 'string') {
        return undefined;
    }
    const actualTokens =
        typeof candidate.actual_tokens === 'number' && Number.isFinite(candidate.actual_tokens)
            ? Math.max(0, Math.floor(candidate.actual_tokens))
            : 0;
    return {
        id: candidate.id,
        step:
            typeof candidate.step === 'number' && Number.isFinite(candidate.step)
                ? Math.max(0, Math.floor(candidate.step))
                : 0,
        created_at: typeof candidate.created_at === 'string' ? candidate.created_at : new Date().toISOString(),
        source: candidate.source === 'llm' ? 'llm' : 'tool',
        phase: normalizePhase(candidate.phase),
        evidence_kind: normalizeEvidenceKind(candidate.evidence_kind),
        target: candidate.target,
        planned_budget_tokens:
            typeof candidate.planned_budget_tokens === 'number' && Number.isFinite(candidate.planned_budget_tokens)
                ? Math.max(0, Math.floor(candidate.planned_budget_tokens))
                : estimatePlannedBudget(
                      normalizePhase(candidate.phase),
                      normalizeEvidenceKind(candidate.evidence_kind)
                  ),
        actual_tokens: actualTokens,
        remaining_budget_tokens:
            typeof candidate.remaining_budget_tokens === 'number' && Number.isFinite(candidate.remaining_budget_tokens)
                ? Math.floor(candidate.remaining_budget_tokens)
                : 0,
        evidence_score:
            typeof candidate.evidence_score === 'number' && Number.isFinite(candidate.evidence_score)
                ? Math.max(0, Math.min(1, candidate.evidence_score))
                : 0.5,
        budget_pressure: normalizePressure(candidate.budget_pressure),
        decision: normalizeDecision(candidate.decision),
        repeated_evidence: candidate.repeated_evidence === true,
        stop_rule:
            typeof candidate.stop_rule === 'string'
                ? candidate.stop_rule
                : inferStopRule(normalizePhase(candidate.phase), normalizeEvidenceKind(candidate.evidence_kind)),
        args_summary: typeof candidate.args_summary === 'string' ? candidate.args_summary : undefined,
        tool_name: typeof candidate.tool_name === 'string' ? candidate.tool_name : undefined,
        status:
            candidate.status === 'success' ||
            candidate.status === 'error' ||
            candidate.status === 'running' ||
            candidate.status === 'pending'
                ? candidate.status
                : undefined
    };
}

function normalizeTargetCounts(raw: unknown): Record<string, number> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return {};
    }
    return Object.fromEntries(
        Object.entries(raw as Record<string, unknown>)
            .filter(([, count]) => typeof count === 'number' && Number.isFinite(count) && count > 0)
            .map(([target, count]) => [target, Math.floor(count as number)])
    );
}

function normalizePhaseCounts(raw: unknown): Partial<Record<EvidenceCardPhase, number>> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return {};
    }
    const counts: Partial<Record<EvidenceCardPhase, number>> = {};
    for (const [phase, count] of Object.entries(raw as Record<string, unknown>)) {
        const normalizedPhase = normalizePhase(phase);
        if (typeof count === 'number' && Number.isFinite(count) && count > 0) {
            counts[normalizedPhase] = Math.floor(count);
        }
    }
    return counts;
}

function derivePhaseCounts(ledger: EvidenceCardLedgerEntry[]): Partial<Record<EvidenceCardPhase, number>> {
    const counts: Partial<Record<EvidenceCardPhase, number>> = {};
    for (const entry of ledger) {
        counts[entry.phase] = (counts[entry.phase] ?? 0) + 1;
    }
    return counts;
}

export function normalizeEvidenceCardState(raw: unknown, enabled: boolean): EvidenceCardState {
    const settings = getEvidenceCardSettings(enabled);
    if (!raw || typeof raw !== 'object') {
        return createEvidenceCardState(enabled, settings.globalBudgetTokens);
    }
    const candidate = raw as Partial<EvidenceCardState>;
    const ledger = Array.isArray(candidate.ledger)
        ? candidate.ledger.map(normalizeLedgerEntry).filter((entry): entry is EvidenceCardLedgerEntry => !!entry)
        : [];
    const globalBudget =
        typeof candidate.global_budget_tokens === 'number' &&
        Number.isFinite(candidate.global_budget_tokens) &&
        candidate.global_budget_tokens > 0
            ? Math.floor(candidate.global_budget_tokens)
            : settings.globalBudgetTokens;
    const usedTokens =
        typeof candidate.used_tokens === 'number' && Number.isFinite(candidate.used_tokens)
            ? Math.max(0, Math.floor(candidate.used_tokens))
            : ledger.reduce((total, entry) => total + entry.actual_tokens, 0);
    const targetCounts = normalizeTargetCounts(candidate.target_counts);
    const phaseCounts = normalizePhaseCounts(candidate.phase_counts);
    return {
        version: EVIDENCECARD_STATE_VERSION,
        enabled,
        global_budget_tokens: globalBudget,
        used_tokens: usedTokens,
        remaining_budget_tokens: globalBudget - usedTokens,
        total_llm_tokens:
            typeof candidate.total_llm_tokens === 'number' && Number.isFinite(candidate.total_llm_tokens)
                ? Math.max(0, Math.floor(candidate.total_llm_tokens))
                : ledger
                      .filter((entry) => entry.source === 'llm')
                      .reduce((total, entry) => total + entry.actual_tokens, 0),
        total_tool_tokens:
            typeof candidate.total_tool_tokens === 'number' && Number.isFinite(candidate.total_tool_tokens)
                ? Math.max(0, Math.floor(candidate.total_tool_tokens))
                : ledger
                      .filter((entry) => entry.source === 'tool')
                      .reduce((total, entry) => total + entry.actual_tokens, 0),
        total_original_tool_result_chars:
            typeof candidate.total_original_tool_result_chars === 'number' &&
            Number.isFinite(candidate.total_original_tool_result_chars)
                ? Math.max(0, Math.floor(candidate.total_original_tool_result_chars))
                : 0,
        total_visible_tool_result_chars:
            typeof candidate.total_visible_tool_result_chars === 'number' &&
            Number.isFinite(candidate.total_visible_tool_result_chars)
                ? Math.max(0, Math.floor(candidate.total_visible_tool_result_chars))
                : 0,
        estimated_saved_chars:
            typeof candidate.estimated_saved_chars === 'number' && Number.isFinite(candidate.estimated_saved_chars)
                ? Math.max(0, Math.floor(candidate.estimated_saved_chars))
                : 0,
        budget_violation_count:
            typeof candidate.budget_violation_count === 'number' && Number.isFinite(candidate.budget_violation_count)
                ? Math.max(0, Math.floor(candidate.budget_violation_count))
                : ledger.filter((entry) => entry.remaining_budget_tokens < 0).length,
        replan_count:
            typeof candidate.replan_count === 'number' && Number.isFinite(candidate.replan_count)
                ? Math.max(0, Math.floor(candidate.replan_count))
                : ledger.filter((entry) => entry.phase === 'replan').length,
        evidence_debt_count:
            typeof candidate.evidence_debt_count === 'number' && Number.isFinite(candidate.evidence_debt_count)
                ? Math.max(0, Math.floor(candidate.evidence_debt_count))
                : ledger.filter((entry) => entry.evidence_score < settings.minEvidenceScore).length,
        repeated_evidence_count:
            typeof candidate.repeated_evidence_count === 'number' && Number.isFinite(candidate.repeated_evidence_count)
                ? Math.max(0, Math.floor(candidate.repeated_evidence_count))
                : ledger.filter((entry) => entry.repeated_evidence).length,
        target_counts: targetCounts,
        phase_counts: Object.keys(phaseCounts).length > 0 ? phaseCounts : derivePhaseCounts(ledger),
        ledger,
        last_updated_at: typeof candidate.last_updated_at === 'string' ? candidate.last_updated_at : undefined
    };
}

export function getEvidenceCardSystemSection(): string {
    return [
        '# EvidenceCard',
        '- Method: Plan-Evidence Token Budgeting for Coding Agents.',
        '- Start with a compact plan-evidence table: step, goal, required_evidence, context_type, token_budget, stop_rule.',
        '- Spend tokens only when a context item pays down a named evidence gap for localization, patching, or verification.',
        '- Maintain a plan-evidence ledger. Reuse prior evidence before rereading the same file, symbol, test, or log.',
        '- Keep patch and verification reserves; do not exhaust the budget on broad exploration or verbose explanations.',
        '- If evidence is weak, escalate context one level at a time; if evidence is sufficient, stop reading and patch/verify.'
    ].join('\n');
}

function truncateText(text: string, maxChars: number): string {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxChars) {
        return normalized;
    }
    return normalized.slice(0, Math.max(0, maxChars - 3)) + '...';
}

function getCommand(args: Record<string, unknown>): string {
    const command = args.command;
    return typeof command === 'string' ? command : '';
}

function summarizeArgs(args: Record<string, unknown>): string {
    const command = getCommand(args);
    if (command) {
        return truncateText(command, 360);
    }
    try {
        return truncateText(JSON.stringify(args), 360);
    } catch {
        return '';
    }
}

function estimatePlannedBudget(phase: EvidenceCardPhase, evidenceKind: EvidenceCardEvidenceKind): number {
    if (phase === 'plan') {
        return 1_200;
    }
    if (phase === 'replan') {
        return 900;
    }
    if (phase === 'patch' || evidenceKind === 'edit_region') {
        return 2_500;
    }
    if (phase === 'verify' || evidenceKind === 'failing_test' || evidenceKind === 'error_trace') {
        return 1_800;
    }
    if (evidenceKind === 'repo_map' || evidenceKind === 'symbol_signature') {
        return 700;
    }
    if (evidenceKind === 'function_body' || evidenceKind === 'config_block') {
        return 1_400;
    }
    if (evidenceKind === 'caller_callee' || evidenceKind === 'full_file') {
        return 2_400;
    }
    if (evidenceKind === 'multi_file_context') {
        return 3_500;
    }
    if (evidenceKind === 'llm_context') {
        return 1_200;
    }
    return 1_000;
}

function scoreEvidence(
    phase: EvidenceCardPhase,
    evidenceKind: EvidenceCardEvidenceKind,
    status: ToolCall['status'] | undefined,
    resultText: string
): number {
    let score = status === 'success' ? 0.4 : 0.22;
    if (['symbol_signature', 'function_body', 'caller_callee', 'config_block', 'edit_region'].includes(evidenceKind)) {
        score += 0.22;
    }
    if (['failing_test', 'error_trace'].includes(evidenceKind)) {
        score += 0.25;
    }
    if (phase === 'patch' || phase === 'verify') {
        score += 0.08;
    }
    if (
        /pass|fail|error|traceback|assert|expected|actual|diff|modified|created|function|class|export|def\s+/i.test(
            resultText
        )
    ) {
        score += 0.15;
    }
    if (resultText.length === 0) {
        score -= 0.18;
    }
    return Math.max(0, Math.min(1, Number(score.toFixed(2))));
}

function inferStopRule(phase: EvidenceCardPhase, evidenceKind: EvidenceCardEvidenceKind): string {
    if (phase === 'plan') {
        return 'plan-evidence table produced';
    }
    if (phase === 'localize') {
        return 'target file/symbol and next evidence gap identified';
    }
    if (phase === 'inspect') {
        return 'bug hypothesis or minimal edit region supported by evidence';
    }
    if (phase === 'patch') {
        return 'minimal patch generated and diff inspected';
    }
    if (phase === 'verify') {
        return 'focused test passes or new failure is summarized as evidence';
    }
    if (phase === 'replan') {
        return 'remaining budget reallocated around unresolved evidence gaps';
    }
    if (evidenceKind === 'full_file' || evidenceKind === 'multi_file_context') {
        return 'stop broad reading once the edit-relevant region is found';
    }
    return 'evidence recorded';
}

function computeBudgetPressure(remainingBudgetTokens: number, globalBudgetTokens: number): EvidenceCardPressure {
    if (remainingBudgetTokens < 0) {
        return 'over';
    }
    if (globalBudgetTokens <= 0) {
        return 'low';
    }
    const ratio = remainingBudgetTokens / globalBudgetTokens;
    if (ratio < 0.15) {
        return 'high';
    }
    if (ratio < 0.35) {
        return 'medium';
    }
    return 'low';
}

export function syncEvidenceCardTaskState(task: {
    evidencecard_state?: EvidenceCardState;
    enableEvidenceCard?: boolean;
}): boolean {
    const enabled = isEvidenceCardFeatureEnabled();
    task.enableEvidenceCard = enabled;
    task.evidencecard_state = normalizeEvidenceCardState(task.evidencecard_state, enabled);
    return enabled;
}

export function isTaskEvidenceCardEnabled(task: unknown): boolean {
    void task;
    return isEvidenceCardFeatureEnabled();
}

export function ensureEvidenceCardState(task: {
    evidencecard_state?: EvidenceCardState;
    enableEvidenceCard?: boolean;
}): EvidenceCardState {
    syncEvidenceCardTaskState(task);
    return task.evidencecard_state!;
}

function appendLedgerEntry(
    state: EvidenceCardState,
    settings: EvidenceCardSettings,
    entry: Omit<EvidenceCardLedgerEntry, 'remaining_budget_tokens' | 'budget_pressure'>
): void {
    state.used_tokens += entry.actual_tokens;
    state.remaining_budget_tokens = state.global_budget_tokens - state.used_tokens;
    const finalEntry: EvidenceCardLedgerEntry = {
        ...entry,
        remaining_budget_tokens: state.remaining_budget_tokens,
        budget_pressure: computeBudgetPressure(state.remaining_budget_tokens, state.global_budget_tokens)
    };
    state.budget_violation_count += finalEntry.remaining_budget_tokens < 0 ? 1 : 0;
    state.replan_count += finalEntry.phase === 'replan' ? 1 : 0;
    state.evidence_debt_count += finalEntry.evidence_score < settings.minEvidenceScore ? 1 : 0;
    state.repeated_evidence_count += finalEntry.repeated_evidence ? 1 : 0;
    state.phase_counts[finalEntry.phase] = (state.phase_counts[finalEntry.phase] ?? 0) + 1;
    state.ledger.push(finalEntry);
    state.ledger = state.ledger.slice(-settings.maxLedgerEntries);
    state.last_updated_at = finalEntry.created_at;
}

export function recordEvidenceCardToolCall(
    task: {
        evidencecard_state?: EvidenceCardState;
        enableEvidenceCard?: boolean;
    },
    toolCall: ToolCall
): void {
    if (!isTaskEvidenceCardEnabled(task)) {
        return;
    }
    const semantics = resolveEvidenceToolSemantics(toolCall);
    if (!semantics) {
        return;
    }
    const settings = getEvidenceCardSettings(true);
    const state = ensureEvidenceCardState(task);
    state.enabled = true;

    const args = parseEvidenceToolCallArgs(toolCall);
    const resultText = typeof toolCall.result === 'string' ? toolCall.result : '';
    const evidenceKind = semantics.evidenceKind;
    const phase = semantics.phase;
    const target = semantics.target;
    const repeatEligible = toolCall.status === 'success';
    const previousTargetCount = repeatEligible ? (state.target_counts[target] ?? 0) : 0;
    const repeatedEvidence = repeatEligible && previousTargetCount > 0;
    const argsSummary = summarizeArgs(args);
    const originalChars = toolCall.result_storage?.original_chars ?? resultText.length;
    const visibleChars = resultText.length;
    const actualTokens = estimateTextTokens(argsSummary) + estimateTextTokens(resultText);
    const plannedBudget = estimatePlannedBudget(phase, evidenceKind);
    const evidenceScore = scoreEvidence(phase, evidenceKind, toolCall.status, resultText);
    const now = new Date().toISOString();

    state.total_tool_tokens += actualTokens;
    state.total_original_tool_result_chars += originalChars;
    state.total_visible_tool_result_chars += visibleChars;
    state.estimated_saved_chars = Math.max(
        0,
        state.total_original_tool_result_chars - state.total_visible_tool_result_chars
    );
    if (repeatEligible) {
        state.target_counts[target] = previousTargetCount + 1;
    }

    appendLedgerEntry(state, settings, {
        id: 'ec_' + String(state.ledger.length + 1) + '_' + Date.now().toString(36),
        step: state.ledger.length + 1,
        created_at: now,
        source: 'tool',
        phase,
        evidence_kind: evidenceKind,
        target,
        planned_budget_tokens: plannedBudget,
        actual_tokens: actualTokens,
        evidence_score: evidenceScore,
        decision: repeatedEvidence ? 'reuse' : actualTokens > plannedBudget ? 'compress' : 'collect',
        repeated_evidence: repeatedEvidence,
        stop_rule: inferStopRule(phase, evidenceKind),
        args_summary: argsSummary,
        tool_name: toolCall.tool_name,
        status: toolCall.status
    });
}

export function recordEvidenceCardLLMUsage(
    task: { evidencecard_state?: EvidenceCardState; enableEvidenceCard?: boolean },
    usage: UsageFields | undefined,
    requestType: string = 'streamComplete'
): void {
    // EvidenceCard in mydesk is intentionally tool-only. We keep the hook wired
    // for compatibility with the old execution path, but do not append llm/replan
    // ledger entries such as source=llm + evidence_kind=llm_context.
    void task;
    void usage;
    void requestType;
}

function collectLastUserText(chatContext: Pick<ChatContext, 'messages'>): string {
    for (let index = chatContext.messages.length - 1; index >= 0; index--) {
        const message = chatContext.messages[index];
        if (message instanceof UserMessage) {
            return message.getPlainText();
        }
    }
    return '';
}

function summarizeConversationShape(chatContext: Pick<ChatContext, 'messages'>): string {
    let userMessages = 0;
    let assistantMessages = 0;
    let compactBoundaries = 0;
    for (const message of chatContext.messages) {
        if (message instanceof UserMessage) {
            userMessages++;
        } else if (message instanceof AssistantMessage) {
            assistantMessages++;
        } else if (message instanceof CompactSeparatorMessage) {
            compactBoundaries++;
        }
    }
    return (
        'messages(user=' +
        userMessages +
        ', assistant=' +
        assistantMessages +
        ', compact_boundaries=' +
        compactBoundaries +
        ')'
    );
}

function formatPhaseCounts(counts: Partial<Record<EvidenceCardPhase, number>>): string {
    const ordered = ALLOWED_PHASES.filter((phase) => (counts[phase] ?? 0) > 0).map(
        (phase) => phase + '=' + counts[phase]
    );
    return ordered.length > 0 ? ordered.join(', ') : 'none';
}

function formatLedgerEntry(entry: EvidenceCardLedgerEntry): string {
    const parts = [
        '- ' + entry.id + ':',
        entry.source,
        'phase=' + entry.phase,
        'evidence=' + entry.evidence_kind,
        'target=' + entry.target,
        'tokens=' + entry.actual_tokens,
        'score=' + entry.evidence_score,
        'decision=' + entry.decision
    ];

    if (entry.status) {
        parts.push('status=' + entry.status);
    }
    if (entry.repeated_evidence) {
        parts.push('repeated');
    }

    return parts.join(' ');
}

export function buildEvidenceCardRuntimePrompt(
    chatContext: Pick<ChatContext, 'messages'>,
    state: EvidenceCardState | undefined,
    query?: string
): string {
    const settings = getEvidenceCardSettings(true);
    const normalizedState = normalizeEvidenceCardState(state, true);
    const recentLedger = normalizedState.ledger.slice(-settings.maxPromptLedgerEntries);
    const latestQuery = truncateText(query || collectLastUserText(chatContext), 240);
    const ledgerText = recentLedger.length > 0 ? recentLedger.map(formatLedgerEntry).join('\n') : '- none yet';

    return [
        '# EvidenceCard Runtime',
        '- enabled: true',
        '- current_query: ' + (latestQuery || 'n/a'),
        '- context_shape: ' + summarizeConversationShape(chatContext),
        '- evidence_debt_count: ' + normalizedState.evidence_debt_count,
        '- repeated_evidence_count: ' + normalizedState.repeated_evidence_count,
        '- phase_counts: ' + formatPhaseCounts(normalizedState.phase_counts),
        '',
        '## Recent Evidence Ledger',
        ledgerText
    ].join('\n');
}

export const buildEvidenceCardRuntimeTail = buildEvidenceCardRuntimePrompt;

/**
 * 将 EvidenceCard 的运行时 tail 注册为 TaskState 的 onTailcardGenerate 钩子。
 *
 * 钩子在每次发起 LLM 请求时被调度，根据当前 EvidenceCard feature 开关与
 * `evidencecard_state` 生成 TailCard 内容；feature 关闭时返回 `undefined`。
 * 同一个 task 内重复注册会保留首次注册（由 Hooks 保证幂等）。
 */
export function registerEvidenceCardTailcard(task: TaskState): void {
    task.hooks.onTailcardGenerate((ctx) => {
        if (!ctx.task.refreshEvidenceCardFeatureState()) {
            return undefined;
        }
        const content = buildEvidenceCardRuntimeTail(ctx.activeContext ?? ctx.chatContext, ctx.task.evidencecard_state);
        return content.trim().length > 0 ? { id: 'evidence-card', content, maxChars: 8_000 } : undefined;
    });
}
