import os from 'os';
import path from 'path';
import { expandTilde, getHomePath } from '../../../utils/path.js';

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
