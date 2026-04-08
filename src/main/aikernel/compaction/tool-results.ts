import fs from 'fs';
import path from 'path';
import { getTaskToolResultDirectory } from '../../utils/setting.js';
import { AssistantMessage, ChatContext, ToolCall, type ToolResultStorageMetadata } from '../messages.js';

export const TOOL_RESULT_STORAGE_DIRECTORY_NAME = 'tool-results';
export const TOOL_RESULT_STORAGE_EXTENSION = '.txt';

// 临时降低阈值，便于 Step 3C 手工调试大结果落盘链路。
export const LARGE_TOOL_RESULT_LINES = 120;
export const LARGE_TOOL_RESULT_CHARS = 12_000;
export const ARTIFACT_HEAD_LINES = 30;
export const ARTIFACT_TAIL_LINES = 50;
export const ARTIFACT_HEAD_CHARS = 1_500;
export const ARTIFACT_TAIL_CHARS = 2_500;

export interface ToolResultPreview {
    mode: 'chars' | 'lines';
    previewText: string;
    omittedChars?: number;
    omittedLines?: number;
}

export interface PersistedToolResultArtifact {
    fullPath: string;
    relativePath: string;
    originalChars: number;
    originalLines: number;
}

export interface PersistedToolResultForCall {
    metadata: ToolResultStorageMetadata;
    fullPath: string;
}

export interface ToolResultReplacementRecord {
    result_id: string;
    replacement_text: string;
    relative_path?: string;
}

export interface SerializedToolResultReplacementState {
    seen_ids: string[];
    replacements: ToolResultReplacementRecord[];
}

export interface ToolResultReplacementState {
    seenIds: Set<string>;
    replacements: Map<string, ToolResultReplacementRecord>;
}

function sanitizeToolResultId(resultId: string): string {
    return resultId.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_');
}

export function countToolResultLines(result: string): number {
    if (result.length === 0) {
        return 0;
    }
    return result.split('\n').length;
}

export function ensureToolResultStorageId(toolCall: ToolCall): string {
    return toolCall.ensureResultStorage().result_id;
}

function truncateByLines(result: string): ToolResultPreview | undefined {
    const lines = result.split('\n');
    if (lines.length <= LARGE_TOOL_RESULT_LINES) {
        return undefined;
    }

    const head = lines.slice(0, ARTIFACT_HEAD_LINES).join('\n');
    const tail = lines.slice(-ARTIFACT_TAIL_LINES).join('\n');
    const omittedLines = Math.max(lines.length - ARTIFACT_HEAD_LINES - ARTIFACT_TAIL_LINES, 0);

    return {
        mode: 'lines',
        previewText: `${head}\n\n... [中间省略 ${omittedLines} 行] ...\n\n${tail}`,
        omittedLines
    };
}

function truncateByChars(result: string): ToolResultPreview | undefined {
    if (result.length <= LARGE_TOOL_RESULT_CHARS) {
        return undefined;
    }

    const head = result.slice(0, ARTIFACT_HEAD_CHARS);
    const tail = result.slice(-ARTIFACT_TAIL_CHARS);
    const omittedChars = Math.max(result.length - ARTIFACT_HEAD_CHARS - ARTIFACT_TAIL_CHARS, 0);
    const omittedKB = (omittedChars / 1024).toFixed(1);

    return {
        mode: 'chars',
        previewText: `${head}\n\n... [中间省略约 ${omittedKB} KB] ...\n\n${tail}`,
        omittedChars
    };
}

export function truncateToolResultForPreview(result: string): ToolResultPreview | undefined {
    return truncateByChars(result) ?? truncateByLines(result);
}

export function shouldPersistToolResult(result: string): boolean {
    return truncateToolResultForPreview(result) !== undefined;
}

export function getToolResultFilename(resultId: string): string {
    return `${sanitizeToolResultId(resultId)}${TOOL_RESULT_STORAGE_EXTENSION}`;
}

export function getToolResultArtifactRelativePath(taskId: string, resultId: string): string {
    return path.join('artifacts', taskId, TOOL_RESULT_STORAGE_DIRECTORY_NAME, getToolResultFilename(resultId));
}

export function getToolResultArtifactPath(taskId: string, resultId: string, ensureExists: boolean = true): string {
    return path.join(getTaskToolResultDirectory(taskId, ensureExists), getToolResultFilename(resultId));
}

export function persistToolResultArtifact(
    taskId: string,
    resultId: string,
    result: string
): PersistedToolResultArtifact {
    const fullPath = getToolResultArtifactPath(taskId, resultId, true);
    if (!fs.existsSync(fullPath)) {
        fs.writeFileSync(fullPath, result, 'utf8');
    }

    return {
        fullPath,
        relativePath: getToolResultArtifactRelativePath(taskId, resultId),
        originalChars: result.length,
        originalLines: countToolResultLines(result)
    };
}

export function buildToolResultReplacementText(previewText: string, fullPath: string): string {
    return `${previewText}\n\n完整输出已保存至: ${fullPath}\n若需完整内容请通过读文件方式获取。`;
}

