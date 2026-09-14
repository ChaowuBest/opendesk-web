/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import { findExecutablesInPath, findOpenHarmonyBash, findOpenHarmonyZsh } from '../../utils/shellExec.js';
import type { SupportedShell, SupportedShellKind } from '../../../common/shells.js';
export { selectSupportedShell, type SupportedShell, type SupportedShellKind } from '../../../common/shells.js';
import {
    getHarmonyLocalRuntimeFeatureAvailability,
    getHarmonyLocalRuntimeState,
    type HarmonyLocalRuntimeState
} from '../../../platforms/bridges/harmonyos/local-runtime.js';

/** Discover runnable shells using the current platform and its configured runtime state. */
export function scanSupportedShells(
    platform: NodeJS.Platform | string = process.platform,
    harmonyState: HarmonyLocalRuntimeState | null = getHarmonyLocalRuntimeState()
): SupportedShell[] {
    const shells: SupportedShell[] = [];
    const add = (kind: SupportedShellKind, shellPath: string | null | undefined, sandboxed = false) => {
        if (!shellPath || shells.some((shell) => shell.path === shellPath && shell.sandboxed === sandboxed)) return;
        // Windows command wrappers require cmd.exe and cannot be spawned as the selected shell.
        if (platform === 'win32' && !/\.exe$/i.test(shellPath)) return;
        shells.push({ kind, path: shellPath, sandboxed });
        if (platform === 'win32' && kind === 'powershell' && !sandboxed) add(kind, shellPath, true);
    };
    if (platform === 'win32') {
        for (const shellPath of findExecutablesInPath('powershell')) add('powershell', shellPath);
        for (const shellPath of findExecutablesInPath('pwsh')) add('powershell', shellPath);
        for (const shellPath of findExecutablesInPath('bash')) add('bash', shellPath);
        for (const shellPath of findExecutablesInPath('zsh')) add('zsh', shellPath);
        return shells;
    }
    if (platform === 'openharmony') {
        if (!getHarmonyLocalRuntimeFeatureAvailability('terminal', harmonyState).available) return [];
        // 宿主快照中的命令已经验证；CLI 无快照时才执行本机探测。
        add('zsh', harmonyState ? harmonyState.commands.zsh : findOpenHarmonyZsh());
        add('bash', harmonyState ? harmonyState.commands.bash : findOpenHarmonyBash());
        return shells;
    }
    for (const kind of ['zsh', 'bash'] as const) {
        for (const shellPath of findExecutablesInPath(kind)) add(kind, shellPath);
    }
    for (const shellPath of findExecutablesInPath('pwsh')) add('powershell', shellPath);
    return shells;
}

export const scanShells = scanSupportedShells;
export const getSupportedShells = scanSupportedShells;
export const detectSupportedShells = scanSupportedShells;
