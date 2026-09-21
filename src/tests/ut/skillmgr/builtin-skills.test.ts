import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    BUILTIN_SKILLS_DIRECTORY_ENV,
    getBuiltinSkillsDirectory,
    listBuiltinSkillDirectories,
    appRootCandidatesFrom
} from '../../../main/applications/skillmgr/builtin-skills.js';
import { skillRegistry } from '../../../main/applications/skillmgr/utils/skill-registry.js';
import { BuiltinApplication } from '../../../main/applications/builtin/app.js';
import { setPlatform, type AbstractPlatform } from '../../../platforms/base.js';
import { setCustomOpendeskDirectory, Setting } from '../../../main/utils/setting.js';

/** 以最小桩替换全局平台，让内置技能加载的平台分支可测 */
function usePlatform(name: string): void {
    setPlatform({ getName: () => name } as unknown as AbstractPlatform);
}

function writeSkill(directory: string, name: string, description: string): void {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
        path.join(directory, 'SKILL.md'),
        ['---', `name: ${name}`, `description: ${description}`, '---', '', `# ${name}`].join('\n'),
        'utf8'
    );
}

function makeTempDir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), `opendesk-${prefix}-`));
}

/** 清理临时目录；个别环境（受限沙箱）会拒绝删除目录，忽略清理失败即可 */
function cleanupTempDirs(dirs: string[]): void {
    for (const dir of dirs) {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
        } catch {
            /* ignore */
        }
    }
}

