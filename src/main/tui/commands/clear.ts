import type { OpenDeskTUI } from "../entry.js";
import { ConfirmOverlay } from "../components/notice.js";


export function registerClearCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: "clear",
        description: "删除所有任务历史",
        execute: async () => {
            const confirm = new ConfirmOverlay(tui, {
                title: "确认删除",
                message: "确定要删除所有任务历史吗？此操作不可恢复。",
                confirmLabel: "删除所有",
                cancelLabel: "取消"
            });
            confirm.show(() => {
                tui.taskManagerState.clearAllTasks();
                tui.clearActiveTask();
            });
        },
    });
}
