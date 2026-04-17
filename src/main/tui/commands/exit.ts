import type { OpenDeskTUI } from '../entry.js';
import { ConfirmOverlay } from '../components/notice.js';
import { t } from '../../../locale/index.js';

export function registerExitCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'exit',
        description: t('exit.description'),
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
