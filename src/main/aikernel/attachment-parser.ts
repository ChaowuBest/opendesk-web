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

import path from 'path';
import { readFileSync } from 'fs';
import officeParser from 'officeparser';
import WordExtractor from 'word-extractor';
import * as XLSX from 'xlsx';
import { readOfd } from '@sharp9/ofdjs';
import {
    initDOMParser,
    parseXml,
    getChild,
    getTextContent,
    getAllChildren,
    getTagName
} from '@sharp9/ofdjs/xml-parser';
import { logger } from '../utils/logger.js';

const SPREADSHEET_ATTACHMENT_EXTENSIONS = new Set(['xls', 'xlsx', 'csv']);

/**
 * 检测文件内容是否为 RTF 格式。
 * RTF 文件以 `{\\rtf` 开头（不区分大小写）。
 */
function isRtfContent(buffer: Buffer): boolean {
    if (buffer.length < 5) return false;
    const head = buffer.subarray(0, 5);
    // 不区分大小写比对
    return (
        head[0] === 0x7b && // '{'
        head[1] === 0x5c && // '\\'
        (head[2] === 0x72 || head[2] === 0x52) && // 'r' or 'R'
        (head[3] === 0x74 || head[3] === 0x54) && // 't' or 'T'
        (head[4] === 0x66 || head[4] === 0x46) // 'f' or 'F'
    );
}

/**
 * 从 RTF 文本中提取纯文本内容。
 * 处理：
 * - `\\par` / `\\pard` → 换行
 * - `\\tab` → 制表符
 * - `\\{` `\\}` `\\\\` → 转义字符
 * - `\\'xx` → 十六进制字符
 * - `{\\*\\...}` → 忽略目标组
 * - 其他控制字 → 移除
 * - 剩余的 `{` `}` → 移除
 */
function extractRtfPlainText(rtfContent: string): string {
    // 1. 移除目标组 {\\*\\...}（它们通常包含字体表、颜色表等元数据）
    let text = rtfContent;
    // 使用循环处理嵌套的目标组
    let prev = '';
    while (prev !== text) {
        prev = text;
        text = text.replace(/\{\\\*[^}]*\}/g, '');
    }

    // 2. 解码十六进制转义 \\'xx
    text = text.replace(/\\'([0-9a-fA-F]{2})/g, (_match, hex) => {
        const code = parseInt(hex, 16);
        // 只处理可打印 ASCII 和常见 Latin-1 补充字符
        if (code >= 0x20 && code <= 0x7e) {
            return String.fromCharCode(code);
        }
        if (code >= 0xa0 && code <= 0xff) {
            return String.fromCharCode(code);
        }
        return '';
    });

    // 3. 转义字符
    text = text.replace(/\\\{/g, '\x00'); // 临时占位
    text = text.replace(/\\\}/g, '\x01');
    text = text.replace(/\\\\/g, '\x02');

    // 4. 段落标记
    text = text.replace(/\\par\b/g, '\n');
    text = text.replace(/\\pard\b/g, '\n');
    text = text.replace(/\\tab\b/g, '\t');
    text = text.replace(/\\line\b/g, '\n');

    // 5. 移除控制字（\\字母序列，可能后跟空格或数字参数）
    //    注意：这里要在处理 \\'xx 之后，因为 \\'xx 已经被解码
    text = text.replace(/\\[a-zA-Z]+[-\d]*\s?/g, '');

    // 6. 恢复转义字符
    text = text.replace(/\x00/g, '{');
    text = text.replace(/\x01/g, '}');
    text = text.replace(/\x02/g, '\\');

    // 7. 移除剩余的花括号（可能是分组标记）
    text = text.replace(/[{}]/g, '');

    // 8. 清理：合并多个空行为最多两个连续空行
    text = text.replace(/\n{3,}/g, '\n\n');
    // 清理行首尾空白
    text = text
        .split('\n')
        .map((line) => line.trim())
        .join('\n');
    // 去除首尾空行
    text = text.replace(/^\n+/, '').replace(/\n+$/, '');

    return text.trim();
}

/** 确保 DOMParser 已初始化（@sharp9/ofdjs 在 Node.js 中需要） */
let _ofdDompInitialized = false;
async function ensureOfdDomp(): Promise<void> {
    if (!_ofdDompInitialized) {
        await initDOMParser();
        _ofdDompInitialized = true;
    }
}

/**
 * 从 OFD 文件中逐页提取 TextObject 的文本内容。
 * OFD 文件本质是 ZIP + XML，解析后遍历每页的 Layer 元素，
 * 收集所有 TextObject → TextCode 中的文本。
 */
