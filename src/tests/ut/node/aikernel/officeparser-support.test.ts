import { after, before, describe, test } from 'node:test';
import assert from 'node:assert';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import officeParser from 'officeparser';
import {
    getAttachmentFileSupport,
    isAttachmentFileExtensionSupported,
    isAttachmentFilePathSupported,
    findUnsupportedAttachmentFiles
} from '../../../../main/aikernel/attachment-support.js';
import { isExtractTextSupported } from '../../../../main/applications/filemgr/parser/extract.js';

const _require = createRequire(import.meta.url);
const unsupportedErrorPattern = /OfficeParser.*currently support .* files only/i;
const extraAttachmentParserExtensions = ['doc', 'xls'];
const unsupportedProbeExtensions = ['ppt', 'md', 'html'];

async function readOfficeParserExtensionSwitch(): Promise<string[]> {
    const officeParserSource = await readFile(_require.resolve('officeparser'), 'utf8');
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
    assert.deepEqual(support.supportedExtensions, [
        'doc',
        'docx',
        'xls',
        'xlsx',
        'csv',
        'pptx',
        'odt',
        'odp',
        'ods',
        'pdf',
        'ofd',
        'rtf'
    ]);
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
            assert.equal(
                isExtractTextSupported(path.join(tmpDir, `supported.${extension}`)),
                true,
                `.${extension} attachments must be readable through extractText`
            );
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
