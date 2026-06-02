import { jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    allRegistries,
    installSkillFromRegistryByName,
    searchSkillsFromAllRegistries,
    SkillRegistry
} from '../../../main/applications/skillmgr/utils';
import type {
    RegistrySkill,
    SearchOptions,
    SearchResult,
    SkillRegistryBase
} from '../../../main/applications/skillmgr/registry';
import { Setting } from '../../../main/utils/setting';

function createRegistry(
    id: string,
    skills: RegistrySkill[],
    options: { label?: string; throws?: boolean } = {}
): SkillRegistryBase & { search: jest.Mock<Promise<SearchResult>, [SearchOptions?]> } {
    const registry = {
        id,
        label: options.label ?? id,
        icon: '',
        iconClass: id,
        get slogan() {
            return '';
        },
        get installPrefix() {
            return `${id}:`;
        },
        matchesInstallUrl(url: string) {
            return typeof url === 'string' && url.startsWith(`${id}:`);
        },
        parseInstallUrl(installUrl: string) {
            if (!this.matchesInstallUrl(installUrl)) return null;
            return { slug: installUrl.slice(`${id}:`.length) };
        },
        search: jest.fn(async (_opts?: SearchOptions) => {
            if (options.throws) throw new Error(`${id} failed`);
            return { skills, total: skills.length, hasMore: false };
        })
    };
    return registry as SkillRegistryBase & { search: jest.Mock<Promise<SearchResult>, [SearchOptions?]> };
}

