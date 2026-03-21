import type { OpenDeskTUI } from "../entry.js";
import { InfoOverlay } from "../components/notice.js";
import { logger } from "../../utils/logger.js";


export function registerRedoCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: "redo",
        description: "恢复最近 N 次 /undo 回退的消息，默认 1 次",
        getArgumentCompletions: (argPrefix: string) => {
            const prefix = argPrefix.trim();
            if (!prefix) {
                return [
                    { value: "1", label: "1", description: "恢复最近 1 次回退" },
                    { value: "2", label: "2", description: "恢复最近 2 次回退" },
                    { value: "3", label: "3", description: "恢复最近 3 次回退" },
                ];
            }
            return null;
        },
        execute: async (args: string) => {
            const trimmed = args.trim();
            const count = trimmed === "" ? 1 : Number(trimmed);

            if (isNaN(count) || !Number.isInteger(count)) {
                const info = new InfoOverlay(tui, {
                    title: "恢复失败",
                    message: `参数必须是一个整数，例如：/redo 2`,
                });
                info.show();
                return;
            }

            if (count < 1) {
                const info = new InfoOverlay(tui, {
                    title: "恢复失败",
                    message: `恢复次数必须大于 0，当前输入：${count}`,
                });
                info.show();
                return;
            }

            if (!tui.activeTaskId) {
                const info = new InfoOverlay(tui, {
                    title: "恢复失败",
                    message: "当前没有活跃的会话，请先开始一个对话。",
                });
                info.show();
                return;
            }

            const task = tui.taskManagerState.getTask(tui.activeTaskId);
            if (!task) {
                const info = new InfoOverlay(tui, {
                    title: "恢复失败",
                    message: "未找到当前任务。",
                });
                info.show();
                return;
            }

            const stack = tui.undoStacks.get(tui.activeTaskId);
            if (!stack || stack.length === 0) {
                const info = new InfoOverlay(tui, {
                    title: "恢复失败",
                    message: "没有可恢复的回退记录。",
                });
                info.show();
                return;
            }

            // 实际可恢复的次数
            const actualCount = Math.min(count, stack.length);
            const requestedCount = count;
            let totalRestored = 0;

            // 恢复指定次数的消息
            for (let i = 0; i < actualCount; i++) {
                const restored = stack.pop()!;
                task.chat_context.messages.push(...restored);
                totalRestored += restored.length;
            }

            tui.taskManagerState.save();
            tui.taskView.clearMessages();
            tui.taskView.rebuildFromHistory();
            tui.tui.requestRender();

            logger.info(`/redo: 已恢复 ${actualCount} 次，共 ${totalRestored} 条消息`);

            // 如果请求的次数超过可用，显示警告
            if (requestedCount > actualCount) {
                const info = new InfoOverlay(tui, {
                    title: "恢复次数不足",
                    message: `请求恢复 ${requestedCount} 次，但实际只有 ${actualCount} 次可恢复。已恢复 ${actualCount} 次。`,
                    type: "warning",
                });
                info.show();
            }
        },
    });
}
