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
 * GUI 专用 Slash Command 系统。
 * 每个命令有 name、description、icon，与技能一起出现在 AgentInput 的 / 触发菜单中。
 */

import { showConfirmModal } from './confirmModal.js';
import { createRendererTranslator } from '../locale.ts';

// ---- 颜色方案（与技能柔和色区分，使用更中性的色调）----
const CMD_COLORS = { bg: '#F0F0F5', text: '#636366' };
const CMD_DANGER_COLORS = { bg: '#FDE9E9', text: '#DC2626' };

export interface SlashCommandDef {
    /** 命令名（不含 /） */
    name: string;
    /** 一行简短介绍 */
    description: string;
    /** FontAwesome icon class */
    icon: string;
    /** 图标容器背景色 */
    iconBg: string;
    /** 图标颜色 */
    iconColor: string;
    /** 是否为危险操作（红色高亮） */
    danger?: boolean;
    /** 是否需要在命令后继续输入参数 */
    acceptsArgs?: boolean;
}

export interface SlashCommandContext {
    globalControlAPI: any;
    taskManagerAPI: any;
    currentTaskId: string | null;
    stopCallback: (() => void) | null;
    /** 清空当前消息队列 */
    clearMessageQueue: (() => void) | null;
}

type GoalCommandResponse = {
    ok?: boolean;
    status?: string;
    summary?: any;
    messageKey?: string;
    messageArgs?: Record<string, string | number>;
    errorCode?: string;
};

const GOAL_SUBCOMMANDS = ['help', 'pause', 'resume', 'clear'];

let t = createRendererTranslator();

function updateTranslator(setting: unknown): void {
    t = createRendererTranslator(setting as any);
}

if (typeof window !== 'undefined') {
    const settingAPI = (window as any).settingAPI;
    void settingAPI
        ?.loadSettingObject?.()
        .then(updateTranslator)
        .catch(() => {});
    settingAPI?.onSettingChanged?.(updateTranslator);
}

function showGoalInfo(message: string): void {
    if (typeof window !== 'undefined' && typeof window.alert === 'function') {
        window.alert(message);
    }
}

function showGoalHelp(): void {
    showGoalInfo(t('goal.help'));
}

function showGoalResult(result: GoalCommandResponse | undefined): void {
    if (!result || result.ok !== false) return;
    if (result.messageKey === 'goal.help') {
        showGoalHelp();
        return;
    }
    showGoalInfo(t(result.messageKey ?? 'goal.error.unknown', result.messageArgs));
}

function getGoalSummary(statusResult: any): any {
    return statusResult?.summary ?? statusResult?.data?.summary ?? null;
}

function isTerminalGoalStatus(status: unknown): boolean {
    return status === 'complete' || status === 'cleared';
}

async function fetchGoalSummary(ctx: SlashCommandContext, taskId: string): Promise<any> {
    if (!ctx.taskManagerAPI?.getGoalStatus) return null;
    try {
        return getGoalSummary(await ctx.taskManagerAPI.getGoalStatus(taskId));
    } catch {
        return null;
    }
}

async function ensureGoalTask(ctx: SlashCommandContext): Promise<{ taskId: string | null; createdTask: boolean }> {
    if (ctx.currentTaskId) {
        return { taskId: ctx.currentTaskId, createdTask: false };
    }
    if (!ctx.taskManagerAPI?.createTask) {
        return { taskId: null, createdTask: false };
    }
    const taskId = await ctx.taskManagerAPI.createTask({});
    return { taskId, createdTask: true };
}

