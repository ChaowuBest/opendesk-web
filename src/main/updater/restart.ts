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

export function resolveUpdateRelaunchPath(
    executablePath: string,
    pathExists: (candidate: string) => boolean = fs.existsSync
): string {
    const executableDirectory = path.dirname(executablePath);
    if (!/^app-\d/i.test(path.basename(executableDirectory))) return executablePath;
    const stableLauncher = path.join(path.dirname(executableDirectory), path.basename(executablePath));
    return pathExists(stableLauncher) ? stableLauncher : executablePath;
}

export interface UpdateRelaunchCommand {
    executablePath: string;
    arguments: string[];
    usesStableLauncher: boolean;
}

export function resolveUpdateRelaunchCommand(
    executablePath: string,
    processId: number,
    pathExists: (candidate: string) => boolean = fs.existsSync
): UpdateRelaunchCommand {
    const resolvedPath = resolveUpdateRelaunchPath(executablePath, pathExists);
    if (resolvedPath.toLowerCase() === executablePath.toLowerCase()) {
        return { executablePath: resolvedPath, arguments: [], usesStableLauncher: false };
    }
    return {
        executablePath: resolvedPath,
        arguments: ['--wait-for-pid', String(processId)],
        usesStableLauncher: true
    };
}
