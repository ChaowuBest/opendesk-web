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
import { findExecutableInPath, findOpenHarmonyBash, findOpenHarmonyZsh } from '../../utils/shellExec.js';
import {
    getHarmonyLocalRuntimeFeatureAvailability,
    getHarmonyLocalRuntimeState,
    type HarmonyLocalRuntimeState
} from '../../../platforms/bridges/harmonyos/local-runtime.js';

export type OpenHarmonyTerminalShell = { kind: 'zsh'; path: string } | { kind: 'bash'; path: string };

export function getOpenHarmonyTerminalShell(
    state: HarmonyLocalRuntimeState | null = getHarmonyLocalRuntimeState()
): OpenHarmonyTerminalShell | null {
    // feature gate 统一拦截 tablet 与 PC 上 zsh/bash 双缺，此处只做 shell 选择
    if (!getHarmonyLocalRuntimeFeatureAvailability('terminal', state).available) return null;
    if (state) {
        // state 为已验证的探测快照：zsh 优先（交互模式加载 ~/.zshrc 环境），bash 兜底
        if (state.commands.zsh) return { kind: 'zsh', path: state.commands.zsh };
        return state.commands.bash ? { kind: 'bash', path: state.commands.bash } : null;
    }
    // 无宿主注入元数据（如 CLI 直跑）时退化为直接探测
    const zshPath = findOpenHarmonyZsh();
    if (zshPath) return { kind: 'zsh', path: zshPath };
    const bashPath = findOpenHarmonyBash();
    return bashPath ? { kind: 'bash', path: bashPath } : null;
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
                const shell = getOpenHarmonyTerminalShell();
                if (shell?.kind === 'zsh') {
                    toolset.addTool(new ExecuteZshTool(shell.path, true));
                } else if (shell?.kind === 'bash') {
                    toolset.addTool(new ExecuteBashTool(shell.path));
                } else {
                    break;
                }
                toolset.addTool(new CheckShellStatusTool());
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
