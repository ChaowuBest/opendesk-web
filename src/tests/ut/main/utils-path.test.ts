import { describe, expect, test } from '@jest/globals';
import { getHomeDir } from '../../../main/utils/temp.js';
import { sanitizeLocalPath } from '../../../main/utils/path.js';

describe('sanitizeLocalPath', () => {
    test('returns empty string for empty or non-string input', () => {
        expect(sanitizeLocalPath('')).toBe('');
        expect(sanitizeLocalPath(undefined)).toBe('');
    });

    test('resolves relative paths against basePath', () => {
        expect(sanitizeLocalPath('src/a.ts', '/home/dev/proj')).toBe('/home/dev/proj/src/a.ts');
        expect(sanitizeLocalPath('../up.txt', '/home/dev/proj/sub')).toBe('/home/dev/proj/up.txt');
    });

    test('keeps absolute paths as-is', () => {
        expect(sanitizeLocalPath('/abs/a.txt', '/home/dev/proj')).toBe('/abs/a.txt');
    });

    test('expands ~ to the user home directory', () => {
        expect(sanitizeLocalPath('~/notes.txt')).toBe(`${getHomeDir()}/notes.txt`.replace(/\\/g, '/'));
        expect(sanitizeLocalPath('~')).toBe(getHomeDir().replace(/\\/g, '/'));
    });

    test('normalizes backslashes and collapses duplicate slashes', () => {
        expect(sanitizeLocalPath('dir//sub///file.txt', '/base')).toBe('/base/dir/sub/file.txt');
        expect(sanitizeLocalPath('dir\\sub\\file.txt', '/base')).toBe('/base/dir/sub/file.txt');
    });

    test('repairs control characters polluted by JSON escapes instead of keeping raw tabs', () => {
        const result = sanitizeLocalPath('/base/te\tst.txt');
        expect(result).not.toContain('\t');
        expect(result).toBe('/base/te/tst.txt');
    });
});