async function extractOfdText(filePath: string): Promise<string> {
    await ensureOfdDomp();
    const buffer = readFileSync(filePath);
    const ofd = await readOfd(new Uint8Array(buffer));

    const docRoot = ofd.node.docBody.docRoot;
    const dir = docRoot.includes('/') ? docRoot.substring(0, docRoot.lastIndexOf('/')) : '';
    const pages = ofd.document.pages.page;
    const pageTexts: string[] = [];

    for (const pageInfo of pages) {
        if (!pageInfo.baseLoc) continue;
        // 构建页面 XML 在 ZIP 中的路径：DocRoot 父目录 + pageBaseLoc
        const pagePath = dir ? `${dir}/${pageInfo.baseLoc}` : pageInfo.baseLoc;
        let pageXml: string;
        try {
            pageXml = await ofd.readFile(pagePath);
        } catch {
            continue;
        }

        const doc = parseXml(pageXml);
        const root = doc.documentElement;

        // 递归收集所有 TextObject 的文本
        const texts: string[] = [];
        function collectTexts(parent: Element): void {
            const children = getAllChildren(parent);
            for (const child of children) {
                const tag = getTagName(child);
                if (tag === 'TextObject') {
                    const textCodeEl = getChild(child, 'TextCode');
                    if (textCodeEl) {
                        const value = getTextContent(textCodeEl);
                        if (value && value.trim()) {
                            texts.push(value.trim());
                        }
                    }
                } else if (tag === 'PageBlock') {
                    collectTexts(child);
                }
            }
        }

        const contentEl = getChild(root, 'Content');
        if (contentEl) {
            const layerEl = getChild(contentEl, 'Layer');
            if (layerEl) {
                collectTexts(layerEl);
            }
        }

        if (texts.length > 0) {
            pageTexts.push(texts.join('\n'));
        }
    }

    return pageTexts.join('\n\n');
}

function sheetToRowNumberedLines(sheet: XLSX.WorkSheet): string[] {
    if (!sheet['!ref']) {
        return [];
    }
    const range = XLSX.utils.decode_range(sheet['!ref']);
    const lines: string[] = [];
    for (let rowIndex = range.s.r; rowIndex <= range.e.r; rowIndex++) {
        const values: string[] = [];
        let hasValue = false;
        for (let columnIndex = range.s.c; columnIndex <= range.e.c; columnIndex++) {
            const cell = sheet[XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })];
            const value = cell ? XLSX.utils.format_cell(cell) : '';
            if (value !== '') {
                hasValue = true;
            }
            values.push(String(value ?? ''));
        }
        if (hasValue) {
            lines.push([String(rowIndex + 1), ...values].join('\t'));
        }
    }
    return lines;
}

export function extractSpreadsheetText(filePath: string): string {
    const workbook = XLSX.read(readFileSync(filePath), { type: 'buffer', cellDates: true });
    const sheets: string[] = [];
    for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        const lines = sheetToRowNumberedLines(sheet);
        if (lines.length === 0) {
            continue;
        }
        const text = lines.join('\n');
        sheets.push(workbook.SheetNames.length > 1 ? `[${sheetName}]\n${text}` : text);
    }
    return sheets.join('\n\n');
}

async function extractLegacyWordText(filePath: string): Promise<string> {
    const extractor = new WordExtractor();
    const document = await extractor.extract(filePath);
    return document.getBody();
}

export async function parseAttachmentFile(filePath: string): Promise<string> {
    try {
        const ext = path.extname(filePath).slice(1).toLowerCase();

        // .rtf 文件直接用 RTF 解析
        if (ext === 'rtf') {
            return extractRtfPlainText(readFileSync(filePath, 'utf-8'));
        }

        // .doc 文件先检测内容是否为 RTF 格式（某些 .doc 文件实际是 RTF）
        if (ext === 'doc') {
            const buffer = readFileSync(filePath);
            if (isRtfContent(buffer)) {
                logger.info(`File "${filePath}" has .doc extension but is actually RTF, using RTF parser`);
                return extractRtfPlainText(buffer.toString('utf-8'));
            }
            return await extractLegacyWordText(filePath);
        }

        if (ext === 'ofd') {
            return await extractOfdText(filePath);
        }
        if (SPREADSHEET_ATTACHMENT_EXTENSIONS.has(ext)) {
            return extractSpreadsheetText(filePath);
        }
        return await officeParser.parseOfficeAsync(filePath);
    } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        logger.error(`Failed to parse attachment file "${filePath}": ${errorMessage}`, err);
        return `[文件解析失败] 无法解析文件 "${path.basename(filePath)}"，错误: ${errorMessage}`;
    }
}
