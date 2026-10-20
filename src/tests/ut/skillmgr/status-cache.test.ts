import { describe, expect, jest, test } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

// status.ts 通过 skill-registry 单例定位 status.json；mock 掉以指向一次性临时目录，
// 避免触碰真实用户数据（test-env 已重定向，这里进一步显式隔离）
let currentSkillsDir = '';
jest.unstable_mockModule('../../../main/applications/skillmgr/utils/skill-registry.js', () => ({
    skillRegistry: {
        getSkillsDirectory: () => currentSkillsDir
    }
}));

async function loadModule() {
    jest.resetModules();
    return await import('../../../main/applications/skillmgr/status.js');
}

function makeTempSkillsDir(): string {
    // 模拟真实布局 <root>/apps/skills/resources，使 status.json 落在 mkdtemp 根内，
    // 与其他用例及系统临时目录完全隔离
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `opendesk-status-cache-${process.pid}-`));
    const skillsDir = path.join(root, 'apps', 'skills', 'resources');
    fs.mkdirSync(skillsDir, { recursive: true });
    return skillsDir;
}

function statusFileOf(skillsDir: string): string {
    return path.join(path.dirname(skillsDir), 'status.json');
}

describe('skillmgr status.json read caching', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('repeated filter evaluations read the status file only once', async () => {
        currentSkillsDir = makeTempSkillsDir();
        fs.writeFileSync(statusFileOf(currentSkillsDir), JSON.stringify({ 'x/a': false }));
        const { getSkillStatus } = await loadModule();
        const readSpy = jest.spyOn(fs, 'readFileSync');

        for (let i = 0; i < 50; i++) {
            expect(getSkillStatus('x/a')).toBe(false);
        }
        expect(readSpy).toHaveBeenCalledTimes(1);
    });

    test('picks up external edits after the file mtime changes', async () => {
        currentSkillsDir = makeTempSkillsDir();
        const statusFile = statusFileOf(currentSkillsDir);
        fs.writeFileSync(statusFile, JSON.stringify({ 'x/a': false }));
        const { getSkillStatus } = await loadModule();

        expect(getSkillStatus('x/a')).toBe(false);

        fs.writeFileSync(statusFile, JSON.stringify({ 'x/a': true }));
        const future = new Date(Date.now() + 60_000);
        fs.utimesSync(statusFile, future, future);

        expect(getSkillStatus('x/a')).toBe(true);
    });

    test('reflects in-process writes immediately without re-reading the file', async () => {
        currentSkillsDir = makeTempSkillsDir();
        const statusFile = statusFileOf(currentSkillsDir);
        fs.writeFileSync(statusFile, JSON.stringify({ 'x/a': false }));
        const { getSkillStatus, setSkillStatus } = await loadModule();

        expect(getSkillStatus('x/a')).toBe(false);
        const readSpy = jest.spyOn(fs, 'readFileSync');

        setSkillStatus('x/a', true);

        expect(getSkillStatus('x/a')).toBe(true);
        expect(readSpy).not.toHaveBeenCalled();
        expect(JSON.parse(fs.readFileSync(statusFile, 'utf8'))).toEqual({ 'x/a': true });
    });

    test('defaults to enabled for a missing file without repeated reads', async () => {
        currentSkillsDir = makeTempSkillsDir();
        const { getSkillStatus } = await loadModule();
        const readSpy = jest.spyOn(fs, 'readFileSync');

        for (let i = 0; i < 50; i++) {
            expect(getSkillStatus('x/a')).toBe(true);
        }
        expect(readSpy).not.toHaveBeenCalled();
    });

    test('treats a corrupted status file as all-enabled', async () => {
        currentSkillsDir = makeTempSkillsDir();
        fs.writeFileSync(statusFileOf(currentSkillsDir), '{ not json');
        const { getSkillStatus } = await loadModule();

        expect(getSkillStatus('x/a')).toBe(true);
    });

    test('re-evaluates the status file path when the skills directory changes', async () => {
        currentSkillsDir = makeTempSkillsDir();
        fs.writeFileSync(statusFileOf(currentSkillsDir), JSON.stringify({ 'x/a': false }));
        const { getSkillStatus } = await loadModule();

        expect(getSkillStatus('x/a')).toBe(false);

        // 运行期切换数据目录（CLI --config-directory / 测试环境均存在此场景）后，
        // 必须读取新目录下的 status.json
        const nextDir = makeTempSkillsDir();
        currentSkillsDir = nextDir;
        fs.writeFileSync(statusFileOf(nextDir), JSON.stringify({ 'x/a': true }));

        expect(getSkillStatus('x/a')).toBe(true);
    });

    test('keeps the cached state consistent when the write fails', async () => {
        currentSkillsDir = makeTempSkillsDir();
        const statusFile = statusFileOf(currentSkillsDir);
        fs.writeFileSync(statusFile, JSON.stringify({ 'x/a': false }));
        const { getSkillStatus, setSkillStatus } = await loadModule();

        expect(getSkillStatus('x/a')).toBe(false);

        const originalWrite = fs.writeFileSync.bind(fs);
        const writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(((
            file: fs.PathOrFileDescriptor,
            ...rest: unknown[]
        ) => {
            if (String(file) === statusFile) throw new Error('simulated disk full');
            return (originalWrite as (...args: unknown[]) => void)(file, ...rest);
        }) as typeof fs.writeFileSync);

        try {
            expect(() => setSkillStatus('x/a', true)).toThrow('simulated disk full');
        } finally {
            writeSpy.mockRestore();
        }

        // 写失败后读取必须回到盘上真值，不得返回被污染的内存态
        expect(getSkillStatus('x/a')).toBe(false);
    });

    test('getAllStatuses returns an independent snapshot', async () => {
        currentSkillsDir = makeTempSkillsDir();
        fs.writeFileSync(statusFileOf(currentSkillsDir), JSON.stringify({ 'x/a': false }));
        const { getAllStatuses, getSkillStatus } = await loadModule();

        const snapshot = getAllStatuses();
        snapshot['x/a'] = true;

        expect(getSkillStatus('x/a')).toBe(false);
    });
});
