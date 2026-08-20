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
import { jsonrepair } from 'jsonrepair';
import {
    AssistantMessage,
    CompactSeparatorMessage,
    UserMessage,
    type ChatContext,
    type ToolCall,
    type UsageFields
} from '../aikernel/messages.js';
import type { ToolResultPreviewOptions } from '../aikernel/compaction/tool-results.js';
import type { TaskState } from '../aikernel/states/tasks.js';
import { Setting } from './setting.js';

export type EvidenceCardPhase =
    | 'plan'
    | 'localize'
    | 'inspect'
    | 'act'
    | 'patch'
    | 'verify'
    | 'replan'
    | 'answer'
    | 'other';

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
    | 'skill_definition'
    | 'search_result'
    | 'knowledge_result'
    | 'ui_snapshot'
    | 'ui_element'
    | 'ui_action'
    | 'visual_assertion'
    | 'task_state'
    | 'user_input'
    | 'external_state'
    | 'tool_observation';

export type EvidenceToolOperation =
    | 'plan'
    | 'search'
    | 'read'
    | 'observe'
    | 'act'
    | 'edit'
    | 'verify'
    | 'execute'
    | 'interact';

export type EvidenceToolRepeatPolicy = 'never' | 'target';

interface EvidenceToolLike {
    name: string;
}

export interface EvidenceToolRegistry {
    getTools(): ReadonlyMap<string, EvidenceToolLike>;
}

type EvidenceToolCall = Pick<
    ToolCall,
    'id' | 'tool_name' | 'args_string' | 'args_object' | 'tool' | 'status' | 'result' | 'result_object'
>;

export interface ResolvedEvidenceToolInvocation {
    qualifiedName: string;
    toolsetName?: string;
    toolName: string;
    effectiveName: string;
    args: Record<string, unknown>;
    wrapper?: {
        kind: 'skill' | 'mcp' | 'device' | 'workflow';
        name: string;
        outerArgs: Record<string, unknown>;
    };
}

export interface EvidenceToolSemantics {
    operation: EvidenceToolOperation;
    target: string;
    evidenceKind: EvidenceCardEvidenceKind;
    phase: EvidenceCardPhase;
    /** Omitted policies default to never. */
    repeatPolicy?: EvidenceToolRepeatPolicy;
}

const KNOWN_TOOLSETS = [
    'channel-plugin-management',
    'knowledgebase-operate',
    'knowledgebase-manage',
    'workflow-discovery',
    'channel-pairing',
    'channel-outbound',
    'browser-manage',
    'device-pairing',
    'device-status',
    'device-invoke',
    'skill-manager',
    'search-manage',
    'mcp-manage',
    'manage-skills',
    'manage-souls',
    'task-info',
    'global-todos',
    'workflow-agent',
    'interaction',
    'knowledgebase',
    'agentoffice',
    'todomgr',
    'terminal',
    'filemgr',
    'planning',
    'workflow',
    'browser',
    'mcpmgr',
    'devicemgr',
    'calendar',
    'mailbox',
    'notes',
    'search',
    'appmgr',
    'memory',
    'pool',
    'skill'
].sort((left, right) => right.length - left.length);

const CONFIG_FILE_PATTERN = /(?:^|\/)(?:package\.json|pyproject\.toml|dockerfile|[^/]+\.(?:ya?ml|toml|ini|cfg|conf))$/i;
const TEST_COMMAND_PATTERN =
    /\b(pytest|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+(?:run\s+)?test|cargo\s+test|go\s+test|mvn\s+test|gradle\s+test|test\.sh)\b/i;
