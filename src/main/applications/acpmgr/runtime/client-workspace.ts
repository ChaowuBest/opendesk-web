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

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
    CreateTerminalRequest,
    CreateTerminalResponse,
    KillTerminalRequest,
    KillTerminalResponse,
    ReadTextFileRequest,
    ReadTextFileResponse,
    ReleaseTerminalRequest,
    ReleaseTerminalResponse,
    TerminalExitStatus,
    TerminalOutputRequest,
    TerminalOutputResponse,
    WaitForTerminalExitRequest,
    WaitForTerminalExitResponse,
    WriteTextFileRequest,
    WriteTextFileResponse
} from '@agentclientprotocol/sdk';
import { t } from '../../../../locale/index.js';

const DEFAULT_OUTPUT_BYTE_LIMIT = 1024 * 1024;
const MAX_OUTPUT_BYTE_LIMIT = 16 * 1024 * 1024;
const MAX_READ_BYTES = 1024 * 1024;
const MAX_WRITE_BYTES = 5 * 1024 * 1024;
const MAX_TERMINALS = 8;
const MAX_DIRECTORY_ENTRIES = 10_000;

export interface ClientWorkspaceOperation {
    kind: 'read' | 'write' | 'execute';
    path?: string;
    command?: string;
    args?: string[];
}

export interface ClientWorkspaceRuntimeOptions {
    root: string;
    authorize(operation: ClientWorkspaceOperation): Promise<boolean>;
}

export interface ClientWorkspaceDirectoryEntry {
    name: string;
    type: 'file' | 'directory' | 'other';
}

interface TerminalRecord {
    sessionId: string;
    child: ChildProcessWithoutNullStreams;
    output: Buffer;
    outputByteLimit: number;
    truncated: boolean;
    exitStatus?: TerminalExitStatus;
    exit: Promise<TerminalExitStatus>;
}

function isOutsideRoot(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function boundedOutputLimit(requested: number | null | undefined): number {
    if (requested === undefined || requested === null || !Number.isFinite(requested)) {
        return DEFAULT_OUTPUT_BYTE_LIMIT;
    }
    return Math.max(1, Math.min(Math.trunc(requested), MAX_OUTPUT_BYTE_LIMIT));
}

function trimToUtf8Boundary(buffer: Buffer, limit: number): Buffer {
    if (buffer.length <= limit) return buffer;
    let start = buffer.length - limit;
    while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
    return buffer.subarray(start);
}

function minimalProcessEnvironment(overrides: CreateTerminalRequest['env']): NodeJS.ProcessEnv {
    const names = [
        'PATH',
        'Path',
        'HOME',
        'USERPROFILE',
        'TEMP',
        'TMP',
        'TMPDIR',
        'SystemRoot',
        'ComSpec',
        'PATHEXT',
        'LANG',
        'LC_ALL',
        'TERM'
    ];
    const environ: NodeJS.ProcessEnv = {};
    for (const name of names) {
        const value = process.env[name];
        if (value !== undefined) environ[name] = value;
    }
    for (const variable of overrides ?? []) {
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable.name)) environ[variable.name] = variable.value;
    }
    return environ;
}

export class ClientWorkspaceRuntime {
    readonly root: string;
    private readonly terminals = new Map<string, TerminalRecord>();
    private sessionId?: string;
    private rootRealPathPromise?: Promise<string>;

    constructor(private readonly options: ClientWorkspaceRuntimeOptions) {
        this.root = path.resolve(options.root);
    }

    setSessionId(sessionId: string): void {
        this.sessionId = sessionId;
    }

