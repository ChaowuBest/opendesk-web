import fs from 'fs';
import os from 'os';
import path from 'path';
import { skillRegistry } from '../../../main/applications/skillmgr/utils/skill-registry';
import { skillInstallManager } from '../../../main/applications/skillmgr/utils/skill-installer';
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

    test('installs directories that only contain registry metadata', async () => {
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

        const result = await skillInstallManager.installFromDirectory(sourceDir, { force: true });

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
        const skill = skillRegistry.listSkills().find((item: any) => item.id === 'browserautomation-skill');
        expect(skill?.description).toContain('Advanced headless browser automation skill');
        expect(fs.existsSync(path.join(sourceDir, 'SKILL.md'))).toBe(false);
    });

    test('still rejects empty directories without metadata', async () => {
        const sourceDir = path.join(tempDir, 'skill-test-generate');
        fs.mkdirSync(sourceDir, { recursive: true });

        const result = await skillInstallManager.installFromDirectory(sourceDir, { force: true });

        expect(result.success).toBe(false);
        expect(result.error).toContain('缺少 SKILL.md');
    });

    test('metadata-only skill 的 skillDir 保持 undefined，不伪造空串目录', () => {
        const skillDir = path.join(tempDir, 'apps', 'skills', 'resources', 'metadata-only-skill');
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(
            path.join(skillDir, 'metadata.json'),
            JSON.stringify({
                name: 'metadata-only-skill',
                slug: 'metadata-only-skill',
                description: 'Skill that only ships registry metadata, without SKILL.md',
                version: '1.0.0'
            }),
            'utf8'
        );

        skillRegistry.loadAll();

        const listed = skillRegistry
            .listSkills()
            .find((item: any) => String(item.description).includes('only ships registry metadata')) as
            { id: string } | undefined;
        expect(listed).toBeDefined();

        // 合成技能没有真实技能目录：必须保持 undefined。下游 `skillBody?.skillDir ?? path.join(默认目录)`
        // 与 `if (!cached?.skillDir)` 都依赖该值 falsy，若改回空串会失去兜底
        expect(skillRegistry.getSkillBody(listed!.id)?.skillDir).toBeUndefined();
        // 缺少目录时 getSkillDetail 不应抛错（历史上 path.resolve(undefined) 会 TypeError）
        expect(skillRegistry.getSkillDetail(listed!.id)?.skillDir).toBeUndefined();
    });
});
