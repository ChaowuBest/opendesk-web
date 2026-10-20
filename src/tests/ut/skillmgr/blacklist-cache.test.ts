import { describe, expect, jest, test } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

// blacklist.ts 通过 skill-registry 单例定位 blacklist.json；mock 掉以指向一次性临时目录
let currentSkillsDir = '';
jest.unstable_mockModule('../../../main/applications/skillmgr/utils/skill-registry.js', () => ({
    skillRegistry: {
        getSkillsDirectory: () => currentSkillsDir
    }
}));

async function loadModule() {
    jest.resetModules();
    return await import('../../../main/applications/skillmgr/blacklist.js');
}

function makeTempSkillsDir(): string {
    // 模拟真实布局 <root>/apps/skills/resources，使 blacklist.json 落在 mkdtemp 根内，
    // 与其他用例及系统临时目录完全隔离
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `opendesk-blacklist-cache-${process.pid}-`));
    const skillsDir = path.join(root, 'apps', 'skills', 'resources');
    fs.mkdirSync(skillsDir, { recursive: true });
    return skillsDir;
}

function blacklistFileOf(skillsDir: string): string {
    return path.join(path.dirname(skillsDir), 'blacklist.json');
}

describe('skillmgr blacklist.json read caching', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('repeated filter evaluations read the blacklist file only once', async () => {
        currentSkillsDir = makeTempSkillsDir();
        fs.writeFileSync(
            blacklistFileOf(currentSkillsDir),
            JSON.stringify({ 'skillmgr/skill-a': { reason: 'r', blockedAt: 't', evidence: 'e' } })
        );
        const { isBlacklisted } = await loadModule();
        const readSpy = jest.spyOn(fs, 'readFileSync');

        for (let i = 0; i < 50; i++) {
            expect(isBlacklisted('skillmgr', 'skill-a')).toBe(true);
            expect(isBlacklisted('skillmgr', 'skill-b')).toBe(false);
        }
        expect(readSpy).toHaveBeenCalledTimes(1);
    });

    test('picks up external edits after the file mtime changes', async () => {
        currentSkillsDir = makeTempSkillsDir();
        const blacklistFile = blacklistFileOf(currentSkillsDir);
        fs.writeFileSync(blacklistFile, JSON.stringify({}));
        const { isBlacklisted } = await loadModule();

        expect(isBlacklisted('skillmgr', 'skill-a')).toBe(false);

        fs.writeFileSync(
            blacklistFile,
            JSON.stringify({ 'skillmgr/skill-a': { reason: 'r', blockedAt: 't', evidence: 'e' } })
        );
        const future = new Date(Date.now() + 60_000);
        fs.utimesSync(blacklistFile, future, future);

        expect(isBlacklisted('skillmgr', 'skill-a')).toBe(true);
    });

    test('blacklist writes take effect immediately without re-reading the file', async () => {
        currentSkillsDir = makeTempSkillsDir();
        fs.mkdirSync(path.join(currentSkillsDir, 'skill-a'));
        const { isBlacklisted, addToBlacklist, removeFromBlacklist } = await loadModule();
        const readSpy = jest.spyOn(fs, 'readFileSync');

        expect(isBlacklisted('skillmgr', 'skill-a')).toBe(false);

        addToBlacklist('skillmgr', 'skill-a', 'reason', 'evidence');
        expect(isBlacklisted('skillmgr', 'skill-a')).toBe(true);

        removeFromBlacklist('skillmgr', 'skill-a');
        expect(isBlacklisted('skillmgr', 'skill-a')).toBe(false);
        expect(readSpy).not.toHaveBeenCalled();
    });

    test('returns false for a missing file without repeated reads', async () => {
        currentSkillsDir = makeTempSkillsDir();
        const { isBlacklisted } = await loadModule();
        const readSpy = jest.spyOn(fs, 'readFileSync');

        for (let i = 0; i < 50; i++) {
            expect(isBlacklisted('skillmgr', 'skill-a')).toBe(false);
        }
        expect(readSpy).not.toHaveBeenCalled();
    });

    test('re-evaluates the blacklist file path when the skills directory changes', async () => {
        currentSkillsDir = makeTempSkillsDir();
        fs.writeFileSync(
            blacklistFileOf(currentSkillsDir),
            JSON.stringify({ 'skillmgr/skill-a': { reason: 'r', blockedAt: 't', evidence: 'e' } })
        );
        const { isBlacklisted } = await loadModule();

        expect(isBlacklisted('skillmgr', 'skill-a')).toBe(true);

        // 运行期切换数据目录后，必须读取新目录下的 blacklist.json
        const nextDir = makeTempSkillsDir();
        currentSkillsDir = nextDir;
        fs.writeFileSync(blacklistFileOf(nextDir), JSON.stringify({}));

        expect(isBlacklisted('skillmgr', 'skill-a')).toBe(false);
    });

    test('keeps the cached state consistent when the write fails', async () => {
        currentSkillsDir = makeTempSkillsDir();
        fs.mkdirSync(path.join(currentSkillsDir, 'skill-a'));
        const blacklistFile = blacklistFileOf(currentSkillsDir);
        fs.writeFileSync(blacklistFile, JSON.stringify({}));
        const { isBlacklisted, addToBlacklist } = await loadModule();

        expect(isBlacklisted('skillmgr', 'skill-a')).toBe(false);

        const originalWrite = fs.writeFileSync.bind(fs);
        const writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(((
            file: fs.PathOrFileDescriptor,
            ...rest: unknown[]
        ) => {
            if (String(file) === blacklistFile) throw new Error('simulated disk full');
            return (originalWrite as (...args: unknown[]) => void)(file, ...rest);
        }) as typeof fs.writeFileSync);

        try {
            expect(() => addToBlacklist('skillmgr', 'skill-a', 'reason', 'evidence')).toThrow('simulated disk full');
        } finally {
            writeSpy.mockRestore();
        }

        // 写失败后读取必须回到盘上真值，不得返回被污染的内存态
        expect(isBlacklisted('skillmgr', 'skill-a')).toBe(false);
    });

    test('getAllBlacklisted returns an independent snapshot', async () => {
        currentSkillsDir = makeTempSkillsDir();
        fs.writeFileSync(
            blacklistFileOf(currentSkillsDir),
            JSON.stringify({ 'skillmgr/skill-a': { reason: 'r', blockedAt: 't', evidence: 'e' } })
        );
        const { getAllBlacklisted, isBlacklisted } = await loadModule();

        const snapshot = getAllBlacklisted();
        delete snapshot['skillmgr/skill-a'];

        expect(isBlacklisted('skillmgr', 'skill-a')).toBe(true);
    });
});
