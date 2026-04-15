import type { OpenDeskTUI } from '../entry.js';

export function registerConfigCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'config',
        description: '打开系统设置',
        execute: async () => {
            tui.enterConfigMode();
        }
    });
}
