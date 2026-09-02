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

import { BaseToolset } from '../../aikernel/tool';
import { BaseApplication } from '../base';
import { t } from './locale/index.js';
import { ExecutePowerShellTool, ExecuteBashTool, ExecuteZshTool, CheckShellStatusTool } from './tools.js';
import { findExecutableInPath, hasZsh } from '../../utils/shellExec.js';
import {
    getHarmonyLocalRuntimeFeatureAvailability,
    getHarmonyLocalRuntimeState,
    type HarmonyLocalRuntimeState
} from '../../../platforms/bridges/harmonyos/local-runtime.js';

export function getOpenHarmonyTerminalBashPath(
    state: HarmonyLocalRuntimeState | null = getHarmonyLocalRuntimeState()
): string | null {
    const availability = getHarmonyLocalRuntimeFeatureAvailability('terminal', state);
    return availability.available ? (state?.commands.bash ?? null) : null;
}

export class TerminalApplication extends BaseApplication {
    constructor() {
        super('terminal', false);
    }

    getName(): string {
        return t('app.name');
    }

    async getToolsets(): Promise<BaseToolset[]> {
        const toolset = new BaseToolset('terminal');

        switch (process.platform as string) {
            case 'win32': {
                toolset.addTool(new ExecutePowerShellTool());
                // 检测 Windows 下是否有 bash.exe（如 Git Bash、WSL 等）
                const bashPath = findExecutableInPath('bash');
                if (bashPath) {
                    toolset.addTool(new ExecuteBashTool(bashPath));
                }
                break;
            }
            case 'openharmony': {
                const state = getHarmonyLocalRuntimeState();
                const ohBash = getOpenHarmonyTerminalBashPath(state);
                if (ohBash) {
                    toolset.addTool(new ExecuteBashTool(ohBash));
                    toolset.addTool(new CheckShellStatusTool());
                } else if (state === null && hasZsh()) {
                    toolset.addTool(new ExecuteZshTool());
                    toolset.addTool(new CheckShellStatusTool());
                }
                break;
            }
            default:
                // macOS/Linux 默认使用 /bin/bash
                toolset.addTool(new ExecuteBashTool('/bin/bash'));
                break;
        }

        if ((process.platform as string) !== 'openharmony') {
            toolset.addTool(new CheckShellStatusTool());
        }

        return toolset.tools.size > 0 ? [toolset] : [];
    }
}
