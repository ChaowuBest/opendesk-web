/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import { Hono, type Context } from 'hono';
import path from 'path';
import type { Path } from '@opencode-ai/sdk/v2/types';
import { AgentRegistry } from '../../../aikernel/agents/registry.js';
import { GlobalState } from '../../../aikernel/states/global.js';
import { SkillRegistry } from '../../../aikernel/skill.js';
import { getOpendeskDirectory, Setting } from '../../../utils/setting.js';
import { getHomeDir } from '../../../utils/temp.js';
import { reloadServerConfigFromDisk } from '../config-compat.js';
import type { ConfigPermissionRuntime } from '../config-permission-runtime.js';
import { EventBus } from '../event-bus.js';
import {
    getOpenCodeProject,
    getOpenCodeVcsInfo,
    permissionRulesetFromConfig,
    skillsToOpenCodeCommands,
    toOpenCodeAgent
} from '../instance-info.js';
import { findFiles, findText, InvalidSearchPatternError } from '../search.js';
import { getOpenCodeSessionTime } from '../session-info.js';
import { getRequestWorkspace, getRequestWorkspaceID, getTaskWorkspace } from '../workspace.js';

/** opencode BadRequestError 结构的 400 响应 */
function badRequest(c: Context, message: string) {
    return c.json({ name: 'BadRequest' as const, data: { message, kind: 'Query' as const } }, 400);
}

/**
 * 实例级别路由。
 * 对应 opencode 的 GET /path, GET /command, GET /agent, POST /instance/dispose 等。
 */
