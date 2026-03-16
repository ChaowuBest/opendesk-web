import type { OpenDeskTUI } from "../entry.js";


export function registerLogCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: "log",
        description: "显示日志面板，用法: /log [off|last|all]",
        getArgumentCompletions: (argPrefix: string) => {
            const options = ['off', 'last', 'all'];
            return options
                .filter(opt => opt.startsWith(argPrefix.toLowerCase()))
                .map(opt => ({ value: opt, label: opt, description: opt === 'off' ? '不显示' : (opt === 'last' ? '最后10条' : '全部') }));
        },
        execute: async (args: string) => {
            const modeArg = args.trim().toLowerCase();
            if (modeArg === 'off' || modeArg === 'last' || modeArg === 'all') {
                tui.logPanel.setMode(modeArg);
            } else {
                tui.logPanel.setMode('off');
            }
        },
    });
}
