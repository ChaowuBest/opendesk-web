import { afterEach, describe, expect, test } from '@jest/globals';
import { filePathToFileUrl } from '../../../common/file-url.js';
import { UPLOAD_ID_PATTERN, sanitizeUploadName } from '../../../common/web/protocol.js';

describe('web upload naming', () => {
    test('keeps ordinary file names', () => {
        expect(sanitizeUploadName('报告 v2.pdf')).toBe('报告 v2.pdf');
    });

    test('strips path separators and control characters', () => {
        expect(sanitizeUploadName('../etc/passwd')).toBe('.._etc_passwd');
        expect(sanitizeUploadName('a\\b\u0001c.txt')).toBe('a_b_c.txt');
    });

    test('never yields dot-only or empty names', () => {
        expect(sanitizeUploadName('..')).toBe('_');
        expect(sanitizeUploadName('')).toBe('upload');
    });

    test('upload ids accept uuids only in a safe alphabet', () => {
        expect(UPLOAD_ID_PATTERN.test('3f2b8c1e-0d4a-4b7e-9a51-2f6c8d9e0a1b')).toBe(true);
        expect(UPLOAD_ID_PATTERN.test('../../x')).toBe(false);
        expect(UPLOAD_ID_PATTERN.test('short')).toBe(false);
    });
});

describe('filePathToFileUrl in web mode', () => {
    const scope = globalThis as { __OPENDESK_WEB__?: unknown; location?: unknown };
    const original = { web: scope.__OPENDESK_WEB__, location: scope.location };

    afterEach(() => {
        scope.__OPENDESK_WEB__ = original.web;
        Object.defineProperty(globalThis, 'location', { value: original.location, configurable: true, writable: true });
    });

    test('returns file:// URLs on the desktop', () => {
        expect(filePathToFileUrl('/tmp/a b.txt')).toBe('file:///tmp/a%20b.txt');
    });

    test('returns same-origin proxy URLs in the browser', () => {
        scope.__OPENDESK_WEB__ = {};
        Object.defineProperty(globalThis, 'location', {
            value: { origin: 'https://od.example.com' },
            configurable: true,
            writable: true
        });
        expect(filePathToFileUrl('/home/u/a b#1.html')).toBe(
            'https://od.example.com/__opendesk/fs/home/u/a%20b%231.html'
        );
        expect(filePathToFileUrl('C:\\work\\x.png')).toBe('https://od.example.com/__opendesk/fs/C%3A/work/x.png');
    });
});
