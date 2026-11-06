import fs from 'fs';
import os from 'os';
import path from 'path';
import { skillInstallManager } from '../../../main/applications/skillmgr/utils/skill-installer.js';
import { skillRegistry } from '../../../main/applications/skillmgr/utils/skill-registry.js';
import { setCustomOpendeskDirectory } from '../../../main/utils/setting.js';

function makeSkill(dir: string, name: string, description: string): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
        path.join(dir, 'SKILL.md'),
        ['---', `name: ${name}`, `description: ${description}`, '---', '', `# ${name}`].join('\n'),
        'utf8'
    );
}

describe('skill installer symlink handling', () => {
    let tempDir: string;
    let resourcesDir: string;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-installer-symlink-test-'));
        setCustomOpendeskDirectory(tempDir);
        resourcesDir = path.join(tempDir, 'apps', 'skills', 'resources');
        fs.mkdirSync(resourcesDir, { recursive: true });
    });

    afterEach(() => {
        skillRegistry.clearRuntimeConfig();
        setCustomOpendeskDirectory(undefined);
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('uninstalls a linked skill without removing its target', () => {
        const targetDir = path.join(tempDir, 'external', 'linked-delete');
        makeSkill(targetDir, 'linked-delete', 'Linked skill to delete');
        const linkDir = path.join(resourcesDir, 'linked-delete');
        fs.symlinkSync(targetDir, linkDir, 'dir');
        skillRegistry.loadAll();

        expect(skillInstallManager.deleteSkill('linked-delete')).toEqual({ success: true });
        expect(fs.existsSync(linkDir)).toBe(false);
        expect(fs.existsSync(path.join(targetDir, 'SKILL.md'))).toBe(true);
    });

    test('keeps a dangling link and chooses another name during install', async () => {
        const sourceDir = path.join(tempDir, 'source');
        makeSkill(sourceDir, 'dangling-skill', 'Skill installed next to a dangling link');
        const linkDir = path.join(resourcesDir, 'dangling-skill');
        fs.symlinkSync(path.join(tempDir, 'missing-target'), linkDir, 'dir');

        expect(await skillInstallManager.installFromDirectory(sourceDir)).toMatchObject({
            success: true,
            name: 'dangling-skill-1'
        });
        expect(fs.lstatSync(linkDir).isSymbolicLink()).toBe(true);
        expect(fs.existsSync(path.join(resourcesDir, 'dangling-skill-1', 'SKILL.md'))).toBe(true);
    });

    test('deletes a dangling linked skill', () => {
        const linkDir = path.join(resourcesDir, 'dangling-delete');
        fs.symlinkSync(path.join(tempDir, 'missing-target'), linkDir, 'dir');

        expect(skillInstallManager.deleteSkill('dangling-delete')).toEqual({ success: true });
        expect(fs.existsSync(linkDir)).toBe(false);
        expect(() => fs.lstatSync(linkDir)).toThrow();
    });

    test('overwrites a linked skill without deleting its target', async () => {
        const targetDir = path.join(tempDir, 'external', 'linked-overwrite');
        makeSkill(targetDir, 'linked-overwrite', 'Original skill');
        const linkDir = path.join(resourcesDir, 'linked-overwrite');
        fs.symlinkSync(targetDir, linkDir, 'dir');
        const sourceDir = path.join(tempDir, 'source');
        makeSkill(sourceDir, 'linked-overwrite', 'Replacement skill');

        expect(await skillInstallManager.installFromDirectory(sourceDir, { force: true })).toMatchObject({
            success: true,
            name: 'linked-overwrite'
        });
        expect(fs.lstatSync(linkDir).isDirectory()).toBe(true);
        expect(fs.readFileSync(path.join(targetDir, 'SKILL.md'), 'utf8')).toContain('Original skill');
        expect(fs.readFileSync(path.join(linkDir, 'SKILL.md'), 'utf8')).toContain('Replacement skill');
    });
});
