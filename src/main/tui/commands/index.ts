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

export { SlashCommandRegistry, type SlashCommandHandler } from './base.js';
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
import { registerDashboardCommand } from './dashboard.js';
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

/**
 * 注册所有内置斜杠命令到 TUI
 */
export function registerAllCommands(tui: OpenDeskTUI): void {
    registerNewCommand(tui);
    registerSwitchCommand(tui);
    registerHelpCommand(tui);
    registerExitCommand(tui);
    registerQuitCommand(tui);
    registerCancelCommand(tui);
    registerClearCommand(tui);
    registerExportCommand(tui);
    registerImportCommand(tui);
    registerDashboardCommand(tui);
    registerConfigCommand(tui);
    registerLogCommand(tui);
    registerDebugCommand(tui);
    registerStopCommand(tui);
    registerUpgradeCommand(tui);
    registerRenameCommand(tui);
    registerForkCommand(tui);
    registerCompactCommand(tui);
    registerBookmarkCommand(tui);
    registerQuickpassCommand(tui);
    registerNotificationCommand(tui);
    registerUndoCommand(tui);
    registerRedoCommand(tui);
    registerBtwCommand(tui);
    registerRecoverCommand(tui);
    registerModeCommand(tui);
    registerReasonCommand(tui);
    registerContextCommand(tui);
    registerModelCommand(tui);
    registerGoalCommand(tui);
    registerUsageCommand(tui);
    registerFeedbackCommand(tui);
    registerAccountCommands(tui);
    registerLoginCommand(tui);
    registerLogoutCommand(tui);
}
