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
 * chunk.js — 纯文本分块算法，不做 I/O
 */

import path from 'path';
import { chunk as llmChunk } from 'llm-chunk';
import { LLM } from '../../../aikernel/llm.js';

const TABLE_ABSTRACT_MAX_CHARS = 2000;
const TABLE_ABSTRACT_MAX_COLUMNS = 80;
const TABLE_ABSTRACT_MAX_CELL_CHARS = 80;
const TABLE_ABSTRACT_TRUNCATED_MARKER = '\n...[已截断]';

async function getBatchEmbedFn() {
    return LLM.batchEmbed.bind(LLM);
}

// ── 私有：format 映射 ──────────────────────────────────────────────────

/**
 * 文件扩展名 → 内部 format 名
 * @param {string} filePath
 * @returns {'prose'|'markdown'|'slides'|'code'|'csv'|'xlsx'|'filename'|null}
 */
function resolveFormat(filePath) {
    const ext = path.extname(filePath).slice(1).toLowerCase();
    if (['pdf', 'doc', 'docx', 'odt', 'ods', 'txt'].includes(ext)) return 'prose';
    if (ext === 'md') return 'markdown';
    if (['pptx', 'odp'].includes(ext)) return 'slides';
    if (['js', 'ts', 'tsx', 'css', 'html'].includes(ext)) return 'code';
    if (ext === 'csv') return 'csv';
    if (['xls', 'xlsx'].includes(ext)) return 'xlsx';
    if (['json', 'yaml', 'yml', 'xml'].includes(ext)) return 'filename';
    return null;
}

// ── 私有：文本规范化 ──────────────────────────────────────────────────

