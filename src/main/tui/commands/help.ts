import type { OpenDeskTUI } from '../entry.js';
import { HelpOverlay } from '../components/help.js';
import { t } from '../../../locale/index.js';

export function registerHelpCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'help',
        description: t('help.description'),
        execute: async () => {
            new HelpOverlay(tui).show();
        }
    });
}
