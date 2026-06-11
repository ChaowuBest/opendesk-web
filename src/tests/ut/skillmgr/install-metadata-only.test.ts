import fs from 'fs';
import os from 'os';
import path from 'path';
import { SkillRegistry } from '../../../main/applications/skillmgr/utils';
import { installSkillFromDirectory } from '../../../main/applications/skillmgr/utils';
import { setCustomOpendeskDirectory } from '../../../main/utils/setting';

describe('skillmgr metadata-only installation', () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-skill-metadata-only-test-'));
        setCustomOpendeskDirectory(tempDir);
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('installs directories that only contain registry metadata', () => {
        const sourceDir = path.join(tempDir, 'browserautomation-skill');
        fs.mkdirSync(sourceDir, { recursive: true });
        fs.writeFileSync(
            path.join(sourceDir, 'metadata.json'),
            JSON.stringify(
                {
                    name: 'Browser Automation',
                    slug: 'browserautomation-skill',
                    description:
                        'Advanced headless browser automation skill for OpenClaw agents. Enables intelligent web navigation, form filling, data extraction, and UI testing with structured commands and semantic element targeting.',
                    category: 'ai-intelligence',
                    version: '1.0.2',
                    owner: 'stveenli',
                    homepage: 'https://api.skillhub.cn/stveenli/browserautomation-skill',
                    source: 'clawhub'
                },
                null,
                2
            ),
            'utf8'
        );

        const result = installSkillFromDirectory(sourceDir, true);

        expect(result.success).toBe(true);
        expect(result.name).toBe('browserautomation-skill');
        const installedSkillMd = path.join(
            tempDir,
            'apps',
            'skills',
            'resources',
            'browserautomation-skill',
            'SKILL.md'
        );
        expect(fs.existsSync(installedSkillMd)).toBe(true);
        const skill = SkillRegistry.listSkills().find((item: any) => item.id === 'browserautomation-skill');
        expect(skill?.description).toContain('Advanced headless browser automation skill');
        expect(fs.existsSync(path.join(sourceDir, 'SKILL.md'))).toBe(false);
    });

    test('still rejects empty directories without metadata', () => {
        const sourceDir = path.join(tempDir, 'skill-test-generate');
        fs.mkdirSync(sourceDir, { recursive: true });

        const result = installSkillFromDirectory(sourceDir, true);

        expect(result.success).toBe(false);
        expect(result.error).toContain('缺少 SKILL.md');
    });
});