describe('builtin bundled skills', () => {
    const originalEnv = process.env[BUILTIN_SKILLS_DIRECTORY_ENV];
    let tempDirs: string[] = [];

    beforeEach(() => {
        delete process.env[BUILTIN_SKILLS_DIRECTORY_ENV];
        usePlatform('electron');
    });

    afterEach(() => {
        if (originalEnv === undefined) {
            delete process.env[BUILTIN_SKILLS_DIRECTORY_ENV];
        } else {
            process.env[BUILTIN_SKILLS_DIRECTORY_ENV] = originalEnv;
        }
        skillRegistry.clearRuntimeConfig();
        skillRegistry.clearMountedDirs();
        setCustomOpendeskDirectory(undefined);
        Setting.clearCache();
        cleanupTempDirs(tempDirs);
        tempDirs = [];
    });

    function pushTempDir(dir: string): string {
        tempDirs.push(dir);
        return dir;
    }

    test('appRootCandidatesFrom yields only directories containing package.json', () => {
        const root = pushTempDir(makeTempDir('app-root'));
        const nested = path.join(root, 'dist', 'main', 'chunks');
        fs.mkdirSync(nested, { recursive: true });
        fs.writeFileSync(path.join(root, 'package.json'), '{}', 'utf8');

        const candidates = [...appRootCandidatesFrom(nested)];

        expect(candidates).toContain(root);
        expect(candidates[0]).toBe(root);
        // 不含 package.json 的中间目录不应作为应用根产出
        expect(candidates).not.toContain(path.join(root, 'dist'));
    });

    test('getBuiltinSkillsDirectory resolves from OPENDESK_BUILTIN_SKILLS_DIRECTORY', () => {
        const root = pushTempDir(makeTempDir('builtin-skills-env'));
        writeSkill(path.join(root, 'sample'), 'sample-skill', 'env override skill');

        process.env[BUILTIN_SKILLS_DIRECTORY_ENV] = root;

        expect(getBuiltinSkillsDirectory()).toBe(path.resolve(root));
        expect(listBuiltinSkillDirectories()).toEqual([path.join(path.resolve(root), 'sample')]);
    });

    test('getBuiltinSkillsDirectory ignores env pointing to a missing directory', () => {
        process.env[BUILTIN_SKILLS_DIRECTORY_ENV] = path.join(os.tmpdir(), 'opendesk-not-exists-dir');

        // 回落到上溯解析（仓库根 resources/skills 在本仓库内存在）或 undefined
        const resolved = getBuiltinSkillsDirectory();
        if (resolved) {
            expect(path.basename(resolved)).toBe('skills');
            expect(path.basename(path.dirname(resolved))).toBe('resources');
        }
    });

    test('listBuiltinSkillDirectories returns empty array for an empty directory', () => {
        const emptyRoot = pushTempDir(makeTempDir('builtin-skills-empty'));
        process.env[BUILTIN_SKILLS_DIRECTORY_ENV] = emptyRoot;

        expect(getBuiltinSkillsDirectory()).toBe(path.resolve(emptyRoot));
        expect(listBuiltinSkillDirectories()).toEqual([]);
    });

    test('SkillRegistry does not scan the builtin resources directory', () => {
        // resources/skills 由 builtin 应用独立加载；skillmgr 注册表重复注册会导致
        // 技能中心「已安装」列表与输入自动补全出现重复条目，且删除时报「无效的技能路径」
        const root = pushTempDir(makeTempDir('builtin-skills-registry'));
        const suffix = path.basename(root).slice(-6).toLowerCase();
        const builtinName = `builtin-skill-${suffix}`;
        writeSkill(path.join(root, builtinName), builtinName, 'bundled from resources/skills');

        process.env[BUILTIN_SKILLS_DIRECTORY_ENV] = root;
        setCustomOpendeskDirectory(pushTempDir(makeTempDir('builtin-skills-config')));

        skillRegistry.refresh();

        expect(skillRegistry.listSkills().some((skill) => skill.id === builtinName)).toBe(false);
        expect(skillRegistry.listSkills().some((skill) => skill.source === 'bundled')).toBe(false);
    });

    test('bundled skills do not override user-installed skills with the same name', () => {
        const root = pushTempDir(makeTempDir('builtin-skills-conflict'));
        const configDir = pushTempDir(makeTempDir('builtin-skills-conflict-config'));
        const suffix = path.basename(root).slice(-6).toLowerCase();
        const name = `conflict-skill-${suffix}`;

        // 先切换应用数据目录，再写入用户安装技能，避免污染真实用户目录
        setCustomOpendeskDirectory(configDir);
        writeSkill(path.join(skillRegistry.getSkillsDirectory(), name), name, 'installed version');
        writeSkill(path.join(root, name), name, 'bundled version');
        process.env[BUILTIN_SKILLS_DIRECTORY_ENV] = root;

        skillRegistry.refresh();

        const matches = skillRegistry.listSkills().filter((skill) => skill.id === name);
        expect(matches).toHaveLength(1);
        expect(matches[0]).toEqual(
            expect.objectContaining({
                id: name,
                source: 'installed',
                description: 'installed version'
            })
        );
    });

    test('BuiltinApplication exposes bundled skills as read-only Skill objects', async () => {
        const root = pushTempDir(makeTempDir('builtin-skills-app'));
        const suffix = path.basename(root).slice(-6).toLowerCase();
        const builtinName = `app-builtin-skill-${suffix}`;
        writeSkill(path.join(root, builtinName), builtinName, 'loaded by builtin application');

        setCustomOpendeskDirectory(pushTempDir(makeTempDir('builtin-skills-app-config')));
        process.env[BUILTIN_SKILLS_DIRECTORY_ENV] = root;

        const application = new BuiltinApplication();
        const skills = await application.getSkills();

        const bundled = skills.find((skill) => skill.frontmatter.name === builtinName);
        expect(bundled).toBeDefined();
        expect(bundled?.readOnly).toBe(true);
        expect(bundled?.directory).toBe(path.join(path.resolve(root), builtinName));
        expect(bundled?.body).toContain(`# ${builtinName}`);
        // builtin 应用从同一目录加载，但 skillmgr 注册表中不应出现重复条目
        expect(skillRegistry.listSkills().some((skill) => skill.id === builtinName)).toBe(false);

        // 代码内置技能仍然保留
        expect(skills.map((skill) => skill.frontmatter.name)).toContain('pool');
        expect(skills.map((skill) => skill.frontmatter.name)).toContain('use-harmony');
    });

    test('BuiltinApplication returns only hardcoded skills when the builtin directory has no skills', async () => {
        // 注意：环境变量指向不存在的目录时会回落到仓库 resources/skills 的上溯解析，
        // 因此这里必须用「存在但为空」的目录来模拟无内置技能的安装布局
        const empty = pushTempDir(makeTempDir('builtin-skills-none'));
        process.env[BUILTIN_SKILLS_DIRECTORY_ENV] = empty;

        const application = new BuiltinApplication();
        const skills = await application.getSkills();

        expect(skills.map((skill) => skill.frontmatter.name).sort()).toEqual(['pool', 'use-harmony']);
    });

    test('packaging config ships resources/skills as an extraResource', () => {
        // ESM 测试环境中无法 require CJS 的 forge.config.cjs（其顶层 require 依赖未打包依赖），
        // 直接对源码文本断言 extraResources 列表包含 resources/skills
        const forgeConfigPath = fileURLToPath(new URL('../../../../forge.config.cjs', import.meta.url));
        const forgeConfigSource = fs.readFileSync(forgeConfigPath, 'utf8');

        const extraResourcesMatch = forgeConfigSource.match(/const extraResources = \[[\s\S]*?\];/);
        expect(extraResourcesMatch).not.toBeNull();
        expect(extraResourcesMatch![0]).toContain(`path.join(__dirname, 'resources', 'skills')`);
    });

    test('repo resources/skills are served by the builtin application only', () => {
        // 仓库自带的内置技能必须始终可解析，防止无效技能进入安装包；
        // 但装载来源仅限 builtin 应用，不得进入 skillmgr 注册表造成重复
        const repoSkillsDir = fileURLToPath(new URL('../../../../resources/skills', import.meta.url));
        process.env[BUILTIN_SKILLS_DIRECTORY_ENV] = repoSkillsDir;
        setCustomOpendeskDirectory(pushTempDir(makeTempDir('builtin-skills-repo')));

        skillRegistry.refresh();

        expect(getBuiltinSkillsDirectory()).toBe(path.resolve(repoSkillsDir));
        expect(
            listBuiltinSkillDirectories()
                .map((dir) => path.basename(dir))
                .sort()
        ).toEqual(['analysis-result-visualizer', 'generate-html-card']);
        expect(skillRegistry.listSkills().some((skill) => skill.source === 'bundled')).toBe(false);
        expect(skillRegistry.listSkills().some((skill) => skill.id === 'generate-html-card')).toBe(false);
        expect(skillRegistry.listSkills().some((skill) => skill.id === 'analysis-result-visualizer')).toBe(false);
    });

    test('BuiltinApplication loads analysis-result-visualizer from repo resources/skills', async () => {
        // 迁移自硬编码实现：该技能现由 resources/skills 目录加载，行为保持不变
        const repoSkillsDir = fileURLToPath(new URL('../../../../resources/skills', import.meta.url));
        process.env[BUILTIN_SKILLS_DIRECTORY_ENV] = repoSkillsDir;
        setCustomOpendeskDirectory(pushTempDir(makeTempDir('builtin-skills-visualizer')));
        usePlatform('electron');

        const application = new BuiltinApplication();
        const skills = await application.getSkills();

        const visualizer = skills.find((skill) => skill.frontmatter.name === 'analysis-result-visualizer');
        expect(visualizer).toBeDefined();
        expect(visualizer?.readOnly).toBe(true);
        expect(visualizer?.directory).toBe(path.join(path.resolve(repoSkillsDir), 'analysis-result-visualizer'));
        expect(visualizer?.body).toContain('# 分析结果可视化');
        expect(visualizer?.body).toContain('Visualizer Core Design System');
    });

    test('BuiltinApplication skips analysis-result-visualizer outside Electron', async () => {
        // 可视化技能依赖宿主 UI 的内联图形预览，CLI 没有渲染能力，不注入技能与系统 prompt 介绍
        const repoSkillsDir = fileURLToPath(new URL('../../../../resources/skills', import.meta.url));
        process.env[BUILTIN_SKILLS_DIRECTORY_ENV] = repoSkillsDir;
        setCustomOpendeskDirectory(pushTempDir(makeTempDir('builtin-skills-cli')));
        usePlatform('cli');

        const application = new BuiltinApplication();
        const skills = await application.getSkills();

        expect(skills.map((skill) => skill.frontmatter.name)).not.toContain('analysis-result-visualizer');
        // 其余内置技能不受平台限制
        expect(skills.map((skill) => skill.frontmatter.name)).toContain('generate-html-card');
    });
});
