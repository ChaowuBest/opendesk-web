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

import crypto from 'node:crypto';
import type {
    TerminalCreateOptions,
    TerminalEvent,
    TerminalProfile,
    TerminalSessionInfo
} from '../../../../common/terminal.js';
import type { TerminalProcess, TerminalSpawnOptions } from './pty.js';

export interface TerminalOwner {
    send(event: TerminalEvent): void;
    isAlive(): boolean;
}
export interface InteractiveTerminalDependencies {
    profiles(): TerminalProfile[];
    resolveCwd(taskId: string | undefined, cwd?: string): string;
    environment(): Record<string, string>;
    spawn(options: TerminalSpawnOptions): TerminalProcess;
}
interface Session {
    owner: TerminalOwner;
    info: TerminalSessionInfo;
    taskId: string | undefined;
    cols: number;
    rows: number;
    process?: TerminalProcess;
    disposables: Array<{ dispose(): void }>;
    pending: number;
    paused: boolean;
}

function dimension(value: unknown, fallback: number, max: number): number {
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || Number(value) < 2 || Number(value) > max) throw new Error('invalidRequest');
    return Number(value);
}

export class InteractiveTerminalSessionManager {
    private readonly sessions = new Map<string, Session>();

    constructor(private readonly deps: InteractiveTerminalDependencies) {}

    listProfiles(): TerminalProfile[] {
        return this.deps.profiles();
    }

    create(owner: TerminalOwner, options: TerminalCreateOptions): TerminalSessionInfo {
        if (
            !owner.isAlive() ||
            !options ||
            typeof options.profileId !== 'string' ||
            (options.taskId !== undefined && (typeof options.taskId !== 'string' || !options.taskId)) ||
            (options.cwd !== undefined && (typeof options.cwd !== 'string' || options.cwd.includes('\0')))
        ) {
            throw new Error('invalidRequest');
        }
        if (this.sessions.size >= 32 || [...this.sessions.values()].filter((s) => s.owner === owner).length >= 8) {
            throw new Error('sessionLimit');
        }
        const profile = this.listProfiles().find((item) => item.id === options.profileId);
        if (!profile) throw new Error('profileMissing');
        const cols = dimension(options.cols, 100, 500);
        const rows = dimension(options.rows, 24, 200);
        const cwd = this.deps.resolveCwd(options.taskId, options.cwd);
        const info: TerminalSessionInfo = { sessionId: crypto.randomUUID(), profile, cwd, backend: 'pty' };
        this.sessions.set(info.sessionId, {
            owner,
            info,
            taskId: options.taskId,
            cols,
            rows,
            disposables: [],
            pending: 0,
            paused: false
        });
        return info;
    }

    // Separate allocation from spawn so even the first prompt has a registered renderer consumer.
    start(owner: TerminalOwner, sessionId: string): void {
        const session = this.requireOwned(owner, sessionId);
        if (session.process) return;
        try {
            session.info.cwd = this.deps.resolveCwd(session.taskId, session.info.cwd);
            const proc = this.deps.spawn({
                profile: session.info.profile,
                cwd: session.info.cwd,
                cols: session.cols,
                rows: session.rows,
                env: this.deps.environment()
            });
            session.process = proc;
            session.disposables.push(
                proc.onData((data) => {
                    if (!this.sessions.has(sessionId)) return;
                    session.pending += data.length;
                    if (!session.paused && session.pending > 256 * 1024) {
                        session.paused = true;
                        proc.pause();
                    }
                    this.send(session, { type: 'data', sessionId, data });
                })
            );
            session.disposables.push(
                proc.onExit((exitCode) => {
                    if (!this.sessions.has(sessionId)) return;
                    this.send(session, { type: 'exit', sessionId, exitCode });
                    this.release(session, false);
                })
            );
        } catch (error) {
            this.release(session, true);
            throw error;
        }
    }

    write(owner: TerminalOwner, sessionId: string, data: string): void {
        const session = this.requireOwned(owner, sessionId);
        if (typeof data !== 'string' || data.length > 64 * 1024) throw new Error('invalidRequest');
        session.process?.write(data);
    }

    resize(owner: TerminalOwner, sessionId: string, cols: number, rows: number): void {
        const session = this.requireOwned(owner, sessionId);
        session.cols = dimension(cols, 100, 500);
        session.rows = dimension(rows, 24, 200);
        session.process?.resize(session.cols, session.rows);
    }

    acknowledge(owner: TerminalOwner, sessionId: string, count: number): void {
        if (!this.sessions.has(sessionId)) return; // A final write callback may arrive after process exit.
        const session = this.requireOwned(owner, sessionId);
        if (!Number.isInteger(count) || count < 0 || count > session.pending) throw new Error('invalidRequest');
        session.pending -= count;
        if (session.paused && session.pending < 64 * 1024) {
            session.paused = false;
            session.process?.resume();
        }
    }

    close(owner: TerminalOwner, sessionId: string): void {
        if (this.sessions.has(sessionId)) this.release(this.requireOwned(owner, sessionId), true);
    }

    closeOwner(owner: TerminalOwner): void {
        for (const session of [...this.sessions.values()]) {
            if (session.owner === owner) this.release(session, true);
        }
    }

    closeAll(): void {
        for (const session of [...this.sessions.values()]) this.release(session, true);
    }

    private requireOwned(owner: TerminalOwner, sessionId: string): Session {
        const session = this.sessions.get(sessionId);
        if (!session || session.owner !== owner || !owner.isAlive()) throw new Error('sessionMissing');
        return session;
    }

    private send(session: Session, event: TerminalEvent): void {
        try {
            if (!session.owner.isAlive()) throw new Error('ownerClosed');
            session.owner.send(event);
        } catch (error) {
            this.release(session, true);
        }
    }

    private release(session: Session, kill: boolean): void {
        if (!this.sessions.delete(session.info.sessionId)) return;
        for (const disposable of session.disposables) disposable.dispose();
        try {
            if (kill) session.process?.kill();
        } catch {
            // A concurrently exiting PTY has already released its OS handles.
        }
    }
}
