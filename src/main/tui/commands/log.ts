import type { OpenDeskTUI } from '../entry.js';
import { t } from '../../../locale/index.js';

export function registerLogCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'log',
        description: t('log.description'),
        getArgumentCompletions: (argPrefix: string) => {
            const options = ['off', 'last', 'all'];
            return options
                .filter((opt) => opt.startsWith(argPrefix.toLowerCase()))
                .map((opt) => ({
                    value: opt,
                    label: opt,
                    description:
                        opt === 'off'
                            ? t('log.off.description')
                            : opt === 'last'
                              ? t('log.last.description')
                              : t('log.all.description')
                }));
        },
        execute: async (args: string) => {
            const modeArg = args.trim().toLowerCase();
            if (modeArg === 'off' || modeArg === 'last' || modeArg === 'all') {
                tui.logPanel.setMode(modeArg);
            } else {
                tui.logPanel.setMode('off');
            }
        }
    });
}
