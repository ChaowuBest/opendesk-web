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
import { findExecutableInPath, hasZsh, findOpenHarmonyBash } from '../../utils/shellExec.js';

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
            case 'win32':
                toolset.addTool(new ExecutePowerShellTool());
                // 检测 Windows 下是否有 bash.exe（如 Git Bash、WSL 等）
                const bashPath = findExecutableInPath('bash');
                if (bashPath) {
                    toolset.addTool(new ExecuteBashTool(bashPath));
                }
                break;
            case 'openharmony': {
                // /bin/zsh 在 OpenHarmony 上可能存在但运行时报 "Error relocating"，优先使用 HNP bash
                const ohBash = findOpenHarmonyBash();
                if (ohBash) {
                    toolset.addTool(new ExecuteBashTool(ohBash));
                } else if (hasZsh()) {
                    toolset.addTool(new ExecuteZshTool());
                }
                break;
            }
            default:
                // macOS/Linux 默认使用 /bin/bash
                toolset.addTool(new ExecuteBashTool('/bin/bash'));
                break;
        }

        toolset.addTool(new CheckShellStatusTool());

        return [toolset];
    }
}
