import type { OpenDeskTUI } from "../entry.js";
import { InfoOverlay } from "../components/notice.js";


export function registerForkCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: "fork",
        description: "复制当前会话并切换到新会话",
        execute: async () => {
            if (!tui.activeTaskId) {
                const info = new InfoOverlay(tui, {
                    title: "Fork 失败",
                    message: "没有活跃的任务",
                    closeLabel: "确定"
                });
                info.show();
                return;
            }

            const currentTask = tui.taskManagerState.getTask(tui.activeTaskId);
            if (!currentTask) {
                const info = new InfoOverlay(tui, {
                    title: "Fork 失败",
                    message: "未找到当前任务",
                    closeLabel: "确定"
                });
                info.show();
                return;
            }

            const forkedTask = currentTask.fork();
            tui.switchToTask(forkedTask);

            const info = new InfoOverlay(tui, {
                title: "Fork 成功",
                message: `已切换到新的会话副本`,
                closeLabel: "确定"
            });
            info.show();
        },
    });
}
