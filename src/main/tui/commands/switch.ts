import type { OpenDeskTUI } from '../entry.js';
import { TaskSwitcher } from '../components/taskswitcher.js';
import { Key } from '@mariozechner/pi-tui';
import { t } from '../../../locale/index.js';

export function registerSwitchCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'switch',
        description: t('switch.description'),
        shortcut: Key.ctrl('l'),
        execute: async () => {
            const switcher = new TaskSwitcher(tui);
            switcher.show();
        }
    });
}
