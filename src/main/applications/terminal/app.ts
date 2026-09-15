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

import { BaseToolset } from '../../aikernel/tool.js';
import { BaseApplication } from '../base.js';
import { t } from './locale/index.js';
import { ExecutePwshTool } from './shells/pwsh.js';
import { ExecuteBashTool } from './shells/bash.js';
import { ExecuteZshTool } from './shells/zsh.js';
import { CheckShellStatusTool } from './shells/status.js';
import { scanSupportedShells, selectSupportedShell } from './scan.js';
import { Setting } from '../../utils/setting.js';

export class TerminalApplication extends BaseApplication {
    readonly shells = scanSupportedShells();
    constructor() {
        super('terminal', false);
    }

    getName(): string {
        return t('app.name');
    }

    async getToolsets(): Promise<BaseToolset[]> {
        const toolset = new BaseToolset('terminal');
        const shell = selectSupportedShell(this.shells, Setting.getInstance().getData().task_config, process.platform);
        if (!shell) return [];
        switch (shell.kind) {
            case 'powershell':
                toolset.addTool(new ExecutePwshTool(shell.path, shell.sandboxed));
                break;
            case 'bash':
                toolset.addTool(new ExecuteBashTool(shell.path));
                break;
            case 'zsh':
                toolset.addTool(new ExecuteZshTool(shell.path, (process.platform as string) === 'openharmony'));
                break;
        }
        toolset.addTool(new CheckShellStatusTool(shell.kind, shell.sandboxed));
        return [toolset];
    }
}
