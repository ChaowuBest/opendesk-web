import assert from 'node:assert/strict';
import { on } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import * as XLSX from 'xlsx';

test(
    'real worker uses each extraction locale without changing its global locale',
    { timeout: 15000 },
    async (context) => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-worker-locale-'));
        const filePath = path.join(directory, 'sample.xlsx');
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, { A1: { t: 'n', v: 1234.5, z: '#,##0.00' }, '!ref': 'A1' }, 'Sheet1');
        XLSX.writeFile(workbook, filePath);

        const localeEntry = new URL('../../../../locale/index.ts', import.meta.url).href;
        const fileWorkerEntry = new URL('../../../../main/applications/filemgr/worker.js', import.meta.url).href;
        const worker = new Worker(
            `
        const { parentPort } = require('node:worker_threads');
        (async () => {
            const { register } = await import('tsx/esm/api');
            register();
            const { getLocale, setRuntimeLocale } = await import(${JSON.stringify(localeEntry)});
            const { default: FileManagerWorker } = await import(${JSON.stringify(fileWorkerEntry)});
            setRuntimeLocale('tr-TR');
            const fileWorker = Object.create(FileManagerWorker.prototype);
            parentPort.on('message', async (message) => {
                const text = await fileWorker.extractFileText(message.filePath, message.options);
                parentPort.postMessage({ locale: getLocale(), text });
            });
            parentPort.postMessage('ready');
        })().catch(error => { throw error; });
        `,
            { eval: true }
        );
        const nextMessage = async () => {
            for await (const frame of on(worker, 'message', { signal: context.signal })) {
                if (frame[0]?.type !== 'log') return frame;
            }
            throw new Error('worker message stream ended');
        };
        try {
            await nextMessage();
            for (const [locale, expected] of [
                ['en-US', '1\t1,234.50'],
                ['tr-TR', '1\t1.234,50'],
                [undefined, '1\t1,234.50']
            ]) {
                const snapshot = nextMessage();
                worker.postMessage({ filePath, options: locale === undefined ? undefined : { locale } });
                const [result] = await snapshot;
                assert.deepEqual(result, { locale: 'tr-TR', text: expected });
            }
        } finally {
            await worker.terminate();
            fs.rmSync(directory, { recursive: true, force: true });
        }
    }
);
