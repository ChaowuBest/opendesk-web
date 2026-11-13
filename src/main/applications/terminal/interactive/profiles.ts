/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import path from 'node:path';
import type { SupportedShell } from '../../../../common/shells.js';
import type { TerminalProfile, TerminalShellKind } from '../../../../common/terminal.js';

export type InteractiveTerminalProfile = TerminalProfile;
export type { TerminalShellKind };

export interface InteractiveShellCandidate {
    kind: TerminalShellKind;
    path: string;
}

function profileId(kind: TerminalShellKind, shellPath: string): string {
    return `${kind}:${shellPath}`;
}

function addCandidate(
    profiles: TerminalProfile[],
    seenKinds: Set<TerminalShellKind>,
    candidate: InteractiveShellCandidate
): void {
    if (!candidate.path || !path.isAbsolute(candidate.path)) return;
    // The dropdown labels profiles by kind; duplicates would show as two identical entries
    // (e.g. Windows PowerShell 5.1 and PowerShell 7 both map to "PowerShell").
    if (seenKinds.has(candidate.kind)) return;
    seenKinds.add(candidate.kind);
    profiles.push({ id: profileId(candidate.kind, candidate.path), kind: candidate.kind, path: candidate.path });
}

/** PowerShell 7 (pwsh) renders UTF-8 and VT sequences better than Windows PowerShell 5.1. */
function prefersPwsh(kind: TerminalShellKind, shellPath: string): boolean {
    return kind !== 'powershell' || /^pwsh(\.exe)?$/i.test(path.basename(shellPath));
}

/**
 * 将系统 shell 探测结果转换为 renderer 可消费的稳定 profile。
 * 该函数保持纯粹，便于在没有 native PTY 的平台上测试和降级。
 */
export function buildInteractiveTerminalProfiles(
    platform: string,
    shells: readonly SupportedShell[],
    environment: Readonly<Record<string, string | undefined>> = process.env
): TerminalProfile[] {
    const profiles: TerminalProfile[] = [];
    const seenKinds = new Set<TerminalShellKind>();

    // Later candidates may still replace an earlier pick of the same kind when they are
    // better (pwsh over powershell.exe), so keep one path per kind while scanning.
    const candidatesByKind = new Map<TerminalShellKind, InteractiveShellCandidate>();
    for (const shell of shells) {
        if (shell.sandboxed) continue;
        if (!shell.path || !path.isAbsolute(shell.path)) continue;
        const existing = candidatesByKind.get(shell.kind);
        if (!existing || (!prefersPwsh(existing.kind, existing.path) && prefersPwsh(shell.kind, shell.path))) {
            candidatesByKind.set(shell.kind, { kind: shell.kind, path: shell.path });
        }
    }
    for (const candidate of candidatesByKind.values()) {
        addCandidate(profiles, seenKinds, candidate);
    }

    if (platform === 'win32') {
        const commandShell = environment.ComSpec || environment.COMSPEC;
        if (commandShell) addCandidate(profiles, seenKinds, { kind: 'cmd', path: commandShell });
    }

    return profiles;
}

export function shellArguments(profile: TerminalProfile, platform: string): string[] {
    if (profile.kind === 'powershell') {
        return platform === 'win32' ? ['-NoLogo'] : ['-NoLogo'];
    }
    if (profile.kind === 'cmd') return [];
    return ['-l'];
}