async function executeGoalSubcommand(
    subcommand: string,
    rest: string,
    ctx: SlashCommandContext,
    taskId: string
): Promise<void> {
    if (subcommand === 'pause') {
        if (rest.trim().length > 0) {
            showGoalResult({ ok: false, messageKey: 'goal.pause.unexpected_args' });
            return;
        }
        showGoalResult(await ctx.taskManagerAPI?.pauseGoal?.(taskId));
        return;
    }
    if (subcommand === 'resume') {
        if (rest.trim().length > 0) {
            showGoalResult({ ok: false, messageKey: 'goal.resume.unexpected_args' });
            return;
        }
        showGoalResult(await ctx.taskManagerAPI?.resumeGoal?.(taskId));
        return;
    }
    if (subcommand === 'clear') {
        const result = await ctx.taskManagerAPI?.clearGoal?.(taskId);
        showGoalResult(result);
        if (result?.ok !== false) {
            ctx.clearMessageQueue?.();
        }
    }
}

async function executeGoalCommand(ctx: SlashCommandContext, args: string): Promise<void> {
    const trimmed = args.trim();
    if (!trimmed) {
        showGoalHelp();
        return;
    }

    const firstSpace = trimmed.indexOf(' ');
    const subcommand = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();
    const rest = firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1);
    const isGoalSubcommand = GOAL_SUBCOMMANDS.includes(subcommand);

    if (subcommand === 'help' || subcommand === 'status') {
        showGoalHelp();
        return;
    }

    if (isGoalSubcommand) {
        if (!ctx.currentTaskId) {
            showGoalInfo(t('goal.error.no_task'));
            return;
        }
        await executeGoalSubcommand(subcommand, rest, ctx, ctx.currentTaskId);
        return;
    }

    try {
        const { taskId, createdTask } = await ensureGoalTask(ctx);
        if (!taskId) {
            showGoalInfo(t('goal.error.no_task'));
            return;
        }

        const currentGoal = createdTask ? null : await fetchGoalSummary(ctx, taskId);
        const shouldEditCurrentGoal = currentGoal && !isTerminalGoalStatus(currentGoal.status);
        if (shouldEditCurrentGoal) {
            showGoalResult(await ctx.taskManagerAPI?.editGoal?.(taskId, trimmed));
            return;
        }

        const result = await ctx.taskManagerAPI?.createGoal?.(taskId, trimmed, undefined);
        showGoalResult(result);
        if (createdTask) {
            ctx.globalControlAPI?.openTask?.(taskId);
        }
    } catch (error: any) {
        showGoalInfo(t('goal.renderer.action_failed', { message: error?.message || String(error) }));
    }
}

// ---- 命令定义 ----

const SLASH_COMMANDS: SlashCommandDef[] = [
    {
        name: 'new',
        description: '创建新任务',
        icon: 'fa-plus',
        iconBg: CMD_COLORS.bg,
        iconColor: CMD_COLORS.text
    },
    {
        name: 'help',
        description: '打开帮助文档',
        icon: 'fa-circle-question',
        iconBg: CMD_COLORS.bg,
        iconColor: CMD_COLORS.text
    },
    {
        name: 'goal',
        description: '创建或管理跟进目标',
        icon: 'fa-bullseye',
        iconBg: CMD_COLORS.bg,
        iconColor: CMD_COLORS.text,
        acceptsArgs: true
    },
    {
        name: 'exit',
        description: '退出 OpenDesk',
        icon: 'fa-right-from-bracket',
        iconBg: CMD_DANGER_COLORS.bg,
        iconColor: CMD_DANGER_COLORS.text,
        danger: true
    },
    {
        name: 'quit',
        description: '退出 OpenDesk',
        icon: 'fa-right-from-bracket',
        iconBg: CMD_DANGER_COLORS.bg,
        iconColor: CMD_DANGER_COLORS.text,
        danger: true
    },
    {
        name: 'cancel',
        description: '取消当前发送队列中的消息',
        icon: 'fa-ban',
        iconBg: CMD_COLORS.bg,
        iconColor: CMD_COLORS.text
    },
    {
        name: 'fork',
        description: '复制当前任务为新任务',
        icon: 'fa-code-fork',
        iconBg: CMD_COLORS.bg,
        iconColor: CMD_COLORS.text
    },
    {
        name: 'compact',
        description: '手动压缩当前任务上下文',
        icon: 'fa-compress',
        iconBg: CMD_COLORS.bg,
        iconColor: CMD_COLORS.text
    },
    {
        name: 'stop',
        description: '停止当前正在运行的任务',
        icon: 'fa-stop',
        iconBg: CMD_DANGER_COLORS.bg,
        iconColor: CMD_DANGER_COLORS.text,
        danger: true
    },
    {
        name: 'config',
        description: '打开设置界面',
        icon: 'fa-gear',
        iconBg: CMD_COLORS.bg,
        iconColor: CMD_COLORS.text
    }
];

