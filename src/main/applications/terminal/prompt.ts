/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import type { ToolSystemPromptContribution } from '../../aikernel/tool.js';
import type { SupportedShellKind } from '../../../common/shells.js';
import { t } from './locale/index.js';

export interface TerminalSystemPromptOptions {
    kind: SupportedShellKind;
    shellPath: string;
    sandboxed: boolean;
    deleteToTrash?: boolean;
    /** 沙箱所在平台：win32 / linux / openharmony。缺省取 process.platform。 */
    platform?: NodeJS.Platform | string;
}

export function createTerminalSystemPromptContribution(
    options: TerminalSystemPromptOptions
): ToolSystemPromptContribution {
    const shellPath = options.shellPath.replaceAll('`', '\\`');
    const platform = options.platform ?? process.platform;
    const isWindowsSandbox = options.sandboxed && platform === 'win32';
    const items = [
        t('prompt.title'),
        t('prompt.active', {
            shell: t(`prompt.shell.${options.kind}`),
            path: shellPath
        }),
        t(isWindowsSandbox ? 'prompt.mode.sandbox' : 'prompt.mode.host')
    ];

    if (isWindowsSandbox) {
        // Windows 动态沙箱（Detours）：powershell / Git Bash（MSYS2）共用同一套
        // 宿主真实路径语义——子进程直接使用宿主路径，策略与授权按根相对约定
        // /C/... 映射，工作目录为宿主真实路径。
        items.push(t('prompt.sandbox.rootPaths'), t('prompt.sandbox.absolutePaths'), t('prompt.sandbox.cwd'));
        if (options.deleteToTrash) {
            items.push(t('prompt.sandbox.trash'));
        }
    } else if (options.sandboxed) {
        // Linux / OpenHarmony / darwin 沙箱（bash/zsh，透明路径语义）
        items.push(
            t('prompt.mode.sandbox.linux'),
            t('prompt.sandbox.linux.transparent'),
            t('prompt.sandbox.linux.workspace'),
            t('prompt.sandbox.linux.system')
        );
        if (options.deleteToTrash && platform === 'darwin') {
            items.push(t('prompt.sandbox.darwin.trash'));
        }
    }

    return {
        id: 'terminal.environment',
        content: items.join('\n')
    };
}