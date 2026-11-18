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

import type { SupportedShell } from '../common/shells.js';

export type HostProcessKind = 'shell' | 'stdio';
export interface HostProcessCommand {
    command: string;
    args: string[];
}
export interface HostShell {
    shellPath: string;
    shellArgs: string[];
}

/** Runtime-specific mechanics are configured before business modules or workers are started. */
export interface HostRuntimeOptions {
    prepareResource?: (resource: string) => void | Promise<void>;
    prepareProcess?: (kind: HostProcessKind) => void | Promise<void>;
    prepareSynchronousProcess?: (kind: HostProcessKind) => void;
    resolveProcessCommand?: (command: string, args: readonly string[], kind: HostProcessKind) => HostProcessCommand;
    transformProcessEnvironment?: (environment: NodeJS.ProcessEnv, explicit?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
    /** Used when the user has no valid explicit workspace; the host owns storage readiness and permissions. */
    defaultWorkspace?: () => string | undefined;
    defaultShell?: () => HostShell | undefined;
    shells?: (platform: string) => readonly SupportedShell[] | undefined;
    sqliteBackend?: 'native' | 'wasm';
    agentGateStorage?: 'sqlite' | 'json';
    nodeModulesRoot?: string;
    fileScanLock?: { retries?: number; retryDelayMs?: number; staleMs?: number; updateMs?: number };
}

let runtime: Readonly<HostRuntimeOptions> = Object.freeze({});

/** Each process/worker owns its configuration; callbacks are never serialized over IPC. */
export function configureHostRuntime(options: HostRuntimeOptions = {}): () => void {
    const previous = runtime;
    const configured = Object.freeze({ ...options });
    runtime = configured;
    return () => {
        if (runtime === configured) runtime = previous;
    };
}

export function getHostRuntime(): Readonly<HostRuntimeOptions> {
    return runtime;
}

export async function prepareHostResource(resource: string): Promise<void> {
    // Let the entrypoint install its host after static imports finish evaluating.
    await Promise.resolve();
    await runtime.prepareResource?.(resource);
}

export async function prepareHostProcess(kind: HostProcessKind): Promise<void> {
    await runtime.prepareProcess?.(kind);
}

export function resolveHostProcessCommand(
    command: string,
    args: readonly string[],
    kind: HostProcessKind
): HostProcessCommand {
    return runtime.resolveProcessCommand?.(command, args, kind) ?? { command, args: [...args] };
}
