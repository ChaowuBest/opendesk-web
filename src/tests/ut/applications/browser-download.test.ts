import path from 'node:path';
import {
    appendAutomatedDownloadsToToolResult,
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
});
