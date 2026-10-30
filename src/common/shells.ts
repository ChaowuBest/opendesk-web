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

export type SupportedShellKind = 'powershell' | 'bash' | 'zsh';

export interface SupportedShell {
    kind: SupportedShellKind;
    path: string;
    sandboxed: boolean;
}

export interface ShellSelection {
    shell_path?: string;
    shell_sandboxed?: boolean;
}

/**
 * 归一化 shell 路径用于匹配：统一正斜杠；Windows（或盘符路径）不区分大小写。
 * 供 selectSupportedShell 与 benchmark 等跨模块的 shell 路径匹配复用。
 */
export function normalizeShellPath(value: string, platform?: string): string {
    const normalized = value.replace(/\\/g, '/');
    return platform === 'win32' || /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
}

export function selectSupportedShell(
    shells: readonly SupportedShell[],
    selection: ShellSelection = {},
    platform?: string
): SupportedShell | null {
    const matching = selection.shell_path
        ? shells.filter(
              (shell) =>
                  normalizeShellPath(shell.path, platform) === normalizeShellPath(selection.shell_path!, platform)
          )
        : [];
    return (
        matching.find((shell) => shell.sandboxed === (selection.shell_sandboxed === true)) ??
        matching.find((shell) => !shell.sandboxed) ??
        shells[0] ??
        null
    );
}
