import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { definePlugin } from '../../../../packages/plugin-sdk/src/index.js';
import { SkillMgrApplication } from '../../../main/applications/skillmgr/app.js';
import { skillRegistry } from '../../../main/applications/skillmgr/utils/skill-registry.js';
import { setSkillStatus } from '../../../main/applications/skillmgr/status.js';
import { getPluginHost } from '../../../main/applications/pluginmgr/runtime/host.js';
import { setCustomOpendeskDirectory } from '../../../main/utils/setting.js';

function writeSkill(directory: string, name: string): void {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
        path.join(directory, 'SKILL.md'),
        ['---', `name: ${name}`, `description: ${name} description`, '---', '', `# ${name}`].join('\n'),
        'utf8'
    );
}

describe('skill.list.after plugin hook', () => {
    let configDirectory: string;
    let externalDirectory: string;
    let mountedDirectory: string;

    beforeEach(async () => {
        await getPluginHost().dispose();
        configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-skill-list-hook-'));
        externalDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-skill-list-external-'));
        mountedDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-skill-list-mounted-'));
        setCustomOpendeskDirectory(configDirectory);
        skillRegistry.clearRuntimeConfig();
        skillRegistry.clearMountedDirs();

        writeSkill(path.join(skillRegistry.getSkillsDirectory(), 'installed-skill-directory'), 'installed-skill');
        writeSkill(externalDirectory, 'config-skill');
        writeSkill(mountedDirectory, 'mounted-skill');
        skillRegistry.setRuntimeConfig({ external_paths: [externalDirectory] });
        skillRegistry.addMountedDir(mountedDirectory);
        skillRegistry.refresh();
        setSkillStatus('installed-skill', false);
    });

    afterEach(async () => {
        await getPluginHost().dispose();
        skillRegistry.clearRuntimeConfig();
        skillRegistry.clearMountedDirs();
        setCustomOpendeskDirectory(undefined);
        fs.rmSync(configDirectory, { recursive: true, force: true });
        fs.rmSync(externalDirectory, { recursive: true, force: true });
        fs.rmSync(mountedDirectory, { recursive: true, force: true });
    });

    test('passes local skill sources, directories, and enabled state to plugins', async () => {
        let received: readonly unknown[] | undefined;
        let calls = 0;
        await getPluginHost().activate(
            definePlugin({
                id: 'skill-list-observer',
                capabilities: ['hook'],
                setup(ctx) {
                    ctx.hooks.on('skill.list.after', ({ skills }) => {
                        calls++;
                        received = skills;
                    });
                }
            }),
            { origin: 'test:skill-list-observer' }
        );

        const application = new SkillMgrApplication();
        await application.ensureLoaded();
        await application.ensureLoaded();

        expect(received).toEqual(
            expect.arrayContaining([
                {
                    name: 'installed-skill',
                    directory: path.join(configDirectory, 'apps', 'skills', 'resources', 'installed-skill-directory'),
                    source: 'installed',
                    enabled: false
                },
                {
                    name: 'config-skill',
                    directory: externalDirectory,
                    source: 'config',
                    enabled: true
                },
                {
                    name: 'mounted-skill',
                    directory: mountedDirectory,
                    source: 'mounted',
                    enabled: true
                }
            ])
        );
        expect(received).toHaveLength(3);
        expect(calls).toBe(1);
    });

    test('publishes the latest list after SkillMgr refreshes', async () => {
        let calls = 0;
        await getPluginHost().activate(
            definePlugin({
                id: 'skill-refresh-observer',
                capabilities: ['hook'],
                setup(ctx) {
                    ctx.hooks.on('skill.list.after', () => {
                        calls++;
                    });
                }
            }),
            { origin: 'test:skill-refresh-observer' }
        );

        const application = new SkillMgrApplication();
        application.refresh();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(calls).toBe(1);
    });
});
