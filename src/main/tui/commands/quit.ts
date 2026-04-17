import type { OpenDeskTUI } from '../entry.js';
import { ConfirmOverlay } from '../components/notice.js';
import { t } from '../../../locale/index.js';

export function registerQuitCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'quit',
        description: t('quit.description'),
        execute: async () => {
            const confirm = new ConfirmOverlay(tui, {
                title: t('confirm.exit.title'),
                message: t('confirm.exit.message'),
                confirmLabel: t('common.exit'),
                cancelLabel: t('common.cancel')
            });
            confirm.show(async () => {
                await tui.exit();
            });
        }
    });
}
