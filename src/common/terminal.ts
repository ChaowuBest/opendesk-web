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

export type TerminalShellKind = 'powershell' | 'bash' | 'zsh' | 'cmd';

export interface TerminalProfile {
    id: string;
    kind: TerminalShellKind;
    path: string;
}

export interface TerminalCreateOptions {
    /** Owning task; sessions without one run in the configured workspace. */
    taskId?: string;
    profileId: string;
    cwd?: string;
    cols?: number;
    rows?: number;
}

export type TerminalBackend = 'pty' | 'pipe';

export interface TerminalSessionInfo {
    sessionId: string;
    profile: TerminalProfile;
    cwd: string;
    /** Current sessions run on node-pty; 'pipe' is reserved for the fallback backend. */
    backend: TerminalBackend;
}

export type TerminalEvent =
    { type: 'data'; sessionId: string; data: string } | { type: 'exit'; sessionId: string; exitCode: number };
