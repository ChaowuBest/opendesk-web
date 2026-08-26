import fs from 'fs';
import os from 'os';
import path from 'path';
import { jest } from '@jest/globals';
import { SkillRegistry } from '../../../../../../main/aikernel/skill.js';
import {
    RecordHarmonyosFallbackTool,
    upsertHarmonyosFallback
} from '../../../../../../main/aikernel/harnesses/platform/harmonyos/skill-fallback-tools.js';

const validArgs = {
    bundleName: 'demo',
    skillName: 'demo-skill',
    category: 'binaries' as const,
    dependencyName: 'ffmpeg',
    note: 'Linux VM execution succeeded'
};

function taskWithLoadedSkills(skills = [{ bundleName: 'demo', skillName: 'demo-skill', turn: 1 }]) {
    return { getLoadedSkillsFromContext: jest.fn(() => skills) } as any;
}

describe('recordHarmonyosFallback tool', () => {
    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    test('has a strict path-free schema and serial execution', () => {
        const tool = new RecordHarmonyosFallbackTool('openharmony');

        expect(tool.serialExecution).toBe(true);
        expect(tool.validateArgs(validArgs).success).toBe(true);
        expect(tool.validateArgs({ ...validArgs, fallback: 'linux_vm' }).success).toBe(false);
        expect(tool.validateArgs({ ...validArgs, path: '/tmp/meta.json' }).success).toBe(false);
    });

    test('rejects non-OpenHarmony before registry lookup', async () => {
        const registry = jest.spyOn(SkillRegistry.getInstance(), 'getSkill');
        const result = await new RecordHarmonyosFallbackTool('linux').execute(
            validArgs,
            undefined,
            taskWithLoadedSkills()
        );

        expect(result.status).toBe('error');
        expect(result.result).toContain('仅允许在 OpenHarmony');
        expect(registry).not.toHaveBeenCalled();
    });

    test('requires the exact bundle and skill in current LoadSkill history', async () => {
        const registry = jest.spyOn(SkillRegistry.getInstance(), 'getSkill');
        const result = await new RecordHarmonyosFallbackTool('openharmony').execute(
            validArgs,
            undefined,
            taskWithLoadedSkills([{ bundleName: 'other', skillName: 'demo-skill', turn: 1 }])
        );

        expect(result.status).toBe('error');
        expect(result.result).toContain('未在当前任务中通过 LoadSkill 加载');
        expect(registry).not.toHaveBeenCalled();
    });

    test('resolves directory through AI SkillRegistry and deterministically upserts while preserving fields', async () => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-07-24T09:10:11.000Z'));
        const skillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fallback-record-tool-'));
        const metaPath = path.join(skillDir, 'opendesk_meta.json');
        fs.writeFileSync(
            metaPath,
            JSON.stringify({
                marker: 'keep',
                dependencies: {
                    binaries: [{ name: 'ffmpeg', version: '7', custom: { keep: true }, note: 'old' }]
                },
                testCases: [{ index: 1 }]
            }),
            'utf8'
        );
        const registry = jest
            .spyOn(SkillRegistry.getInstance(), 'getSkill')
            .mockResolvedValue({ directory: skillDir } as any);

        try {
            const result = await new RecordHarmonyosFallbackTool('openharmony').execute(
                validArgs,
                undefined,
                taskWithLoadedSkills()
            );
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));

            expect(result.status).toBe('success');
            expect(registry).toHaveBeenCalledWith('demo', 'demo-skill');
            expect(meta.marker).toBe('keep');
            expect(meta.testCases).toEqual([{ index: 1 }]);
            expect(meta.dependencies.binaries).toEqual([
                {
                    name: 'ffmpeg',
                    version: '7',
                    custom: { keep: true },
                    note: validArgs.note,
                    fallback: 'linux_vm',
                    recordedAt: '2026-07-24T09:10:11.000Z'
                }
            ]);
        } finally {
            fs.rmSync(skillDir, { recursive: true, force: true });
        }
    });

    test('adds a new dependency to an existing non-empty category', () => {
        const meta = {
            dependencies: {
                binaries: [{ name: 'curl', version: '8' }]
            }
        };

        const changed = upsertHarmonyosFallback(
            meta,
            'binaries',
            'ffmpeg',
            'Linux VM succeeded',
            '2026-07-24T00:00:00.000Z'
        );

        expect(changed).toBe(true);
        expect(meta.dependencies.binaries).toEqual([
            { name: 'curl', version: '8' },
            {
                name: 'ffmpeg',
                fallback: 'linux_vm',
                note: 'Linux VM succeeded',
                recordedAt: '2026-07-24T00:00:00.000Z'
            }
        ]);
    });

    test('keeps an existing Linux VM fallback unchanged when it is recorded again', () => {
        const existing = {
            name: 'ffmpeg',
            fallback: 'linux_vm',
            note: 'original evidence',
            recordedAt: '2026-07-01T00:00:00.000Z'
        };
        const meta = { dependencies: { binaries: [existing] } };

        const changed = upsertHarmonyosFallback(meta, 'binaries', 'ffmpeg', 'new evidence', '2026-07-24T00:00:00.000Z');

        expect(changed).toBe(false);
        expect(meta.dependencies.binaries).toEqual([existing]);
    });

    test('rejects comma-separated dependencyName in schema validation', () => {
        const tool = new RecordHarmonyosFallbackTool('openharmony');
        expect(tool.validateArgs({ ...validArgs, dependencyName: 'a, b' }).success).toBe(false);
        expect(tool.validateArgs({ ...validArgs, dependencyName: 'curl,wget' }).success).toBe(false);
    });

    test('rejects comma-separated dependencyName in upsertHarmonyosFallback', () => {
        expect(() => upsertHarmonyosFallback({}, 'binaries', 'a, b', 'note', '2026-07-24T00:00:00.000Z')).toThrow(
            '逗号'
        );
        expect(() =>
            upsertHarmonyosFallback({}, 'npmPackages', 'curl,wget', 'note', '2026-07-24T00:00:00.000Z')
        ).toThrow('逗号');
    });

    test('fails closed for duplicate names and damaged dependency structures', () => {
        const duplicate = {
            dependencies: { binaries: [{ name: 'ffmpeg' }, { name: 'ffmpeg' }] },
            marker: 'keep'
        };
        const damaged = { dependencies: { binaries: { name: 'ffmpeg' } }, marker: 'keep' };
        const duplicateBefore = structuredClone(duplicate);
        const damagedBefore = structuredClone(damaged);

        expect(() =>
            upsertHarmonyosFallback(duplicate, 'binaries', 'ffmpeg', 'note', '2026-07-24T00:00:00.000Z')
        ).toThrow('多条同名依赖');
        expect(() =>
            upsertHarmonyosFallback(damaged as any, 'binaries', 'ffmpeg', 'note', '2026-07-24T00:00:00.000Z')
        ).toThrow('结构损坏');
        expect(duplicate).toEqual(duplicateBefore);
        expect(damaged).toEqual(damagedBefore);
    });
});
