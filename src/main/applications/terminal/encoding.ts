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

import chardet from 'chardet';
import iconv from 'iconv-lite';

/** 用于检测编码时读取的文件头字节数 */
export const HEAD_BYTES = 8192;

export interface DetectResult {
    /** 检测到的编码名（iconv-lite 或 TextDecoder 兼容） */
    encoding: string;
    /** BOM 占用的字节数，解码时应从该偏移开始 */
    bomOffset: number;
}

/**
 * chardet 返回的编码名 -> 解码器兼容名的显式映射。
 * 大部分 chardet 名称可直接被 iconv-lite 或 TextDecoder 接受，
 * 此表只收录需要特殊处理的条目。
 */
const CHARDET_NAME_OVERRIDE: Record<string, string> = {
    'ISO-2022-KR': 'cp949',
    'ISO-2022-CN': 'gb18030'
};

function normalizeChardetName(name: string): string {
    return CHARDET_NAME_OVERRIDE[name] ?? name;
}

function isDecodable(encoding: string): boolean {
    if (iconv.encodingExists(encoding)) return true;
    try {
        new TextDecoder(encoding);
        return true;
    } catch {
        return false;
    }
}

/**
 * 根据文件头 Buffer 检测编码。
 * 优先级：BOM > chardet 统计检测 > UTF-8 回退
 */
export function detectEncoding(buffer: Buffer): DetectResult {
    // UTF-32 BOM 必须在 UTF-16 之前检测（UTF-32 LE 前两字节与 UTF-16 LE BOM 相同）
    if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xfe && buffer[2] === 0x00 && buffer[3] === 0x00) {
        return { encoding: 'utf-32le', bomOffset: 4 };
    }
    if (buffer.length >= 4 && buffer[0] === 0x00 && buffer[1] === 0x00 && buffer[2] === 0xfe && buffer[3] === 0xff) {
        return { encoding: 'utf-32be', bomOffset: 4 };
    }

    if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
        return { encoding: 'utf8', bomOffset: 3 };
    }
    if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
        return { encoding: 'utf16le', bomOffset: 2 };
    }
    if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
        return { encoding: 'utf16be', bomOffset: 2 };
    }

    // 无 BOM：使用 chardet 统计检测
    const results = chardet.analyse(buffer);
    if (results.length > 0) {
        const best = results[0];
        const encoding = normalizeChardetName(best.name);
        if (isDecodable(encoding)) {
            return { encoding, bomOffset: 0 };
        }
    }

    return { encoding: 'utf8', bomOffset: 0 };
}

/**
 * 将 Buffer 按指定编码解码为字符串（从 startOffset 开始，用于跳过 BOM）。
 * 优先使用 iconv-lite，不支持时回退到 Node.js 内置的 TextDecoder。
 */
export function decodeBuffer(buffer: Buffer, encoding: string, startOffset: number = 0): string {
    const slice = startOffset > 0 ? buffer.subarray(startOffset) : buffer;

    if (encoding === 'utf8' || encoding === 'utf16le') {
        return slice.toString(encoding as BufferEncoding);
    }

    if (iconv.encodingExists(encoding)) {
        return iconv.decode(slice, encoding);
    }

    try {
        const decoder = new TextDecoder(encoding);
        return decoder.decode(slice);
    } catch {
        return slice.toString('utf8');
    }
}

const DISPLAY_NAMES: Record<string, string> = {
    utf8: 'UTF-8',
    'UTF-8': 'UTF-8',
    utf16le: 'UTF-16 LE',
    utf16be: 'UTF-16 BE',
    'UTF-16 LE': 'UTF-16 LE',
    'UTF-16 BE': 'UTF-16 BE',
    'utf-32le': 'UTF-32 LE',
    'utf-32be': 'UTF-32 BE',
    'UTF-32 LE': 'UTF-32 LE',
    'UTF-32 BE': 'UTF-32 BE',
    gbk: 'GBK',
    GBK: 'GBK',
    gb18030: 'GB18030',
    GB18030: 'GB18030',
    gb2312: 'GB2312',
    Big5: 'Big5',
    big5: 'Big5',
    Shift_JIS: 'Shift-JIS',
    shiftjis: 'Shift-JIS',
    'EUC-JP': 'EUC-JP',
    eucjp: 'EUC-JP',
    'EUC-KR': 'EUC-KR',
    euckr: 'EUC-KR',
    cp949: 'EUC-KR',
    'KOI8-R': 'KOI8-R',
    koi8r: 'KOI8-R',
    'ISO-2022-JP': 'ISO-2022-JP'
};

/**
 * 供外部显示的编码名称
 */
export function encodingDisplayName(encoding: string): string {
    return DISPLAY_NAMES[encoding] ?? encoding.toUpperCase();
}
