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
 * 严格校验 Buffer 是否为合法 UTF-8（fatal 模式下遇到非法字节序列会抛错）。
 * 头部被截断的多字节字符尾部允许失败（由 tailGuard 限定校验范围）。
 */
function isValidUtf8(buffer: Buffer): boolean {
    // 末尾最多 3 字节可能是一个被截断的多字节字符头部，校验时排除
    let checkLen = buffer.length;
    for (let i = 0; i < 3 && checkLen > 0; i++) {
        if ((buffer[checkLen - 1] & 0xc0) !== 0x80) break;
        checkLen--;
    }
    if (checkLen === 0) return true;
    try {
        new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, checkLen));
        return true;
    } catch {
        return false;
    }
}

/** 供 chardet 统计检测使用的采样窗口大小 */
const CHARDET_SAMPLE_BYTES = HEAD_BYTES;
/** 锚定窗口向前多带的上下文字节数，避免多字节字符被窗口起点截断 */
const CHARDET_ANCHOR_CONTEXT_BYTES = 64;

/**
 * 在 Buffer 中找到第一个非 ASCII 字节（>=0x80）的位置。
 * 找不到返回 -1（纯 ASCII 内容）。
 */
function findFirstHighByte(buffer: Buffer): number {
    for (let i = 0; i < buffer.length; i++) {
        if (buffer[i] >= 0x80) return i;
    }
    return -1;
}

/**
 * 为 chardet 截取有判别力的采样窗口：
 * 多字节内容紧跟在长 ASCII 头部之后时（如生成代码 + 中文注释的 GBK 文件），
 * 从文件头开始采样只能拿到纯 ASCII，统计检测必然失真；
 * 锚定到第一个高位字节附近采样才能命中真实编码特征。
 */
function extractChardetSample(buffer: Buffer): Buffer {
    if (buffer.length <= CHARDET_SAMPLE_BYTES) {
        return buffer;
    }
    const anchor = findFirstHighByte(buffer);
    if (anchor < 0) {
        return buffer.subarray(0, CHARDET_SAMPLE_BYTES);
    }
    const start = Math.max(0, anchor - CHARDET_ANCHOR_CONTEXT_BYTES);
    return buffer.subarray(start, start + CHARDET_SAMPLE_BYTES);
}

/**
 * 根据文件内容 Buffer 检测编码（应传入完整文件内容，而非头部片段）。
 * 优先级：BOM > UTF-8 严格校验（全文） > chardet 统计检测（锚定窗口） > UTF-8 回退
 *
 * 无 BOM 时先做全文 UTF-8 严格校验：UTF-8 有确定性的字节序列规则，任何位置的非法序列
 * 都会导致校验失败，因此通过即可断定全文是 UTF-8，避免把"头部以 ASCII 为主、中文稀疏"
 * 的源码文件误交给 chardet——这类样本上 chardet 经常把纯 ASCII 头判成 ISO-8859-1
 * （置信度还高于 UTF-8），导致中文字节被按单字节解码成乱码。含 NUL 字节的内容不视为
 * UTF-8 文本（NUL 是合法 UTF-8 码点，但文本文件中不应出现，通常是 UTF-16 等宽字节编码），
 * 交给 chardet 以保留其 UTF-16 感知能力。
 *
 * 校验失败说明存在非法 UTF-8 序列（GBK/Big5/Shift_JIS 等），此时用锚定窗口（第一个
 * 高位字节附近起 8KB）交给 chardet 统计检测——窗口内多字节样本充足，统计检测可靠。
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

    // 无 BOM：先做全文 UTF-8 严格校验（含 NUL 时不算纯文本，走 chardet）
    if (!buffer.includes(0) && isValidUtf8(buffer)) {
        return { encoding: 'utf8', bomOffset: 0 };
    }

    // 非 UTF-8：使用 chardet 统计检测（锚定采样窗口）
    const results = chardet.analyse(extractChardetSample(buffer));
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
