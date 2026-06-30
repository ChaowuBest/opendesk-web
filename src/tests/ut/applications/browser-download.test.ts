import { jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    appendAutomatedDownloadsToToolResult,
    BrowserApplication,
    makeUniqueDownloadPath,
    normalizeSaveDialogSyncPath,
    resolveAutomatedDownloadDirectory,
    sanitizeDownloadFilename
} from '../../../main/applications/browser/app.js';

describe('browser download save dialog result', () => {
    test('treats cancelled sync save dialog as no save path', () => {
        expect(normalizeSaveDialogSyncPath(undefined)).toBeNull();
    });

    test('keeps selected sync save dialog path', () => {
        expect(normalizeSaveDialogSyncPath('/tmp/report.pdf')).toBe('/tmp/report.pdf');
    });

    test('sanitizes unsafe filenames for automated downloads', () => {
        expect(sanitizeDownloadFilename('../unsafe:name?.txt')).toBe('unsafe_name_.txt');
        expect(sanitizeDownloadFilename('')).toBe('download');
    });

    test('deduplicates automated download paths', () => {
        const existing = new Set([
            path.join('/tmp/downloads', 'report.pdf'),
            path.join('/tmp/downloads', 'report (1).pdf')
        ]);

        expect(makeUniqueDownloadPath('/tmp/downloads', 'report.pdf', (filePath) => existing.has(filePath))).toBe(
            path.join('/tmp/downloads', 'report (2).pdf')
        );
    });

    test('uses workspace Downloads directory for automated downloads', () => {
        expect(resolveAutomatedDownloadDirectory('/tmp/workspace')).toBe(path.join('/tmp/workspace', 'Downloads'));
    });

    test('adds automated download save paths to browser tool results', () => {
        const result = appendAutomatedDownloadsToToolResult(JSON.stringify({ success: true, clicked: true }), [
            {
                id: 'dl_1',
                url: 'https://example.com/report.pdf',
                filename: 'report (1).pdf',
                savePath: path.join('/tmp/workspace', 'Downloads', 'report (1).pdf'),
                receivedBytes: 10,
                totalBytes: 10,
                state: 'completed',
                startTime: 1,
                endTime: 2
            }
        ]);

        expect(JSON.parse(result)).toMatchObject({
            success: true,
            clicked: true,
            downloads: [
                {
                    filename: 'report (1).pdf',
                    savePath: path.join('/tmp/workspace', 'Downloads', 'report (1).pdf')
                }
            ]
        });
    });

    test('reports delayed automated downloads on the next browser tool result', async () => {
        const app = new BrowserApplication() as any;
        jest.spyOn(app, '_rememberTaskActiveWebContents').mockResolvedValue(undefined);
        const download = {
            id: 'dl_delayed',
            url: 'https://example.com/slow-report.pdf',
            filename: 'slow-report.pdf',
            savePath: path.join('/tmp/workspace', 'Downloads', 'slow-report.pdf'),
            receivedBytes: 0,
            totalBytes: 0,
            state: 'progressing',
            startTime: 1
        };

        app._queuePendingAutomatedDownload('task-1', download);

        const result = await app.runWithAutomatedDownloadScope('task-1', '/tmp/workspace', async () =>
            JSON.stringify({ success: true, waited: true })
        );

        expect(JSON.parse(result)).toMatchObject({
            success: true,
            waited: true,
            downloads: [
                {
                    filename: 'slow-report.pdf',
                    savePath: path.join('/tmp/workspace', 'Downloads', 'slow-report.pdf')
                }
            ]
        });
    });

    test('auto-saves late downloads for remembered task webContents without prompting', async () => {
        const app = new BrowserApplication() as any;
        jest.spyOn(app, '_rememberTaskActiveWebContents').mockResolvedValue(undefined);
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-download-'));
        const promptSpy = jest.spyOn(app, '_promptDownloadSavePath');
        let savePath: string | null = null;
        const item = {
            getFilename: jest.fn(() => 'slow-report.pdf'),
            getURL: jest.fn(() => 'https://example.com/slow-report.pdf'),
            getTotalBytes: jest.fn(() => 0),
            getReceivedBytes: jest.fn(() => 0),
            setSavePath: jest.fn((value: string) => {
                savePath = value;
            }),
            on: jest.fn(),
            once: jest.fn(),
            cancel: jest.fn()
        };

        try {
            app._rememberAutomatedDownloadWebContents(123, 'task-1', path.join(workspace, 'Downloads'), null, 60_000);

            app.handleDownload(item as any, { id: 123 } as any);
            const result = await app.runWithAutomatedDownloadScope('task-1', workspace, async () =>
                JSON.stringify({ success: true })
            );

            expect(promptSpy).not.toHaveBeenCalled();
            expect(item.cancel).not.toHaveBeenCalled();
            expect(item.setSavePath).toHaveBeenCalledWith(path.join(workspace, 'Downloads', 'slow-report.pdf'));
            expect(JSON.parse(result)).toMatchObject({
                success: true,
                downloads: [
                    {
                        filename: 'slow-report.pdf',
                        savePath
                    }
                ]
            });
        } finally {
            app._forgetAutomatedDownloadWebContents(123);
            fs.rmSync(workspace, { recursive: true, force: true });
        }
    });
});
