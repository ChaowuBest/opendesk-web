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

import iconv from 'iconv-lite';


/** 用于检测编码时读取的文件头字节数 */
export const HEAD_BYTES = 8192;

/** UTF-8 替换字符，用于启发式判断 */
const UTF8_REPLACEMENT = '\uFFFD';

/** 无 BOM 时若 UTF-8 解码中替换字符占比超过此值则尝试 GBK */
const REPLACEMENT_RATIO_THRESHOLD = 0.05;

export interface DetectResult {
    /** 检测到的编码（与 Node/iconv 一致：utf8, utf16le, utf16be, gbk 等） */
    encoding: string;
    /** BOM 占用的字节数，解码时应从该偏移开始 */
    bomOffset: number;
}

/**
 * 根据文件头 Buffer 检测编码（BOM 优先，无 BOM 时 UTF-8 vs GBK 启发式）
 */
export function detectEncoding(buffer: Buffer): DetectResult {
    if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
        return { encoding: 'utf8', bomOffset: 3 };
    }
    if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
        return { encoding: 'utf16le', bomOffset: 2 };
    }
    if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
        return { encoding: 'utf16be', bomOffset: 2 };
    }

    const bomOffset = 0;
    const utf8Str = buffer.toString('utf8');
    const replacementCount = (utf8Str.match(/\uFFFD/g) || []).length;
    const ratio = utf8Str.length > 0 ? replacementCount / utf8Str.length : 0;

    if (ratio <= REPLACEMENT_RATIO_THRESHOLD) {
        return { encoding: 'utf8', bomOffset };
    }

    try {
        const gbkStr = iconv.decode(buffer, 'gbk');
        const gbkReplacement = (gbkStr.match(new RegExp(UTF8_REPLACEMENT, 'g')) || []).length;
        const gbkRatio = gbkStr.length > 0 ? gbkReplacement / gbkStr.length : 0;
        if (gbkRatio < ratio) {
            return { encoding: 'gbk', bomOffset };
        }
    } catch {
        // 解码失败则仍用 utf8
    }
    return { encoding: 'utf8', bomOffset };
}

/**
 * 将 Buffer 按指定编码解码为字符串（从 startOffset 开始，用于跳过 BOM）
 */
export function decodeBuffer(buffer: Buffer, encoding: string, startOffset: number = 0): string {
    const slice = startOffset > 0 ? buffer.subarray(startOffset) : buffer;
    switch (encoding) {
        case 'utf8':
        case 'utf16le':
        case 'utf16be':
            return slice.toString(encoding as BufferEncoding);
        default:
            return iconv.decode(slice, encoding);
    }
}

/**
 * 供外部显示的编码名称（与 metadata 中一致）
 */
export function encodingDisplayName(encoding: string): string {
    const names: Record<string, string> = {
        utf8: 'UTF-8',
        utf16le: 'UTF-16LE',
        utf16be: 'UTF-16BE',
        gbk: 'GBK',
        gb2312: 'GB2312'
    };
    return names[encoding] ?? encoding.toUpperCase();
}
