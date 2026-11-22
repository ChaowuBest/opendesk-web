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

/**
 * 实例级 opencode 结构（Agent / Command / Project / VcsInfo / ProviderAuthMethod）的转换。
 * 字段以 @opencode-ai/sdk 1.19.6 的 v2 类型为准（服务端兼容的 opencode 协议版本），
 * 用 satisfies 约束，多出或缺少字段都会在类型检查时报错。
 */

import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import type {
    Agent,
    Command,
    PermissionRuleset,
    Project,
    ProviderAuthMethod,
    VcsInfo
} from '@opencode-ai/sdk/v2/types';
import type { AgentDecl } from '../../aikernel/agents/common.js';
import type { Skill } from '../../aikernel/skill.js';
import { buildChildProcessEnv } from '../../utils/shellExec.js';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 5000;

export function toOpenCodeAgent(agent: AgentDecl, permission: PermissionRuleset): Agent {
    return {
        name: agent.agentId,
        description: agent.whenToUse,
        // 可被主 Agent 调度的对应 opencode 的 subagent，其余是用户直接对话的 primary
        mode: agent.dispatchable ? 'subagent' : 'primary',
        native: agent.agentType === 'builtin',
        permission,
        options: {}
    } satisfies Agent;
}

/** 与 opencode Permission.fromConfig 一致：字符串值作用于全部模式，对象值逐个模式展开 */
export function permissionRulesetFromConfig(permission: unknown): PermissionRuleset {
    if (typeof permission !== 'object' || permission === null || Array.isArray(permission)) return [];
    const ruleset: PermissionRuleset = [];
    for (const [name, value] of Object.entries(permission)) {
        if (isPermissionAction(value)) {
            ruleset.push({ permission: name, pattern: '*', action: value });
            continue;
        }
        if (typeof value !== 'object' || value === null) continue;
        for (const [pattern, action] of Object.entries(value)) {
            if (isPermissionAction(action)) ruleset.push({ permission: name, pattern, action });
        }
    }
    return ruleset;
}

function isPermissionAction(value: unknown): value is 'allow' | 'ask' | 'deny' {
    return value === 'allow' || value === 'ask' || value === 'deny';
}

/** 与 opencode 一致，用户可调用的 Skill 以 source: 'skill' 的命令出现在命令列表 */
export function skillToOpenCodeCommand(skill: Skill): Command {
    const template = skill.directory
        ? [
              skill.body,
              '',
              `Base directory for this skill: ${skill.directory}`,
              'Relative paths in this skill (e.g., scripts/, references/) are relative to this base directory.'
          ].join('\n')
        : skill.body;
    return {
        name: skill.frontmatter.name,
        ...(skill.frontmatter.description ? { description: skill.frontmatter.description } : {}),
        source: 'skill',
        template,
        hints: []
    } satisfies Command;
}

export function skillsToOpenCodeCommands(skills: readonly { skill: Skill }[]): Command[] {
    const commands = new Map<string, Command>();
    for (const { skill } of skills) {
        if (!commands.has(skill.frontmatter.name)) commands.set(skill.frontmatter.name, skillToOpenCodeCommand(skill));
    }
    return [...commands.values()];
}

export function openCodeProjectId(directory: string): string {
    return `proj_${path.basename(directory) || 'unknown'}`;
}

export async function getOpenCodeProject(directory: string): Promise<Project> {
    const name = path.basename(directory) || 'unknown';
    const [isGit, time] = await Promise.all([isGitWorkTree(directory), readDirectoryTime(directory)]);
    return {
        id: openCodeProjectId(directory),
        worktree: directory,
        ...(isGit ? { vcs: 'git' as const } : {}),
        name,
        time,
        sandboxes: []
    } satisfies Project;
}

async function readDirectoryTime(directory: string): Promise<Project['time']> {
    try {
        const stat = await fs.promises.stat(directory);
        return {
            created: Math.floor(stat.birthtimeMs || stat.ctimeMs),
            updated: Math.floor(stat.mtimeMs)
        };
    } catch {
        return { created: 0, updated: 0 };
    }
}

export async function getOpenCodeVcsInfo(directory: string): Promise<VcsInfo> {
    if (!(await isGitWorkTree(directory))) return {};
    const [branch, defaultBranch] = await Promise.all([
        git(directory, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
        resolveDefaultBranch(directory)
    ]);
    return {
        ...(branch ? { branch } : {}),
        ...(defaultBranch ? { default_branch: defaultBranch } : {})
    } satisfies VcsInfo;
}

/** 与 opencode Git.defaultBranch 的判定顺序一致：主远端的 HEAD → init.defaultBranch → main → master */
async function resolveDefaultBranch(directory: string): Promise<string | undefined> {
    const remotes = lines(await git(directory, ['remote']));
    const remote = remotes.includes('origin')
        ? 'origin'
        : remotes.length === 1
          ? remotes[0]
          : remotes.includes('upstream')
            ? 'upstream'
            : remotes[0];
    if (remote) {
        const head = await git(directory, ['symbolic-ref', `refs/remotes/${remote}/HEAD`]);
        const name = head?.replace(/^refs\/remotes\//, '').slice(`${remote}/`.length);
        if (head?.startsWith(`refs/remotes/${remote}/`) && name) return name;
    }

    const branches = lines(await git(directory, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']));
    const configured = await git(directory, ['config', 'init.defaultBranch']);
    if (configured && branches.includes(configured)) return configured;
    if (branches.includes('main')) return 'main';
    if (branches.includes('master')) return 'master';
    return undefined;
}

async function isGitWorkTree(directory: string): Promise<boolean> {
    return (await git(directory, ['rev-parse', '--is-inside-work-tree'])) === 'true';
}

/** 执行 git 并返回去除首尾空白的 stdout；非 git 目录、未安装 git 或命令失败时返回 undefined */
async function git(directory: string, args: string[]): Promise<string | undefined> {
    try {
        const { stdout } = await execFileAsync('git', args, {
            cwd: directory,
            timeout: GIT_TIMEOUT_MS,
            windowsHide: true,
            env: buildChildProcessEnv()
        });
        return stdout.trim();
    } catch {
        return undefined;
    }
}

function lines(text: string | undefined): string[] {
    return (text ?? '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
}

/** opencode 的 /provider/auth 只列出可用的认证方式；OpenDesk 的模型服务都通过 API Key 接入 */
export function openCodeProviderAuthMethods(): ProviderAuthMethod[] {
    return [{ type: 'api', label: 'API key' } satisfies ProviderAuthMethod];
}