/** 统一换行符为 \n（兼容 Windows \r\n 和旧 Mac \r） */
function normalize(text) {
    return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

// ── 私有：句子级切分 ──────────────────────────────────────────────────

/**
 * 按句子/段落边界切分为细粒度片段
 * @param {string} normalizedText - 已规范化的文本
 * @param {object} [options]
 * @param {number} [options.chunkSize=1000]
 * @param {number} [options.maxSegmentSize]
 * @returns {{ text: string }[]}
 */
function splitSentences(normalizedText, options = {}) {
    if (normalizedText.trim() === '') return [];
    const segments = [];
    const chunkSize = typeof options.chunkSize === 'number' && options.chunkSize > 0 ? options.chunkSize : 1000;
    const maxSegmentSize =
        typeof options.maxSegmentSize === 'number' && options.maxSegmentSize > 0
            ? options.maxSegmentSize
            : Math.max(chunkSize * 2, chunkSize + 1000);

    // 中文句末标点直接切（消耗标点，捕获组 $1 拼回前一个 segment）；英文句末标点要求后跟空白
    const splitRegex = /([。！？])(?=[^。！？])|(?<=[.!?])\s+|\n\n+/g;
    let lastIdx = 0;
    let match;
    while ((match = splitRegex.exec(normalizedText)) !== null) {
        const endPos = match[1] ? match.index + match[1].length : match.index;
        const raw = normalizedText.slice(lastIdx, endPos);
        const trimmed = raw.trim();
        if (trimmed.length > 0) {
            segments.push({ text: trimmed });
        }
        lastIdx = match.index + match[0].length;
    }
    const tail = normalizedText.slice(lastIdx).trim();
    if (tail.length > 0) {
        segments.push({ text: tail });
    }
    return segments.flatMap((segment) => splitOversizedSegment(segment.text, maxSegmentSize).map((text) => ({ text })));
}

function splitOversizedSegment(text, maxSegmentSize) {
    if (text.length <= maxSegmentSize) return [text];

    let pieces = [text];
    const splitters = [
        (value) => value.split(/\n+/),
        (value) => value.split(/(?<=[，,；;、:：])/),
        (value) => value.split(/[ \t]+/)
    ];

    for (const splitter of splitters) {
        pieces = pieces.flatMap((piece) => {
            if (piece.length <= maxSegmentSize) return [piece];
            const split = splitter(piece)
                .map((part) => part.trim())
                .filter((part) => part.length > 0);
            return split.length > 1 ? split : [piece];
        });
    }

    return pieces.flatMap((piece) => {
        if (piece.length <= maxSegmentSize) return [piece];
        const hardSplit = [];
        for (let i = 0; i < piece.length; i += maxSegmentSize) {
            const part = piece.slice(i, i + maxSegmentSize).trim();
            if (part.length > 0) hardSplit.push(part);
        }
        return hardSplit;
    });
}

// ── 私有：segmentText ─────────────────────────────────────────────────

/**
 * 将文本切分为细粒度 segments，仅处理 prose / markdown / slides
 *
 * prose   → 句子/段落级，无 heading
 * markdown → 按 H1-H6 分节，节内句子/段落级，每个 segment 携带 heading metadata
 *            heading-only 节产出 { text: headingLine, heading: headingLine }（heading 同时作为 text 和 metadata）
 * slides  → 按 slide 分隔符切分，每张 slide 分配 sectionId（L3 硬断点，L4 软断点）
 *            超长 slide 按句子/段落二次拆分，子段共享 sectionId
 *
 * @param {string} text - 原始文本
 * @param {'prose'|'markdown'|'slides'} format
 * @param {object} [options]
 * @param {number} [options.maxSlideChunkSize=2000] - slides 格式：单张 slide 超过此值时再做 prose 切分
 * @returns {{ text: string, heading?: string, sectionId?: number }[]}
 */
function segmentText(text, format, options = {}) {
    const normalized = normalize(text);
    if (normalized.trim() === '') return [];

    if (format === 'prose') {
        return splitSentences(normalized, options);
    }

    if (format === 'markdown') {
        // 用 regex 按 heading 边界拆分（lookahead），不再 prepend '\n'
        // 直接在 normalized 上匹配行首 heading，避免 prepend 导致 lines[0] 为空
        const boundaries = [0];
        const bRegex = /(?:^|\n\n)(?=#{1,6} )/g;
        let bm;
        while ((bm = bRegex.exec(normalized)) !== null) {
            // 如果匹配到 \n\n 前缀，实际边界在 \n\n 之后
            const pos = normalized[bm.index] === '\n' ? bm.index + 2 : bm.index;
            if (pos > 0 && !boundaries.includes(pos)) {
                boundaries.push(pos);
            }
            // 零长度匹配时必须手动推进 lastIndex，否则 exec 会无限循环
            if (bm[0].length === 0) {
                bRegex.lastIndex = bm.index + 1;
            }
        }
        boundaries.push(normalized.length);

        const result = [];
        let sectionId = 0;
        for (let bi = 0; bi < boundaries.length - 1; bi++) {
            const section = normalized.slice(boundaries[bi], boundaries[bi + 1]);
            if (!section.trim()) continue;

            const lines = section.split('\n');
            const headingLine = lines[0].trim().startsWith('#') ? lines[0].trim() : '';
            const body = headingLine ? lines.slice(1).join('\n') : section;

            // 每个 heading 边界产生新 sectionId，即使 heading 文本相同
            // 这确保两个 "## Overview" 不会被当作同一 section
            const curSectionId = sectionId++;

            const subSegs = splitSentences(body, options);

            if (subSegs.length === 0) {
                // heading-only 节：heading 即内容，同时设 heading metadata 以便 L4 识别硬断点
                if (headingLine) {
                    result.push({ text: headingLine, heading: headingLine, sectionId: curSectionId });
                }
            } else {
                for (const sub of subSegs) {
                    result.push(
                        headingLine
                            ? { text: sub.text, heading: headingLine, sectionId: curSectionId }
                            : { text: sub.text, sectionId: curSectionId }
                    );
                }
            }
        }
        return result;
    }

    if (format === 'slides') {
        const maxSlideChunkSize =
            typeof options.maxSlideChunkSize === 'number' && options.maxSlideChunkSize > 0
                ? options.maxSlideChunkSize
                : 2000;

        const SEP = '\n\n===\n\n';
        const slides = normalized
            .split(SEP)
            .map((s) => s.trim())
            .filter((s) => s.length > 0);

        const result = [];
        let sectionId = 0;
        for (const slide of slides) {
            const curSectionId = sectionId++;
            if (slide.length <= maxSlideChunkSize) {
                result.push({ text: slide, sectionId: curSectionId });
            } else {
                // 超长 slide 按句子/段落边界二次拆分，同一 slide 的子段共享 sectionId
                const subSegs = splitSentences(slide, options);
                if (subSegs.length === 0) {
                    result.push({ text: slide, sectionId: curSectionId });
                } else {
                    for (const sub of subSegs) {
                        result.push({ text: sub.text, sectionId: curSectionId });
                    }
                }
            }
        }
        return result;
    }

    return [];
}

// ── 私有：findOverlapTail ────────────────────────────────────────────

/**
 * 从 text 尾部取 overlap 区域，向前搜索最近的分隔符，
 * 从该分隔符之后截取到末尾。实际 overlap 长度 ≥ 设定值，保证不切断句子。
 *
 * 搜索范围：searchFrom 向前最多 overlap*0.5，避免 overlap 过大。
 * 分隔符（同级取最近）：
 *   - 段落边界（\n\n）
 *   - 中文句末标点（。！？）— 直接切，与 splitSentences 一致
 *   - 英文句末标点（.!?）后跟空白 — 与 splitSentences 一致
 * 兜底：空格（英文），固定字符（中文）。
 *
 * @param {string} text
 * @param {number} overlap
 * @returns {string}
 */
function findOverlapTail(text, overlap) {
    if (text.length <= overlap) return text;

    const searchFrom = text.length - overlap;
    const searchLimit = Math.floor(overlap * 0.5);
    const searchStart = Math.max(0, searchFrom - searchLimit);
    const region = text.slice(searchStart, searchFrom + 1);

    // 在 region 内找所有分隔符，取最近的（index 最大的）
    const candidates = [];

    // 段落边界
    const paraIdx = region.lastIndexOf('\n\n');
    if (paraIdx !== -1) candidates.push(searchStart + paraIdx + 2);

    // 中文句末标点（直接切）
    const cnMatch = region.match(/.*[。！？]/s);
    if (cnMatch) candidates.push(searchStart + cnMatch[0].length);

    // 英文句末标点后跟空白
    const enMatch = region.match(/.*[.!?]\s+/s);
    if (enMatch) candidates.push(searchStart + enMatch[0].length);

    if (candidates.length > 0) {
        return text.slice(Math.max(...candidates));
    }

    // 兜底：空格（英文场景）
    const spaceIdx = region.lastIndexOf(' ');
    if (spaceIdx !== -1) return text.slice(searchStart + spaceIdx + 1);

    // 最终 fallback：固定字符切分
    return text.slice(searchFrom);
}

// ── 私有：mergeBySize ─────────────────────────────────────────────────

/**
 * 将细粒度 segments 贪心合并为不超过 chunkSize 的 chunk 列表
 * - section 变化时强制切断（不跨节合并），通过 sectionId 判断而非 heading 文本
 * - section 变化时不携带 overlap（不跨节重叠）
 * - 合并后将 heading 一次性拼入 chunk.text 开头
 *
 * @param {{ text: string, heading?: string, sectionId?: number }[]} segments
 * @param {{ chunkSize?: number, overlap?: number }} options
 * @returns {{ id: string, text: string }[]}
 */
function mergeBySize(segments, options = {}) {
    if (segments.length === 0) return [];

    const chunkSize = typeof options.chunkSize === 'number' && options.chunkSize > 0 ? options.chunkSize : 1000;
    const overlap =
        typeof options.overlap === 'number' && options.overlap >= 0 && options.overlap < chunkSize
            ? options.overlap
            : 200;

    const chunks = [];
    let curText = '';
    let curHeading = undefined;
    let curSectionId = 0;

    function flush() {
        if (!curText) return;
        // 与 mergeBySemantics 一致：不在此处拼入 heading，推迟到最终输出
        chunks.push({ _text: curText, _heading: curHeading });
    }

    for (const seg of segments) {
        const segSection = seg.sectionId ?? 0;
        // sectionId 变化 → 强制切断，不携带 overlap
        // 使用 sectionId 而非 heading 文本，确保同名 heading 的不同节不会合并
        if (curText && segSection !== curSectionId) {
            flush();
            curText = '';
        }

        if (!curText) {
            curText = seg.text;
            curHeading = seg.heading;
            curSectionId = segSection;
        } else if (curText.length + seg.text.length + 2 <= chunkSize) {
            curText += '\n\n' + seg.text;
        } else {
            flush();
            const tail = overlap > 0 ? findOverlapTail(curText, overlap) : '';
            curText = tail ? tail + '\n\n' + seg.text : seg.text;
            // sectionId 不变（同一节内的大小切断）
        }
    }
    flush();

    // heading 前缀统一在最终输出时拼入（与 mergeBySemantics 对称）
    return chunks.map((c, i) => {
        const text = c._heading && c._text !== c._heading ? c._heading + '\n\n' + c._text : c._text;
        return { id: `chunk${i}`, text };
    });
}

// ── 私有：splitCode ───────────────────────────────────────────────────

/**
 * code 格式专用：按 chunkTokens 固定大小切分
 * @param {string} text
 * @param {object} options
 * @returns {{ id: string, text: string }[]}
 */
function splitCode(text, options = {}) {
    const normalized = normalize(text);
    if (normalized.trim() === '') return [];

    const chunkTokens = typeof options.chunkTokens === 'number' && options.chunkTokens > 0 ? options.chunkTokens : 512;
    const tokenOverlap =
        typeof options.tokenOverlap === 'number' && options.tokenOverlap >= 0 && options.tokenOverlap < chunkTokens
            ? options.tokenOverlap
            : 50;

    const chunkChars = chunkTokens * 4;
    const overlapChars = tokenOverlap * 4;
    const result = [];
    let start = 0;

    while (start < normalized.length) {
        const end = Math.min(start + chunkChars, normalized.length);
        const chunk = normalized.slice(start, end);
        if (chunk.trim()) {
            result.push({ id: `chunk${result.length}`, text: chunk });
        }
        if (end >= normalized.length) break;
        start = end - overlapChars;
    }

    return result;
}

function truncateTableCell(value, maxChars = TABLE_ABSTRACT_MAX_CELL_CHARS) {
    const text = String(value ?? '').trim();
    if (text.length <= maxChars) return text;
    return text.slice(0, Math.max(0, maxChars - 1)) + '…';
}

function capTableColumns(values, maxColumns = TABLE_ABSTRACT_MAX_COLUMNS) {
    const capped = values.slice(0, maxColumns).map((value) => truncateTableCell(value));
    if (values.length > maxColumns) {
        capped.push(`... 另 ${values.length - maxColumns} 列`);
    }
    return capped;
}

function truncateTableAbstract(text, maxChars = TABLE_ABSTRACT_MAX_CHARS) {
    if (text.length <= maxChars) return text;
    const contentMax = Math.max(0, maxChars - TABLE_ABSTRACT_TRUNCATED_MARKER.length);
    return text.slice(0, contentMax).trimEnd() + TABLE_ABSTRACT_TRUNCATED_MARKER;
}

// ── 私有：summarizeCsv ───────────────────────────────────────────────

/**
 * csv 格式专用：生成单个摘要 chunk
 * @param {string} text - CSV 原始文本（readFile utf-8）
 * @param {object} options
 * @returns {{ id: string, text: string }[]}
 */
function summarizeCsv(text, options = {}) {
    const normalized = normalize(text);
    const maxAbstractLines =
        typeof options.maxAbstractLines === 'number' && options.maxAbstractLines > 0 ? options.maxAbstractLines : 10;

    const lines = normalized.split('\n').filter((l) => l.trim());
    if (lines.length === 0) return [];

    const headers = capTableColumns(lines[0].split(','));
    const dataLines = lines.slice(1, maxAbstractLines + 1).map((l) => capTableColumns(l.split(',')).join(' | '));

    const parts = [`列名: [${headers.join(', ')}]`];
    if (dataLines.length > 0) {
        parts.push('样本:');
        parts.push(...dataLines);
    }

    return [{ id: 'chunk0', text: truncateTableAbstract(parts.join('\n')) }];
}

// ── 私有：summarizeXlsx ──────────────────────────────────────────────

/**
 * xlsx 格式专用：生成单个摘要 chunk
 * @param {string} text - \t 列分隔、\n 行分隔的扁平文本（来自 extractText）
 * @param {object} options
 * @returns {{ id: string, text: string }[]}
 */
function summarizeXlsx(text, options = {}) {
    const normalized = normalize(text);
    const maxAbstractLines =
        typeof options.maxAbstractLines === 'number' && options.maxAbstractLines > 0 ? options.maxAbstractLines : 10;

    const lines = normalized.split('\n').filter((l) => l.trim());
    if (lines.length === 0) return [];

    const sections = [];
    let currentSection = { title: '', lines: [] };
    for (const line of lines) {
        const sheetMatch = line.match(/^\[([^\]]+)\]$/);
        if (sheetMatch) {
            if (currentSection.lines.length > 0) {
                sections.push(currentSection);
            }
            currentSection = { title: sheetMatch[1], lines: [] };
            continue;
        }
        currentSection.lines.push(line);
    }
    if (currentSection.lines.length > 0) {
        sections.push(currentSection);
    }

    const parts = [];
    for (const section of sections) {
        if (section.lines.length === 0) continue;
        if (section.title) {
            parts.push(`工作表: ${section.title}`);
        }
        const rawHeaders = section.lines[0].split('\t');
        if (/^\d+$/.test(rawHeaders[0] ?? '')) {
            rawHeaders[0] = '行号';
        }
        const headers = capTableColumns(rawHeaders);
        const dataLines = section.lines
            .slice(1, maxAbstractLines + 1)
            .map((l) => capTableColumns(l.split('\t')).join(' | '));
        parts.push(`列名: [${headers.join(', ')}]`);
        if (dataLines.length > 0) {
            parts.push('样本:');
            parts.push(...dataLines);
        }
    }

    return [{ id: 'chunk0', text: truncateTableAbstract(parts.join('\n')) }];
}

// ── 私有：数学工具 ────────────────────────────────────────────────────

function cosineSimilarity(a, b) {
    let dot = 0,
        normA = 0,
        normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
}

function percentile(arr, p) {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = (p / 100) * (sorted.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// ── 公开：chunkBasic（L2）─────────────────────────────────────────────

/**
 * L2：格式无关，段落级朴素切分（基于 llm-chunk 库，splitter: 'paragraph' 模式）
 * text=null 时返回 chunks: null，表示"无可分块文本"
 *
 * @param {string|null} text
 * @param {{ chunkSize?: number, overlap?: number }} options
 * @returns {{ chunk_type: 'chunk', chunks: Array<{id: string, text: string}> | null }}
 */
export function chunkBasic(text, options = {}) {
    if (text === null) {
        return { chunk_type: 'chunk', chunks: null };
    }

    const chunkSize = typeof options.chunkSize === 'number' && options.chunkSize > 0 ? options.chunkSize : 1000;
    let overlap = typeof options.overlap === 'number' && options.overlap >= 0 ? options.overlap : 200;
    if (overlap >= chunkSize) {
        overlap = Math.floor(chunkSize / 5);
    }

    const normalized = normalize(text);
    if (normalized.trim() === '') return { chunk_type: 'chunk', chunks: [] };

    const rawChunks = llmChunk(normalized, {
        maxLength: chunkSize,
        overlap,
        splitter: 'paragraph',
        minLength: 0
    });

    const chunks = [];
    for (const raw of rawChunks) {
        const trimmed = raw.trim();
        if (trimmed !== '') {
            chunks.push({ id: `chunk${chunks.length}`, text: trimmed });
        }
    }
    return { chunk_type: 'chunk', chunks };
}

// ── 公开：chunkStructured（L3）────────────────────────────────────────

/**
 * L3：结构感知切分
 * text=null 且格式受支持 → { chunk_type, chunks: null }
 * 格式不支持 → { chunk_type: null, chunks: null }
 *
 * @param {string|null} text
 * @param {string} filePath
 * @param {object} options
 * @returns {{ chunk_type: 'chunk'|'abstract'|'filename'|null, chunks: Array<{id: string, text: string}> | null }}
 */
export function chunkStructured(text, filePath, options = {}) {
    const format = resolveFormat(filePath);

    if (format === null) {
        return { chunk_type: null, chunks: null };
    }

    // filename 完全不依赖 text，即使 text=null 也返回 basename chunk
    if (format === 'filename') {
        return {
            chunk_type: 'filename',
            chunks: [{ id: 'chunk0', text: path.basename(filePath) }]
        };
    }

    if (text === null) {
        const chunkType = ['csv', 'xlsx'].includes(format) ? 'abstract' : 'chunk';
        return { chunk_type: chunkType, chunks: null };
    }

    switch (format) {
        case 'code':
            return { chunk_type: 'chunk', chunks: splitCode(text, options) };
        case 'csv':
            return { chunk_type: 'abstract', chunks: summarizeCsv(text, options) };
        case 'xlsx':
            return { chunk_type: 'abstract', chunks: summarizeXlsx(text, options) };
        case 'prose':
        case 'markdown':
        case 'slides': {
            const segments = segmentText(text, format, options);
            return { chunk_type: 'chunk', chunks: mergeBySize(segments, options) };
        }
        default:
            return { chunk_type: null, chunks: null };
    }
}

// ── 公开：chunkSemantic（L4）─────────────────────────────────────────

// ── 私有：mergeBySemantics ────────────────────────────────────────────

/**
 * 语义感知合并：基于 embedding 相似度断点 + heading 硬断点
 *
 * - heading 边界为硬断点，不参与相似度打分，不跨节合并
 * - bufferSize 上下文窗口在 heading 边界处截断
 * - 合并后将 heading 前缀一次性拼入 chunk.text 开头
 *
 * @param {{ text: string, heading?: string, sectionId?: number }[]} segments
 * @param {(texts: string[]) => Promise<number[][]>} embedFn
 * @param {object} options
 * @returns {Promise<{ id: string, text: string }[]>}
 */
async function mergeBySemantics(segments, embedFn, options = {}) {
    const chunkSize = typeof options.chunkSize === 'number' && options.chunkSize > 0 ? options.chunkSize : 1000;
    const overlap =
        typeof options.overlap === 'number' && options.overlap >= 0 && options.overlap < chunkSize
            ? options.overlap
            : 200;
    const bufferSize = typeof options.bufferSize === 'number' && options.bufferSize >= 0 ? options.bufferSize : 1;
    const bpPercentile = typeof options.breakpointPercentile === 'number' ? options.breakpointPercentile : 95;
    const minChunkSize =
        typeof options.minChunkSize === 'number' && options.minChunkSize > 0 ? options.minChunkSize : 100;

    const N = segments.length;

    // Step 1: 为每个 segment 标记 section 编号（仅硬断点）
    // 硬断点条件：sectionId 变化 且 至少一侧携带 heading metadata
    //   markdown heading 边界 → 硬断点（一侧或两侧有 heading）
    //   slides 边界 → 非硬断点（两侧均无 heading）→ 合为同一 section，允许跨 slide 合并
    //   prose → 无 sectionId → 全部同属一个 section
    const sectionOf = new Array(N);
    let curSection = 0;
    sectionOf[0] = 0;
    for (let i = 1; i < N; i++) {
        const prevSid = segments[i - 1].sectionId ?? 0;
        const curSid = segments[i].sectionId ?? 0;
        const sectionChanged = curSid !== prevSid;
        const isHard = sectionChanged && (segments[i].heading !== undefined || segments[i - 1].heading !== undefined);
        if (isHard) curSection++;
        sectionOf[i] = curSection;
    }

    // Step 2: 构建上下文窗口，截断在 section 边界
    const groups = segments.map((seg, i) => {
        let lo = Math.max(0, i - bufferSize);
        let hi = Math.min(N - 1, i + bufferSize);
        // 向左截断到同 section
        while (lo < i && sectionOf[lo] !== sectionOf[i]) lo++;
        // 向右截断到同 section
        while (hi > i && sectionOf[hi] !== sectionOf[i]) hi--;
        return segments
            .slice(lo, hi + 1)
            .map((s) => s.text)
            .join(' ');
    });

    // Step 3: 批量 embedding
    const embeddings = await embedFn(groups);

    // Step 4: 相邻余弦距离；跨 section 使用 Infinity 强制断点
    const distances = [];
    for (let i = 0; i < N - 1; i++) {
        distances.push(
            sectionOf[i] !== sectionOf[i + 1] ? Infinity : 1 - cosineSimilarity(embeddings[i], embeddings[i + 1])
        );
    }

    // Step 5: 百分位断点检测（仅使用有限距离值）
    const finiteDists = distances.filter((d) => isFinite(d));
    const threshold = percentile(finiteDists, bpPercentile);
    const breakpoints = new Set();
    for (let i = 0; i < distances.length; i++) {
        if (distances[i] > threshold || !isFinite(distances[i])) {
            breakpoints.add(i + 1);
        }
    }

    // Step 6: 合并 segments 为 chunks
    const rawChunks = [];
    let curText = '';
    let curHeading = undefined;
    let curSectionId = undefined;
    let hasContent = false;

    function flush() {
        if (!hasContent) return;
        // 不在此处拼入 heading——推迟到 Step 7 合并完成后统一拼入，
        // 避免 minChunkSize 合并导致同 section 内 heading 重复
        rawChunks.push({ text: curText, _sectionId: curSectionId, _heading: curHeading });
    }

    for (let i = 0; i < N; i++) {
        const seg = segments[i];
        const wouldBe = hasContent ? curText.length + 2 + seg.text.length : seg.text.length;
        // 使用 sectionId 判断 section 变化，而非 heading 文本
        const isSectionChange = hasContent && sectionOf[i] !== curSectionId;

        if (hasContent && (breakpoints.has(i) || isSectionChange || wouldBe > chunkSize)) {
            flush();
            // section 变化不携带 overlap，语义断点/大小切断正常携带
            const tail = !isSectionChange && overlap > 0 ? findOverlapTail(curText, overlap) : '';
            curText = tail ? tail + '\n\n' + seg.text : seg.text;
            curHeading = seg.heading;
            curSectionId = sectionOf[i];
            hasContent = true;
        } else {
            if (!hasContent) {
                curHeading = seg.heading;
                curSectionId = sectionOf[i];
            }
            curText = hasContent ? curText + '\n\n' + seg.text : seg.text;
            hasContent = true;
        }
    }
    flush();

    // Step 7: minChunkSize 合并（过短 chunk 并入相邻 chunk，不超过 chunkSize）
    // 重要：section 边界是硬断点，不同 sectionId 的 chunk 不得合并
    const merged = [];
    for (let i = 0; i < rawChunks.length; i++) {
        if (rawChunks[i].text.length < minChunkSize) {
            const sameSectionBack =
                merged.length > 0 && merged[merged.length - 1]._sectionId === rawChunks[i]._sectionId;
            const sameSectionFwd = i + 1 < rawChunks.length && rawChunks[i + 1]._sectionId === rawChunks[i]._sectionId;

            const canBack =
                sameSectionBack && merged[merged.length - 1].text.length + 2 + rawChunks[i].text.length <= chunkSize;
            const canFwd = sameSectionFwd && rawChunks[i].text.length + 2 + rawChunks[i + 1].text.length <= chunkSize;

            if (canBack) {
                merged[merged.length - 1].text += '\n\n' + rawChunks[i].text;
            } else if (canFwd) {
                rawChunks[i + 1].text = rawChunks[i].text + '\n\n' + rawChunks[i + 1].text;
            } else {
                merged.push(rawChunks[i]);
            }
        } else {
            merged.push(rawChunks[i]);
        }
    }

    // heading 前缀在 Step 7 合并完成后统一拼入，确保每个最终 chunk 只出现一次
    return merged.map((c, i) => {
        const text = c._heading && c.text !== c._heading ? c._heading + '\n\n' + c.text : c.text;
        return { id: `chunk${i}`, text };
    });
}

/**
 * L4：语义感知切分
 * embedFn 可选：不传时 fallback 到内部 LLM.batchEmbed；LLM 不可用时抛出异常
 *
 * @param {string|null} text
 * @param {string} filePath
 * @param {object} options
 * @param {((texts: string[]) => Promise<number[][]>)} [embedFn]
 * @returns {Promise<{ chunk_type: 'chunk'|'abstract'|'filename'|null, chunks: Array<{id: string, text: string}> | null }>}
 */
export async function chunkSemantic(text, filePath, options = {}, embedFn) {
    const format = resolveFormat(filePath);

    if (format === null) {
        return { chunk_type: null, chunks: null };
    }

    if (text === null) {
        // csv/xlsx/filename fallback 到 chunkStructured（后者正确处理 null text）
        if (['csv', 'xlsx', 'filename'].includes(format)) {
            return chunkStructured(null, filePath, options);
        }
        // prose/markdown/slides/code：格式受支持但无文本
        return { chunk_type: 'chunk', chunks: null };
    }

    // code/csv/xlsx/filename 不使用 embedding，直接 fallback 到 chunkStructured
    if (['code', 'csv', 'xlsx', 'filename'].includes(format)) {
        return chunkStructured(text, filePath, options);
    }

    // prose / markdown / slides → 语义合并
    const segments = segmentText(text, format, options);

    // 片段数 < 3：语义断点无意义，fallback 到 mergeBySize
    if (segments.length < 3) {
        return { chunk_type: 'chunk', chunks: mergeBySize(segments, options) };
    }

    const actualEmbedFn = embedFn || (await getBatchEmbedFn());
    const chunks = await mergeBySemantics(segments, actualEmbedFn, options);
    return { chunk_type: 'chunk', chunks };
}