export function InstanceRoutes(permissionRuntime?: ConfigPermissionRuntime) {
    const app = new Hono();

    // GET /path - 获取路径信息
    app.get('/path', (c) => {
        const directory = getRequestWorkspace(c);
        // OpenDesk 的设置与运行状态（任务、日志等）都在同一个数据目录下
        const dataDirectory = getOpendeskDirectory();
        return c.json({
            home: getHomeDir(),
            state: dataDirectory,
            config: dataDirectory,
            worktree: directory,
            directory
        } satisfies Path);
    });

    // GET /command - 列出所有命令（用户可调用的 Skill）
    app.get('/command', async (c) => {
        const skills = await SkillRegistry.getInstance().getUserInvocableSkills();
        return c.json(skillsToOpenCodeCommands(skills));
    });

    // GET /agent - 列出所有 Agent
    app.get('/agent', (c) => {
        // 只有启用并生效的配置权限才会真正作用于任务，否则不对外宣称规则
        const permission = permissionRuntime?.getSnapshot().policy
            ? permissionRulesetFromConfig(Setting.getInstance().getData().permission)
            : [];
        return c.json(AgentRegistry.getAgents().map((agent) => toOpenCodeAgent(agent, permission)));
    });

    // GET /skill - 列出所有 Skills
    app.get('/skill', async (c) => {
        const skills = await SkillRegistry.getInstance().getUserInvocableSkills();
        return c.json(
            skills.map(({ bundleName, skill }) => ({
                name: skill.frontmatter.name,
                description: skill.frontmatter.description || '',
                location: skill.directory || bundleName,
                content: skill.body || ''
            }))
        );
    });

    // POST /instance/dispose - 与 opencode 重建实例对应：从磁盘重新加载配置，客户端收到事件后重新拉取状态
    app.post('/instance/dispose', async (c) => {
        await reloadServerConfigFromDisk(permissionRuntime);
        const directory = getRequestWorkspace(c);
        EventBus.publish({ type: 'server.instance.disposed', directory, properties: { directory } });
        return c.json(true);
    });

    // GET /project/current - 当前项目信息（opencode TUI bootstrap 需要）
    app.get('/project/current', async (c) => {
        return c.json(await getOpenCodeProject(getRequestWorkspace(c)));
    });

    // GET /vcs - 工作空间所在 git 仓库的当前分支与默认分支
    app.get('/vcs', async (c) => {
        return c.json(await getOpenCodeVcsInfo(getRequestWorkspace(c)));
    });

    // GET /lsp - OpenDesk 不运行 LSP，没有 LSP 服务
    app.get('/lsp', (c) => {
        return c.json([]);
    });

    // GET /formatter - OpenDesk 不在写文件后自动格式化，没有 formatter
    app.get('/formatter', (c) => {
        return c.json([]);
    });

    // GET /find - 按正则搜索工作空间内的文本（对应 opencode 的 ripgrep 搜索）
    app.get('/find', async (c) => {
        const pattern = c.req.query('pattern');
        if (!pattern) return badRequest(c, 'pattern is required');
        try {
            return c.json(await findText(getRequestWorkspace(c), pattern));
        } catch (error) {
            if (error instanceof InvalidSearchPatternError) return badRequest(c, error.message);
            throw error;
        }
    });

    // GET /find/file - 模糊搜索工作空间内的文件与目录
    app.get('/find/file', async (c) => {
        const query = c.req.query('query');
        if (query === undefined) return badRequest(c, 'query is required');
        const limit = c.req.query('limit');
        const parsedLimit = limit === undefined ? undefined : Number(limit);
        if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 200)) {
            return badRequest(c, 'limit must be an integer between 1 and 200');
        }
        const type = c.req.query('type');
        if (type !== undefined && type !== 'file' && type !== 'directory') {
            return badRequest(c, 'type must be file or directory');
        }
        return c.json(
            await findFiles(getRequestWorkspace(c), {
                query,
                type: type ?? (c.req.query('dirs') === 'false' ? 'file' : undefined),
                limit: parsedLimit
            })
        );
    });

    // GET /find/symbol - 与 opencode 1.19.6 相同，没有符号搜索（依赖 LSP），返回空列表
    app.get('/find/symbol', (c) => {
        return c.json([]);
    });

    // GET /experimental/console - OpenDesk 没有 opencode Console 组织账号，不托管任何 provider（TUI bootstrap 需要）
    // 必须返回 ConsoleState 格式，特别是 consoleManagedProviders 字段，
    // 否则 TUI 的 isConsoleManagedProvider() 会在 undefined.has() 处崩溃。
    app.get('/experimental/console', (c) => {
        return c.json({
            consoleManagedProviders: [],
            activeOrgName: undefined,
            switchableOrgCount: 0
        });
    });

    // GET /experimental/resource - OpenDesk 的 MCP 管理只接入工具，不读取 MCP resources
    app.get('/experimental/resource', (c) => {
        return c.json({});
    });

    // GET /experimental/session - session 列表（experimental endpoint）
    // TUI 的 listSessions() 会传 start, search, limit, roots 等参数。
    app.get('/experimental/session', (c) => {
        const tms = GlobalState.getInstance().taskManagerState;
        const directory = getRequestWorkspace(c);
        const requestWorkspaceID = getRequestWorkspaceID(c);
        const dirName = path.basename(directory) || 'unknown';

        const search = c.req.query('search');
        const limitStr = c.req.query('limit');
        const startStr = c.req.query('start');
        const rootsOnly = c.req.query('roots') === 'true';

        let tasks = rootsOnly ? tms.tasks.filter((t: any) => !t.parent_id) : tms.tasks;
        if (c.req.query('scope') !== 'project') {
            tasks = tasks.filter((t: any) => getTaskWorkspace(t) === directory);
        }

        // start 参数：只返回 created >= start 的 session
        if (startStr) {
            const startTs = parseInt(startStr, 10);
            if (!isNaN(startTs)) {
                tasks = tasks.filter((t: any) => {
                    return getOpenCodeSessionTime(t).created >= startTs;
                });
            }
        }

        if (search) {
            const lowerSearch = search.toLowerCase();
            tasks = tasks.filter((t: any) => (t.task_name || '').toLowerCase().includes(lowerSearch));
        }

        if (limitStr) {
            const limit = parseInt(limitStr, 10);
            if (!isNaN(limit) && limit > 0) {
                tasks = tasks.slice(-limit);
            }
        }

        const toExternalId = (id: string) => (id.startsWith('task_') ? id.replace('task_', 'ses_') : id);
        return c.json(
            tasks.map((task: any) => {
                const sessionId = toExternalId(task.task_id);
                const parentID = task.parent_id ? toExternalId(task.parent_id) : undefined;
                return {
                    id: sessionId,
                    slug: sessionId.replace('ses_', ''),
                    projectID: `proj_${dirName}`,
                    ...(requestWorkspaceID || task.workspaceID
                        ? { workspaceID: requestWorkspaceID || task.workspaceID }
                        : {}),
                    directory: getTaskWorkspace(task),
                    path: '',
                    title: task.task_name || '',
                    ...(parentID ? { parentID } : {}),
                    version: '1',
                    agent: 'explore',
                    time: getOpenCodeSessionTime(task),
                    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                    cost: 0
                };
            })
        );
    });

    // GET /experimental/worktree - OpenDesk 不为任务创建 git worktree 沙箱
    app.get('/experimental/worktree', (c) => {
        return c.json([]);
    });

    // GET /experimental/workspace - OpenDesk 没有 opencode 的远程工作空间适配器，没有已注册的 workspace
    app.get('/experimental/workspace', (c) => {
        return c.json([]);
    });

    // GET /experimental/workspace/status - 没有远程 workspace，也就没有连接状态
    app.get('/experimental/workspace/status', (c) => {
        return c.json([]);
    });

    // POST /experimental/workspace/sync-list - 没有适配器需要同步，按规范返回 204
    app.post('/experimental/workspace/sync-list', (c) => {
        return c.body(null, 204);
    });

    // POST /session/:sessionID/command - slash 命令处理 stub
    app.post('/session/:sessionID/command', async (c) => {
        return c.json({ error: 'Commands not supported' }, 400);
    });

    // POST /session/:sessionID/shell - shell 命令处理 stub
    app.post('/session/:sessionID/shell', async (c) => {
        return c.json({ error: 'Shell not supported' }, 400);
    });

    return app;
}
