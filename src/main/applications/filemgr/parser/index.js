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
 * index.js — parser 模块对外唯一入口
 * 组合 extract + chunk，提供 parseAndChunk 入口函数
 */

import { extractText } from './extract.js';
import { chunkBasic, chunkStructured, chunkSemantic } from './chunk.js';

/**
 * 解析文件内容并分块
 *
 * @param {string} filePath - 单文件路径
 * @param {{ isChunk?: boolean, level?: 'basic'|'structured'|'semantic', ...options }} [options]
 * @param {((texts: string[]) => Promise<number[][]>)} [embedFn] - L4 可选 embedding 函数
 * @returns {Promise<
 *   { filePath: string, text: string|null }                                                       // isChunk=false：仅解析，返回 text，无 chunk_type/chunks
 * | { filePath: string, chunk_type: 'chunk'|'abstract'|'filename'|null, chunks: Array<{id: string, text: string}>|null }  // isChunk=true（默认）：返回 chunk_type+chunks，无 text
 * >}
 */
export async function parseAndChunk(filePath, options = {}, embedFn) {
    const { isChunk = true, level = 'structured', ...chunkOptions } = options;

    const text = await extractText(filePath);

    if (!isChunk) {
        return { filePath, text };
    }

    let result;
    switch (level) {
        case 'basic':
            result = chunkBasic(text, chunkOptions);
            break;
        case 'structured':
            result = chunkStructured(text, filePath, chunkOptions);
            break;
        case 'semantic':
            result = await chunkSemantic(text, filePath, chunkOptions, embedFn);
            break;
        default:
            result = chunkStructured(text, filePath, chunkOptions);
    }

    return { filePath, chunk_type: result.chunk_type, chunks: result.chunks };
}

// Re-export 供需要直接使用的调用方
export { chunkBasic, chunkStructured, chunkSemantic } from './chunk.js';
export { extractText } from './extract.js';
