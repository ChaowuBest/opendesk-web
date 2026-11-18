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

import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, open, readlink, realpath, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

async function resolveWorkingCopyTarget(localPath: string): Promise<string> {
    let candidate = path.resolve(localPath);
    const visited = new Set<string>();
    for (;;) {
        // Resolve the parent first: relative link targets are relative to the
        // physical directory, which may itself be reached through a link.
        const directory = await realpath(path.dirname(candidate));
        candidate = path.join(directory, path.basename(candidate));
        let entry;
        try {
            entry = await lstat(candidate);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            return candidate;
        }
        if (!entry.isSymbolicLink()) return candidate;
        if (visited.has(candidate) || visited.size >= 40) {
            // Filesystem diagnostic: retain Node's error code for callers.
            throw Object.assign(new Error('ELOOP: too many symbolic links encountered while resolving document'), {
                code: 'ELOOP',
                path: localPath
            });
        }
        visited.add(candidate);
        candidate = path.resolve(directory, await readlink(candidate));
    }
}

/** Keep streaming serializers while publishing only a complete, flushed file. */
export async function persistOfficeWorkingCopyAtomically(
    localPath: string,
    writeTemporary: (temporaryPath: string) => Promise<void>
): Promise<void> {
    // Match a stream writer's link-following behavior; publish beside the real
    // target instead of replacing the link used to open the document.
    const targetPath = await resolveWorkingCopyTarget(localPath);
    let existingMode: number | undefined;
    try {
        existingMode = (await stat(targetPath)).mode & 0o777;
        // A writable parent directory must not let rename bypass the existing
        // document's write restriction, which the original stream enforced.
        await access(targetPath, constants.W_OK);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        existingMode = undefined;
    }
    const temporaryPath = path.join(
        path.dirname(targetPath),
        `.${path.basename(targetPath)}.${randomUUID()}.office-tmp`
    );
    try {
        await writeTemporary(temporaryPath);
        const handle = await open(temporaryPath, 'r+');
        try {
            // Replacing an existing document must retain its access restrictions.
            // A new file keeps the serializer's normal mode and umask handling.
            if (existingMode !== undefined && process.platform !== 'win32') await handle.chmod(existingMode);
            await handle.sync();
        } finally {
            await handle.close();
        }
        for (let attempt = 0; ; attempt++) {
            try {
                await rename(temporaryPath, targetPath);
                break;
            } catch (error) {
                if (!RETRYABLE_RENAME_CODES.has((error as NodeJS.ErrnoException).code ?? '') || attempt >= 4) {
                    throw error;
                }
                await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt));
            }
        }
    } finally {
        await rm(temporaryPath, { force: true });
    }
}
