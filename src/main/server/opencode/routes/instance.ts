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

import { Hono } from 'hono';
import path from 'path';
import { AgentRegistry } from '../../../aikernel/agents/registry.js';
import { GlobalState } from '../../../aikernel/states/global.js';
import { SkillRegistry } from '../../../aikernel/skill.js';
import { getRequestWorkspace, getRequestWorkspaceID, getTaskWorkspace } from '../workspace.js';

/**
 * 实例级别路由。
 * 对应 opencode 的 GET /path, GET /command, GET /agent, POST /instance/dispose 等。
 */
export function InstanceRoutes() {
    const app = new Hono();

    // GET /path - 获取路径信息
    app.get('/path', (c) => {
        const directory = getRequestWorkspace(c);
        return c.json({
            directory,
            home: process.env.HOME || process.env.USERPROFILE || '',
            state: '',
            config: '',
            worktree: directory
        });
    });

    // GET /command - 列出所有命令
    app.get('/command', (c) => {
        const commands = AgentRegistry.getAgents().flatMap((agent) => {
            return agent.supportedModes().map((mode) => ({
                id: `${agent.agentName}:${mode.id}`,
                name: mode.id,
                description: mode.getSubPrompt?.() ?? ''
            }));
        });
        return c.json(commands);
    });

    // GET /agent - 列出所有 Agent
    app.get('/agent', (c) => {
        const agents = AgentRegistry.getAgents().map((agent) => ({
            name: agent.agentName,
            type: agent.agentType,
            modes: agent.supportedModes().map((m) => ({
                id: m.id,
                description: m.getSubPrompt?.() ?? ''
            }))
        }));
        return c.json(agents);
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

    // POST /instance/dispose - 释放当前实例
    app.post('/instance/dispose', (c) => {
        return c.json(true);
    });

    // GET /project/current - 当前项目信息（opencode TUI bootstrap 需要）
    app.get('/project/current', (c) => {
        const directory = getRequestWorkspace(c);
        const name = path.basename(directory) || 'unknown';
        return c.json({
            id: `proj_${name}`,
            name,
            path: directory,
            directory
        });
    });

    // GET /vcs - VCS（版本控制）信息 stub
    app.get('/vcs', (c) => {
        const directory = getRequestWorkspace(c);
        return c.json({
            sha: '',
            branch: '',
            dirty: false,
            root: directory
        });
    });

    // GET /lsp - LSP 状态 stub
    app.get('/lsp', (c) => {
        return c.json([]);
    });

    // GET /formatter - Formatter 列表 stub
    app.get('/formatter', (c) => {
        return c.json([]);
    });

    // GET /find - 文件搜索 stub
    app.get('/find', (c) => {
        return c.json([]);
    });

    // GET /find/file - 文件搜索 stub
    app.get('/find/file', (c) => {
        return c.json([]);
    });

    // GET /find/symbol - 符号搜索 stub
    app.get('/find/symbol', (c) => {
        return c.json([]);
    });

    // GET /experimental/console - Console 状态 stub（TUI bootstrap 需要）
    // 必须返回 ConsoleState 格式，特别是 consoleManagedProviders 字段，
    // 否则 TUI 的 isConsoleManagedProvider() 会在 undefined.has() 处崩溃。
    app.get('/experimental/console', (c) => {
        return c.json({
            consoleManagedProviders: [],
            activeOrgName: undefined,
            switchableOrgCount: 0
        });
    });

    // GET /experimental/resource - MCP 资源列表 stub
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
                    const created = t.started_at ? new Date(t.started_at).getTime() : Date.now();
                    return created >= startTs;
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
                    time: {
                        created: task.started_at ? new Date(task.started_at).getTime() : Date.now(),
                        updated: task.updated_at ? new Date(task.updated_at).getTime() : Date.now()
                    },
                    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                    cost: 0
                };
            })
        );
    });

    // GET /experimental/worktree - worktree 列表 stub
    app.get('/experimental/worktree', (c) => {
        return c.json([]);
    });

    // GET /experimental/workspace - workspace 列表 stub
    app.get('/experimental/workspace', (c) => {
        return c.json([]);
    });

    // GET /experimental/workspace/status - workspace 状态 stub
    app.get('/experimental/workspace/status', (c) => {
        return c.json([]);
    });

    // POST /experimental/workspace/sync-list - workspace sync stub
    app.post('/experimental/workspace/sync-list', (c) => {
        return c.json([]);
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
