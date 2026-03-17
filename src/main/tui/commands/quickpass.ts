import type { OpenDeskTUI } from "../entry.js";
import { InfoOverlay } from "../components/notice.js";
import { QuickPassHelper } from "../../utils/quickpass.js";
import { logger } from "../../utils/logger.js";


export function registerQuickpassCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: "quickpass",
        description: "导出快捷口令，用法：/quickpass config base|all",
        getArgumentCompletions: (argPrefix: string) => {
            const options = [
                { value: 'config base', label: 'config base', description: '导出基础设置口令（不含应用配置）' },
                { value: 'config all', label: 'config all', description: '导出全部设置口令' },
            ];
            const prefix = argPrefix.trimEnd().toLowerCase();
            return options.filter(opt => opt.value.startsWith(prefix));
        },
        execute: async (args: string) => {
            const parts = args.trim().split(/\s+/);
            const subCommand = (parts[0] || '').toLowerCase();
            const subArg = (parts[1] || '').toLowerCase();

            if (subCommand === 'config') {
                if (subArg === 'base') {
                    try {
                        const quickpass = QuickPassHelper.exportBaseConfig();
                        const info = new InfoOverlay(tui, {
                            title: "基础设置口令",
                            message: `请复制以下口令并发送给对方：\n\n${quickpass}`,
                            closeLabel: "确定",
                            fullWidth: true,
                        });
                        info.show();
                    } catch (err: unknown) {
                        const info = new InfoOverlay(tui, {
                            title: "导出失败",
                            message: `导出基础设置口令失败：${err instanceof Error ? err.message : String(err)}`,
                        });
                        info.show();
                    }
                } else if (subArg === 'all') {
                    try {
                        const quickpass = QuickPassHelper.exportAllConfig();
                        const info = new InfoOverlay(tui, {
                            title: "全部设置口令",
                            message: `请复制以下口令并发送给对方：\n\n${quickpass}`,
                            closeLabel: "确定",
                            fullWidth: true,
                        });
                        info.show();
                    } catch (err: unknown) {
                        const info = new InfoOverlay(tui, {
                            title: "导出失败",
                            message: `导出全部设置口令失败：${err instanceof Error ? err.message : String(err)}`,
                        });
                        info.show();
                    }
                } else {
                    logger.warn('用法：/quickpass config base|all');
                }
            } else {
                logger.warn('用法：/quickpass config base|all');
            }
        },
    });
}
