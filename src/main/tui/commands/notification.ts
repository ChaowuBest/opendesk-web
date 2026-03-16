import type { OpenDeskTUI } from "../entry.js";


export function registerNotificationCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: "notification",
        description: "打开通知中心，查看所有通知",
        execute: async () => {
            tui.showNotificationCenter();
        },
    });
}
