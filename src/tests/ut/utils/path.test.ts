import os from 'os';
import path from 'path';
import { expandTilde, fromMsysPath, getHomePath, toMsysPath } from '../../../utils/path.js';

describe('expandTilde', () => {
    const fakeHome = path.join(os.tmpdir(), 'opendesk-expand-tilde-home');
    let savedUserProfile: string | undefined;
    let savedHome: string | undefined;

    beforeEach(() => {
        savedUserProfile = process.env.USERPROFILE;
        savedHome = process.env.HOME;
        // getHomePath 在 Windows 上优先读 USERPROFILE，其余平台读 HOME
        process.env.USERPROFILE = fakeHome;
        process.env.HOME = fakeHome;
    });

    afterEach(() => {
        if (savedUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = savedUserProfile;
        if (savedHome === undefined) delete process.env.HOME;
        else process.env.HOME = savedHome;
    });

    test('expands leading ~ to the home directory', () => {
        expect(expandTilde('~')).toBe(fakeHome);
        // 调用方随后都会经 path.resolve 归一化分隔符，这里同样归一化后比较
        expect(path.normalize(expandTilde('~/slow_task.json'))).toBe(
            path.normalize(path.join(fakeHome, 'slow_task.json'))
        );
        expect(path.normalize(expandTilde('~/sub/dir/x.html'))).toBe(
            path.normalize(path.join(fakeHome, 'sub/dir/x.html'))
        );
        expect(getHomePath()).toBe(fakeHome);
    });

    test('expands ~\\ prefix on Windows-style input', () => {
        expect(expandTilde('~\\slow_task.json')).toBe(fakeHome + '\\slow_task.json');
    });

    test('leaves non-tilde and ~user paths unchanged', () => {
        expect(expandTilde('')).toBe('');
        expect(expandTilde('relative/x.json')).toBe('relative/x.json');
        expect(expandTilde('/absolute/x.json')).toBe('/absolute/x.json');
        expect(expandTilde('a~b')).toBe('a~b');
        // ~user 形式无法跨平台解析为其他用户家目录，保持原样
        expect(expandTilde('~otheruser/x.json')).toBe('~otheruser/x.json');
        expect(expandTilde('dir/~/file.json')).toBe('dir/~/file.json');
    });

    test('returns input unchanged when home directory is unavailable', () => {
        delete process.env.USERPROFILE;
        delete process.env.HOME;
        expect(expandTilde('~/slow_task.json')).toBe('~/slow_task.json');
    });
});

describe('toMsysPath / fromMsysPath', () => {
    // afterEach 需要恢复真实平台：process.platform 可能已被用例覆盖，恢复值必须在覆盖前捕获
    const realPlatform = process.platform;

    /** 测试进程可能跑在 Windows 上，用 Object.defineProperty 模拟平台 */
    function setPlatform(platform: string): void {
        Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    }

    afterEach(() => {
        setPlatform(realPlatform);
    });

    test('Windows 路径转 MSYS 形式：盘符、反斜杠与正斜杠混排均处理', () => {
        setPlatform('win32');
        expect(toMsysPath('C:\\Users\\liyif\\AppData')).toBe('/c/Users/liyif/AppData');
        expect(toMsysPath('C:/Users/liyif')).toBe('/c/Users/liyif');
        expect(toMsysPath('d:\\data\\x.tar.gz')).toBe('/d/data/x.tar.gz');
    });

    test('非 Windows 平台原样返回，不做盘符转换', () => {
        setPlatform('linux');
        expect(toMsysPath('C:\\Users\\liyif')).toBe('C:\\Users\\liyif');
        expect(toMsysPath('/data/app/bin/bash')).toBe('/data/app/bin/bash');
    });

    test('非盘符开头的输入保持原样', () => {
        setPlatform('win32');
        expect(toMsysPath('relative/path')).toBe('relative/path');
        expect(toMsysPath('')).toBe('');
        expect(toMsysPath('\\\\server\\share')).toBe('\\\\server\\share');
    });

    test('与 fromMsysPath 往返一致（仅正斜杠结果）', () => {
        setPlatform('win32');
        const windowsPath = 'C:\\Users\\liyif\\AppData';
        const roundTrip = fromMsysPath(toMsysPath(windowsPath));
        expect(roundTrip.toLowerCase()).toBe('c:/users/liyif/appdata');
    });
});
