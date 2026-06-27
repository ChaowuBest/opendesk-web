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

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as XLSX from 'xlsx';
import {
    findUnsupportedAttachmentFiles,
    getAttachmentFileSupport,
    isAttachmentFilePathSupported,
    isAttachmentFileExtensionSupported
} from '../../../../main/aikernel/attachment-support.js';
import { parseAttachmentFile } from '../../../../main/aikernel/attachment-parser.js';

const require = createRequire(import.meta.url);
const officeParser = require('officeparser') as {
    parseOfficeAsync(filePath: string, config?: { outputErrorToConsole?: boolean }): Promise<string>;
};

const unsupportedErrorPattern = /OfficeParser.*currently support .* files only/i;
const extraAttachmentParserExtensions = ['doc', 'xls'];
const unsupportedProbeExtensions = ['ppt', 'rtf', 'csv', 'md', 'html'];

async function readOfficeParserExtensionSwitch(): Promise<string[]> {
    const officeParserSource = await readFile(require.resolve('officeparser'), 'utf8');
    const switchMatch = officeParserSource.match(/switch\s*\(\s*ext\s*\)\s*{([\s\S]*?)default\s*:/);
    assert.ok(switchMatch, 'officeparser extension switch should be discoverable');
    return [...switchMatch[1].matchAll(/case\s+["']([^"']+)["']\s*:/g)].map((match) => match[1]);
}

async function parseFakeFileWithExtension(tmpDir: string, extension: string): Promise<string> {
    const filePath = path.join(tmpDir, `fake.${extension}`);
    await writeFile(filePath, 'not a real office file');
    const originalWarn = console.warn;
    console.warn = () => undefined;
    try {
        await officeParser.parseOfficeAsync(filePath, { outputErrorToConsole: false });
        return '';
    } catch (err) {
        return err instanceof Error ? err.message : String(err);
    } finally {
        console.warn = originalWarn;
    }
}

test('agent attachment support covers officeparser plus legacy doc and xls adapters', async () => {
    const officeParserSupportedExtensions = await readOfficeParserExtensionSwitch();
    const support = getAttachmentFileSupport();
    assert.deepEqual(support.supportedExtensions, ['doc', 'docx', 'xls', 'xlsx', 'pptx', 'odt', 'odp', 'ods', 'pdf']);
    for (const extension of officeParserSupportedExtensions) {
        assert.ok(support.supportedExtensions.includes(extension), `.${extension} should remain supported`);
    }
    for (const extension of extraAttachmentParserExtensions) {
        assert.ok(support.supportedExtensions.includes(extension), `.${extension} should be supported by an adapter`);
    }
    assert.deepEqual(
        support.knownUnsupportedExtensions.filter((extension) => support.supportedExtensions.includes(extension)),
        []
    );

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'opendesk-officeparser-support-'));
    try {
        for (const extension of support.supportedExtensions) {
            assert.equal(isAttachmentFileExtensionSupported(extension), true);
        }

        for (const extension of officeParserSupportedExtensions) {
            const message = await parseFakeFileWithExtension(tmpDir, extension);
            assert.doesNotMatch(message, unsupportedErrorPattern, `.${extension} should enter an officeparser parser`);
        }

        for (const extension of unsupportedProbeExtensions) {
            if (officeParserSupportedExtensions.includes(extension)) {
                continue;
            }
            assert.equal(isAttachmentFileExtensionSupported(extension), false);
            const message = await parseFakeFileWithExtension(tmpDir, extension);
            assert.match(message, unsupportedErrorPattern, `.${extension} should be rejected by officeparser`);
        }

        assert.equal(isAttachmentFilePathSupported('/tmp/report.DOC'), true);
        assert.equal(isAttachmentFilePathSupported('/tmp/report.DOCX'), true);
        assert.equal(isAttachmentFilePathSupported('/tmp/sheet.XLS'), true);
        assert.deepEqual(findUnsupportedAttachmentFiles(['/tmp/deck.ppt']), [
            { filePath: '/tmp/deck.ppt', extension: 'ppt' }
        ]);
    } finally {
        await rm(tmpDir, { recursive: true, force: true });
    }
});

test('agent attachment parser extracts xls and xlsx as tab-separated text', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'opendesk-attachment-spreadsheet-'));
    try {
        for (const extension of ['xls', 'xlsx']) {
            const filePath = path.join(tmpDir, `sheet.${extension}`);
            const workbook = XLSX.utils.book_new();
            const sheet = XLSX.utils.aoa_to_sheet([
                ['name', 'status'],
                ['OpenDesk', extension]
            ]);
            XLSX.utils.book_append_sheet(workbook, sheet, 'Data');
            XLSX.writeFile(workbook, filePath, { bookType: extension as XLSX.BookType });

            const text = await parseAttachmentFile(filePath);
            assert.equal(text, `1\tname\tstatus\n2\tOpenDesk\t${extension}`);
        }
    } finally {
        await rm(tmpDir, { recursive: true, force: true });
    }
});

test('agent attachment parser routes doc to word-extractor instead of officeparser', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'opendesk-attachment-doc-'));
    try {
        const filePath = path.join(tmpDir, 'legacy.doc');
        await writeFile(filePath, 'not a real word document');
        await assert.rejects(
            () => parseAttachmentFile(filePath),
            (err) => {
                const message = err instanceof Error ? err.message : String(err);
                assert.doesNotMatch(message, unsupportedErrorPattern);
                assert.match(message, /Unable to read this type of file|Not a valid compound document/i);
                return true;
            }
        );
    } finally {
        await rm(tmpDir, { recursive: true, force: true });
    }
});
