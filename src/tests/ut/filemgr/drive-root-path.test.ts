import { describe, expect, test } from '@jest/globals';
import { resolveDriveRootPath } from '../../../main/applications/filemgr/utils.js';

describe('FileMgr drive-root path view', () => {
    test('recognizes exactly drive roots, preserves case and is idempotent', () => {
        for (const input of ['D:', 'D:/', 'D:\\', 'd:', 'd:/', 'd:\\']) {
            const result = `${input.slice(0, 2)}/`;
            expect(resolveDriveRootPath(input, 'win32')).toBe(result);
            expect(resolveDriveRootPath(result, 'win32')).toBe(result);
        }
    });
    test('preserves ordinary, malformed, UNC, device and non-Windows values', () => {
        const values = [
            'D:/docs',
            'D:\\docs',
            'D:relative',
            'D://',
            'D:/../docs',
            'relative',
            '',
            '/',
            '{DRIVE_ROOT}',
            '\\\\server\\share',
            '\\\\?\\D:\\',
            '/tmp/a\\b',
            null,
            undefined
        ];
        for (const value of values) expect(resolveDriveRootPath(value, 'win32')).toBe(value);
        for (const platform of ['darwin', 'linux', 'openharmony', '']) {
            for (const value of [...values, 'D:', 'D:/', 'D:\\']) {
                expect(resolveDriveRootPath(value, platform)).toBe(value);
            }
        }
    });
});
