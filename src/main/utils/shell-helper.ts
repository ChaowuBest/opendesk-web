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
const POWERSHELL_DISK_USAGE = [
    "$ErrorActionPreference = 'Stop'",
    '$item = Get-Item -LiteralPath $env:OPENDESK_DISK_USAGE_PATH -Force',
    'if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { 0 }',
    'elseif ($item.PSIsContainer) {',
    '    $sum = (Get-ChildItem -LiteralPath $env:OPENDESK_DISK_USAGE_PATH -Recurse -File -Force -Attributes !ReparsePoint | Measure-Object -Property Length -Sum).Sum',
    '    if ($null -eq $sum) { 0 } else { [long]$sum }',
    '} else { [long]$item.Length }'
].join('\n');

/**
 * Measure a file or directory with the host's shell commands, without walking it in JavaScript.
 *
 * macOS/Linux/OpenHarmony: `du -sk` (allocated KiB, converted to bytes).
 * Windows: PowerShell Get-ChildItem/Measure-Object (apparent bytes, including hidden files).
 * Links are not followed. Native du hard-link accounting and directory overhead apply on Unix;
 * PowerShell counts regular file lengths, excluding reparse points. Results are snapshots.
 * A missing path returns zero; permission errors, unavailable tools, timeouts and invalid output reject.
 * Callers own caching and any user-visible error translation.
 */
export async function getDiskUsage(target: string, options: DiskUsageOptions = {}): Promise<DiskUsage> {
    if (!target || target.includes('\0')) throw new Error('Invalid disk usage path');
    const isWindows = process.platform === 'win32';
    const absolutePath = (isWindows ? path.win32 : path).resolve(target);
    const kind = isWindows ? 'apparent' : 'allocated';
    const timeout = options.timeout ?? 120_000;
    if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('Invalid disk usage timeout');
    try {
        await fs.promises.lstat(absolutePath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { bytes: 0, kind };
        throw error;
    }
    if (isWindows && !/^(?:powershell|pwsh)(?:\.exe)?$/i.test(path.win32.basename(getDefaultShell().shellPath))) {
        throw new Error('Disk usage requires PowerShell on Windows');
    }

    // Environment values stay data even when paths contain quotes, newlines or shell substitutions.
    // Resolve first so a leading '-' cannot become a du option; -sk works with BSD/GNU/toybox du.
    const { stdout } = await asyncShellExec(isWindows ? POWERSHELL_DISK_USAGE : 'du -sk "$OPENDESK_DISK_USAGE_PATH"', {
        timeout,
        env: { [PATH_ENV]: absolutePath, LC_ALL: 'C' }
    });
    const match = isWindows ? /^\s*(\d+)\s*$/.exec(stdout) : /^\s*(\d+)[\t ]/.exec(stdout);
    const bytes = match ? Number(match[1]) * (isWindows ? 1 : 1024) : NaN;
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid disk usage command output');
    return { bytes, kind };
}
