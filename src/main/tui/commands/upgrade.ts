import type { OpenDeskTUI } from '../entry.js';
import { UpgradeOverlay } from '../components/upgrade.js';
import { t } from '../../../locale/index.js';

export function registerUpgradeCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'upgrade',
        description: t('upgrade.description'),
        execute: async () => {
            const upgradeOverlay = new UpgradeOverlay(tui);
            upgradeOverlay.show();
        }
    });
}
