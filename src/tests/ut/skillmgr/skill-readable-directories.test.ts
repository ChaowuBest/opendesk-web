import fs from 'fs';
import os from 'os';
import path from 'path';
import { Skill, SkillRegistry } from '../../../main/aikernel/skill';
import { MAIN_AGENT_STANDARD_MODE } from '../../../main/aikernel/agents/main/modes/standard';
import { ReadableDirectoryRegistry } from '../../../main/aikernel/security/enforcer';
import { HarnessContext } from '../../../main/aikernel/security/harness';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks';
import type { PermissionRequest } from '../../../main/aikernel/security/permission';
import type { SkillMgrApplication } from '../../../main/applications/skillmgr/app.js';
import { skillRegistry } from '../../../main/applications/skillmgr/utils/skill-registry.js';
import { setCustomOpendeskDirectory } from '../../../main/utils/setting.js';

/**
 * 技能目录可读范围：技能中心初始化时只整根放行「内置技能根 + 用户技能根」。
 * external_paths / --mount-skill 目录（任意大的用户目录、运行期可变）不再整根放行，
 * 其中的技能靠 LoadSkill 加载时按 skill.directory 精确开放自身目录。
 */

const BUNDLE = 'test-skillmgr-readable';

function toPosix(p: string): string {
    return p.replace(/\\/g, '/');
}

function writeSkill(dir: string, name: string): void {
    fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
    fs.writeFileSync(
        path.join(dir, 'SKILL.md'),
        ['---', `name: ${name}`, 'description: test skill', '---', '', `# ${name}`].join('\n'),
        'utf8'
    );
    fs.writeFileSync(path.join(dir, 'test', 'abc.md'), '# abc', 'utf8');
}

function readRequest(filePath: string): PermissionRequest {
    return { resourceType: 'file', action: 'read', resourcePath: toPosix(path.resolve(filePath)) };
}

describe('skillmgr 技能目录可读注册范围', () => {
    let tempRoot: string;
    let workspace: string;
    let externalRoot: string;
    let externalSkillDir: string;
    let mountedRoot: string;
    let userSkillsDir: string;
    let bundledDir: string;
    let filterCountBefore: number;
    const registeredBefore = new Set<string>();

    beforeEach(async () => {
        // 临时目录被默认策略整体放行，无法验证越界读，因此测试根放在用户主目录下
        tempRoot = fs.mkdtempSync(path.join(os.homedir(), '.opendesk-skillmgr-readable-'));
        setCustomOpendeskDirectory(tempRoot);

        workspace = path.join(tempRoot, 'workspace');
        externalRoot = path.join(tempRoot, 'external-skills');
        externalSkillDir = path.join(externalRoot, 'external-skill');
        mountedRoot = path.join(tempRoot, 'mounted-skills');
        fs.mkdirSync(workspace, { recursive: true });
        writeSkill(externalSkillDir, 'external-skill');
        writeSkill(path.join(mountedRoot, 'mounted-skill'), 'mounted-skill');

        skillRegistry.setRuntimeConfig({ external_paths: [externalRoot] });
        skillRegistry.addMountedDir(mountedRoot);

        userSkillsDir = skillRegistry.getSkillsDirectory();
        bundledDir = skillRegistry.getBundledSkillsDirectory();
        for (const dir of ReadableDirectoryRegistry.getInstance().getRegisteredDirectories()) {
            registeredBefore.add(dir);
        }

        filterCountBefore = SkillRegistry.skillFilters.length;
        const { SkillMgrApplication: App } = await import('../../../main/applications/skillmgr/app.js');
        const app = Object.create(App.prototype) as SkillMgrApplication;
        (app as unknown as { registerReadableSkillDirectories(): void }).registerReadableSkillDirectories();
    });

    afterEach(() => {
        SkillRegistry.skillFilters.splice(filterCountBefore);
        const registry = ReadableDirectoryRegistry.getInstance();
        for (const dir of registry.getRegisteredDirectories()) {
            if (!registeredBefore.has(dir)) registry.unregister(dir);
        }
        SkillRegistry.getInstance().unregisterSkillProvider(BUNDLE);
        skillRegistry.clearRuntimeConfig();
        skillRegistry.clearMountedDirs();
        setCustomOpendeskDirectory(undefined);
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    test('只整根放行内置技能根与用户技能根，不再放行 external_paths / mount 目录', () => {
        const registered = ReadableDirectoryRegistry.getInstance().getRegisteredDirectories();

        expect(registered).toContain(toPosix(path.resolve(bundledDir)));
        expect(registered).toContain(toPosix(userSkillsDir));
        expect(registered).not.toContain(toPosix(path.resolve(externalRoot)));
        expect(registered).not.toContain(toPosix(path.resolve(externalSkillDir)));
        expect(registered).not.toContain(toPosix(path.resolve(mountedRoot)));
    });

    test('用户技能根下的技能不经加载即可直接读取（整根注册保留）', async () => {
        const installedSkillDir = path.join(userSkillsDir, 'installed-skill');
        writeSkill(installedSkillDir, 'installed-skill');

        const manager = new TaskManagerState();
        const task = new TaskState(manager);
        task.task_id = 'skillmgr-readable-installed';
        task.harnessContext = await HarnessContext.createForMode(workspace, MAIN_AGENT_STANDARD_MODE);
        task.activeModeId = MAIN_AGENT_STANDARD_MODE.id;

        const result = await task.harnessContext.permission!.check(
            readRequest(path.join(installedSkillDir, 'test', 'abc.md'))
        );
        expect(result.effect).toBe('allow');
    });

    test('external_paths 中的技能目录：加载前读需要确认，加载后即可读取', async () => {
        const manager = new TaskManagerState();
        const task = new TaskState(manager);
        task.task_id = 'skillmgr-readable-task';
        task.harnessContext = await HarnessContext.createForMode(workspace, MAIN_AGENT_STANDARD_MODE);
        task.activeModeId = MAIN_AGENT_STANDARD_MODE.id;

        const skillFile = path.join(externalSkillDir, 'test', 'abc.md');
        const beforeLoad = await task.harnessContext.permission!.check(readRequest(skillFile));
        expect(beforeLoad.effect).toBe('ask');

        SkillRegistry.getInstance().registerSkillProvider(BUNDLE, {
            getSkills: async () => [
                new Skill({ name: 'external-skill', description: 'test skill' }, '# external-skill', externalSkillDir)
            ]
        });
        const loadSkill = SkillRegistry.getInstance().getToolset().getTool('LoadSkill')!;
        const loaded = await loadSkill.execute(
            { bundleName: BUNDLE, skillName: 'external-skill' },
            undefined,
            task,
            undefined
        );
        expect(loaded.status).toBe('success');

        const afterLoad = await task.harnessContext.permission!.check(readRequest(skillFile));
        expect(afterLoad.effect).toBe('allow');
    });
});
