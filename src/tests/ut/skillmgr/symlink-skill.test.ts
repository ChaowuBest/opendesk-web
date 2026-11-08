import fs from 'fs';
import os from 'os';
import path from 'path';
import { skillRegistry } from '../../../main/applications/skillmgr/utils/skill-registry.js';
import { setCustomOpendeskDirectory } from '../../../main/utils/setting.js';

function makeSkill(dir: string, name: string, desc: string): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
        path.join(dir, 'SKILL.md'),
        ['---', `name: ${name}`, `description: ${desc}`, '---', '', `# ${name}`].join('\n'),
        'utf8'
    );
}

function registeredIds(): string[] {
    return skillRegistry.listSkills().map((s) => s.id);
}

// Windows 非管理员/非开发者模式下无权创建符号链接，探测失败时整组用例跳过
const symlinkProbeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-symlink-probe-'));
let symlinksSupported = true;
try {
    fs.symlinkSync(symlinkProbeDir, path.join(symlinkProbeDir, 'probe'), 'dir');
} catch {
    symlinksSupported = false;
} finally {
    fs.rmSync(symlinkProbeDir, { recursive: true, force: true });
}
const describeIfSymlinks = symlinksSupported ? describe : describe.skip;

describeIfSymlinks('skill registry: symlinked skill directories', () => {
    let tempDir: string;
    let resourcesDir: string;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-symlink-skill-test-'));
        setCustomOpendeskDirectory(tempDir);
        resourcesDir = path.join(tempDir, 'apps', 'skills', 'resources');
        fs.mkdirSync(resourcesDir, { recursive: true });
    });

    afterEach(() => {
        skillRegistry.clearRuntimeConfig();
        setCustomOpendeskDirectory(undefined);
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('symlink skills are registered from resources and external_paths', () => {
        makeSkill(path.join(resourcesDir, 'real-skill'), 'real-skill', 'Real directory skill');
        const linkedFromResources = path.join(tempDir, 'external-skills', 'symlink-skill');
        makeSkill(linkedFromResources, 'symlink-skill', 'Skill installed via symlink');
        fs.symlinkSync(linkedFromResources, path.join(resourcesDir, 'symlink-skill'), 'dir');

        // symlink 与真实技能并存且指向独立技能，避免同名 frontmatter 掩盖 symlink 被跳过
        const configRoot = path.join(tempDir, 'config-root');
        makeSkill(path.join(configRoot, 'config-real-skill'), 'config-real-skill', 'Real skill in external_paths');
        const linkedFromConfig = path.join(tempDir, 'elsewhere', 'config-linked-skill');
        makeSkill(linkedFromConfig, 'config-linked-skill', 'Skill symlinked inside external_paths');
        fs.symlinkSync(linkedFromConfig, path.join(configRoot, 'config-linked-skill'), 'dir');
        skillRegistry.setRuntimeConfig({ external_paths: [configRoot] });

        const { errors } = skillRegistry.loadAll();

        expect(registeredIds()).toEqual(
            expect.arrayContaining(['real-skill', 'symlink-skill', 'config-real-skill', 'config-linked-skill'])
        );
        expect(skillRegistry.listSkills()).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 'config-linked-skill',
                    source: 'config',
                    skillDir: path.join(configRoot, 'config-linked-skill')
                })
            ])
        );
        expect(errors).toEqual([]);
    });

    test('cyclic symlinks in external_paths terminate scanning without errors', () => {
        const configRoot = path.join(tempDir, 'cycle-root');
        fs.mkdirSync(configRoot, { recursive: true });
        makeSkill(path.join(configRoot, 'cycle-skill'), 'cycle-skill', 'Skill next to a cyclic link');
        // 自环：链接指向自己的父目录，realpath 归一后命中 visited，扫描终止
        fs.symlinkSync(configRoot, path.join(configRoot, 'self-loop'), 'dir');
        skillRegistry.setRuntimeConfig({ external_paths: [configRoot] });

        const { errors } = skillRegistry.loadAll();

        expect(registeredIds()).toContain('cycle-skill');
        expect(errors).toEqual([]);
    });

    test('symlinked SKILL.md inside a real skill directory is discovered', () => {
        // dotfiles 仓库布局：技能目录为真实目录，入口文件是指向仓库内共享文件的链接
        const sharedDir = path.join(tempDir, 'shared');
        makeSkill(sharedDir, 'linked-entry-skill', 'Skill whose entry file is a symlink');
        const skillDir = path.join(resourcesDir, 'linked-entry-skill');
        fs.mkdirSync(skillDir);
        fs.symlinkSync(path.join(sharedDir, 'SKILL.md'), path.join(skillDir, 'SKILL.md'), 'file');

        const { errors } = skillRegistry.loadAll();

        expect(registeredIds()).toContain('linked-entry-skill');
        expect(errors.find((e) => e.id === 'linked-entry-skill')).toBeUndefined();
    });
});
