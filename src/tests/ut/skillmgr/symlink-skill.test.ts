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

describe('skill registry: symlinked skill directories', () => {
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

    test('symlink skill pointing outside resources is registered alongside real-directory skills', () => {
        makeSkill(path.join(resourcesDir, 'real-skill'), 'real-skill', 'Real directory skill');
        const externalDir = path.join(tempDir, 'external-skills', 'symlink-skill');
        makeSkill(externalDir, 'symlink-skill', 'Skill installed via symlink');
        fs.symlinkSync(externalDir, path.join(resourcesDir, 'symlink-skill'), 'dir');

        const { errors } = skillRegistry.loadAll();

        expect(registeredIds()).toEqual(expect.arrayContaining(['real-skill', 'symlink-skill']));
        expect(errors.find((e) => e.id === 'symlink-skill')).toBeUndefined();
    });

    test('cyclic symlinks in external_paths terminate scanning without errors', () => {
        const configRoot = path.join(tempDir, 'cycle-root');
        fs.mkdirSync(configRoot, { recursive: true });
        makeSkill(path.join(configRoot, 'cycle-skill'), 'cycle-skill', 'Skill next to cyclic links');
        // 自环：链接指向自己的父目录
        fs.symlinkSync(configRoot, path.join(configRoot, 'self-loop'), 'dir');
        // 互环：ping/next → pong，pong/next → ping
        const ping = path.join(configRoot, 'ping');
        const pong = path.join(configRoot, 'pong');
        fs.mkdirSync(ping);
        fs.mkdirSync(pong);
        fs.symlinkSync(pong, path.join(ping, 'next'), 'dir');
        fs.symlinkSync(ping, path.join(pong, 'next'), 'dir');
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

    test('symlink skill inside configured external_paths directory is discovered', () => {
        const configRoot = path.join(tempDir, 'external-skills');
        makeSkill(path.join(configRoot, 'config-real-skill'), 'config-real-skill', 'Real skill in external_paths');
        // symlink 与真实技能并存且指向独立技能，避免同名 frontmatter 掩盖 symlink 被跳过
        const elsewhere = path.join(tempDir, 'elsewhere', 'config-linked-skill');
        makeSkill(elsewhere, 'config-linked-skill', 'Skill symlinked inside external_paths');
        fs.symlinkSync(elsewhere, path.join(configRoot, 'config-linked-skill'), 'dir');
        skillRegistry.setRuntimeConfig({ external_paths: [configRoot] });

        const { errors } = skillRegistry.loadAll();

        expect(registeredIds()).toEqual(expect.arrayContaining(['config-real-skill', 'config-linked-skill']));
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
});
