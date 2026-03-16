import type { OpenDeskTUI } from "../entry.js";
import { UpgradeOverlay } from "../components/upgrade.js";


export function registerUpgradeCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: "upgrade",
        description: "升级 OpenDesk CLI 到最新版本",
        execute: async () => {
            const upgradeOverlay = new UpgradeOverlay(tui);
            upgradeOverlay.show();
        },
    });
}
