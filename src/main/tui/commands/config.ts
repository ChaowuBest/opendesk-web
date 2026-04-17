import type { OpenDeskTUI } from '../entry.js';
import { t } from '../../../locale/index.js';

export function registerConfigCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'config',
        description: t('config.command.description'),
        execute: async () => {
            tui.enterConfigMode();
        }
    });
}
