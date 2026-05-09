export { SlashCommandRegistry, type SlashCommandHandler } from './base.js';
import type { OpenDeskTUI } from '../entry.js';
import { registerNewCommand } from './new.js';
import { registerSwitchCommand } from './switch.js';
import { registerHelpCommand } from './help.js';
import { registerExitCommand } from './exit.js';
import { registerQuitCommand } from './quit.js';
import { registerManualCommand } from './manual.js';
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
import { registerMemoryCommand } from './memory.js';
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

/**
 * 注册所有内置斜杠命令到 TUI
 */
export function registerAllCommands(tui: OpenDeskTUI): void {
    registerNewCommand(tui);
    registerSwitchCommand(tui);
    registerHelpCommand(tui);
    registerExitCommand(tui);
    registerQuitCommand(tui);
    registerManualCommand(tui);
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
    registerMemoryCommand(tui);
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
}
