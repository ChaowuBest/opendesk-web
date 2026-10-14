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

export function selectSupportedShell(
    shells: readonly SupportedShell[],
    selection: ShellSelection = {},
    platform?: string
): SupportedShell | null {
    const normalize = (value: string) => {
        const normalized = value.replace(/\\/g, '/');
        return platform === 'win32' || /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
    };
    const matching = selection.shell_path
        ? shells.filter((shell) => normalize(shell.path) === normalize(selection.shell_path!))
        : [];
    return (
        matching.find((shell) => shell.sandboxed === (selection.shell_sandboxed === true)) ??
        matching.find((shell) => !shell.sandboxed) ??
        shells[0] ??
        null
    );
}
