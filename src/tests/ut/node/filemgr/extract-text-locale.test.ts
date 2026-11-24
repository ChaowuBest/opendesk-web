import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as XLSX from 'xlsx';
import { getLocale, setRuntimeLocale } from '../../../../locale/index.js';
import { FileMgrApplication } from '../../../../main/applications/filemgr/app.js';
import FileManagerWorker from '../../../../main/applications/filemgr/worker.js';
import { ExtractTextTool } from '../../../../main/applications/filemgr/tools.js';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-extract-text-locale-'));
const filePath = path.join(directory, 'sample.xlsx');
const workbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(
    workbook,
    {
        A1: { t: 'n', v: 1234.5, z: '#,##0.00' },
        B1: { t: 'n', v: 46320, z: '[$-0409]d mmmm yyyy' },
        C1: { t: 's', v: '原文 1.234,50' },
        D1: { t: 'n', v: 1234.5, z: '[$-0409]#,##0.00' },
        '!ref': 'A1:D1'
    },
    'Sheet1'
);
XLSX.writeFile(workbook, filePath);

test.beforeEach(() => setRuntimeLocale('en-US'));
test.after(() => {
    setRuntimeLocale(null);
    fs.rmSync(directory, { recursive: true, force: true });
});

test('extractText exposes an optional locale in its model-facing schema', () => {
    const tool = new ExtractTextTool(async () => '');
    const schema = tool.getJsonSchema();
    assert.equal(schema.properties.locale?.type, 'string');
    assert.deepEqual(schema.required, ['file_path']);
});

for (const route of ['worker', 'fallback']) {
    test(`extractText preserves document locale, then call locale, then live application locale via ${route}`, async () => {
        const worker = Object.create(FileManagerWorker.prototype) as FileManagerWorker;
        const app = new FileMgrApplication();
        const requests: Array<{ locale?: string } | undefined> = [];
        app.registry = {
            async callWorker(bundleName: string, method: string, requestedPath: string, options?: { locale?: string }) {
                assert.equal(bundleName, 'filemgr');
                assert.equal(method, 'extractFileText');
                requests.push(options);
                if (route === 'fallback') return { status: 'error', message: 'worker unavailable' };
                return { status: 'ok', data: await worker.extractFileText(requestedPath, options) };
            }
        };
        const [toolset] = await app.getToolsets();
        const tool = toolset.getTool('extractText');
        assert.ok(tool);

        const overridden = await tool.execute({ file_path: filePath, locale: 'tr_TR' });
        assert.equal(overridden.status, 'success');
        assert.ok(
            JSON.parse(String(overridden.result)).file.content.endsWith(
                '1\t1.234,50\t25 October 2026\t原文 1.234,50\t1,234.50'
            )
        );
        assert.deepEqual(requests[0], { locale: 'tr-TR' });
        assert.equal(getLocale(), 'en-US');

        const defaultResult = await tool.execute({ file_path: filePath });
        assert.equal(defaultResult.status, 'success');
        assert.ok(
            JSON.parse(String(defaultResult.result)).file.content.endsWith(
                '1\t1,234.50\t25 October 2026\t原文 1.234,50\t1,234.50'
            )
        );

        setRuntimeLocale('tr-TR');
        const changedDefault = await tool.execute({ file_path: filePath });
        assert.equal(changedDefault.status, 'success');
        assert.ok(
            JSON.parse(String(changedDefault.result)).file.content.endsWith(
                '1\t1.234,50\t25 October 2026\t原文 1.234,50\t1,234.50'
            )
        );
        assert.deepEqual(
            requests.map((options) => options?.locale),
            ['tr-TR', 'en-US', 'tr-TR']
        );
    });
}

test('invalid locale uses shared tool argument validation before extraction', async () => {
    let calls = 0;
    const tool = new ExtractTextTool(async () => {
        calls++;
        return '';
    });
    const args = { file_path: filePath, locale: 'bad locale!' };
    assert.equal(tool.validateArgs(args).success, false);
    const result = await tool.execute(args);
    assert.equal(result.status, 'error');
    assert.match(String(result.result), /locale/);
    assert.equal(calls, 0);
});
