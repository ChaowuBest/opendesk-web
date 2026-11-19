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

import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { transformOfficeWordStorage } from './office-word-storage-compat.mjs';
import { transformOfficeSlidesStorage } from './office-slides-storage-compat.mjs';
import { transformOfficeSheetsStorage } from './office-sheets-storage-compat.mjs';

const require = createRequire(import.meta.url);

/** Both builders consume the same pinned transforms; Android does not duplicate the patch. */
export function createOfficeStorageEsbuildPlugin() {
    const wordMainPath = require.resolve('@bitclub.ai/opendesk-office/word-main');
    const version = JSON.parse(
        readFileSync(path.join(path.dirname(wordMainPath), '..', 'package.json'), 'utf8')
    ).version;
    if (version !== '0.3.9') throw new Error(`Unsupported Office storage package version: ${version}`);
    const entries = new Map([
        [wordMainPath, transformOfficeWordStorage],
        [require.resolve('@bitclub.ai/opendesk-office/main'), transformOfficeSlidesStorage],
        [require.resolve('@bitclub.ai/opendesk-office/sheets-main'), transformOfficeSheetsStorage]
    ]);
    return {
        name: 'opendesk-office:storage-compat',
        setup(build) {
            build.onLoad(
                { filter: /[\\/]@bitclub\.ai[\\/]opendesk-office[\\/]dist[\\/](?:main|word-main|sheets-main)\.js$/ },
                async ({ path: inputPath }) => {
                    const transform = entries.get(inputPath);
                    if (!transform) return undefined;
                    return {
                        contents: transform(await readFile(inputPath, 'utf8')),
                        loader: 'js',
                        resolveDir: path.dirname(inputPath)
                    };
                }
            );
        }
    };
}
