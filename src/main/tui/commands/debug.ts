import type { OpenDeskTUI } from '../entry.js';
import { setDebugMode, getDebugMode } from '../../utils/logger.js';
import { logger } from '../../utils/logger.js';
import { InfoOverlay } from '../components/notice.js';
import { t } from '../../../locale/index.js';

export function registerDebugCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'debug',
        description: t('debug.description'),
        getArgumentCompletions: (argPrefix: string) => {
            const subCommands = ['log', 'taskid'];
            const logOptions = ['on', 'off'];

            // 解析参数
            const parts = argPrefix.trim().split(/\s+/);
            const firstArg = parts[0]?.toLowerCase() || '';
            const secondArg = parts[1]?.toLowerCase() || '';

            // 如果还没有输入第一个参数，或者正在输入第一个参数
            if (parts.length === 1) {
                const matchingSubCommands = subCommands.filter((cmd) => cmd.startsWith(firstArg));
                if (matchingSubCommands.length > 0) {
                    return matchingSubCommands.map((cmd) => ({
                        value: cmd,
                        label: cmd,
                        description: cmd === 'log' ? t('debug.log.description') : t('debug.taskid.description')
                    }));
                }
            }

            // 如果第一个参数是 log，提供 on/off 选项
            if (firstArg === 'log' && parts.length === 2) {
                return logOptions
                    .filter((opt) => opt.startsWith(secondArg))
                    .map((opt) => ({
                        value: `log ${opt}`,
                        label: opt,
                        description: opt === 'on' ? t('debug.log.on.description') : t('debug.log.off.description')
                    }));
            }

            return [];
        },
        execute: async (args: string) => {
            const trimmedArgs = args.trim().toLowerCase();
            const parts = trimmedArgs.split(/\s+/);
            const subCommand = parts[0];
            const subArg = parts[1];

            if (subCommand === 'log') {
                // /debug log [on|off]
                if (subArg === 'on') {
                    setDebugMode(true);
                    logger.info('Debug log enabled');
                } else if (subArg === 'off') {
                    setDebugMode(false);
                    logger.info('Debug log disabled');
                } else {
                    const currentMode = getDebugMode();
                    logger.info(`Current debug log status: ${currentMode ? 'on' : 'off'}`);
                }
            } else if (subCommand === 'taskid') {
                // /debug taskid
                const taskId = tui.activeTaskId;
                if (taskId) {
                    const info = new InfoOverlay(tui, {
                        title: t('debug.current.task.id'),
                        message: taskId,
                        fullWidth: true
                    });
                    info.show();
                } else {
                    const info = new InfoOverlay(tui, {
                        title: t('debug.hint'),
                        message: t('debug.no.active.task')
                    });
                    info.show();
                }
            } else {
                // 未知子命令或无参数，显示帮助
                if (!subCommand) {
                    logger.info('Usage: /debug log [on|off] | /debug taskid');
                } else {
                    logger.info(`Unknown subcommand: ${subCommand}. Usage: /debug log [on|off] | /debug taskid`);
                }
            }
        }
    });
}