export function buildToolResultStorageMetadata(
    toolCall: ToolCall,
    artifact: PersistedToolResultArtifact,
    replacementText: string,
    persistedAt: string = new Date().toISOString()
): ToolResultStorageMetadata {
    return toolCall.ensureResultStorage({
        relative_path: artifact.relativePath,
        original_chars: artifact.originalChars,
        original_lines: artifact.originalLines,
        persisted_at: persistedAt,
        replacement_text: replacementText
    });
}

export function persistToolResultForToolCall(
    taskId: string,
    toolCall: ToolCall,
    result: string,
    replacementText: string,
    persistedAt: string = new Date().toISOString()
): PersistedToolResultForCall {
    const resultId = ensureToolResultStorageId(toolCall);
    const artifact = persistToolResultArtifact(taskId, resultId, result);
    const metadata = buildToolResultStorageMetadata(toolCall, artifact, replacementText, persistedAt);

    return {
        metadata,
        fullPath: artifact.fullPath
    };
}

function normalizeReplacementRecord(record: unknown): ToolResultReplacementRecord | undefined {
    if (record === undefined || record === null || typeof record !== 'object') {
        return undefined;
    }

    const candidate = record as {
        result_id?: unknown;
        replacement_text?: unknown;
        relative_path?: unknown;
    };

    if (typeof candidate.result_id !== 'string' || candidate.result_id.trim().length === 0) {
        return undefined;
    }

    if (typeof candidate.replacement_text !== 'string' || candidate.replacement_text.length === 0) {
        return undefined;
    }

    const normalized: ToolResultReplacementRecord = {
        result_id: candidate.result_id,
        replacement_text: candidate.replacement_text
    };

    if (typeof candidate.relative_path === 'string' && candidate.relative_path.trim().length > 0) {
        normalized.relative_path = candidate.relative_path;
    }

    return normalized;
}

function createEmptyState(): ToolResultReplacementState {
    return {
        seenIds: new Set<string>(),
        replacements: new Map<string, ToolResultReplacementRecord>()
    };
}

function applyReplacementRecord(state: ToolResultReplacementState, record: ToolResultReplacementRecord): void {
    state.seenIds.add(record.result_id);
    state.replacements.set(record.result_id, record);
}

function applyChatContextMetadata(state: ToolResultReplacementState, chatContext: ChatContext): void {
    for (const message of chatContext.messages) {
        if (!(message instanceof AssistantMessage)) {
            continue;
        }

        for (const part of message.content) {
            if (part.type !== 'tool_call') {
                continue;
            }

            for (const toolCall of part.toolcalls) {
                const metadata = toolCall.result_storage;
                if (!metadata?.result_id) {
                    continue;
                }

                state.seenIds.add(metadata.result_id);

                if (typeof metadata.replacement_text === 'string' && metadata.replacement_text.length > 0) {
                    applyReplacementRecord(state, {
                        result_id: metadata.result_id,
                        replacement_text: metadata.replacement_text,
                        relative_path: metadata.relative_path
                    });
                }
            }
        }
    }
}

export class ToolResultReplacementStates {
    static create(): ToolResultReplacementState {
        return createEmptyState();
    }

    static clone(source: ToolResultReplacementState): ToolResultReplacementState {
        return {
            seenIds: new Set(source.seenIds),
            replacements: new Map(
                Array.from(source.replacements.entries()).map(([resultId, record]) => [resultId, { ...record }])
            )
        };
    }

    static synchronize(state: ToolResultReplacementState, chatContext: ChatContext): ToolResultReplacementState {
        const synchronized = ToolResultReplacementStates.clone(state);
        applyChatContextMetadata(synchronized, chatContext);
        return synchronized;
    }

    static deserialize(raw: unknown, chatContext?: ChatContext): ToolResultReplacementState {
        const state = createEmptyState();

        if (raw && typeof raw === 'object') {
            const candidate = raw as {
                seen_ids?: unknown;
                replacements?: unknown;
            };

            if (Array.isArray(candidate.seen_ids)) {
                for (const seenId of candidate.seen_ids) {
                    if (typeof seenId === 'string' && seenId.trim().length > 0) {
                        state.seenIds.add(seenId);
                    }
                }
            }

            if (Array.isArray(candidate.replacements)) {
                for (const replacement of candidate.replacements) {
                    const normalized = normalizeReplacementRecord(replacement);
                    if (normalized) {
                        applyReplacementRecord(state, normalized);
                    }
                }
            }
        }

        if (chatContext) {
            applyChatContextMetadata(state, chatContext);
        }

        return state;
    }

    static serialize(
        state: ToolResultReplacementState,
        chatContext?: ChatContext
    ): SerializedToolResultReplacementState {
        const synchronized = chatContext
            ? ToolResultReplacementStates.synchronize(state, chatContext)
            : ToolResultReplacementStates.clone(state);

        return {
            seen_ids: Array.from(synchronized.seenIds).sort(),
            replacements: Array.from(synchronized.replacements.values()).sort((a, b) =>
                a.result_id.localeCompare(b.result_id)
            )
        };
    }
}
