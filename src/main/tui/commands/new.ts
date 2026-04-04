import type { OpenDeskTUI } from '../entry.js';
import { Key } from '@mariozechner/pi-tui';

export function registerNewCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'new',
        description: '启动新任务并发送消息',
        shortcut: Key.ctrl('n'),
        execute: async (args: string) => {
            await tui.createNewTask();
            if (args.trim()) {
                await tui.onRequestSubmit(args.trim());
            }
        }
    });
}