/**
 * 获取所有 GUI slash command 的定义列表
 */
export function getSlashCommands(): SlashCommandDef[] {
    return SLASH_COMMANDS;
}

/**
 * 根据用户输入的前缀过滤匹配的命令
 */
export function filterSlashCommands(prefix: string): SlashCommandDef[] {
    if (!prefix) return SLASH_COMMANDS;
    const lower = prefix.toLowerCase();
    return SLASH_COMMANDS.filter((cmd) => cmd.name.toLowerCase().startsWith(lower));
}

/**
 * 执行指定的 slash command
 */
export async function executeSlashCommand(name: string, ctx: SlashCommandContext, args = ''): Promise<void> {
    switch (name) {
        case 'new':
            ctx.globalControlAPI?.openHomePage();
            break;

        case 'help': {
            // 先打开浏览器应用，然后导航到帮助页面
            ctx.globalControlAPI?.openApplication('browser');
            let navigated = false;
            const doNavigate = () => {
                if (navigated) return;
                const browserWidget = document.querySelector('#nonAppSlot > browser-entry-widget');
                if (browserWidget && typeof (browserWidget as any).navigateTo === 'function') {
                    (browserWidget as any).navigateTo('https://opendesk.bitclub.ai/docs/quickstart/desktop/');
                    navigated = true;
                }
            };
            // 延迟导航以确保浏览器 app 已挂载；两次尝试中任意一次成功即停止
            setTimeout(doNavigate, 300);
            setTimeout(doNavigate, 800);
            break;
        }

        case 'goal': {
            await executeGoalCommand(ctx, args);
            break;
        }

        case 'exit':
        case 'quit': {
            const confirmed = await showConfirmModal({
                icon: 'fa-right-from-bracket',
                iconBg: '#FEF2F2',
                iconColor: '#DC2626',
                title: '退出 OpenDesk',
                message: '确定要退出 OpenDesk 吗？',
                confirmText: '退出',
                danger: true
            });
            if (confirmed) {
                // 使用 app:quit IPC 完全退出应用，而非仅关闭窗口
                if ((window as any).windowControlAPI?.quitApp) {
                    (window as any).windowControlAPI.quitApp();
                } else {
                    window.close();
                }
            }
            break;
        }

        case 'cancel':
            if (ctx.clearMessageQueue) {
                ctx.clearMessageQueue();
            }
            break;

        case 'fork': {
            if (!ctx.currentTaskId || !ctx.taskManagerAPI) break;
            try {
                const forkedTaskId = await ctx.taskManagerAPI.forkTask(ctx.currentTaskId);
                ctx.globalControlAPI?.openTask(forkedTaskId);
            } catch (err) {
                console.error('Failed to fork task:', err);
            }
            break;
        }

        case 'compact':
            if (ctx.currentTaskId && ctx.taskManagerAPI?.compactTask) {
                try {
                    await ctx.taskManagerAPI.compactTask(ctx.currentTaskId);
                } catch (err) {
                    console.error('Failed to compact task:', err);
                }
            }
            break;

        case 'stop':
            if (ctx.stopCallback) {
                ctx.stopCallback();
            }
            break;

        case 'config':
            ctx.globalControlAPI?.openSettingEditor();
            break;

        default:
            console.warn(`Unknown slash command: /${name}`);
    }
}
