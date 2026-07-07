import type { OpenDeskTUI } from '../entry.js';
import { Key } from '@earendil-works/pi-tui';
import { t } from '../../../locale/index.js';

export function registerNewCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'new',
        description: t('new.description'),
        shortcut: Key.ctrl('n'),
        execute: async (args: string) => {
            await tui.createNewTask();
            if (args.trim()) {
                await tui.onRequestSubmit(args.trim());
            }
        }
    });
}
