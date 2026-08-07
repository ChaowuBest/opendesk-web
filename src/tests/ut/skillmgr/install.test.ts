import fs from 'fs';
import os from 'os';
import path from 'path';
import AdmZip from 'adm-zip';
import { skillRegistry } from '../../../main/applications/skillmgr/utils/skill-registry';
import { skillInstallManager, LocalZipInstaller } from '../../../main/applications/skillmgr/utils/skill-installer';
import { setCustomOpendeskDirectory } from '../../../main/utils/setting';
import { setPlatform } from '../../../platforms/base';

describe('skillmgr skill package installation', () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-skill-install-test-'));
        setCustomOpendeskDirectory(tempDir);
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('installs packages whose entry file is lowercase skill.md', async () => {
        const zipPath = path.join(tempDir, 'lowercase-skill.zip');
        const zip = new AdmZip();
        zip.addFile(
            'lowercase-skill/skill.md',
            Buffer.from(
                [
                    '---',
                    'name: lowercase-skill',
                    'description: Test skill with a lowercase entry filename',
                    '---',
                    '',
                    '# Lowercase Skill'
                ].join('\n'),
                'utf8'
            )
        );
        zip.writeZip(zipPath);

        const result = await skillInstallManager.installFromLocalZip(zipPath, undefined, { force: true });

        if (!result.success) {
            console.error('installSkillFromLocalZip failed:', JSON.stringify(result));
        }
        expect(result.success).toBe(true);
        expect(result.name).toBe('lowercase-skill');
        expect(fs.existsSync(path.join(tempDir, 'apps', 'skills', 'resources', 'lowercase-skill', 'SKILL.md'))).toBe(
            true
        );
    });

    test('uses the zip package name when frontmatter omits name', async () => {
        const zipPath = path.join(tempDir, 'desktop-control-1.0.0.zip');
        const zip = new AdmZip();
        zip.addFile(
            'desktop-control/SKILL.md',
            Buffer.from(
                [
                    '---',
                    'description: Advanced desktop automation with mouse, keyboard, and screen control',
                    '---',
                    '',
                    '# Desktop Control Skill'
                ].join('\n'),
                'utf8'
            )
        );
        zip.writeZip(zipPath);

        const result = await skillInstallManager.installFromLocalZip(zipPath, undefined, { force: true });

        expect(result.success).toBe(true);
        expect(result.name).toBe('desktop-control');
    });

    test('uses slug when frontmatter has registry display fields but no name', async () => {
        const zipPath = path.join(tempDir, 'meta-ads-1.0.0.zip');
        const zip = new AdmZip();
        zip.addFile(
            'meta-ads/skill.md',
            Buffer.from(
                [
                    '---',
                    'slug: meta-ads',
                    'display_name: Meta Ads API',
                    'version: 1.0.0',
                    '---',
                    '',
                    '# Meta Ads API',
                    '',
                    '## Description',
                    '',
                    'Full read/write integration with Meta Ads API.'
                ].join('\n'),
                'utf8'
            )
        );
        zip.writeZip(zipPath);

        const result = await skillInstallManager.installFromLocalZip(zipPath, undefined, { force: true });

        expect(result.success).toBe(true);
        expect(result.name).toBe('meta-ads');
    });

    test('truncates overly long descriptions for registration', async () => {
        const zipPath = path.join(tempDir, 'agent-reach-1.1.0.zip');
        const zip = new AdmZip();
        zip.addFile(
            'agent-reach/SKILL.md',
            Buffer.from(
                [
                    '---',
                    'name: agent-reach',
                    'description: ' + 'Search every supported social and web platform. '.repeat(40),
                    '---',
                    '',
                    '# Agent Reach'
                ].join('\n'),
                'utf8'
            )
        );
        zip.writeZip(zipPath);

        const result = await skillInstallManager.installFromLocalZip(zipPath, undefined, { force: true });

        expect(result.success).toBe(true);
        expect(result.name).toBe('agent-reach');
        const skill = skillRegistry.listSkills().find((item: any) => item.id === 'agent-reach');
        expect(skill?.description).toHaveLength(1024);
        expect(skill?.description.endsWith('...')).toBe(true);
    });

    test('uses summary when frontmatter omits description', async () => {
        const zipPath = path.join(tempDir, 'fast-browser-use-1.0.5.zip');
        const zip = new AdmZip();
        zip.addFile(
            'fast-browser-use/SKILL.md',
            Buffer.from(
                [
                    '---',
                    'name: fast-browser-use',
                    'summary: Rust-powered browser automation that rips through DOMs 10x faster than Puppeteer.',
                    '---',
                    '',
                    '# Fastest Browser Use',
                    '',
                    'A Rust-based browser automation engine.'
                ].join('\n'),
                'utf8'
            )
        );
        zip.writeZip(zipPath);

        const result = await skillInstallManager.installFromLocalZip(zipPath, undefined, { force: true });

        expect(result.success).toBe(true);
        expect(result.name).toBe('fast-browser-use');
        const skill = skillRegistry.listSkills().find((item: any) => item.id === 'fast-browser-use');
        expect(skill?.description).toBe(
            'Rust-powered browser automation that rips through DOMs 10x faster than Puppeteer.'
        );
    });

    test('keeps local zip auto-renaming but supports explicit registry conflict policies', async () => {
        const zipPath = path.join(tempDir, 'conflict-skill.zip');
        const zip = new AdmZip();
        zip.addFile(
            'conflict-skill/SKILL.md',
            Buffer.from(
                [
                    '---',
                    'name: conflict-skill',
                    'description: Skill used to verify installation conflict policies',
                    '---',
                    '',
                    '# Conflict Skill'
                ].join('\n'),
                'utf8'
            )
        );
        zip.writeZip(zipPath);

        expect((await skillInstallManager.installFromLocalZip(zipPath)).name).toBe('conflict-skill');
        expect((await skillInstallManager.installFromLocalZip(zipPath)).name).toBe('conflict-skill-1');

        const rejected = await new LocalZipInstaller({
            registry: skillRegistry,
            zipPath,
            conflictPolicy: { action: 'reject' }
        }).install();
        expect(rejected.success).toBe(false);
        expect(rejected.error).toContain('已存在');
        expect(fs.existsSync(path.join(tempDir, 'apps', 'skills', 'resources', 'conflict-skill-2'))).toBe(false);

        const renamed = await new LocalZipInstaller({
            registry: skillRegistry,
            zipPath,
            conflictPolicy: {
                action: 'rename',
                name: 'renamed-conflict-skill'
            }
        }).install();
        expect(renamed).toEqual({ success: true, name: 'renamed-conflict-skill' });
        expect(
            fs.readFileSync(
                path.join(tempDir, 'apps', 'skills', 'resources', 'renamed-conflict-skill', 'SKILL.md'),
                'utf8'
            )
        ).toContain('name: renamed-conflict-skill');
    });

    test('rejects duplicate remote installs while local zip installs auto-rename', async () => {
        const zip = new AdmZip();
        zip.addFile(
            'remote-conflict-skill/SKILL.md',
            Buffer.from(
                [
                    '---',
                    'name: remote-conflict-skill',
                    'description: Skill used to verify remote installation conflict behavior',
                    '---',
                    '',
                    '# Remote Conflict Skill'
                ].join('\n'),
                'utf8'
            )
        );
        const zipBuffer = zip.toBuffer();
        setPlatform({
            fetch: async () => new Response(zipBuffer),
            getEffectiveWorkspace: () => tempDir,
            initPlatformHarness: async () => {}
        } as any);

        const first = await skillInstallManager.installFromUrl('https://example.com/remote-conflict-skill.zip');
        const duplicate = await skillInstallManager.installFromUrl('https://example.com/remote-conflict-skill.zip');

        expect(first).toEqual({ success: true, name: 'remote-conflict-skill' });
        expect(duplicate.success).toBe(false);
        expect(duplicate.error).toContain('已存在');
        expect(fs.existsSync(path.join(tempDir, 'apps', 'skills', 'resources', 'remote-conflict-skill-1'))).toBe(false);
    });

    test.each([
        ['matrix', 'matrix:market-conflict-matrix'],
        ['clawhub', 'clawhub:market-conflict-clawhub'],
        ['modelscope', 'modelscope:owner/market-conflict-modelscope'],
        ['skillhub', 'skillhub:market-conflict-skillhub']
    ])('uses the same conflict policies for the %s registry', async (_registry, installUrl) => {
        const skillName = `market-conflict-${_registry}`;
        const zipPath = path.join(tempDir, `${skillName}.zip`);
        const zip = new AdmZip();
        zip.addFile(
            `${skillName}/SKILL.md`,
            Buffer.from(
                [
                    '---',
                    `name: ${skillName}`,
                    'description: Skill used to verify registry conflict behavior',
                    '---',
                    '',
                    '# Registry Conflict Skill'
                ].join('\n'),
                'utf8'
            )
        );
        zip.writeZip(zipPath);
        const zipBuffer = zip.toBuffer();
        setPlatform({
            fetch: async () => new Response(zipBuffer),
            getEffectiveWorkspace: () => tempDir,
            initPlatformHarness: async () => {}
        } as any);

        expect(await skillInstallManager.installFromLocalZip(zipPath)).toEqual({ success: true, name: skillName });

        const rejected = await skillInstallManager.installFromRegistryInstallUrl(installUrl);
        expect(rejected).toEqual({ success: false, error: `技能「${skillName}」已存在` });

        const overwritten = await skillInstallManager.installFromRegistryInstallUrl(installUrl, { force: true });
        expect(overwritten).toEqual({ success: true, name: skillName });

        const customName = `${skillName}-custom`;
        const renamed = await skillInstallManager.installFromRegistryInstallUrl(installUrl, { customName });
        expect(renamed).toEqual({ success: true, name: customName });
    });

    test.each(['../escaped-skill', 'nested/skill', 'nested\\skill', '.', '..'])(
        'rejects unsafe custom skill name %s',
        async (customName) => {
            const zipPath = path.join(tempDir, 'unsafe-name-skill.zip');
            const zip = new AdmZip();
            zip.addFile(
                'unsafe-name-skill/SKILL.md',
                Buffer.from(
                    [
                        '---',
                        'name: unsafe-name-skill',
                        'description: Skill used to verify custom name validation',
                        '---',
                        '',
                        '# Unsafe Name Skill'
                    ].join('\n'),
                    'utf8'
                )
            );
            zip.writeZip(zipPath);

            const result = await new LocalZipInstaller({
                registry: skillRegistry,
                zipPath,
                conflictPolicy: {
                    action: 'rename',
                    name: customName
                }
            }).install();

            expect(result.success).toBe(false);
        }
    );
});
