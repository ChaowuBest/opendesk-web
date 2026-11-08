import { describe, expect, test } from '@jest/globals';
import { normalizeTrashExcludeDirs } from '../../../main/applications/terminal/sandboxes/trash-exclude.js';

describe('normalizeTrashExcludeDirs 排除清单归一化', () => {
    test('保留绝对路径条目（POSIX 与 Win32 形态都接受）', () => {
        expect(
            normalizeTrashExcludeDirs([
                '/tmp',
                '/data/storage/el2',
                'C:/Users/x/AppData/Local/Temp',
                'C:\\Windows\\Temp'
            ])
        ).toEqual(['/tmp', '/data/storage/el2', 'C:/Users/x/AppData/Local/Temp', 'C:\\Windows\\Temp']);
    });

    test('丢弃相对路径与空条目（dynobox 遇到非绝对路径会拒绝启动）', () => {
        expect(normalizeTrashExcludeDirs(['tmp', './tmp', '../tmp', '', '   ', '/tmp'])).toEqual(['/tmp']);
    });

    test('去除首尾空白并按键值去重', () => {
        expect(normalizeTrashExcludeDirs(['  /tmp  ', '/tmp', '/var/tmp'])).toEqual(['/tmp', '/var/tmp']);
    });

    test('缺省与空清单返回空数组', () => {
        expect(normalizeTrashExcludeDirs()).toEqual([]);
        expect(normalizeTrashExcludeDirs([])).toEqual([]);
    });
});
