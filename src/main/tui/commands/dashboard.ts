import { ApplicationRegistry } from "../../applications/registry.js";
import { DashboardOverlay } from "../components/dashboard.js";
import { logger } from "../../utils/logger.js";
import type { OpenDeskTUI } from "../entry.js";


export function registerDashboardCommand(tui: OpenDeskTUI): void {

    const showDashboard = async () => {
        try {
            // 从 worker 获取全局待办数据
            const todosResult = await ApplicationRegistry.callWorker('todomgr', 'listGlobalTodos', 'all');
            const todos = todosResult?.data || [];
            const tasks = tui.taskManagerState.tasks;

            // 直接获取当前已有的消息插件状态，不阻塞等待初始化完成
            let channelStates: any[] = [];
            const channelsApp = ApplicationRegistry.getApplication('channelmgr');
            if (channelsApp && 'getChannelStates' in channelsApp) {
                channelStates = (channelsApp as any).getChannelStates();
            }

            new DashboardOverlay(tui, { globalTodos: todos, tasks, channelStates }).show();
        } catch (err) {
            logger.error(`打开仪表盘失败: ${err}`);
        }
    }

    tui.commandRegistry.register({
        name: "dashboard",
        description: "查看系统仪表盘（任务、待办、状态）",
        execute: async () => {
            await showDashboard();
        },
    });
}
