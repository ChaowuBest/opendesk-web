import fs from 'fs';
import os from 'os';
import path from 'path';
import { Skill, SkillRegistry } from '../../../main/aikernel/skill';
import { MAIN_AGENT_STANDARD_MODE } from '../../../main/aikernel/agents/main/modes/standard';
import { ReadableDirectoryRegistry } from '../../../main/aikernel/security/enforcer';
import { HarnessContext } from '../../../main/aikernel/security/harness';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks';
import type { PermissionRequest } from '../../../main/aikernel/security/permission';

const BUNDLE = 'test-skill-directory-read';
const SKILL_NAME = 'skill-directory-read';

function readRequest(filePath: string): PermissionRequest {
    return { resourceType: 'file', action: 'read', resourcePath: path.resolve(filePath).replace(/\\/g, '/') };
}

async function createTask(workspace: string): Promise<TaskState> {
    const manager = new TaskManagerState();
    const task = new TaskState(manager);
    task.task_id = 'skill-dir-read-task';
    task.harnessContext = await HarnessContext.createForMode(workspace, MAIN_AGENT_STANDARD_MODE);
    task.activeModeId = MAIN_AGENT_STANDARD_MODE.id;
    return task;
}

describe('skill directory read access', () => {
    let tempRoot: string;
    let workspace: string;
    let skillDir: string;
    let skillFile: string;

    beforeEach(() => {
        // 临时目录被默认策略整体放行，无法验证越界读，因此把测试根放在用户主目录下
        tempRoot = fs.mkdtempSync(path.join(os.homedir(), '.opendesk-skill-dir-read-'));
        workspace = path.join(tempRoot, 'workspace');
        skillDir = path.join(tempRoot, 'skills', SKILL_NAME);
        skillFile = path.join(skillDir, 'test', 'abc.md');
        fs.mkdirSync(workspace, { recursive: true });
        fs.mkdirSync(path.dirname(skillFile), { recursive: true });
        fs.writeFileSync(skillFile, '# abc');
        fs.writeFileSync(
            path.join(skillDir, 'SKILL.md'),
            '---\nname: skill-directory-read\ndescription: x\n---\n# 正文'
        );

        SkillRegistry.getInstance().registerSkillProvider(BUNDLE, {
            getSkills: async () => [
                new Skill({ name: SKILL_NAME, description: '技能目录读取测试' }, '# 正文', skillDir)
            ]
        });
    });

    afterEach(() => {
        SkillRegistry.getInstance().unregisterSkillProvider(BUNDLE);
        ReadableDirectoryRegistry.getInstance().unregister(skillDir);
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    test('技能目录内的自定义子目录在加载技能前需要用户确认', async () => {
        const task = await createTask(workspace);
        const result = await task.harnessContext.permission!.check(readRequest(skillFile));
        expect(result.effect).toBe('ask');
    });

    test('加载技能后当前任务即可读取技能目录下的自定义子目录', async () => {
        const task = await createTask(workspace);
        const loadSkill = SkillRegistry.getInstance().getToolset().getTool('LoadSkill')!;

        const loaded = await loadSkill.execute(
            { bundleName: BUNDLE, skillName: SKILL_NAME },
            undefined,
            task,
            undefined
        );
        expect(loaded.status).toBe('success');

        const result = await task.harnessContext.permission!.check(readRequest(skillFile));
        expect(result.effect).toBe('allow');
    });

    test('加载技能后技能目录进入可读目录注册表，后续任务无需再次授权', async () => {
        const task = await createTask(workspace);
        const loadSkill = SkillRegistry.getInstance().getToolset().getTool('LoadSkill')!;
        await loadSkill.execute({ bundleName: BUNDLE, skillName: SKILL_NAME }, undefined, task, undefined);

        expect(ReadableDirectoryRegistry.getInstance().getRegisteredDirectories()).toContain(
            path.resolve(skillDir).replace(/\\/g, '/')
        );

        const nextTask = await createTask(workspace);
        const result = await nextTask.harnessContext.permission!.check(readRequest(skillFile));
        expect(result.effect).toBe('allow');
    });

    test('目录名含 glob 特殊字符时加载后仍可读（pattern 需转义）', async () => {
        // external_paths 递归扫描等来源的技能目录名任意，`C++ (v2) [beta]` 里的
        // `+ ( ) [ ]` 都是 picomatch 语法字符，规则不转义会匹配不到自身
        const specialDir = path.join(tempRoot, 'C++ (v2) [beta]', SKILL_NAME);
        const specialFile = path.join(specialDir, 'test', 'abc.md');
        fs.mkdirSync(path.dirname(specialFile), { recursive: true });
        fs.writeFileSync(specialFile, '# abc');
        fs.writeFileSync(path.join(specialDir, 'SKILL.md'), '---\nname: special-skill\ndescription: x\n---\n# 正文');

        const bundle = `${BUNDLE}-special`;
        SkillRegistry.getInstance().registerSkillProvider(bundle, {
            getSkills: async () => [new Skill({ name: 'special-skill', description: 'x' }, '# 正文', specialDir)]
        });
        try {
            const task = await createTask(workspace);
            const loadSkill = SkillRegistry.getInstance().getToolset().getTool('LoadSkill')!;
            const loaded = await loadSkill.execute(
                { bundleName: bundle, skillName: 'special-skill' },
                undefined,
                task,
                undefined
            );
            expect(loaded.status).toBe('success');

            const result = await task.harnessContext.permission!.check(readRequest(specialFile));
            expect(result.effect).toBe('allow');
        } finally {
            SkillRegistry.getInstance().unregisterSkillProvider(bundle);
            ReadableDirectoryRegistry.getInstance().unregister(specialDir);
        }
    });
});
