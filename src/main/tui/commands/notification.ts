import type { OpenDeskTUI } from '../entry.js';
import { t } from '../../../locale/index.js';

export function registerNotificationCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'notification',
        description: t('notification.description'),
        execute: async () => {
            tui.showNotificationCenter();
        }
    });
}
