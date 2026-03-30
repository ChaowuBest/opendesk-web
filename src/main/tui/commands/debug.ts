import type { OpenDeskTUI } from "../entry.js";
import { setDebugMode, getDebugMode } from "../../utils/logger.js";
import { logger } from "../../utils/logger.js";
import { InfoOverlay } from "../components/notice.js";


export function registerDebugCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: "debug",
        description: "调试命令，用法: /debug log [on|off] | /debug taskid",
        getArgumentCompletions: (argPrefix: string) => {
            const subCommands = ['log', 'taskid'];
            const logOptions = ['on', 'off'];

            // 解析参数
            const parts = argPrefix.trim().split(/\s+/);
            const firstArg = parts[0]?.toLowerCase() || '';
            const secondArg = parts[1]?.toLowerCase() || '';

            // 如果还没有输入第一个参数，或者正在输入第一个参数
            if (parts.length === 1) {
                const matchingSubCommands = subCommands.filter(cmd => cmd.startsWith(firstArg));
                if (matchingSubCommands.length > 0) {
                    return matchingSubCommands.map(cmd => ({
                        value: cmd,
                        label: cmd,
                        description: cmd === 'log' ? '调试日志开关 (on|off)' : '显示当前任务ID'
                    }));
                }
            }

            // 如果第一个参数是 log，提供 on/off 选项
            if (firstArg === 'log' && parts.length === 2) {
                return logOptions
                    .filter(opt => opt.startsWith(secondArg))
                    .map(opt => ({
                        value: `log ${opt}`,
                        label: opt,
                        description: opt === 'on' ? '开启调试日志' : '关闭调试日志'
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
                    logger.info('调试日志已开启');
                } else if (subArg === 'off') {
                    setDebugMode(false);
                    logger.info('调试日志已关闭');
                } else {
                    const currentMode = getDebugMode();
                    logger.info(`当前调试日志状态: ${currentMode ? 'on' : 'off'}`);
                }
            } else if (subCommand === 'taskid') {
                // /debug taskid
                const taskId = tui.activeTaskId;
                if (taskId) {
                    const info = new InfoOverlay(tui, {
                        title: "当前任务ID",
                        message: taskId,
                        fullWidth: true
                    });
                    info.show();
                } else {
                    const info = new InfoOverlay(tui, {
                        title: "提示",
                        message: "当前没有活跃任务"
                    });
                    info.show();
                }
            } else {
                // 未知子命令或无参数，显示帮助
                if (!subCommand) {
                    logger.info('用法: /debug log [on|off] | /debug taskid');
                } else {
                    logger.info(`未知子命令: ${subCommand}。用法: /debug log [on|off] | /debug taskid`);
                }
            }
        },
    });
}
