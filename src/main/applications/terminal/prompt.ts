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

import type { ToolSystemPromptContribution } from '../../aikernel/tool.js';
import type { SupportedShellKind } from '../../../common/shells.js';
import { t } from './locale/index.js';

export interface TerminalSystemPromptOptions {
    kind: SupportedShellKind;
    shellPath: string;
    sandboxed: boolean;
    deleteToTrash?: boolean;
}

export function createTerminalSystemPromptContribution(
    options: TerminalSystemPromptOptions
): ToolSystemPromptContribution {
    const shellPath = options.shellPath.replaceAll('`', '\\`');
    const items = [
        t('prompt.title'),
        t('prompt.active', {
            shell: t(`prompt.shell.${options.kind}`),
            path: shellPath
        }),
        t(options.sandboxed ? 'prompt.mode.sandbox' : 'prompt.mode.host')
    ];

    if (options.sandboxed) {
        // darwin 沙箱与 Linux 同为透明路径语义；PowerShell 沙箱为 Windows 语义
        if (options.kind !== 'powershell') {
            items.push(
                t('prompt.mode.sandbox.linux'),
                t('prompt.sandbox.linux.transparent'),
                t('prompt.sandbox.linux.workspace'),
                t('prompt.sandbox.linux.system')
            );
            if (options.deleteToTrash) {
                items.push(t('prompt.sandbox.darwin.trash'));
            }
        } else {
            items.push(t('prompt.sandbox.rootPaths'), t('prompt.sandbox.absolutePaths'), t('prompt.sandbox.cwd'));
            if (options.deleteToTrash) {
                items.push(t('prompt.sandbox.trash'));
            }
        }
    }

    return {
        id: 'terminal.environment',
        content: items.join('\n')
    };
}