describe('skillmgr registry tools helpers', () => {
    const originalRegistries = [...allRegistries];
    let tempDirs: string[] = [];

    afterEach(() => {
        SkillRegistry.clearRuntimeConfig();
        allRegistries.splice(0, allRegistries.length, ...originalRegistries);
        for (const tempDir of tempDirs) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
        tempDirs = [];
        jest.restoreAllMocks();
        jest.clearAllMocks();
    });

    test('reads configured external skill directories from external_paths', () => {
        jest.spyOn(Setting, 'getInstance').mockReturnValue({
            getApplicationConfig: jest.fn(() => ({
                external_paths: ['extra-skills', 'extra-skills', ''],
                skills: {
                    paths: ['legacy-skills']
                }
            }))
        } as unknown as Setting);

        expect(SkillRegistry.getConfiguredSkillDirectories()).toEqual([path.resolve('extra-skills')]);
    });

    test('recursively loads root and nested skills from configured external paths', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-external-skill-'));
        tempDirs.push(tempDir);
        const suffix = path.basename(tempDir).slice(-6).toLowerCase();
        const rootName = `root-skill-${suffix}`;
        const deepName = `deep-skill-${suffix}`;

        fs.writeFileSync(
            path.join(tempDir, 'SKILL.md'),
            [
                '---',
                `name: ${rootName}`,
                'description: Root external skill',
                '---',
                '',
                '# Root Skill',
                ''
            ].join('\n'),
            'utf8'
        );

        const skillDir = path.join(tempDir, 'group', 'nested', 'deep-skill');
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(
            path.join(skillDir, 'SKILL.md'),
            [
                '---',
                `name: ${deepName}`,
                'description: Deep external skill',
                '---',
                '',
                '# Deep Skill',
                ''
            ].join('\n'),
            'utf8'
        );

        jest.spyOn(Setting, 'getInstance').mockReturnValue({
            getApplicationConfig: jest.fn(() => ({
                external_paths: [tempDir]
            }))
        } as unknown as Setting);

        SkillRegistry.refresh();

        expect(SkillRegistry.listSkills()).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: rootName,
                    name: rootName,
                    description: 'Root external skill',
                    source: 'config',
                    skillDir: tempDir
                }),
                expect.objectContaining({
                    id: deepName,
                    name: deepName,
                    description: 'Deep external skill',
                    source: 'config',
                    skillDir
                })
            ])
        );
        expect(SkillRegistry.getSkillBody(rootName)?.skillDir).toBe(tempDir);
        expect(SkillRegistry.getSkillBody(deepName)?.skillDir).toBe(skillDir);
    });

    test('loads external skills from runtime config override used by the worker', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-worker-external-skill-'));
        tempDirs.push(tempDir);
        const skillName = `worker-external-skill-${path.basename(tempDir).slice(-6).toLowerCase()}`;

        fs.writeFileSync(
            path.join(tempDir, 'SKILL.md'),
            [
                '---',
                `name: ${skillName}`,
                'description: Worker external skill',
                '---',
                '',
                '# Worker External Skill',
                ''
            ].join('\n'),
            'utf8'
        );

        jest.spyOn(Setting, 'getInstance').mockReturnValue({
            getApplicationConfig: jest.fn(() => ({
                external_paths: []
            }))
        } as unknown as Setting);

        SkillRegistry.setRuntimeConfig({
            external_paths: [tempDir]
        });
        SkillRegistry.refresh();

        expect(SkillRegistry.listSkills()).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: skillName,
                    name: skillName,
                    source: 'config',
                    skillDir: tempDir
                })
            ])
        );
    });

    test('deduplicates overlapping configured skill directories while scanning', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-external-skill-'));
        tempDirs.push(tempDir);
        const suffix = path.basename(tempDir).slice(-6).toLowerCase();
        const skillName = `dedupe-skill-${suffix}`;
        const skillDir = path.join(tempDir, 'group', 'dedupe-skill');
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(
            path.join(skillDir, 'SKILL.md'),
            [
                '---',
                `name: ${skillName}`,
                'description: Dedupe external skill',
                '---',
                '',
                '# Dedupe Skill',
                ''
            ].join('\n'),
            'utf8'
        );

        jest.spyOn(Setting, 'getInstance').mockReturnValue({
            getApplicationConfig: jest.fn(() => ({
                external_paths: [tempDir, skillDir]
            }))
        } as unknown as Setting);

        const { errors } = SkillRegistry.refresh();
        const matches = SkillRegistry.listSkills().filter((skill) => skill.id === skillName);

        expect(errors.filter((error) => error.id === skillDir)).toHaveLength(0);
        expect(matches).toHaveLength(1);
        expect(matches[0]).toEqual(
            expect.objectContaining({
                id: skillName,
                source: 'config',
                skillDir
            })
        );
    });

    test('searches all registries and returns GUI card install metadata', async () => {
        const matrix = createRegistry('matrix', [
            {
                id: 'demo-skill',
                name: 'Demo Skill',
                description: 'demo description',
                author: 'tester',
                source: 'matrix',
                installUrl: 'matrix:demo-skill',
                downloads: 42,
                stars: 7,
                canInstall: true
            }
        ]);
        const skillsmp = createRegistry('skillsmp', [
            {
                id: 'mp-skill',
                name: 'MP Skill',
                description: '',
                source: 'skillsmp',
                installUrl: 'https://example.com/mp.zip',
                downloads: 3,
                canInstall: true
            }
        ]);
        const broken = createRegistry('broken', [], { throws: true });
        allRegistries.splice(0, allRegistries.length, matrix, skillsmp, broken);

        const result = await searchSkillsFromAllRegistries('skill', {
            limit: 5,
            skillsmpApiKey: 'secret'
        });

        expect(result.results).toEqual([
            expect.objectContaining({
                fullName: 'matrix/Demo Skill',
                skillName: 'Demo Skill',
                skillId: 'demo-skill',
                registryName: 'matrix',
                installCount: 42,
                installUrl: 'matrix:demo-skill'
            }),
            expect.objectContaining({
                fullName: 'skillsmp/MP Skill',
                registryName: 'skillsmp',
                installCount: 3,
                installUrl: 'https://example.com/mp.zip'
            })
        ]);
        expect(result.errors).toEqual([{ registryName: 'broken', error: 'broken failed' }]);
        expect(skillsmp.search).toHaveBeenCalledWith(
            expect.objectContaining({
                query: 'skill',
                page: 1,
                limit: 5,
                apiKey: 'secret'
            })
        );
    });

    test('installs an exact fullName match through the same installUrl path used by GUI cards', async () => {
        const matrix = createRegistry('matrix', [
            {
                id: 'demo-skill',
                name: 'Demo Skill',
                description: '',
                source: 'matrix',
                installUrl: 'matrix:demo-skill',
                downloads: 5,
                canInstall: true
            }
        ]);
        allRegistries.splice(0, allRegistries.length, matrix);
        const install = jest.fn(async () => ({ success: true, name: 'demo-skill' }));

        const result = await installSkillFromRegistryByName('matrix', 'matrix/Demo Skill', {
            install,
            skillExists: () => false
        });

        expect(result).toEqual(
            expect.objectContaining({
                success: true,
                name: 'demo-skill',
                registryName: 'matrix',
                matchedSkill: 'Demo Skill'
            })
        );
        expect(install).toHaveBeenCalledWith('matrix:demo-skill', false);
    });

    test('requires force before overwriting an installed registry skill', async () => {
        const matrix = createRegistry('matrix', [
            {
                id: 'demo-skill',
                name: 'Demo Skill',
                description: '',
                source: 'matrix',
                installUrl: 'matrix:demo-skill',
                downloads: 5,
                canInstall: true
            }
        ]);
        allRegistries.splice(0, allRegistries.length, matrix);
        const install = jest.fn(async () => ({ success: true, name: 'demo-skill' }));

        const blocked = await installSkillFromRegistryByName('matrix', 'Demo Skill', {
            install,
            skillExists: () => true
        });
        expect(blocked).toEqual(
            expect.objectContaining({
                success: false,
                registryName: 'matrix',
                matchedSkill: 'Demo Skill'
            })
        );
        expect(blocked.error).toContain('force=true');
        expect(install).not.toHaveBeenCalled();

        const overwritten = await installSkillFromRegistryByName('matrix', 'Demo Skill', {
            force: true,
            install,
            skillExists: () => true
        });
        expect(overwritten.success).toBe(true);
        expect(install).toHaveBeenCalledWith('matrix:demo-skill', true);
    });

    test('does not guess when a registry search has multiple non-exact candidates', async () => {
        const matrix = createRegistry('matrix', [
            {
                id: 'alpha-tool',
                name: 'Alpha Tool',
                description: '',
                source: 'matrix',
                installUrl: 'matrix:alpha-tool',
                downloads: 10,
                canInstall: true
            },
            {
                id: 'alpha-helper',
                name: 'Alpha Helper',
                description: '',
                source: 'matrix',
                installUrl: 'matrix:alpha-helper',
                downloads: 8,
                canInstall: true
            }
        ]);
        allRegistries.splice(0, allRegistries.length, matrix);
        const install = jest.fn(async () => ({ success: true, name: 'alpha-tool' }));

        const result = await installSkillFromRegistryByName('matrix', 'alpha', {
            install,
            skillExists: () => false
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('匹配到多个技能');
        expect(result.candidates?.map((skill) => skill.fullName)).toEqual(['matrix/Alpha Tool', 'matrix/Alpha Helper']);
        expect(install).not.toHaveBeenCalled();
    });
});
