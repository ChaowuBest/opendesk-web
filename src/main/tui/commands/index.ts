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

import { SlashCommandRegistry, type SlashCommandHandler } from './base.js';
export { SlashCommandRegistry, type SlashCommandHandler };
import type { OpenDeskTUI } from '../entry.js';
import { registerNewCommand } from './new.js';
import { registerSwitchCommand } from './switch.js';
import { registerHelpCommand } from './help.js';
import { registerExitCommand } from './exit.js';
import { registerQuitCommand } from './quit.js';
import { registerCancelCommand } from './cancel.js';
import { registerClearCommand } from './clear.js';
import { registerExportCommand } from './export.js';
import { registerImportCommand } from './import.js';
import { registerConfigCommand } from './config.js';
import { registerLogCommand } from './log.js';
import { registerDebugCommand } from './debug.js';
import { registerStopCommand } from './stop.js';
import { registerUpgradeCommand } from './upgrade.js';
import { registerRenameCommand } from './rename.js';
import { registerForkCommand } from './fork.js';
import { registerCompactCommand } from './compact.js';
import { registerBookmarkCommand } from './bookmark.js';
import { registerQuickpassCommand } from './quickpass.js';
import { registerNotificationCommand } from './notification.js';
import { registerUndoCommand } from './undo.js';
import { registerRedoCommand } from './redo.js';
import { registerBtwCommand } from './btw.js';
import { registerRecoverCommand } from './recover.js';
import { registerModeCommand } from './mode.js';
import { registerReasonCommand } from './reason.js';
import { registerContextCommand } from './context.js';
import { registerModelCommand } from './model.js';
import { registerGoalCommand } from './goal.js';
import { registerUsageCommand } from './usage.js';
import { registerFeedbackCommand } from './feedback.js';
import { registerAccountCommands, registerLoginCommand, registerLogoutCommand } from './account.js';
import { registerDisplayCommand } from './display.js';
import { registerLanguageCommand } from './language.js';

const BUILTIN_COMMAND_REGISTRARS: Array<(tui: OpenDeskTUI) => void> = [
    registerNewCommand,
    registerSwitchCommand,
    registerHelpCommand,
    registerExitCommand,
    registerQuitCommand,
    registerCancelCommand,
    registerClearCommand,
    registerExportCommand,
    registerImportCommand,
    registerConfigCommand,
    registerLogCommand,
    registerDebugCommand,
    registerStopCommand,
    registerUpgradeCommand,
    registerRenameCommand,
    registerForkCommand,
    registerCompactCommand,
    registerBookmarkCommand,
    registerQuickpassCommand,
    registerNotificationCommand,
    registerUndoCommand,
    registerRedoCommand,
    registerBtwCommand,
    registerRecoverCommand,
    registerModeCommand,
    registerReasonCommand,
    registerContextCommand,
    registerModelCommand,
    registerGoalCommand,
    registerUsageCommand,
    registerFeedbackCommand,
    registerAccountCommands,
    registerLoginCommand,
    registerLogoutCommand,
    registerDisplayCommand,
    registerLanguageCommand
];

/**
 * 内置命令注册状态，按 TUI 实例隔离，供语言切换后重新注册使用（不含应用与插件命令）。
 * 用 WeakMap 而非实例字段，避免为一个刷新用的中间态污染 OpenDeskTUI 的公开形状。
 */
interface BuiltinCommandState {
    /** 是否执行过内置命令注册（用于区分「嵌入式只注册了部分命令」） */
    registered: boolean;
    /** 当前仍由内置注册器持有的命令 -> 注册时写入的 handler 对象 */
    owned: Map<string, SlashCommandHandler>;
}

const builtinCommandStateByTui = new WeakMap<OpenDeskTUI, BuiltinCommandState>();

function builtinCommandStateOf(tui: OpenDeskTUI): BuiltinCommandState {
    let state = builtinCommandStateByTui.get(tui);
    if (!state) {
        state = { registered: false, owned: new Map<string, SlashCommandHandler>() };
        builtinCommandStateByTui.set(tui, state);
    }
    return state;
}

/** 依次执行注册器，并记录本次新增的命令（名字 -> 写入注册表的 handler） */
function runBuiltinRegistrars(tui: OpenDeskTUI, owned: Map<string, SlashCommandHandler>): void {
    for (const register of BUILTIN_COMMAND_REGISTRARS) {
        const before = new Set(tui.commandRegistry.getAll().map((cmd) => cmd.name));
        register(tui);
        for (const cmd of tui.commandRegistry.getAll()) {
            if (before.has(cmd.name)) continue;
            const handler = tui.commandRegistry.get(cmd.name);
            if (handler) owned.set(cmd.name, handler);
        }
    }
}

/**
 * 注册所有内置斜杠命令到 TUI
 */
export function registerAllCommands(tui: OpenDeskTUI): void {
    const state = builtinCommandStateOf(tui);
    state.registered = true;
    runBuiltinRegistrars(tui, state.owned);
}

/**
 * 语言切换后重新注册内置命令，让 /help 与自动补全里的描述文案按新语言解析。
 * 命令描述是在注册时求值的，不重注册会停留在切换前的语言。
 */
export function refreshBuiltinCommands(tui: OpenDeskTUI): void {
    const state = builtinCommandStateOf(tui);
    // 从未注册过内置命令（如嵌入式只注册了部分命令）时不应借刷新把整套内置命令塞进来
    if (!state.registered) return;
    // Map 按插入序展示（/help、自动补全），重注册会把内置命令挤到末尾，这里记录原序以便还原
    const orderBefore = tui.commandRegistry.getAll().map((cmd) => cmd.name);
    const previous = [...state.owned];
    state.owned.clear();
    for (const [name, handler] of previous) {
        // 已被插件 registerOverride 接管的同名命令不抢回，否则一次语言切换会把插件的覆盖顶掉
        if (tui.commandRegistry.get(name) !== handler) continue;
        tui.commandRegistry.unregister(name);
    }
    runBuiltinRegistrars(tui, state.owned);
    tui.commandRegistry.reorder(orderBefore);
}
