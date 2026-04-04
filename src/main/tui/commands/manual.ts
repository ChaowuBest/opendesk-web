import type { OpenDeskTUI } from '../entry.js';
import { InfoOverlay } from '../components/notice.js';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import open from 'open';

export function registerManualCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'manual',
        description: '打开使用手册',
        execute: async () => {
            const __filename = fileURLToPath(import.meta.url);
            const __dirname = path.dirname(__filename);

            const possiblePaths = [
                path.join(__dirname, '..', 'manual.html'),
                path.join(__dirname, '..', '..', '..', 'docs', 'manual.html'),
                path.join(__dirname, '..', '..', 'docs', 'manual.html')
            ];

            let manualPath: string | null = null;
            for (const p of possiblePaths) {
                if (fs.existsSync(p)) {
                    manualPath = p;
                    break;
                }
            }

            if (manualPath) {
                try {
                    await open(manualPath);
                } catch (err: unknown) {
                    const info = new InfoOverlay(tui, {
                        title: '打开失败',
                        message: `无法打开手册: ${err instanceof Error ? err.message : String(err)}`,
                        closeLabel: '确定'
                    });
                    info.show();
                }
            } else {
                const info = new InfoOverlay(tui, {
                    title: '文件未找到',
                    message: '未找到 manual.html 文件',
                    closeLabel: '确定'
                });
                info.show();
            }
        }
    });
}
