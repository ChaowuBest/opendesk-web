import type { OpenDeskTUI } from '../entry.js';
import { TaskSwitcher } from '../components/taskswitcher.js';
import type { KeyId } from '@earendil-works/pi-tui';
import { getShortcuts } from '../../utils/setting.js';
import { t } from '../../../locale/index.js';

export function registerSwitchCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'switch',
        description: t('switch.description'),
        get shortcut(): KeyId {
            return getShortcuts().list_tasks as KeyId;
        },
        execute: async () => {
            const switcher = new TaskSwitcher(tui);
            switcher.show();
        }
    });
}
