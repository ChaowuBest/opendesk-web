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

import { createRequire } from 'node:module';
import type { IPty } from 'node-pty';
import type { TerminalProfile } from '../../../../common/terminal.js';
import { shellArguments } from './profiles.js';

export interface TerminalSpawnOptions {
    profile: TerminalProfile;
    cwd: string;
    cols: number;
    rows: number;
    env: Record<string, string>;
}
export interface TerminalProcess {
    onData(listener: (data: string) => void): { dispose(): void };
    onExit(listener: (exitCode: number) => void): { dispose(): void };
    write(data: string): void;
    resize(cols: number, rows: number): void;
    pause(): void;
    resume(): void;
    kill(): void;
}

export function spawnTerminalProcess(options: TerminalSpawnOptions): TerminalProcess {
    let native: typeof import('node-pty');
    try {
        // Optional native module: unsupported devices must still be able to start OpenDesk.
        native = createRequire(import.meta.url)('node-pty');
    } catch (error) {
        console.warn('[terminal] native PTY unavailable', error);
        throw new Error((process.platform as string) === 'openharmony' ? 'harmonyUnavailable' : 'nativeUnavailable');
    }
    let pty: IPty;
    try {
        pty = native.spawn(options.profile.path, shellArguments(options.profile, process.platform), {
            name: 'xterm-256color',
            cwd: options.cwd,
            cols: options.cols,
            rows: options.rows,
            env: options.env
        });
    } catch (error) {
        console.warn('[terminal] PTY spawn failed', error);
        throw new Error((process.platform as string) === 'openharmony' ? 'harmonyUnavailable' : 'startFailed');
    }
    return {
        onData: (listener) => pty.onData(listener),
        onExit: (listener) => pty.onExit(({ exitCode }) => listener(exitCode)),
        write: (data) => pty.write(data),
        resize: (cols, rows) => pty.resize(cols, rows),
        pause: () => pty.pause(),
        resume: () => pty.resume(),
        kill: () => {
            // POSIX shells start a new session; terminate its group as well as the PTY master.
            if (process.platform !== 'win32' && pty.pid > 0) {
                try {
                    process.kill(-pty.pid, 'SIGKILL');
                } catch {
                    /* Already exited. */
                }
            }
            pty.kill();
        }
    };
}
