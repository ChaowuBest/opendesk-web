import type { OpenDeskTUI } from '../entry.js';
import { HelpOverlay } from '../components/help.js';

export function registerHelpCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'help',
        description: '显示快捷键与指令帮助',
        execute: async () => {
            new HelpOverlay(tui).show();
        }
    });
}
