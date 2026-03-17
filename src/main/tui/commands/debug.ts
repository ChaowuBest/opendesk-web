import type { OpenDeskTUI } from "../entry.js";
import { setDebugMode, getDebugMode } from "../../utils/logger.js";
import { logger } from "../../utils/logger.js";


export function registerDebugCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: "debug",
        description: "调试模式开关，用法: /debug [on|off]",
        getArgumentCompletions: (argPrefix: string) => {
            const options = ['on', 'off'];
            return options
                .filter(opt => opt.startsWith(argPrefix.toLowerCase()))
                .map(opt => ({ value: opt, label: opt, description: opt === 'on' ? '开启调试模式' : '关闭调试模式' }));
        },
        execute: async (args: string) => {
            const modeArg = args.trim().toLowerCase();
            if (modeArg === 'on') {
                setDebugMode(true);
                logger.info('调试模式已开启');
            } else if (modeArg === 'off') {
                setDebugMode(false);
                logger.info('调试模式已关闭');
            } else {
                const currentMode = getDebugMode();
                logger.info(`当前调试模式: ${currentMode ? 'on' : 'off'}`);
            }
        },
    });
}