    async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
        this.assertSession(params.sessionId);
        const filePath = await this.resolveExistingPath(params.path);
        await this.authorize({ kind: 'read', path: filePath });
        const stat = await fs.stat(filePath);
        if (!stat.isFile() || stat.size > MAX_READ_BYTES) throw new Error(t('acpmgr.error.localFileTooLarge'));
        const content = await fs.readFile(filePath, 'utf8');
        if (Buffer.byteLength(content, 'utf8') > MAX_READ_BYTES) throw new Error(t('acpmgr.error.localFileTooLarge'));
        if (params.line === undefined && params.limit === undefined) return { content };
        const start = Math.max(0, (params.line ?? 1) - 1);
        const end = params.limit === undefined || params.limit === null ? undefined : start + params.limit;
        return { content: content.split(/\r?\n/).slice(start, end).join('\n') };
    }

    async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
        this.assertSession(params.sessionId);
        if (Buffer.byteLength(params.content, 'utf8') > MAX_WRITE_BYTES) {
            throw new Error(t('acpmgr.error.localFileTooLarge'));
        }
        const filePath = await this.resolveWritablePath(params.path);
        await this.authorize({ kind: 'write', path: filePath });
        await fs.writeFile(filePath, params.content, 'utf8');
        return {};
    }

    async listDirectory(sessionId: string, input: string = this.root): Promise<ClientWorkspaceDirectoryEntry[]> {
        this.assertSession(sessionId);
        const directoryPath = await this.resolveExistingPath(input);
        await this.authorize({ kind: 'read', path: directoryPath });
        const entries = await fs.readdir(directoryPath, { withFileTypes: true });
        if (entries.length > MAX_DIRECTORY_ENTRIES) throw new Error(t('acpmgr.error.localDirectoryTooLarge'));
        return entries
            .map((entry) => ({
                name: entry.name,
                type: entry.isFile()
                    ? ('file' as const)
                    : entry.isDirectory()
                      ? ('directory' as const)
                      : ('other' as const)
            }))
            .sort((left, right) => left.name.localeCompare(right.name));
    }

    async createTerminal(params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
        this.assertSession(params.sessionId);
        if (this.terminals.size >= MAX_TERMINALS) throw new Error(t('acpmgr.error.localTerminalLimit'));
        const cwd = await this.resolveExistingPath(params.cwd ?? this.root);
        const stat = await fs.stat(cwd);
        if (!stat.isDirectory()) throw new Error(t('acpmgr.error.localPathOutsideWorkspace'));
        const args = [...(params.args ?? [])];
        await this.authorize({ kind: 'execute', path: cwd, command: params.command, args });

        const child = spawn(params.command, args, {
            cwd,
            env: minimalProcessEnvironment(params.env),
            shell: false,
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe']
        });
        child.stdin.end();
        const terminalId = crypto.randomUUID();
        const record: TerminalRecord = {
            sessionId: params.sessionId,
            child,
            output: Buffer.alloc(0),
            outputByteLimit: boundedOutputLimit(params.outputByteLimit),
            truncated: false,
            exit: Promise.resolve({})
        };
        const append = (chunk: Buffer | string): void => {
            const next = Buffer.concat([record.output, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
            record.truncated ||= next.length > record.outputByteLimit;
            record.output = trimToUtf8Boundary(next, record.outputByteLimit);
        };
        child.stdout.on('data', append);
        child.stderr.on('data', append);
        record.exit = new Promise<TerminalExitStatus>((resolve) => {
            child.once('error', (error) => {
                append(`${error.message}\n`);
                record.exitStatus = { exitCode: null, signal: null };
                resolve(record.exitStatus);
            });
            child.once('close', (exitCode, signal) => {
                record.exitStatus = { exitCode, signal };
                resolve(record.exitStatus);
            });
        });
        this.terminals.set(terminalId, record);
        return { terminalId };
    }

    async terminalOutput(params: TerminalOutputRequest): Promise<TerminalOutputResponse> {
        const terminal = this.requireTerminal(params.sessionId, params.terminalId);
        return {
            output: terminal.output.toString('utf8'),
            truncated: terminal.truncated,
            ...(terminal.exitStatus ? { exitStatus: terminal.exitStatus } : {})
        };
    }

    async waitForTerminalExit(params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> {
        return this.requireTerminal(params.sessionId, params.terminalId).exit;
    }

    async killTerminal(params: KillTerminalRequest): Promise<KillTerminalResponse> {
        const terminal = this.requireTerminal(params.sessionId, params.terminalId);
        if (!terminal.exitStatus) terminal.child.kill();
        return {};
    }

    async releaseTerminal(params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse> {
        const terminal = this.requireTerminal(params.sessionId, params.terminalId);
        await this.terminateTerminal(terminal);
        this.terminals.delete(params.terminalId);
        return {};
    }

    async close(): Promise<void> {
        const terminals = [...this.terminals.values()];
        this.terminals.clear();
        await Promise.allSettled(terminals.map((terminal) => this.terminateTerminal(terminal)));
    }

    private assertSession(sessionId: string): void {
        if (this.sessionId && this.sessionId !== sessionId) throw new Error(t('acpmgr.error.localSessionMismatch'));
    }

    private async authorize(operation: ClientWorkspaceOperation): Promise<void> {
        if (!(await this.options.authorize(operation))) throw new Error(t('acpmgr.error.localOperationDenied'));
    }

    private async resolveExistingPath(input: string): Promise<string> {
        if (!path.isAbsolute(input)) throw new Error(t('acpmgr.error.localPathOutsideWorkspace'));
        const rootRealPath = await this.getRootRealPath();
        const candidate = path.resolve(input);
        if (isOutsideRoot(this.root, candidate)) throw new Error(t('acpmgr.error.localPathOutsideWorkspace'));
        const realPath = await fs.realpath(candidate);
        if (isOutsideRoot(rootRealPath, realPath)) throw new Error(t('acpmgr.error.localPathOutsideWorkspace'));
        return realPath;
    }

    private async resolveWritablePath(input: string): Promise<string> {
        if (!path.isAbsolute(input)) throw new Error(t('acpmgr.error.localPathOutsideWorkspace'));
        const candidate = path.resolve(input);
        if (isOutsideRoot(this.root, candidate)) throw new Error(t('acpmgr.error.localPathOutsideWorkspace'));
        const rootRealPath = await this.getRootRealPath();
        try {
            const realPath = await fs.realpath(candidate);
            if (isOutsideRoot(rootRealPath, realPath)) throw new Error(t('acpmgr.error.localPathOutsideWorkspace'));
            return realPath;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        const parentRealPath = await fs.realpath(path.dirname(candidate));
        if (isOutsideRoot(rootRealPath, parentRealPath)) throw new Error(t('acpmgr.error.localPathOutsideWorkspace'));
        return candidate;
    }

    private requireTerminal(sessionId: string, terminalId: string): TerminalRecord {
        this.assertSession(sessionId);
        const terminal = this.terminals.get(terminalId);
        if (!terminal || terminal.sessionId !== sessionId) throw new Error(t('acpmgr.error.localTerminalNotFound'));
        return terminal;
    }

    private getRootRealPath(): Promise<string> {
        this.rootRealPathPromise ??= fs.realpath(this.root);
        return this.rootRealPathPromise;
    }

    private async terminateTerminal(terminal: TerminalRecord): Promise<void> {
        if (terminal.exitStatus) return;
        terminal.child.kill();
        await Promise.race([terminal.exit, new Promise<void>((resolve) => setTimeout(resolve, 1000))]);
        if (terminal.exitStatus) return;
        terminal.child.kill('SIGKILL');
        await Promise.race([terminal.exit, new Promise<void>((resolve) => setTimeout(resolve, 1000))]);
    }
}
