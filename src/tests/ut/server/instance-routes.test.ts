import { jest } from '@jest/globals';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AgentRegistry } from '../../../main/aikernel/agents/registry.js';
import { SkillRegistry, type Skill } from '../../../main/aikernel/skill.js';
import { GlobalState } from '../../../main/aikernel/states/global.js';
import { ConfigPermissionRuntime } from '../../../main/server/opencode/config-permission-runtime.js';
import { InstanceRoutes } from '../../../main/server/opencode/routes/instance.js';
import { getOpendeskDirectory, Setting } from '../../../main/utils/setting.js';
import { getHomeDir } from '../../../main/utils/temp.js';

function makeSkill(options: { name: string; description?: string; directory?: string }): Skill {
    return {
        frontmatter: { name: options.name, description: options.description },
        body: `body of ${options.name}`,
        directory: options.directory
    } as unknown as Skill;
}

/** 当前在 feature 分支、本地还有 main 分支的 git 仓库；全局 git 配置被隔离，不影响默认分支判定 */
function createGitWorkspace(): string {
    const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-instance-git-')));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: workspace, stdio: 'ignore' });
    git('-c', 'init.defaultBranch=main', 'init');
    git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'init');
    git('checkout', '-b', 'feature');
    return workspace;
}

describe('opencode instance routes', () => {
    beforeAll(() => {
        AgentRegistry.initBuiltinAgents();
    });

    const previousGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;

    beforeAll(() => {
        process.env.GIT_CONFIG_GLOBAL = path.join(
            fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-gitconfig-')),
            'config'
        );
    });

    afterAll(() => {
        if (previousGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
        else process.env.GIT_CONFIG_GLOBAL = previousGitConfigGlobal;
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('GET /command lists user-invocable skills as opencode skill commands', async () => {
        jest.spyOn(SkillRegistry, 'getInstance').mockReturnValue({
            getUserInvocableSkills: jest.fn(async () => [
                {
                    bundleName: 'builtin',
                    skill: makeSkill({ name: 'pdf', description: 'Work with PDFs', directory: '/skills/pdf' })
                },
                { bundleName: 'plugin', skill: makeSkill({ name: 'pdf', directory: '/plugin/pdf' }) },
                { bundleName: 'builtin', skill: makeSkill({ name: 'notes' }) }
            ])
        } as unknown as SkillRegistry);

        const response = await InstanceRoutes().request('/command');

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual([
            {
                name: 'pdf',
                description: 'Work with PDFs',
                source: 'skill',
                template: [
                    'body of pdf',
                    '',
                    'Base directory for this skill: /skills/pdf',
                    'Relative paths in this skill (e.g., scripts/, references/) are relative to this base directory.'
                ].join('\n'),
                hints: []
            },
            { name: 'notes', source: 'skill', template: 'body of notes', hints: [] }
        ]);
    });

    test('GET /agent returns builtin agents in the opencode Agent shape', async () => {
        const response = await InstanceRoutes().request('/agent');

        expect(response.status).toBe(200);
        const agents = (await response.json()) as Array<Record<string, unknown>>;
        expect(agents).toEqual(
            expect.arrayContaining([
                {
                    name: 'main',
                    description: expect.any(String),
                    mode: 'primary',
                    native: true,
                    permission: [],
                    options: {}
                },
                expect.objectContaining({ name: 'explore', mode: 'subagent' })
            ])
        );
        for (const agent of agents) {
            expect(Object.keys(agent).sort()).toEqual([
                'description',
                'mode',
                'name',
                'native',
                'options',
                'permission'
            ]);
        }
    });

    test('GET /agent reports configured permissions only while they are enforced', async () => {
        const permission = { '*': 'ask', bash: { '*': 'ask', 'git *': 'allow' } };
        jest.spyOn(Setting, 'getInstance').mockReturnValue({ getData: () => ({ permission }) } as unknown as Setting);

        const enforced = await InstanceRoutes(new ConfigPermissionRuntime(true, permission)).request('/agent');
        const [enforcedAgent] = (await enforced.json()) as Array<{ permission: unknown }>;
        expect(enforcedAgent.permission).toEqual([
            { permission: '*', pattern: '*', action: 'ask' },
            { permission: 'bash', pattern: '*', action: 'ask' },
            { permission: 'bash', pattern: 'git *', action: 'allow' }
        ]);

        const disabled = await InstanceRoutes(new ConfigPermissionRuntime(false, permission)).request('/agent');
        const [disabledAgent] = (await disabled.json()) as Array<{ permission: unknown }>;
        expect(disabledAgent.permission).toEqual([]);
    });

    test('GET /project/current and GET /vcs describe a git workspace', async () => {
        const workspace = createGitWorkspace();
        const query = `?directory=${encodeURIComponent(workspace)}`;

        const project = await InstanceRoutes().request(`/project/current${query}`);
        expect(project.status).toBe(200);
        await expect(project.json()).resolves.toEqual({
            id: `proj_${path.basename(workspace)}`,
            worktree: workspace,
            vcs: 'git',
            name: path.basename(workspace),
            time: { created: expect.any(Number), updated: expect.any(Number) },
            sandboxes: []
        });

        const vcs = await InstanceRoutes().request(`/vcs${query}`);
        await expect(vcs.json()).resolves.toEqual({ branch: 'feature', default_branch: 'main' });
    });

    test('GET /project/current and GET /vcs omit git fields outside a repository', async () => {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-instance-plain-'));
        const query = `?directory=${encodeURIComponent(workspace)}`;

        const project = (await (await InstanceRoutes().request(`/project/current${query}`)).json()) as Record<
            string,
            unknown
        >;
        expect(project.vcs).toBeUndefined();
        expect(project.worktree).toBe(workspace);

        const vcs = await InstanceRoutes().request(`/vcs${query}`);
        await expect(vcs.json()).resolves.toEqual({});
    });

    test('GET /path reports the OpenDesk data directory as config and state', async () => {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-instance-path-'));
        const response = await InstanceRoutes().request(`/path?directory=${encodeURIComponent(workspace)}`);

        await expect(response.json()).resolves.toEqual({
            home: getHomeDir(),
            state: getOpendeskDirectory(),
            config: getOpendeskDirectory(),
            worktree: workspace,
            directory: workspace
        });
    });

    test('GET /find and GET /find/file search the requested workspace', async () => {
        const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-instance-find-')));
        fs.mkdirSync(path.join(workspace, 'src'));
        fs.writeFileSync(path.join(workspace, 'src', 'main.ts'), 'export const answer = 42;\n');
        const query = `directory=${encodeURIComponent(workspace)}`;

        const text = await InstanceRoutes().request(`/find?pattern=answer&${query}`);
        expect(text.status).toBe(200);
        await expect(text.json()).resolves.toEqual([
            expect.objectContaining({ path: { text: 'src/main.ts' }, line_number: 1 })
        ]);

        const files = await InstanceRoutes().request(`/find/file?query=main&${query}`);
        await expect(files.json()).resolves.toEqual(['src/main.ts']);
        const directories = await InstanceRoutes().request(`/find/file?query=src&type=directory&${query}`);
        await expect(directories.json()).resolves.toEqual(['src/']);
    });

    test('find endpoints reject invalid queries with an opencode BadRequest error', async () => {
        for (const url of [
            '/find',
            '/find?pattern=(unclosed',
            '/find/file',
            '/find/file?query=a&limit=0',
            '/find/file?query=a&type=link'
        ]) {
            const response = await InstanceRoutes().request(url);
            expect(response.status).toBe(400);
            await expect(response.json()).resolves.toEqual({
                name: 'BadRequest',
                data: { message: expect.any(String), kind: 'Query' }
            });
        }
    });

    test('POST /experimental/workspace/sync-list answers 204 without a body', async () => {
        const response = await InstanceRoutes().request('/experimental/workspace/sync-list', { method: 'POST' });
        expect(response.status).toBe(204);
        await expect(response.text()).resolves.toBe('');
    });

    test('GET /experimental/session uses stable task lifecycle timestamps', async () => {
        const workspace = '/tmp/opendesk-instance-session-test';
        const task = {
            task_id: 'task_historical',
            parent_id: null,
            task_name: 'Historical task',
            task_status: 'waiting',
            created_at: new Date('2026-01-01T08:00:00.000Z'),
            started_at: new Date('2026-02-02T09:30:00.000Z'),
            updated_at: undefined,
            workspace,
            getWorkspace: jest.fn(() => workspace)
        };
        jest.spyOn(GlobalState, 'getInstance').mockReturnValue({
            taskManagerState: { tasks: [task] }
        } as any);

        const response = await InstanceRoutes().request(
            `/experimental/session?directory=${encodeURIComponent(workspace)}`
        );

        expect(response.status).toBe(200);
        const [session] = (await response.json()) as Array<{ time: { created: number; updated: number } }>;
        expect(session.time).toEqual({
            created: task.created_at.getTime(),
            updated: task.started_at.getTime()
        });
    });
});
