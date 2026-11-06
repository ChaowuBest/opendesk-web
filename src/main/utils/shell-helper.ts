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

import fs from 'node:fs';
import path from 'node:path';
import { asyncShellExec, getDefaultShell } from './shellExec.js';

export interface DiskUsage {
    bytes: number;
    /** du reports allocated space; PowerShell reports file lengths (not NTFS allocation). */
    kind: 'allocated' | 'apparent';
}

export interface DiskUsageOptions {
    /** Maximum command duration in milliseconds; defaults to two minutes. */
    timeout?: number;
}

const PATH_ENV = 'OPENDESK_DISK_USAGE_PATH';
const DU_COMMAND = 'du -sk "$OPENDESK_DISK_USAGE_PATH"';
const POWERSHELL_DISK_USAGE = [
    "$ErrorActionPreference = 'Stop'",
    '$item = Get-Item -LiteralPath $env:OPENDESK_DISK_USAGE_PATH -Force',
    'if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { 0 }',
    'elseif ($item.PSIsContainer) {',
    '    $sum = (Get-ChildItem -LiteralPath $env:OPENDESK_DISK_USAGE_PATH -Recurse -File -Force -Attributes !ReparsePoint | Measure-Object -Property Length -Sum).Sum',
    '    if ($null -eq $sum) { 0 } else { [long]$sum }',
    '} else { [long]$item.Length }'
].join('\n');

// PowerShell 插值会把 "$VAR" 展开为空，du 语法 PowerShell 解析不了：命令必须跟着 shell 走。
const POWERSHELL_SHELL_RE = /^(?:powershell|pwsh)(?:\.exe)?$/i;
const POSIX_SHELL_RE = /^(?:sh|bash|dash|zsh|ksh)(?:\.exe)?$/i;

/**
 * Measure a file or directory with the host's shell commands, without walking it in JavaScript.
 *
 * The command follows the detected default shell: PowerShell interpreters run a
 * Get-ChildItem/Measure-Object snippet (apparent bytes, including hidden files);
 * POSIX shells — including Git Bash on Windows — run `du -sk` (allocated KiB).
 * Links are not followed. Native du hard-link accounting and directory overhead apply on Unix;
 * PowerShell counts regular file lengths, excluding reparse points. Results are snapshots.
 * A missing path returns zero; permission errors, unsupported shells, timeouts and invalid output reject.
 * Callers own caching and any user-visible error translation.
 */
export async function getDiskUsage(target: string, options: DiskUsageOptions = {}): Promise<DiskUsage> {
    if (!target || target.includes('\0')) throw new Error('Invalid disk usage path');
    const isWindows = process.platform === 'win32';
    const absolutePath = (isWindows ? path.win32 : path).resolve(target);
    const shellName = path.win32.basename(getDefaultShell().shellPath);
    const useDu = !POWERSHELL_SHELL_RE.test(shellName);
    if (isWindows && useDu && !POSIX_SHELL_RE.test(shellName)) {
        throw new Error(`Disk usage requires PowerShell or a POSIX shell, got: ${shellName}`);
    }
    const kind: DiskUsage['kind'] = useDu ? 'allocated' : 'apparent';
    const timeout = options.timeout ?? 120_000;
    if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('Invalid disk usage timeout');
    try {
        await fs.promises.lstat(absolutePath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { bytes: 0, kind };
        throw error;
    }

    // Environment values stay data even when paths contain quotes, newlines or shell substitutions.
    // Resolve first so a leading '-' cannot become a du option; -sk works with BSD/GNU/toybox du.
    const { stdout } = await asyncShellExec(useDu ? DU_COMMAND : POWERSHELL_DISK_USAGE, {
        timeout,
        env: { [PATH_ENV]: absolutePath, LC_ALL: 'C' }
    });
    const match = useDu ? /^\s*(\d+)[\t ]/.exec(stdout) : /^\s*(\d+)\s*$/.exec(stdout);
    const bytes = match ? Number(match[1]) * (useDu ? 1024 : 1) : NaN;
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid disk usage command output');
    return { bytes, kind };
}
