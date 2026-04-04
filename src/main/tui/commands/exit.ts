import type { OpenDeskTUI } from '../entry.js';
import { ConfirmOverlay } from '../components/notice.js';

export function registerExitCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'exit',
        description: '退出 OpenDesk',
        execute: async () => {
            const confirm = new ConfirmOverlay(tui, {
                title: '确认退出',
                message: '确定要退出 OpenDesk 吗？',
                confirmLabel: '退出',
                cancelLabel: '取消'
            });
            confirm.show(async () => {
                await tui.exit();
            });
        }
    });
}
