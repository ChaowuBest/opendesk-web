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
}

export interface SlashCommandContext {
    globalControlAPI: any;
    taskManagerAPI: any;
    currentTaskId: string | null;
    stopCallback: (() => void) | null;
    /** 清空当前消息队列 */
    clearMessageQueue: (() => void) | null;
    /** 显示确认弹窗 */
    showConfirmModal: typeof showConfirmModal;
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
export async function executeSlashCommand(name: string, ctx: SlashCommandContext): Promise<void> {
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
                // 使用 IPC 关闭窗口（而非 window.close()），确保 Electron 正确退出
                if ((window as any).windowControlAPI?.close) {
                    (window as any).windowControlAPI.close();
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
