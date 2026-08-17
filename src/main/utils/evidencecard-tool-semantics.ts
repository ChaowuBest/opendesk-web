/**
 * Copyright (c) 2026 The OpenDesk Team
 *
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
import type { ToolCall } from '../aikernel/messages.js';
import { parseNestedToolArgs } from './tool-args.js';

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
        return parseNestedToolArgs(toolCall.args_string);
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
        return parseNestedToolArgs(value);
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
        return parseNestedToolArgs(toolCall.result);
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
            phase: 'inspect'
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
            phase: 'inspect'
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
            phase: 'localize'
        };
    }
    if (toolName === 'grepfiles' || toolName === 'semanticsearch') {
        const root = readString(args, 'path', 'directory', 'root', 'workingDirectory');
        return {
            operation: 'search',
            target: `file:${toolName}:${root ? normalizePath(root) : 'workspace'}:query=${digestEvidenceValue(args.pattern ?? args.query ?? args)}`,
            evidenceKind: toolName === 'grepfiles' ? 'symbol_signature' : 'search_result',
            phase: 'localize'
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
    if (/\brg\b|grep|select-string|ripgrep|\bfind\b|\blist\b|\bls\b|get-childitem|git\s+ls-files/i.test(command)) {
        return {
            operation: 'search',
            target,
            evidenceKind: /\brg\b|grep|select-string|ripgrep/i.test(command) ? 'symbol_signature' : 'repo_map',
            phase: 'localize'
        };
    }
    if (/get-content|\bcat\b|\bsed\b|\bnl\b|\btype\b|\bhead\b|\btail\b/i.test(command)) {
        return { operation: 'read', target, evidenceKind: 'tool_observation', phase: 'inspect' };
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
                phase: 'inspect'
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
                phase: toolName === 'webfetch' ? 'inspect' : 'localize'
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
                phase: isQuery ? 'inspect' : isList ? 'localize' : 'act'
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
                phase: toolName === 'mcpsearchtools' ? 'localize' : 'inspect'
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
