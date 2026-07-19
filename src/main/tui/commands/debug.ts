/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import type { OpenDeskTUI } from '../entry.js';
import { setDebugMode, getDebugMode } from '../../utils/logger.js';
import { logger } from '../../utils/logger.js';
import { isDeveloperModeEnabled, setDeveloperModeEnabled } from '../../utils/setting.js';
import { InfoOverlay } from '../components/notice.js';
import { t } from '../../../locale/index.js';

const DEBUG_SUBCOMMANDS = ['log', 'developer', 'taskid'];
const TOGGLE_OPTIONS = ['on', 'off'];

function isDeveloperSubCommand(subCommand: string | undefined): boolean {
    return subCommand === 'developer' || subCommand === 'dev';
}

function localizedToggleStatus(enabled: boolean): string {
    return t(enabled ? 'debug.status.on' : 'debug.status.off');
}

export function registerDebugCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'debug',
        description: t('debug.description'),
        getArgumentCompletions: (argPrefix: string) => {
            const trimmed = argPrefix.trim();
            const hasTrailingSpace = argPrefix.endsWith(' ');
            const parts = trimmed ? trimmed.split(/\s+/) : [];
            const firstArg = parts[0]?.toLowerCase() || '';
            const secondArg = parts[1]?.toLowerCase() || '';

            if (!hasTrailingSpace && parts.length <= 1) {
                const matchingSubCommands = DEBUG_SUBCOMMANDS.filter((cmd) => cmd.startsWith(firstArg));
                if (matchingSubCommands.length > 0) {
                    return matchingSubCommands.map((cmd) => ({
                        value: cmd,
                        label: cmd,
                        description:
                            cmd === 'log'
                                ? t('debug.log.description')
                                : cmd === 'developer'
                                  ? t('debug.developer.description')
                                  : t('debug.taskid.description')
                    }));
                }
            }

            if ((firstArg === 'log' || isDeveloperSubCommand(firstArg)) && (hasTrailingSpace || parts.length >= 2)) {
                return TOGGLE_OPTIONS.filter((opt) => opt.startsWith(secondArg)).map((opt) => ({
                    value: `${firstArg} ${opt}`,
                    label: opt,
                    description:
                        firstArg === 'log'
                            ? opt === 'on'
                                ? t('debug.log.on.description')
                                : t('debug.log.off.description')
                            : opt === 'on'
                              ? t('debug.developer.on.description')
                              : t('debug.developer.off.description')
                }));
            }

            return [];
        },
        execute: async (args: string) => {
            const trimmedArgs = args.trim().toLowerCase();
            const parts = trimmedArgs.split(/\s+/);
            const subCommand = parts[0];
            const subArg = parts[1];

            if (subCommand === 'log') {
                // /debug log [on|off]
                if (subArg === 'on') {
                    setDebugMode(true);
                    logger.info(t('debug.log.enabled'));
                } else if (subArg === 'off') {
                    setDebugMode(false);
                    logger.info(t('debug.log.disabled'));
                } else {
                    const currentMode = getDebugMode();
                    logger.info(t('debug.log.status', { status: localizedToggleStatus(currentMode) }));
                }
            } else if (isDeveloperSubCommand(subCommand)) {
                // /debug developer [on|off]
                if (subArg === 'on') {
                    setDeveloperModeEnabled(true);
                    logger.info(t('debug.developer.enabled'));
                } else if (subArg === 'off') {
                    setDeveloperModeEnabled(false);
                    logger.info(t('debug.developer.disabled'));
                } else {
                    logger.info(
                        t('debug.developer.status', { status: localizedToggleStatus(isDeveloperModeEnabled()) })
                    );
                }
            } else if (subCommand === 'taskid') {
                // /debug taskid
                const taskId = tui.activeTaskId;
                if (taskId) {
                    const info = new InfoOverlay(tui, {
                        title: t('debug.current.task.id'),
                        message: taskId,
                        fullWidth: true
                    });
                    info.show();
                } else {
                    const info = new InfoOverlay(tui, {
                        title: t('debug.hint'),
                        message: t('debug.no.active.task')
                    });
                    info.show();
                }
            } else {
                // 未知子命令或无参数，显示帮助
                if (!subCommand) {
                    logger.info(t('debug.usage'));
                } else {
                    logger.info(t('debug.unknown', { subCommand, usage: t('debug.usage') }));
                }
            }
        }
    });
}
