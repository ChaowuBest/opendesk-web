import type { OpenDeskTUI } from '../entry.js';

export function registerCancelCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'cancel',
        description: '撤销消息队列中的所有待发送消息',
        execute: async () => {
            tui.inputArea.clearMessageQueue();
            if (tui.activeTaskId) {
                const currentTask = tui.taskManagerState.getTask(tui.activeTaskId);
                if (currentTask) {
                    currentTask.message_queue = tui.inputArea.getQueueSnapshot();
                }
            }
        }
    });
}
