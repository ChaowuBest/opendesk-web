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
import type { TaskState } from '../../aikernel/states/tasks.js';
import { MAIN_AGENT_UNLIMITED_MODE } from '../../aikernel/agents/main/modes/unlimited.js';
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
        // 交互式终端挂载在 task-view 内，不作为独立应用展示。
        super('terminal', false);
    }

    getName(): string {
        return t('app.name');
    }

    async getToolsets(taskState?: TaskState): Promise<BaseToolset[]> {
        const toolset = new BaseToolset('terminal');
        const taskConfig = Setting.getInstance().getData().task_config;
        const shell = selectSupportedShell(this.shells, taskConfig, process.platform);
        if (!shell) return [];
        // 无限制模式强制禁用所有 shell 沙箱：shell 直接以宿主权限执行，
        // 删除送回收站（依赖沙箱原生层拦截）也随之失效。
        const sandboxed = !isUnlimitedMode(taskState) && shell.sandboxed;
        const deleteToTrash = sandboxed && taskConfig?.shell_sandbox_del_to_trash === true;
        switch (shell.kind) {
            case 'powershell':
                toolset.addTool(new ExecutePwshTool(shell.path, sandboxed, deleteToTrash));
                break;
            case 'bash':
                toolset.addTool(new ExecuteBashTool(shell.path, sandboxed, deleteToTrash));
                break;
            case 'zsh':
                toolset.addTool(
                    new ExecuteZshTool(
                        shell.path,
                        (process.platform as string) === 'openharmony',
                        sandboxed,
                        deleteToTrash
                    )
                );
                break;
        }
        toolset.addTool(new CheckShellStatusTool(shell.kind, sandboxed));
        return [toolset];
    }
}

/** 任务是否处于无限制模式（unlimited）：该模式下所有 shell 沙箱与文件回收站被强制关闭。 */
export function isUnlimitedMode(taskState?: TaskState): boolean {
    return taskState?.activeModeId === MAIN_AGENT_UNLIMITED_MODE.id;
}
