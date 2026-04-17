import type { OpenDeskTUI } from '../entry.js';
import { InfoOverlay } from '../components/notice.js';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import open from 'open';
import { t } from '../../../locale/index.js';

export function registerManualCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'manual',
        description: t('manual.description'),
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
                        title: t('manual.open.fail'),
                        message: `${t('manual.open.fail.detail')}${err instanceof Error ? err.message : String(err)}`,
                        closeLabel: t('common.close')
                    });
                    info.show();
                }
            } else {
                const info = new InfoOverlay(tui, {
                    title: t('manual.file.not.found'),
                    message: t('manual.file.not.found.detail'),
                    closeLabel: t('common.close')
                });
                info.show();
            }
        }
    });
}