const ERROR_RESULT_PATTERN = /traceback|assertionerror|\berror\b|\bfailed\b|\bfailing\b|exception/i;

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseEvidenceObject(value: unknown): Record<string, unknown> {
    if (value === undefined || value === null) return {};
    if (isRecord(value)) return value;
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return {};
        const parsed = JSON.parse(jsonrepair(trimmed)) as unknown;
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

export function digestEvidenceValue(value: unknown): string {
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

function safeSegment(value: unknown, fallback = 'unspecified'): string {
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return fallback;
    const normalized = String(value).trim().replace(/\s+/g, '_');
    return normalized.length > 0 ? normalized.slice(0, 100) : fallback;
}

function normalizeUrl(value: string): string {
    try {
        const parsed = new URL(value);
        parsed.hash = '';
        parsed.username = '';
        parsed.password = '';
        const entries = Array.from(parsed.searchParams.entries()).sort(([left], [right]) => left.localeCompare(right));
        parsed.search = '';
        for (const [key, parameterValue] of entries) {
            const safeValue = /token|password|secret|authorization|cookie|api[-_]?key/i.test(key)
                ? digestEvidenceValue(parameterValue)
                : parameterValue;
            parsed.searchParams.append(key, safeValue);
        }
        return parsed.toString();
    } catch {
        return value.trim();
    }
}

export function parseEvidenceToolCallArgs(toolCall: EvidenceToolCall): Record<string, unknown> {
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

function splitQualifiedName(qualifiedName: string, boundToolName?: string): { toolsetName?: string; toolName: string } {
    if (boundToolName && qualifiedName.endsWith('-' + boundToolName)) {
        return {
            toolsetName: qualifiedName.slice(0, -(boundToolName.length + 1)),
            toolName: boundToolName
        };
    }
    const knownToolset = KNOWN_TOOLSETS.find((name) => qualifiedName.startsWith(name + '-'));
    if (knownToolset) {
        return { toolsetName: knownToolset, toolName: qualifiedName.slice(knownToolset.length + 1) };
    }
    const separator = qualifiedName.lastIndexOf('-');
    if (separator > 0 && separator < qualifiedName.length - 1) {
        return { toolsetName: qualifiedName.slice(0, separator), toolName: qualifiedName.slice(separator + 1) };
    }
    return { toolName: boundToolName || qualifiedName || 'unknown' };
}

function resolveQualifiedName(toolCall: EvidenceToolCall, registry?: EvidenceToolRegistry): string {
    const rawName = toolCall.tool_name?.trim() || '';
    if (registry) {
        const tools = registry.getTools();
        if (tools.has(rawName)) return rawName;
        if (toolCall.tool) {
            for (const [qualifiedName, tool] of tools) {
                if (tool === toolCall.tool) return qualifiedName;
            }
        }
    }
    if (rawName) return rawName;
    if (toolCall.tool?.name) return toolCall.tool.name;
    return 'unknown-' + safeSegment(toolCall.id, 'missing-id');
}

function parseNestedOrDigest(value: unknown): Record<string, unknown> {
    try {
        return parseEvidenceObject(value);
    } catch {
        return { __unparsedArgsDigest: digestEvidenceValue(value) };
    }
}

export function resolveEvidenceToolInvocation(
    toolCall: EvidenceToolCall,
    registry?: EvidenceToolRegistry
): ResolvedEvidenceToolInvocation {
    const qualifiedName = resolveQualifiedName(toolCall, registry);
    const split = splitQualifiedName(qualifiedName, toolCall.tool?.name);
    const outerArgs = parseEvidenceToolCallArgs(toolCall);
    const normalizedToolName = split.toolName.toLowerCase();

    if (normalizedToolName === 'callskilltool') {
        const bundleName = readString(outerArgs, 'bundleName');
        const skillName = readString(outerArgs, 'skillName');
        const innerToolName = readString(outerArgs, 'toolName');
        if (bundleName && skillName && innerToolName) {
            const args = parseNestedOrDigest(outerArgs.toolArgs);
            return {
                qualifiedName,
                toolsetName: split.toolsetName,
                toolName: split.toolName,
                effectiveName: `skill:${bundleName}/${skillName}/${innerToolName}`,
                args,
                wrapper: {
                    kind: 'skill',
                    name: `${bundleName}/${skillName}`,
                    outerArgs: { bundleName, skillName, toolName: innerToolName }
                }
            };
        }
    }

    if (normalizedToolName === 'mcpcalltool') {
        const serverId = readString(outerArgs, 'serverId') || 'unspecified-server';
        const innerToolName = readString(outerArgs, 'toolName') || 'unspecified-tool';
        return {
            qualifiedName,
            toolsetName: split.toolsetName,
            toolName: split.toolName,
            effectiveName: `mcp:${serverId}/${innerToolName}`,
            args: parseNestedOrDigest(outerArgs.arguments),
            wrapper: {
                kind: 'mcp',
                name: `${serverId}/${innerToolName}`,
                outerArgs: { serverId, toolName: innerToolName }
            }
        };
    }

    if (normalizedToolName === 'invokedevicecommand') {
        const nodeId = readString(outerArgs, 'nodeId') || 'unspecified-node';
        const command = readString(outerArgs, 'command') || 'unspecified-command';
        return {
            qualifiedName,
            toolsetName: split.toolsetName,
            toolName: split.toolName,
            effectiveName: `device:${nodeId}/${command}`,
            args: parseNestedOrDigest(outerArgs.params),
            wrapper: {
                kind: 'device',
                name: `${nodeId}/${command}`,
                outerArgs: { nodeId, command }
            }
        };
    }

    if (normalizedToolName === 'runworkflow') {
        const reference = readString(outerArgs, 'reference') || 'unspecified-workflow';
        return {
            qualifiedName,
            toolsetName: split.toolsetName,
            toolName: split.toolName,
            effectiveName: `workflow:${reference}`,
            args: parseNestedOrDigest(outerArgs.input),
            wrapper: {
                kind: 'workflow',
                name: reference,
                outerArgs: { reference }
            }
        };
    }

    return {
        qualifiedName,
        toolsetName: split.toolsetName,
        toolName: split.toolName,
        effectiveName: split.toolsetName ? `${split.toolsetName}/${split.toolName}` : split.toolName,
        args: outerArgs
    };
}

function parseResultObject(toolCall: EvidenceToolCall): Record<string, unknown> | undefined {
    if (isRecord(toolCall.result_object)) return toolCall.result_object;
    if (!toolCall.result) return undefined;
    try {
        return parseEvidenceObject(toolCall.result);
    } catch {
        return undefined;
    }
}

function findNestedString(value: unknown, keys: readonly string[], depth = 0): string | undefined {
    if (!value || typeof value !== 'object' || depth > 5) return undefined;
    const record = value as Record<string, unknown>;
    for (const key of keys) {
        const candidate = record[key];
        if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim();
    }
    for (const child of Object.values(record)) {
        const found = findNestedString(child, keys, depth + 1);
        if (found) return found;
    }
    return undefined;
}

function resultIdentity(toolCall: EvidenceToolCall, ...keys: string[]): string | undefined {
    return findNestedString(parseResultObject(toolCall), keys);
}

function resultWithErrorOverride(semantics: EvidenceToolSemantics, toolCall: EvidenceToolCall): EvidenceToolSemantics {
    if (toolCall.status === 'error') {
        return { ...semantics, evidenceKind: 'error_trace', phase: 'localize' };
    }
    return semantics;
}

function fileSemantics(invocation: ResolvedEvidenceToolInvocation): EvidenceToolSemantics | undefined {
    const toolName = invocation.toolName.toLowerCase();
    const args = invocation.args;
    const rawPath = readString(args, 'file_path', 'filePath', 'path', 'resourcePath');
    const filePath = rawPath ? normalizePath(rawPath) : undefined;

    if (toolName === 'readfile') {
        const offset = readNumber(args, 'offset');
        const limit = readNumber(args, 'limit');
        const range =
            offset !== undefined || limit !== undefined
                ? `lines=${offset ?? 1}..${limit !== undefined ? (offset ?? 1) + limit - 1 : 'end'}`
                : 'full';
        const evidenceKind: EvidenceCardEvidenceKind =
            range !== 'full'
                ? 'function_body'
                : filePath && CONFIG_FILE_PATTERN.test(filePath)
                  ? 'config_block'
                  : 'full_file';
        return {
            operation: 'read',
            target: limitTarget(`file:read:${filePath ?? 'unspecified'}:${range}`),
            evidenceKind,
            phase: 'inspect',
            repeatPolicy: 'target'
        };
    }
    if (toolName === 'readimage' || toolName === 'askimage') {
        return {
            operation: 'observe',
            target: `file:${toolName}:${filePath ?? 'unspecified'}:args=${digestEvidenceValue(args)}`,
            evidenceKind: 'ui_snapshot',
            phase: 'inspect'
        };
    }
    if (toolName === 'extracttext') {
        return {
            operation: 'read',
            target: `file:extractText:${filePath ?? 'unspecified'}:args=${digestEvidenceValue(args)}`,
            evidenceKind: 'full_file',
            phase: 'inspect',
            repeatPolicy: 'target'
        };
    }
    if (['editfile', 'searchreplace'].includes(toolName)) {
        const region = digestEvidenceValue(args.oldString ?? args.search ?? args);
        return {
            operation: 'edit',
            target: limitTarget(`file:edit:${filePath ?? 'unspecified'}:region=${region}`),
            evidenceKind: 'edit_region',
            phase: 'patch'
        };
    }
    if (toolName === 'writefile') {
        return {
            operation: 'edit',
            target: limitTarget(
                `file:write:${filePath ?? 'unspecified'}:mode=${safeSegment(args.mode, 'overwrite')}:content=${digestEvidenceValue(args.content)}`
            ),
            evidenceKind: 'edit_region',
            phase: 'patch'
        };
    }
    if (toolName === 'applypatch') {
        return {
            operation: 'edit',
            target: `file:applyPatch:patch=${digestEvidenceValue(args.patch)}`,
            evidenceKind: 'edit_region',
            phase: 'patch'
        };
    }
    if (toolName === 'globfiles') {
        const root = readString(args, 'path', 'directory', 'root', 'workingDirectory');
        return {
            operation: 'search',
            target: `file:glob:${root ? normalizePath(root) : 'workspace'}:pattern=${digestEvidenceValue(args.pattern ?? args)}`,
            evidenceKind: 'repo_map',
            phase: 'localize',
            repeatPolicy: 'target'
        };
    }
    if (toolName === 'grepfiles' || toolName === 'semanticsearch') {
        const root = readString(args, 'path', 'directory', 'root', 'workingDirectory');
        return {
            operation: 'search',
            target: `file:${toolName}:${root ? normalizePath(root) : 'workspace'}:query=${digestEvidenceValue(args.pattern ?? args.query ?? args)}`,
            evidenceKind: toolName === 'grepfiles' ? 'symbol_signature' : 'search_result',
            phase: 'localize',
            repeatPolicy: 'target'
        };
    }
    return undefined;
}

function terminalSemantics(invocation: ResolvedEvidenceToolInvocation, resultText: string): EvidenceToolSemantics {
    const args = invocation.args;
    const command = readString(args, 'command') || '';
    const cwd = readString(args, 'workingDirectory', 'cwd');
    const target = `shell:${invocation.toolName}:cwd=${cwd ? normalizePath(cwd) : 'default'}:command=${digestEvidenceValue(command)}`;
    if (TEST_COMMAND_PATTERN.test(command)) {
        return {
            operation: 'verify',
            target,
            evidenceKind: ERROR_RESULT_PATTERN.test(resultText) ? 'error_trace' : 'failing_test',
            phase: 'verify'
        };
    }
    if (/git\s+diff|apply_patch|patch\s+-p|diff\s+-u/i.test(command)) {
        return { operation: 'edit', target, evidenceKind: 'edit_region', phase: 'patch' };
    }
    if (/\brg\b|grep|select-string|ripgrep|\bfind\b|\bls\b|get-childitem|git\s+ls-files/i.test(command)) {
        return {
            operation: 'search',
            target,
            evidenceKind: /\brg\b|grep|select-string|ripgrep/i.test(command) ? 'symbol_signature' : 'repo_map',
            phase: 'localize',
            repeatPolicy: 'target'
        };
    }
    if (/get-content|\bcat\b|\bsed\b|\bnl\b|\btype\b|\bhead\b|\btail\b/i.test(command)) {
        return {
            operation: 'read',
            target,
            evidenceKind: 'tool_observation',
            phase: 'inspect',
            repeatPolicy: 'target'
        };
    }
    if (invocation.toolName.toLowerCase() === 'checkshellstatus') {
        return { operation: 'observe', target, evidenceKind: 'external_state', phase: 'inspect' };
    }
    return { operation: 'execute', target, evidenceKind: 'tool_observation', phase: 'act' };
}

function harmonySemantics(
    invocation: ResolvedEvidenceToolInvocation,
    toolCall: EvidenceToolCall
): EvidenceToolSemantics | undefined {
    if (invocation.wrapper?.kind !== 'skill' || !invocation.effectiveName.startsWith('skill:')) return undefined;
    const skillName = invocation.wrapper.name.split('/').at(-1)?.toLowerCase();
    if (skillName !== 'use-harmony') return undefined;
    const toolName = invocation.effectiveName.split('/').at(-1) || invocation.toolName;
    const normalizedToolName = toolName.toLowerCase();
    const args = invocation.args;
    const snapshotId =
        readString(args, 'snapshotId') || resultIdentity(toolCall, 'snapshotId', 'lastSnapshotId') || 'current';
    const bundleName = readString(args, 'bundleName') || resultIdentity(toolCall, 'bundleName') || 'all';

    if (normalizedToolName === 'snapshot') {
        return {
            operation: 'observe',
            target: `ui:snapshot:${safeSegment(bundleName)}:snapshotId=${safeSegment(snapshotId)}`,
            evidenceKind: 'ui_snapshot',
            phase: 'inspect'
        };
    }
    if (normalizedToolName === 'screenshot') {
        return {
            operation: 'observe',
            target: `ui:screenshot:region=${digestEvidenceValue(args.region ?? 'full')}:ocr=${safeSegment(args.ocr, 'true')}`,
            evidenceKind: 'ui_snapshot',
            phase: 'inspect'
        };
    }
    if (normalizedToolName === 'visualassert') {
        return {
            operation: 'verify',
            target: `ui:visualAssert:mode=${safeSegment(args.mode)}:expected=${digestEvidenceValue(args)}`,
            evidenceKind: 'visual_assertion',
            phase: 'verify'
        };
    }
    if (normalizedToolName === 'findelement') {
        return {
            operation: 'read',
            target: `ui:findElement:snapshot=${safeSegment(snapshotId)}:query=${digestEvidenceValue(args)}`,
            evidenceKind: 'ui_element',
            phase: 'inspect'
        };
    }
    if (normalizedToolName === 'getelementstate') {
        return {
            operation: 'read',
            target: `ui:getElementState:snapshot=${safeSegment(snapshotId)}:ref=${safeSegment(args.ref)}`,
            evidenceKind: 'ui_element',
            phase: 'inspect'
        };
    }
    if (normalizedToolName === 'waitfor') {
        return {
            operation: 'verify',
            target: `ui:waitFor:condition=${digestEvidenceValue(args)}`,
            evidenceKind: 'ui_element',
            phase: 'verify'
        };
    }
    if (normalizedToolName === 'clickref') {
        return {
            operation: 'act',
            target: `ui:clickRef:${safeSegment(snapshotId)}/${safeSegment(args.ref)}:${safeSegment(args.position, 'center')}`,
            evidenceKind: 'ui_action',
            phase: 'act'
        };
    }
    if (normalizedToolName === 'click' || normalizedToolName === 'doubleclick' || normalizedToolName === 'longclick') {
        return {
            operation: 'act',
            target: `ui:${toolName}:x=${safeSegment(args.x)}:y=${safeSegment(args.y)}:args=${digestEvidenceValue(args)}`,
            evidenceKind: 'ui_action',
            phase: 'act'
        };
    }
    if (normalizedToolName === 'input') {
        return {
            operation: 'act',
            target: `ui:input:x=${safeSegment(args.x)}:y=${safeSegment(args.y)}:mode=${safeSegment(args.mode, 'append')}:text=${digestEvidenceValue(args.text)}`,
            evidenceKind: 'ui_action',
            phase: 'act'
        };
    }
    if (normalizedToolName === 'hover') {
        return {
            operation: 'act',
            target: `ui:hover:x=${safeSegment(args.x)}:y=${safeSegment(args.y)}:duration=${safeSegment(args.duration, '800')}`,
            evidenceKind: 'ui_action',
            phase: 'act'
        };
    }
    if (normalizedToolName === 'scroll' || normalizedToolName === 'scrollto') {
        return {
            operation: 'act',
            target: `ui:${toolName}:direction=${safeSegment(args.direction)}:region=${digestEvidenceValue(args.region ?? args)}`,
            evidenceKind: 'ui_action',
            phase: 'act'
        };
    }
    if (normalizedToolName === 'presskey') {
        return {
            operation: 'act',
            target: `ui:pressKey:key=${safeSegment(args.key)}:modifiers=${digestEvidenceValue(args.modifiers ?? [])}`,
            evidenceKind: 'ui_action',
            phase: 'act'
        };
    }
    if (normalizedToolName === 'listapps' || normalizedToolName === 'listwindows') {
        return {
            operation: 'search',
            target: `ui:${toolName}:args=${digestEvidenceValue(args)}`,
            evidenceKind: 'external_state',
            phase: 'localize'
        };
    }
    return {
        operation: 'act',
        target: `ui:${toolName}:args=${digestEvidenceValue(args)}`,
        evidenceKind: 'ui_action',
        phase: 'act'
    };
}

function browserSemantics(
    invocation: ResolvedEvidenceToolInvocation,
    toolCall: EvidenceToolCall
): EvidenceToolSemantics | undefined {
    if (invocation.toolsetName !== 'browser') return undefined;
    const toolName = invocation.toolName.toLowerCase();
    const args = invocation.args;
    const pageId =
        readString(args, 'tabId', 'pageId') || resultIdentity(toolCall, 'tabId', 'pageId', 'url') || 'current';
    if (toolName === 'navigate') {
        const url = readString(args, 'url');
        return {
            operation: 'act',
            target: `browser:navigate:${url ? normalizeUrl(url) : 'unspecified'}`,
            evidenceKind: 'ui_action',
            phase: 'act'
        };
    }
    if (toolName === 'snapshot') {
        return {
            operation: 'observe',
            target: `browser:snapshot:${safeSegment(pageId)}:args=${digestEvidenceValue(args)}`,
            evidenceKind: 'ui_snapshot',
            phase: 'inspect'
        };
    }
    if (toolName === 'tabs') {
        return {
            operation: 'search',
            target: `browser:tabs:args=${digestEvidenceValue(args)}`,
            evidenceKind: 'external_state',
            phase: 'localize'
        };
    }
    if (toolName === 'waitfor') {
        return {
            operation: 'verify',
            target: `browser:waitFor:${safeSegment(pageId)}:condition=${digestEvidenceValue(args)}`,
            evidenceKind: 'ui_element',
            phase: 'verify'
        };
    }
    if (toolName === 'evaluate') {
        return {
            operation: 'read',
            target: `browser:evaluate:${safeSegment(pageId)}:expression=${digestEvidenceValue(args)}`,
            evidenceKind: 'tool_observation',
            phase: 'inspect'
        };
    }
    return {
        operation: 'act',
        target: `browser:${invocation.toolName}:${safeSegment(pageId)}:args=${digestEvidenceValue(args)}`,
        evidenceKind: 'ui_action',
        phase: 'act'
    };
}

function genericPhase(toolName: string): EvidenceCardPhase {
    const normalized = toolName.toLowerCase();
    if (/^(?:list|search|find|glob|grep)|search/.test(normalized)) return 'localize';
    if (/^(?:read|get|snapshot|screenshot|inspect|retrieve|fetch|evaluate|tabs)/.test(normalized)) return 'inspect';
    if (/^(?:assert|verify|test|check|wait)/.test(normalized)) return 'verify';
    if (/^(?:write|edit|patch|searchreplace)/.test(normalized)) return 'patch';
    if (/^(?:plan|todo|subtask)/.test(normalized)) return 'plan';
    if (/^(?:askuser|exitplan)/.test(normalized)) return 'replan';
    return 'act';
}

function semanticsForPhase(phase: EvidenceCardPhase): Pick<EvidenceToolSemantics, 'operation' | 'evidenceKind'> {
    if (phase === 'localize') return { operation: 'search', evidenceKind: 'search_result' };
    if (phase === 'inspect') return { operation: 'read', evidenceKind: 'external_state' };
    if (phase === 'verify') return { operation: 'verify', evidenceKind: 'tool_observation' };
    if (phase === 'patch') return { operation: 'edit', evidenceKind: 'edit_region' };
    if (phase === 'plan') return { operation: 'plan', evidenceKind: 'task_state' };
    if (phase === 'replan') return { operation: 'interact', evidenceKind: 'user_input' };
    return { operation: 'act', evidenceKind: 'ui_action' };
}

export function classifyOpenDeskToolSemantics(
    invocation: ResolvedEvidenceToolInvocation,
    toolCall: EvidenceToolCall
): EvidenceToolSemantics {
    const toolsetName = invocation.toolsetName?.toLowerCase();
    const toolName = invocation.toolName.toLowerCase();
    const args = invocation.args;
    const resultText = toolCall.result || '';

    const harmony = harmonySemantics(invocation, toolCall);
    if (harmony) return resultWithErrorOverride(harmony, toolCall);

    if (invocation.wrapper?.kind === 'skill') {
        const innerToolName = invocation.effectiveName.split('/').at(-1) || invocation.toolName;
        const phase = genericPhase(innerToolName);
        const inferred = semanticsForPhase(phase);
        return resultWithErrorOverride(
            {
                ...inferred,
                target: `${invocation.effectiveName}:args=${digestEvidenceValue(args)}`,
                phase
            },
            toolCall
        );
    }

    if (invocation.wrapper?.kind === 'mcp') {
        return resultWithErrorOverride(
            {
                operation: 'act',
                target: `mcp:${invocation.wrapper.name}:args=${digestEvidenceValue(args)}`,
                evidenceKind: 'external_state',
                phase: 'act'
            },
            toolCall
        );
    }
    if (invocation.wrapper?.kind === 'device') {
        return resultWithErrorOverride(
            {
                operation: 'act',
                target: `device:${invocation.wrapper.name}:params=${digestEvidenceValue(args)}`,
                evidenceKind: 'external_state',
                phase: 'act'
            },
            toolCall
        );
    }
    if (invocation.wrapper?.kind === 'workflow') {
        return resultWithErrorOverride(
            {
                operation: 'execute',
                target: `workflow:${invocation.wrapper.name}:input=${digestEvidenceValue(args)}`,
                evidenceKind: 'task_state',
                phase: 'act'
            },
            toolCall
        );
    }

    if (toolsetName === 'filemgr') {
        const semantics = fileSemantics(invocation);
        if (semantics) return resultWithErrorOverride(semantics, toolCall);
    }
    if (toolsetName === 'terminal') {
        return resultWithErrorOverride(terminalSemantics(invocation, resultText), toolCall);
    }
    if (toolsetName === 'skill-manager' && toolName === 'loadskill') {
        return resultWithErrorOverride(
            {
                operation: 'read',
                target: `skill:load:${safeSegment(args.bundleName)}/${safeSegment(args.skillName)}`,
                evidenceKind: 'skill_definition',
                phase: 'inspect',
                repeatPolicy: 'target'
            },
            toolCall
        );
    }
    const browser = browserSemantics(invocation, toolCall);
    if (browser) return resultWithErrorOverride(browser, toolCall);

    if (toolsetName === 'todomgr' && toolName === 'todowrite') {
        return resultWithErrorOverride(
            {
                operation: 'plan',
                target: `task:todo:state=${digestEvidenceValue(args.todos)}`,
                evidenceKind: 'task_state',
                phase: 'plan'
            },
            toolCall
        );
    }
    if (toolsetName === 'planning' || toolsetName === 'task-info' || toolsetName === 'pool') {
        return resultWithErrorOverride(
            {
                operation: 'plan',
                target: `task:${invocation.toolName}:args=${digestEvidenceValue(args)}`,
                evidenceKind: 'task_state',
                phase: toolName === 'attemptcompletion' ? 'answer' : 'plan'
            },
            toolCall
        );
    }
    if (toolsetName === 'interaction' && (toolName === 'askuser' || toolName === 'exitplanmode')) {
        return resultWithErrorOverride(
            {
                operation: 'interact',
                target: `interaction:${invocation.toolName}:questions=${digestEvidenceValue(args)}`,
                evidenceKind: 'user_input',
                phase: 'replan'
            },
            toolCall
        );
    }
    if (toolsetName?.startsWith('search')) {
        const url = readString(args, 'url');
        return resultWithErrorOverride(
            {
                operation: toolName === 'webfetch' ? 'read' : 'search',
                target: url
                    ? `web:fetch:${normalizeUrl(url)}`
                    : `web:${invocation.toolName}:query=${digestEvidenceValue(args.query ?? args)}`,
                evidenceKind: 'search_result',
                phase: toolName === 'webfetch' ? 'inspect' : 'localize',
                repeatPolicy:
                    toolsetName === 'search' && (toolName === 'webfetch' || toolName.endsWith('search'))
                        ? 'target'
                        : undefined
            },
            toolCall
        );
    }
    if (toolsetName?.startsWith('knowledgebase')) {
        const isQuery = /retrieve|ask/i.test(toolName);
        const isList = toolName.startsWith('list');
        return resultWithErrorOverride(
            {
                operation: isQuery ? 'read' : isList ? 'search' : 'act',
                target: `knowledge:${safeSegment(args.providerId ?? args.provider)}/${safeSegment(args.knowledgeBaseId ?? args.id)}:${toolName}:args=${digestEvidenceValue(args)}`,
                evidenceKind: isQuery ? 'knowledge_result' : isList ? 'external_state' : 'ui_action',
                phase: isQuery ? 'inspect' : isList ? 'localize' : 'act',
                repeatPolicy: isQuery ? 'target' : undefined
            },
            toolCall
        );
    }
    if (toolsetName === 'mcpmgr' && (toolName === 'mcpsearchtools' || toolName === 'mcpgettool')) {
        return resultWithErrorOverride(
            {
                operation: toolName === 'mcpsearchtools' ? 'search' : 'read',
                target: `mcp:${invocation.toolName}:args=${digestEvidenceValue(args)}`,
                evidenceKind: 'skill_definition',
                phase: toolName === 'mcpsearchtools' ? 'localize' : 'inspect',
                repeatPolicy: 'target'
            },
            toolCall
        );
    }

    const phase = genericPhase(invocation.toolName);
    const inferred = semanticsForPhase(phase);
    return resultWithErrorOverride(
        {
            ...inferred,
            target: invocation.qualifiedName.startsWith('unknown-')
                ? `tool:unknown:call=${safeSegment(toolCall.id)}`
                : `tool:${invocation.qualifiedName}:${Object.keys(args).length > 0 ? `args=${digestEvidenceValue(args)}` : 'no-args'}`,
            phase
        },
        toolCall
    );
}

export function resolveEvidenceToolSemantics(
    toolCall: EvidenceToolCall,
    registry?: EvidenceToolRegistry
): EvidenceToolSemantics {
    const invocation = resolveEvidenceToolInvocation(toolCall, registry);
    return classifyOpenDeskToolSemantics(invocation, toolCall);
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

function estimateTextTokens(text: string | undefined): number {
    if (!text) {
        return 0;
    }
    return Math.ceil(text.length / 4);
}

const ALLOWED_PHASES: EvidenceCardPhase[] = [
    'plan',
    'localize',
    'inspect',
    'act',
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
    'skill_definition',
    'search_result',
    'knowledge_result',
    'ui_snapshot',
    'ui_element',
    'ui_action',
    'visual_assertion',
    'task_state',
    'user_input',
    'external_state',
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

function isLikelyAnswerArtifactCommand(command: string): boolean {
    const normalized = command.toLowerCase();
    return (
        /answer\.(json|txt|md|yaml|yml)/.test(normalized) &&
        /(cat\s*>|set-content|out-file|write-output|echo\s+)/.test(normalized)
    );
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
        chat_context?: EvidenceToolRegistry;
    },
    toolCall: ToolCall
): void {
    if (!isTaskEvidenceCardEnabled(task)) {
        return;
    }
    const settings = getEvidenceCardSettings(true);
    const state = ensureEvidenceCardState(task);
    state.enabled = true;

    const args = parseEvidenceToolCallArgs(toolCall);
    const command = getCommand(args);
    if (isLikelyAnswerArtifactCommand(command)) {
        return;
    }

    const resultText = typeof toolCall.result === 'string' ? toolCall.result : '';
    const semantics = resolveEvidenceToolSemantics(toolCall, task.chat_context);
    const evidenceKind = semantics.evidenceKind;
    const phase = semantics.phase;
    const target = semantics.target;
    const repeatEligible = semantics.repeatPolicy === 'target' && toolCall.status === 'success';
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
    task.hooks.onTailcardGenerate(
        (currentTask, context) => {
            if (!currentTask.refreshEvidenceCardFeatureState()) {
                return undefined;
            }
            const content = buildEvidenceCardRuntimeTail(
                context.activeContext ?? context.chatContext,
                currentTask.evidencecard_state
            );
            return content.trim().length > 0 ? { id: 'evidence-card', content } : undefined;
        },
        {
            id: 'evidence-card',
            maxChars: 8_000
        }
    );
}
