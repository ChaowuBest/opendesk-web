import fs from 'fs';
import os from 'os';
import path from 'path';
import AdmZip from 'adm-zip';
import { SkillRegistry } from '../../../main/applications/skillmgr/utils';
import { installSkillFromLocalZip } from '../../../main/applications/skillmgr/utils';
import { setCustomOpendeskDirectory } from '../../../main/utils/setting';

describe('skillmgr skill package installation', () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-skill-install-test-'));
        setCustomOpendeskDirectory(tempDir);
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('installs packages whose entry file is lowercase skill.md', () => {
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

        const result = installSkillFromLocalZip(zipPath, undefined, true);

        expect(result.success).toBe(true);
        expect(result.name).toBe('lowercase-skill');
        expect(fs.existsSync(path.join(tempDir, 'apps', 'skills', 'resources', 'lowercase-skill', 'SKILL.md'))).toBe(
            true
        );
    });

    test('uses the zip package name when frontmatter omits name', () => {
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

        const result = installSkillFromLocalZip(zipPath, undefined, true);

        expect(result.success).toBe(true);
        expect(result.name).toBe('desktop-control');
    });

    test('uses slug when frontmatter has registry display fields but no name', () => {
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

        const result = installSkillFromLocalZip(zipPath, undefined, true);

        expect(result.success).toBe(true);
        expect(result.name).toBe('meta-ads');
    });

    test('truncates overly long descriptions for registration', () => {
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

        const result = installSkillFromLocalZip(zipPath, undefined, true);

        expect(result.success).toBe(true);
        expect(result.name).toBe('agent-reach');
        const skill = SkillRegistry.listSkills().find((item: any) => item.id === 'agent-reach');
        expect(skill?.description).toHaveLength(1024);
        expect(skill?.description.endsWith('...')).toBe(true);
    });

    test('uses summary when frontmatter omits description', () => {
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

        const result = installSkillFromLocalZip(zipPath, undefined, true);

        expect(result.success).toBe(true);
        expect(result.name).toBe('fast-browser-use');
        const skill = SkillRegistry.listSkills().find((item: any) => item.id === 'fast-browser-use');
        expect(skill?.description).toBe(
            'Rust-powered browser automation that rips through DOMs 10x faster than Puppeteer.'
        );
    });
});
