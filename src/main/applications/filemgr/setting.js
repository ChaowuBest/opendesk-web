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

import { z } from 'zod';

const defaultExcludePatterns = [
    '**/node_modules/**',
    '**/.git/**',
    '**/.idea/**',
    '**/.vscode/**',
    '**/.pytest_cache/**',
    '**/.mypy_cache/**',
    '**/.hvigor/**',
    '**/site-packages/**'
];

function getHomeDirectory() {
    return process.env.HOME || process.env.USERPROFILE || '';
}

if (process.platform === 'darwin') {
    defaultExcludePatterns.push(`${getHomeDirectory()}/Library/**`);
    defaultExcludePatterns.push('**/.DS_Store/**');
}

if (process.platform === 'win32') {
    let home = getHomeDirectory();
    home = home.replace(/\\/g, '/');
    defaultExcludePatterns.push(`${home}/AppData/**`);
    defaultExcludePatterns.push('C:/Windows/**');
    defaultExcludePatterns.push('C:/Temp/**');
}

export const FSEntrySchema = z.object({
    root: z.string().default(getHomeDirectory()),
    include_patterns: z
        .array(z.string())
        .default(['**/*.{txt,md}', '**/*.{pdf,docx,pptx,xlsx,csv}', '**/*.{json,yaml,yml,xml,html,css,js}']),
    exclude_patterns: z.array(z.string()).default(defaultExcludePatterns)
});
