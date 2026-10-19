/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 license for more details.
 */

import type { AssistantMessagePart } from '../messages.js';
import type { TaskUpdateChunk } from './types.js';

function serializeAssistantPartForRender(part: AssistantMessagePart): object {
    return part.toRenderJSON();
}

function serializeStreamingAssistantPart(part: AssistantMessagePart): object {
    const serialized = serializeAssistantPartForRender(part) as Record<string, unknown>;
    if (part.type === 'reasoning') {
        // text 是流式 reasoning 快照的唯一内容拷贝；rendered 与 content 是同一份文本的
        // 重复拷贝（渲染路径恒等），残留时会使长思考输出的 payload 体积翻倍。
        const { rendered: _rendered, ...rest } = serialized;
        return { ...rest, text: part.content };
    }
    return serialized;
}

/** Prevent raw tool arguments and results from bypassing the render DTO on live Electron updates. */
export function serializeTaskUpdateForRender(chunk: TaskUpdateChunk): object {
    if (chunk.type === 'assistant') {
        return {
            ...chunk,
            last_part: chunk.streaming
                ? serializeStreamingAssistantPart(chunk.last_part)
                : serializeAssistantPartForRender(chunk.last_part)
        };
    }
    if (chunk.type === 'assistant_replace') {
        return {
            ...chunk,
            parts: chunk.parts.map(serializeAssistantPartForRender)
        };
    }
    return chunk;
}
