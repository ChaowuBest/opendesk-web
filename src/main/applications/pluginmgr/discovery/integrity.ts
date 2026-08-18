/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

function shouldIgnorePluginFile(relativePath: string): boolean {
    const segments = relativePath.split('/');
    const name = segments[segments.length - 1] ?? '';
    return segments.includes('node_modules') || segments.includes('.git') || /^\.opendesk-.*\.mjs$/.test(name);
}

function collectFiles(directory: string, current = directory): string[] {
    const files: string[] = [];
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const absolute = path.join(current, entry.name);
        const relative = path.relative(directory, absolute).replace(/\\/g, '/');
        if (shouldIgnorePluginFile(relative)) continue;
        if (entry.isDirectory()) files.push(...collectFiles(directory, absolute));
        else if (entry.isFile()) files.push(relative);
        else if (entry.isSymbolicLink()) throw new Error(`plugin.integrity_symlink_unsupported:${relative}`);
        else throw new Error(`plugin.integrity_file_type_unsupported:${relative}`);
    }
    return files.sort();
}

export function computePluginIntegrity(directory: string): string {
    const hash = crypto.createHash('sha256');
    for (const relative of collectFiles(directory)) {
        const absolute = path.join(directory, ...relative.split('/'));
        hash.update(relative, 'utf-8');
        hash.update('\0');
        hash.update(fs.readFileSync(absolute));
        hash.update('\0');
    }
    return `sha256-${hash.digest('base64')}`;
}
