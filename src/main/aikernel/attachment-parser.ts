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
        if (ext === 'doc') {
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
