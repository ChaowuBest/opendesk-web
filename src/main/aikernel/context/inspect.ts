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

import { prepareContextForModel } from '../compaction/pipeline.js';
import { ChatContext } from '../messages.js';
import { AutoCompactStates, type AutoCompactState } from '../compaction/auto-compact.js';
import { MicrocompactStates, type MicrocompactState } from '../compaction/microcompact-state.js';
import { ToolResultReplacementStates, type ToolResultReplacementState } from '../compaction/tool-results.js';
import { SessionMemoryStates, type SessionMemoryState } from '../compaction/session-memory-compact.js';
import type { ContextInspectOptions, ContextInspectResult } from './types.js';

/**
 * 克隆 ChatContext 供只读诊断使用。
 *
 * toolsets 是运行时对象，无法经 toJSON()/assign() 序列化恢复，
 * 这里在 JSON 深拷贝后浅拷贝 Map 共享 toolset 引用，克隆体上的增删不影响原始上下文。
 */
export function cloneChatContext(chatContext: ChatContext): ChatContext {
    const cloned = ChatContext.assign(JSON.parse(JSON.stringify(chatContext.toJSON())));
    cloned.toolsets = new Map(chatContext.toolsets);
    return cloned;
}

function cloneAutoCompactState(state: AutoCompactState | undefined): AutoCompactState | undefined {
    return state ? AutoCompactStates.clone(state) : undefined;
}

function cloneMicrocompactState(state: MicrocompactState | undefined): MicrocompactState | undefined {
    return state ? MicrocompactStates.clone(state) : undefined;
}

function cloneToolResultReplacementState(
    state: ToolResultReplacementState | undefined
): ToolResultReplacementState | undefined {
    return state ? ToolResultReplacementStates.clone(state) : undefined;
}

function cloneSessionMemoryState(state: SessionMemoryState | undefined): SessionMemoryState | undefined {
    return state ? SessionMemoryStates.clone(state) : undefined;
}

function sanitizeInspectOptions(options: ContextInspectOptions = {}): ContextInspectOptions {
    return {
        ...options,
        readonlyOnly: true,
        beforeCompact: undefined,
        enableSessionMemoryCompact: false,
        enableToolResultBudget: options.enableToolResultBudget ?? true,
        executeCompact: () => false,
        autoCompactState: cloneAutoCompactState(options.autoCompactState),
        microcompactState: cloneMicrocompactState(options.microcompactState),
        sessionMemoryState: cloneSessionMemoryState(options.sessionMemoryState),
        toolResultReplacementState: cloneToolResultReplacementState(options.toolResultReplacementState)
    };
}

/**
 * 只读的上下文诊断入口。
 *
 * 通过克隆 chatContext 和相关状态复用现有 compaction 预处理链路，
 * 但不会把 inspection 的结果写回原始上下文对象。
 */
export async function inspectContextForDiagnostics(
    chatContext: ChatContext,
    model?: string,
    options: ContextInspectOptions = {}
): Promise<ContextInspectResult> {
    const clonedContext = cloneChatContext(chatContext);
    return prepareContextForModel(clonedContext, model, sanitizeInspectOptions(options));
}

export type { ContextInspectInput, ContextInspectOptions, ContextInspectResult } from './types.js';
