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

import { app, ipcMain, type WebContents } from 'electron';
import type { TerminalCreateOptions } from '../../../../common/terminal.js';
import { GlobalState } from '../../../aikernel/states/global.js';
import { Setting } from '../../../utils/setting.js';
import { scanSupportedShells } from '../scan.js';
import { terminalEnvironment } from './environment.js';
import { buildInteractiveTerminalProfiles } from './profiles.js';
import { spawnTerminalProcess } from './pty.js';
import {
    InteractiveTerminalSessionManager,
    type InteractiveTerminalDependencies,
    type TerminalOwner
} from './session-manager.js';

/** Task workspace first: interactive shells should open where the task reads and writes. */
function resolveSessionCwd(taskId: string | undefined, cwd?: string): string {
    if (taskId) {
        const workspace = GlobalState.getInstance().taskManagerState.getTask(taskId)?.getWorkspace();
        if (workspace) return workspace;
    }
    return cwd || Setting.getInstance().getEffectiveWorkspace();
}

const manager = new InteractiveTerminalSessionManager({
    profiles: () => buildInteractiveTerminalProfiles(process.platform, scanSupportedShells()),
    resolveCwd: resolveSessionCwd,
    environment: () => terminalEnvironment(process.env),
    spawn: spawnTerminalProcess
});

// The manager compares owners by identity, so each WebContents gets one stable adapter.
const owners = new WeakMap<WebContents, TerminalOwner>();

/** WebContents is channel-based and destroyed-aware; the manager speaks typed events. */
function ownerOf(sender: WebContents): TerminalOwner {
    const existing = owners.get(sender);
    if (existing) return existing;
    const owner: TerminalOwner = {
        isAlive: () => !sender.isDestroyed(),
        send(event) {
            if (event.type === 'data') {
                sender.send('terminal:data', { sessionId: event.sessionId, data: event.data });
            } else {
                sender.send('terminal:exit', { sessionId: event.sessionId, exitCode: event.exitCode });
            }
        }
    };
    owners.set(sender, owner);
    // Renderer frames die silently; their PTYs must not keep running.
    sender.once('destroyed', () => manager.closeOwner(owner));
    return owner;
}

function ok(data?: unknown): { status: 'ok'; data?: unknown } {
    return data === undefined ? { status: 'ok' } : { status: 'ok', data };
}

function errorResult(error: unknown): { status: 'error'; message: string } {
    return { status: 'error', message: error instanceof Error ? error.message : String(error) };
}

let registered = false;

export function registerInteractiveTerminalHandlers(): void {
    if (registered) return;
    registered = true;
    const guarded =
        (run: (sender: WebContents, ...args: any[]) => unknown) =>
        (event: { sender: WebContents }, ...args: any[]) => {
            try {
                return ok(run(event.sender, ...args));
            } catch (error) {
                return errorResult(error);
            }
        };
    ipcMain.handle(
        'terminal:listProfiles',
        guarded(() => manager.listProfiles())
    );
    ipcMain.handle(
        'terminal:create',
        guarded((sender, options: TerminalCreateOptions) => manager.create(ownerOf(sender), options))
    );
    ipcMain.handle(
        'terminal:start',
        guarded((sender, sessionId: string) => manager.start(ownerOf(sender), sessionId))
    );
    ipcMain.handle(
        'terminal:write',
        guarded((sender, sessionId: string, data: string) => manager.write(ownerOf(sender), sessionId, data))
    );
    ipcMain.handle(
        'terminal:resize',
        guarded((sender, sessionId: string, cols: number, rows: number) =>
            manager.resize(ownerOf(sender), sessionId, cols, rows)
        )
    );
    ipcMain.handle(
        'terminal:close',
        guarded((sender, sessionId: string) => manager.close(ownerOf(sender), sessionId))
    );
    ipcMain.handle(
        'terminal:acknowledge',
        guarded((sender, sessionId: string, count: number) => manager.acknowledge(ownerOf(sender), sessionId, count))
    );
    app.once('will-quit', () => manager.closeAll());
}
