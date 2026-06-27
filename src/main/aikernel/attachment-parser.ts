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

const SPREADSHEET_ATTACHMENT_EXTENSIONS = new Set(['xls', 'xlsx', 'csv']);

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
    const ext = path.extname(filePath).slice(1).toLowerCase();
    if (ext === 'doc') {
        return extractLegacyWordText(filePath);
    }
    if (SPREADSHEET_ATTACHMENT_EXTENSIONS.has(ext)) {
        return extractSpreadsheetText(filePath);
    }
    return officeParser.parseOfficeAsync(filePath);
}
