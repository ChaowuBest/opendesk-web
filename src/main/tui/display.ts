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

import { Setting } from '../utils/setting.js';

export const OUTPUT_DISPLAY_LEVELS = ['minimal', 'verbose'] as const;
export type OutputDisplayLevel = (typeof OUTPUT_DISPLAY_LEVELS)[number];

export function isOutputDisplayLevel(value: unknown): value is OutputDisplayLevel {
    return typeof value === 'string' && OUTPUT_DISPLAY_LEVELS.includes(value as OutputDisplayLevel);
}

export function getConfiguredOutputDisplayLevel(): OutputDisplayLevel {
    return Setting.getInstance().getData().cli_config?.output_display ?? 'minimal';
}

export function persistOutputDisplayLevel(level: OutputDisplayLevel): void {
    const setting = Setting.getInstance();
    const data = setting.getData();
    if (!data.cli_config) {
        data.cli_config = {} as typeof data.cli_config;
    }
    data.cli_config.output_display = level;
    if (level === 'minimal') {
        data.cli_config.show_all_reasoning = false;
    }
    setting.setData(data);
}

/** Returns the persisted reasoning preference without applying the output-mode gate. */
export function isReasoningDisplayFullConfigured(): boolean {
    const cliConfig = Setting.getInstance().getData().cli_config;
    return cliConfig?.show_all_reasoning === true || cliConfig?.reason_display === 'full';
}

/** Returns whether persisted settings alone permit full reasoning output. */
export function shouldShowAllReasoning(): boolean {
    const cliConfig = Setting.getInstance().getData().cli_config;
    return cliConfig?.output_display === 'verbose' && isReasoningDisplayFullConfigured();
}
